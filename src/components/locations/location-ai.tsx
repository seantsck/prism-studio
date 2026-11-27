import { SheetAi } from "@/components/ai/sheet-ai";
import type { WritingProposal } from "@/data/writing-repository";
import { LOCATION_AI_FIELDS, locationAsText, parseLocationIdeas } from "@/domain/location-ai";
import type { Location } from "@/domain/schemas";
import { fillLocation, reviewLocationFill } from "@/server/location-ai-actions";
import type { QuoteResult } from "@/server/series-start";

/** "Fill in the sheet with Prism" on a Location (src/domain/location-ai.ts). */
export function LocationAi({
  slug,
  location,
  inStory,
  latest,
  fillQuote,
  refineQuote,
  prominent,
  filled,
}: {
  slug: string;
  location: Location;
  inStory: boolean;
  latest: WritingProposal | null;
  fillQuote: QuoteResult;
  refineQuote: QuoteResult;
  prominent: boolean;
  filled?: string[];
}) {
  const proposed =
    latest?.status === "ready" && latest.result ? parseLocationIdeas(latest.result.ideas) : null;
  if (location.locked && !proposed) return null;
  return (
    <SheetAi
      testId="location-ai"
      prompt={location.description}
      name={location.name}
      className="max-w-4xl"
      hidden={
        <>
          <input type="hidden" name="projectSlug" value={slug} />
          <input type="hidden" name="locationId" value={location.id} />
        </>
      }
      fields={LOCATION_AI_FIELDS.map((f) => ({ ...f, rows: f.list || f.key === "description" ? 4 : 2 }))}
      current={locationAsText(location)}
      proposed={proposed as Record<string, string> | null}
      latest={latest}
      fillQuote={fillQuote}
      refineQuote={refineQuote}
      prominent={prominent}
      filled={filled}
      intro={`Prism writes every field from what is already here${inStory ? ", the Bible and the actors" : ""}: a precise visual description for its pictures, the layout, the zones and entrances Shots use to place people, the light, and the props that are always there.`}
      notePlaceholder="Old-money Kyoto; the dining room overlooks a moss garden; the kitchen door is always ajar."
      fill={fillLocation}
      review={reviewLocationFill}
    />
  );
}
