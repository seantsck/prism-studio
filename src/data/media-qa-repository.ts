import type { Asset } from "@/domain/schemas";
import type { AnalysisJobStatus, ProviderState } from "@/domain/continuity/analysis/job-state";
import type {
  AnalysisErrorCategory,
  AnalysisUsage,
  BatchResultEntry,
  ContinuityAnalysisInput,
  ContinuityAnalysisPlan,
  ExternalMediaManifest,
  NormalizedFinding,
} from "@/domain/continuity/analysis/types";
import type { ProjectQaPolicy, QaPolicyInput } from "@/domain/continuity/automation";
import type { ContinuityCategory, ContinuityResult, ContinuitySeverity } from "@/domain/continuity/model";

/**
 * Persistence contract for derived media (lineage + delivery masters) and continuity QA runs.
 *
 * Narrow queries only: the QA and delivery screens never load a whole project to refresh. Implementations:
 * src/data/media-qa-memory.ts (memory mode, tests) and src/data/media-qa-postgres.ts (RLS-bound).
 */

export const DERIVATION_OPERATIONS = [
  "crop",
  "pad",
  "trim",
  "scale",
  "conform",
  "thumbnail",
  "frame_extract",
  "contact_sheet",
] as const;
export type DerivationOperation = (typeof DERIVATION_OPERATIONS)[number];

export interface AssetDerivation {
  id: string;
  projectId: string;
  parentAssetId: string;
  childAssetId: string;
  operation: DerivationOperation;
  derivationKey: string;
  parameters: Record<string, unknown>;
  processor: string;
  processorVersion: string;
  attemptId: string | null;
  slot: string;
  version: number;
  createdBy: string | null;
  createdAt: string;
}

export interface DerivedAsset {
  derivation: AssetDerivation;
  asset: Asset;
}

export interface NewDerivation {
  asset: Asset;
  parentAssetId: string;
  operation: DerivationOperation;
  derivationKey: string;
  parameters: Record<string, unknown>;
  processor: string;
  processorVersion: string;
  attemptId: string | null;
  slot: string;
  createdBy: string | null;
  now: string;
}

export interface AttemptDelivery {
  attemptId: string;
  projectId: string;
  assetId: string;
  originalAssetId: string;
  conform: Record<string, unknown> | null;
  selectedBy: string | null;
  selectedAt: string;
}

export const ANALYSIS_STATUSES = ["queued", "running", "complete", "failed"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export interface ContinuityRun {
  id: string;
  projectId: string;
  attemptId: string;
  runNumber: number;
  subjectAssetId: string;
  originalAssetId: string | null;
  analyzer: string;
  analyzerVersion: string;
  analyzerKind: "deterministic" | "mock" | "model" | "manual";
  rulesVersion: string;
  analysisStatus: AnalysisStatus;
  analysisError: string;
  packageFingerprint: string;
  subjectFingerprint: string;
  criteriaFingerprint: string;
  referenceFingerprint: string;
  referenceSet: Record<string, unknown>;
  /** Phase 2D: frozen analysis plan, external-media manifest and prompt/rubric/model identity (null before 2D). */
  analysisPlan: ContinuityAnalysisPlan | null;
  externalManifest: ExternalMediaManifest | null;
  promptVersion: string | null;
  rubricVersion: string | null;
  model: string | null;
  /** Phase 3A.2: identity of an AUTOMATIC run (unique per Project when set); null for manual and historical runs. */
  automationKey: string | null;
  createdBy: string | null;
  createdAt: string;
  completedAt: string | null;
  finalizedAt: string | null;
  finalizedBy: string | null;
  finalizeNote: string;
}

export interface ContinuityFinding {
  id: string;
  projectId: string;
  runId: string;
  criterionKey: string;
  category: ContinuityCategory;
  severity: ContinuitySeverity;
  title: string;
  sourceRef: string;
  expected: string;
  actual: string;
  result: ContinuityResult;
  resultSource: "deterministic" | "analyzer" | "none";
  confidence: number | null;
  notes: string;
  evidence: Record<string, unknown>;
  position: number;
  createdAt: string;
}

export interface ContinuityOverride {
  id: string;
  projectId: string;
  runId: string;
  findingId: string;
  result: ContinuityResult;
  notes: string;
  createdBy: string | null;
  createdAt: string;
}

export interface ContinuityRunView {
  run: ContinuityRun;
  findings: Array<{ finding: ContinuityFinding; overrides: ContinuityOverride[] }>;
}

export type NewRun = Omit<
  ContinuityRun,
  | "id"
  | "runNumber"
  | "createdAt"
  | "completedAt"
  | "finalizedAt"
  | "finalizedBy"
  | "finalizeNote"
  | "analysisPlan"
  | "externalManifest"
  | "promptVersion"
  | "rubricVersion"
  | "model"
  | "analysisError"
  | "automationKey"
> & {
  now: string;
  analysisPlan?: ContinuityAnalysisPlan | null;
  externalManifest?: ExternalMediaManifest | null;
  promptVersion?: string | null;
  rubricVersion?: string | null;
  model?: string | null;
};

export type NewFinding = Omit<ContinuityFinding, "id" | "runId" | "projectId" | "createdAt">;

// ───────────────────────── analysis jobs (Phase 2D) ─────────────────────────

export interface AnalysisJob {
  id: string;
  projectId: string;
  runId: string;
  attemptId: string;
  analyzer: string;
  model: string;
  status: AnalysisJobStatus;
  inputSnapshot: ContinuityAnalysisInput;
  inputAssetIds: string[];
  idempotencyKey: string;
  nextRunAt: string;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  providerState: ProviderState;
  providerRef: string | null;
  batchesTotal: number;
  batchesDone: number;
  correctionCount: number;
  /** Outbound provider transport invocations made so far (a locally refused call is never counted). */
  transportCalls: number;
  /** Batches already answered (or partially spent): a durable retry resumes after them. Normalized only. */
  batchResults: BatchResultEntry[];
  estimatedCostUsd: number | null;
  actualCostUsd: number | null;
  providerFiles: Array<{ ref: string; state: "uploaded" | "deleted" | "cleanup_failed" }>;
  lastErrorCode: string | null;
  lastErrorCategory: AnalysisErrorCategory | null;
  lastErrorMessage: string;
  cancelRequestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisCost {
  id: string;
  projectId: string;
  runId: string;
  jobId: string;
  analyzer: string;
  model: string;
  kind: "estimated" | "actual" | "unknown";
  amountUsd: number | null;
  expectedUsd: number | null;
  currency: string;
  usage: Record<string, unknown>;
  pricingVersion: string;
  recordedAt: string;
}

export interface AnalysisEvent {
  id: string;
  jobId: string;
  runId: string;
  at: string;
  fromStatus: string | null;
  toStatus: string;
  note: string;
}

export interface NewAnalysisRun {
  run: NewRun;
  findings: NewFinding[];
  job: {
    idempotencyKey: string;
    analyzer: string;
    model: string;
    snapshot: ContinuityAnalysisInput;
    inputAssetIds: string[];
    maxAttempts: number;
    estimate: {
      maxUsd: number | null;
      expectedUsd: number | null;
      usage: Record<string, unknown>;
      pricingVersion: string;
    };
  };
  limits: { maxActivePerProject: number };
}

export interface AnalysisJobPatch {
  status?: AnalysisJobStatus;
  nextRunAt?: string;
  attemptCount?: number;
  providerState?: ProviderState;
  providerRef?: string | null;
  batchesTotal?: number;
  batchesDone?: number;
  correctionCount?: number;
  transportCalls?: number;
  batchResults?: BatchResultEntry[];
  actualCostUsd?: number | null;
  providerFiles?: AnalysisJob["providerFiles"];
  lastErrorCode?: string | null;
  lastErrorCategory?: AnalysisErrorCategory | null;
  lastErrorMessage?: string;
  startedAt?: string | null;
  releaseLease?: boolean;
  /** Status-change reason (appended to the event trail with the transition). */
  note?: string;
  /** An audit event WITHOUT a status change (e.g. one provider request attempt). Safe metadata only. */
  event?: string;
}

export interface AnalysisCostRecord {
  kind: "actual" | "unknown";
  amountUsd: number | null;
  usage: AnalysisUsage;
  pricingVersion: string;
  analyzer: string;
  model: string;
}

export interface FinalizeAnalysisSuccess {
  jobId: string;
  leaseToken: string;
  runId: string;
  /** Every criterion the analysis was asked about, including those it could not judge (as unchecked). */
  findings: NormalizedFinding[];
  cost: AnalysisCostRecord;
  providerRef: string | null;
  correctionCount: number;
  note: string;
  now: string;
}

export interface FinalizeAnalysisFailure {
  jobId: string;
  leaseToken: string;
  runId: string;
  errorCode: string;
  errorCategory: AnalysisErrorCategory;
  errorMessage: string;
  /** The user cancelled: the job ends `cancelled` (not `failed`). */
  cancelled?: boolean;
  /** Spend that may have occurred before the failure (usage of calls that returned), or unknown. */
  cost: AnalysisCostRecord | null;
  now: string;
}

export interface ClaimedAnalysisJob {
  job: AnalysisJob;
}

export interface InputAssetRef {
  assetId: string;
  objectPath: string | null;
  bucket: string | null;
  storageProvider: string;
  mime: string | null;
  byteSize: number | null;
  checksum: string | null;
  width: number | null;
  height: number | null;
}

/** Worker-side persistence for continuity analysis (narrow authority: see migration 0022). */
export interface AnalysisWorkerStore {
  claim(opts: {
    workerId: string;
    now: string;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedAnalysisJob[]>;
  heartbeat(jobId: string, leaseToken: string, now: string, leaseMs: number): Promise<boolean>;
  update(jobId: string, leaseToken: string, patch: AnalysisJobPatch, now: string): Promise<AnalysisJob>;
  /** Marks the run `running` (queued → running). */
  startRun(runId: string, now: string): Promise<void>;
  /** The storage reference of an asset named by this job's frozen snapshot (null for anything else). */
  findInputAsset(jobId: string, assetId: string): Promise<InputAssetRef | null>;
  /** One transaction: apply findings, run → complete, record the final cost, job → succeeded. */
  finalizeSuccess(input: FinalizeAnalysisSuccess): Promise<AnalysisJob>;
  /** One transaction: run → failed, optional cost, job → failed. */
  finalizeFailure(input: FinalizeAnalysisFailure): Promise<AnalysisJob>;
  /** Recorded analysis spend since a time (actual where known, else the estimate ceiling): the daily ceiling. */
  spentSince(sinceIso: string): Promise<number>;
}

export class AnalysisLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Lease on continuity analysis job ${jobId} was lost`);
    this.name = "AnalysisLeaseLostError";
  }
}

export class MediaQaError extends Error {
  constructor(
    readonly code: "not_found" | "run_closed" | "run_in_progress" | "invalid" | "conflict" | "not_migrated",
    message: string,
  ) {
    super(message);
    this.name = "MediaQaError";
  }
}

export interface MediaQaRepository {
  // ── derivations / delivery masters ──
  findDerivationByKey(projectId: string, derivationKey: string): Promise<DerivedAsset | null>;
  listAttemptDerivations(attemptId: string): Promise<DerivedAsset[]>;
  listDerivationsByParent(parentAssetId: string): Promise<DerivedAsset[]>;
  /** The derivation that produced this asset (null for assets that are not derived). */
  getDerivationOfAsset(childAssetId: string): Promise<AssetDerivation | null>;
  /**
   * Why an asset cannot be deleted by lineage rules: it has derived files, is a selected delivery master or
   * original, or was the subject of a continuity run. Empty = free of lineage constraints.
   */
  assetPins(assetId: string): Promise<string[]>;
  /**
   * Atomically inserts the derived Asset and its lineage row. Idempotent on `derivationKey`: when a derivation
   * with that key already exists (a retry after a crash, a double click) the existing one is returned and
   * nothing is written. `version` is assigned per (attempt, operation, slot).
   */
  recordDerivation(input: NewDerivation): Promise<DerivedAsset & { created: boolean }>;
  getDelivery(attemptId: string): Promise<AttemptDelivery | null>;
  listProjectDeliveries(projectId: string): Promise<AttemptDelivery[]>;
  selectDelivery(input: {
    attemptId: string;
    projectId: string;
    assetId: string;
    originalAssetId: string;
    conform: Record<string, unknown> | null;
    selectedBy: string | null;
    now: string;
  }): Promise<AttemptDelivery>;

  // ── continuity QA ──
  /** Creates the run (number assigned atomically) with its criteria/findings in one transaction. */
  createRun(run: NewRun, findings: NewFinding[]): Promise<ContinuityRunView>;
  /**
   * Phase 3A.2: the ONE automatic run for `automationKey` in this Project. Atomic: concurrent callers with the same key
   * get the same run (`created` is true for exactly one of them). Manual runs never carry a key, so people can re-run.
   */
  ensureAutomaticRun(
    run: NewRun,
    findings: NewFinding[],
    automationKey: string,
  ): Promise<{ run: ContinuityRunView; created: boolean }>;
  getRun(runId: string): Promise<ContinuityRunView | null>;
  listAttemptRuns(attemptId: string): Promise<ContinuityRunView[]>;
  /** The most recent run per attempt for a project (QA dashboard / shot list). */
  listLatestProjectRuns(projectId: string): Promise<ContinuityRunView[]>;
  setAnalysisStatus(
    runId: string,
    status: AnalysisStatus,
    now: string,
    error?: string,
  ): Promise<ContinuityRun | null>;
  /** Writes analyzer results into the findings of a run that is still being analysed. */
  applyAnalysis(
    runId: string,
    results: Array<{
      criterionKey: string;
      result: ContinuityResult;
      actual: string;
      confidence: number | null;
      notes: string;
      evidence: Record<string, unknown>;
    }>,
  ): Promise<void>;
  /** Explicit human decision on one finding; append-only, the latest wins. */
  addOverride(input: {
    runId: string;
    findingId: string;
    result: ContinuityResult;
    notes: string;
    createdBy: string | null;
    now: string;
  }): Promise<ContinuityOverride>;
  finalizeRun(
    runId: string,
    input: { by: string | null; note: string; now: string },
  ): Promise<ContinuityRun | null>;

  // ── analysis jobs ──
  /**
   * Atomic: validates limits, then writes the run (frozen plan + manifest) + findings + queued job + estimated
   * cost + first event in ONE transaction. Idempotent on `job.idempotencyKey`.
   */
  createAnalysisRunWithJob(
    input: NewAnalysisRun,
  ): Promise<{ run: ContinuityRunView; job: AnalysisJob; duplicate: boolean }>;
  getAnalysisJob(jobId: string): Promise<AnalysisJob | null>;
  listAttemptAnalysisJobs(attemptId: string): Promise<AnalysisJob[]>;
  listActiveProjectAnalysisJobs(projectId: string): Promise<AnalysisJob[]>;
  listAnalysisCosts(runId: string): Promise<AnalysisCost[]>;
  listAnalysisEvents(jobId: string): Promise<AnalysisEvent[]>;
  /** queued → cancelled locally; otherwise cancel_requested (the worker stops before the next request). */
  requestAnalysisCancel(jobId: string, now: string): Promise<AnalysisJob | null>;
  /** Analysis spend since a time: actual where known, otherwise the estimate ceiling (never under-counted). */
  analysisSpentSince(projectId: string | null, sinceIso: string): Promise<number>;

  // ── Project QA policy (Phase 3A.2, owner only) ──
  /** The Project's policy; the default (semantic automation off, revision 0) when none was ever saved. */
  getQaPolicy(projectId: string): Promise<ProjectQaPolicy>;
  /**
   * Saves the policy when `expectedRevision` is still current (0 = none saved yet); the revision goes up by exactly one.
   * A stale page gets `conflict` and overwrites nothing.
   */
  saveQaPolicy(input: {
    projectId: string;
    policy: QaPolicyInput;
    expectedRevision: number;
    by: string | null;
    now: string;
  }): Promise<ProjectQaPolicy>;
}
