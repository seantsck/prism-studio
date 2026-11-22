import { ActionForm } from "@/components/action-form";
import { Button, Field, Panel } from "@/components/ui";
import type { WritingProposal } from "@/data/writing-repository";
import { BIBLE_AI_FIELDS, bibleAsText, parseBibleIdeas } from "@/domain/bible-ai";
import type { ProjectBible } from "@/domain/schemas";
import { REFINE_NOTE_MAX } from "@/domain/series-start";
import { applyBibleDraft, draftBible } from "@/server/series-actions";
import type { QuoteResult } from "@/server/series-start";

const money = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
const priceOf = (q: { paid: boolean; usd: number; label: string }) =>
  `${q.paid ? `up to ${money(q.usd)}` : "free"} with ${q.label}`;

/**
 * Shape the Bible with Prism: draft it from the premise and the plan, or refine it with a note. Prism's version is shown
 * field by field beside the Bible as it is, each with a tick (on where they differ); only the ticked fields are applied.
 * Every request names its price before it runs. The Bible below stays editable by hand.
 */
export function BibleAi({
  slug,
  bible,
  latest,
  draftQuote,
  refineQuote,
}: {
  slug: string;
  bible: ProjectBible;
  /** The newest Bible request, when it is newer than the Bible itself (still to review, or being written). */
  latest: WritingProposal | null;
  draftQuote: QuoteResult;
  refineQuote: QuoteResult;
}) {
  const current = bibleAsText(bible);
  const proposed = latest?.status === "ready" && latest.result ? parseBibleIdeas(latest.result.ideas) : null;
  const shown = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join("\n") : (v ?? ""));
  return (
    <Panel title="Shape the Bible with Prism" className="xl:col-span-2">
      <div className="space-y-4" data-testid="bible-ai">
        {latest && (latest.status === "queued" || latest.status === "running") ? (
          <p className="text-[13px]" data-testid="bible-ai-running">
            Prism is working on the Bible. Refresh in a moment.
          </p>
        ) : null}
        {latest?.status === "failed" ? (
          <p className="text-[13px] text-fail">
            The last request failed{latest.error ? `: ${latest.error.message}` : ""}.
          </p>
        ) : null}

        {proposed && Object.keys(proposed).length === 0 ? (
          <p className="text-[13px] text-warn" data-testid="bible-ai-empty">
            Prism&apos;s answer did not name the Bible&apos;s fields. Ask again.
          </p>
        ) : null}
        {proposed && Object.keys(proposed).length > 0 ? (
          <ActionForm
            action={applyBibleDraft}
            successMessage="Applied"
            className="space-y-3"
            data-testid="bible-ai-review"
          >
            <input type="hidden" name="projectSlug" value={slug} />
            <input type="hidden" name="proposalId" value={latest!.id} />
            <p className="text-[13px] text-muted">
              Prism&apos;s version beside yours. Tick what to use; the rest stays as it is.
            </p>
            <ul className="space-y-3">
              {BIBLE_AI_FIELDS.filter((f) => proposed[f.key] !== undefined).map((f) => {
                const next = shown(proposed[f.key]);
                const differs = next.trim() !== current[f.key].trim();
                return (
                  <li
                    key={f.key}
                    className="rounded-[3px] border border-line p-2"
                    data-testid="bible-ai-field"
                    data-field={f.key}
                  >
                    <label className="flex items-center gap-2 text-[13px] font-medium">
                      <input type="checkbox" name={`use_${f.key}`} value="1" defaultChecked={differs} />
                      {f.label}
                      {differs ? null : (
                        <span className="text-[11px] font-normal text-faint">same as yours</span>
                      )}
                    </label>
                    <div className="mt-1 grid gap-2 text-[12.5px] md:grid-cols-2">
                      <div>
                        <div className="text-[11px] text-faint">Yours</div>
                        <p className="whitespace-pre-wrap text-muted">{current[f.key] || "(empty)"}</p>
                      </div>
                      <div>
                        <div className="text-[11px] text-faint">Prism</div>
                        <p className="whitespace-pre-wrap">{next}</p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <Button type="submit" variant="primary" data-testid="bible-ai-apply">
              Apply the ticked fields
            </Button>
          </ActionForm>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <p className="text-[13px] text-muted">
              Prism drafts every field from the premise and the season plan. You review it before anything
              changes.
            </p>
            {draftQuote.ok ? (
              <ActionForm action={draftBible} successMessage="" quiet>
                <input type="hidden" name="projectSlug" value={slug} />
                <input type="hidden" name="model" value={draftQuote.model} />
                {draftQuote.paid ? (
                  <input type="hidden" name="confirmedTotalUsd" value={draftQuote.usd.toFixed(4)} />
                ) : null}
                <Button type="submit" data-testid="bible-ai-draft">
                  Draft the Bible · {priceOf(draftQuote)}
                </Button>
              </ActionForm>
            ) : (
              <p className="text-[13px] text-warn" data-testid="bible-ai-unavailable">
                {draftQuote.reason}
              </p>
            )}
          </div>
          {refineQuote.ok ? (
            <ActionForm
              action={draftBible}
              successMessage=""
              quiet
              className="space-y-2"
              data-testid="bible-ai-refine"
            >
              <input type="hidden" name="projectSlug" value={slug} />
              <input type="hidden" name="refine" value="1" />
              <input type="hidden" name="model" value={refineQuote.model} />
              {refineQuote.paid ? (
                <input type="hidden" name="confirmedTotalUsd" value={refineQuote.usd.toFixed(4)} />
              ) : null}
              <Field
                label="Refine with Prism"
                hint="Say what to change; Prism revises the whole Bible for you to review."
              >
                <textarea
                  name="note"
                  rows={2}
                  maxLength={REFINE_NOTE_MAX}
                  required
                  placeholder="Make the visual style warmer, and keep the dialogue mostly Japanese."
                  data-testid="bible-ai-note"
                />
              </Field>
              <Button type="submit" data-testid="bible-ai-refine-go">
                Refine the Bible · {priceOf(refineQuote)}
              </Button>
            </ActionForm>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
