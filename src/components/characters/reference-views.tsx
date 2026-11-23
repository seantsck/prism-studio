import Link from "next/link";
import { Panel } from "@/components/ui";
import { REFERENCE_PHOTOS_BEST } from "@/domain/generation/reference-plan";
import type { ViewsQuote } from "@/server/reference-views";

import { ViewChecklist, type ViewState } from "./view-checklist";

export type { ViewState };

/**
 * A Character's reference views, made from its page: tick any of the missing ones (one by one, or all), each with its
 * exact price (what the Reference Studio would charge for that same request), and the total of the ticked ones on the
 * button (ViewChecklist).
 * A view already in the set, being made, or made and waiting to be added is not made again. Each result is a take in
 * the Reference Studio; the creator adds the ones that are clearly the same person to the set.
 */
export function ReferenceViewsPanel({
  slug,
  characterId,
  name,
  quote,
  states,
  photos,
  studioHref,
  batchId,
  atOnce,
}: {
  slug: string;
  characterId: string;
  name: string;
  quote: ViewsQuote;
  states: Record<string, ViewState>;
  photos: number;
  studioHref: string;
  /** one id per page view: pressing the same button twice never makes the same views twice */
  batchId: string;
  /** how many generations this project runs at once */
  atOnce: number;
}) {
  const [low, high] = REFERENCE_PHOTOS_BEST;
  return (
    <Panel
      title="References: how many, and the price"
      className="xl:col-span-2"
      actions={
        <Link href={studioHref} className="text-[12px] text-accent hover:underline">
          Open the Reference Studio
        </Link>
      }
    >
      <div
        className="grid gap-4 text-[12.5px] md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]"
        data-testid="reference-plan"
      >
        <div className="space-y-1">
          <div className="font-medium">1. Photos (optional, best for a real face)</div>
          <p className="text-muted">
            {low} to {high} photos: face large, sharp and evenly lit; front, 3/4 and side; one full body. No
            sunglasses, filters or group shots.
          </p>
          <p
            className={photos >= low && photos <= high ? "text-pass" : "text-faint"}
            data-testid="reference-plan-photos"
          >
            You have {photos} photo{photos === 1 ? "" : "s"}.
          </p>
          <p className="pt-1 text-[11.5px] text-muted" data-testid="reference-views-start">
            {quote.startsFrom === "photos"
              ? `Every view is made from your ${photos === 1 ? "photo" : `${Math.min(photos, high)} photos`}.`
              : quote.startsFrom === "front"
                ? "The other views are made from the front view, so they keep its face."
                : `With no photos, the front view is made from ${name}'s description. Make it first: the other views are then made from it and keep its face. Made all at once from the description, each view is drawn separately and faces can differ.`}
          </p>
        </div>

        <ViewChecklist
          // a view started (or added) changes what can be made: the checklist starts again, every missing view ticked
          key={quote.views.map((v) => `${v.id}:${states[v.id] ?? "missing"}`).join(",")}
          slug={slug}
          characterId={characterId}
          views={quote.views.map((v) => ({
            id: v.id,
            label: v.label,
            state: states[v.id] ?? "missing",
            costUsd: v.costUsd,
            problem: v.problem,
          }))}
          paid={quote.paid}
          modelLabel={quote.modelLabel}
          batchId={batchId}
          atOnce={atOnce}
          studioHref={studioHref}
        />
      </div>
    </Panel>
  );
}
