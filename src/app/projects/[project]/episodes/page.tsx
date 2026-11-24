import Link from "next/link";
import { Badge, Button, Field, PageHeader, Panel } from "@/components/ui";
import { formatDuration } from "@/domain/duration";
import { summarizeEpisode } from "@/domain/summary";
import { episodePath } from "@/lib/paths";
import { createEpisode } from "@/server/actions";
import { requireProject } from "@/server/repo";
import { ActionForm } from "@/components/action-form";
import { RefreshWhileActive } from "@/components/images/refresh-while-active";
import { AddEpisodes, type AddEpisodesQuote } from "@/components/projects/add-episodes";
import type { WritingProposal } from "@/data/writing-repository";
import { MAX_ADD_EPISODES } from "@/domain/series-start";
import { applyAddedEpisodes, setAsideAddedEpisodes } from "@/server/series-actions";
import { quoteAddEpisodes, recommendedWriter, writers } from "@/server/series-start";
import { getWritingRepo } from "@/server/story";

export default async function EpisodesPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const data = await requireProject(slug);
  const episodes = [...data.episodes].sort((a, b) => a.order - b.order);
  const next = data.episodes.reduce((m, e) => Math.max(m, e.number), 0) + 1;
  const last = [...data.episodes].sort((a, b) => b.number - a.number)[0];

  // adding episodes with Prism: each writer switched on, priced for 1 … MAX_ADD_EPISODES episodes
  const offered = writers().filter((w) => w.available);
  const quotes: Record<string, AddEpisodesQuote> = {};
  for (const w of offered) {
    const usd: number[] = [];
    let failed: string | null = null;
    for (let n = 1; n <= MAX_ADD_EPISODES && !failed; n++) {
      const q = quoteAddEpisodes(data, n, w.value);
      if (q.ok) usd.push(q.usd);
      else if (n === 1) failed = q.reason;
    }
    quotes[w.value] = failed
      ? { ok: false, reason: failed }
      : { ok: true, paid: w.paid, label: w.label, usd };
  }
  // what Prism was asked for new episodes (kept with the first episode), newest first; set-aside ones are gone
  const writing = await getWritingRepo();
  const first = [...data.episodes].sort((a, b) => a.number - b.number)[0];
  const asked: WritingProposal[] = [];
  if (first)
    for (const s of await writing.listSessions(data.project.id, first.id))
      asked.push(...(await writing.listProposals(data.project.id, s.id)));
  const plans = asked
    .filter((p) => p.context.addEpisodes && p.status !== "rejected")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const planning = plans.some((p) => p.status === "queued" || p.status === "running");
  const have = new Set(data.episodes.map((e) => e.synopsis.trim()));
  // the newest plan with ideas still to add (or still being written, or failed)
  const shown = plans.find(
    (p) =>
      p.status !== "ready" || (p.result?.ideas ?? []).some((i) => !have.has(i.detail.slice(0, 2000).trim())),
  );

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
                    {e.targetMinutes ? (
                      <Badge>{e.targetMinutes} min</Badge>
                    ) : null}
                    {e.scriptText.trim() ? null : <Badge tone="warn">no script yet</Badge>}
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
        <div className="space-y-4">
          <Panel title="Add episodes with Prism">
            <RefreshWhileActive active={planning} intervalMs={1500} />
            <AddEpisodes
              slug={slug}
              next={next}
              defaultMinutes={last?.targetMinutes ?? null}
              max={MAX_ADD_EPISODES}
              writers={offered.map((w) => ({ value: w.value, label: w.label, paid: w.paid }))}
              recommended={recommendedWriter()?.value ?? ""}
              quotes={quotes}
              busy={planning}
            />
            {shown ? <PlannedEpisodes slug={slug} plan={shown} have={have} /> : null}
          </Panel>
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
    </div>
  );
}

/** Prism's ideas for new episodes: being planned, failed, or ready to tick and add (or set aside). */
function PlannedEpisodes({ slug, plan, have }: { slug: string; plan: WritingProposal; have: Set<string> }) {
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="proposalId" value={plan.id} />
    </>
  );
  const range = plan.context.addEpisodes!;
  if (plan.status === "queued" || plan.status === "running")
    return (
      <p className="mt-3 text-[12.5px] text-muted" data-testid="added-episodes-planning">
        Prism is planning {range.count} episode{range.count === 1 ? "" : "s"}…
      </p>
    );
  if (plan.status !== "ready" || !plan.result)
    return (
      <div className="mt-3 space-y-1.5 text-[12.5px]" data-testid="added-episodes-failed">
        <p className="text-fail">{plan.error?.message ?? "Prism could not plan the episodes."}</p>
        <ActionForm action={setAsideAddedEpisodes} quiet>
          {hidden}
          <Button type="submit" size="sm">
            Dismiss
          </Button>
        </ActionForm>
      </div>
    );
  return (
    <div className="mt-3 space-y-2" data-testid="added-episodes">
      <ActionForm action={applyAddedEpisodes} className="space-y-2">
        {hidden}
        <div className="text-[12.5px] font-medium">Prism&apos;s new episodes: tick the ones to add</div>
        <ol className="space-y-1.5">
          {plan.result.ideas.map((idea, i) => {
            const added = have.has(idea.detail.slice(0, 2000).trim());
            return (
              <li key={i} className="rounded-[3px] border border-line px-2 py-1.5 text-[12.5px]">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    name={`use_${i}`}
                    value="1"
                    defaultChecked={!added}
                    disabled={added}
                    className="mt-0.5"
                    data-testid="added-episode-pick"
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{idea.title}</span>
                    {added ? <span className="text-faint"> · added</span> : null}
                    <span className="block text-muted">{idea.detail}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" size="sm" data-testid="added-episodes-add">
            Add the ticked episodes
          </Button>
        </div>
        <p className="text-[11.5px] text-muted">
          Each is added with its title, what happens and its length; write their scripts from Start from a
          prompt.
        </p>
      </ActionForm>
      <ActionForm action={setAsideAddedEpisodes} quiet>
        {hidden}
        <Button type="submit" size="sm" variant="ghost" data-testid="added-episodes-set-aside">
          Set these aside
        </Button>
      </ActionForm>
    </div>
  );
}
