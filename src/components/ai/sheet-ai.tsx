import { priceText } from "@/domain/pricing/user-price";
import { ActionForm } from "@/components/action-form";
import { Button, Field, Panel } from "@/components/ui";
import type { WritingProposal } from "@/data/writing-repository";
import { REFINE_NOTE_MAX } from "@/domain/series-start";
import type { ActionResult } from "@/server/action-result";
import { RefreshWhileActive } from "@/components/images/refresh-while-active";
import type { QuoteResult } from "@/server/series-start";

const priceOf = (q: { paid: boolean; usd: number; label: string }) =>
  `${q.paid ? priceText(q.usd) : "free"} with ${q.label}`;

export interface SheetField {
  key: string;
  label: string;
  /** one per line */
  list: boolean;
  /** rows for Prism's editable version */
  rows?: number;
}

/**
 * "Fill in with Prism" for one sheet (a Character's, a Location's): Prism proposes every field from what is already
 * written (and, in a story, the Bible and the cast); its version is shown beside the sheet in editable fields, each
 * with a tick (on where they differ), and only the ticked fields are applied, as edited. The draft can be refined with
 * a note or discarded. The page updates on its own while Prism works. Every request names its price before it runs.
 */
export function SheetAi({
  testId,
  name,
  hidden,
  fields,
  current,
  proposed,
  latest,
  fillQuote,
  refineQuote,
  prominent,
  intro,
  notePlaceholder,
  fill,
  review,
  className,
  anchorId,
  prompt,
}: {
  /** "character-ai" / "location-ai": the prefix of every test id */
  testId: string;
  name: string;
  hidden: React.ReactNode;
  fields: readonly SheetField[];
  current: Record<string, string>;
  /** Prism's version, as text per field (null: no ready draft) */
  proposed: Record<string, string> | null;
  latest: WritingProposal | null;
  fillQuote: QuoteResult;
  refineQuote: QuoteResult;
  prominent: boolean;
  intro: string;
  notePlaceholder: string;
  fill: (form: FormData) => Promise<ActionResult>;
  review: (form: FormData) => Promise<ActionResult>;
  className?: string;
  /** the element id to scroll to (unique on the page) */
  anchorId?: string;
  /** what the creator wrote, shown whole at the top */
  prompt?: string;
}) {
  const pending = !!latest && (latest.status === "queued" || latest.status === "running");
  const offered = proposed ? fields.filter((f) => proposed[f.key] !== undefined) : [];
  const reviewing = offered.length > 0;
  return (
    <Panel
      title="Fill in the sheet with Prism"
      className={[prominent ? "border-accent/50" : "", className ?? ""].join(" ").trim()}
    >
      <div className="scroll-mt-4 space-y-3" data-testid={testId} id={anchorId}>
        <RefreshWhileActive active={pending} intervalMs={3000} />
        {prompt?.trim() ? (
          <div className="rounded-[3px] border border-line bg-bg/40 p-2.5" data-testid={`${testId}-prompt`}>
            <div className="text-[11px] text-faint">What you wrote</div>
            <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed">{prompt}</p>
          </div>
        ) : null}
        {pending ? (
          <p className="flex items-center gap-2 text-[13px]" data-testid={`${testId}-running`}>
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
            Prism is writing {name}&apos;s sheet. It appears here on its own.
          </p>
        ) : null}
        {latest?.status === "failed" ? (
          <p className="text-[13px] text-fail">
            The last request failed{latest.error ? `: ${latest.error.message}` : ""}.
          </p>
        ) : null}
        {proposed && !reviewing ? (
          <p className="text-[13px] text-warn" data-testid={`${testId}-empty`}>
            Prism&apos;s answer did not name the sheet&apos;s fields. Ask again.
          </p>
        ) : null}

        {reviewing ? (
          <ActionForm
            key={latest!.id}
            action={review}
            successMessage=""
            className="space-y-3"
            data-testid={`${testId}-review`}
          >
            {hidden}
            <input type="hidden" name="proposalId" value={latest!.id} />
            <p className="text-[13px] text-muted">
              Prism&apos;s suggestion, beside yours. What you left empty is ticked; what you wrote stays as
              you wrote it unless you tick Prism&apos;s version. Edit anything, then apply.
            </p>
            <ul className="space-y-3">
              {offered.map((f) => {
                const next = proposed![f.key]!;
                const mine = (current[f.key] ?? "").trim();
                const differs = next.trim() !== mine;
                return (
                  <li
                    key={f.key}
                    className="rounded-[3px] border border-line p-2"
                    data-testid={`${testId}-field`}
                    data-field={f.key}
                  >
                    <label className="flex items-center gap-2 text-[13px] font-medium">
                      <input
                        type="checkbox"
                        name={`use_${f.key}`}
                        value="1"
                        defaultChecked={differs && !mine}
                      />
                      {f.label}
                      {!differs ? (
                        <span className="text-[11px] font-normal text-faint">same as yours</span>
                      ) : mine ? (
                        <span className="text-[11px] font-normal text-faint">
                          you wrote this one: tick to use Prism&apos;s
                        </span>
                      ) : null}
                    </label>
                    <div className="mt-1 grid gap-2 text-[12.5px] md:grid-cols-2">
                      <div>
                        <div className="text-[11px] text-faint">Yours</div>
                        <p className="whitespace-pre-wrap text-muted">{current[f.key] || "(empty)"}</p>
                      </div>
                      <div>
                        <div className="text-[11px] text-faint">Prism{f.list ? " (one per line)" : ""}</div>
                        <textarea
                          name={`text_${f.key}`}
                          defaultValue={next}
                          rows={f.rows ?? (f.list ? 4 : 2)}
                          maxLength={1500}
                          aria-label={`Prism's ${f.label.toLowerCase()}`}
                          data-testid={`${testId}-text`}
                        />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                name="intent"
                value="apply"
                variant="primary"
                data-testid={`${testId}-apply`}
              >
                Apply the ticked fields
              </Button>
              <Button
                type="submit"
                name="intent"
                value="discard"
                variant="ghost"
                data-testid={`${testId}-discard`}
              >
                Discard the draft
              </Button>
            </div>
            {refineQuote.ok ? (
              <div className="space-y-2 border-t border-line pt-3">
                <input type="hidden" name="model" value={refineQuote.model} />
                {refineQuote.paid ? (
                  <input type="hidden" name="confirmedTotalUsd" value={refineQuote.usd.toFixed(4)} />
                ) : null}
                <Field
                  label="Refine this draft with Prism"
                  hint="Say what to change. Prism revises the draft as it reads now, your edits included."
                >
                  <textarea
                    name="note"
                    rows={2}
                    maxLength={REFINE_NOTE_MAX}
                    placeholder={notePlaceholder}
                    data-testid={`${testId}-draft-note`}
                  />
                </Field>
                <Button type="submit" name="intent" value="refine" data-testid={`${testId}-draft-refine`}>
                  Refine the draft · {priceOf(refineQuote)}
                </Button>
              </div>
            ) : null}
          </ActionForm>
        ) : null}

        {reviewing || pending ? null : fillQuote.ok ? (
          <ActionForm action={fill} successMessage="" quiet className="space-y-2">
            {hidden}
            <input type="hidden" name="model" value={fillQuote.model} />
            {fillQuote.paid ? (
              <input type="hidden" name="confirmedTotalUsd" value={fillQuote.usd.toFixed(4)} />
            ) : null}
            <p className="text-[13px] text-muted">
              {prominent ? `Most of ${name}'s sheet is empty. ` : ""}
              {intro} You review it before anything changes.
            </p>
            <Field label="Anything to add (optional)">
              <textarea
                name="note"
                rows={2}
                maxLength={REFINE_NOTE_MAX}
                placeholder={notePlaceholder}
                data-testid={`${testId}-note`}
              />
            </Field>
            <Button
              type="submit"
              variant={prominent ? "primary" : "secondary"}
              data-testid={`${testId}-fill`}
            >
              Fill in with Prism · {priceOf(fillQuote)}
            </Button>
          </ActionForm>
        ) : (
          <p className="text-[13px] text-warn" data-testid={`${testId}-unavailable`}>
            {fillQuote.reason}
          </p>
        )}
      </div>
    </Panel>
  );
}
