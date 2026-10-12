import Link from "next/link";
import { Badge, Button, Field, PageHeader, Panel } from "@/components/ui";
import { formatDuration } from "@/domain/duration";
import { summarizeEpisode } from "@/domain/summary";
import { episodePath } from "@/lib/paths";
import { createEpisode } from "@/server/actions";
import { requireProject } from "@/server/repo";
import { ActionForm } from "@/components/action-form";

export default async function EpisodesPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const data = await requireProject(slug);
  const episodes = [...data.episodes].sort((a, b) => a.order - b.order);

  return (
    <div>
      <PageHeader title="Episodes" />
      <div className="grid gap-6 p-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-2">
          {episodes.map((e) => {
            const shots = summarizeEpisode(data, e);
            return (
              <Link
                key={e.id}
                href={episodePath(slug, e.slug, "/shots")}
                className="block border border-line bg-panel px-4 py-3 hover:border-line2 hover:bg-panel2"
              >
                <div className="flex items-center justify-between">
                  <div className="text-[14px] font-medium">
                    <span className="mr-2 font-mono text-muted">{e.number}</span>
                    {e.title}
                  </div>
                  <div className="flex gap-1.5">
                    <Badge>{shots.length} shots</Badge>
                    <Badge tone="pass">{shots.filter((s) => s.report.ready).length} ready</Badge>
                    <Badge tone="info">
                      {formatDuration(shots.reduce((a, s) => a + s.ctx.duration.durationMs, 0))}
                    </Badge>
                  </div>
                </div>
                <p className="mt-1 text-muted">{e.synopsis}</p>
              </Link>
            );
          })}
        </div>
        <Panel title="New episode">
          <ActionForm action={createEpisode} className="space-y-3">
            <input type="hidden" name="projectSlug" value={slug} />
            <Field label="Title">
              <input name="title" required />
            </Field>
            <Field label="Synopsis">
              <textarea name="synopsis" rows={3} />
            </Field>
            <Button type="submit" variant="primary">
              Create episode
            </Button>
          </ActionForm>
        </Panel>
      </div>
    </div>
  );
}
