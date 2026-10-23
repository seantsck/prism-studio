"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export const SEQUENCE_FILTERS = [
  ["all", "All"],
  ["needs_pf", "Needs Production Frame"],
  ["stale", "Stale"],
  ["issues", "Continuity issues"],
] as const;
export type SequenceFilter = (typeof SEQUENCE_FILTERS)[number][0];

/**
 * Client-local filter for the Sequence Board. It only sets `data-seq-filter` on the wrapper; globals.css hides the
 * cards that do not match (each card carries its own data flags), so the server-rendered cards and the drag-to-reorder
 * board are untouched. Nothing is stored or sent.
 */
export function SequenceFilters({
  counts,
  children,
}: {
  counts: Record<SequenceFilter, number>;
  children: ReactNode;
}) {
  const [filter, setFilter] = useState<SequenceFilter>("all");
  return (
    <div data-seq-filter={filter} data-testid="sequence-board">
      <div role="group" aria-label="Filter Shots" className="mb-4 flex flex-wrap gap-1.5">
        {SEQUENCE_FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            data-testid={`sequence-filter-${key}`}
            onClick={() => setFilter(key)}
            className={cn(
              "rounded-[3px] border px-2 py-0.5 text-[11.5px]",
              filter === key ? "border-accent/60 text-accent" : "border-line2 text-muted hover:text-fg",
            )}
          >
            {label} <span className="font-mono">({counts[key]})</span>
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}
