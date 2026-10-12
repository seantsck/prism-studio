import { buildShotContext, shotOrder } from "./context";
import { storyboardFreshness, type StoryboardFreshnessStatus } from "./fingerprint";
import type { ProjectData, Shot, Waveform } from "./schemas";
import { timelineFromContext, type TimelineSegment } from "./timeline";

export interface AnimaticAudioCue {
  lineId: string;
  speaker: string;
  text: string;
  takeId: string;
  takeNumber: number;
  audioAssetId: string | null;
  waveform: Waveform | null;
  /** Absolute offset in the episode timeline. */
  startMs: number;
  durationMs: number;
}

export interface AnimaticClip {
  shotId: string;
  shotCode: string;
  title: string;
  sceneId: string;
  sceneNumber: string;
  startMs: number;
  durationMs: number;
  durationSource: "manual" | "performance" | "manual_fallback" | "unset";
  frame: { frameId: string; assetId: string | null; approved: boolean; version: number } | null;
  /** "stale" when the approved frame predates a change to the shot (see domain/fingerprint.ts). */
  frameFreshness: StoryboardFreshnessStatus;
  freshnessMessages: string[];
  cues: AnimaticAudioCue[];
  /** Labelled time map relative to the clip start: pre-roll, takes, pauses, reaction hold. */
  segments: TimelineSegment[];
  ambience: string;
  musicCue: string;
  status: Shot["status"];
}

export interface AnimaticScene {
  sceneId: string;
  sceneNumber: string;
  slugline: string;
  startMs: number;
  endMs: number;
}

export interface AnimaticTimeline {
  episodeId: string;
  clips: AnimaticClip[];
  scenes: AnimaticScene[];
  totalMs: number;
}

/** Sequential, ordered timeline built from approved frames, shot durations and selected performances. */
export function buildAnimaticTimeline(data: ProjectData, episodeId: string): AnimaticTimeline {
  const shots = data.shots.filter((s) => s.episodeId === episodeId).sort(shotOrder(data));
  let cursor = 0;
  const scenes: AnimaticScene[] = [];

  const clips = shots.map<AnimaticClip>((shot) => {
    const ctx = buildShotContext(data, shot.id);
    const timeline = timelineFromContext(ctx);
    const durationMs = Math.max(timeline.totalMs, 0);
    const frame = ctx.approvedFrame ?? ctx.frames[0] ?? null;
    const freshness = storyboardFreshness(ctx, ctx.approvedFrame);

    const cues: AnimaticAudioCue[] = [];
    for (const seg of timeline.segments) {
      if (seg.kind !== "dialogue" || !seg.lineId) continue;
      const line = ctx.lines.find((l) => l.line.id === seg.lineId);
      cues.push({
        lineId: seg.lineId,
        speaker: seg.speaker ?? "",
        text: seg.text ?? "",
        takeId: seg.takeId ?? "",
        takeNumber: seg.takeNumber ?? 0,
        audioAssetId: seg.audioAssetId ?? null,
        waveform: line?.selectedTake?.waveform ?? null,
        startMs: cursor + seg.startMs,
        durationMs: seg.endMs - seg.startMs,
      });
    }

    const clip: AnimaticClip = {
      shotId: shot.id,
      shotCode: shot.shotCode,
      title: shot.title,
      sceneId: shot.sceneId,
      sceneNumber: ctx.scene.sceneNumber,
      startMs: cursor,
      durationMs,
      durationSource: timeline.source,
      frame: frame
        ? { frameId: frame.id, assetId: frame.assetId, approved: frame.approved, version: frame.version }
        : null,
      frameFreshness: freshness.status,
      freshnessMessages: freshness.messages,
      cues,
      segments: timeline.segments,
      ambience: shot.audio.ambience,
      musicCue: shot.audio.musicCue,
      status: shot.status,
    };

    const last = scenes[scenes.length - 1];
    if (last && last.sceneId === shot.sceneId) last.endMs = cursor + durationMs;
    else
      scenes.push({
        sceneId: shot.sceneId,
        sceneNumber: ctx.scene.sceneNumber,
        slugline: ctx.scene.slugline,
        startMs: cursor,
        endMs: cursor + durationMs,
      });
    cursor += durationMs;
    return clip;
  });
  return { episodeId, clips, scenes, totalMs: cursor };
}

export function clipAt(timeline: AnimaticTimeline, ms: number): AnimaticClip | null {
  return timeline.clips.find((c) => ms >= c.startMs && ms < c.startMs + c.durationMs) ?? null;
}
