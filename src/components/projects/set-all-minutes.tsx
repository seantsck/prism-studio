"use client";

import { useRef } from "react";

/** "Every episode: N minutes": fills each episode's minutes box in the surrounding form (saved with the plan). */
export function SetAllMinutes({ max }: { max: number }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-[12px] text-muted"
      data-testid="start-plan-all-minutes"
    >
      <span>Every episode:</span>
      <input
        ref={ref}
        type="number"
        min={1}
        max={max}
        inputMode="numeric"
        placeholder="24"
        aria-label="Minutes for every episode"
        className="w-20"
        data-testid="start-plan-all-minutes-input"
      />
      <span>minutes</span>
      <button
        type="button"
        className="text-accent hover:underline"
        data-testid="start-plan-all-minutes-go"
        onClick={(e) => {
          const value = ref.current?.value.trim() ?? "";
          if (!value) return;
          e.currentTarget
            .closest("form")
            ?.querySelectorAll<HTMLInputElement>("input[data-minutes]")
            .forEach((input) => {
              input.value = value;
            });
        }}
      >
        Apply to all
      </button>
    </div>
  );
}
