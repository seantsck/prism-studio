import type { PerformanceTake, Shot } from "./schemas";

export interface DurationBreakdown {
  preRollMs: number;
  performanceMs: number;
  gapsMs: number;
  postRollMs: number;
}

export interface ShotDuration {
  /** Effective duration used by animatic and generation package. */
  durationMs: number;
  source: "manual" | "performance" | "manual_fallback" | "unset";
  breakdown: DurationBreakdown | null;
  /** Dialogue lines that block performance-derived timing because they have no selected take. */
  missingTakeLineIds: string[];
}

/** The single canonical take for a line, if any. */
export function selectedTake(takes: readonly PerformanceTake[], lineId: string): PerformanceTake | null {
  return takes.find((t) => t.dialogueLineId === lineId && t.selected && !t.archived) ?? null;
}

export interface PerformanceSegment {
  /** offset from the start of the Shot timeline */
  startMs: number;
  durationMs: number;
}

export interface PerformanceLayout {
  /** one entry per input; null for an input that has no take (it occupies no time) */
  segments: Array<PerformanceSegment | null>;
  /** end of the last take (pre-roll when there is none); the post-roll follows this */
  speechEndMs: number;
}

/**
 * THE Shot timeline arithmetic for a performance: pre-roll, then each take in order, with the inter-line gap
 * between takes. computeShotDuration, the interactive audio scheduler and the offline previs audio mix all place
 * takes through this one function, so they cannot disagree about where a take begins or ends.
 */
export function layoutPerformance(
  preRollMs: number,
  interLineGapMs: number,
  durationsMs: ReadonlyArray<number | null>,
): PerformanceLayout {
  const segments: Array<PerformanceSegment | null> = [];
  let cursor = preRollMs;
  let speechEndMs = preRollMs;
  for (const durationMs of durationsMs) {
    if (durationMs === null) {
      segments.push(null);
      continue;
    }
    segments.push({ startMs: cursor, durationMs });
    speechEndMs = cursor + durationMs;
    cursor = speechEndMs + interLineGapMs;
  }
  return { segments, speechEndMs };
}

/**
 * Shot timing originates from the selected performance whenever possible:
 *   preRoll + Σ selected take durations + inter-line gaps + postRoll.
 * Falls back to the manual target when the mode is manual, the shot has no dialogue,
 * or any dialogue line still lacks a selected take.
 */
export function computeShotDuration(
  shot: Pick<Shot, "durationMode" | "targetDurationMs" | "audio">,
  takes: readonly PerformanceTake[],
): ShotDuration {
  const manual = shot.targetDurationMs;
  const lineIds = shot.audio.dialogueLineIds;

  if (shot.durationMode === "manual" || lineIds.length === 0) {
    return {
      durationMs: manual ?? 0,
      source: manual == null ? "unset" : "manual",
      breakdown: null,
      missingTakeLineIds: [],
    };
  }

  const picked = lineIds.map((lineId) => ({ lineId, take: selectedTake(takes, lineId) }));
  const missing = picked.filter((p) => !p.take).map((p) => p.lineId);
  if (missing.length > 0) {
    return {
      durationMs: manual ?? 0,
      source: manual == null ? "unset" : "manual_fallback",
      breakdown: null,
      missingTakeLineIds: missing,
    };
  }

  const performanceMs = picked.reduce((sum, p) => sum + (p.take?.durationMs ?? 0), 0);
  const gapsMs = Math.max(0, lineIds.length - 1) * shot.audio.interLineGapMs;
  const breakdown: DurationBreakdown = {
    preRollMs: shot.audio.preRollMs,
    performanceMs,
    gapsMs,
    postRollMs: shot.audio.postRollMs,
  };
  const layout = layoutPerformance(
    shot.audio.preRollMs,
    shot.audio.interLineGapMs,
    picked.map((p) => p.take?.durationMs ?? 0),
  );
  return {
    durationMs: layout.speechEndMs + breakdown.postRollMs,
    source: "performance",
    breakdown,
    missingTakeLineIds: [],
  };
}

export function formatDuration(ms: number): string {
  const totalSeconds = ms / 1000;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
