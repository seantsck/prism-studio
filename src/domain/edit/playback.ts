import { frameAtMs, frameTimecode, type EditRate } from "./edit-rate";
import {
  placementDurationMs,
  type EpisodeEdit,
  type TitlePlacement,
  type TitleStyle,
  type VisualKind,
} from "./model";
import { editTimeline } from "./timeline";

/**
 * Phase 2I.1E rough-sequence playback: the PURE timeline of a persisted edit. Everything here is derived from the
 * edit's own pinned decisions (order, picture, trims, holds, placements, clip-audio policy; 5B-V3 dissolves and title
 * cards) and nothing else: no Best, approval, delivery master, Production Frame or take selection is consulted.
 * Positions come from THE canonical timeline (timeline.ts), the same one the render manifest uses. Integer
 * milliseconds; frames only as a derived display of absolute positions. Playback never writes anything.
 */

/** Media addresses resolved by the caller (the private `/api/assets/<id>` route); null = no playable media. */
export interface PlaybackMedia {
  pictureUrl(item: EpisodeEdit["items"][number]): string | null;
  takeUrl(takeId: string): string | null;
}

export interface PlaybackItem {
  itemId: string;
  shotId: string;
  index: number;
  kind: VisualKind;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** the picture to show: a clip, a still, or null (no picture, or the pinned media is unavailable) */
  pictureUrl: string | null;
  /** video only: the exact source interval the item plays */
  sourceInMs: number | null;
  sourceOutMs: number | null;
  /** video only: the clip's own audio is audible ("included") */
  clipAudio: boolean;
  /** the pinned picture is known to be unusable (from the read view); the interval still plays */
  unavailable: boolean;
  /** 5B-V3: the dissolve into / out of this item (0 = cut) */
  transitionInMs: number;
  transitionOutMs: number;
}

/** 5B-V3: a title card on the timeline (full frame, joined by cuts). */
export interface PlaybackTitle {
  titleId: string;
  placement: TitlePlacement;
  title: string;
  subtitle: string;
  style: TitleStyle;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface PlaybackPlacement {
  /** stable within an edit: item id + line id (one placement per line per item) */
  key: string;
  itemId: string;
  dialogueLineId: string;
  takeId: string;
  /** absolute timeline interval */
  startMs: number;
  endMs: number;
  takeInMs: number;
  takeOutMs: number;
  audioUrl: string | null;
}

export interface PlaybackPlan {
  editId: string;
  revision: number;
  editRate: EditRate;
  totalMs: number;
  items: PlaybackItem[];
  titles: PlaybackTitle[];
  placements: PlaybackPlacement[];
}

/**
 * The playable timeline of a persisted edit, from the canonical timeline: each item at its timeline start (after the
 * opening title, overlapping its predecessor by its incoming dissolve), each placement at `item start + placement
 * start` for `take out − take in`.
 */
export function buildPlaybackPlan(
  edit: EpisodeEdit,
  media: PlaybackMedia,
  unavailableItemIds: ReadonlySet<string> = new Set(),
): PlaybackPlan {
  const timeline = editTimeline(edit);
  const items: PlaybackItem[] = [];
  const placements: PlaybackPlacement[] = [];
  for (const t of timeline.items) {
    const item = t.item;
    const v = item.visual;
    items.push({
      itemId: item.id,
      shotId: item.shotId,
      index: t.index,
      kind: v.kind,
      startMs: t.startMs,
      endMs: t.endMs,
      durationMs: t.durationMs,
      pictureUrl: v.kind === "none" ? null : media.pictureUrl(item),
      sourceInMs: v.kind === "video" ? v.sourceInMs : null,
      sourceOutMs: v.kind === "video" ? v.sourceOutMs : null,
      clipAudio: v.kind === "video" && item.sourceAudio === "included",
      unavailable: unavailableItemIds.has(item.id),
      transitionInMs: t.transitionInMs,
      transitionOutMs: t.transitionOutMs,
    });
    for (const p of item.performance)
      placements.push({
        key: `${item.id}:${p.dialogueLineId}`,
        itemId: item.id,
        dialogueLineId: p.dialogueLineId,
        takeId: p.takeId,
        startMs: t.startMs + p.startMs,
        endMs: t.startMs + p.startMs + placementDurationMs(p),
        takeInMs: p.takeInMs,
        takeOutMs: p.takeOutMs,
        audioUrl: media.takeUrl(p.takeId),
      });
  }
  return {
    editId: edit.id,
    revision: edit.revision,
    editRate: edit.editRate,
    totalMs: timeline.totalMs,
    items,
    titles: timeline.titles.map((t) => ({
      titleId: t.title.id,
      placement: t.placement,
      title: t.title.title,
      subtitle: t.title.subtitle,
      style: t.title.style,
      startMs: t.startMs,
      endMs: t.endMs,
      durationMs: t.durationMs,
    })),
    placements,
  };
}

/** Clamps a requested position into the edit (0 … total). */
export const clampTimeline = (plan: Pick<PlaybackPlan, "totalMs">, ms: number): number =>
  Math.max(0, Math.min(plan.totalMs, Math.round(ms)));

/**
 * The item playing at `ms`: `start ≤ ms < end` (a boundary belongs to the NEXT item). Inside a dissolve two items
 * overlap; the INCOMING one (the later start) is the item playing, the outgoing one is `outgoingAt`. During a title
 * card, or at / after the end of the edit, no item plays (null).
 */
export function itemAt(plan: Pick<PlaybackPlan, "items" | "totalMs">, ms: number): PlaybackItem | null {
  if (ms < 0 || ms >= plan.totalMs) return null;
  // items are in start order; binary-search the last item starting at or before ms, then step back over overlaps
  let lo = 0;
  let hi = plan.items.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (plan.items[mid]!.startMs <= ms) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  for (let i = last; i >= 0 && i >= last - 1; i--) {
    const it = plan.items[i]!;
    if (ms >= it.startMs && ms < it.endMs) return it;
  }
  return null;
}

/** Inside a dissolve: the OUTGOING item still visible under the incoming one at `ms`; else null. */
export function outgoingAt(plan: Pick<PlaybackPlan, "items" | "totalMs">, ms: number): PlaybackItem | null {
  const item = itemAt(plan, ms);
  if (!item || item.transitionInMs === 0 || item.index === 0) return null;
  const prev = plan.items[item.index - 1];
  return prev && ms < prev.endMs ? prev : null;
}

/**
 * How much of the incoming picture shows at `ms` (0 … 1, linear across the dissolve); 1 outside a dissolve. The
 * preview and the render manifest describe the same linear cross dissolve.
 */
export function dissolveMix(item: PlaybackItem, ms: number): number {
  if (item.transitionInMs <= 0) return 1;
  return Math.max(0, Math.min(1, (ms - item.startMs) / item.transitionInMs));
}

/** The title card on screen at `ms`, if any. */
export const titleAt = (plan: Pick<PlaybackPlan, "titles">, ms: number): PlaybackTitle | null =>
  plan.titles.find((t) => ms >= t.startMs && ms < t.endMs) ?? null;

/** Where in its source file a video item is at timeline `ms`: `source in + (ms − item start)`, never outside the trim. */
export function videoSourceMs(item: PlaybackItem, ms: number): number | null {
  if (item.kind !== "video" || item.sourceInMs == null || item.sourceOutMs == null) return null;
  return Math.max(item.sourceInMs, Math.min(item.sourceOutMs, item.sourceInMs + (ms - item.startMs)));
}

/** The placements sounding at timeline `ms` (`start ≤ ms < end`); several may sound at once, each independently. */
export const placementsAt = (plan: Pick<PlaybackPlan, "placements">, ms: number): PlaybackPlacement[] =>
  plan.placements.filter((p) => ms >= p.startMs && ms < p.endMs);

/** Where in its take a placement is at timeline `ms`: `take in + (ms − placement start)`, never outside its trim. */
export const placementSourceMs = (p: PlaybackPlacement, ms: number): number =>
  Math.max(p.takeInMs, Math.min(p.takeOutMs, p.takeInMs + (ms - p.startMs)));

/** Display of an absolute position at the edit rate (derived, never stored): frame number and NDF timecode. */
export function playheadLabel(plan: Pick<PlaybackPlan, "editRate">, ms: number) {
  const frame = frameAtMs(Math.max(0, Math.round(ms)), plan.editRate);
  return { frame, timecode: frameTimecode(frame, plan.editRate) };
}
