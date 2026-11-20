"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { REFERENCE_SET_GUIDANCE, type ReferenceSetViewId } from "@/domain/generation/reference-studio";
import { cn } from "@/lib/utils";
import type { StudioSetView, StudioState } from "@/server/reference-studio";
import { addToReferenceSet } from "@/server/visual-bible-actions";

/**
 * A Character's reference set: the five views every Production Frame of the Character is made from, what is in each,
 * and what is missing. An empty view offers to make it (which only fills in the brief; nothing is spent until
 * Generate). Beside it, in a few lines, what makes a strong set.
 */
export function ReferenceSetPanel({
  subject,
  set,
  photos,
  onMake,
}: {
  subject: NonNullable<StudioState["selected"]>;
  set: StudioSetView[];
  /** How many of the creator's own photos of the subject there are. */
  photos: number;
  /** Fills in the brief to make this view (from the selected starting images). */
  onMake: (intent: string) => void;
}) {
  const filled = set.filter((v) => v.assetId).length;
  return (
    <div className="rounded-[3px] border border-line bg-panel p-3" data-testid="studio-reference-set">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-medium">
          {subject.name}&apos;s reference set{" "}
          <span className="font-normal text-muted" data-testid="studio-set-count">
            ({filled} of {set.length} views)
          </span>
        </h2>
        <p className="text-[11.5px] text-muted">
          Every Production Frame of {subject.name} is made from these, the front first.
        </p>
      </div>
      <ul className="mt-2 grid grid-cols-5 gap-2">
        {set.map((v) => (
          <li
            key={v.id}
            data-testid="studio-set-view"
            data-view={v.id}
            data-filled={v.assetId ? "true" : "false"}
          >
            <div
              className={cn(
                "flex h-[112px] items-center justify-center overflow-hidden rounded-[3px] border bg-[#232326]",
                v.assetId ? "border-line2" : "border-dashed border-line2",
              )}
            >
              {v.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={v.url} alt={`${subject.name}, ${v.label}`} className="h-full w-full object-cover" />
              ) : (
                <button
                  type="button"
                  className="px-1 text-center text-[11px] text-accent hover:underline"
                  onClick={() => onMake(v.intent)}
                  data-testid="studio-set-make"
                >
                  Make it
                </button>
              )}
            </div>
            <p className="mt-0.5 text-[11px] font-medium">
              {v.label}
              {v.canonical ? <span className="font-normal text-muted"> · canonical</span> : null}
            </p>
            <p className="text-[10.5px] text-muted">{v.from ?? "empty"}</p>
          </li>
        ))}
      </ul>
      <details className="mt-2 text-[11.5px]" data-testid="studio-set-guidance">
        <summary className="text-muted hover:text-fg">
          What makes the best set{" "}
          <span className={photos >= 4 ? "text-pass" : "text-warn"}>
            (you have {photos} photo{photos === 1 ? "" : "s"}; 4 to 8 is best)
          </span>
        </summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">
          {REFERENCE_SET_GUIDANCE.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/**
 * Puts one picture (a take, or one of the creator's photos) into a view of the reference set: one choice, one button.
 * The button says what will happen: add, or replace the picture the view holds now (the old one stays in the library).
 */
export function AddToSet({
  slug,
  characterId,
  set,
  attemptId,
  assetId,
  suggested,
  compact = false,
}: {
  slug: string;
  characterId: string;
  set: StudioSetView[];
  /** A finished take … */
  attemptId?: string;
  /** … or one of the creator's photos of this Character. */
  assetId: string;
  /** The view the picture naturally belongs in (from what it was made as). */
  suggested: ReferenceSetViewId | null;
  compact?: boolean;
}) {
  const firstEmpty = set.find((v) => !v.assetId)?.id;
  const [choice, setChoice] = useState<ReferenceSetViewId | null>(null);
  const viewId = choice ?? suggested ?? firstEmpty ?? set[0]?.id ?? "front";
  const view = set.find((v) => v.id === viewId);
  const here = set.filter((v) => v.assetId === assetId).map((v) => v.label.toLowerCase());
  if (!view) return null;
  const same = view.assetId === assetId;
  const replacing = !!view.assetId && !same;
  const blocked = replacing && view.locked;
  return (
    <ActionForm
      action={addToReferenceSet}
      successMessage="Added to the reference set"
      className={cn("flex flex-wrap items-center gap-1.5", compact ? "mt-1" : "")}
      data-testid="studio-add-to-set"
    >
      <input type="hidden" name="projectSlug" value={slug} />
      <input type="hidden" name="characterId" value={characterId} />
      {attemptId ? (
        <input type="hidden" name="attemptId" value={attemptId} />
      ) : (
        <input type="hidden" name="assetId" value={assetId} />
      )}
      {replacing ? <input type="hidden" name="confirmReplace" value="1" /> : null}
      <select
        name="view"
        value={viewId}
        onChange={(e) => setChoice(e.target.value as ReferenceSetViewId)}
        className={compact ? "h-7 text-[11.5px]" : undefined}
        style={{ width: "auto", maxWidth: "16rem" }}
        aria-label="View in the reference set"
        data-testid="studio-set-choice"
      >
        {set.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
            {v.canonical ? " (canonical)" : ""}
            {v.assetId ? (v.assetId === assetId ? " ✓" : " · filled") : " · empty"}
          </option>
        ))}
      </select>
      <Button
        type="submit"
        variant={compact ? undefined : "primary"}
        size={compact ? "sm" : undefined}
        disabled={same || blocked}
        data-testid="studio-add-to-set-submit"
      >
        {same
          ? `In the set as ${view.label.toLowerCase()}`
          : replacing
            ? `Replace the ${view.label.toLowerCase()}`
            : `Add to the set as ${view.label.toLowerCase()}`}
      </Button>
      {blocked ? (
        <span className="text-[11px] text-warn">That view is locked on the Character page.</span>
      ) : here.length > 0 && !same ? (
        <span className="text-[11px] text-muted">Already the {here.join(" and ")}.</span>
      ) : null}
    </ActionForm>
  );
}
