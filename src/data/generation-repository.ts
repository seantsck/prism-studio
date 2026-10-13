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
    readonly code: "duplicate_active" | "project_busy" | "throttled" | "stale_shot" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "GenerationSubmitError";
  }
}

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
  limits: {
    maxActivePerProject: number;
    maxSubmitsPerMinutePerUser: number;
  };
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
  /** Narrow review write (never rewrites the creative request). Approving unapproves siblings atomically. */
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
  }): Promise<void>;
}
