import { createHash, randomUUID } from "node:crypto";
import type {
  GenerationRepository,
  GenerationStore,
  ClaimedJob,
  JobPatch,
} from "@/data/generation-repository";
import { LeaseLostError } from "@/data/generation-repository";
import {
  DEFAULT_RETRY_POLICY,
  GenerationProviderError,
  decideRetry,
  USER_ERROR_MESSAGES,
  type RetryPolicy,
} from "@/domain/generation/errors";
import { spendBlockers } from "@/domain/generation/gate";
import { IllegalTransitionError } from "@/domain/generation/job-state";
import {
  generationRequestSchema,
  type GenerationErrorCategory,
  type GenerationJob,
  type GenerationRequest,
} from "@/domain/generation/schemas";
import { describeError, redactText } from "@/lib/auth/redact";
import type { GenerationConfig } from "./config";
import { IngestError, ingestOutputs } from "./ingest";
import { consoleLogger, type GenerationLogger } from "./log";
import type { AssetAccess, GenerationProviderAdapter, ProviderContext, ProviderJobRef } from "./provider";
import type { ModelRegistry } from "./registry";
import type { OutputSink } from "./sink";

type WorkerStore = GenerationStore & Pick<GenerationRepository, "getJob">;

export interface WorkerDeps {
  store: WorkerStore;
  registry: ModelRegistry;
  sink: OutputSink;
  config: GenerationConfig;
  logger?: GenerationLogger;
  clock?: () => Date;
  workerId?: string;
  retryPolicy?: RetryPolicy;
  random?: () => number;
  /** Heartbeats are skipped when 0 (unit tests drive leases explicitly). */
  heartbeatMs?: number;
  /** Tests only: allow loopback http downloads. */
  unsafeAllowLoopbackHttp?: boolean;
}

const isIllegalTransition = (err: unknown) =>
  err instanceof IllegalTransitionError ||
  (err instanceof Error && /illegal generation job transition/i.test(err.message));

/** Error categories after which a submit call may nevertheless have been accepted by the provider. */
const AMBIGUOUS_SUBMIT_CATEGORIES: readonly GenerationErrorCategory[] = [
  "transient",
  "timeout",
  "provider_unavailable",
];

/** A sanitized, user-safe description of a failure. Provider detail is reduced to a stable code. */
interface Classified {
  category: GenerationErrorCategory;
  code: string;
  message: string;
  retryAfterMs: number | null;
  retryable: boolean;
}

function classify(err: unknown): Classified {
  if (err instanceof GenerationProviderError) {
    return {
      category: err.category,
      code: err.code,
      message: redactText(err.message).slice(0, 300),
      retryAfterMs: err.options.retryAfterMs ?? null,
      retryable: err.retryable,
    };
  }
  if (err instanceof IngestError) {
    return {
      category: err.kind === "retryable" ? "transient" : "permanent",
      code: err.code,
      message: redactText(err.message).slice(0, 300),
      retryAfterMs: null,
      retryable: err.kind === "retryable",
    };
  }
  // Unknown failures are treated as transient (bounded by max attempts) but their detail is never stored.
  return {
    category: "transient",
    code: "worker_error",
    message: "Unexpected worker error.",
    retryAfterMs: null,
    retryable: true,
  };
}

/**
 * Executes generation jobs. One `tick()` claims due jobs and advances each by one step (submit, poll or
 * ingest). Everything the worker needs is in the store (frozen request + prompt plan), so it is independent
 * of the browser session and of the Next.js runtime.
 */
export class GenerationWorker {
  private readonly store: WorkerStore;
  private readonly registry: ModelRegistry;
  private readonly sink: OutputSink;
  private readonly config: GenerationConfig;
  private readonly log: GenerationLogger;
  private readonly now: () => Date;
  readonly workerId: string;
  private readonly retryPolicy: RetryPolicy;
  private readonly random: () => number;
  private readonly heartbeatMs: number;
  private readonly unsafeLoopback: boolean;
  /** provider/model → submissions of this process between the capacity check and the `submitting` write. */
  private readonly reserving = new Map<string, number>();

  constructor(deps: WorkerDeps) {
    this.store = deps.store;
    this.registry = deps.registry;
    this.sink = deps.sink;
    this.config = deps.config;
    this.log = deps.logger ?? consoleLogger;
    this.now = deps.clock ?? (() => new Date());
    this.workerId = deps.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.retryPolicy = deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.random = deps.random ?? Math.random;
    this.heartbeatMs = deps.heartbeatMs ?? deps.config.worker.heartbeatMs;
    this.unsafeLoopback = Boolean(deps.unsafeAllowLoopbackHttp);
  }

  /** Claims up to `limit` due jobs and processes them concurrently. Returns how many were processed. */
  async tick(limit: number = this.config.worker.concurrency): Promise<number> {
    const claimed = await this.store.claim({
      workerId: this.workerId,
      now: this.now().toISOString(),
      leaseMs: this.config.worker.leaseMs,
      limit,
    });
    await Promise.all(claimed.map((c) => this.process(c)));
    return claimed.length;
  }

  /** Runs until the signal aborts. Safe to stop mid-job: leases expire and another worker resumes. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let n = 0;
      try {
        n = await this.tick();
      } catch (err) {
        this.log.error({ event: "worker.tick_failed", workerId: this.workerId }, err);
      }
      if (n === 0) await sleep(this.config.worker.idlePollMs, signal);
    }
  }

  // ───────────────────────── one job ─────────────────────────

  private async process(claimed: ClaimedJob): Promise<void> {
    const { job } = claimed;
    const token = job.leaseToken!;
    const base = { jobId: job.id, attemptId: job.attemptId, provider: job.provider, model: job.model };
    const stop = this.startHeartbeat(job.id, token);
    const startedAt = Date.now();
    try {
      await this.step(claimed);
      this.log.info({
        ...base,
        event: "job.step_done",
        status: job.status,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      if (err instanceof LeaseLostError) {
        this.log.warn({ ...base, event: "job.lease_lost" });
        return;
      }
      if (isIllegalTransition(err)) {
        // The user cancelled while we were working: honour that.
        const fresh = await this.store.getJob(job.id);
        if (fresh?.status === "cancel_requested") {
          await this.cancel(claimed, fresh).catch((e) =>
            this.log.error({ ...base, event: "job.cancel_failed" }, e),
          );
          return;
        }
      }
      this.log.error({ ...base, event: "job.step_error" }, err);
      await this.failOrRetry(claimed, err).catch((e) =>
        this.log.error({ ...base, event: "job.recovery_failed" }, e),
      );
    } finally {
      stop();
    }
  }

  private startHeartbeat(jobId: string, token: string): () => void {
    if (this.heartbeatMs <= 0) return () => undefined;
    const timer = setInterval(() => {
      void this.store
        .heartbeat(jobId, token, this.now().toISOString(), this.config.worker.leaseMs)
        .catch(() => undefined);
    }, this.heartbeatMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * Provider context for ONE attempt. Asset access is limited to the inputs the frozen attempt names, read
   * back through the store (and therefore through the worker role's RLS) and checksum-verified.
   */
  private ctx(attemptId: string): ProviderContext {
    const sink = this.sink;
    const resolve = async (assetId: string) => {
      const ref = await this.store.findInputAsset(attemptId, assetId);
      if (!ref?.objectPath) return null;
      if (ref.bucket && sink.bucket && ref.bucket !== sink.bucket) return null;
      return ref;
    };
    const assets: AssetAccess = {
      read: async (assetId) => {
        const ref = await resolve(assetId);
        if (!ref?.objectPath) return null;
        const bytes = await sink.get(ref.objectPath);
        if (!bytes) return null;
        if (ref.byteSize != null && bytes.length !== ref.byteSize) return null;
        if (ref.checksum && createHash("sha256").update(bytes).digest("hex") !== ref.checksum) return null;
        return { bytes, mime: ref.mime, filename: ref.objectPath.split("/").pop() ?? "input" };
      },
      signedUrl: sink.signedUrl
        ? async (assetId, ttlSeconds) => {
            const ref = await resolve(assetId);
            return ref?.objectPath ? sink.signedUrl!(ref.objectPath, ttlSeconds) : null;
          }
        : undefined,
    };
    return { now: this.now, assets };
  }

  private async step(claimed: ClaimedJob): Promise<void> {
    const { job, attempt } = claimed;
    const adapter = this.registry.adapter(job.provider);
    const model = this.registry.model(job.provider, job.model);
    if (!adapter || !model) {
      throw new GenerationProviderError(
        "permanent",
        "provider_unavailable_in_worker",
        `Provider ${job.provider}/${job.model} is not registered in this worker.`,
      );
    }
    if (!attempt.request) {
      throw new GenerationProviderError(
        "invalid_request",
        "missing_request",
        "Attempt has no frozen request.",
      );
    }
    const request = generationRequestSchema.parse(attempt.request);

    // Kill switch: a provider that was disabled or lost its configuration after the job was queued must not
    // receive NEW work. (Jobs already submitted keep being polled/ingested so their results are not lost.)
    if (
      (job.status === "queued" || job.status === "submitting") &&
      !this.registry.availabilityOf(model).available
    ) {
      throw new GenerationProviderError(
        "permanent",
        "provider_unavailable",
        "This provider/model is disabled or not configured in this deployment.",
      );
    }

    switch (job.status) {
      case "cancel_requested":
        return this.cancel(claimed, job);
      case "queued":
      case "submitting":
        return this.submit(claimed, adapter, request);
      case "submitted":
      case "processing":
        return this.poll(claimed, adapter, request);
      case "ingesting":
        return this.ingest(claimed, adapter, request);
      default:
        // terminal states are never claimed; defensive no-op.
        return;
    }
  }

  private async submit(claimed: ClaimedJob, adapter: GenerationProviderAdapter, request: GenerationRequest) {
    const { job, attempt } = claimed;
    const token = job.leaseToken!;
    const now = this.now();
    const plan = attempt.promptPlan;
    if (!plan)
      throw new GenerationProviderError(
        "invalid_request",
        "missing_prompt_plan",
        "Attempt has no prompt plan.",
      );

    // A second remote submission is only safe when the provider de-duplicates on our idempotency key, or when
    // the previous try was definitely refused (rate limit, quota, invalid). An interrupted or ambiguous try
    // (lease expired mid-submit, network error, timeout) may have been accepted: without provider idempotency
    // re-submitting could bill twice, so Prism stops and says so instead of guessing.
    const model0 = this.registry.model(job.provider, job.model)!;
    const resubmission = job.attemptCount > 0 && !job.providerJobId;
    if (resubmission && !model0.capabilities.operational.idempotency) {
      const ambiguous =
        job.status === "submitting" ||
        job.lastErrorCategory === null ||
        AMBIGUOUS_SUBMIT_CATEGORIES.includes(job.lastErrorCategory);
      if (ambiguous) {
        throw new GenerationProviderError(
          "permanent",
          "submission_outcome_unknown",
          "An earlier submission may have reached the provider and this provider cannot de-duplicate requests. Check the provider account, then generate again if nothing was created.",
        );
      }
    }

    let reservedKey: string | null = null;
    // Live-spend gate, enforced where money is actually spent (the queue may predate a config change).
    if (this.registry.billsMoney(model0)) {
      const policy = this.registry.spendPolicy();
      const blocked = spendBlockers({
        paidEnabled: policy.enabled,
        maxUsd: policy.maxUsd,
        estimate: { amount: job.estimatedCost, currency: job.currency },
      });
      if (blocked.length > 0) {
        throw new GenerationProviderError("permanent", "spend_gate_blocked", blocked[0]!.message, {
          retryable: false,
        });
      }
      // Respect the provider's concurrency: do not flood it. Waiting does not consume an attempt.
      if (job.status === "queued") {
        const key = `${job.provider}/${job.model}`;
        const active = await this.store.countProviderActive(job.provider, job.model);
        // Jobs of THIS process that passed the check but are not yet visible as `submitting` in the store.
        const local = this.reserving.get(key) ?? 0;
        if (active + local >= model0.capabilities.operational.maxConcurrency) {
          const first = job.providerStatus !== "waiting_for_capacity";
          await this.store.update(
            job.id,
            token,
            {
              providerStatus: "waiting_for_capacity",
              nextRunAt: new Date(
                now.getTime() + model0.capabilities.operational.recommendedPollIntervalMs,
              ).toISOString(),
              releaseLease: true,
              note: first ? "Waiting for provider capacity" : undefined,
            },
            now.toISOString(),
          );
          return;
        }
        this.reserving.set(key, local + 1);
        reservedKey = key;
      }
    }

    let current = job;
    if (job.status === "queued") {
      try {
        current = await this.store.update(
          job.id,
          token,
          {
            status: "submitting",
            attemptCount: job.attemptCount + 1,
            startedAt: job.startedAt ?? now.toISOString(),
            note: `Submitting (try ${job.attemptCount + 1})`,
          },
          now.toISOString(),
        );
      } finally {
        // From here on the store itself counts this job as in flight.
        if (reservedKey)
          this.reserving.set(reservedKey, Math.max(0, (this.reserving.get(reservedKey) ?? 1) - 1));
      }
    } else {
      // Lease expired mid-submit: the provider may or may not have accepted. The idempotency key lets the
      // provider de-duplicate; we still count it as an attempt.
      current = await this.store.update(
        job.id,
        token,
        { attemptCount: job.attemptCount + 1, note: "Re-submitting after interrupted attempt" },
        now.toISOString(),
      );
    }

    const submission = await adapter.submit(request, plan, this.ctx(job.attemptId));
    const accepted = this.now().toISOString();
    const next =
      submission.state === "succeeded"
        ? "ingesting"
        : submission.state === "processing"
          ? "processing"
          : "submitted";
    const model = this.registry.model(job.provider, job.model)!;
    const interval = model.capabilities.operational.recommendedPollIntervalMs;
    try {
      await this.store.update(
        current.id,
        token,
        {
          status: next,
          providerJobId: submission.providerJobId,
          providerStatus: submission.providerStatus,
          submittedAt: accepted,
          nextRunAt: new Date(this.now().getTime() + (next === "ingesting" ? 0 : interval)).toISOString(),
          releaseLease: true,
          lastErrorCode: null,
          lastErrorCategory: null,
          lastErrorMessage: "",
          note: `Accepted by provider (${submission.providerStatus})`,
        },
        accepted,
      );
    } catch (err) {
      if (isIllegalTransition(err)) {
        // Cancellation arrived while the provider call was in flight. The provider HAS accepted the request:
        // keep its id (no status change) so the cancel path can ask it to stop and records billing honestly,
        // instead of reporting "cancelled before it was sent".
        await this.store.update(
          current.id,
          token,
          {
            providerJobId: submission.providerJobId,
            providerStatus: submission.providerStatus,
            submittedAt: accepted,
            note: "Provider accepted the request while cancellation was pending",
          },
          accepted,
        );
      }
      throw err;
    }
  }

  private ref(job: GenerationJob, request: GenerationRequest): ProviderJobRef {
    return {
      providerJobId: job.providerJobId!,
      model: job.model,
      pollCount: job.pollCount,
      submittedAt: job.submittedAt,
      idempotencyKey: request.idempotencyKey,
    };
  }

  private async poll(claimed: ClaimedJob, adapter: GenerationProviderAdapter, request: GenerationRequest) {
    const { job } = claimed;
    const token = job.leaseToken!;
    if (!job.providerJobId) {
      throw new GenerationProviderError("permanent", "missing_provider_job", "Job has no provider job id.");
    }
    const model = this.registry.model(job.provider, job.model)!;
    const now = this.now();

    // Overall provider-side timeout (queue waiting time before submission does not count).
    if (
      job.submittedAt &&
      now.getTime() - Date.parse(job.submittedAt) > model.capabilities.operational.jobTimeoutMs
    ) {
      await adapter.cancel?.(this.ref(job, request), this.ctx(job.attemptId)).catch(() => undefined);
      throw new GenerationProviderError("timeout", "job_timeout", "The provider did not finish in time.", {
        retryable: false,
      });
    }

    // pollCount advances on EVERY attempt (success or error) so scripted providers progress deterministically.
    await this.store.update(
      job.id,
      token,
      { pollCount: job.pollCount + 1, lastPolledAt: now.toISOString() },
      now.toISOString(),
    );
    const status = await adapter.poll(
      { ...this.ref(job, request), pollCount: job.pollCount },
      this.ctx(job.attemptId),
    );
    const at = this.now();
    const interval = Math.max(
      250,
      status.retryAfterMs ?? model.capabilities.operational.recommendedPollIntervalMs,
    );

    if (status.state === "succeeded") {
      await this.store.update(
        job.id,
        token,
        {
          status: "ingesting",
          providerStatus: status.providerStatus,
          nextRunAt: at.toISOString(),
          note: "Provider finished",
        },
        at.toISOString(),
      );
      // Continue straight into ingestion under the same lease.
      const fresh = (await this.store.getJob(job.id))!;
      return this.ingest({ ...claimed, job: { ...fresh, leaseToken: token } }, adapter, request);
    }
    if (status.state === "failed" || status.state === "cancelled") {
      // A task the provider itself ended is final: re-polling or re-submitting would not change that.
      const f = status.failure;
      throw new GenerationProviderError(
        f?.category ?? "permanent",
        f?.code ?? (status.state === "failed" ? "provider_failed" : "provider_cancelled"),
        f?.message ?? `Provider ended the job as ${status.state}.`,
        { retryable: false },
      );
    }
    await this.store.update(
      job.id,
      token,
      {
        status: status.state === "processing" ? "processing" : job.status,
        providerStatus: status.providerStatus,
        nextRunAt: new Date(at.getTime() + interval).toISOString(),
        releaseLease: true,
        lastErrorCode: null,
        lastErrorCategory: null,
        lastErrorMessage: "",
      },
      at.toISOString(),
    );
  }

  private async ingest(claimed: ClaimedJob, adapter: GenerationProviderAdapter, request: GenerationRequest) {
    const { job, attempt, ownerUserId } = claimed;
    const token = job.leaseToken!;
    const result = await adapter.fetchResult(this.ref(job, request), request, this.ctx(job.attemptId));
    const { outputs } = await ingestOutputs(result, {
      projectId: job.projectId,
      attemptId: attempt.id,
      ownerUserId,
      provider: job.provider,
      model: job.model,
      providerJobId: job.providerJobId ?? result.provenance.providerJobId,
      sink: this.sink,
      allowedHosts: adapter.allowedOutputHosts?.() ?? [],
      limits: this.config.download,
      now: this.now,
      unsafeAllowLoopbackHttp: this.unsafeLoopback,
    });

    const known = result.cost.amount != null;
    const now = this.now().toISOString();
    try {
      await this.store.finalizeSuccess({
        jobId: job.id,
        leaseToken: token,
        attemptId: attempt.id,
        outputs: outputs.map((o) => ({
          ...o,
          provenance: {
            ...o.provenance,
            provider: result.provenance,
          },
        })),
        cost: {
          kind: known ? "actual" : "unknown",
          amount: result.cost.amount,
          currency: result.cost.currency,
          basis: result.cost.basis,
          units: result.cost.units,
        },
        durationMs: result.provenance.actualDurationMs ?? request.durationMs,
        providerStatus: result.provenance.finishReason,
        now,
      });
    } catch (err) {
      // The database write failed after the upload. The objects are deliberately KEPT: their paths are
      // deterministic, so the retry finds and reuses them instead of re-downloading from a provider URL that
      // may have expired (and instead of uploading duplicates). A job that ultimately fails leaves them for
      // `npm run db:generation:cleanup`.
      throw err;
    }
  }

  private async cancel(claimed: ClaimedJob, job: GenerationJob) {
    const token = claimed.job.leaseToken!;
    const now = this.now().toISOString();
    let outcome: "local_only" | "confirmed" | "not_supported" | "failed" = "local_only";
    let completedFirst = false;
    // A submit was started but no provider id was recorded: the provider may hold a request we cannot name.
    // That is NOT "cancelled before it was sent".
    const maybeSubmitted = !job.providerJobId && job.attemptCount > 0;
    if (maybeSubmitted) outcome = "failed";
    if (job.providerJobId) {
      const adapter = this.registry.adapter(job.provider);
      const model = this.registry.model(job.provider, job.model);
      if (!adapter?.cancel || !model?.capabilities.operational.cancellation) {
        outcome = "not_supported";
      } else {
        try {
          const request = generationRequestSchema.parse(claimed.attempt.request);
          const res = await adapter.cancel(this.ref(job, request), this.ctx(job.attemptId));
          if (res.completed) completedFirst = true;
          else outcome = res.confirmed ? "confirmed" : "failed";
        } catch {
          outcome = "failed";
        }
      }
    }
    if (completedFirst) {
      // Lost the race: the provider finished (and billed) first. Keep the paid output and say so honestly.
      const adapter = this.registry.adapter(job.provider)!;
      const request = generationRequestSchema.parse(claimed.attempt.request);
      await this.store.update(
        job.id,
        token,
        {
          status: "ingesting",
          providerStatus: "succeeded",
          nextRunAt: now,
          note: "Provider finished before the cancellation took effect; keeping the output",
        },
        now,
      );
      const fresh = (await this.store.getJob(job.id))!;
      return this.ingest({ ...claimed, job: { ...fresh, leaseToken: token } }, adapter, request);
    }
    await this.store.update(
      job.id,
      token,
      {
        status: "cancelled",
        cancelledAt: now,
        cancelOutcome: outcome,
        releaseLease: true,
        note:
          outcome === "confirmed"
            ? "Cancelled; provider confirmed"
            : outcome === "local_only"
              ? "Cancelled before submission"
              : maybeSubmitted
                ? "Cancelled in Prism; an earlier submission may have reached the provider"
                : "Cancelled in Prism; the provider did not confirm and may still complete",
      },
      now,
    );
    if ((job.providerJobId || maybeSubmitted) && outcome !== "confirmed") {
      await this.store.recordUnknownCost({
        jobId: job.id,
        attemptId: job.attemptId,
        projectId: job.projectId,
        provider: job.provider,
        model: job.model,
        currency: job.currency,
        basis: "cancelled without provider confirmation: billing unknown",
        now,
      });
    }
  }

  private async failOrRetry(claimed: ClaimedJob, err: unknown) {
    const { job } = claimed;
    const token = job.leaseToken!;
    const c = classify(err);
    const fresh = (await this.store.getJob(job.id)) ?? job;
    const decision = decideRetry(
      { category: c.category, retryAfterMs: c.retryAfterMs, retryable: c.retryable },
      // submit already counted its attempt; poll/ingest failures consume the same budget
      Math.max(fresh.attemptCount, 1),
      fresh.maxAttempts,
      this.retryPolicy,
      this.random,
    );
    const now = this.now();
    const common: JobPatch = {
      lastErrorCode: c.code,
      lastErrorCategory: c.category,
      lastErrorMessage: `${USER_ERROR_MESSAGES[c.category]} (${c.code})`,
    };

    if (decision.retry) {
      const requeue = fresh.status === "submitting" || fresh.status === "queued";
      await this.store.update(
        job.id,
        token,
        {
          ...common,
          status: requeue && fresh.status === "submitting" ? "queued" : undefined,
          attemptCount: fresh.attemptCount + (requeue ? 0 : 1),
          nextRunAt: new Date(now.getTime() + decision.delayMs).toISOString(),
          releaseLease: true,
          note: `Retrying in ${Math.round(decision.delayMs / 1000)}s: ${c.code}`,
        },
        now.toISOString(),
      );
      this.log.warn({
        event: "job.retry_scheduled",
        jobId: job.id,
        attemptId: job.attemptId,
        provider: job.provider,
        model: job.model,
        errorCategory: c.category,
        errorCode: c.code,
        nextRunInMs: decision.delayMs,
      });
      return;
    }

    await this.store.update(
      job.id,
      token,
      {
        ...common,
        status: "failed",
        failedAt: now.toISOString(),
        releaseLease: true,
        note:
          decision.reason === "attempts_exhausted"
            ? `Gave up after ${fresh.attemptCount} attempts: ${c.code}`
            : `Failed: ${c.code}`,
      },
      now.toISOString(),
    );
    if (fresh.providerJobId || c.code === "submission_outcome_unknown") {
      await this.store.recordUnknownCost({
        jobId: job.id,
        attemptId: job.attemptId,
        projectId: job.projectId,
        provider: job.provider,
        model: job.model,
        currency: job.currency,
        basis: "job failed after submission: provider billing unknown",
        now: now.toISOString(),
      });
    }
    this.log.error(
      {
        event: "job.failed",
        jobId: job.id,
        attemptId: job.attemptId,
        provider: job.provider,
        model: job.model,
        errorCategory: c.category,
        errorCode: c.code,
      },
      describeError(err),
    );
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
