import Link from "next/link";
import { Panel } from "@/components/ui";
import {
  LOCATION_PHOTOS_BEST,
  REFERENCE_PHOTOS_BEST,
  type ReferencePlan,
} from "@/domain/generation/reference-plan";
import { priceText } from "@/domain/pricing/user-price";

/**
 * How many references a Character needs and what the rest will cost, before anything is made: the photos that make the
 * likeness, then the six views, each ticked once it is in the set. The total is the creator's price for the views
 * still to make with the suggested model; each picture's exact price is shown again before it is made.
 */
export function ReferencePlanPanel({
  name,
  plan,
  photos,
  studioHref,
  kind = "character",
  className = "xl:col-span-2",
}: {
  name: string;
  plan: ReferencePlan;
  photos: number;
  studioHref: string;
  kind?: "character" | "location";
  className?: string;
}) {
  const [low, high] = kind === "character" ? REFERENCE_PHOTOS_BEST : LOCATION_PHOTOS_BEST;
  const todo = plan.views.filter((v) => !v.done);
  return (
    <Panel
      title="References: how many, and the price"
      className={className}
      actions={
        <Link href={studioHref} className="text-[12px] text-accent hover:underline">
          Make them in the Reference Studio
        </Link>
      }
    >
      <div className="grid gap-4 text-[12.5px] md:grid-cols-2" data-testid="reference-plan">
        <div className="space-y-1">
          <div className="font-medium">
            1. Photos (optional, best for {kind === "character" ? "a real face" : "a real place"})
          </div>
          <p className="text-muted">
            {kind === "character"
              ? `${low} to ${high} photos: face large, sharp and evenly lit; front, 3/4 and side; one full body. No sunglasses, filters or group shots. Without photos, Prism makes ${name} from the physical description.`
              : `${low} to ${high} photos: a wide view, the reverse angle and a few details, all at the same time of day. Without photos, Prism makes ${name} from its description.`}
          </p>
          <p
            className={photos >= low && photos <= high ? "text-pass" : "text-faint"}
            data-testid="reference-plan-photos"
          >
            You have {photos} photo{photos === 1 ? "" : "s"}.
          </p>
        </div>
        <div className="space-y-1">
          <div className="font-medium">
            2. {plan.views.length === 6 ? "Six" : plan.views.length} views, made one at a time
          </div>
          <ul className="flex flex-wrap gap-1.5" data-testid="reference-plan-views">
            {plan.views.map((v) => (
              <li
                key={v.id}
                className={
                  "rounded-full border px-2 py-0.5 text-[11.5px] " +
                  (v.done ? "border-pass/50 text-pass" : "border-line text-muted")
                }
                data-done={v.done ? "1" : "0"}
              >
                {v.done ? "✓ " : ""}
                {v.label}
              </li>
            ))}
          </ul>
          <p data-testid="reference-plan-total">
            {todo.length === 0 ? (
              <span className="text-pass">The set is complete.</span>
            ) : (
              <>
                <span className="font-medium">
                  {todo.length} to make: about {priceText(plan.remainingCostUsd)}
                </span>
                <span className="text-muted">
                  {" "}
                  with {plan.modelLabel}. Each picture&apos;s exact price is shown before it is made, and
                  nothing is made without you pressing Generate.
                </span>
              </>
            )}
          </p>
        </div>
      </div>
    </Panel>
  );
}
