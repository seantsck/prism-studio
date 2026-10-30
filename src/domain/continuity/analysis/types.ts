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

/**
 * `sequence_transition` (Phase 3A.4D): one CUT of an Episode Edit, judged from bounded edge media of BOTH sides (the
 * two cut-edge clips, the exact edge stills, sided references). Internal name only: the UI says "Sequence Continuity".
 */
export const ANALYSIS_MODES = ["image_set", "direct_video", "sequence_transition"] as const;
export type AnalysisMode = (typeof ANALYSIS_MODES)[number];
/** The modes of a Shot (attempt) analysis. A Shot job never carries a sequence batch, a transition job never these. */
export const SHOT_ANALYSIS_MODES = ["image_set", "direct_video"] as const;
export type ShotAnalysisMode = (typeof SHOT_ANALYSIS_MODES)[number];
export const isShotAnalysisMode = (m: AnalysisMode): m is ShotAnalysisMode =>
  (SHOT_ANALYSIS_MODES as readonly string[]).includes(m);

/**
 * Versioned prompt/rubric identity: stored on every run so history stays interpretable. `video-v2` (Phase 3A.3) is the
 * production temporal prompt (whole-clip inspection, timestamp/interval evidence, sampling precision); `video-v1` was
 * the dormant architecture-era prompt and only ever appears on historical runs.
 */
export const PROMPT_VERSIONS: Record<AnalysisMode, string> = {
  image_set: "continuity-gemini-image-v1",
  direct_video: "continuity-gemini-video-v2",
  /** 3A.4D: LEFT and RIGHT of one cut, sided evidence (never `continuity-gemini-video-v2`). */
  sequence_transition: "continuity-gemini-transition-v1",
};
/** OpenAI-adapter prompt identity (same rubric and schema; its own system instruction text). No sequence mode. */
export const OPENAI_PROMPT_VERSIONS: Record<ShotAnalysisMode, string> = {
  image_set: "continuity-openai-image-v1",
  direct_video: "continuity-openai-video-v1",
};

/** The prompt version an analyzer uses for a mode. Stored on every batch/run so history stays interpretable. */
export function promptVersionFor(analyzerId: string, mode: AnalysisMode): string {
  if (analyzerId === "openai") {
    if (!isShotAnalysisMode(mode)) throw new Error("The OpenAI analyzer has no sequence-transition prompt.");
    return OPENAI_PROMPT_VERSIONS[mode];
  }
  return PROMPT_VERSIONS[mode];
}
/** The Shot rubric. Unchanged by 3A.4D: a sequence job uses `SEQUENCE_RUBRIC_VERSION` instead. */
export const RUBRIC_VERSION = "continuity-rubric-1";
/** 3A.4D: the cut rubric (sided evidence, no editorial taste, expected truth supplied by Prism). */
export const SEQUENCE_RUBRIC_VERSION = "sequence-rubric-1";
/**
 * 2 (Phase 3A.3): direct-video evidence may carry an interval end (`endMs`) and is bounded by the clip duration.
 * Schema-1 snapshots/findings (no `endMs`) stay readable as they are; nothing historical is rewritten.
 */
export const ANALYSIS_SCHEMA_VERSION = 2;

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
  /** Position in the output (frames only). For a cut-edge still: its exact source position in the parent clip. */
  atMs: number | null;
  /**
   * 3A.4D sequence media only: which side of the cut the input belongs to; an evidence item's side is derived from it.
   * Input ids: `left:clip`, `right:clip`, `left:last`, `right:first`, `ref:left:<role>:<n>`, `ref:right:<role>:<n>`.
   */
  side?: "left" | "right";
  /**
   * 3A.4D cut-edge clips/stills: the frozen mapping clip-local time → parent source time → edit time. A clip-local
   * instant t is source `startMs + t` and edit time `itemEditStartMs + (startMs + t − sourceInMs)`. A still has
   * `startMs = endMs = atMs`. Ids and numbers only: never a URL.
   */
  edge?: {
    policy: string;
    parentAssetId: string;
    parentChecksum: string;
    startMs: number;
    endMs: number;
    sourceInMs: number;
    itemEditStartMs: number;
  };
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
  /** 3A.4D cut criteria only: the semantic cross-cut family (each one independently calibration-gated). */
  family?: string;
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
  | "manual"
  /** The analyzer could judge it, but the Project has not allowed the media it needs (full video): unchecked. */
  | "not_allowed"
  /** 3A.4D: Prism decided the criterion does not apply to this cut (`n_a`): never sent, never answered. */
  | "not_applicable";

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
  /** Direct-video batches only: the frozen temporal sampling policy (see temporal.ts). */
  sampling?: { policy: string; fps: number };
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
  omissionReason:
    | "input_budget"
    | "no_matching_criterion"
    | "direct_video_disabled"
    /** 3A.3: the Project has not allowed full-video analysis. */
    | "direct_video_not_allowed"
    /** 3A.3: the video is outside Prism's temporal bounds (duration / size / format / unknown duration). */
    | "video_not_eligible"
    /** 3A.4D: no semantic criterion of this cut may be analysed by this analyzer (no mode / not calibrated). */
    | "sequence_not_calibrated"
    /** 3A.4D: the Project has not allowed bounded cut-edge video to leave Prism (`direct_video_allowed`). */
    | "sequence_video_not_allowed"
    | null;
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
interface ContinuityAnalysisInputBase {
  version: 1;
  runKey: string;
  criteria: AnalysisCriterion[];
  media: AnalysisMedia[];
  framing: { productionAspectRatio: string | null };
  analyzer: string;
  /** the analyzer's version FOR THIS INPUT'S MODE (`provider.analysisVersion(mode)`) */
  analyzerVersion: string;
  model: string;
  rubricVersion: string;
  schemaVersion: number;
  plan: ContinuityAnalysisPlan;
}

/**
 * 3A.4D: the frozen input is discriminated by subject. A Shot input keeps exactly its pre-3A.4D shape (`subjectKind` is
 * absent on every historical snapshot); a cut input carries the cut's frozen identity instead of an attempt.
 */
export interface AttemptContinuityAnalysisInput extends ContinuityAnalysisInputBase {
  subjectKind?: "attempt";
  attemptId: string;
  /** The delivery master (or provider original) that is judged. */
  subjectAssetId: string;
  providerOriginalAssetId: string | null;
  framing: {
    productionAspectRatio: string | null;
    deliveryWidth: number | null;
    deliveryHeight: number | null;
    providerCanvas: string | null;
    strategy: string | null;
  };
  promptVersions: Record<ShotAnalysisMode, string>;
}

/** What a transition job freezes about its cut (never the live Episode Edit). */
export interface FrozenTransitionIdentity {
  transitionKey: string;
  editId: string;
  episodeId: string;
  editRevision: number;
  leftItemId: string;
  rightItemId: string;
  leftShotId: string;
  rightShotId: string;
  subjectFingerprint: string;
  leftSubjectFingerprint: string;
  rightSubjectFingerprint: string;
  criteriaFingerprint: string;
  referenceFingerprint: string;
  rulesVersion: string;
}

export interface TransitionContinuityAnalysisInput extends ContinuityAnalysisInputBase {
  subjectKind: "transition";
  transition: FrozenTransitionIdentity;
  /** the cut-edge policy the edge media were derived under (`cut-edge-static-v1`) */
  edgePolicy: string;
  /** the family-acceptance identity the plan was made under (which families the analyzer was trusted with) */
  calibration: { version: string; acceptedFamilies: string[] };
  promptVersions: { sequence_transition: string };
}

export type ContinuityAnalysisInput = AttemptContinuityAnalysisInput | TransitionContinuityAnalysisInput;

export const isTransitionInput = (i: ContinuityAnalysisInput): i is TransitionContinuityAnalysisInput =>
  i.subjectKind === "transition";

// ───────────────────────── results ─────────────────────────

export const FINDING_RESULTS = ["pass", "warn", "fail", "unchecked"] as const;
export type AnalysisFindingResult = (typeof FINDING_RESULTS)[number];

export type EvidenceSource = "reference_image" | "output_frame" | "contact_sheet" | "video" | "metadata";

export interface FindingEvidence {
  input: string;
  assetId: string | null;
  /** Approximate time in the output (direct video: within the clip; a frame: its own position). */
  atMs: number | null;
  /** Direct video only (schema 2): end of the observed interval; absent/null = a single moment. */
  endMs?: number | null;
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
    /** Input tokens served from the provider cache (billed at the cached rate where the price table has one). */
    cachedInputTokens?: number | null;
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
