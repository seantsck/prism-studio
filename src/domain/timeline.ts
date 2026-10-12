import type { ProjectData, Shot } from "./schemas";
import { buildShotContext, shotOrder, type ShotContext } from "./context";
import { formatSeconds } from "./duration";

/**
 * Explainable shot timing. Every millisecond of a shot's duration is attributed to a labelled segment, so
 * the UI can say exactly WHY a shot is 4.5s, and the animatic / generation package share one source of truth.
 *
 *   0.00–0.80  pre-roll / expression
 *   0.80–3.60  Yumeko · selected Take 2
 *   3.60–4.50  reaction hold
 */

export type TimelineSegmentKind = "pre_roll" | "dialogue" | "pause" | "reaction" | "manual";

export interface TimelineSegment {
  kind: TimelineSegmentKind;
  startMs: number;
  endMs: number;
  label: string;
  lineId?: string;
  takeId?: string;
  takeNumber?: number;
  speaker?: string;
  text?: string;
  audioAssetId?: string | null;
}

export interface ShotTimeline {
  totalMs: number;
  /** "performance" = derived from selected takes; "manual" = target duration; "manual_fallback" = takes missing. */
  source: "performance" | "manual" | "manual_fallback" | "unset";
  segments: TimelineSegment[];
  missingTakeLineIds: string[];
}

export interface TimelineLineInput {
  lineId: string;
  speaker: string;
  text: string;
  take: { id: string; takeNumber: number; durationMs: number; audioAssetId: string | null } | null;
}

export function buildShotTimeline(
  shot: Pick<Shot, "audio" | "durationMode" | "targetDurationMs">,
  lines: readonly TimelineLineInput[],
): ShotTimeline {
  const manual = shot.targetDurationMs;
  const wantsPerformance = shot.durationMode === "derived_from_performance" && lines.length > 0;
  const missing = lines.filter((l) => !l.take).map((l) => l.lineId);
  const placed = lines.filter((l) => l.take);

  // Lay selected takes out from the shot start: pre-roll, takes separated by the inter-line gap, reaction.
  const layout: TimelineSegment[] = [];
  let at = 0;
  const push = (s: Omit<TimelineSegment, "startMs" | "endMs">, ms: number) => {
    if (ms <= 0) return;
    layout.push({ ...s, startMs: at, endMs: at + ms });
    at += ms;
  };
  if (placed.length > 0) push({ kind: "pre_roll", label: "Pre-roll / expression" }, shot.audio.preRollMs);
  placed.forEach((l, i) => {
    if (i > 0) push({ kind: "pause", label: "Pause" }, shot.audio.interLineGapMs);
    const take = l.take!;
    push(
      {
        kind: "dialogue",
        label: `${l.speaker} · selected Take ${take.takeNumber}`,
        lineId: l.lineId,
        takeId: take.id,
        takeNumber: take.takeNumber,
        speaker: l.speaker,
        text: l.text,
        audioAssetId: take.audioAssetId,
      },
      take.durationMs,
    );
  });
  const performanceEnd = at;
  push({ kind: "reaction", label: "Reaction hold" }, shot.audio.postRollMs);

  // Fully performance-derived: the laid-out performance IS the duration.
  if (wantsPerformance && missing.length === 0) {
    return { totalMs: at, source: "performance", segments: layout, missingTakeLineIds: [] };
  }

  // Manual duration (or takes still missing): the target wins; any selected takes are still placed so they
  // can be heard in the animatic, and a manual hold fills whatever time is left.
  const total = manual ?? 0;
  const source: ShotTimeline["source"] =
    manual == null ? "unset" : wantsPerformance ? "manual_fallback" : "manual";
  const segments = layout.filter((s) => s.kind !== "reaction");
  if (performanceEnd < total || segments.length === 0) {
    if (total > 0) {
      segments.push({
        kind: "manual",
        startMs: segments.length ? performanceEnd : 0,
        endMs: total,
        label:
          source === "manual_fallback"
            ? `Manual target (${missing.length} line${missing.length === 1 ? "" : "s"} missing a selected take)`
            : segments.length
              ? "Manual hold"
              : "Manual target duration",
      });
    }
  }
  return {
    totalMs: total,
    source,
    segments,
    missingTakeLineIds: wantsPerformance ? missing : [],
  };
}

export function timelineFromContext(ctx: ShotContext): ShotTimeline {
  return buildShotTimeline(
    ctx.shot,
    ctx.lines.map((l) => ({
      lineId: l.line.id,
      speaker: l.character?.name ?? l.line.speakerLabel,
      text: l.line.originalText,
      take: l.selectedTake
        ? {
            id: l.selectedTake.id,
            takeNumber: l.selectedTake.takeNumber,
            durationMs: l.selectedTake.durationMs,
            audioAssetId: l.selectedTake.audioAssetId,
          }
        : null,
    })),
  );
}

const fmt = (ms: number) => (ms / 1000).toFixed(2);

/** "0.00–0.80  Pre-roll / expression" — plain text, one segment per line. */
export function describeTimeline(t: ShotTimeline): string[] {
  return [
    ...t.segments.map((s) => `${fmt(s.startMs)}–${fmt(s.endMs)}  ${s.label}`),
    `Total ${formatSeconds(t.totalMs)}`,
  ];
}

// ───────────────────────── Scene audio assembly ─────────────────────────

export type AudioCueKind = "dialogue" | "pause" | "reaction" | "pre_roll" | "ambience" | "foley" | "music";

export interface SceneAudioCue {
  kind: AudioCueKind;
  /** Offset from the start of the scene. */
  startMs: number;
  durationMs: number;
  shotId: string;
  shotCode: string;
  label: string;
  /** Placeholder cues (ambience/foley/music) carry the written intent only; no audio asset yet. */
  placeholder: boolean;
  lineId?: string;
  takeId?: string;
  audioAssetId?: string | null;
  text?: string;
  speaker?: string;
}

export interface SceneAudioAssembly {
  sceneId: string;
  sceneNumber: string;
  slugline: string;
  totalMs: number;
  shots: Array<{
    shotId: string;
    shotCode: string;
    startMs: number;
    durationMs: number;
    timeline: ShotTimeline;
  }>;
  cues: SceneAudioCue[];
  missingTakeLineIds: string[];
}

/** Rough audio timeline for a scene: selected takes, gaps, pre-roll, reaction holds and ambience/music placeholders. */
export function buildSceneAudioAssembly(data: ProjectData, sceneId: string): SceneAudioAssembly {
  const scene = data.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found`);
  const shots = data.shots.filter((s) => s.sceneId === sceneId).sort(shotOrder(data));
  const cues: SceneAudioCue[] = [];
  const outShots: SceneAudioAssembly["shots"] = [];
  const missing: string[] = [];
  let cursor = 0;

  for (const shot of shots) {
    const ctx = buildShotContext(data, shot.id);
    const timeline = timelineFromContext(ctx);
    missing.push(...timeline.missingTakeLineIds);
    for (const s of timeline.segments) {
      if (s.kind === "manual") continue;
      cues.push({
        kind: s.kind,
        startMs: cursor + s.startMs,
        durationMs: s.endMs - s.startMs,
        shotId: shot.id,
        shotCode: shot.shotCode,
        label: s.label,
        placeholder: s.kind !== "dialogue",
        lineId: s.lineId,
        takeId: s.takeId,
        audioAssetId: s.audioAssetId,
        text: s.text,
        speaker: s.speaker,
      });
    }
    const placeholders: Array<[AudioCueKind, string]> = [
      ["ambience", shot.audio.ambience],
      ["foley", shot.audio.foley],
      ["music", shot.audio.musicCue],
    ];
    for (const [kind, text] of placeholders) {
      if (!text.trim()) continue;
      cues.push({
        kind,
        startMs: cursor,
        durationMs: timeline.totalMs,
        shotId: shot.id,
        shotCode: shot.shotCode,
        label: `${kind[0].toUpperCase()}${kind.slice(1)}: ${text}`,
        placeholder: true,
      });
    }
    outShots.push({
      shotId: shot.id,
      shotCode: shot.shotCode,
      startMs: cursor,
      durationMs: timeline.totalMs,
      timeline,
    });
    cursor += timeline.totalMs;
  }

  return {
    sceneId,
    sceneNumber: scene.sceneNumber,
    slugline: scene.slugline,
    totalMs: cursor,
    shots: outShots,
    cues: cues.sort((a, b) => a.startMs - b.startMs || a.kind.localeCompare(b.kind)),
    missingTakeLineIds: missing,
  };
}
