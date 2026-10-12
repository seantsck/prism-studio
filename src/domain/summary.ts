import { buildShotContext, shotOrder, type ShotContext } from "./context";
import { runPreflight, type PreflightReport } from "./preflight";
import type { Episode, ProjectData } from "./schemas";

export interface ShotSummary {
  ctx: ShotContext;
  report: PreflightReport;
}

/** Ordered shot contexts + preflight reports for an episode. Pure; used by lists, storyboard and overview. */
export function summarizeEpisode(data: ProjectData, episode: Episode): ShotSummary[] {
  return data.shots
    .filter((s) => s.episodeId === episode.id)
    .sort(shotOrder(data))
    .map((shot) => {
      const ctx = buildShotContext(data, shot.id);
      return { ctx, report: runPreflight(ctx) };
    });
}

export function dialogueSummary(ctx: ShotContext, max = 40): string {
  if (ctx.lines.length === 0) return "";
  const first = ctx.lines[0];
  const speaker = first.character?.name ?? first.line.speakerLabel;
  const text = first.line.originalText;
  const clipped = text.length > max ? `${text.slice(0, max)}…` : text;
  return `${speaker}: ${clipped}${ctx.lines.length > 1 ? ` (+${ctx.lines.length - 1})` : ""}`;
}
