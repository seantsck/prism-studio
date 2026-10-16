import { buildShotContext } from "../context";
import type { ProjectData } from "../schemas";
import {
  buildPerformanceAudioPlan,
  layoutTimelineCues,
  type PerformanceAudioPlan,
  type TimelineCue,
} from "./audio-mix";

/** The Shot's selected performance on its timeline (untrimmed), from the canonical Shot context. */
export function shotTimelineCues(
  data: ProjectData,
  shotId: string,
): { cues: TimelineCue[]; shotDurationMs: number } {
  const ctx = buildShotContext(data, shotId);
  const cues = layoutTimelineCues(
    ctx.shot.audio.preRollMs,
    ctx.shot.audio.interLineGapMs,
    ctx.lines.map((l) =>
      l.selectedTake
        ? {
            assetId: l.selectedTake.audioAssetId ?? null,
            assetChecksum: l.selectedAudioAsset?.checksum ?? null,
            durationMs: l.selectedTake.durationMs,
          }
        : null,
    ),
  );
  return { cues, shotDurationMs: ctx.duration.durationMs };
}

/** The mix plan for rendering this Shot's previs at `renderDurationMs`, or null when it has no selected audio. */
export function performanceAudioPlanForShot(
  data: ProjectData,
  shotId: string,
  renderDurationMs: number,
): PerformanceAudioPlan | null {
  const { cues, shotDurationMs } = shotTimelineCues(data, shotId);
  return buildPerformanceAudioPlan({ renderDurationMs, shotDurationMs, cues });
}
