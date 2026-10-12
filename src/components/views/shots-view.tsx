import Link from "next/link";
import { ReadinessBadge, ScoreBar } from "@/components/shared";
import { Badge, Button, PageHeader, STATUS_TONE } from "@/components/ui";
import { formatSeconds } from "@/domain/duration";
import type { Episode, ProjectData } from "@/domain/schemas";
import { dialogueSummary, summarizeEpisode } from "@/domain/summary";
import { shotPath } from "@/lib/paths";
import { createShot } from "@/server/actions";

export function ShotsView({ data, episode }: { data: ProjectData; episode: Episode }) {
  const summaries = summarizeEpisode(data, episode);
  const scenes = data.scenes.filter((s) => s.episodeId === episode.id).sort((a, b) => a.order - b.order);
  const slug = data.project.slug;

  return (
    <div>
      <PageHeader
        title={`Shots — ${episode.title}`}
        subtitle={`${summaries.length} shots · ${summaries.filter((s) => s.report.ready).length} ready to generate`}
      />
      <div className="space-y-6 p-6">
        {scenes.map((scene) => {
          const items = summaries.filter((s) => s.ctx.shot.sceneId === scene.id);
          return (
            <section key={scene.id}>
              <div className="mb-1.5 flex items-center justify-between">
                <h2 className="text-[12px] font-semibold">
                  <span className="mr-2 font-mono text-muted">{scene.sceneNumber}</span>
                  {scene.slugline}
                </h2>
                <form action={createShot} className="flex items-center gap-1">
                  <input type="hidden" name="projectSlug" value={slug} />
                  <input type="hidden" name="sceneId" value={scene.id} />
                  <input name="title" placeholder="New shot title" className="!w-44 !py-0.5" />
                  <Button size="sm" type="submit">
                    + Shot
                  </Button>
                </form>
              </div>
              <div className="border border-line">
                <table className="w-full text-left text-[12px]">
                  <thead className="bg-panel text-[10.5px] uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">Shot</th>
                      <th className="font-medium">Title</th>
                      <th className="font-medium">Location</th>
                      <th className="font-medium">Cast</th>
                      <th className="font-medium">Dialogue</th>
                      <th className="font-medium">Duration</th>
                      <th className="font-medium">Status</th>
                      <th className="font-medium">Prep</th>
                      <th className="font-medium">Preflight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(({ ctx, report }) => (
                      <tr key={ctx.shot.id} className="border-t border-line hover:bg-panel2">
                        <td className="px-3 py-1.5 font-mono">
                          <Link
                            className="text-accent hover:underline"
                            href={shotPath(slug, episode.slug, ctx.shot.id)}
                          >
                            {ctx.shot.shotCode}
                          </Link>
                        </td>
                        <td>
                          <Link href={shotPath(slug, episode.slug, ctx.shot.id)} className="hover:underline">
                            {ctx.shot.title}
                          </Link>
                        </td>
                        <td className="text-muted">{ctx.location?.name ?? "—"}</td>
                        <td className="text-muted">
                          {ctx.characters.map((c) => c.character?.name).join(", ") || "—"}
                        </td>
                        <td className="max-w-56 truncate text-muted">{dialogueSummary(ctx) || "—"}</td>
                        <td className="font-mono">
                          {formatSeconds(ctx.duration.durationMs)}
                          <span className="ml-1 text-[10px] text-faint">
                            {ctx.duration.source === "performance"
                              ? "perf"
                              : ctx.duration.source === "manual_fallback"
                                ? "fallback"
                                : ""}
                          </span>
                        </td>
                        <td>
                          <Badge tone={STATUS_TONE[ctx.shot.status]}>{ctx.shot.status}</Badge>
                        </td>
                        <td>
                          <ScoreBar score={report.score} />
                        </td>
                        <td>
                          <ReadinessBadge report={report} />
                        </td>
                      </tr>
                    ))}
                    {items.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-3 py-3 text-muted">
                          No shots in this scene yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
