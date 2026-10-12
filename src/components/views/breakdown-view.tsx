import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Empty, PageHeader } from "@/components/ui";
import { buildEpisodeCoverage, type CoverageItem, type SceneCoverage } from "@/domain/coverage";
import type { Episode, ProjectData } from "@/domain/schemas";
import { cn } from "@/lib/utils";
import { createShotFromSources } from "@/server/actions";

function Bar({ percent }: { percent: number }) {
  return (
    <div className="h-1.5 w-28 overflow-hidden rounded-full bg-line" aria-hidden>
      <div
        className={cn("h-full", percent === 100 ? "bg-pass" : percent >= 50 ? "bg-warn" : "bg-fail")}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function Item({
  item,
  shotHref,
}: {
  item: CoverageItem;
  shotHref: (shotId: string) => string;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-2 border-t border-line px-3 py-1.5 first:border-t-0",
        !item.covered && "bg-warn/5",
      )}
    >
      <input
        type="checkbox"
        name={item.kind === "action" ? "actionId" : "lineId"}
        value={item.id}
        aria-label={`Select ${item.kind}: ${item.text.slice(0, 40)}`}
        className="mt-0.5 !w-auto"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge tone={item.kind === "action" ? "neutral" : "info"}>{item.kind}</Badge>
          {item.startLine != null ? (
            <span className="font-mono text-[10.5px] text-faint">L{item.startLine}</span>
          ) : null}
          {item.speaker ? <span className="text-[11px] text-muted">{item.speaker}</span> : null}
        </div>
        <p className={cn("mt-0.5 text-[12.5px]", item.kind === "dialogue" && "font-medium")}>
          {item.kind === "dialogue" ? `「${item.text}」` : item.text}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-1">
        {item.covered ? (
          item.shotIds.map((id, i) => (
            <Link key={id} href={shotHref(id)}>
              <Badge tone="pass">{item.shotCodes[i]}</Badge>
            </Link>
          ))
        ) : (
          <Badge tone="warn">uncovered</Badge>
        )}
      </div>
    </li>
  );
}

function SceneBlock({
  scene,
  episode,
  slug,
}: {
  scene: SceneCoverage;
  episode: Episode;
  slug: string;
}) {
  const shotHref = (shotId: string) => `/projects/${slug}/episodes/${episode.slug}/shots/${shotId}`;
  return (
    <section className="border border-line bg-panel" id={`scene-${scene.sceneNumber}`}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">
            <span className="mr-2 font-mono text-muted">{scene.sceneNumber}</span>
            {scene.slugline}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
            {scene.location ? <span>Location: {scene.location}</span> : null}
            {scene.timeOfDay ? <span>{scene.timeOfDay}</span> : null}
            {scene.characters.length ? <span>Cast: {scene.characters.join(", ")}</span> : null}
            {scene.props.length ? <span>Props: {scene.props.join(", ")}</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[12px]">
            {scene.percent}% <span className="text-faint">({scene.covered}/{scene.total})</span>
          </span>
          <Bar percent={scene.percent} />
        </div>
      </header>

      {scene.total === 0 ? (
        <div className="p-4 text-muted">This scene has no action or dialogue yet.</div>
      ) : (
        <ActionForm action={createShotFromSources} quiet={false} resetOnSuccess>
          <input type="hidden" name="projectSlug" value={slug} />
          <input type="hidden" name="sceneId" value={scene.sceneId} />
          <ul>
            {scene.items.map((item) => (
              <Item key={`${item.kind}-${item.id}`} item={item} shotHref={shotHref} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panel2 px-3 py-2">
            <span className="text-[11px] text-muted">Selected script content →</span>
            <select name="targetShotId" className="!w-auto" aria-label="Target shot">
              <option value="">New shot</option>
              {scene.shots.map((s) => (
                <option key={s.id} value={s.id}>
                  Link to {s.code} — {s.title}
                </option>
              ))}
            </select>
            <Button type="submit" variant="primary">
              Apply
            </Button>
            <span className="text-[10.5px] text-faint">
              Shots are created and linked by you; nothing is generated automatically.
            </span>
          </div>
        </ActionForm>
      )}

      {scene.uncovered.length > 0 ? (
        <div className="border-t border-line px-4 py-2 text-[11.5px]">
          <span className="font-medium text-warn">Uncovered:</span>{" "}
          <span className="text-muted">
            {scene.uncovered
              .map((u) => (u.kind === "dialogue" ? `「${u.text.slice(0, 24)}」` : u.text.slice(0, 48)))
              .join(" · ")}
          </span>
        </div>
      ) : null}
    </section>
  );
}

export function BreakdownView({ data, episode }: { data: ProjectData; episode: Episode }) {
  const coverage = buildEpisodeCoverage(data, episode.id);
  return (
    <div>
      <PageHeader
        title={`Breakdown — ${episode.title}`}
        subtitle="Script → shots, traced. Coverage is deterministic: a beat is covered when a shot links to it."
        actions={
          <div className="flex items-center gap-3">
            <span className="font-mono text-[12px]">
              {coverage.percent}%{" "}
              <span className="text-faint">
                ({coverage.covered}/{coverage.total})
              </span>
            </span>
            <Bar percent={coverage.percent} />
          </div>
        }
      />
      <div className="space-y-4 p-6">
        {coverage.scenes.length === 0 ? (
          <Empty>No scenes yet — write or paste a script first.</Empty>
        ) : (
          coverage.scenes.map((s) => (
            <SceneBlock key={s.sceneId} scene={s} episode={episode} slug={data.project.slug} />
          ))
        )}
      </div>
    </div>
  );
}
