import { z } from "zod";
import { fingerprint, sha256 } from "../hash";

/**
 * Reconstruction jobs (Phase 2F M2D.2): the ORCHESTRATION that creates a Location's spatial reconstruction from
 * reference images through an external provider.
 *
 *   ReconstructionJob  (Prism; this module)      what was asked, from which inputs, which attempt, its state
 *   ProviderOperation  (external, temporary)     the provider's long-running execution state, by id
 *   ProviderResult     (external, transport)     result candidates; provider URLs are transport only
 *   Prism Asset        (Prism, private)          the downloaded, validated result bytes
 *   SpatialReconstruction (Prism, immutable)     origin truth, the same record an import produces (M2D.1)
 *   Set scene object   (Prism, mutable)          placement, only after an explicit "Use as Spatial Environment"
 *
 * The provider is never the source of truth: a job's status is derived by the Prism server, and a provider "success"
 * only becomes a Prism success after the bytes are downloaded, validated and stored privately.
 */

export const RECONSTRUCTION_JOB_SCHEMA = "prism.reconstruction-job.v1" as const;

export const RECONSTRUCTION_PROVIDER_IDS = ["worldlabs_marble", "meshy", "mock_reconstruction"] as const;
export type ReconstructionProviderId = (typeof RECONSTRUCTION_PROVIDER_IDS)[number];

export const RECONSTRUCTION_RESULT_KINDS = ["gaussian_splat", "mesh"] as const;
export type ReconstructionResultKind = (typeof RECONSTRUCTION_RESULT_KINDS)[number];

/** Job status (Prism's view). Provider operation status is separate (see ProviderOperationStatus). */
export const JOB_STATUSES = [
  "draft",
  "queued",
  "submitting",
  "running",
  "ingesting",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const TERMINAL_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "cancelled"];
export const isTerminal = (s: JobStatus) => TERMINAL_STATUSES.includes(s);

/**
 * The ONLY allowed transitions. Terminal states never move again (a retry is a NEW job attempt). `running → running`
 * is a progress update. The database enforces the same matrix (migration 0036).
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  draft: ["queued", "cancelled"],
  queued: ["submitting", "failed", "cancelled"],
  submitting: ["running", "failed"],
  running: ["running", "ingesting", "failed", "cancelled"],
  ingesting: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** The provider's operation status, normalised. Distinct from the job status on purpose. */
export const PROVIDER_OPERATION_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "expired",
  "cancelled",
] as const;
export type ProviderOperationStatus = (typeof PROVIDER_OPERATION_STATUSES)[number];

export const JOB_ERROR_CODES = [
  "not_configured",
  "capability_unavailable",
  "spend_blocked",
  "invalid_sources",
  "submit_failed",
  "submit_ambiguous",
  "provider_failed",
  "provider_timeout",
  "result_missing",
  "result_too_large",
  "result_invalid",
  "ingest_failed",
  "cancelled",
] as const;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

export const JOB_EVENTS = [
  "created",
  "queued",
  "submitted",
  "provider_running",
  "progress",
  "provider_succeeded",
  "ingesting",
  "succeeded",
  "failed",
  "cancel_requested",
  "cancelled",
  "retry_created",
] as const;
export type JobEvent = (typeof JOB_EVENTS)[number];

// ───────────────────────── input snapshot (frozen by value, ORDERED) ─────────────────────────

export const jobSourceSchema = z.object({
  /** 0-based position the user chose: 0 is the primary / first image. Provider semantics may depend on it. */
  ordinal: z.number().int().nonnegative(),
  assetId: z.string().min(1),
  checksum: z.string().nullable(),
  mime: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
});
export type JobSource = z.infer<typeof jobSourceSchema>;

/** Assigns ordinals in the given order. Order is preserved, never sorted: the first image is the primary one. */
export function orderedSources(sources: Array<Omit<JobSource, "ordinal">>): JobSource[] {
  return sources.map((s, i) => ({ ...s, ordinal: i }));
}

export const MAX_JOB_SOURCES = 8;

export function validateSources(sources: JobSource[]): { ok: true } | { ok: false; error: string } {
  if (sources.length === 0) return { ok: false, error: "Choose at least one reference image." };
  if (sources.length > MAX_JOB_SOURCES)
    return { ok: false, error: `At most ${MAX_JOB_SOURCES} reference images can be used.` };
  const ids = new Set<string>();
  for (const [i, s] of sources.entries()) {
    if (s.ordinal !== i) return { ok: false, error: "The reference images are not in a valid order." };
    if (ids.has(s.assetId)) return { ok: false, error: "The same reference image is listed twice." };
    ids.add(s.assetId);
    if (!s.mime?.startsWith("image/")) return { ok: false, error: "Every source must be an image Asset." };
  }
  return { ok: true };
}

// ───────────────────────── options ─────────────────────────

/** Provider-neutral options. Provider-specific options are a separate, canonicalised object. */
export const jobOptionsSchema = z.object({
  /** human label, metadata only (never part of the fingerprint) */
  displayName: z.string().max(64).nullable().default(null),
  /** provider-specific options (e.g. World Labs `reconstruct_images`, `seed`, mock scenario) */
  provider: z.record(z.string(), z.unknown()).default({}),
});
export type JobOptions = z.infer<typeof jobOptionsSchema>;

// ───────────────────────── identity ─────────────────────────

export interface JobIdentity {
  projectId: string;
  locationId: string;
  sources: JobSource[];
  provider: ReconstructionProviderId;
  capability: string;
  model: string | null;
  resultKind: ReconstructionResultKind;
  options: JobOptions;
}

/**
 * Identity of WHAT is asked: inputs in their order, provider, capability, model, result kind and canonicalised
 * options. Never status, timestamps, progress, operation ids, poll counts, provider URLs or the display name.
 */
export function jobFingerprint(j: JobIdentity): string {
  return fingerprint({
    schema: RECONSTRUCTION_JOB_SCHEMA,
    projectId: j.projectId,
    locationId: j.locationId,
    sources: j.sources.map((s) => ({
      ordinal: s.ordinal,
      assetId: s.assetId,
      checksum: s.checksum,
      mime: s.mime,
      width: s.width,
      height: s.height,
      byteSize: s.byteSize,
    })),
    provider: j.provider,
    capability: j.capability,
    model: j.model,
    resultKind: j.resultKind,
    // `fingerprint` canonicalises object keys at every depth; arrays keep their order
    options: j.options.provider,
  });
}

/**
 * The key sent to the provider for one attempt of one job (stable across ambiguous resubmissions of the SAME attempt,
 * different for a new attempt). 32 characters, within provider tag/key limits.
 */
export function idempotencyKey(jobId: string, attempt: number): string {
  return `pj${sha256(`${jobId}:${attempt}`).slice(0, 30)}`;
}

// ───────────────────────── record ─────────────────────────

export interface ReconstructionJobRecord {
  id: string;
  projectId: string;
  locationId: string;
  schemaVersion: typeof RECONSTRUCTION_JOB_SCHEMA;
  jobFingerprint: string;
  attempt: number;
  /** the failed/cancelled attempt this one retries, if any */
  previousJobId: string | null;
  provider: ReconstructionProviderId;
  capability: string;
  model: string | null;
  resultKind: ReconstructionResultKind;
  sources: JobSource[];
  options: JobOptions;
  status: JobStatus;
  /** 0..1 when the provider reports progress, else null */
  progress: number | null;
  /** compare-and-set counter; every write bumps it */
  revision: number;
  providerOperationId: string | null;
  /** sanitised, bounded provider operation subset (status, progress text, world id, cost, error): never URLs */
  providerOperation: Record<string, unknown> | null;
  /** provider-side input identities (e.g. World Labs media_asset_id per source): never upload URLs */
  providerInputs: Array<{
    ordinal: number;
    assetId: string;
    checksum: string | null;
    providerAssetId: string;
  }> | null;
  /** sanitised result metadata (candidate kinds, chosen resolution, scale estimate): never URLs */
  providerResult: Record<string, unknown> | null;
  resultReconstructionId: string | null;
  errorCode: JobErrorCode | null;
  errorMessage: string | null;
  lastPolledAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface JobEventRecord {
  id: string;
  jobId: string;
  event: JobEvent;
  detail: Record<string, unknown>;
  createdAt: string;
}

// ───────────────────────── sanitising ─────────────────────────

const URL_LIKE =
  /(https?:\/\/|blob:|data:[a-z]+\/|[?&](token|signature|sig|X-Amz-[A-Za-z-]+|X-Goog-[A-Za-z-]+|Expires)=)/i;
const SECRET_KEY = /(key|secret|token|authorization|password|signature|credential|upload_url|url)$/i;

/**
 * Keep only a bounded, URL-free, secret-free subset of a provider payload. Strings that look like URLs or keys named
 * like credentials/URLs are dropped; depth and size are capped. Applied to everything stored or logged.
 */
export function sanitizeProviderPayload(value: unknown, depth = 0): unknown {
  if (depth > 5) return undefined;
  if (typeof value === "string") return URL_LIKE.test(value) ? undefined : value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value))
    return value
      .slice(0, 20)
      .map((v) => sanitizeProviderPayload(v, depth + 1))
      .filter((v) => v !== undefined);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (SECRET_KEY.test(k)) continue;
      const s = sanitizeProviderPayload(v, depth + 1);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/(WLT-Api-Key|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .slice(0, 500);
}

// ───────────────────────── writes ─────────────────────────

export interface NewReconstructionJob {
  id: string;
  projectId: string;
  locationId: string;
  attempt: number;
  previousJobId: string | null;
  provider: ReconstructionProviderId;
  capability: string;
  model: string | null;
  resultKind: ReconstructionResultKind;
  sources: JobSource[];
  options: JobOptions;
  /** a job is created by an explicit action, so it starts QUEUED (draft exists for UI-held requests) */
  status: "draft" | "queued";
  userId: string | null;
  now: string;
}

/** Everything a server-side transition may change. Identity fields are not here: they are frozen at creation. */
export interface JobPatch {
  status?: JobStatus;
  progress?: number | null;
  providerOperationId?: string;
  providerOperation?: Record<string, unknown> | null;
  providerInputs?: ReconstructionJobRecord["providerInputs"];
  providerResult?: Record<string, unknown> | null;
  errorCode?: JobErrorCode | null;
  errorMessage?: string | null;
  lastPolledAt?: string | null;
}

export class JobTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobTransitionError";
  }
}

/**
 * Applies one server-side change to a job, enforcing the same rules as the database: terminal jobs never change,
 * transitions follow the matrix, an operation id is assigned once, a failure carries a code. Pure.
 */
export function applyJobPatch(
  job: ReconstructionJobRecord,
  patch: JobPatch,
  now: string,
): ReconstructionJobRecord {
  if (isTerminal(job.status))
    throw new JobTransitionError("A finished reconstruction job is immutable history.");
  const status = patch.status ?? job.status;
  if (status !== job.status && !canTransition(job.status, status))
    throw new JobTransitionError(`Reconstruction job transition ${job.status} -> ${status} is not allowed.`);
  if (
    patch.providerOperationId !== undefined &&
    job.providerOperationId !== null &&
    patch.providerOperationId !== job.providerOperationId
  )
    throw new JobTransitionError("A provider operation id is never replaced; retry creates a new attempt.");
  const next: ReconstructionJobRecord = {
    ...job,
    status,
    progress: patch.progress !== undefined ? clampProgress(patch.progress) : job.progress,
    providerOperationId: patch.providerOperationId ?? job.providerOperationId,
    providerOperation:
      patch.providerOperation !== undefined
        ? (sanitizeProviderPayload(patch.providerOperation) as Record<string, unknown> | null)
        : job.providerOperation,
    providerInputs: patch.providerInputs !== undefined ? patch.providerInputs : job.providerInputs,
    providerResult:
      patch.providerResult !== undefined
        ? (sanitizeProviderPayload(patch.providerResult) as Record<string, unknown> | null)
        : job.providerResult,
    errorCode: patch.errorCode !== undefined ? patch.errorCode : job.errorCode,
    errorMessage:
      patch.errorMessage !== undefined
        ? patch.errorMessage === null
          ? null
          : sanitizeErrorMessage(patch.errorMessage)
        : job.errorMessage,
    lastPolledAt: patch.lastPolledAt !== undefined ? patch.lastPolledAt : job.lastPolledAt,
    revision: job.revision + 1,
    updatedAt: now,
    completedAt: isTerminal(status) ? now : null,
  };
  if (next.status === "failed" && !next.errorCode)
    throw new JobTransitionError("A failed reconstruction job must say why (error code).");
  if (["running", "ingesting"].includes(next.status) && !next.providerOperationId)
    throw new JobTransitionError("A running reconstruction job must have its provider operation id.");
  if (next.status === "succeeded")
    throw new JobTransitionError(
      "A job succeeds only together with its reconstruction (completeReconstructionJob).",
    );
  return next;
}

const clampProgress = (p: number | null) =>
  p === null || !Number.isFinite(p) ? null : Math.min(1, Math.max(0, Math.round(p * 1000) / 1000));

export function newJobRecord(input: NewReconstructionJob): ReconstructionJobRecord {
  return {
    id: input.id,
    projectId: input.projectId,
    locationId: input.locationId,
    schemaVersion: RECONSTRUCTION_JOB_SCHEMA,
    jobFingerprint: jobFingerprint(input),
    attempt: input.attempt,
    previousJobId: input.previousJobId,
    provider: input.provider,
    capability: input.capability,
    model: input.model,
    resultKind: input.resultKind,
    sources: input.sources.map((s) => ({ ...s })),
    options: jobOptionsSchema.parse(input.options),
    status: input.status,
    progress: null,
    revision: 1,
    providerOperationId: null,
    providerOperation: null,
    providerInputs: null,
    providerResult: null,
    resultReconstructionId: null,
    errorCode: null,
    errorMessage: null,
    lastPolledAt: null,
    createdBy: input.userId,
    createdAt: input.now,
    updatedAt: input.now,
    completedAt: null,
  };
}
