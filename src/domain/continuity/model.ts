/**
 * Continuity QA vocabulary (Phase 2C). Pure.
 *
 *   QA ADVISES, humans approve. Nothing here can approve or reject a shot, and an automated score never
 *   changes creative review state.
 *
 * Distinct concerns, kept separate on purpose:
 *   generation   did the provider produce an output?          (GenerationJob / Attempt.status)
 *   continuity   does the output match production truth?      (this module)
 *   creative     does the director like it?                   (Attempt.reviewStatus)
 */

export const CONTINUITY_CATEGORIES = [
  "identity",
  "wardrobe",
  "hair",
  "makeup",
  "jewelry",
  "props",
  "location_set",
  "lighting",
  "weather",
  "time_of_day",
  "character_count",
  "screen_direction",
  "eyelines",
  "geography",
  "camera",
  "composition",
  "action_continuity",
  "duration",
  "audio",
  "lip_sync",
  "other",
] as const;
export type ContinuityCategory = (typeof CONTINUITY_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ContinuityCategory, string> = {
  identity: "Identity",
  wardrobe: "Wardrobe",
  hair: "Hair",
  makeup: "Makeup",
  jewelry: "Jewelry",
  props: "Props",
  location_set: "Location / set",
  lighting: "Lighting",
  weather: "Weather",
  time_of_day: "Time of day",
  character_count: "Character count",
  screen_direction: "Screen direction",
  eyelines: "Eyelines",
  geography: "Geography",
  camera: "Camera",
  composition: "Composition",
  action_continuity: "Action continuity",
  duration: "Duration",
  audio: "Audio",
  lip_sync: "Lip sync",
  other: "Other",
};

export const CONTINUITY_SEVERITIES = ["critical", "major", "minor"] as const;
export type ContinuitySeverity = (typeof CONTINUITY_SEVERITIES)[number];

export const CONTINUITY_RESULTS = ["pass", "warn", "fail", "n_a", "unchecked"] as const;
export type ContinuityResult = (typeof CONTINUITY_RESULTS)[number];

export const RESULT_LABELS: Record<ContinuityResult, string> = {
  pass: "Pass",
  warn: "Warning",
  fail: "Fail",
  n_a: "N/A",
  unchecked: "Unchecked",
};

/** What an analyzer says it can judge. No capability is assumed: an analyzer declares exactly its own. */
export const ANALYZER_CAPABILITIES = [
  "image_identity",
  "wardrobe",
  "object_presence",
  "scene_match",
  "character_count",
  "composition",
  "lighting",
  "video_temporal",
  "lip_sync",
  "audio",
  /**
   * 3A.4D, INTERNAL: the analyzer can execute a `sequence_transition` (cut) request. It is never proof that a semantic
   * cut family may be judged: each family is separately calibration-gated (`acceptedCrossCutFamilies`).
   */
  "cross_cut",
] as const;
export type AnalyzerCapability = (typeof ANALYZER_CAPABILITIES)[number];

/** Who is expected to answer a criterion. */
export type CriterionHandler = "deterministic" | "analyzer" | "manual";

export interface ContinuityCriterion {
  /** Stable within a run and across runs for the same production truth ("wardrobe:<characterId>"). */
  key: string;
  category: ContinuityCategory;
  severity: ContinuitySeverity;
  title: string;
  /** Where the expectation comes from in production truth ("Look: Formal Black", "Shot continuity"). */
  sourceRef: string;
  expected: string;
  handler: CriterionHandler;
  /** Analyzer capability that could judge it (null: only a person or a deterministic check can). */
  capability: AnalyzerCapability | null;
  /**
   * Phase 3A.1: the ONLY reference roles an analyzer may compare this criterion against (best first). Absent: the
   * category's default routing (`REFERENCE_PRIORITY`). Fidelity criteria name exactly one canonical reference so a
   * Production Frame check is never judged against a Storyboard sketch.
   */
  referenceRoles?: readonly string[];
  position: number;
}

export interface ReferenceItem {
  /** identity | look | storyboard | location | props | lighting | previous_shot | next_shot | performance |
   *  constraint | framing */
  role: string;
  label: string;
  assetId: string | null;
  checksum: string | null;
  /** Textual references (production constraints, delivery framing) carry their value here. */
  text: string | null;
}

export interface ReferenceSet {
  items: ReferenceItem[];
  /** Content hash of every item: a changed Look reference changes this. */
  fingerprint: string;
}

export interface FindingResult {
  criterionKey: string;
  result: ContinuityResult;
  actual: string;
  /** Who produced the result. `none` = nobody yet (unchecked). */
  source: "deterministic" | "analyzer" | "none";
  confidence: number | null;
  notes: string;
  evidence: { frames?: number[]; timeRangeMs?: [number, number] };
}

/**
 * Bump when criteria construction or check semantics change: stored on every run.
 *   2c.1  Phase 2C criteria.
 *   3a.1  Phase 3A.1 Shot fidelity: Production Frame and Location View fidelity criteria from the attempt's FROZEN
 *         package; `camera` split into `camera_framing` (stills) and `camera_movement` (temporal); forbidden objects
 *         routed to object-presence analysis and forbidden actions to temporal analysis (unchecked until enabled).
 *         Runs recorded under 2c.1 stay readable exactly as frozen; they are never rewritten.
 */
export const CONTINUITY_RULES_VERSION = "3a.1";

export const SEVERITY_ORDER: Record<ContinuitySeverity, number> = { critical: 0, major: 1, minor: 2 };
