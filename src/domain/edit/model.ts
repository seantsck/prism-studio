import { isEditRate, type EditRate } from "./edit-rate";

/**
 * Phase 2I.1 Episode edit: the PERSISTED editorial decision (what a human chose), as opposed to a `proposal` (what
 * Prism suggests, see proposal.ts). Not persisted yet (2I.1B): this is the shape the repositories will store.
 *
 * Identity: the edit and every item have their own stable ids. "One edit per Episode" and "one item per Shot" are
 * Phase 2I.1 invariants checked below (and later by removable unique constraints), not identities: nothing here keys
 * an edit by its Episode or an item by its Shot.
 */

/**
 * WHAT an item shows, by kind, so a mixed or ambiguous state cannot be represented. Only `video` is a moving picture;
 * the stills are labelled placeholders and `none` is an explicit "no picture yet".
 *   video             an exact generated clip: the attempt AND the exact Asset the trims refer to (a provider output
 *                     or one of the attempt's delivery versions). Its duration IS the chosen source interval.
 *   production_frame  placeholder still: one Production Frame of the Shot, held for `durationMs`
 *   storyboard_frame  placeholder still: one Storyboard frame of the Shot, held for `durationMs`
 *   none              no picture (a labelled slate) for `durationMs`
 */
export type VisualSource =
  | { kind: "video"; attemptId: string; assetId: string; sourceInMs: number; sourceOutMs: number }
  | { kind: "production_frame"; productionFrameId: string; durationMs: number }
  | { kind: "storyboard_frame"; storyboardFrameId: string; durationMs: number }
  | { kind: "none"; durationMs: number };

export type VisualKind = VisualSource["kind"];

export const VISUAL_KIND_LABEL: Record<VisualKind, string> = {
  video: "Generated clip",
  production_frame: "Placeholder: Production Frame still",
  storyboard_frame: "Placeholder: Storyboard still",
  none: "No picture yet",
};

/** The clip's OWN audio track. Muted by default: the performance takes are the dialogue truth. */
export type SourceAudio = "muted" | "included";

/**
 * One dialogue take placed under an item. References only (line + exact take): the audio Asset, waveform and duration
 * are read through the take, never copied. Timing is relative to the ITEM's timeline start:
 *   startMs            where the take begins, relative to the item start
 *   takeInMs/takeOutMs the part of the take that plays (0 ≤ in < out ≤ take duration)
 * The shape allows a negative `startMs` (a J-cut, audio before the picture) and an end beyond the item (an L-cut);
 * Phase 2I.1 VALIDATION keeps every placement inside its item (`PLACEMENT_INSIDE_ITEM`), so J/L cuts later are a
 * relaxation of one rule, not a new model. No placement for a line = explicit silence there.
 */
export interface AudioPlacement {
  dialogueLineId: string;
  takeId: string;
  startMs: number;
  takeInMs: number;
  takeOutMs: number;
}

/**
 * The Shot's named part fingerprints (fingerprint.ts) when the performance was placed: lets the view report "the
 * performance / planned timing changed since this was placed" the way every other freshness check works (frozen parts
 * vs live). Null = placed without a basis (reported as unknown, never as fresh).
 */
export interface PlacementBasis {
  performance: string;
  timing: string;
}

export interface EditItem {
  id: string;
  shotId: string;
  visual: VisualSource;
  sourceAudio: SourceAudio;
  performance: AudioPlacement[];
  performanceBasis: PlacementBasis | null;
}

export interface EpisodeEdit {
  id: string;
  projectId: string;
  episodeId: string;
  editRate: EditRate;
  /** Bumped by every mutation (optimistic concurrency, 2I.1B). */
  revision: number;
  /** In editorial order: items are contiguous, the first starts at 0. */
  items: EditItem[];
}

/** Phase 2I.1 invariants that a later phase may relax (each names exactly one check below). */
export const ONE_ITEM_PER_SHOT = true;
export const PLACEMENT_INSIDE_ITEM = true;

/** The timeline duration of an item: a video item is EXACTLY its chosen source interval; a still holds its duration. */
export function itemDurationMs(visual: VisualSource): number {
  return visual.kind === "video" ? visual.sourceOutMs - visual.sourceInMs : visual.durationMs;
}

export const placementDurationMs = (p: AudioPlacement): number => p.takeOutMs - p.takeInMs;

export type EditShapeViolation =
  | { code: "invalid_edit_rate" }
  | { code: "duplicate_item_id"; itemId: string }
  | { code: "duplicate_shot"; shotId: string }
  | { code: "invalid_time"; itemId: string; field: string }
  | { code: "empty_item"; itemId: string }
  | { code: "duplicate_line"; itemId: string; dialogueLineId: string }
  | { code: "invalid_placement"; itemId: string; dialogueLineId: string; field: string }
  | { code: "placement_outside_item"; itemId: string; dialogueLineId: string };

const isMs = (n: number) => Number.isSafeInteger(n) && n >= 0;

/**
 * Structural checks of an edit that need no project state (integer ms, non-empty items, ordering identity,
 * Phase 2I.1 one-item-per-Shot and placement-inside-item). Source eligibility against the project is eligibility.ts.
 */
export function editShapeViolations(edit: Pick<EpisodeEdit, "editRate" | "items">): EditShapeViolation[] {
  const out: EditShapeViolation[] = [];
  if (!isEditRate(edit.editRate)) out.push({ code: "invalid_edit_rate" });
  const ids = new Set<string>();
  const shots = new Set<string>();
  for (const item of edit.items) {
    if (ids.has(item.id)) out.push({ code: "duplicate_item_id", itemId: item.id });
    ids.add(item.id);
    if (ONE_ITEM_PER_SHOT && shots.has(item.shotId))
      out.push({ code: "duplicate_shot", shotId: item.shotId });
    shots.add(item.shotId);
    out.push(...itemShapeViolations(item));
  }
  return out;
}

export function itemShapeViolations(item: EditItem): EditShapeViolation[] {
  const out: EditShapeViolation[] = [];
  const v = item.visual;
  const times: Array<[string, number]> =
    v.kind === "video"
      ? [
          ["sourceInMs", v.sourceInMs],
          ["sourceOutMs", v.sourceOutMs],
        ]
      : [["durationMs", v.durationMs]];
  for (const [field, n] of times) if (!isMs(n)) out.push({ code: "invalid_time", itemId: item.id, field });
  const duration = itemDurationMs(v);
  if (out.length === 0 && duration <= 0) out.push({ code: "empty_item", itemId: item.id });

  const lines = new Set<string>();
  for (const p of item.performance) {
    if (lines.has(p.dialogueLineId))
      out.push({ code: "duplicate_line", itemId: item.id, dialogueLineId: p.dialogueLineId });
    lines.add(p.dialogueLineId);
    if (!Number.isSafeInteger(p.startMs))
      out.push({
        code: "invalid_placement",
        itemId: item.id,
        dialogueLineId: p.dialogueLineId,
        field: "startMs",
      });
    if (!isMs(p.takeInMs) || !isMs(p.takeOutMs) || p.takeOutMs <= p.takeInMs) {
      out.push({
        code: "invalid_placement",
        itemId: item.id,
        dialogueLineId: p.dialogueLineId,
        field: "takeInMs",
      });
      continue;
    }
    if (PLACEMENT_INSIDE_ITEM && (p.startMs < 0 || p.startMs + placementDurationMs(p) > duration))
      out.push({ code: "placement_outside_item", itemId: item.id, dialogueLineId: p.dialogueLineId });
  }
  return out;
}
