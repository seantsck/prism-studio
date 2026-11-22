import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { WriteIt, type WriteQuotes } from "@/components/projects/write-it";
import { Button, Field, PageHeader } from "@/components/ui";
import type { WritingProposal } from "@/data/writing-repository";
import type { Episode } from "@/domain/schemas";
import { PREMISE_MAX } from "@/domain/series-start";
import { cn } from "@/lib/utils";
import { startFromPremise } from "@/server/actions";
import { requireProject } from "@/server/repo";
import { applySeasonPlan, planSeason } from "@/server/series-actions";
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
    ? (asked
        .get(first.id)
        ?.find((p) => p.mode === "brainstorm" && p.instruction.startsWith("Plan season 1")) ?? null)
    : null;
  const planned = kind === "series" && episodes.length > 1 && episodes.every((e) => e.synopsis.trim());
  const scripted = episodes.filter((e) => e.scriptText.trim()).length;

  const offered = writers();
  const recommended = recommendedWriter();
  const quotes: WriteQuotes = {};
  if (premise && first)
    for (const w of offered.filter((x) => x.available)) {
      const one = quoteWriting(data, "one", w.value);
      const all = kind === "series" ? quoteWriting(data, "all", w.value) : null;
      quotes[w.value] = { one, all: all && all.ok && all.episodes.length > 1 ? all : null };
    }
  const planQuote = premise && first && kind === "series" ? quoteSeasonPlan(data) : null;

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
  const writeState: StepState = written
    ? "done"
    : premise && (kind !== "series" || planned)
      ? "now"
      : "later";
  const series = kind === "series";
  let n = 0;
  const next = () => ++n;

  return (
    <div className="max-w-3xl">
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
            {planned ? (
              <EpisodeList episodes={episodes} base={base} />
            ) : !premise ? (
              <Later>Comes after the premise.</Later>
            ) : plan && (plan.status === "queued" || plan.status === "running") ? (
              <p className="text-[13px]" data-testid="start-plan-running">
                Prism is planning the season. Refresh in a moment.
              </p>
            ) : (
              <div className="space-y-3">
                {plan?.status === "ready" && plan.result ? (
                  <div className="space-y-2" data-testid="start-plan-ready">
                    <ol className="space-y-1.5 text-[13px]">
                      {plan.result.ideas.map((idea, i) => (
                        <li key={i}>
                          <span className="font-medium">
                            {i + 1}. {idea.title}
                          </span>{" "}
                          <span className="text-muted">{idea.detail}</span>
                        </li>
                      ))}
                    </ol>
                    <ActionForm action={applySeasonPlan} successMessage="">
                      <input type="hidden" name="projectSlug" value={slug} />
                      <input type="hidden" name="proposalId" value={plan.id} />
                      <Button type="submit" variant="primary" data-testid="start-plan-use">
                        Use this plan
                      </Button>
                    </ActionForm>
                  </div>
                ) : (
                  <p className="text-[13px] text-muted">
                    Prism gives each episode a title and what happens in it, so the episodes tell one story.
                    You can edit any of it on the Episodes page.
                  </p>
                )}
                {plan?.status === "failed" ? (
                  <p className="text-[13px] text-fail">
                    The last plan failed{plan.error ? `: ${plan.error.message}` : ""}.
                  </p>
                ) : null}
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
                        variant={plan?.status === "ready" ? "secondary" : "primary"}
                        data-testid="start-plan-go"
                      >
                        {plan ? "Plan again" : `Plan ${episodes.length} episodes`} · {priceOf(q)}
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
          ) : series && !planned ? (
            <Later>Comes after the season plan (or write the episodes yourself on the Episodes page).</Later>
          ) : (
            <div className="space-y-4">
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
              Prism is reading the script.{" "}
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

function EpisodeList({ episodes, base }: { episodes: Episode[]; base: string }) {
  return (
    <div className="space-y-1" data-testid="start-plan-done">
      <ol className="space-y-1 text-[13px]">
        {episodes.map((e) => (
          <li key={e.id}>
            <span className="font-medium">
              {e.number}. {e.title}
            </span>{" "}
            <span className="text-muted">{e.synopsis}</span>
          </li>
        ))}
      </ol>
      <Link href={`${base}/episodes`} className="text-[12px] text-accent hover:underline">
        Edit them on the Episodes page
      </Link>
    </div>
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
