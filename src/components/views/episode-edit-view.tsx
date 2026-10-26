import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Empty, PageHeader } from "@/components/ui";
import type { Episode, ProjectData } from "@/domain/schemas";
import type { EpisodeEditPage } from "@/server/episode-edit-page";
import { createEpisodeEdit } from "@/server/episode-edit-actions";
import { AddShotPanel, ItemEditor, ItemOrderControls, type EditTarget } from "./episode-edit-controls";
import { EditPlayer } from "./episode-edit-player";
import type { BadgeVM, RowVM, RunVM, SummaryVM } from "./episode-edit-model";

/**
 * Phase 2I.1C Episode Edit page (2I.1D adds the editing controls, episode-edit-controls.tsx). With no persisted edit it shows the proposed initial assembly (not an edit)
 * and one explicit "Create edit"; with an edit it shows the persisted editorial assembly, every pinned source labelled
 * truthfully and every upstream change as a badge, with explicit editing controls. Playback is 2I.1E.
 */
export function EpisodeEditView({
  data,
  episode,
  page,
}: {
  data: ProjectData;
  episode: Episode;
  page: EpisodeEditPage;
}) {
  const base = `/projects/${data.project.slug}/episodes/${episode.slug}`;
  const relation = (
    <>
      The persisted editorial assembly of this Episode. The{" "}
      <Link href={`${base}/animatic`} className="text-accent hover:underline">
        Animatic
      </Link>{" "}
      stays the unsaved planning playback; the{" "}
      <Link href={`${base}/sequence`} className="text-accent hover:underline">
        Sequence Board
      </Link>{" "}
      is the planned Shot order.
    </>
  );

  if (page.state === "error") {
    return (
      <div>
        <PageHeader title={`Episode Edit — ${episode.title}`} subtitle={relation} />
        <div className="p-6">
          <div
            role="alert"
            data-testid="episode-edit-error"
            className="border border-fail/50 bg-fail/10 p-4 text-fail"
          >
            {page.message}
          </div>
        </div>
      </div>
    );
  }

  if (page.state === "proposal") {
    return (
      <div data-testid="episode-edit-proposal">
        <PageHeader
          title={`Episode Edit — ${episode.title}`}
          subtitle={relation}
          actions={<SummaryBadges summary={page.summary} />}
        />
        <div className="space-y-4 p-6">
          <section className="border border-info/40 bg-info/5 p-4">
            <h2 className="text-[13px] font-semibold">Proposed initial assembly</h2>
            <p className="mt-1 text-muted">
              Not an edit yet: nothing is saved. This is what Prism would create from the Sequence Board
              order, each Shot&apos;s approved clip (else a labelled placeholder still) and its selected
              takes. Best is never followed. Once created, the edit keeps exactly these sources until you
              change them.
            </p>
            {page.editRateNote ? <p className="mt-1 text-warn">{page.editRateNote}</p> : null}
            {page.rows.length === 0 ? (
              <p className="mt-2 text-muted">This Episode has no Shots yet.</p>
            ) : (
              <ActionForm action={createEpisodeEdit} successMessage="" className="mt-3">
                <input type="hidden" name="projectSlug" value={data.project.slug} />
                <input type="hidden" name="episodeId" value={episode.id} />
                <input type="hidden" name="proposalKey" value={page.key} />
                <Button type="submit" variant="primary" data-testid="create-episode-edit">
                  Create edit from this proposal
                </Button>
              </ActionForm>
            )}
          </section>
          <Runs runs={page.runs} />
          <Rows rows={page.rows} />
        </div>
      </div>
    );
  }

  const target: EditTarget = { projectSlug: data.project.slug, editId: page.editId, revision: page.revision };
  return (
    <div data-testid="episode-edit-persisted">
      <PageHeader
        title={`Episode Edit — ${episode.title}`}
        subtitle={relation}
        actions={
          <>
            <Badge tone="accent">
              <span data-testid="edit-revision">Revision {page.revision}</span>
            </Badge>
            <SummaryBadges summary={page.summary} />
          </>
        }
      />
      <div className="space-y-4 p-6">
        <p className="text-muted">
          Saved edit <span className="font-mono text-faint">{page.editId.slice(0, 8)}</span>. Upstream changes
          (approval, Best, delivery masters, frames, takes, timing, order) are shown as facts and never
          applied: only an explicit change below edits it, each against the revision shown here.
        </p>
        {page.badges.length ? (
          <div className="flex flex-wrap gap-1.5" data-testid="edit-badges">
            <BadgeList badges={page.badges} />
          </div>
        ) : null}
        {page.problems.length ? (
          <div
            role="alert"
            data-testid="edit-problems"
            className="border border-fail/50 bg-fail/10 p-3 text-fail"
          >
            <p className="font-medium">Some pinned sources cannot be resolved:</p>
            <ul className="mt-1 list-disc pl-5">
              {page.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {/* keyed on the revision: a saved change rebuilds playback from the new edit (paused at 0) */}
        <EditPlayer key={page.revision} playback={page.playback} />
        <Runs runs={page.runs} />
        <Rows rows={page.rows} target={target} />
        <AddShotPanel target={target} addable={page.addable} items={page.rows.length} />
      </div>
    </div>
  );
}

function SummaryBadges({ summary }: { summary: SummaryVM }) {
  return (
    <>
      <Badge tone="info">
        <span data-testid="edit-total">Total {summary.total}</span>
      </Badge>
      <Badge>{summary.editRate}</Badge>
      <Badge>
        {summary.items} Shot{summary.items === 1 ? "" : "s"}
      </Badge>
      <Badge>
        {summary.runs} Scene run{summary.runs === 1 ? "" : "s"} · {summary.scenes} Scene
        {summary.scenes === 1 ? "" : "s"}
      </Badge>
    </>
  );
}

function BadgeList({ badges }: { badges: BadgeVM[] }) {
  return (
    <>
      {badges.map((b) => (
        <span key={b.label} title={b.title}>
          <Badge tone={b.tone}>{b.label}</Badge>
        </span>
      ))}
    </>
  );
}

function Runs({ runs }: { runs: RunVM[] }) {
  if (runs.length === 0) return null;
  return (
    <ol className="flex flex-wrap gap-1.5 text-[11px]" data-testid="edit-runs" aria-label="Scene runs">
      {runs.map((r) => (
        <li key={`${r.label}-${r.firstIndex}`} className="border border-line2 px-2 py-1">
          <span className="font-medium">{r.label}</span>{" "}
          <span className="text-muted">
            items {r.firstIndex + 1}–{r.lastIndex + 1} · from {r.start} · {r.duration}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Rows({ rows, target }: { rows: RowVM[]; target?: EditTarget }) {
  if (rows.length === 0) return <Empty>No Shots in this Episode yet.</Empty>;
  return (
    <ol className="space-y-2">
      {rows.map((r) => (
        <Row key={r.key} row={r} target={target} />
      ))}
    </ol>
  );
}

function Row({ row, target }: { row: RowVM; target?: EditTarget }) {
  const p = row.picture;
  return (
    <li
      data-testid="edit-item"
      data-shot-code={row.shotCode}
      data-item-id={target ? row.key : undefined}
      data-start-ms={row.startMs}
      data-duration-ms={row.durationMs}
      className="grid grid-cols-[176px_1fr] gap-3 border border-line bg-panel p-2.5 data-[playing=true]:border-accent data-[playing=true]:bg-accent/5"
    >
      <div>
        <div className="relative aspect-video overflow-hidden border border-line2 bg-black/40">
          {p.mediaType === "video" && p.mediaUrl ? (
            <video
              src={p.mediaUrl}
              preload="metadata"
              muted
              controls
              className="h-full w-full object-contain"
            />
          ) : p.mediaType === "image" && p.mediaUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- private asset route, not a static image
            <img
              src={p.mediaUrl}
              alt={`${row.shotCode} ${p.kindLabel}`}
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] text-faint">No picture</div>
          )}
        </div>
        <div className="mt-1 text-[11px]" data-testid="item-kind">
          {p.placeholder ? (
            <span className="text-warn">{p.kindLabel}</span>
          ) : (
            <span className="text-pass">{p.kindLabel}</span>
          )}
        </div>
      </div>
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-[11px] text-muted">#{row.index + 1}</span>
          <span className="font-mono font-medium">{row.shotCode}</span>
          <span className="truncate text-muted">{row.shotTitle}</span>
          <span className="text-[11px] text-faint">{row.run || row.scene}</span>
          {target && row.editor ? (
            <span className="ml-auto">
              <ItemOrderControls target={target} editor={row.editor} shotCode={row.shotCode} />
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-x-3 text-[11.5px] text-muted" data-testid="item-timing">
          <span>Starts {row.start}</span>
          <span>Duration {row.duration}</span>
          {row.planned ? <span>Planned {row.planned}</span> : null}
        </div>
        <div className="text-[11.5px]">
          <span>{p.source}</span>
          {p.details.length ? <span className="text-muted"> · {p.details.join(" · ")}</span> : null}
        </div>
        <div className="flex flex-wrap gap-1" data-testid="item-badges">
          <BadgeList badges={row.badges} />
        </div>
        <div className="border-t border-line pt-1.5 text-[11.5px]" data-testid="item-audio">
          <span className="mr-2 text-[10.5px] uppercase tracking-wide text-faint">Performance</span>
          {row.audio.silence ? (
            <span data-testid="item-silence" className="text-muted">
              Silence (no placed take)
            </span>
          ) : (
            <ul className="mt-0.5 space-y-0.5">
              {row.audio.placements.map((pl) => (
                <li key={pl.dialogueLineId} className="flex flex-wrap items-center gap-2">
                  <span>
                    {pl.speaker}: “{pl.text}”
                  </span>
                  <span className="text-muted">
                    {pl.take} · {pl.timing}
                  </span>
                  {pl.audioUrl ? (
                    <a href={pl.audioUrl} className="text-accent hover:underline">
                      audio
                    </a>
                  ) : null}
                  <BadgeList badges={pl.badges} />
                </li>
              ))}
            </ul>
          )}
          <span className="ml-2 text-[11px] text-faint">{row.audio.clipAudio}</span>
          {row.audio.notes.map((n) => (
            <span key={n} className="ml-2 text-[11px] text-faint">
              · {n}
            </span>
          ))}
        </div>
        {row.notes.length ? (
          <ul className="list-disc pl-5 text-[11px] text-muted" data-testid="item-notes">
            {row.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        {row.problems.length ? (
          <ul role="alert" className="list-disc pl-5 text-[11px] text-fail">
            {row.problems.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        <details className="text-[11px]" data-testid="item-lineage">
          <summary className="cursor-pointer text-muted">Lineage</summary>
          <div className="mt-1 space-y-1 pl-2">
            <Chain links={row.lineage.picture} />
            {row.lineage.audio.map((chain, i) => (
              <Chain key={i} links={chain} />
            ))}
          </div>
        </details>
        {target && row.editor ? <ItemEditor target={target} editor={row.editor} /> : null}
      </div>
    </li>
  );
}

function Chain({ links }: { links: Array<{ label: string; url: string | null }> }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {links.map((l, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 ? <span className="text-faint">→</span> : null}
          {l.url ? (
            <a href={l.url} className="text-accent hover:underline">
              {l.label}
            </a>
          ) : (
            <span>{l.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}
