import { frameAtMs, type EditRate } from "./edit-rate";
import {
  itemDurationMs,
  maxDissolveMs,
  DISSOLVE_MIN_MS,
  type EditItem,
  type EditTitleCard,
  type EpisodeEdit,
  type TitlePlacement,
} from "./model";

/**
 * Phase 5B-V3: THE canonical timeline of an Episode edit. Every consumer that needs to know where something sits or
 * how long the edit is (the editor rows, the Scene runs, the rough-cut player, the render manifest, the tests) reads
 * it from here; nothing re-adds durations on its own.
 *
 *   opening title   [0, title)                                         when the edit has one
 *   items           each starts where the previous one ENDS, minus the incoming dissolve's overlap
 *   closing title   from the end of the last item
 *
 * Exact integer milliseconds throughout (so no rounding accumulates); frames are derived from absolute positions.
 * Titles and items never overlap each other (a title is joined by a cut); only two items can overlap, by exactly the
 * dissolve between them. Audio never changes the visual duration.
 *
 *   A 5000 ms → dissolve 500 ms → B 4000 ms   =   8500 ms (not 9000).
 */

export interface TimelineTitle {
  kind: "title";
  title: EditTitleCard;
  placement: TitlePlacement;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface TimelineItem {
  kind: "item";
  item: EditItem;
  index: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** the dissolve INTO this item (0 = a cut): the first `transitionInMs` overlap the previous item's last ms */
  transitionInMs: number;
  /** the dissolve OUT of this item into the next (0 = a cut) */
  transitionOutMs: number;
  startFrame: number;
  endFrame: number;
}

export type TimelineSegment = TimelineTitle | TimelineItem;

export interface EditTimeline {
  /** every segment in timeline order: opening title, items, closing title */
  segments: TimelineSegment[];
  items: TimelineItem[];
  titles: TimelineTitle[];
  totalMs: number;
  totalFrames: number;
  /** Σ dissolve overlaps (already subtracted from `totalMs`) */
  overlapMs: number;
}

const titleOf = (titles: readonly EditTitleCard[] | undefined, placement: TitlePlacement) =>
  (titles ?? []).find((t) => t.placement === placement) ?? null;

/**
 * The dissolve INTO `items[index]` as the timeline applies it: its duration when it is bound to the actual
 * predecessor, else 0 (a cut). Validation (`transitionViolations`) refuses a stale or oversized dissolve before it is
 * stored; the timeline never trusts it blindly either.
 */
export function incomingDissolveMs(
  items: readonly Partial<Pick<EditItem, "id" | "incomingTransition">>[],
  index: number,
) {
  const t = items[index]?.incomingTransition;
  if (!t || index === 0 || items[index - 1]!.id !== t.fromItemId) return 0;
  return t.durationMs;
}

export function editTimeline(
  edit: Pick<EpisodeEdit, "items" | "titles"> & { editRate: EditRate },
): EditTimeline {
  const rate = edit.editRate;
  const segments: TimelineSegment[] = [];
  const titles: TimelineTitle[] = [];
  let cursor = 0;
  const opening = titleOf(edit.titles, "opening");
  if (opening) {
    const t: TimelineTitle = {
      kind: "title",
      title: opening,
      placement: "opening",
      startMs: 0,
      endMs: opening.durationMs,
      durationMs: opening.durationMs,
    };
    segments.push(t);
    titles.push(t);
    cursor = t.endMs;
  }
  const items: TimelineItem[] = [];
  let overlapMs = 0;
  edit.items.forEach((item, index) => {
    const durationMs = itemDurationMs(item.visual);
    const transitionInMs = incomingDissolveMs(edit.items, index);
    const startMs = cursor - transitionInMs;
    overlapMs += transitionInMs;
    const t: TimelineItem = {
      kind: "item",
      item,
      index,
      startMs,
      endMs: startMs + durationMs,
      durationMs,
      transitionInMs,
      transitionOutMs: incomingDissolveMs(edit.items, index + 1),
      startFrame: frameAtMs(startMs, rate),
      endFrame: frameAtMs(startMs + durationMs, rate),
    };
    items.push(t);
    segments.push(t);
    cursor = t.endMs;
  });
  const closing = titleOf(edit.titles, "closing");
  if (closing) {
    const t: TimelineTitle = {
      kind: "title",
      title: closing,
      placement: "closing",
      startMs: cursor,
      endMs: cursor + closing.durationMs,
      durationMs: closing.durationMs,
    };
    segments.push(t);
    titles.push(t);
    cursor = t.endMs;
  }
  return { segments, items, titles, totalMs: cursor, totalFrames: frameAtMs(cursor, rate), overlapMs };
}

export type TransitionViolation =
  | { code: "transition_on_first"; itemId: string }
  | { code: "transition_stale"; itemId: string }
  | { code: "transition_too_short"; itemId: string; minMs: number }
  | { code: "transition_too_long"; itemId: string; maxMs: number };

/**
 * Every dissolve must name the item right before it and fit its neighbours: `DISSOLVE_MIN_MS` ≤ duration ≤
 * `maxDissolveMs(outgoing, incoming)` (half of the shorter neighbour, capped). Checked on the WHOLE next edit, so a
 * trim or hold that would leave a dissolve too long for its shortened neighbour is refused too.
 */
export function transitionViolations(items: readonly EditItem[]): TransitionViolation[] {
  const out: TransitionViolation[] = [];
  items.forEach((item, index) => {
    const t = item.incomingTransition;
    if (!t) return;
    if (index === 0) {
      out.push({ code: "transition_on_first", itemId: item.id });
      return;
    }
    const prev = items[index - 1]!;
    if (prev.id !== t.fromItemId) {
      out.push({ code: "transition_stale", itemId: item.id });
      return;
    }
    const max = maxDissolveMs(itemDurationMs(prev.visual), itemDurationMs(item.visual));
    if (!Number.isSafeInteger(t.durationMs) || t.durationMs < DISSOLVE_MIN_MS)
      out.push({ code: "transition_too_short", itemId: item.id, minMs: DISSOLVE_MIN_MS });
    else if (t.durationMs > max) out.push({ code: "transition_too_long", itemId: item.id, maxMs: max });
  });
  return out;
}

/** The segment visible at `ms` for a still image of the timeline: the item that STARTED last wins an overlap. */
export function segmentAt(timeline: Pick<EditTimeline, "segments" | "totalMs">, ms: number) {
  if (ms < 0 || ms >= timeline.totalMs) return null;
  let found: TimelineSegment | null = null;
  for (const s of timeline.segments) if (ms >= s.startMs && ms < s.endMs) found = s;
  return found;
}
