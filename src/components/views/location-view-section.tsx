import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { LocationViewCard } from "@/components/location-views/location-view-ui";
import { Button } from "@/components/ui";
import type { ShotContext } from "@/domain/context";
import { clearShotLocationView, selectShotLocationView } from "@/server/location-view-actions";

/**
 * Shot Prep → LOCATION VIEW (Phase 2G.3), shown before the Production Frame and its generation controls. The Shot
 * chooses ONE canonical view of its own Location; Prism then hands that same image to every Production Frame
 * generation of the Shot (and of every other Shot that chooses it), so the place keeps its geography. Optional: no
 * view is never a blocker. Changing the choice changes the Shot's location intent (frames made before become stale).
 */
export function LocationViewSection({ ctx, slug }: { ctx: ShotContext; slug: string }) {
  const selected = ctx.selectedLocationView;
  const hidden = (
    <>
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="shotId" value={ctx.shot.id} />
      <input type="hidden" name="expectedSelectedId" value={selected?.id ?? ""} />
    </>
  );
  return (
    <div data-testid="location-view-section" className="space-y-2 border border-line p-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">Location View</h3>
        {ctx.location ? (
          <span data-testid="lv-location" className="text-[12px]">
            {ctx.location.name}
          </span>
        ) : null}
      </div>

      {!ctx.location ? (
        <p data-testid="lv-no-location" className="text-[12px] text-muted">
          This Shot has no Location. Set one under Location / set to choose a Location View.
        </p>
      ) : (
        <>
          {ctx.locationViewIssue ? (
            <div
              data-testid="lv-integrity"
              className="border border-fail/40 bg-fail/10 p-2 text-[12px] text-fail"
            >
              {ctx.locationViewIssue.message}
            </div>
          ) : null}

          {selected ? (
            <div data-testid="lv-selected" data-view-id={selected.id}>
              <LocationViewCard view={selected} asset={ctx.assets.get(selected.assetId)} selected>
                <ActionForm action={clearShotLocationView} quiet>
                  {hidden}
                  <Button data-testid="lv-clear" size="sm" type="submit">
                    Clear View
                  </Button>
                </ActionForm>
              </LocationViewCard>
            </div>
          ) : (
            <div data-testid="lv-empty" className="text-[12px]">
              <div className="font-medium">No Location View selected.</div>
              <p className="text-muted">
                Choose a persistent view of this Location so future generations preserve the same geography.
              </p>
              {ctx.locationViewIssue ? (
                <ActionForm action={clearShotLocationView} quiet className="mt-1">
                  <input type="hidden" name="projectSlug" value={slug} />
                  <input type="hidden" name="shotId" value={ctx.shot.id} />
                  <Button data-testid="lv-clear-invalid" size="sm" type="submit">
                    Clear the invalid selection
                  </Button>
                </ActionForm>
              ) : null}
            </div>
          )}

          {ctx.locationViews.length > 0 ? (
            <div data-testid="lv-available" className="space-y-1.5">
              <div className="text-[11px] text-muted">Available views of {ctx.location.name}</div>
              {ctx.locationViews
                .filter((v) => v.id !== selected?.id)
                .map((v) => (
                  <LocationViewCard key={v.id} view={v} asset={ctx.assets.get(v.assetId)}>
                    <ActionForm action={selectShotLocationView} quiet>
                      {hidden}
                      <input type="hidden" name="locationViewId" value={v.id} />
                      <Button data-testid="lv-choose" size="sm" type="submit">
                        Choose View
                      </Button>
                    </ActionForm>
                  </LocationViewCard>
                ))}
            </div>
          ) : (
            <p data-testid="lv-none" className="text-[12px] text-muted">
              {ctx.location.name} has no Location Views yet.{" "}
              <Link href={`/projects/${slug}/locations`} className="underline">
                Create one on the Locations page
              </Link>{" "}
              or save a fresh Production Frame as one.
            </p>
          )}
        </>
      )}
    </div>
  );
}
