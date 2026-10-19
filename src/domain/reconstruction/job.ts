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

/**
 * A provider id is an identifier, not a closed list: the server-side provider REGISTRY decides which ids are known,
 * enabled, local or hosted, free or paid. The database (migration 0037) only guarantees this shape, so adding a
 * provider needs no migration, and a job naming a provider the registry no longer has stays readable history.
 */
export type ReconstructionProviderId = string;
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const isProviderId = (id: unknown): id is ReconstructionProviderId =>
  typeof id === "string" && PROVIDER_ID_PATTERN.test(id);

/** Result kinds the job schema can record (the database allows both). */
export const RECONSTRUCTION_RESULT_KINDS = ["gaussian_splat", "mesh"] as const;
export type ReconstructionResultKind = (typeof RECONSTRUCTION_RESULT_KINDS)[number];
/**
 * Result kinds Prism can actually INGEST today. A mesh has no trustworthy ingestion path yet, so no job may request
 * one and no provider may advertise one.
 */
export const INGESTIBLE_RESULT_KINDS = [
  "gaussian_splat",
] as const satisfies readonly ReconstructionResultKind[];
export type IngestibleResultKind = (typeof INGESTIBLE_RESULT_KINDS)[number];

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

/** What one input is. Every job before the free-first pass was image-only, so a stored source without it is an image. */
export const JOB_SOURCE_KINDS = ["image", "video"] as const;
export type JobSourceKind = (typeof JOB_SOURCE_KINDS)[number];

export const jobSourceSchema = z.object({
  /** 0-based position the user chose: 0 is the primary / first image. Provider semantics may depend on it. */
  ordinal: z.number().int().nonnegative(),
  kind: z.enum(JOB_SOURCE_KINDS).default("image"),
  assetId: z.string().min(1),
  checksum: z.string().nullable(),
  mime: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
});
export type JobSource = z.infer<typeof jobSourceSchema>;

/** Assigns ordinals in the given order. Order is preserved, never sorted: the first image is the primary one. */
export function orderedSources(
  sources: Array<Omit<JobSource, "ordinal" | "kind"> & { kind?: JobSourceKind }>,
): JobSource[] {
  return sources.map((s, i) => ({ ...s, kind: s.kind ?? "image", ordinal: i }));
}

/**
 * Prism's own ceiling on one job's inputs (the database allows the same, migration 0037). Each provider declares a
 * lower maximum of its own (World Labs: 8 images); a local capture needs tens to hundreds of photos.
 */
export const MAX_JOB_SOURCES = 300;

/** How a provider receives a job's inputs. A panorama is a single image to Prism (the provider may detect it). */
export const INPUT_MODES = ["single_image", "multi_image", "panorama", "video"] as const;
export type InputMode = (typeof INPUT_MODES)[number];

/** The input mode of an ordered source list: one video, one image, or several images. */
export function inputModeOf(sources: Pick<JobSource, "kind">[]): InputMode {
  if (sources.some((s) => s.kind === "video")) return "video";
  return sources.length === 1 ? "single_image" : "multi_image";
}

export function validateSources(sources: JobSource[]): { ok: true } | { ok: false; error: string } {
  if (sources.length === 0) return { ok: false, error: "Choose at least one reference image." };
  if (sources.length > MAX_JOB_SOURCES)
    return { ok: false, error: `At most ${MAX_JOB_SOURCES} inputs can be used.` };
  const ids = new Set<string>();
  for (const [i, s] of sources.entries()) {
    if (s.ordinal !== i) return { ok: false, error: "The reference images are not in a valid order." };
    if (ids.has(s.assetId)) return { ok: false, error: "The same reference image is listed twice." };
    ids.add(s.assetId);
    if (!s.mime?.startsWith(`${s.kind}/`))
      return {
        ok: false,
        error:
          s.kind === "video"
            ? "A video input must be a video Asset."
            : "Every source must be an image Asset.",
      };
  }
  // a video job is exactly one video; images and video are never mixed in one request
  if (sources.some((s) => s.kind === "video") && sources.length !== 1)
    return { ok: false, error: "A video reconstruction takes exactly one video and no images." };
  return { ok: true };
}

// ───────────────────────── cost provenance ─────────────────────────

/**
 * What a reconstruction may cost, as Prism showed and checked it BEFORE submission. Frozen with the request.
 *   free     no money is spent (local execution, test provider)
 *   paid     the provider charges; `usd` / `providerUnits` say how much when it is documented
 *   unknown  Prism cannot tell; treated like paid by the spend gate (and blocked, since it cannot be checked)
 */
export const COST_CLASSES = ["free", "paid", "unknown"] as const;
export type CostClass = (typeof COST_CLASSES)[number];

const ordered = (r: { min: number; max: number }) => r.min <= r.max;

export const jobCostEstimateSchema = z.object({
  costClass: z.enum(COST_CLASSES),
  /** USD, ONLY when the provider publishes an authoritative conversion; null otherwise */
  usd: z
    .object({ min: z.number().nonnegative(), max: z.number().nonnegative() })
    .refine(ordered, "min must not exceed max")
    .nullable(),
  /** the provider's own billing units (e.g. World Labs credits), when documented */
  providerUnits: z
    .object({ unit: z.string().min(1).max(32), min: z.number().nonnegative(), max: z.number().nonnegative() })
    .refine(ordered, "min must not exceed max")
    .nullable(),
  /** what the figure was computed from, e.g. "marble-1.1 · single_image" */
  basis: z.string().max(200),
  /** the price table's source (a documentation reference, never a URL with credentials) */
  pricingSource: z.string().max(200).nullable(),
  /** when that price table was last checked against its source (YYYY-MM-DD) */
  pricingCheckedAt: z.string().max(32).nullable(),
});
export type JobCostEstimate = z.infer<typeof jobCostEstimateSchema>;

/** What the provider REPORTED it charged. Recorded only when a provider reports it; never derived by Prism. */
export const jobActualCostSchema = z.object({
  usd: z.number().nonnegative().nullable(),
  providerUnits: z.object({ unit: z.string().min(1).max(32), amount: z.number().nonnegative() }).nullable(),
  reportedAt: z.string().max(40),
});
export type JobActualCost = z.infer<typeof jobActualCostSchema>;

export const FREE_COST_ESTIMATE = (basis: string): JobCostEstimate => ({
  costClass: "free",
  usd: { min: 0, max: 0 },
  providerUnits: null,
  basis,
  pricingSource: null,
  pricingCheckedAt: null,
});

// ───────────────────────── options ─────────────────────────

/** Provider-neutral options. Provider-specific options are a separate, canonicalised object. */
export const jobOptionsSchema = z.object({
  /** human label, metadata only (never part of the fingerprint) */
  displayName: z.string().max(64).nullable().default(null),
  /**
   * Provider-specific options. Each provider DECLARES its options (ProviderCapabilities.options); the server keeps
   * only declared keys of the declared type (normalizeProviderOptions), so this is never free-form input.
   */
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
      // an image is the historical default and is left out, so image jobs keep their pre-0037 fingerprints
      ...(s.kind !== "image" ? { kind: s.kind } : {}),
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
  /** the cost shown and checked before submission (null: none recorded, e.g. a job created before 0037) */
  costEstimate: JobCostEstimate | null;
  /** what the provider reported it charged (null: not reported; never derived) */
  actualCost: JobActualCost | null;
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
  return (
    message
      .replace(/https?:\/\/\S+/gi, "[url]")
      // any `…api-key` header or field (e.g. a provider's `X-…-Api-Key`), and authorization headers
      .replace(/([\w-]*api[_-]?key|authorization)\s*[:=]\s*\S+/gi, "$1: [redacted]")
      .slice(0, 500)
  );
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
  /** frozen with the request; null only when no estimate exists */
  costEstimate: JobCostEstimate | null;
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
  /** set only from a provider's own report */
  actualCost?: JobActualCost | null;
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
    actualCost:
      patch.actualCost !== undefined
        ? patch.actualCost === null
          ? null
          : jobActualCostSchema.parse(patch.actualCost)
        : job.actualCost,
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
    sources: input.sources.map((s) => jobSourceSchema.parse(s)),
    options: jobOptionsSchema.parse(input.options),
    status: input.status,
    progress: null,
    revision: 1,
    providerOperationId: null,
    providerOperation: null,
    providerInputs: null,
    providerResult: null,
    resultReconstructionId: null,
    costEstimate: input.costEstimate ? jobCostEstimateSchema.parse(input.costEstimate) : null,
    actualCost: null,
    errorCode: null,
    errorMessage: null,
    lastPolledAt: null,
    createdBy: input.userId,
    createdAt: input.now,
    updatedAt: input.now,
    completedAt: null,
  };
}
