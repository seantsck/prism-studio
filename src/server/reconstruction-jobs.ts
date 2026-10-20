import { createHash } from "node:crypto";
import { PrevisError, type PrevisRepository } from "@/data/previs-repository";
import { spendBlockers } from "@/domain/generation/gate";
import {
  idempotencyKey,
  INGESTIBLE_RESULT_KINDS,
  inputModeOf,
  isProviderId,
  isTerminal,
  jobOptionsSchema,
  orderedSources,
  sanitizeErrorMessage,
  validateSources,
  type InputMode,
  type JobErrorCode,
  type JobEvent,
  type JobOptions,
  type JobPatch,
  type ReconstructionJobRecord,
  type ReconstructionProviderId,
} from "@/domain/reconstruction/job";
import {
  MAX_SPLAT_BYTES,
  providerEstimatedCalibration,
  SPLAT_FORMAT_INFO,
  type SplatCalibration,
} from "@/domain/previs/splat";
import { assetSchema, type Asset } from "@/domain/schemas";
import { inspectSplat } from "@/lib/splat/inspect";
import { buildObjectPath } from "@/lib/storage-paths";
import type { ProviderRegistry, ReconstructionConfig } from "@/lib/reconstruction/registry";
import {
  isBillable,
  normalizeProviderOptions,
  ProviderError,
  type OperationSnapshot,
  type PreparedInput,
  type ReconstructionProvider,
} from "@/lib/reconstruction/provider";
import {
  LEASE_EXPIRED_MESSAGE,
  remoteLeaseOf,
  staleRemoteJob,
} from "@/lib/reconstruction/remote-agent-capture";
import { persistPassBundle, type PassStoreDeps } from "./spatial-pass-store";

/**
 * Reconstruction job orchestration (Phase 2F M2D.2). Import-safe (no Next), all effects injected, so the whole
 * lifecycle is unit-tested with fake providers, storage and repository.
 *
 * Rules that matter:
 *   - Every status change is derived HERE and written with compare-and-set; the browser never sends a status.
 *   - A billable provider is never called while the live-spend gate is closed (checked before ANY provider call).
 *   - The provider is the one the user chose. There is NO fallback: an unavailable or failing provider fails the
 *     request; Prism never switches to another provider (and so never to a paid one) on its own.
 *   - A local timeout never fails a running provider operation and never triggers a new submission.
 *   - A `local_worker` or `remote_agent` provider is executed outside the web request (the same-host worker, or a
 *     paired workstation): the web side only reads the job, and fails a remote job whose lease has expired.
 *   - A provider "success" is only a Prism success after download, size cap, checksum and splat validation, and the
 *     Asset + immutable reconstruction + job success are persisted all-or-nothing. Exactly one poller ingests.
 */

export class JobServiceError extends Error {
  constructor(
    readonly code: JobErrorCode | "not_found" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "JobServiceError";
  }
}

export interface JobServiceDeps {
  repo: Pick<
    PrevisRepository,
    | "createReconstructionJob"
    | "getReconstructionJob"
    | "listReconstructionJobs"
    | "updateReconstructionJob"
    | "completeReconstructionJob"
    | "appendReconstructionJobEvent"
  >;
  providers: ProviderRegistry;
  config: ReconstructionConfig;
  /** the Project's assets (for source validation and snapshots) */
  projectAssets: Asset[];
  projectId: string;
  locationName: (locationId: string) => string | null;
  readAssetBytes: (asset: Asset) => Promise<Uint8Array | null>;
  store: PassStoreDeps;
  storage: { name: Asset["storageProvider"]; bucket: string | null };
  userId: string | null;
  now: () => string;
  newId: () => string;
  log?: (entry: Record<string, unknown>) => void;
}

const MAX_INGEST_ATTEMPTS = 3;

function log(deps: Pick<JobServiceDeps, "log">, entry: Record<string, unknown>) {
  (deps.log ?? ((e) => console.info(JSON.stringify(e))))({ event: "reconstruction.job", ...entry });
}

async function event(
  deps: Pick<JobServiceDeps, "repo" | "now">,
  job: ReconstructionJobRecord,
  ev: JobEvent,
  detail: Record<string, unknown> = {},
) {
  await deps.repo.appendReconstructionJobEvent({
    projectId: job.projectId,
    jobId: job.id,
    event: ev,
    detail,
    now: deps.now(),
  });
}

function providerFor(deps: JobServiceDeps, id: ReconstructionProviderId): ReconstructionProvider {
  const p = deps.providers.get(id);
  if (!p)
    throw new JobServiceError(
      "not_configured",
      "That reconstruction provider is not available on this server.",
    );
  return p;
}

/**
 * Why a provider may not be used for this request right now (null = it may). Checked at creation AND again
 * immediately before submission, before any provider call.
 */
export function submissionBlocker(
  deps: Pick<JobServiceDeps, "config">,
  provider: ReconstructionProvider,
  model: string | null,
  mode: InputMode,
): { code: JobErrorCode; message: string } | null {
  if (!deps.config.jobsEnabled)
    return { code: "not_configured", message: "Reconstruction jobs are switched off on this server." };
  const status = provider.status();
  if (!status.configured || !status.enabled)
    return { code: "not_configured", message: status.reason ?? "This provider is not configured." };
  if (status.capability !== "available")
    return {
      code: "capability_unavailable",
      message: status.reason ?? "This provider does not expose the reconstruction capability.",
    };
  const caps = provider.capabilities();
  if (isBillable(caps)) {
    const estimate = provider.estimateCost(model, mode);
    const blockers = spendBlockers({
      paidEnabled: deps.config.paid.enabled,
      maxUsd: deps.config.paid.maxUsd,
      // the documented MAXIMUM price is checked against the ceiling (variable pricing is never assumed cheap);
      // an unknown price cannot be checked, so it blocks
      estimate: {
        amount: estimate.costClass === "unknown" ? null : (estimate.usd?.max ?? null),
        currency: "USD",
      },
    });
    if (blockers.length > 0) return { code: "spend_blocked", message: blockers[0]!.message };
  }
  return null;
}

/** The registered provider for an id, or null for an id this server does not (or no longer) know. */
const registered = (deps: JobServiceDeps, id: ReconstructionProviderId) => deps.providers.get(id) ?? null;

// ───────────────────────── create ─────────────────────────

export async function createJob(
  deps: JobServiceDeps,
  input: {
    locationId: string;
    /** in the user's order: the first is the primary image */
    sourceAssetIds: string[];
    provider: ReconstructionProviderId;
    model: string | null;
    options: unknown;
    retryOf?: ReconstructionJobRecord | null;
  },
): Promise<ReconstructionJobRecord> {
  if (!isProviderId(input.provider))
    throw new JobServiceError("invalid", "That is not a reconstruction provider id.");
  const provider = providerFor(deps, input.provider);
  const caps = provider.capabilities();
  const model = input.model ?? caps.defaultModel;
  if (model !== null && !caps.models.some((m) => m.id === model))
    throw new JobServiceError("invalid", "That model is not offered by this provider.");
  // what Prism will request: only a kind it can ingest, and only from a provider that advertises it
  const resultKind = INGESTIBLE_RESULT_KINDS[0]!;
  if (!caps.resultKinds.includes(resultKind))
    throw new JobServiceError("capability_unavailable", "This provider does not produce a Gaussian splat.");

  // sources: this Project's own images (or one video), frozen BY VALUE in the user's order
  const sources = orderedSources(
    input.sourceAssetIds.map((id) => {
      const a = deps.projectAssets.find((x) => x.id === id);
      if (!a || !a.objectPath)
        throw new JobServiceError("invalid_sources", "A chosen reference image is not in this project.");
      return {
        kind: a.mime?.startsWith("video/") ? ("video" as const) : ("image" as const),
        assetId: a.id,
        checksum: a.checksum ?? null,
        mime: a.mime ?? null,
        width: a.width ?? null,
        height: a.height ?? null,
        byteSize: a.byteSize ?? null,
      };
    }),
  );
  const ok = validateSources(sources);
  if (!ok.ok) throw new JobServiceError("invalid_sources", ok.error);
  if (sources.length > caps.maxInputs)
    throw new JobServiceError("invalid_sources", `This provider accepts at most ${caps.maxInputs} inputs.`);
  if (caps.minInputs && sources.length < caps.minInputs)
    throw new JobServiceError("invalid_sources", `This provider needs at least ${caps.minInputs} images.`);
  if (caps.inputMimes && sources.some((s) => !caps.inputMimes!.includes(s.mime ?? "")))
    throw new JobServiceError(
      "invalid_sources",
      `This provider accepts only ${caps.inputMimes.map((m) => m.replace(/^\w+\//, "").toUpperCase()).join(" or ")} images.`,
    );
  const mode = inputModeOf(sources);
  if (!caps.inputModes.includes(mode))
    throw new JobServiceError(
      "invalid_sources",
      mode === "single_image"
        ? "This provider needs more than one image."
        : mode === "video"
          ? "This provider does not accept video."
          : "This provider does not accept several images.",
    );

  // configuration / availability / spend: the CHOSEN provider only, never a substitute
  const blocked = submissionBlocker(deps, provider, model, mode);
  if (blocked) throw new JobServiceError(blocked.code, blocked.message);

  let options: JobOptions;
  try {
    options = jobOptionsSchema.parse(input.options ?? {});
  } catch {
    throw new JobServiceError("invalid", "The reconstruction options are not valid.");
  }
  const normalized = normalizeProviderOptions(caps.options, options.provider);
  if (!normalized.ok) throw new JobServiceError("invalid", normalized.error);
  options = { ...options, provider: normalized.options };

  const job = await deps.repo.createReconstructionJob({
    id: deps.newId(),
    projectId: deps.projectId,
    locationId: input.locationId,
    attempt: input.retryOf ? input.retryOf.attempt + 1 : 1,
    previousJobId: input.retryOf?.id ?? null,
    provider: input.provider,
    capability: caps.capability,
    model,
    resultKind,
    sources,
    options,
    // the cost the user was shown and the gate checked, frozen with the request
    costEstimate: provider.estimateCost(model, mode),
    status: "queued",
    userId: deps.userId,
    now: deps.now(),
  });
  await event(deps, job, "created", {
    attempt: job.attempt,
    sources: sources.length,
    provider: job.provider,
    costClass: job.costEstimate?.costClass ?? null,
  });
  await event(deps, job, "queued");
  if (input.retryOf)
    await event(deps, input.retryOf, "retry_created", { newJobId: job.id, attempt: job.attempt });
  log(deps, { jobId: job.id, provider: job.provider, transition: "created->queued", attempt: job.attempt });
  return job;
}

// ───────────────────────── submit ─────────────────────────

async function transition(
  deps: JobServiceDeps,
  job: ReconstructionJobRecord,
  patch: JobPatch,
): Promise<ReconstructionJobRecord> {
  const next = await deps.repo.updateReconstructionJob(job.id, job.revision, patch, deps.now());
  if (patch.status && patch.status !== job.status)
    log(deps, {
      jobId: job.id,
      provider: job.provider,
      transition: `${job.status}->${patch.status}`,
      // a provider operation suffix helps support; a remote agent's lease id is never logged, not even in part
      operation:
        next.providerOperationId && !remoteLeaseOf(next) ? `…${next.providerOperationId.slice(-8)}` : null,
      code: patch.errorCode ?? null,
    });
  return next;
}

const fail = (code: JobErrorCode, message: string): JobPatch => ({
  status: "failed",
  errorCode: code,
  errorMessage: sanitizeErrorMessage(message),
});

/** Submits a QUEUED job exactly once (the queued → submitting compare-and-set elects one submitter). */
export async function submitJob(deps: JobServiceDeps, jobId: string): Promise<ReconstructionJobRecord> {
  let job = await deps.repo.getReconstructionJob(jobId);
  if (!job || job.projectId !== deps.projectId)
    throw new JobServiceError("not_found", "No such reconstruction job.");
  if (job.status !== "queued") return job;
  const provider = registered(deps, job.provider);
  // an id this server no longer knows: the job stays as it is (readable, cancellable), nothing else is tried
  if (!provider) return job;
  // a local worker or a paired agent claims queued jobs itself; a web request never runs a reconstruction
  if (provider.capabilities().runner !== "provider_api") return job;

  // spend / configuration gate BEFORE any provider call (nothing is uploaded, nothing is submitted)
  const blocked = submissionBlocker(deps, provider, job.model, inputModeOf(job.sources));
  if (blocked) {
    job = await transition(deps, job, fail(blocked.code, blocked.message));
    await event(deps, job, "failed", { code: blocked.code });
    return job;
  }

  try {
    job = await transition(deps, job, { status: "submitting" });
  } catch (e) {
    if (e instanceof PrevisError && e.code === "conflict")
      return (await deps.repo.getReconstructionJob(jobId))!;
    throw e;
  }

  // source bytes are read server-side from PRIVATE storage; they never become public URLs
  const images = [];
  for (const s of job.sources) {
    const asset = deps.projectAssets.find((a) => a.id === s.assetId);
    const bytes = asset ? await deps.readAssetBytes(asset) : null;
    if (!asset || !bytes || (s.checksum && asset.checksum !== s.checksum)) {
      job = await transition(
        deps,
        job,
        fail("invalid_sources", "A reference image changed or is no longer readable. Create a new job."),
      );
      await event(deps, job, "failed", { code: "invalid_sources" });
      return job;
    }
    images.push({ ordinal: s.ordinal, assetId: s.assetId, checksum: s.checksum, mime: s.mime ?? "", bytes });
  }

  // provider-side inputs of the attempt being retried are reused when the image content is identical
  const previous = job.previousJobId ? await deps.repo.getReconstructionJob(job.previousJobId) : null;
  let prepared: PreparedInput[];
  try {
    prepared = await provider.prepareInputs(images, previous?.providerInputs ?? []);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Preparing the inputs failed.";
    job = await transition(deps, job, fail("submit_failed", msg));
    await event(deps, job, "failed", { code: "submit_failed", stage: "inputs" });
    return job;
  }

  let op: OperationSnapshot;
  try {
    op = await provider.submit({
      jobId: job.id,
      attempt: job.attempt,
      idempotencyKey: idempotencyKey(job.id, job.attempt),
      model: job.model,
      inputs: prepared,
      options: job.options,
    });
  } catch (e) {
    const ambiguous = e instanceof ProviderError && (e.code === "timeout" || e.code === "network");
    // An unanswered submit MAY have been accepted (and charged). Prism never resubmits on its own.
    job = await transition(deps, job, {
      ...fail(
        ambiguous ? "submit_ambiguous" : "submit_failed",
        ambiguous
          ? `The provider did not confirm this submission; it may still have been accepted. Check the provider account for tag ${idempotencyKey(job.id, job.attempt)} before retrying.`
          : e instanceof Error
            ? e.message
            : "The provider refused the submission.",
      ),
      providerInputs: prepared,
    });
    await event(deps, job, "failed", { code: job.errorCode });
    return job;
  }

  job = await transition(deps, job, {
    status: "running",
    providerOperationId: op.operationId,
    providerOperation: { status: op.status, ...op.summary },
    providerInputs: prepared,
    progress: op.progress,
    lastPolledAt: deps.now(),
  });
  await event(deps, job, "submitted", { operation: `…${op.operationId.slice(-8)}` });
  await event(deps, job, "provider_running");
  return applySnapshot(deps, job, provider, op);
}

// ───────────────────────── poll ─────────────────────────

/** Refreshes one job from its provider (no faster than the poll interval). Safe to call from many tabs. */
export async function refreshJob(deps: JobServiceDeps, jobId: string): Promise<ReconstructionJobRecord> {
  let job = await deps.repo.getReconstructionJob(jobId);
  if (!job || job.projectId !== deps.projectId)
    throw new JobServiceError("not_found", "No such reconstruction job.");
  if (job.status === "queued") return submitJob(deps, jobId);
  if (job.status !== "running" && job.status !== "ingesting" && job.status !== "submitting") return job;
  const provider = registered(deps, job.provider);
  if (!provider) {
    // history from a provider this server no longer has: shown as stored, never polled, never substituted
    log(deps, { jobId, provider: job.provider, poll: "skipped", reason: "provider not registered" });
    return job;
  }
  // the worker / the paired agent owns the job's progress; web requests only read what it wrote. A remote lease is
  // reconciled in every in-flight state, `submitting` included (a claim interrupted between its two writes).
  const runner = provider.capabilities().runner;
  if (runner === "remote_agent") return reconcileRemoteLease(deps, job);
  // a hosted submission in flight belongs to its submitter (unchanged)
  if (job.status === "submitting") return job;
  if (runner !== "provider_api") return job;
  const last = job.lastPolledAt ? Date.parse(job.lastPolledAt) : 0;
  if (Date.parse(deps.now()) - last < deps.config.pollIntervalMs) return job;

  // claim this poll (a concurrent tab loses the compare-and-set and just reads)
  try {
    job = await transition(deps, job, { lastPolledAt: deps.now() });
  } catch (e) {
    if (e instanceof PrevisError && (e.code === "conflict" || e.code === "invalid"))
      return (await deps.repo.getReconstructionJob(jobId))!;
    throw e;
  }
  if (job.status === "ingesting") return ingest(deps, job, provider);

  let op: OperationSnapshot;
  try {
    op = await provider.getOperation(job.providerOperationId!);
  } catch (e) {
    // a local timeout / network error is NOT a provider failure: the job stays running and is polled again later
    log(deps, {
      jobId,
      provider: job.provider,
      poll: "deferred",
      code: e instanceof ProviderError ? e.code : "error",
    });
    return job;
  }
  return applySnapshot(deps, job, provider, op);
}

/**
 * The ONLY thing a web request does to a remote-agent job: when its stored lease has truly expired (the workstation
 * stopped reporting), the attempt is failed with a clear message (compare-and-set). It is never handed to another
 * workstation (that could run two expensive reconstructions for one attempt); Retry creates a new attempt.
 */
export async function reconcileRemoteLease(
  deps: Pick<JobServiceDeps, "repo" | "now" | "log">,
  job: ReconstructionJobRecord,
): Promise<ReconstructionJobRecord> {
  if (!staleRemoteJob(job, Date.parse(deps.now()))) return job;
  try {
    const next = await deps.repo.updateReconstructionJob(
      job.id,
      job.revision,
      {
        ...fail("provider_timeout", LEASE_EXPIRED_MESSAGE),
        providerOperation: { ...(job.providerOperation ?? {}), stage: "lease_expired" },
      },
      deps.now(),
    );
    await event(deps, next, "failed", {
      code: "provider_timeout",
      reason: "lease_expired",
      agent: remoteLeaseOf(job)?.agentId ?? null,
    });
    log(deps, {
      jobId: job.id,
      provider: job.provider,
      transition: `${job.status}->failed`,
      reason: "lease_expired",
    });
    return next;
  } catch (e) {
    // the agent renewed, uploaded or the user cancelled first: theirs is the outcome
    if (e instanceof PrevisError && (e.code === "conflict" || e.code === "invalid"))
      return (await deps.repo.getReconstructionJob(job.id)) ?? job;
    throw e;
  }
}

async function applySnapshot(
  deps: JobServiceDeps,
  job: ReconstructionJobRecord,
  provider: ReconstructionProvider,
  op: OperationSnapshot,
): Promise<ReconstructionJobRecord> {
  const operation = { status: op.status, description: op.description, ...op.summary };
  // only a cost the provider itself reported is recorded as actual; nothing is derived from the estimate
  const reported = op.reportedCost ? { actualCost: op.reportedCost } : {};
  switch (op.status) {
    case "pending":
    case "running": {
      if (op.progress !== job.progress) {
        const next = await transition(deps, job, {
          status: "running",
          progress: op.progress,
          providerOperation: operation,
        });
        await event(deps, next, "progress", { progress: op.progress });
        return next;
      }
      return job;
    }
    case "failed":
    case "expired": {
      const next = await transition(deps, job, {
        ...fail(
          op.status === "expired" ? "provider_timeout" : "provider_failed",
          op.error?.message ??
            (op.status === "expired" ? "The provider operation expired." : "The provider failed."),
        ),
        providerOperation: operation,
        ...reported,
      });
      await event(deps, next, "failed", { code: next.errorCode });
      return next;
    }
    case "cancelled": {
      const next = await transition(deps, job, { status: "cancelled", providerOperation: operation });
      await event(deps, next, "cancelled", { remote: true });
      return next;
    }
    case "succeeded": {
      // claim ingestion: exactly one poller moves running → ingesting
      let claimed: ReconstructionJobRecord;
      try {
        claimed = await transition(deps, job, {
          status: "ingesting",
          progress: 1,
          providerOperation: operation,
          ...reported,
        });
      } catch (e) {
        if (e instanceof PrevisError && (e.code === "conflict" || e.code === "invalid"))
          return (await deps.repo.getReconstructionJob(job.id))!;
        throw e;
      }
      await event(deps, claimed, "provider_succeeded");
      await event(deps, claimed, "ingesting");
      return ingest(deps, claimed, provider, op);
    }
  }
}

// ───────────────────────── ingest ─────────────────────────

async function ingest(
  deps: JobServiceDeps,
  job: ReconstructionJobRecord,
  provider: ReconstructionProvider,
  known?: OperationSnapshot,
): Promise<ReconstructionJobRecord> {
  const attempts =
    Number((job.providerResult as { ingestAttempts?: number } | null)?.ingestAttempts ?? 0) + 1;
  const deterministic = async (code: JobErrorCode, message: string) => {
    const next = await transition(deps, job, {
      ...fail(code, message),
      providerResult: { ...(job.providerResult ?? {}), ingestAttempts: attempts },
    });
    await event(deps, next, "failed", { code });
    return next;
  };
  // a transient failure keeps the job ingesting (retried on a later poll, bounded); it never re-generates
  const transient = async (message: string) => {
    if (attempts >= MAX_INGEST_ATTEMPTS) return deterministic("ingest_failed", message);
    const next = await transition(deps, job, {
      providerResult: {
        ...(job.providerResult ?? {}),
        ingestAttempts: attempts,
        lastIngestError: sanitizeErrorMessage(message),
      },
    });
    log(deps, { jobId: job.id, provider: job.provider, ingest: "deferred", attempt: attempts });
    return next;
  };

  let op = known;
  if (!op) {
    try {
      op = await provider.getOperation(job.providerOperationId!);
    } catch (e) {
      return transient(e instanceof Error ? e.message : "The provider could not be reached.");
    }
  }
  const extracted = provider.extractResult(op);
  const splats = extracted.candidates.filter((c) => c.kind === "gaussian_splat");
  if (splats.length === 0)
    return deterministic(
      "result_missing",
      "The provider finished without a Gaussian-splat result Prism can import.",
    );

  // best resolution that fits Prism's splat cap; larger ones are skipped, never truncated
  let bytes: Uint8Array | null = null;
  let chosen = splats[0]!;
  let tooLarge = 0;
  for (const c of splats) {
    try {
      bytes = await provider.download(c, MAX_SPLAT_BYTES);
      chosen = c;
      break;
    } catch (e) {
      if (e instanceof ProviderError && e.code === "too_large") {
        tooLarge++;
        continue;
      }
      if (e instanceof ProviderError && e.code === "unsafe_url")
        return deterministic("result_missing", e.message);
      return transient(e instanceof Error ? e.message : "Downloading the result failed.");
    }
  }
  if (!bytes)
    return deterministic(
      "result_too_large",
      `Every result the provider offered is larger than Prism's ${MAX_SPLAT_BYTES / 1024 / 1024} MB splat limit (${tooLarge} checked).`,
    );

  const out = await ingestReconstructionResult(deps, job, {
    bytes,
    label: chosen.label,
    fileHint: chosen.format === "glb" ? ".glb" : SPLAT_FORMAT_INFO[chosen.format].extension,
    // what the provider claimed about scale: an ESTIMATE at most, never exact
    calibration: providerEstimatedCalibration(extracted.metricScaleFactor, extracted.groundPlaneOffset),
    providerResult: {
      ...extracted.metadata,
      resolution: chosen.label,
      skippedTooLarge: tooLarge,
      ingestAttempts: attempts,
    },
  });
  switch (out.kind) {
    case "succeeded":
    case "lost_race":
      return out.job;
    case "invalid":
      return deterministic(out.code, out.message.replace(/^The result/, "The provider result"));
    case "store_failed":
      return transient(out.message);
  }
}

// ───────────────────────── shared result ingestion ─────────────────────────

export type IngestDeps = Pick<
  JobServiceDeps,
  "repo" | "store" | "storage" | "userId" | "now" | "newId" | "locationName" | "log"
>;

/** A finished result, from a hosted provider's download or the local engine's output. */
export interface ResultToIngest {
  bytes: Uint8Array;
  /** what the result is called (World Labs: the resolution, e.g. "full_res"; local: the quality profile) */
  label: string;
  /** the file extension the bytes claim to be (the validator decides what they are) */
  fileHint: string;
  calibration: SplatCalibration;
  /** sanitised, URL-free provenance; stored with the job result and the reconstruction's generation metadata */
  providerResult: Record<string, unknown>;
  /** when the producer already hashed the bytes (the local engine), they must hash to exactly this */
  expectedChecksum?: string | null;
}

export type IngestOutcome =
  | { kind: "succeeded"; job: ReconstructionJobRecord }
  /** another writer completed (or ended) this job first; ours left nothing behind */
  | { kind: "lost_race"; job: ReconstructionJobRecord }
  /** the bytes are not an acceptable result: retrying cannot help */
  | { kind: "invalid"; code: "result_invalid" | "result_too_large"; message: string }
  /** storage or the database failed: nothing was kept, and the caller may try again */
  | { kind: "store_failed"; message: string };

/**
 * THE persistence of a reconstruction result, shared by hosted providers (M2D.2) and the local worker (M2D.3B).
 * The job must be `ingesting` (its claimed revision). Prism's own validation decides: size cap, splat validation and
 * checksum; then the private Asset object + row, the immutable generated reconstruction and the job's success are
 * written all-or-nothing (persistPassBundle + completeReconstructionJob, compare-and-set on the job and exactly one
 * reconstruction per job in the database). On any failure everything this attempt wrote is removed.
 */
export async function ingestReconstructionResult(
  deps: IngestDeps,
  job: ReconstructionJobRecord,
  result: ResultToIngest,
): Promise<IngestOutcome> {
  const { bytes } = result;
  if (bytes.length > MAX_SPLAT_BYTES)
    return {
      kind: "invalid",
      code: "result_too_large",
      message: `The result is larger than Prism's ${MAX_SPLAT_BYTES / 1024 / 1024} MB splat limit.`,
    };
  // Prism's own validation decides, not the producer's "succeeded"
  const inspected = inspectSplat(bytes, `result${result.fileHint}`);
  if (!inspected.ok)
    return {
      kind: "invalid",
      code: "result_invalid",
      message: `The result is not a valid splat: ${inspected.error}`,
    };
  const sum = createHash("sha256").update(bytes).digest("hex");
  if (result.expectedChecksum && result.expectedChecksum !== sum)
    return {
      kind: "invalid",
      code: "result_invalid",
      message: "The result does not match its recorded checksum.",
    };

  const assetId = deps.newId();
  const info = SPLAT_FORMAT_INFO[inspected.format];
  const objectPath = buildObjectPath(job.projectId, assetId, `${assetId}${info.extension}`);
  const stamp = deps.now();
  const location = deps.locationName(job.locationId) ?? "Location";
  const asset = assetSchema.parse({
    id: assetId,
    projectId: job.projectId,
    createdBy: deps.userId,
    type: "3d",
    purpose: "spatial_reconstruction",
    source: "provider_output",
    name: `${location} — reconstruction (${job.provider}, attempt ${job.attempt})`,
    originalFilename: `${result.label}${info.extension}`,
    storageProvider: deps.storage.name,
    bucket: deps.storage.bucket,
    objectPath,
    mime: info.mime,
    byteSize: bytes.length,
    checksum: sum,
    width: null,
    height: null,
    durationMs: null,
    frameRate: null,
    sampleRate: null,
    channels: null,
    tags: ["gaussian_splat", inspected.format, "generated"],
    notes: "",
    metadata: {
      gaussianCount: inspected.gaussianCount,
      format: inspected.format,
      jobId: job.id,
      resolution: result.label,
    },
    createdAt: stamp,
    updatedAt: stamp,
  });
  const providerResult = {
    ...result.providerResult,
    format: inspected.format,
    gaussianCount: inspected.gaussianCount,
  };

  try {
    const out = await persistPassBundle(
      deps.store,
      [{ asset, bytes, objectPath, mime: info.mime }],
      async () => {
        const r = await deps.repo.completeReconstructionJob({
          jobId: job.id,
          expectedRevision: job.revision,
          providerResult,
          now: deps.now(),
          reconstruction: {
            id: deps.newId(),
            projectId: job.projectId,
            locationId: job.locationId,
            method: "generated",
            resultKind: "gaussian_splat",
            resultAssetId: assetId,
            resultChecksum: sum,
            resultFormat: inspected.format,
            gaussianCount: inspected.gaussianCount,
            // the job's ORDER is kept (the first image is the primary one)
            sources: job.sources.map((s) => ({ assetId: s.assetId, checksum: s.checksum })),
            calibration: result.calibration,
            generation: {
              jobId: job.id,
              attempt: job.attempt,
              provider: job.provider,
              capability: job.capability,
              model: job.model,
              // a remote agent's operation id carries its lease id: never copied into the reconstruction
              operationId: remoteLeaseOf(job) ? null : job.providerOperationId,
              metadata: providerResult,
            },
            userId: deps.userId,
            now: deps.now(),
          },
        });
        return { existing: false, ...r };
      },
    );
    await event(deps, out.job, "succeeded", {
      reconstructionId: out.reconstruction.id,
      resolution: result.label,
    });
    log(deps, {
      jobId: job.id,
      provider: job.provider,
      transition: "ingesting->succeeded",
      bytes: bytes.length,
    });
    return { kind: "succeeded", job: out.job };
  } catch (e) {
    // the attempt's Asset row and object were already removed by persistPassBundle
    if (e instanceof PrevisError && (e.code === "conflict" || e.code === "invalid")) {
      // another writer completed or ended this job first: theirs is THE outcome, ours left nothing behind
      const current = await deps.repo.getReconstructionJob(job.id);
      if (current && current.revision !== job.revision) return { kind: "lost_race", job: current };
    }
    return { kind: "store_failed", message: e instanceof Error ? e.message : "Storing the result failed." };
  }
}

// ───────────────────────── cancel / retry ─────────────────────────

export async function cancelJob(deps: JobServiceDeps, jobId: string): Promise<ReconstructionJobRecord> {
  let job = await deps.repo.getReconstructionJob(jobId);
  if (!job || job.projectId !== deps.projectId)
    throw new JobServiceError("not_found", "No such reconstruction job.");
  if (isTerminal(job.status)) return job;
  if (job.status === "submitting" || job.status === "ingesting")
    throw new JobServiceError(
      "invalid",
      "This job cannot be cancelled while it is being submitted or imported.",
    );
  await event(deps, job, "cancel_requested");
  if (job.status === "draft" || job.status === "queued") {
    job = await transition(deps, job, { status: "cancelled" });
    await event(deps, job, "cancelled", { remote: false, reason: "never submitted" });
    return job;
  }
  // an unregistered provider can still be cancelled locally: Prism just stops tracking it
  const provider = registered(deps, job.provider);
  const caps = provider?.capabilities() ?? null;
  let remote = false;
  if (provider && caps?.supportsCancel && provider.cancel) {
    try {
      remote = await provider.cancel(job.providerOperationId!);
    } catch {
      remote = false;
    }
  }
  job = await transition(deps, job, {
    status: "cancelled",
    errorMessage: remote
      ? null
      : caps && !isBillable(caps)
        ? "Prism stopped tracking this job. The provider has no cancel operation, so it may still finish."
        : "Prism stopped tracking this job. The provider has no cancel operation, so it may still finish (and charge).",
    providerOperation: { ...(job.providerOperation ?? {}), cancelConfirmedByProvider: remote },
  });
  await event(deps, job, "cancelled", { remote });
  return job;
}

/** A retry is a NEW attempt: the failed one stays history. Never automatic; the user chooses it. */
export async function retryJob(deps: JobServiceDeps, jobId: string): Promise<ReconstructionJobRecord> {
  const job = await deps.repo.getReconstructionJob(jobId);
  if (!job || job.projectId !== deps.projectId)
    throw new JobServiceError("not_found", "No such reconstruction job.");
  if (job.status !== "failed" && job.status !== "cancelled")
    throw new JobServiceError("invalid", "Only a failed or cancelled job can be retried.");
  const next = await createJob(deps, {
    locationId: job.locationId,
    sourceAssetIds: job.sources.map((s) => s.assetId),
    provider: job.provider,
    model: job.model,
    options: job.options,
    retryOf: job,
  });
  return submitJob(deps, next.id);
}
