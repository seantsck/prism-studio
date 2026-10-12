import Link from "next/link";
import { Badge, Button, Field, PageHeader, Panel } from "@/components/ui";
import { ScoreBar } from "@/components/shared";
import { formatDuration } from "@/domain/duration";
import { PRODUCTION_STATUSES, PROJECT_TYPES } from "@/domain/schemas";
import { summarizeEpisode } from "@/domain/summary";
import { episodePath } from "@/lib/paths";
import { saveProject } from "@/server/actions";
import { requireProject } from "@/server/repo";
import { ActionForm } from "@/components/action-form";

export default async function OverviewPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const data = await requireProject(slug);
  const episodes = [...data.episodes]
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ e, shots: summarizeEpisode(data, e) }));
  const allShots = episodes.flatMap((x) => x.shots);
  const ready = allShots.filter((s) => s.report.ready).length;
  const runtime = allShots.reduce((s, x) => s + x.ctx.duration.durationMs, 0);
  const lines = data.dialogueLines.length;
  const linesWithTake = data.dialogueLines.filter((l) =>
    data.takes.some((t) => t.dialogueLineId === l.id && t.selected),
  ).length;

  const stats: Array<[string, string, string?]> = [
    ["Episodes", String(data.episodes.length)],
    ["Shots", String(allShots.length), `${ready} ready to generate`],
    ["Runtime", formatDuration(runtime), "animatic estimate"],
    ["Dialogue", `${linesWithTake}/${lines}`, "lines with canonical take"],
    ["Characters", String(data.characters.length), `${data.looks.length} looks`],
    ["Locations", String(data.locations.length), `${data.locations.filter((l) => l.locked).length} locked`],
    ["Attempts", String(data.attempts.length), `${data.attempts.filter((a) => a.approved).length} approved`],
  ];

  return (
    <div>
      <PageHeader
        title={data.project.title}
        subtitle={data.project.description}
        actions={<Badge tone="info">{data.project.productionStatus.replace("_", " ")}</Badge>}
      />
      <div className="space-y-6 p-6">
        <div className="grid grid-cols-2 gap-px border border-line bg-line md:grid-cols-4 xl:grid-cols-7">
          {stats.map(([label, value, sub]) => (
            <div key={label} className="bg-panel px-3 py-2.5">
              <div className="text-[10.5px] uppercase tracking-wide text-muted">{label}</div>
              <div className="mt-0.5 font-mono text-[18px]">{value}</div>
              {sub ? <div className="text-[10.5px] text-faint">{sub}</div> : null}
            </div>
          ))}
        </div>

        <Panel title="Episodes">
          <table className="w-full text-left text-[12px]">
            <thead className="text-[10.5px] uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 font-medium">#</th>
                <th className="font-medium">Title</th>
                <th className="font-medium">Shots</th>
                <th className="font-medium">Ready</th>
                <th className="font-medium">Avg prep</th>
                <th className="font-medium">Runtime</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {episodes.map(({ e, shots }) => (
                <tr key={e.id} className="border-t border-line">
                  <td className="py-1.5 font-mono">{e.number}</td>
                  <td>{e.title}</td>
                  <td className="font-mono">{shots.length}</td>
                  <td className="font-mono">
                    {shots.filter((s) => s.report.ready).length}/{shots.length}
                  </td>
                  <td>
                    <ScoreBar
                      score={
                        shots.length
                          ? Math.round(shots.reduce((a, s) => a + s.report.score, 0) / shots.length)
                          : 0
                      }
                    />
                  </td>
                  <td className="font-mono">
                    {formatDuration(shots.reduce((a, s) => a + s.ctx.duration.durationMs, 0))}
                  </td>
                  <td className="text-right">
                    <Link className="text-accent hover:underline" href={episodePath(slug, e.slug, "/shots")}>
                      Open shots →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Project details">
          <ActionForm action={saveProject} className="grid max-w-3xl grid-cols-2 gap-3">
            <input type="hidden" name="projectSlug" value={slug} />
            <Field label="Title" className="col-span-2">
              <input name="title" defaultValue={data.project.title} />
            </Field>
            <Field label="Type">
              <select name="projectType" defaultValue={data.project.projectType}>
                {PROJECT_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field label="Production status">
              <select name="productionStatus" defaultValue={data.project.productionStatus}>
                {PRODUCTION_STATUSES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field label="Genre">
              <input name="genre" defaultValue={data.project.genre} />
            </Field>
            <Field label="Tone">
              <input name="tone" defaultValue={data.project.tone} />
            </Field>
            <Field label="Default language">
              <input name="defaultLanguage" defaultValue={data.project.defaultLanguage} />
            </Field>
            <Field label="Description" className="col-span-2">
              <textarea name="description" rows={2} defaultValue={data.project.description} />
            </Field>
            <div className="col-span-2">
              <Button type="submit" variant="primary">
                Save
              </Button>
            </div>
          </ActionForm>
        </Panel>
      </div>
    </div>
  );
}
