import { buildShotContext, shotOrder } from "./context";
import type { ProjectData, Shot } from "./schemas";

export interface AnimaticAudioCue {
  lineId: string;
  speaker: string;
  text: string;
  takeId: string;
  audioAssetId: string | null;
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
  cues: AnimaticAudioCue[];
  ambience: string;
  musicCue: string;
  status: Shot["status"];
}

export interface AnimaticTimeline {
  episodeId: string;
  clips: AnimaticClip[];
  totalMs: number;
}

/** Sequential, ordered timeline built from approved frames, shot durations and selected performances. */
export function buildAnimaticTimeline(data: ProjectData, episodeId: string): AnimaticTimeline {
  const shots = data.shots.filter((s) => s.episodeId === episodeId).sort(shotOrder(data));
  let cursor = 0;
  const clips = shots.map<AnimaticClip>((shot) => {
    const ctx = buildShotContext(data, shot.id);
    const durationMs = Math.max(ctx.duration.durationMs, 0);
    const frame = ctx.approvedFrame ?? ctx.frames[0] ?? null;

    const cues: AnimaticAudioCue[] = [];
    let at = cursor + shot.audio.preRollMs;
    for (const l of ctx.lines) {
      if (!l.selectedTake) continue;
      cues.push({
        lineId: l.line.id,
        speaker: l.character?.name ?? l.line.speakerLabel,
        text: l.line.originalText,
        takeId: l.selectedTake.id,
        audioAssetId: l.selectedTake.audioAssetId,
        startMs: at,
        durationMs: l.selectedTake.durationMs,
      });
      at += l.selectedTake.durationMs + shot.audio.interLineGapMs;
    }

    const clip: AnimaticClip = {
      shotId: shot.id,
      shotCode: shot.shotCode,
      title: shot.title,
      sceneId: shot.sceneId,
      sceneNumber: ctx.scene.sceneNumber,
      startMs: cursor,
      durationMs,
      durationSource: ctx.duration.source,
      frame: frame
        ? { frameId: frame.id, assetId: frame.assetId, approved: frame.approved, version: frame.version }
        : null,
      cues,
      ambience: shot.audio.ambience,
      musicCue: shot.audio.musicCue,
      status: shot.status,
    };
    cursor += durationMs;
    return clip;
  });
  return { episodeId, clips, totalMs: cursor };
}

export function clipAt(timeline: AnimaticTimeline, ms: number): AnimaticClip | null {
  return timeline.clips.find((c) => ms >= c.startMs && ms < c.startMs + c.durationMs) ?? null;
}
