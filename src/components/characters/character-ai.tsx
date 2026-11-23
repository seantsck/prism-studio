import { SheetAi } from "@/components/ai/sheet-ai";
import type { WritingProposal } from "@/data/writing-repository";
import { characterAiFields, characterAsText, parseCharacterIdeas } from "@/domain/character-ai";
import type { Character } from "@/domain/schemas";
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
      name={character.name}
      className="xl:col-span-2"
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
      intro={`Prism writes every field from what is already here${inStory ? ", the Bible and the rest of the cast" : ""}: personality, how they move and speak, a precise physical description for their pictures, a signature habit and the rules that keep them consistent${inStory ? ", plus their role and relationships in this story" : ""}.`}
      notePlaceholder="Raised in Kyoto, studied in London; polite in public, ruthless in private."
      fill={fillCharacter}
      review={reviewCharacterFill}
    />
  );
}
