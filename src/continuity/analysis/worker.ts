import { randomUUID } from "node:crypto";
import { analysisSpendBlockers, type AnalysisSpendPolicy } from "@/domain/continuity/analysis/cost";
import { boundedDerivative } from "@/domain/continuity/analysis/plan";
import { uncheckedFinding } from "@/domain/continuity/analysis/schema";
import {
  DEFAULT_ANALYSIS_BUDGET,
  type AnalysisErrorCategory,
  type AnalysisMedia,
  type NormalizedFinding,
} from "@/domain/continuity/analysis/types";
import {
  AnalysisLeaseLostError,
  type AnalysisJob,
  type AnalysisWorkerStore,
  type InputAssetRef,
} from "@/data/media-qa-repository";
import type { GenerationLogger } from "@/generation/log";
import { sniffMediaFormat } from "@/media/ffmpeg";
import type { MediaProcessor } from "@/media/types";
import {
  AnalysisBatchError,
  sumUsage,
  type ContinuityAnalysisProvider,
  type MediaBytes,
  type UsageCall,
} from "./provider";

/**
 * Continuity analysis worker. Runs OUTSIDE Next.js, connected as `prism_continuity_worker`. Everything it may
 * know comes from the frozen job snapshot; everything it may write is execution state and normalized findings.
 *
 * Guarantees:
 *  - SKIP LOCKED claim + lease token fencing: a worker that lost its lease can change nothing.
 *  - A paid request is never blindly re-sent: if a reclaimed job's provider interaction may have started
 *    (`provider_state != not_sent`), it fails `outcome_unknown` instead of spending again.
 *  - Exactly one normalized final result + one final cost record per job.
 *  - Spend gate re-checked at execution time (the queue may predate a configuration change).
 */
export interface MediaReader {
  read(ref: InputAssetRef): Promise<Uint8Array | null>;
}

export interface AnalysisWorkerOptions {
  store: AnalysisWorkerStore;
  providers: Map<string, ContinuityAnalysisProvider>;
  media: MediaReader;
  /** Optional: bounds oversized images before they leave Prism. Without it oversized images are refused. */
  processor?: MediaProcessor | null;
  logger: GenerationLogger;
  paid: AnalysisSpendPolicy;
  clock?: () => Date;
  workerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  idlePollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Backoff for the one safe job-level requeue (rate limit before any request was processed). */
  retryDelayMs?: number;
}

const SAFE_REQUEUE: readonly AnalysisErrorCategory[] = ["rate_limit", "overloaded"];
/** Direct-video input ceiling (also bounds what may be uploaded to a provider's temporary file store). */
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export class ContinuityAnalysisWorker {
  readonly workerId: string;
  private readonly clock: () => Date;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: AnalysisWorkerOptions) {
    this.workerId = o.workerId ?? `continuity-${randomUUID().slice(0, 8)}`;
    this.clock = o.clock ?? (() => new Date());
    this.leaseMs = o.leaseMs ?? 60_000;
    this.heartbeatMs = o.heartbeatMs ?? 15_000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** One scheduling pass: claim due jobs and run each to a terminal state or a safe requeue. */
  async tick(limit = 2): Promise<number> {
    const claimed = await this.o.store.claim({
      workerId: this.workerId,
      now: this.clock().toISOString(),
      leaseMs: this.leaseMs,
      limit,
    });
    for (const { job } of claimed) {
      try {
        await this.process(job);
      } catch (err) {
        if (err instanceof AnalysisLeaseLostError) {
          this.o.logger.warn({ event: "continuity.lease_lost", jobId: job.id, workerId: this.workerId });
          continue;
        }
        this.o.logger.error({ event: "continuity.unexpected", jobId: job.id }, err);
      }
    }
    return claimed.length;
  }

  async run(signal: AbortSignal): Promise<void> {
    const idle = this.o.idlePollMs ?? 2000;
    while (!signal.aborted) {
      const n = await this.tick();
      if (n === 0) await this.sleep(idle);
    }
  }

  private async process(job: AnalysisJob): Promise<void> {
    const token = job.leaseToken!;
    const now = () => this.clock().toISOString();
    const log = (event: string, extra: Record<string, unknown> = {}) =>
      this.o.logger.info({
        event,
        jobId: job.id,
        provider: job.analyzer,
        model: job.model,
        workerId: this.workerId,
        ...extra,
      });

    const fail = async (
      category: AnalysisErrorCategory,
      code: string,
      message: string,
      cost: import("@/data/media-qa-repository").AnalysisCostRecord | null = null,
      cancelled = false,
    ) => {
      await this.o.store.finalizeFailure({
        jobId: job.id,
        leaseToken: token,
        runId: job.runId,
        errorCode: code,
        errorCategory: category,
        errorMessage: message,
        cost,
        cancelled,
        now: now(),
      });
      log("continuity.failed", { errorCategory: category, errorCode: code });
    };

    const provider = this.o.providers.get(job.analyzer);
    if (!provider) {
      return fail(
        "config",
        "unknown_analyzer",
        `Analyzer "${job.analyzer}" is not available on this worker.`,
      );
    }

    // ── reclaim safety: never spend twice on an interaction that may already have been sent ──
    if (job.attemptCount > 0 && job.providerState !== "not_sent") {
      return fail(
        "outcome_unknown",
        "reclaimed_after_send",
        "The analysis was interrupted after a request may have been sent. It will not be re-sent automatically; start a new analysis if needed.",
        {
          kind: "unknown",
          amountUsd: null,
          usage: sumUsage([]),
          pricingVersion: "",
          analyzer: job.analyzer,
          model: job.model,
        },
      );
    }
    if (job.status === "cancel_requested") {
      return fail("cancelled", "cancelled", "Analysis cancelled.", null, true);
    }

    // ── spend gate at execution time (paid analyzers only) ──
    if (provider.kind === "model") {
      const since = new Date(this.clock().getTime() - 24 * 3600_000).toISOString();
      const spent = Math.max(0, (await this.o.store.spentSince(since)) - (job.estimatedCostUsd ?? 0));
      const blockers = analysisSpendBlockers({
        policy: this.o.paid,
        maxEstimateUsd: job.estimatedCostUsd,
        spentLast24hUsd: spent,
      });
      if (blockers.length > 0) {
        return fail("budget", blockers[0]!.code, blockers[0]!.message);
      }
    }

    const input = job.inputSnapshot;
    let current = await this.o.store.update(
      job.id,
      token,
      {
        status: job.status === "queued" || job.status === "claimed" ? "processing" : undefined,
        startedAt: job.startedAt ?? now(),
        attemptCount: job.attemptCount + 1,
        note: `Analysing with ${job.analyzer}/${job.model}`,
      },
      now(),
    );
    await this.o.store.startRun(job.runId, now());
    log("continuity.started", { attemptCount: current.attemptCount });

    // heartbeat while processing
    let beating: ReturnType<typeof setInterval> | null = null;
    if (this.heartbeatMs > 0) {
      beating = setInterval(() => {
        void this.o.store.heartbeat(job.id, token, now(), this.leaseMs).catch(() => undefined);
      }, this.heartbeatMs);
    }
    const calls: UsageCall[] = [];
    const providerFiles: string[] = [];
    let cleaned = false;
    // Temporary provider-side copies are deleted best-effort, BEFORE the lease is released; a failed delete is
    // recorded (cleanup_failed) and never invalidates the analysis.
    const cleanup = async () => {
      if (cleaned || providerFiles.length === 0 || !provider.cleanupFiles) return;
      cleaned = true;
      const states = await provider
        .cleanupFiles(providerFiles)
        .catch(() => providerFiles.map((ref) => ({ ref, state: "cleanup_failed" as const })));
      await this.o.store
        .update(job.id, token, { providerFiles: states.map((s) => ({ ref: s.ref, state: s.state })) }, now())
        .catch(() => undefined);
      this.o.logger.info({
        event: "continuity.provider_files",
        jobId: job.id,
        count: states.length,
        note: `${states.filter((s) => s.state === "deleted").length} deleted`,
      });
    };
    let correctionCount = 0;
    let providerRef: string | null = null;
    const findings: NormalizedFinding[] = [];
    try {
      // 1. load + bound exactly the media the plan SENDS
      const sendIds = new Set(
        input.plan.batches.flatMap((b) => [...b.referenceInputIds, ...b.outputInputIds]),
      );
      const loaded = new Map<string, MediaBytes>();
      for (const m of input.media.filter((x) => sendIds.has(x.inputId))) {
        loaded.set(m.inputId, await this.loadOne(job, m));
      }

      // 2. batches, one request each, cancellation checked between requests
      for (const batch of input.plan.batches) {
        current = await this.o.store.update(job.id, token, {}, now());
        if (current.status === "cancel_requested") {
          await cleanup();
          return await fail(
            "cancelled",
            "cancelled",
            "Analysis cancelled.",
            this.partialCost(provider, calls, job),
            true,
          );
        }
        const out = await provider.analyzeBatch({
          batch,
          input,
          media: loaded,
          ctx: {
            now: this.clock,
            sleep: this.sleep,
            onProviderFile: (ref) => {
              if (!providerFiles.includes(ref)) providerFiles.push(ref);
            },
            beforeSend: async () => {
              await this.o.store.update(job.id, token, { providerState: "sending" }, now());
            },
          },
        });
        calls.push(...out.calls);
        findings.push(...out.findings);
        if (out.correctionUsed) correctionCount += 1;
        providerRef = out.providerRef ?? providerRef;
        await this.o.store.update(
          job.id,
          token,
          {
            providerState: "responded",
            providerRef,
            batchesDone: findings.length > 0 ? input.plan.batches.indexOf(batch) + 1 : 0,
            correctionCount,
          },
          now(),
        );
        await this.o.store.heartbeat(job.id, token, now(), this.leaseMs);
      }

      // 3. criteria nobody analysed stay UNCHECKED, with the reason (never an inferred pass)
      const analysed = new Set(findings.map((f) => f.criterionKey));
      for (const item of input.plan.items) {
        if (analysed.has(item.criterionKey)) continue;
        if (item.status === "unsupported" || item.status === "no_media") {
          findings.push(uncheckedFinding(item.criterionKey, item.status, item.reason));
        }
      }

      // 4. cost from authoritative usage; unknown stays unknown
      await cleanup();
      const cost = this.partialCost(provider, calls, job)!;
      await this.o.store.finalizeSuccess({
        jobId: job.id,
        leaseToken: token,
        runId: job.runId,
        findings,
        cost,
        providerRef,
        correctionCount,
        note: `${findings.filter((f) => f.result !== "unchecked").length} criteria judged, ${findings.filter((f) => f.result === "unchecked").length} unchecked`,
        now: now(),
      });
      log("continuity.succeeded", { count: findings.length });
    } catch (err) {
      if (err instanceof AnalysisLeaseLostError) throw err;
      await cleanup();
      if (err instanceof AnalysisBatchError) {
        calls.push(...err.calls);
        // A rate limit / overload proves the provider processed nothing: ONE safe requeue if nothing was spent.
        if (
          SAFE_REQUEUE.includes(err.category) &&
          calls.length === 0 &&
          current.attemptCount < job.maxAttempts
        ) {
          const delay = err.retryAfterMs ?? this.o.retryDelayMs ?? 30_000;
          await this.o.store.update(
            job.id,
            token,
            {
              status: "queued",
              nextRunAt: new Date(this.clock().getTime() + delay).toISOString(),
              providerState: "not_sent",
              lastErrorCode: err.code,
              lastErrorCategory: err.category,
              lastErrorMessage: err.message.slice(0, 300),
              releaseLease: true,
              note: `Provider busy (${err.category}); retrying`,
            },
            now(),
          );
          log("continuity.requeued", { errorCategory: err.category });
          return;
        }
        const spend =
          err.requestSent || calls.length > 0
            ? this.partialCost(provider, calls, job, err.category === "outcome_unknown")
            : null;
        return await fail(err.category, err.code, err.message, spend);
      }
      const message = err instanceof Error ? err.message : "Analysis failed";
      return await fail(
        "invalid_input",
        "media",
        message.slice(0, 300),
        this.partialCost(provider, calls, job),
      );
    } finally {
      if (beating) clearInterval(beating);
      await cleanup(); // safety net for paths that left without cleaning
    }
  }

  /** Final cost record for the calls that returned; unknown when usage is missing or a request may be in flight. */
  private partialCost(
    provider: ContinuityAnalysisProvider,
    calls: UsageCall[],
    job: AnalysisJob,
    ambiguous = false,
  ): import("@/data/media-qa-repository").AnalysisCostRecord {
    const usage = sumUsage(calls);
    const priced = provider.actualCost(calls, this.clock());
    const known = !ambiguous && priced.amountUsd != null;
    return {
      kind: known ? "actual" : "unknown",
      amountUsd: known ? priced.amountUsd : null,
      usage,
      pricingVersion: priced.pricingVersion,
      analyzer: job.analyzer,
      model: job.model,
    };
  }

  /** Loads one input through the narrow asset read, verifies it, and bounds its size. */
  private async loadOne(job: AnalysisJob, m: AnalysisMedia): Promise<MediaBytes> {
    const ref = await this.o.store.findInputAsset(job.id, m.assetId);
    if (!ref) throw new Error(`Input ${m.inputId} is not part of this analysis.`);
    const bytes = await this.o.media.read(ref);
    if (!bytes) throw new Error(`Input ${m.inputId} is missing from storage.`);
    const format = sniffMediaFormat(bytes);
    if (m.kind === "video") {
      if (format !== "mp4" && format !== "webm")
        throw new Error(`Input ${m.inputId} is not a supported video.`);
      if (bytes.length > MAX_VIDEO_BYTES)
        throw new Error(`Input ${m.inputId} exceeds the video analysis size limit.`);
      return { inputId: m.inputId, mime: format === "mp4" ? "video/mp4" : "video/webm", bytes };
    }
    if (format !== "png" && format !== "jpeg" && format !== "webp") {
      throw new Error(`Input ${m.inputId} is not a supported still image.`);
    }
    const mime = format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
    const budget = job.inputSnapshot.plan.budget ?? DEFAULT_ANALYSIS_BUDGET;
    const target = boundedDerivative({ width: ref.width, height: ref.height, mime }, budget);
    const oversizedDims = ref.width != null && target.width != null && ref.width !== target.width;
    if (oversizedDims || bytes.length > budget.maxImageBytes) {
      if (!this.o.processor || !(await this.o.processor.available())) {
        if (bytes.length > budget.maxImageBytes) {
          throw new Error(`Input ${m.inputId} exceeds the analysis size limit and cannot be reduced here.`);
        }
        return { inputId: m.inputId, mime, bytes };
      }
      const w = target.width ?? ref.width ?? 0;
      const h = target.height ?? ref.height ?? 0;
      if (w >= 2 && h >= 2) {
        const scaled = await this.o.processor.scaleImage(bytes, 2 * Math.round(w / 2), 2 * Math.round(h / 2));
        return { inputId: m.inputId, mime: scaled.mime, bytes: scaled.bytes };
      }
    }
    return { inputId: m.inputId, mime, bytes };
  }
}
