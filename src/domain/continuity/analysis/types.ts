import type { AnalyzerCapability, ContinuityCategory, ContinuitySeverity } from "../model";

/**
 * Continuity ANALYSIS vocabulary (Phase 2D). Pure; provider-independent.
 *
 *   THE MODEL DOES NOT DECIDE WHAT CONTINUITY SHOULD BE.
 *
 * Prism supplies the expected truth, the references, the criterion, the severity and the relevant media. An
 * analyzer answers one question per criterion: "does this output appear consistent with THIS explicit
 * expectation, based on THESE specific references?". Severity, expected value, aggregation and approval are
 * Prism-owned and never come back from a provider.
 */

export const ANALYSIS_MODES = ["image_set", "direct_video"] as const;
export type AnalysisMode = (typeof ANALYSIS_MODES)[number];

/** Versioned prompt/rubric identity: stored on every run so history stays interpretable. */
export const PROMPT_VERSIONS: Record<AnalysisMode, string> = {
  image_set: "continuity-gemini-image-v1",
  direct_video: "continuity-gemini-video-v1",
};
export const RUBRIC_VERSION = "continuity-rubric-1";
export const ANALYSIS_SCHEMA_VERSION = 1;

export type MediaKind = "reference" | "output_frame" | "contact_sheet" | "video";

/** One piece of media an analysis may use. Identified by Prism ids and checksums: never by URL. */
export interface AnalysisMedia {
  /** Stable label used in the prompt and in evidence ("ref:identity:1", "frame:2500", "sheet", "video"). */
  inputId: string;
  kind: MediaKind;
  /** identity | look | storyboard | location | lighting | reference | previous_shot | next_shot | output_frame ... */
  role: string;
  label: string;
  assetId: string;
  checksum: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  durationMs: number | null;
  /** Position in the output (frames only). */
  atMs: number | null;
}

export interface AnalysisCriterion {
  /** criterionId — the key of the finding this answer will be written to. */
  key: string;
  category: ContinuityCategory;
  severity: ContinuitySeverity;
  title: string;
  sourceRef: string;
  expected: string;
  capability: AnalyzerCapability;
}

export type PlanItemStatus =
  | "planned"
  /** The configured analyzer does not declare the needed capability: stays UNCHECKED, never PASS. */
  | "unsupported"
  /** No usable reference/frame media exists for this criterion. */
  | "no_media"
  /** Answered by deterministic metadata checks (no AI). */
  | "deterministic"
  /** Only a person can answer it. */
  | "manual";

export interface PlanItem {
  criterionKey: string;
  status: PlanItemStatus;
  mode: AnalysisMode | null;
  capability: AnalyzerCapability | null;
  reason: string;
  batchId: string | null;
}

export interface AnalysisBatch {
  id: string;
  mode: AnalysisMode;
  promptVersion: string;
  criterionKeys: string[];
  /** Reference inputs sent with this batch, in rank order. */
  referenceInputIds: string[];
  /** Output frames / contact sheet / video sent with this batch. */
  outputInputIds: string[];
  /** References that ranked but did NOT fit the input budget. */
  omittedReferenceInputIds: string[];
}

export interface ManifestEntry {
  inputId: string;
  assetId: string;
  checksum: string | null;
  kind: MediaKind;
  role: string;
  /** Sent to the external analyzer in at least one batch. */
  sent: boolean;
  /** Bounded derivative of the asset that was actually sent (never stored as an asset). */
  derivative: { width: number | null; height: number | null; mime: string | null } | null;
  omissionReason: "input_budget" | "no_matching_criterion" | "direct_video_disabled" | null;
}

/** What left Prism infrastructure for this run. No signed URLs, ever. */
export interface ExternalMediaManifest {
  version: 1;
  analyzer: string;
  model: string;
  entries: ManifestEntry[];
  /** Production text sent as data: criterion titles / expected values (counted, not duplicated here). */
  criteriaSent: number;
}

export interface AnalysisBudget {
  maxReferencesPerBatch: number;
  maxOutputImagesPerBatch: number;
  maxCriteriaPerBatch: number;
  maxImageBytes: number;
  maxImageDimension: number;
}

export const DEFAULT_ANALYSIS_BUDGET: AnalysisBudget = {
  maxReferencesPerBatch: 6,
  maxOutputImagesPerBatch: 5,
  maxCriteriaPerBatch: 8,
  maxImageBytes: 4 * 1024 * 1024,
  maxImageDimension: 1024,
};

export interface ContinuityAnalysisPlan {
  version: 1;
  analyzer: string;
  model: string;
  items: PlanItem[];
  batches: AnalysisBatch[];
  /** Every media item that was eligible, with sent / omitted status. */
  manifest: ExternalMediaManifest;
  budget: AnalysisBudget;
  /** Deterministic fingerprint of everything above. */
  fingerprint: string;
}

/**
 * The frozen input of one analysis. Stored on the job and (as plan/manifest) on the run. Contains ids,
 * checksums and Prism-owned text only: never signed URLs, never bytes, never credentials.
 */
export interface ContinuityAnalysisInput {
  version: 1;
  runKey: string;
  attemptId: string;
  /** The delivery master (or provider original) that is judged. */
  subjectAssetId: string;
  providerOriginalAssetId: string | null;
  criteria: AnalysisCriterion[];
  media: AnalysisMedia[];
  framing: {
    productionAspectRatio: string | null;
    deliveryWidth: number | null;
    deliveryHeight: number | null;
    providerCanvas: string | null;
    strategy: string | null;
  };
  analyzer: string;
  analyzerVersion: string;
  model: string;
  promptVersions: Record<AnalysisMode, string>;
  rubricVersion: string;
  schemaVersion: number;
  plan: ContinuityAnalysisPlan;
}

// ───────────────────────── results ─────────────────────────

export const FINDING_RESULTS = ["pass", "warn", "fail", "unchecked"] as const;
export type AnalysisFindingResult = (typeof FINDING_RESULTS)[number];

export type EvidenceSource = "reference_image" | "output_frame" | "contact_sheet" | "video" | "metadata";

export interface FindingEvidence {
  input: string;
  assetId: string | null;
  atMs: number | null;
  observation: string;
  source: EvidenceSource;
}

export interface NormalizedFinding {
  criterionKey: string;
  result: AnalysisFindingResult;
  /** Analyzer-reported, advisory, NOT a calibrated probability. */
  confidence: number | null;
  summary: string;
  evidence: FindingEvidence[];
  contradictions: string[];
  limitations: string[];
}

/**
 * Why an amount is UNKNOWN (never "zero"): the three situations are operationally different.
 *  - `provider_overloaded`: every request was answered 429/503 and none reported usage. The provider documents
 *    that such a request is not processed, but a missing usage record is still not proof of zero cost.
 *  - `ambiguous_submission`: a request may have been processed (timeout / connection lost after send).
 *  - `no_usage_reported`: a request completed but the provider returned no usage metadata.
 */
export type UnknownCostReason = "provider_overloaded" | "ambiguous_submission" | "no_usage_reported";

export interface AnalysisUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  thoughtsTokens: number | null;
  totalTokens: number | null;
  /** Set only when the cost record is `unknown`. */
  unknownReason?: UnknownCostReason;
  /** Outbound transport invocations actually made (a call a local guard stopped is never counted). */
  transportCalls?: number;
  /** Per call: [initial, correction?]. */
  calls: Array<{
    kind: "analysis" | "correction";
    inputTokens: number | null;
    outputTokens: number | null;
    thoughtsTokens: number | null;
  }>;
}

export const ANALYSIS_ERROR_CATEGORIES = [
  "rate_limit",
  "overloaded",
  "server_error",
  "timeout",
  "network",
  "auth",
  "invalid_input",
  "refused",
  "schema_invalid",
  "outcome_unknown",
  "config",
  "budget",
  "cancelled",
  /** Prism's own policy refused the request BEFORE it left the process (nothing was sent). */
  "local_policy_block",
  /** Every allowed request was answered 429/503: nothing was analysed (confirmed, not ambiguous). */
  "provider_overloaded_retry_exhausted",
] as const;
export type AnalysisErrorCategory = (typeof ANALYSIS_ERROR_CATEGORIES)[number];

export class AnalysisError extends Error {
  constructor(
    readonly category: AnalysisErrorCategory,
    readonly code: string,
    message: string,
    readonly opts: { retryAfterMs?: number; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

/**
 * One completed (or partially spent) batch, persisted on the job so a durable retry resumes where it stopped and
 * never re-sends a batch that already has its answer. Normalized findings only: no raw provider payload.
 */
export interface BatchResultEntry {
  batchId: string;
  /** false = the batch's usage was spent but it has no answer yet (a later request in it was refused 429/503). */
  complete: boolean;
  findings: NormalizedFinding[];
  calls: AnalysisUsage["calls"];
  correctionUsed: boolean;
  providerRef: string | null;
}

/** Categories where the provider rejected the request without processing it: retrying cannot double-bill. */
export const SAFE_TO_RETRY: readonly AnalysisErrorCategory[] = ["rate_limit", "overloaded"];
