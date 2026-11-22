import { priceText } from "@/domain/pricing/user-price";
import { ActionForm } from "@/components/action-form";
import { Button, Field, Panel } from "@/components/ui";
import type { WritingProposal } from "@/data/writing-repository";
import { characterAiFields, characterAsText, parseCharacterIdeas } from "@/domain/character-ai";
import type { Character } from "@/domain/schemas";
import { REFINE_NOTE_MAX } from "@/domain/series-start";
import { fillCharacter, reviewCharacterFill } from "@/server/character-ai-actions";
import { RefreshWhileActive } from "@/components/images/refresh-while-active";
import type { QuoteResult } from "@/server/series-start";

const priceOf = (q: { paid: boolean; usd: number; label: string }) =>
  `${q.paid ? priceText(q.usd) : "free"} with ${q.label}`;

/**
 * Fill in a Character's sheet with Prism: from what is already written (and, in a story, the Bible and the cast),
 * Prism proposes every field; its version is shown beside the sheet in editable fields, each with a tick (on where they
 * differ), and only the ticked fields are applied, as edited. The draft can be refined with a note or discarded. The
 * page updates on its own while Prism works. Every request names its price before it runs.
 */
export function CharacterAi({
  slug,
  character,
  inStory,
  latest,
  fillQuote,
  refineQuote,
  prominent,
}: {
  slug: string;
  character: Character;
  inStory: boolean;
  /** The newest request for this Character, while it is newer than the sheet. */
  latest: WritingProposal | null;
  fillQuote: QuoteResult;
  refineQuote: QuoteResult;
  /** The sheet is thin: say plainly that this is the next step. */
  prominent: boolean;
}) {
  const fields = characterAiFields(inStory);
  const current = characterAsText(character);
  const proposed =
    latest?.status === "ready" && latest.result ? parseCharacterIdeas(latest.result.ideas, inStory) : null;
  const shown = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join("\n") : (v ?? ""));
  const pending = !!latest && (latest.status === "queued" || latest.status === "running");
  const reviewing = !!proposed && Object.keys(proposed).length > 0;
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="characterId" value={character.id} />
    </>
  );
  return (
    <Panel
      title="Fill in the sheet with Prism"
      className={prominent ? "border-accent/50 xl:col-span-2" : "xl:col-span-2"}
    >
      <div className="space-y-3" data-testid="character-ai">
        <RefreshWhileActive active={pending} intervalMs={3000} />
        {pending ? (
          <p className="flex items-center gap-2 text-[13px]" data-testid="character-ai-running">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
            Prism is writing {character.name}&apos;s sheet. It appears here on its own.
          </p>
        ) : null}
        {latest?.status === "failed" ? (
          <p className="text-[13px] text-fail">
            The last request failed{latest.error ? `: ${latest.error.message}` : ""}.
          </p>
        ) : null}
        {proposed && !reviewing ? (
          <p className="text-[13px] text-warn" data-testid="character-ai-empty">
            Prism&apos;s answer did not name the sheet&apos;s fields. Ask again.
          </p>
        ) : null}

        {reviewing ? (
          <ActionForm
            key={latest!.id}
            action={reviewCharacterFill}
            successMessage=""
            className="space-y-3"
            data-testid="character-ai-review"
          >
            {hidden}
            <input type="hidden" name="proposalId" value={latest!.id} />
            <p className="text-[13px] text-muted">
              Prism&apos;s version, beside yours. Edit any field, tick what to use, and apply; the rest stays
              as it is.
            </p>
            <ul className="space-y-3">
              {fields
                .filter((f) => proposed![f.key] !== undefined)
                .map((f) => {
                  const next = shown(proposed![f.key]);
                  const differs = next.trim() !== current[f.key].trim();
                  return (
                    <li
                      key={f.key}
                      className="rounded-[3px] border border-line p-2"
                      data-testid="character-ai-field"
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
                          <div className="text-[11px] text-faint">Prism{f.list ? " (one per line)" : ""}</div>
                          <textarea
                            name={`text_${f.key}`}
                            defaultValue={next}
                            rows={f.list || f.key === "physicalDescription" ? 4 : 2}
                            maxLength={1500}
                            aria-label={`Prism's ${f.label.toLowerCase()}`}
                            data-testid="character-ai-text"
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
                data-testid="character-ai-apply"
              >
                Apply the ticked fields
              </Button>
              <Button
                type="submit"
                name="intent"
                value="discard"
                variant="ghost"
                data-testid="character-ai-discard"
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
                    placeholder="Make him colder, and give him a scar over his left eyebrow."
                    data-testid="character-ai-draft-note"
                  />
                </Field>
                <Button type="submit" name="intent" value="refine" data-testid="character-ai-draft-refine">
                  Refine the draft · {priceOf(refineQuote)}
                </Button>
              </div>
            ) : null}
          </ActionForm>
        ) : null}

        {reviewing || pending ? null : fillQuote.ok ? (
          <ActionForm action={fillCharacter} successMessage="" quiet className="space-y-2">
            {hidden}
            <input type="hidden" name="model" value={fillQuote.model} />
            {fillQuote.paid ? (
              <input type="hidden" name="confirmedTotalUsd" value={fillQuote.usd.toFixed(4)} />
            ) : null}
            <p className="text-[13px] text-muted">
              {prominent ? `Most of ${character.name}'s sheet is empty. ` : ""}
              Prism writes every field from what is already here
              {inStory ? ", the Bible and the rest of the cast" : ""}: personality, how they move and speak, a
              precise physical description for their pictures, a signature habit and the rules that keep them
              consistent{inStory ? ", plus their role and relationships in this story" : ""}. You review it
              before anything changes.
            </p>
            <Field label="Anything to add (optional)">
              <textarea
                name="note"
                rows={2}
                maxLength={REFINE_NOTE_MAX}
                placeholder="Raised in Kyoto, studied in London; polite in public, ruthless in private."
                data-testid="character-ai-note"
              />
            </Field>
            <Button
              type="submit"
              variant={prominent ? "primary" : "secondary"}
              data-testid="character-ai-fill"
            >
              Fill in with Prism · {priceOf(fillQuote)}
            </Button>
          </ActionForm>
        ) : (
          <p className="text-[13px] text-warn" data-testid="character-ai-unavailable">
            {fillQuote.reason}
          </p>
        )}
      </div>
    </Panel>
  );
}
