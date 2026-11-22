import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { WriteIt, type WriteQuotes } from "@/components/projects/write-it";
import { Button, Field, PageHeader } from "@/components/ui";
import type { WritingProposal } from "@/data/writing-repository";
import type { Episode } from "@/domain/schemas";
import { RefreshWhileActive } from "@/components/images/refresh-while-active";
import { SetAllMinutes } from "@/components/projects/set-all-minutes";
import { isSeasonPlanRequest, MAX_MINUTES, PREMISE_MAX, REFINE_NOTE_MAX } from "@/domain/series-start";
import { PLAN_BATCH } from "@/domain/story/writing";
import { cn } from "@/lib/utils";
import { startFromPremise } from "@/server/actions";
import { requireProject } from "@/server/repo";
import { editSeasonPlan, planSeason, setRuntime } from "@/server/series-actions";
import {
  quoteAnalyzeEpisode,
  quoteSeasonPlan,
  quoteWriting,
  recommendedWriter,
  writers,
  WRITING_AI_OFF,
  type QuoteResult,
} from "@/server/series-start";
import { getStoryRepo, getWritingRepo } from "@/server/story";
import { analyzeStory } from "@/server/story-actions";

export const dynamic = "force-dynamic";

type StepState = "done" | "now" | "later";
const money = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
const priceOf = (q: { paid: boolean; usd: number; label: string }) =>
  `${q.paid ? `up to ${money(q.usd)}` : "free"} with ${q.label}`;

/**
 * Start a series (or a film) from a prompt: the premise; for a series, Prism plans the season (an idea per Episode, used
 * with one click); Prism writes one Episode, every Episode, or the whole film (each arrives as a proposal to review);
 * then Import Story turns Episode 1 into the Bible, cast, places and Shots. Every AI step names its writer and its price
 * before it runs; nothing is applied without the creator.
 */
export default async function StartPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const data = await requireProject(slug);
  const base = `/projects/${slug}`;
  const kind = data.project.projectType;
  const premise = data.bible?.premise?.trim() ?? "";
  const episodes = [...data.episodes].sort((a, b) => a.number - b.number);
  const first = episodes[0] ?? null;

  // what Prism has been asked so far, per Episode (newest first)
  const writing = await getWritingRepo();
  const asked = new Map<string, WritingProposal[]>();
  for (const e of episodes) {
    const list: WritingProposal[] = [];
    for (const s of await writing.listSessions(data.project.id, e.id))
      list.push(...(await writing.listProposals(data.project.id, s.id)));
    asked.set(
      e.id,
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }
  const sessionLink = (e: Episode, p: WritingProposal) =>
    `${base}/episodes/${e.slug}/write?session=${p.sessionId}`;
  const wholeOf = (e: Episode) => asked.get(e.id)?.find((p) => p.context.longForm) ?? null;

  // the season plan: the newest plan asked for on Episode 1, and whether the Episodes already carry one
  const plan = first
    ? (asked.get(first.id)?.find((p) => p.mode === "brainstorm" && isSeasonPlanRequest(p.instruction)) ??
      null)
    : null;
  const planned = kind === "series" && episodes.length > 0 && episodes.every((e) => e.synopsis.trim());
  // episodes can be written once any of them has a plan (the rest follow the premise)
  const somePlanned = kind === "series" && episodes.some((e) => e.synopsis.trim());
  // Prism's newest plan is shown in the editor while it is newer than the Episodes (not yet saved or set aside)
  const lastEdit = episodes.reduce((m, e) => (e.updatedAt > m ? e.updatedAt : m), "");
  const pendingPlan = !!plan && (plan.status === "queued" || plan.status === "running");
  const draft = plan?.status === "ready" && plan.result && plan.createdAt > lastEdit ? plan : null;
  const scripted = episodes.filter((e) => e.scriptText.trim()).length;

  const offered = writers();
  const recommended = recommendedWriter();
  const quotes: WriteQuotes = {};
  if (premise && first)
    for (const w of offered.filter((x) => x.available)) {
      quotes[w.value] = quoteWriting(data, kind === "series" ? "all" : "one", w.value);
    }
  const planQuote = premise && first && kind === "series" ? quoteSeasonPlan(data) : null;
  const refineQuote =
    premise && first && kind === "series" ? quoteSeasonPlan(data, null, { refine: true }) : null;

  const proposals = first
    ? (await (await getStoryRepo()).list(data.project.id))
        .filter((p) => p.sourceEpisodeId === first.id && !p.parentId)
        .sort((a, b) => b.version - a.version)
    : [];
  const proposal = proposals[0] ?? null;
  const applied = proposals.some((p) => p.status === "applied");
  const firstScripted = !!first?.scriptText.trim();
  const analyzeQuote = first && firstScripted && !applied ? quoteAnalyzeEpisode(first) : null;

  const written = episodes.length > 0 && scripted === episodes.length;
  const busy = (p: { status: string } | null | undefined) =>
    p?.status === "queued" || p?.status === "running";
  // re-render on its own while Prism is working on anything shown here
  const active = pendingPlan || episodes.some((e) => busy(wholeOf(e))) || busy(proposal);
  const bibleShaped = !!(data.bible.visualStyle.trim() && data.bible.tone.trim());
  const writeState: StepState = written
    ? "done"
    : premise && (kind !== "series" || somePlanned)
      ? "now"
      : "later";
  const series = kind === "series";
  let n = 0;
  const next = () => ++n;

  return (
    <div className="max-w-3xl">
      <RefreshWhileActive active={active} intervalMs={3000} />
      <PageHeader
        title={series ? "Start your series" : "Start your film"}
        subtitle="Describe it, let Prism plan and write it, then turn the script into your Bible, cast, places and Shots. You see each price before anything runs, and review everything. You can also skip this and work in any order from the sidebar."
      />

      <ol className="space-y-3">
        <Step n={next()} state={premise ? "done" : "now"} title="Describe it" testId="start-premise">
          {premise ? (
            <div className="space-y-1">
              <p className="whitespace-pre-wrap text-[13px]" data-testid="start-premise-text">
                {premise}
              </p>
              <Link href={`${base}/bible`} className="text-[12px] text-accent hover:underline">
                Edit it on the Bible page
              </Link>
            </div>
          ) : (
            <ActionForm action={startFromPremise} successMessage="" className="space-y-2">
              <input type="hidden" name="projectSlug" value={slug} />
              <Field
                label="Premise"
                hint="A few lines: who it is about, where, what they want and what stands in the way."
              >
                <textarea
                  name="premise"
                  rows={4}
                  maxLength={PREMISE_MAX}
                  required
                  data-testid="start-premise-input"
                />
              </Field>
              <Button type="submit" variant="primary">
                Save premise
              </Button>
            </ActionForm>
          )}
        </Step>

        {series ? (
          <Step
            n={next()}
            state={planned ? "done" : premise ? "now" : "later"}
            title={`Plan the season (${episodes.length} episodes)`}
            testId="start-plan"
          >
            {!premise ? (
              <Later>Comes after the premise.</Later>
            ) : pendingPlan ? (
              <p className="flex items-center gap-2 text-[13px]" data-testid="start-plan-running">
                <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
                {planned ? "Prism is revising the plan…" : "Prism is planning the season…"}
                {episodes.length > PLAN_BATCH ? " Long seasons take a little longer." : ""} It appears here on
                its own.
              </p>
            ) : (
              <div className="space-y-4">
                {plan?.status === "failed" && plan.createdAt > lastEdit ? (
                  <p className="text-[13px] text-fail" data-testid="start-plan-failed">
                    The last request failed{plan.error ? `: ${plan.error.message}` : ""}.
                  </p>
                ) : null}
                <PlanEditor
                  key={draft?.id ?? `own-${lastEdit}`}
                  slug={slug}
                  episodes={episodes}
                  draft={draft}
                  hadPlan={planned}
                  refineQuote={refineQuote}
                />
                <Priced quote={planQuote}>
                  {(q) => (
                    <ActionForm action={planSeason} successMessage="" quiet>
                      <input type="hidden" name="projectSlug" value={slug} />
                      <input type="hidden" name="model" value={q.model} />
                      {q.paid ? (
                        <input type="hidden" name="confirmedTotalUsd" value={q.usd.toFixed(4)} />
                      ) : null}
                      <Button
                        type="submit"
                        variant={planned || draft ? "ghost" : "primary"}
                        data-testid="start-plan-go"
                      >
                        {planned || draft
                          ? "Plan again from scratch"
                          : `Plan ${episodes.length} episodes with Prism`}{" "}
                        · {priceOf(q)}
                      </Button>
                    </ActionForm>
                  )}
                </Priced>
              </div>
            )}
          </Step>
        ) : null}

        <Step
          n={next()}
          state={bibleShaped ? "done" : premise ? "now" : "later"}
          title="Shape the Bible (optional)"
          testId="start-bible"
        >
          <p className="text-[13px] text-muted">
            {bibleShaped
              ? "Your Bible has its look, rules and canon. Prism follows it when it writes the episodes."
              : "Prism can draft the look, tone, rules and canon from your premise and plan, and refine them with your notes. You review every field."}{" "}
            <Link
              href={`${base}/bible`}
              className="text-accent hover:underline"
              data-testid="start-bible-open"
            >
              {bibleShaped ? "Open the Bible" : "Shape it with Prism"}
            </Link>
          </p>
        </Step>

        <Step
          n={next()}
          state={writeState}
          title={series ? "Write the episodes" : "Write the film"}
          testId="start-write"
        >
          {!premise ? (
            <Later>Comes after the premise.</Later>
          ) : !first ? (
            <p className="text-[13px]">
              This project has no Episode yet.{" "}
              <Link href={`${base}/episodes`} className="text-accent hover:underline">
                Add Episode 1
              </Link>
              , then come back here.
            </p>
          ) : series && !somePlanned ? (
            <Later>Comes after the season plan (or write the episodes yourself on the Episodes page).</Later>
          ) : (
            <div className="space-y-4">
              {!series && first ? <Runtime slug={slug} episode={first} kind={kind} /> : null}
              <WritingStatus episodes={episodes} wholeOf={wholeOf} link={sessionLink} base={base} />
              {written ? null : recommended ? (
                <WriteIt
                  slug={slug}
                  kind={kind}
                  writers={offered}
                  recommended={recommended.value}
                  quotes={quotes}
                />
              ) : (
                <p className="text-[13px] text-warn" data-testid="start-unavailable">
                  {WRITING_AI_OFF} You can write it yourself on the Episodes page.
                </p>
              )}
            </div>
          )}
        </Step>

        <Step
          n={next()}
          state={applied ? "done" : firstScripted ? "now" : "later"}
          title="Turn it into a Bible, cast, places and Shots"
          testId="start-analyze"
        >
          {applied ? (
            <p className="text-[13px] text-muted">
              Applied. Your characters, places and Shots are in the project.{" "}
              <Link href={`${base}/characters`} className="text-accent hover:underline">
                See the cast
              </Link>
            </p>
          ) : !first || !firstScripted ? (
            <Later>Comes after {series ? "Episode 1 has" : "the film has"} a script.</Later>
          ) : proposal && (proposal.status === "queued" || proposal.status === "running") ? (
            <p className="text-[13px]" data-testid="start-analyze-running">
              Prism is reading the script; this page updates on its own.{" "}
              <Link href={`${base}/story/${proposal.id}`} className="text-accent hover:underline">
                Follow it
              </Link>
            </p>
          ) : proposal && proposal.status === "ready" ? (
            <p className="text-[13px]" data-testid="start-analyze-ready">
              The proposal is ready.{" "}
              <Link href={`${base}/story/${proposal.id}`} className="text-accent hover:underline">
                Review it and apply what you want
              </Link>
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-[13px] text-muted">
                Prism reads the script and proposes the Bible, each character with a written description of
                how they look, the places and a first list of Shots. Nothing changes until you review it and
                choose Apply.
              </p>
              {proposal?.status === "failed" ? (
                <p className="text-[13px] text-fail">
                  The last attempt failed{proposal.error ? `: ${proposal.error.message}` : ""}.
                </p>
              ) : null}
              <Priced quote={analyzeQuote}>
                {(q) => (
                  <ActionForm action={analyzeStory} successMessage="" quiet>
                    <input type="hidden" name="projectSlug" value={slug} />
                    <input type="hidden" name="sourceMode" value="episode" />
                    <input type="hidden" name="episodeId" value={first.id} />
                    <input type="hidden" name="model" value={q.model} />
                    {q.paid ? (
                      <input type="hidden" name="confirmedTotalUsd" value={q.usd.toFixed(4)} />
                    ) : null}
                    <Button type="submit" variant="primary" data-testid="start-analyze-go">
                      {proposal?.status === "failed"
                        ? "Try again"
                        : `Analyze ${series ? "Episode 1" : "the film"}`}{" "}
                      · {priceOf(q)}
                    </Button>
                  </ActionForm>
                )}
              </Priced>
            </div>
          )}
        </Step>

        <Step n={next()} state={applied ? "now" : "later"} title="Carry on in any order" testId="start-next">
          <p className="text-[13px] text-muted">
            Add photos or descriptions for each character, give places a look, then make frames. Home shows
            what each part of the project needs next.
          </p>
          <Link href={base} className="mt-1 inline-block text-[13px] text-accent hover:underline">
            Go to Home
          </Link>
        </Step>
      </ol>
    </div>
  );
}

/**
 * The plan, editable in place: each Episode's title and what happens in it. While Prism's newest plan is still to
 * review, the fields hold Prism's version: save it (edited or not), refine it with a note, or keep the plan you had.
 */
function PlanEditor({
  slug,
  episodes,
  draft,
  hadPlan,
  refineQuote,
}: {
  slug: string;
  episodes: Episode[];
  draft: WritingProposal | null;
  hadPlan: boolean;
  refineQuote: QuoteResult | null;
}) {
  const ideas = draft?.result?.ideas ?? [];
  const titleOf = (e: Episode, i: number) =>
    ideas[i]
      ? ideas[i]!.title.replace(/^\s*(episode\s*\d+\s*[:.\-–]\s*)/i, "").slice(0, 120) || e.title
      : e.title;
  const synopsisOf = (e: Episode, i: number) => (ideas[i] ? ideas[i]!.detail.slice(0, 2000) : e.synopsis);
  const q = refineQuote && refineQuote.ok ? refineQuote : null;
  return (
    <ActionForm
      action={editSeasonPlan}
      successMessage=""
      className={cn("space-y-3", draft && "rounded-[3px] border border-accent/40 p-3")}
      data-testid="start-plan-editor"
      data-source={draft ? "prism" : "episodes"}
    >
      <input type="hidden" name="projectSlug" value={slug} />
      {draft ? <input type="hidden" name="proposalId" value={draft.id} /> : null}
      {draft ? (
        <p className="text-[13px]" data-testid="start-plan-draft-note">
          <span className="font-medium">{hadPlan ? "Prism's revised plan." : "Prism's plan."}</span>{" "}
          <span className="text-muted">
            Edit anything, then save it
            {hadPlan ? ", or keep the plan you had" : ""}. Nothing changes until you choose.
          </span>
        </p>
      ) : (
        <p className="text-[13px] text-muted">
          {hadPlan
            ? "Your plan. Edit any title, length or synopsis and save, or ask Prism to refine it."
            : "Write the plan yourself, or let Prism plan it below and edit what it gives you. Set each episode's length in minutes and Prism sizes its scenes and script to it."}
        </p>
      )}
      <SetAllMinutes max={MAX_MINUTES} />
      <ol className="space-y-2">
        {episodes.map((e, i) => (
          <li key={e.id} className="grid gap-1 sm:grid-cols-[2.5rem_1fr]" data-testid="start-plan-episode">
            <span className="pt-1 text-[12px] text-muted">{e.number}.</span>
            <div className="space-y-1">
              <div className="flex gap-2">
                <input
                  name={`title_${e.id}`}
                  defaultValue={titleOf(e, i)}
                  maxLength={120}
                  aria-label={`Episode ${e.number} title`}
                  className="min-w-0 flex-1 font-medium"
                />
                <label className="flex shrink-0 items-center gap-1 text-[12px] text-muted">
                  <input
                    name={`minutes_${e.id}`}
                    type="number"
                    min={1}
                    max={MAX_MINUTES}
                    inputMode="numeric"
                    defaultValue={e.targetMinutes ?? ""}
                    placeholder="—"
                    aria-label={`Episode ${e.number} length in minutes`}
                    className="w-16"
                    data-minutes
                  />
                  min
                </label>
              </div>
              <textarea
                name={`synopsis_${e.id}`}
                defaultValue={synopsisOf(e, i)}
                rows={2}
                maxLength={2000}
                placeholder="What happens in this episode"
                aria-label={`What happens in episode ${e.number}`}
              />
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" name="intent" value="save" variant="primary" data-testid="start-plan-save">
          {draft ? "Save this plan" : "Save plan"}
        </Button>
        {draft && hadPlan ? (
          <Button type="submit" name="intent" value="keep" variant="ghost" data-testid="start-plan-keep">
            Keep my plan
          </Button>
        ) : null}
      </div>
      {q ? (
        <div className="space-y-2 border-t border-line pt-3" data-testid="start-plan-refine">
          <input type="hidden" name="model" value={q.model} />
          {q.paid ? <input type="hidden" name="confirmedTotalUsd" value={q.usd.toFixed(4)} /> : null}
          <Field
            label="Refine with Prism"
            hint="Say what to change. The plan above is saved as it is, then Prism revises the whole of it for you to review."
          >
            <textarea
              name="note"
              rows={2}
              maxLength={REFINE_NOTE_MAX}
              placeholder="Make episode 3 darker, and bring in a rival halfway through the season."
              data-testid="start-plan-note"
            />
          </Field>
          <Button type="submit" name="intent" value="refine" data-testid="start-plan-refine-go">
            Save and refine · {priceOf(q)}
          </Button>
        </div>
      ) : refineQuote && !refineQuote.ok ? (
        <p className="text-[13px] text-warn" data-testid="start-unavailable">
          {refineQuote.reason}
        </p>
      ) : null}
    </ActionForm>
  );
}

/** A film's (or short's) length, set before it is written: Prism sizes its scenes and script to it. */
function Runtime({ slug, episode, kind }: { slug: string; episode: Episode; kind: string }) {
  return (
    <ActionForm
      action={setRuntime}
      successMessage="Length saved"
      className="flex flex-wrap items-end gap-2"
      data-testid="start-runtime"
    >
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="episodeId" value={episode.id} />
      <Field
        label="Length"
        hint={`Minutes on screen; Prism sizes the ${kind === "film" ? "film" : "short"}'s scenes and script to it.`}
      >
        <input
          name="minutes"
          type="number"
          min={1}
          max={MAX_MINUTES}
          inputMode="numeric"
          defaultValue={episode.targetMinutes ?? ""}
          placeholder={kind === "film" ? "100" : "15"}
          className="w-24"
          data-testid="start-runtime-input"
        />
      </Field>
      <Button type="submit" data-testid="start-runtime-save">
        Set length
      </Button>
    </ActionForm>
  );
}

const rowState = (e: Episode, p: WritingProposal | null) =>
  e.scriptText.trim() ? "written" : p ? p.status : "none";

/** Where each Episode stands: written, waiting for review, being written, or failed. */
function WritingStatus({
  episodes,
  wholeOf,
  link,
  base,
}: {
  episodes: Episode[];
  wholeOf: (e: Episode) => WritingProposal | null;
  link: (e: Episode, p: WritingProposal) => string;
  base: string;
}) {
  const rows = episodes.map((e) => ({ e, p: wholeOf(e) })).filter((r) => r.e.scriptText.trim() || r.p);
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-1 text-[13px]" data-testid="start-writing-status">
      {rows.map(({ e, p }) => (
        <li
          key={e.id}
          className="flex flex-wrap gap-x-2"
          data-testid="start-writing-row"
          data-state={rowState(e, p)}
        >
          <span className="font-medium">
            {episodes.length > 1 ? `${e.number}. ` : ""}
            {e.title}
          </span>
          {e.scriptText.trim() ? (
            <Link href={`${base}/episodes/${e.slug}/script`} className="text-pass hover:underline">
              Written
            </Link>
          ) : p && (p.status === "queued" || p.status === "running") ? (
            <span className="text-muted">Prism is writing it…</span>
          ) : p && p.status === "ready" ? (
            <Link
              href={link(e, p)}
              className="text-accent hover:underline"
              data-testid="start-writing-review"
            >
              Ready to review
            </Link>
          ) : p && p.status === "failed" ? (
            <span className="text-fail">Failed{p.error ? `: ${p.error.message}` : ""}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Priced({
  quote,
  children,
}: {
  quote: QuoteResult | null;
  children: (q: Extract<QuoteResult, { ok: true }>) => ReactNode;
}) {
  if (!quote) return null;
  if (!quote.ok)
    return (
      <p className="text-[13px] text-warn" data-testid="start-unavailable">
        {quote.reason}
      </p>
    );
  return <>{children(quote)}</>;
}

function Step({
  n,
  state,
  title,
  testId,
  children,
}: {
  n: number;
  state: StepState;
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <li
      data-testid={testId}
      data-state={state}
      className={cn(
        "flex gap-3 border px-4 py-3",
        state === "now" ? "border-accent/60 bg-panel" : "border-line bg-panel/60",
        state === "later" && "opacity-60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[12px]",
          state === "done"
            ? "border-pass bg-pass/15 text-pass"
            : state === "now"
              ? "border-accent text-accent"
              : "border-line text-muted",
        )}
        aria-hidden
      >
        {state === "done" ? "✓" : n}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="mb-1.5 text-[14px] font-medium">{title}</h2>
        {children}
      </div>
    </li>
  );
}

const Later = ({ children }: { children: ReactNode }) => <p className="text-[13px] text-muted">{children}</p>;
