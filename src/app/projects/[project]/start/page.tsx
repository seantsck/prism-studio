import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { Button, Field, PageHeader } from "@/components/ui";
import { mainEpisodeId } from "@/domain/production-checklist";
import { episodeOneInstruction, PREMISE_MAX } from "@/domain/series-start";
import { cn } from "@/lib/utils";
import { startFromPremise } from "@/server/actions";
import { requireProject } from "@/server/repo";
import { quoteAnalyzeEpisode, quoteWriteEpisode, type StepQuoteResult } from "@/server/series-start";
import { getStoryRepo, getWritingRepo } from "@/server/story";
import { analyzeStory } from "@/server/story-actions";
import { askPrism } from "@/server/writing-actions";

export const dynamic = "force-dynamic";

type StepState = "done" | "now" | "later";

/**
 * Start a series from a prompt. The premise is turned into Episode 1 by the writing assistant (reviewed and accepted on
 * the Write page), then Import Story reads that script and proposes the Bible, the cast with their written looks, the
 * places and the Shots (reviewed and applied on the proposal page). Every AI step names its price on its button before
 * anything runs; nothing is applied without the creator. Any step can also be done by hand from the sidebar.
 */
export default async function StartPage({ params }: { params: Promise<{ project: string }> }) {
  const { project: slug } = await params;
  const data = await requireProject(slug);
  const base = `/projects/${slug}`;
  const premise = data.bible?.premise?.trim() ?? "";
  const episodes = [...data.episodes].sort((a, b) => a.order - b.order);
  const episode = episodes.find((e) => e.id === mainEpisodeId(data)) ?? episodes[0] ?? null;
  const scripted = !!episode?.scriptText.trim();

  const sessions = episode ? await (await getWritingRepo()).listSessions(data.project.id, episode.id) : [];
  const draft = [...sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const proposals = episode
    ? (await (await getStoryRepo()).list(data.project.id))
        .filter((p) => p.sourceEpisodeId === episode.id && !p.parentId)
        .sort((a, b) => b.version - a.version)
    : [];
  const proposal = proposals[0] ?? null;
  const applied = proposals.some((p) => p.status === "applied");

  const writeQuote = premise && episode && !scripted ? quoteWriteEpisode(data, episode, premise) : null;
  const analyzeQuote = scripted && episode && !applied ? quoteAnalyzeEpisode(episode) : null;

  const states: StepState[] = [
    premise ? "done" : "now",
    scripted ? "done" : premise ? "now" : "later",
    applied ? "done" : scripted ? "now" : "later",
  ];

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Start your series"
        subtitle="Describe it, let Prism draft Episode 1, then turn that script into your Bible, cast, places and Shots. You review every step. You can also skip this and work in any order from the sidebar."
      />

      <ol className="space-y-3">
        <Step n={1} state={states[0]} title="Describe your series" testId="start-premise">
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

        <Step n={2} state={states[1]} title="Write Episode 1 from your premise" testId="start-write">
          {scripted && episode ? (
            <Done>
              Episode 1 has a script.{" "}
              <Link href={`${base}/episodes/${episode.slug}/script`} className="text-accent hover:underline">
                Open the script
              </Link>
            </Done>
          ) : !premise ? (
            <Later>Comes after the premise.</Later>
          ) : !episode ? (
            <p className="text-[13px]">
              This project has no Episode yet.{" "}
              <Link href={`${base}/episodes`} className="text-accent hover:underline">
                Add Episode 1
              </Link>
              , then come back here.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-[13px] text-muted">
                Prism writes a short first draft as a screenplay. It opens on the Write page, where you read
                it, ask for changes, and choose Accept to put it in the script.
              </p>
              {draft && (
                <p className="text-[13px]">
                  <Link
                    href={`${base}/episodes/${episode.slug}/write?session=${draft.id}`}
                    className="text-accent hover:underline"
                    data-testid="start-open-draft"
                  >
                    Open the draft you already asked for
                  </Link>
                </p>
              )}
              <Priced quote={writeQuote}>
                {(q) => (
                  <ActionForm action={askPrism} successMessage="" quiet>
                    <input type="hidden" name="projectSlug" value={slug} />
                    <input type="hidden" name="episodeId" value={episode.id} />
                    <input type="hidden" name="preset" value="continue" />
                    <input type="hidden" name="scopeKind" value="episode" />
                    <input type="hidden" name="instruction" value={episodeOneInstruction(data, premise)} />
                    <input type="hidden" name="model" value={q.model} />
                    {q.paid && <input type="hidden" name="confirmedTotalUsd" value={q.usd.toFixed(4)} />}
                    <Button
                      type="submit"
                      variant={draft ? "secondary" : "primary"}
                      data-testid="start-write-go"
                    >
                      {draft ? "Write another draft" : "Write Episode 1"} · {priceLabel(q)}
                    </Button>
                  </ActionForm>
                )}
              </Priced>
              <p className="text-[12px] text-muted">
                Or{" "}
                <Link
                  href={`${base}/episodes/${episode.slug}/script`}
                  className="text-accent hover:underline"
                >
                  write or paste it yourself
                </Link>
                .
              </p>
            </div>
          )}
        </Step>

        <Step
          n={3}
          state={states[2]}
          title="Turn it into a Bible, cast, places and Shots"
          testId="start-analyze"
        >
          {applied ? (
            <Done>
              Applied. Your characters, places and Shots are in the project.{" "}
              <Link href={`${base}/characters`} className="text-accent hover:underline">
                See the cast
              </Link>
            </Done>
          ) : !scripted || !episode ? (
            <Later>Comes after Episode 1 has a script.</Later>
          ) : proposal && (proposal.status === "queued" || proposal.status === "running") ? (
            <p className="text-[13px]" data-testid="start-analyze-running">
              Prism is reading Episode 1.{" "}
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
                how they look, the places and a first list of Shots. Nothing changes until you review the
                proposal and choose Apply.
              </p>
              {proposal?.status === "failed" && (
                <p className="text-[13px] text-fail">
                  The last attempt failed{proposal.error ? `: ${proposal.error.message}` : ""}.
                </p>
              )}
              <Priced quote={analyzeQuote}>
                {(q) => (
                  <ActionForm action={analyzeStory} successMessage="" quiet>
                    <input type="hidden" name="projectSlug" value={slug} />
                    <input type="hidden" name="sourceMode" value="episode" />
                    <input type="hidden" name="episodeId" value={episode.id} />
                    <input type="hidden" name="model" value={q.model} />
                    {q.paid && <input type="hidden" name="confirmedTotalUsd" value={q.usd.toFixed(4)} />}
                    <Button type="submit" variant="primary" data-testid="start-analyze-go">
                      {proposal?.status === "failed" ? "Try again" : "Analyze Episode 1"} · {priceLabel(q)}
                    </Button>
                  </ActionForm>
                )}
              </Priced>
            </div>
          )}
        </Step>

        <Step n={4} state={applied ? "now" : "later"} title="Carry on in any order" testId="start-next">
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

function priceLabel(q: { paid: boolean; usd: number; label: string }) {
  return q.paid
    ? `up to $${q.usd < 0.01 ? q.usd.toFixed(4) : q.usd.toFixed(2)} with ${q.label}`
    : `free with ${q.label}`;
}

function Priced({
  quote,
  children,
}: {
  quote: StepQuoteResult | null;
  children: (q: Extract<StepQuoteResult, { ok: true }>) => ReactNode;
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

const Done = ({ children }: { children: ReactNode }) => <p className="text-[13px] text-muted">{children}</p>;
const Later = ({ children }: { children: ReactNode }) => <p className="text-[13px] text-muted">{children}</p>;
