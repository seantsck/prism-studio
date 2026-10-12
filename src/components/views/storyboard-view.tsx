import Link from "next/link";
import { FramePlaceholder, ReadinessBadge } from "@/components/shared";
import { SortableBoard } from "@/components/sortable-board";
import { Badge, Button, PageHeader, STATUS_TONE } from "@/components/ui";
import { formatSeconds } from "@/domain/duration";
import { FRAME_SOURCES, type Episode, type ProjectData } from "@/domain/schemas";
import { dialogueSummary, summarizeEpisode, type ShotSummary } from "@/domain/summary";
import { shotPath } from "@/lib/paths";
import { assetUrl } from "@/lib/utils";
import { addStoryboardFrame, setFrameApproved } from "@/server/actions";
import { ActionForm } from "@/components/action-form";

function ShotCard({ data, episodeSlug, s }: { data: ProjectData; episodeSlug: string; s: ShotSummary }) {
  const { ctx, report } = s;
  const slug = data.project.slug;
  const hidden = <input type="hidden" name="projectSlug" value={slug} />;
  const shown = ctx.approvedFrame ?? ctx.frames[0] ?? null;
  const asset = shown?.assetId ? ctx.assets.get(shown.assetId) : undefined;
  const url = assetUrl(asset);

  return (
    <div className="border border-line bg-panel">
      <div className="relative">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={ctx.shot.title} className="aspect-[2.39/1] w-full object-cover" />
        ) : (
          <FramePlaceholder
            code={ctx.shot.shotCode}
            label={
              [ctx.shot.composition.shotSize, ctx.shot.composition.framing].filter(Boolean).join(" · ") ||
              "No composition"
            }
            hint={shown ? `v${shown.version} · ${shown.source}${asset ? " · placeholder" : ""}` : "No frame"}
          />
        )}
        {shown ? (
          <div className="absolute bottom-1.5 left-1.5">
            <Badge tone={shown.approved ? "pass" : "warn"}>
              {shown.approved ? "approved" : `v${shown.version} unapproved`}
            </Badge>
          </div>
        ) : (
          <div className="absolute bottom-1.5 left-1.5">
            <Badge tone="fail">frame missing</Badge>
          </div>
        )}
      </div>
      <div className="space-y-1 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <Link
            href={shotPath(slug, episodeSlug, ctx.shot.id, "storyboard")}
            className="min-w-0 truncate hover:underline"
          >
            <span className="mr-1.5 font-mono text-accent">{ctx.shot.shotCode}</span>
            {ctx.shot.title}
          </Link>
          <span className="shrink-0 font-mono text-[11px]">{formatSeconds(ctx.duration.durationMs)}</span>
        </div>
        <div className="truncate text-[11.5px] text-muted">{dialogueSummary(ctx, 28) || "No dialogue"}</div>
        <div className="flex items-center gap-1.5">
          <Badge tone={STATUS_TONE[ctx.shot.status]}>{ctx.shot.status}</Badge>
          <ReadinessBadge report={report} />
        </div>
        <details className="pt-1">
          <summary className="text-[11px] text-muted hover:text-fg">
            Versions ({ctx.frames.length}) / upload ▾
          </summary>
          <div className="mt-2 space-y-1.5">
            {ctx.frames.map((f) => (
              <ActionForm
                key={f.id}
                action={setFrameApproved}
                className="flex items-center justify-between gap-2 border border-line px-2 py-1"
              >
                {hidden}
                <input type="hidden" name="frameId" value={f.id} />
                <input type="hidden" name="approved" value={String(!f.approved)} />
                <span className="text-[11.5px]">
                  v{f.version} <span className="text-muted">· {f.source}</span>
                  {f.notes ? <span className="block text-[10.5px] text-faint">{f.notes}</span> : null}
                </span>
                <Button size="sm" variant={f.approved ? "primary" : "secondary"} type="submit">
                  {f.approved ? "Approved ✓" : "Approve"}
                </Button>
              </ActionForm>
            ))}
            <ActionForm action={addStoryboardFrame} className="space-y-1.5 border-t border-line pt-2">
              {hidden}
              <input type="hidden" name="shotId" value={ctx.shot.id} />
              <input type="file" name="file" accept="image/*" className="!p-0.5 text-[11px]" />
              <div className="flex gap-1.5">
                <select name="source" defaultValue="upload" className="!py-0.5">
                  {FRAME_SOURCES.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
                <input name="notes" placeholder="Notes" className="!py-0.5" />
              </div>
              <Button size="sm" type="submit">
                Add version
              </Button>
            </ActionForm>
          </div>
        </details>
      </div>
    </div>
  );
}

export function StoryboardView({ data, episode }: { data: ProjectData; episode: Episode }) {
  const summaries = summarizeEpisode(data, episode);
  const scenes = data.scenes.filter((s) => s.episodeId === episode.id).sort((a, b) => a.order - b.order);
  const approved = summaries.filter((s) => s.ctx.approvedFrame).length;

  return (
    <div>
      <PageHeader
        title={`Storyboard — ${episode.title}`}
        subtitle="Shot-centric board. Drag to reorder within a scene; locked shots keep their position."
        actions={
          <Badge tone={approved === summaries.length ? "pass" : "warn"}>
            {approved}/{summaries.length} frames approved
          </Badge>
        }
      />
      <div className="space-y-8 p-6">
        {scenes.map((scene) => {
          const items = summaries
            .filter((s) => s.ctx.shot.sceneId === scene.id)
            .sort((a, b) => a.ctx.shot.order - b.ctx.shot.order);
          if (items.length === 0) return null;
          return (
            <section key={scene.id}>
              <h2 className="mb-2 text-[12px] font-semibold">
                <span className="mr-2 font-mono text-muted">{scene.sceneNumber}</span>
                {scene.slugline}
              </h2>
              <SortableBoard
                key={items.map((i) => i.ctx.shot.id).join(",")}
                sceneId={scene.id}
                projectSlug={data.project.slug}
                items={items.map((i) => ({ id: i.ctx.shot.id, locked: i.ctx.shot.status === "locked" }))}
              >
                {items.map((s) => (
                  <ShotCard key={s.ctx.shot.id} data={data} episodeSlug={episode.slug} s={s} />
                ))}
              </SortableBoard>
            </section>
          );
        })}
      </div>
    </div>
  );
}
