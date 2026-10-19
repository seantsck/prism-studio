import { createHash } from "node:crypto";
import { PrevisError, type PrevisRepository } from "@/data/previs-repository";
import { spendBlockers } from "@/domain/generation/gate";
import {
  idempotencyKey,
  isTerminal,
  jobOptionsSchema,
  orderedSources,
  sanitizeErrorMessage,
  validateSources,
  type JobErrorCode,
  type JobEvent,
  type JobOptions,
  type JobPatch,
  type ReconstructionJobRecord,
  type ReconstructionProviderId,
} from "@/domain/reconstruction/job";
import { MAX_SPLAT_BYTES, providerEstimatedCalibration, SPLAT_FORMAT_INFO } from "@/domain/previs/splat";
import { assetSchema, type Asset } from "@/domain/schemas";
import { inspectSplat } from "@/lib/splat/inspect";
import { buildObjectPath } from "@/lib/storage-paths";
import type { ReconstructionConfig } from "@/lib/reconstruction/registry";
import {
  ProviderError,
  type OperationSnapshot,
  type PreparedInput,
  type ReconstructionProvider,
} from "@/lib/reconstruction/provider";
import { persistPassBundle, type PassStoreDeps } from "./spatial-pass-store";

/**
 * Reconstruction job orchestration (Phase 2F M2D.2). Import-safe (no Next), all effects injected, so the whole
 * lifecycle is unit-tested with fake providers, storage and repository.
 *
 * Rules that matter:
 *   - Every status change is derived HERE and written with compare-and-set; the browser never sends a status.
 *   - A billable provider is never called while the live-spend gate is closed (checked before ANY provider call).
 *   - A local timeout never fails a running provider operation and never triggers a new submission.
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
  providers: Map<ReconstructionProviderId, ReconstructionProvider>;
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

function log(deps: JobServiceDeps, entry: Record<string, unknown>) {
  (deps.log ?? ((e) => console.info(JSON.stringify(e))))({ event: "reconstruction.job", ...entry });
}

async function event(
  deps: JobServiceDeps,
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
  if (caps.billable) {
    const m = caps.models.find((x) => x.id === (model ?? caps.defaultModel));
    const blockers = spendBlockers({
      paidEnabled: deps.config.paid.enabled,
      maxUsd: deps.config.paid.maxUsd,
      // the documented MAXIMUM price is checked against the ceiling (variable pricing is never assumed cheap)
      estimate: m?.usd ? { amount: m.usd.max, currency: "USD" } : { amount: null, currency: "USD" },
    });
    if (blockers.length > 0) return { code: "spend_blocked", message: blockers[0]!.message };
  }
  return null;
}

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
  const provider = providerFor(deps, input.provider);
  const caps = provider.capabilities();
  const model = input.model ?? caps.defaultModel;
  if (model !== null && !caps.models.some((m) => m.id === model))
    throw new JobServiceError("invalid", "That model is not offered by this provider.");
  const blocked = submissionBlocker(deps, provider, model);
  if (blocked) throw new JobServiceError(blocked.code, blocked.message);

  // sources: this Project's own images, frozen BY VALUE in the user's order
  const sources = orderedSources(
    input.sourceAssetIds.map((id) => {
      const a = deps.projectAssets.find((x) => x.id === id);
      if (!a || !a.objectPath)
        throw new JobServiceError("invalid_sources", "A chosen reference image is not in this project.");
      return {
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
  if (sources.length > caps.maxImages)
    throw new JobServiceError("invalid_sources", `This provider accepts at most ${caps.maxImages} images.`);

  let options: JobOptions;
  try {
    options = jobOptionsSchema.parse(input.options ?? {});
  } catch {
    throw new JobServiceError("invalid", "The reconstruction options are not valid.");
  }
  const job = await deps.repo.createReconstructionJob({
    id: deps.newId(),
    projectId: deps.projectId,
    locationId: input.locationId,
    attempt: input.retryOf ? input.retryOf.attempt + 1 : 1,
    previousJobId: input.retryOf?.id ?? null,
    provider: input.provider,
    capability: caps.capability,
    model,
    resultKind: "gaussian_splat",
    sources,
    options,
    status: "queued",
    userId: deps.userId,
    now: deps.now(),
  });
  await event(deps, job, "created", {
    attempt: job.attempt,
    sources: sources.length,
    provider: job.provider,
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
      operation: next.providerOperationId ? `…${next.providerOperationId.slice(-8)}` : null,
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
  const provider = providerFor(deps, job.provider);

  // spend / configuration gate BEFORE any provider call (nothing is uploaded, nothing is submitted)
  const blocked = submissionBlocker(deps, provider, job.model);
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
  if (job.status !== "running" && job.status !== "ingesting") return job;
  const provider = providerFor(deps, job.provider);
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

async function applySnapshot(
  deps: JobServiceDeps,
  job: ReconstructionJobRecord,
  provider: ReconstructionProvider,
  op: OperationSnapshot,
): Promise<ReconstructionJobRecord> {
  const operation = { status: op.status, description: op.description, ...op.summary };
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

  // Prism's own validation decides, not the provider's "succeeded"
  const ext = chosen.format === "glb" ? ".glb" : SPLAT_FORMAT_INFO[chosen.format].extension;
  const inspected = inspectSplat(bytes, `result${ext}`);
  if (!inspected.ok)
    return deterministic("result_invalid", `The provider result is not a valid splat: ${inspected.error}`);

  const sum = createHash("sha256").update(bytes).digest("hex");
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
    originalFilename: `${chosen.label}${info.extension}`,
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
      resolution: chosen.label,
    },
    createdAt: stamp,
    updatedAt: stamp,
  });
  const providerResult = {
    ...extracted.metadata,
    resolution: chosen.label,
    skippedTooLarge: tooLarge,
    ingestAttempts: attempts,
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
            // what the provider claimed about scale: an ESTIMATE at most, never exact
            calibration: providerEstimatedCalibration(
              extracted.metricScaleFactor,
              extracted.groundPlaneOffset,
            ),
            generation: {
              jobId: job.id,
              attempt: job.attempt,
              provider: job.provider,
              capability: job.capability,
              model: job.model,
              operationId: job.providerOperationId,
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
      resolution: chosen.label,
    });
    log(deps, {
      jobId: job.id,
      provider: job.provider,
      transition: "ingesting->succeeded",
      bytes: bytes.length,
    });
    return out.job;
  } catch (e) {
    // the attempt's Asset row and object were already removed by persistPassBundle
    if (e instanceof PrevisError && e.code === "conflict") {
      // another poller completed this job first: theirs is THE reconstruction, ours left nothing behind
      return (await deps.repo.getReconstructionJob(job.id))!;
    }
    return transient(e instanceof Error ? e.message : "Storing the result failed.");
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
  const provider = providerFor(deps, job.provider);
  let remote = false;
  if (provider.capabilities().supportsCancel && provider.cancel) {
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
