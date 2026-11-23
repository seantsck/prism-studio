import Link from "next/link";
import { Panel } from "@/components/ui";
import { REFERENCE_PHOTOS_BEST } from "@/domain/generation/reference-plan";
import type { ViewsQuote } from "@/server/reference-views";

import { ViewChecklist, type ViewEngine, type ViewState } from "./view-checklist";

export type { ViewEngine, ViewState };

/**
 * A Character's reference pictures, made from its page: 3. the photos that make the likeness best, and 4. the six
 * views, made with the engine the creator picks, each at its exact price. A finished view is shown here and added to
 * the reference set in one click; what is in the set is what the Visual Bible below reads (the front view becomes the
 * canonical identity).
 */
export function ReferenceViewsPanel({
  slug,
  characterId,
  name,
  quote,
  states,
  failures,
  pictures,
  engines,
  suggestedEngine,
  photos,
  studioHref,
  batchId,
  atOnce,
  activeInProject,
}: {
  slug: string;
  characterId: string;
  name: string;
  quote: ViewsQuote;
  states: Record<string, ViewState>;
  /** views whose newest try failed: why */
  failures: Record<string, string>;
  /** each view's picture: the one in the set, or the newest finished take (`attemptId`) waiting to be added */
  pictures: Record<string, { url: string | null; attemptId: string | null }>;
  /** the engines that can make views; `quote` is priced with the chosen one (`quote.model`) */
  engines: ViewEngine[];
  suggestedEngine: string;
  photos: number;
  studioHref: string;
  /** one id per page view: pressing the same button twice never makes the same views twice */
  batchId: string;
  /** how many generations this project runs at once */
  atOnce: number;
  /** generations running in this project now */
  activeInProject: number;
}) {
  const [low, high] = REFERENCE_PHOTOS_BEST;
  return (
    <div id="reference-views" className="scroll-mt-4 xl:col-span-2">
      <Panel
        title="Reference pictures"
        actions={
          <Link href={studioHref} className="text-[12px] text-accent hover:underline">
            Open the Reference Studio
          </Link>
        }
      >
        <div
          className="grid gap-4 text-[12.5px] md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]"
          data-testid="reference-plan"
        >
          <div className="space-y-1">
            <div className="font-medium">3. Photos (optional, best for a real face)</div>
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
            slug={slug}
            characterId={characterId}
            views={quote.views.map((v) => ({
              id: v.id,
              label: v.label,
              state: states[v.id] ?? "missing",
              costUsd: v.costUsd,
              problem: v.problem,
              failed: failures[v.id] ?? null,
              pictureUrl: pictures[v.id]?.url ?? null,
              attemptId: pictures[v.id]?.attemptId ?? null,
            }))}
            paid={quote.paid}
            engine={quote.model}
            engines={engines}
            suggestedEngine={suggestedEngine}
            modelLabel={quote.modelLabel}
            batchId={batchId}
            atOnce={atOnce}
            activeInProject={activeInProject}
            studioHref={studioHref}
          />
        </div>
      </Panel>
    </div>
  );
}
