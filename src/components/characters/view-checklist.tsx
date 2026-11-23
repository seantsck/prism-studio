"use client";

import Link from "next/link";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { userPrice } from "@/domain/pricing/user-price";
import { makeReferenceViews } from "@/server/reference-view-actions";
import { cn } from "@/lib/utils";

export type ViewState = "in_set" | "making" | "made" | "missing";

export interface ChecklistView {
  id: string;
  label: string;
  state: ViewState;
  /** Prism's cost for this view (null: it cannot be made right now, see `problem`) */
  costUsd: number | null;
  problem: string | null;
}

/**
 * The six reference views as a checklist: tick the ones to make, one by one or all at once, and the button carries
 * the exact total of what is ticked (each view is charged its own price, so the total is the sum of the prices shown).
 * What is sent back is Prism's cost for the ticked views; the server prices them again before anything starts.
 */
export function ViewChecklist({
  slug,
  characterId,
  views,
  paid,
  modelLabel,
  batchId,
  atOnce,
  studioHref,
}: {
  slug: string;
  characterId: string;
  views: ChecklistView[];
  paid: boolean;
  modelLabel: string;
  batchId: string;
  atOnce: number;
  studioHref: string;
}) {
  const makeable = views.filter((v) => v.state === "missing" && v.costUsd != null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(makeable.map((v) => v.id)));
  const chosen = makeable.filter((v) => picked.has(v.id));
  const cost = chosen.reduce((s, v) => s + v.costUsd!, 0);
  const price = Math.round(chosen.reduce((s, v) => s + (userPrice(v.costUsd) ?? 0), 0) * 100) / 100;
  const priceOf = (usd: number) => (paid ? `$${(userPrice(usd) ?? 0).toFixed(2)}` : "free");
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const all = makeable.length > 0 && chosen.length === makeable.length;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <div className="font-medium">2. Six views</div>
        {makeable.length > 1 ? (
          <button
            type="button"
            className="text-[11.5px] text-accent hover:underline"
            onClick={() => setPicked(all ? new Set() : new Set(makeable.map((v) => v.id)))}
            data-testid="reference-views-select-all"
          >
            {all ? "Select none" : "Select all"}
          </button>
        ) : null}
      </div>
      <ul className="space-y-1" data-testid="reference-plan-views">
        {views.map((v) => {
          const can = v.state === "missing" && v.costUsd != null;
          return (
            <li
              key={v.id}
              data-testid="reference-view"
              data-view={v.id}
              data-state={v.state}
              data-picked={can && picked.has(v.id) ? "1" : "0"}
            >
              <label
                className={cn(
                  "flex items-center justify-between gap-2 rounded-[3px] border px-2 py-1",
                  can ? "cursor-pointer border-line hover:border-line2" : "border-line",
                  can && picked.has(v.id) && "border-accent/60 bg-accent/5",
                )}
              >
                <span className="flex items-center gap-2">
                  {can ? (
                    <input
                      type="checkbox"
                      checked={picked.has(v.id)}
                      onChange={() => toggle(v.id)}
                      data-testid="reference-view-pick"
                    />
                  ) : null}
                  <span className={v.state === "in_set" ? "text-pass" : ""}>
                    {v.state === "in_set" ? "✓ " : ""}
                    {v.label}
                  </span>
                </span>
                {v.state === "in_set" ? (
                  <span className="text-[11.5px] text-faint">in the set</span>
                ) : v.state === "making" ? (
                  <span className="text-[11.5px] text-muted">being made…</span>
                ) : v.state === "made" ? (
                  <Link href={studioHref} className="text-[11.5px] text-accent hover:underline">
                    made: add it to the set
                  </Link>
                ) : v.costUsd == null ? (
                  <span className="text-[11.5px] text-warn" title={v.problem ?? ""}>
                    {v.problem ?? "can't be made right now"}
                  </span>
                ) : (
                  <span className="text-[11.5px] text-muted" data-testid="reference-view-price">
                    {priceOf(v.costUsd)}
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>
      {makeable.length > 0 ? (
        <ActionForm action={makeReferenceViews} successMessage="" className="space-y-1">
          <input type="hidden" name="projectSlug" value={slug} />
          <input type="hidden" name="characterId" value={characterId} />
          <input type="hidden" name="views" value={chosen.map((v) => v.id).join(",")} />
          <input type="hidden" name="batchId" value={`${batchId}-${chosen.map((v) => v.id).join("-")}`} />
          {paid ? <input type="hidden" name="confirmedTotalUsd" value={cost.toFixed(4)} /> : null}
          <Button
            type="submit"
            variant="primary"
            disabled={chosen.length === 0}
            data-testid="reference-views-make"
          >
            {chosen.length === 0
              ? "Tick the views to make"
              : `Make ${chosen.length === 1 ? `the ${chosen[0]!.label.toLowerCase()} view` : `${chosen.length} views`} · ${paid ? `$${price.toFixed(2)}` : "free"}`}
          </Button>
          <p className="text-[11px] text-muted" data-testid="reference-views-total">
            {paid
              ? `The exact total for the ticked views with ${modelLabel}: each is charged its own price, only when it starts.`
              : `Free with ${modelLabel}.`}
            {chosen.length > atOnce
              ? ` This project makes ${atOnce} at a time: the first ${atOnce} start now, then press again for the rest.`
              : ""}
          </p>
        </ActionForm>
      ) : views.every((v) => v.state === "in_set") ? (
        <p className="text-pass" data-testid="reference-plan-total">
          The set is complete.
        </p>
      ) : null}
    </div>
  );
}
