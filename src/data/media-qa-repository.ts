import type { Asset } from "@/domain/schemas";
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
  | "analysisError"
> & { now: string };

export type NewFinding = Omit<ContinuityFinding, "id" | "runId" | "projectId" | "createdAt">;

export class MediaQaError extends Error {
  constructor(
    readonly code: "not_found" | "run_closed" | "run_in_progress" | "invalid",
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
}
