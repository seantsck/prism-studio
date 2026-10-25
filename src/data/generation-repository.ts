import type { Asset, GenerationAttempt } from "@/domain/schemas";
import type {
  CancelOutcome,
  CostEstimate,
  GenerationCost,
  GenerationErrorCategory,
  GenerationEvent,
  GenerationJob,
  GenerationOutput,
  JobStatus,
  OutputRole,
  RejectionCategory,
  ReviewStatus,
} from "@/domain/generation/schemas";

/**
 * Persistence contracts for generation. Two audiences, one data model:
 *
 *   GenerationRepository  the application path (acts as the signed-in user; RLS applies in Postgres).
 *                         NARROW queries only: status refreshes must never load the whole project.
 *   GenerationStore       the worker path (server credential, no browser session). Operates on jobs that
 *                         were already authorised and queued by GenerationRepository.
 *
 * Implementations: src/data/generation-memory.ts (memory mode, tests) and src/data/generation-postgres.ts.
 */

export class GenerationSubmitError extends Error {
  constructor(
    readonly code:
      | "duplicate_active"
      | "project_busy"
      | "throttled"
      | "stale_shot"
      | "stale_package"
      | "stale_animation_source"
      | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "GenerationSubmitError";
  }
}

/** `stale_animation_source`: the Shot's selected Production Frame is not the one the animation was prepared from. */
export const STALE_ANIMATION_SOURCE_MESSAGE =
  "The Production Frame changed while this animation was being submitted. Review the current Production Frame and animate again.";

/**
 * Creative approval is the Shot's ONE approved output (one per Shot, any Shot-output purpose), so a Production Frame
 * candidate must never take it: approving one would silently supersede the Shot's approved video.
 */
export const NOT_SHOT_OUTPUT_APPROVAL_MESSAGE =
  "Only a Shot output can be approved. A Production Frame candidate becomes the Production Frame with “Use as Production Frame” instead.";

export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Lease on generation job ${jobId} was lost`);
    this.name = "LeaseLostError";
  }
}

export interface AttemptOutputView {
  output: GenerationOutput;
  asset: Asset;
}

export interface AttemptView {
  attempt: GenerationAttempt;
  /** The most recent job (an attempt normally has exactly one). */
  job: GenerationJob | null;
  outputs: AttemptOutputView[];
  costs: GenerationCost[];
}

export interface ProjectGenerationRow {
  attempt: Pick<
    GenerationAttempt,
    | "id"
    | "shotId"
    | "attemptNumber"
    | "provider"
    | "model"
    | "status"
    | "reviewStatus"
    | "approved"
    | "rejectionCategories"
    | "createdAt"
    | "requestModality"
  >;
  job: GenerationJob | null;
  primaryAssetId: string | null;
  estimated: number | null;
  actual: number | null;
  currency: string;
}

export interface GenerationFilters {
  statuses?: JobStatus[];
  provider?: string;
  model?: string;
  review?: ReviewStatus;
  shotIds?: string[];
  limit?: number;
}

export interface CreateAttemptInput {
  /** Fully built attempt MINUS the number, which is assigned atomically with the insert. */
  attempt: Omit<GenerationAttempt, "attemptNumber">;
  job: {
    id: string;
    idempotencyKey: string;
    maxAttempts: number;
    queuePriority: number;
    currency: string;
  };
  estimate: CostEstimate;
  /** The shot revision the package was built from; submission is refused if the shot moved since. */
  expectedShotUpdatedAt: string;
  /**
   * `projectRevision()` read BEFORE the project data the package was built from. Submission is refused when
   * a revision-covered package input (looks, takes, locations, assets, other shots...) changed since. The
   * Production Frame, Location View and Character Continuity selection tables are NOT revision-covered (see
   * docs/roadmap.md). `null` opts out of the check (tests/scripts only; the server action always supplies it).
   */
  expectedProjectRevision: string | null;
  /**
   * Phase 2H (`animate_production_frame` only; set by `prepareSubmission`, never by hand): the Production Frame
   * the frozen package animates. A NEW attempt is accepted only if the Shot has exactly this frame selected at the
   * insertion boundary, checked atomically with the insert (`stale_animation_source` otherwise). An idempotent
   * replay of an already accepted attempt is unaffected. Absent / null: no extra check (every other purpose).
   */
  expectedAnimationProductionFrameId?: string | null;
  limits: {
    maxActivePerProject: number;
    maxSubmitsPerMinutePerUser: number;
  };
  /**
   * Phase 2E: this attempt is one candidate of an explicit candidate set, so other active generations of the
   * same shot are expected and do not make it a duplicate. The project-wide active limit still applies.
   */
  allowConcurrentOnShot?: boolean;
  now: string;
}

export interface ReviewInput {
  status: ReviewStatus;
  categories: RejectionCategory[];
  reason: string;
  notes: string;
  now: string;
}

export interface GenerationRepository {
  /**
   * Opaque revision of the revision-covered package inputs (generation history excluded; the later Production
   * Frame, Location View and Character Continuity selection tables are not yet covered). Read it BEFORE loading
   * the project, then pass it as `expectedProjectRevision`: a change to a covered input committed in between
   * makes the submission fail with `stale_package` instead of freezing a package nobody validated.
   */
  projectRevision(slug: string): Promise<{ projectId: string; revision: string } | null>;
  /** Atomic: validates, then writes attempt + job + estimated cost + first event in ONE transaction. */
  createAttemptWithJob(
    input: CreateAttemptInput,
  ): Promise<{ attempt: GenerationAttempt; job: GenerationJob; duplicate: boolean }>;
  getJob(jobId: string): Promise<GenerationJob | null>;
  getAttemptView(attemptId: string): Promise<AttemptView | null>;
  listShotAttempts(shotId: string): Promise<AttemptView[]>;
  /** Cheap polling query: jobs that are not terminal. */
  listActiveProjectJobs(projectId: string): Promise<GenerationJob[]>;
  listProjectGenerations(projectId: string, filters?: GenerationFilters): Promise<ProjectGenerationRow[]>;
  listJobEvents(jobId: string): Promise<GenerationEvent[]>;
  /** queued → cancelled locally; otherwise cancel_requested (the worker asks the provider). */
  requestCancel(jobId: string, now: string): Promise<GenerationJob | null>;
  /**
   * Narrow review write (never rewrites the creative request). Approving unapproves siblings atomically and is refused
   * for an attempt that is not a Shot output (`NOT_SHOT_OUTPUT_APPROVAL_MESSAGE`).
   */
  reviewAttempt(attemptId: string, review: ReviewInput): Promise<GenerationAttempt | null>;
}

// ───────────────────────── Worker side ─────────────────────────

export interface ClaimedJob {
  job: GenerationJob;
  attempt: GenerationAttempt;
  /** Owner of the project, for storage ownership + audit. */
  ownerUserId: string;
}

export interface JobPatch {
  status?: JobStatus;
  providerJobId?: string | null;
  providerStatus?: string;
  nextRunAt?: string;
  attemptCount?: number;
  pollCount?: number;
  submittedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  cancelledAt?: string | null;
  cancelOutcome?: CancelOutcome | null;
  lastPolledAt?: string | null;
  lastErrorCode?: string | null;
  lastErrorCategory?: GenerationErrorCategory | null;
  lastErrorMessage?: string;
  actualCost?: number | null;
  /** Give the lease back (the job becomes claimable again once next_run_at is due). */
  releaseLease?: boolean;
  /** Free-text note stored on the status-change event. */
  note?: string;
}

export interface FinalizeSuccess {
  jobId: string;
  leaseToken: string;
  attemptId: string;
  /** Assets already uploaded to storage, to be recorded + linked. First `primary` becomes output_asset_id. */
  outputs: Array<{
    asset: Asset;
    role: OutputRole;
    position: number;
    provenance: Record<string, unknown>;
  }>;
  cost: {
    kind: "actual" | "unknown";
    amount: number | null;
    currency: string;
    basis: string;
    units: number | null;
  };
  durationMs: number | null;
  providerStatus: string;
  now: string;
}

export interface GenerationStore {
  claim(opts: { workerId: string; now: string; leaseMs: number; limit: number }): Promise<ClaimedJob[]>;
  /** Extends the lease. Returns false when the lease was lost (job re-claimed by someone else). */
  heartbeat(jobId: string, leaseToken: string, now: string, leaseMs: number): Promise<boolean>;
  /** Validated, lease-checked update. Mirrors execution status onto the attempt. Throws LeaseLostError. */
  update(jobId: string, leaseToken: string, patch: JobPatch, now: string): Promise<GenerationJob>;
  /** One transaction: assets + outputs + attempt result + final cost + job → succeeded. */
  finalizeSuccess(input: FinalizeSuccess): Promise<GenerationJob>;
  /** Final cost row for terminal jobs without success (unknown billing after a provider-side start). */
  recordUnknownCost(args: {
    jobId: string;
    attemptId: string;
    projectId: string;
    provider: string;
    model: string;
    currency: string;
    basis: string;
    now: string;
    /** When the provider DID report what a non-successful task cost, it is recorded as `actual`. */
    amount?: number | null;
  }): Promise<void>;
  /**
   * Storage reference of an asset that is an INPUT of this attempt (null for anything else, so a worker can
   * only ever hand a provider the inputs the frozen attempt names).
   */
  findInputAsset(attemptId: string, assetId: string): Promise<InputAssetRef | null>;
  /** Jobs of this provider/model in flight at the provider (submitting/submitted/processing). */
  countProviderActive(provider: string, model: string): Promise<number>;
}

export interface InputAssetRef {
  assetId: string;
  objectPath: string | null;
  bucket: string | null;
  storageProvider: string;
  mime: string | null;
  byteSize: number | null;
  checksum: string | null;
}
