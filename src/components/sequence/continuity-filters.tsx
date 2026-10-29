"use client";

import { useState, type ReactNode } from "react";
import { CUT_FILTERS, type CutFilter } from "@/components/views/cut-marker-model";
import { cn } from "@/lib/utils";

/**
 * Client-local filter for the Continuity Supervisor (Phase 3A.4B). It only sets `data-cut-filter` on the wrapper;
 * globals.css hides the server-rendered cut rows that do not match their own data flags. No request, nothing stored.
 */
export function ContinuityFilters({
  counts,
  children,
}: {
  counts: Record<CutFilter, number>;
  children: ReactNode;
}) {
  const [filter, setFilter] = useState<CutFilter>("all");
  return (
    <div data-cut-filter={filter} data-testid="cut-list">
      <div role="group" aria-label="Filter cuts" className="mb-3 flex flex-wrap gap-1.5">
        {CUT_FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            data-testid={`cut-filter-${key}`}
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
