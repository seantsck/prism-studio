import type { ProjectData } from "../schemas";
import type { ProductionProposal } from "./proposal";

/**
 * Phase 5B-S1: matching proposal items to what the project already has, and the creator's REVIEW of a proposal.
 * Pure. The proposal itself is immutable; the review (selection, rejections, edits, match decisions, target Episode)
 * is the only thing the creator changes, and it freezes when the proposal is applied.
 */
export const ITEM_KINDS = ["character", "location", "scene", "shot"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const itemId = (kind: ItemKind, key: string) => `${kind}:${key}`;

// ───────────────────────── matching (surfaced, never applied automatically) ─────────────────────────

/** Name as compared: lower case, no voice-over / off-screen marks, no punctuation or leading article. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\((v\.?o\.?|o\.?s\.?|o\.?c\.?|cont'?d)\)/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/^\s*the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length]![b.length]!;
}

export interface Match {
  existingId: string;
  existingName: string;
  /** exact: the same name once normalized; possible: plural / spelling / partial — the creator must decide. */
  kind: "exact" | "possible";
}

export function findMatch(name: string, existing: ReadonlyArray<{ id: string; name: string }>): Match | null {
  const n = normalizeName(name);
  if (!n) return null;
  const exact = existing.find((e) => normalizeName(e.name) === n);
  if (exact) return { existingId: exact.id, existingName: exact.name, kind: "exact" };
  const stem = (s: string) => s.replace(/(es|s)$/, "");
  const possible = existing.find((e) => {
    const m = normalizeName(e.name);
    if (!m) return false;
    if (stem(m) === stem(n)) return true;
    if (Math.min(m.length, n.length) >= 5 && editDistance(m, n) <= 2) return true;
    const a = new Set(n.split(" "));
    const b = new Set(m.split(" "));
    const shared = [...a].filter((w) => b.has(w) && w.length > 2).length;
    return shared > 0 && shared / Math.max(a.size, b.size) >= 0.6;
  });
  return possible ? { existingId: possible.id, existingName: possible.name, kind: "possible" } : null;
}

export function proposalMatches(p: ProductionProposal, data: Pick<ProjectData, "characters" | "locations">) {
  const out: Record<string, Match> = {};
  for (const c of p.characters) {
    const m = findMatch(c.name, data.characters);
    if (m) out[itemId("character", c.key)] = m;
  }
  for (const l of p.locations) {
    const m = findMatch(l.name, data.locations);
    if (m) out[itemId("location", l.key)] = m;
  }
  return out;
}

// ───────────────────────── review ─────────────────────────

export const MATCH_DECISIONS = ["use_existing", "create_new", "merge"] as const;
export type MatchDecision = (typeof MATCH_DECISIONS)[number];

export interface ItemReview {
  selected: boolean;
  rejected: boolean;
  /** Edited proposal fields (only the EDITABLE ones), applied instead of the proposal's value. */
  edits: Record<string, string>;
  /** Present when the item has a possible match: what to do with it (null = not decided yet). */
  match: { existingId: string; decision: MatchDecision | null } | null;
}

export interface ProposalReview {
  version: 1;
  items: Record<string, ItemReview>;
  /** Edited story fields (title / logline / synopsis). */
  story: Record<string, string>;
  /** Where Scenes and Shots go: a new Episode, or the end of an existing one. */
  target: { kind: "new_episode" } | { kind: "existing_episode"; episodeId: string };
}

export const EDITABLE: Record<ItemKind | "story", readonly string[]> = {
  story: ["title", "logline", "synopsis"],
  character: ["name", "role", "description", "personality", "visualNotes"],
  location: ["name", "description", "timeStateNotes"],
  scene: ["heading", "timeOfDay", "summary", "purpose"],
  shot: ["purpose", "visualIntent"],
};
export const MAX_EDIT = 4000;

/** Everything selected; an exact match proposes "use existing" (changeable); a possible match waits for the creator. */
export function defaultReview(
  p: ProductionProposal,
  matches: Record<string, Match>,
  target: ProposalReview["target"] = { kind: "new_episode" },
): ProposalReview {
  const items: Record<string, ItemReview> = {};
  const add = (kind: ItemKind, key: string) => {
    const id = itemId(kind, key);
    const m = matches[id];
    items[id] = {
      selected: true,
      rejected: false,
      edits: {},
      match: m ? { existingId: m.existingId, decision: m.kind === "exact" ? "use_existing" : null } : null,
    };
  };
  for (const c of p.characters) add("character", c.key);
  for (const l of p.locations) add("location", l.key);
  for (const s of p.scenes) add("scene", s.key);
  for (const s of p.shots) add("shot", s.key);
  return { version: 1, items, story: {}, target };
}

/** The proposal item with the creator's edits applied (only editable string fields). */
export function edited<T extends object>(
  kind: ItemKind | "story",
  item: T,
  edits: Record<string, string>,
): T {
  const allowed = EDITABLE[kind];
  const out = { ...item } as Record<string, unknown>;
  for (const [k, v] of Object.entries(edits)) if (allowed.includes(k)) out[k] = v.slice(0, MAX_EDIT);
  return out as T;
}

/** An item goes in only when selected and not rejected. */
export const isIncluded = (r: ItemReview | undefined) => !!r && r.selected && !r.rejected;
