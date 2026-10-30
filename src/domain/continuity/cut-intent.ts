import { CONTINUITY_CATEGORIES, type ContinuityCategory } from "./model";

/**
 * Cut intent (Phase 3A.4A semantics, persisted in 3A.4C on the RIGHT Episode Edit item as `incoming_cut_intent`): a
 * person's statement that a cut is deliberately discontinuous. Shared by the Episode Edit model and the cut domain,
 * so neither imports the other. It is bound to the predecessor it was declared against; it never changes criteria,
 * results or evidence, is not part of transition freshness, and never covers an edit fact.
 * Migration 0046 (`episode_cut_intent_valid`) validates exactly this shape.
 */

export const CUT_INTENT_KINDS = [
  "jump_cut",
  "montage",
  "match_cut",
  "time_jump",
  "location_jump",
  "dream_flashback",
  "axis_break",
  "lighting_transition",
  "wardrobe_progression",
  "other",
] as const;
export type CutIntentKind = (typeof CUT_INTENT_KINDS)[number];

export const CUT_INTENT_KIND_LABELS: Record<CutIntentKind, string> = {
  jump_cut: "Jump cut",
  montage: "Montage",
  match_cut: "Match cut",
  time_jump: "Time jump",
  location_jump: "Location jump",
  dream_flashback: "Dream / flashback",
  axis_break: "Axis break",
  lighting_transition: "Lighting transition",
  wardrobe_progression: "Wardrobe progression",
  other: "Other",
};

export const CUT_INTENT_NOTE_MAX = 2000;

export interface CutIntent {
  /** the left item (the predecessor) the intent was declared against */
  fromItemId: string;
  kinds: CutIntentKind[];
  /** affected categories; empty = every continuity category */
  scope: ContinuityCategory[];
  note: string;
  /** the signed-in user who declared it (set by the server, never the browser) */
  declaredBy: string | null;
  /** ISO timestamp set by the server */
  declaredAt: string;
}

/** Effective only for the cut it was declared against: A → B intent never covers C → B. */
export const cutIntentEffective = (
  intent: CutIntent | null | undefined,
  address: { leftItemId: string },
): boolean => !!intent && intent.fromItemId === address.leftItemId;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** Why a value is not a valid persisted intent (the same rules as the database's check), or null when it is. */
export function cutIntentProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not an object";
  const v = value as Record<string, unknown>;
  const keys = ["fromItemId", "kinds", "scope", "note", "declaredBy", "declaredAt"];
  if (Object.keys(v).some((k) => !keys.includes(k))) return "unknown field";
  if (typeof v.fromItemId !== "string" || !UUID.test(v.fromItemId)) return "fromItemId";
  const kinds = v.kinds;
  if (
    !Array.isArray(kinds) ||
    kinds.length < 1 ||
    kinds.length > CUT_INTENT_KINDS.length ||
    new Set(kinds).size !== kinds.length ||
    kinds.some((k) => !(CUT_INTENT_KINDS as readonly unknown[]).includes(k))
  )
    return "kinds";
  const scope = v.scope;
  if (
    !Array.isArray(scope) ||
    new Set(scope).size !== scope.length ||
    scope.some((c) => !(CONTINUITY_CATEGORIES as readonly unknown[]).includes(c))
  )
    return "scope";
  if (typeof v.note !== "string" || v.note.trim().length < 1 || v.note.trim().length > CUT_INTENT_NOTE_MAX)
    return "note";
  if (v.declaredBy !== null && (typeof v.declaredBy !== "string" || !UUID.test(v.declaredBy)))
    return "declaredBy";
  if (typeof v.declaredAt !== "string" || !ISO.test(v.declaredAt)) return "declaredAt";
  return null;
}

/** A persisted value read back as an intent; malformed database state fails clearly (never silently dropped). */
export function parseCutIntent(value: unknown): CutIntent | null {
  if (value === null || value === undefined) return null;
  const problem = cutIntentProblem(value);
  if (problem) throw new Error(`Malformed persisted cut intent (${problem}).`);
  // canonical key order (jsonb reorders keys), so an unchanged intent compares equal to the one written
  const v = value as CutIntent;
  return {
    fromItemId: v.fromItemId,
    kinds: [...v.kinds],
    scope: [...v.scope],
    note: v.note,
    declaredBy: v.declaredBy,
    declaredAt: v.declaredAt,
  };
}
