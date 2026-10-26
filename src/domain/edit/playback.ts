import { frameAtMs, frameTimecode, type EditRate } from "./edit-rate";
import { itemDurationMs, placementDurationMs, type EpisodeEdit, type VisualKind } from "./model";

/**
 * Phase 2I.1E rough-sequence playback: the PURE timeline of a persisted edit. Everything here is derived from the
 * edit's own pinned decisions (order, picture, trims, holds, placements, clip-audio policy) and nothing else: no Best,
 * approval, delivery master, Production Frame or take selection is consulted. Integer milliseconds; frames only as a
 * derived display of absolute positions. Playback never writes anything.
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
  placements: PlaybackPlacement[];
}

/**
 * The playable timeline of a persisted edit: items back to back from 0 (`start = Σ previous durations`, exact integer
 * ms, so no rounding accumulates), each placement at `item start + placement start` for `take out − take in`.
 */
export function buildPlaybackPlan(
  edit: EpisodeEdit,
  media: PlaybackMedia,
  unavailableItemIds: ReadonlySet<string> = new Set(),
): PlaybackPlan {
  let cursor = 0;
  const items: PlaybackItem[] = [];
  const placements: PlaybackPlacement[] = [];
  edit.items.forEach((item, index) => {
    const durationMs = itemDurationMs(item.visual);
    const startMs = cursor;
    const v = item.visual;
    items.push({
      itemId: item.id,
      shotId: item.shotId,
      index,
      kind: v.kind,
      startMs,
      endMs: startMs + durationMs,
      durationMs,
      pictureUrl: v.kind === "none" ? null : media.pictureUrl(item),
      sourceInMs: v.kind === "video" ? v.sourceInMs : null,
      sourceOutMs: v.kind === "video" ? v.sourceOutMs : null,
      clipAudio: v.kind === "video" && item.sourceAudio === "included",
      unavailable: unavailableItemIds.has(item.id),
    });
    for (const p of item.performance)
      placements.push({
        key: `${item.id}:${p.dialogueLineId}`,
        itemId: item.id,
        dialogueLineId: p.dialogueLineId,
        takeId: p.takeId,
        startMs: startMs + p.startMs,
        endMs: startMs + p.startMs + placementDurationMs(p),
        takeInMs: p.takeInMs,
        takeOutMs: p.takeOutMs,
        audioUrl: media.takeUrl(p.takeId),
      });
    cursor += durationMs;
  });
  return {
    editId: edit.id,
    revision: edit.revision,
    editRate: edit.editRate,
    totalMs: cursor,
    items,
    placements,
  };
}

/** Clamps a requested position into the edit (0 … total). */
export const clampTimeline = (plan: Pick<PlaybackPlan, "totalMs">, ms: number): number =>
  Math.max(0, Math.min(plan.totalMs, Math.round(ms)));

/**
 * The item playing at `ms`: `start ≤ ms < end` (a boundary belongs to the NEXT item). At or after the end of the edit,
 * nothing plays (null).
 */
export function itemAt(plan: Pick<PlaybackPlan, "items" | "totalMs">, ms: number): PlaybackItem | null {
  if (ms < 0 || ms >= plan.totalMs) return null;
  let lo = 0;
  let hi = plan.items.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const it = plan.items[mid]!;
    if (ms < it.startMs) hi = mid - 1;
    else if (ms >= it.endMs) lo = mid + 1;
    else return it;
  }
  return null;
}

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
