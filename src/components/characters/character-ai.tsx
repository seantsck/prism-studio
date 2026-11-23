import { SheetAi } from "@/components/ai/sheet-ai";
import type { WritingProposal } from "@/data/writing-repository";
import {
  PART_SIZE_HINT,
  PART_SIZE_LABEL,
  characterAiFields,
  characterAsText,
  parseCharacterIdeas,
  partSizeOf,
} from "@/domain/character-ai";
import { priceText } from "@/domain/pricing/user-price";
import { PART_SIZES, type Character, type PartSize } from "@/domain/schemas";
import { fillCharacter, reviewCharacterFill } from "@/server/character-ai-actions";
import type { QuoteResult } from "@/server/series-start";

/** "Fill in the sheet with Prism" on a Character's page (src/domain/character-ai.ts). */
export function CharacterAi({
  slug,
  character,
  inStory,
  latest,
  fillQuote,
  refineQuote,
  prominent,
  filled,
  sizeQuotes,
  editedSince,
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
  filled?: string[];
  /** the price of filling in for each size of part (the Character's own size is chosen) */
  sizeQuotes?: Record<PartSize, QuoteResult>;
  /** the creator has edited the sheet since Prism's last suggestion */
  editedSince?: boolean;
}) {
  const fields = characterAiFields(inStory);
  const proposed =
    latest?.status === "ready" && latest.result
      ? Object.fromEntries(
          Object.entries(parseCharacterIdeas(latest.result.ideas, inStory)).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join("\n") : v,
          ]),
        )
      : null;
  return (
    <SheetAi
      testId="character-ai"
      anchorId="character-ai"
      prompt={character.description}
      name={character.name}
      className="self-start"
      hidden={
        <>
          <input type="hidden" name="projectSlug" value={slug} />
          <input type="hidden" name="characterId" value={character.id} />
        </>
      }
      fields={fields.map((f) => ({ ...f, rows: f.list || f.key === "physicalDescription" ? 4 : 2 }))}
      current={characterAsText(character)}
      proposed={proposed}
      latest={latest}
      fillQuote={fillQuote}
      refineQuote={refineQuote}
      prominent={prominent}
      filled={filled}
      fillButtonText={sizeQuotes ? "Fill in with Prism" : undefined}
      refineMode={!prominent}
      editedHint={
        editedSince
          ? `You edited ${character.name} since Prism's last suggestion. Refine with Prism to bring the rest of the sheet in line with your edits.`
          : undefined
      }
      fillExtra={
        sizeQuotes ? (
          <fieldset className="pt-1" data-testid="character-ai-size">
            <legend className="mb-1.5 text-[11px] text-muted">How big is the part?</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {PART_SIZES.map((p) => {
                const q = sizeQuotes[p];
                return (
                  <label
                    key={p}
                    className="cursor-pointer rounded-lg border border-line p-2.5 transition-colors hover:border-line2 has-[:checked]:bg-accent/10 has-[:checked]:ring-1 has-[:checked]:ring-accent has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-accent"
                  >
                    <input
                      type="radio"
                      name="partSize"
                      value={p}
                      defaultChecked={partSizeOf(character) === p}
                      className="sr-only"
                      data-testid={`character-ai-size-${p}`}
                    />
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-[13px] font-medium">{PART_SIZE_LABEL[p]}</span>
                      <span
                        className="shrink-0 text-[12px] text-muted"
                        data-testid={`character-ai-size-price-${p}`}
                      >
                        {q.ok ? (q.paid ? priceText(q.usd) : "free") : "unavailable"}
                      </span>
                    </span>
                    <span className="mt-1 block text-[11px] leading-snug text-faint">
                      {PART_SIZE_HINT[p]}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : undefined
      }
      intro={
        !prominent
          ? `Prism reads the sheet as it is now, your edits included${inStory ? ", with the Bible and the rest of the cast" : ""}, keeps what you wrote, and suggests how to bring the rest in line.`
          : sizeQuotes
            ? `Prism fills in what the part needs, from what is already here${inStory ? ", the Bible and the rest of the cast" : ""}. Choose how big the part is: each size shows its price.`
            : `Prism writes every field from what is already here${inStory ? ", the Bible and the rest of the cast" : ""}: personality, how they move and speak, a precise physical description for their pictures, a signature habit and the rules that keep them consistent${inStory ? ", plus their role and relationships in this story" : ""}.`
      }
      notePlaceholder="Raised in Kyoto, studied in London; polite in public, ruthless in private."
      fill={fillCharacter}
      review={reviewCharacterFill}
    />
  );
}
