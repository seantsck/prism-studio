import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Button, Panel } from "@/components/ui";
import { REFERENCE_PHOTOS_BEST } from "@/domain/generation/reference-plan";
import { priceText, userPrice } from "@/domain/pricing/user-price";
import { makeReferenceViews } from "@/server/reference-view-actions";
import type { ViewsQuote } from "@/server/reference-views";

export type ViewState = "in_set" | "making" | "made" | "missing";

/**
 * A Character's reference views, made from its page: one at a time or every missing view at once, each with its exact
 * price (what the Reference Studio would charge for that same request), and the total for all of them on the button.
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
  const missing = quote.views.filter((v) => states[v.id] === "missing" && v.costUsd != null);
  const total = missing.reduce((s, v) => s + (v.costUsd ?? 0), 0);
  const hidden = (views: string[], cost: number) => (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="characterId" value={characterId} />
      <input type="hidden" name="views" value={views.join(",")} />
      <input type="hidden" name="batchId" value={`${batchId}-${views.join("-")}`} />
      {quote.paid ? <input type="hidden" name="confirmedTotalUsd" value={cost.toFixed(4)} /> : null}
    </>
  );
  const price = (cost: number) => (quote.paid ? priceText(cost) : "free");
  // what the creator pays for all of them: each view is charged its own price, so the total is their sum
  const totalPrice = Math.round(missing.reduce((s, v) => s + (userPrice(v.costUsd) ?? 0), 0) * 100) / 100;
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

        <div className="space-y-2">
          <div className="font-medium">2. Six views</div>
          <ul className="space-y-1" data-testid="reference-plan-views">
            {quote.views.map((v) => {
              const state = states[v.id] ?? "missing";
              return (
                <li
                  key={v.id}
                  className="flex items-center justify-between gap-2 rounded-[3px] border border-line px-2 py-1"
                  data-testid="reference-view"
                  data-view={v.id}
                  data-state={state}
                >
                  <span className={state === "in_set" ? "text-pass" : ""}>
                    {state === "in_set" ? "✓ " : ""}
                    {v.label}
                  </span>
                  {state === "in_set" ? (
                    <span className="text-[11.5px] text-faint">in the set</span>
                  ) : state === "making" ? (
                    <span className="text-[11.5px] text-muted">being made…</span>
                  ) : state === "made" ? (
                    <Link href={studioHref} className="text-[11.5px] text-accent hover:underline">
                      made: add it to the set
                    </Link>
                  ) : v.costUsd == null ? (
                    <span className="text-[11.5px] text-warn" title={v.problem ?? ""}>
                      {v.problem ?? "can't be made right now"}
                    </span>
                  ) : (
                    <ActionForm action={makeReferenceViews} successMessage="" quiet>
                      {hidden([v.id], v.costUsd)}
                      <Button type="submit" size="sm" data-testid="reference-view-make">
                        Make · {price(v.costUsd)}
                      </Button>
                    </ActionForm>
                  )}
                </li>
              );
            })}
          </ul>
          {missing.length > 1 ? (
            <ActionForm action={makeReferenceViews} successMessage="" className="space-y-1">
              {hidden(
                missing.map((v) => v.id),
                total,
              )}
              <Button type="submit" variant="primary" data-testid="reference-views-make-all">
                Make all {missing.length} · {quote.paid ? `$${totalPrice.toFixed(2)}` : "free"}
              </Button>
              <p className="text-[11px] text-muted" data-testid="reference-views-total">
                {quote.paid
                  ? `The exact total for these ${missing.length} views with ${quote.modelLabel}, charged only for the views that start.`
                  : `Free with ${quote.modelLabel}.`}
                {missing.length > atOnce
                  ? ` This project makes ${atOnce} at a time: the first ${atOnce} start now, then press again for the rest.`
                  : ""}
              </p>
            </ActionForm>
          ) : null}
          {missing.length === 0 && quote.views.every((v) => states[v.id] === "in_set") ? (
            <p className="text-pass" data-testid="reference-plan-total">
              The set is complete.
            </p>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
