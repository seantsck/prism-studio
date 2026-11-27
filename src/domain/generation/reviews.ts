/**
 * Human generation review (Phase 2E): the primary quality signal in Prism. Distinct from the creative
 * approval of an attempt (`generation_attempts.review_status`, which makes ONE attempt the shot's output):
 * a candidate can be liked, shortlisted or rejected long before anything is promoted.
 *
 * Append-only: a changed mind is a NEW row that supersedes the previous one; nothing is rewritten.
 * Providers, workers and analyzers can never write a review.
 */
export const REVIEW_DECISIONS = ["approve", "shortlist", "reject", "unreviewed"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const DECISION_LABELS: Record<ReviewDecision, string> = {
  approve: "Good",
  shortlist: "Shortlisted",
  reject: "Rejected",
  unreviewed: "Unreviewed",
};

export const NEGATIVE_TAGS = [
  "character_identity",
  "wardrobe",
  "hair_makeup",
  "location_set",
  "props",
  "composition",
  "camera_motion",
  "body_motion",
  "facial_expression",
  "performance",
  "lip_sync",
  "dialogue_audio",
  "visual_artifacts",
  "physics",
  "lighting",
  "duration",
  "framing",
  "style",
  "prompt_adherence",
  "other",
] as const;
export type NegativeTag = (typeof NEGATIVE_TAGS)[number];

export const POSITIVE_TAGS = [
  "identity_good",
  "wardrobe_good",
  "motion_good",
  "camera_good",
  "performance_good",
  "composition_good",
  "set_good",
  "lighting_good",
  "audio_good",
  "overall_quality",
] as const;
export type PositiveTag = (typeof POSITIVE_TAGS)[number];

export const NEGATIVE_LABELS: Record<NegativeTag, string> = {
  character_identity: "Character identity",
  wardrobe: "Wardrobe",
  hair_makeup: "Hair / makeup",
  location_set: "Location / set",
  props: "Props",
  composition: "Composition",
  camera_motion: "Camera motion",
  body_motion: "Body motion",
  facial_expression: "Facial expression",
  performance: "Performance",
  lip_sync: "Lip sync",
  dialogue_audio: "Dialogue audio",
  visual_artifacts: "Visual artifacts",
  physics: "Physics",
  lighting: "Lighting",
  duration: "Duration",
  framing: "Framing",
  style: "Style",
  prompt_adherence: "Prompt adherence",
  other: "Other",
};

export const POSITIVE_LABELS: Record<PositiveTag, string> = {
  identity_good: "Identity",
  wardrobe_good: "Wardrobe",
  motion_good: "Motion",
  camera_good: "Camera",
  performance_good: "Performance",
  composition_good: "Composition",
  set_good: "Set",
  lighting_good: "Lighting",
  audio_good: "Audio",
  overall_quality: "Overall quality",
};

/** The six one-click reasons on a candidate card (everything else is under "more"). */
export const QUICK_REJECT_REASONS: Array<{ tag: NegativeTag; label: string }> = [
  { tag: "character_identity", label: "Identity" },
  { tag: "wardrobe", label: "Wardrobe" },
  { tag: "body_motion", label: "Motion" },
  { tag: "composition", label: "Composition" },
  { tag: "visual_artifacts", label: "Artifacts" },
  { tag: "other", label: "Other" },
];

/** Keyboard shortcuts on a focused candidate card (documented in docs/human-generation-review.md). */
export const REVIEW_SHORTCUTS = {
  "1": "approve",
  "2": "shortlist",
  "3": "reject",
  b: "best",
} as const;

export interface GenerationReview {
  id: string;
  projectId: string;
  attemptId: string;
  candidateSetId: string | null;
  decision: ReviewDecision;
  positiveTags: PositiveTag[];
  /** Ordered: the first tag is the primary reason. */
  negativeTags: NegativeTag[];
  notes: string;
  reviewer: string | null;
  reviewedAt: string;
  /** The review this one replaces (history stays; only the latest per attempt is "current"). */
  supersedesId: string | null;
}

export interface ReviewDraft {
  decision: ReviewDecision;
  positiveTags: string[];
  negativeTags: string[];
  notes: string;
}

export class ReviewValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewValidationError";
  }
}

const isNeg = (t: string): t is NegativeTag => (NEGATIVE_TAGS as readonly string[]).includes(t);
const isPos = (t: string): t is PositiveTag => (POSITIVE_TAGS as readonly string[]).includes(t);

/** Normalizes and validates a review. Rejection needs at least one reason; no free-text note is ever forced. */
export function normalizeReview(draft: ReviewDraft): {
  decision: ReviewDecision;
  positiveTags: PositiveTag[];
  negativeTags: NegativeTag[];
  notes: string;
} {
  if (!(REVIEW_DECISIONS as readonly string[]).includes(draft.decision)) {
    throw new ReviewValidationError("Unknown review decision.");
  }
  const dedupe = <T extends string>(xs: T[]) => [...new Set(xs)];
  const negative = dedupe(draft.negativeTags.filter(isNeg));
  const positive = dedupe(draft.positiveTags.filter(isPos));
  const notes = draft.notes.trim().slice(0, 1000);
  switch (draft.decision) {
    case "reject":
      if (negative.length === 0) throw new ReviewValidationError("Choose at least one reason for rejecting.");
      return { decision: "reject", positiveTags: [], negativeTags: negative, notes };
    case "approve":
      return { decision: "approve", positiveTags: positive, negativeTags: [], notes };
    case "shortlist":
      return { decision: "shortlist", positiveTags: positive, negativeTags: negative, notes };
    default:
      return { decision: "unreviewed", positiveTags: [], negativeTags: [], notes };
  }
}

/** The current review per attempt: the newest by time (ties by id), supersession chain notwithstanding. */
export function latestReviews(reviews: readonly GenerationReview[]): Map<string, GenerationReview> {
  const out = new Map<string, GenerationReview>();
  for (const r of reviews) {
    const cur = out.get(r.attemptId);
    if (!cur || r.reviewedAt > cur.reviewedAt || (r.reviewedAt === cur.reviewedAt && r.id > cur.id)) {
      out.set(r.attemptId, r);
    }
  }
  return out;
}

export function primaryReason(r: Pick<GenerationReview, "negativeTags">): NegativeTag | null {
  return r.negativeTags[0] ?? null;
}

/** Positive for the performance statistics: a person liked it enough to keep it. */
export function isPositiveDecision(d: ReviewDecision): boolean {
  return d === "approve" || d === "shortlist";
}
