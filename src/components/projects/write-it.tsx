"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { writeWhole } from "@/server/series-actions";

export interface WriterOption {
  value: string;
  label: string;
  paid: boolean;
  available: boolean;
  reason: string | null;
}

export type ScopeQuote =
  | {
      ok: true;
      usd: number;
      paid: boolean;
      label: string;
      episodes: Array<{ number: number; title: string }>;
    }
  | { ok: false; reason: string };

/** The price of each choice, per writer: what the confirmation shows and what is confirmed. */
export type WriteQuotes = Record<string, { one: ScopeQuote; all: ScopeQuote | null }>;

const RECOMMENDED = "recommended";
const money = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;

/**
 * Write it: choose the writer (Prism's recommendation, or a named one) and, for a series, one Episode or every
 * unwritten one; a film is written whole. "Write…" opens a confirmation that names what will be written, by whom, and
 * the most it can cost; nothing runs before "Write" there.
 */
export function WriteIt({
  slug,
  kind,
  writers,
  recommended,
  quotes,
}: {
  slug: string;
  kind: "series" | "film" | "short";
  writers: WriterOption[];
  /** The writer "Recommended by Prism" uses. */
  recommended: string;
  quotes: WriteQuotes;
}) {
  const [writer, setWriter] = useState(RECOMMENDED);
  const [scope, setScope] = useState<"one" | "all">("one");
  const [confirming, setConfirming] = useState(false);
  const chosen = writer === RECOMMENDED ? recommended : writer;
  const forWriter = quotes[chosen];
  const quote = scope === "all" && forWriter?.all ? forWriter.all : forWriter?.one;
  const what =
    kind !== "series"
      ? `the whole ${kind === "film" ? "film" : "short film"}`
      : quote?.ok && quote.episodes.length > 1
        ? `all ${quote.episodes.length} episodes`
        : quote?.ok
          ? `episode ${quote.episodes[0]!.number}, "${quote.episodes[0]!.title}"`
          : "it";
  const recommendedLabel = writers.find((w) => w.value === recommended)?.label;

  return (
    <div className="space-y-3" data-testid="write-it">
      <div>
        <div className="mb-1 text-[12px] text-muted">Writer</div>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Writer">
          {[
            {
              value: RECOMMENDED,
              label: "Recommended by Prism",
              hint: recommendedLabel,
              available: true,
              reason: null,
            },
            ...writers.map((w) => ({ ...w, hint: w.paid ? null : "free" })),
          ].map((w) => (
            <button
              key={w.value}
              type="button"
              role="radio"
              aria-checked={writer === w.value}
              disabled={!w.available}
              title={w.reason ?? undefined}
              onClick={() => setWriter(w.value)}
              className={cn(
                "rounded-full border px-3 py-1 text-[12px] transition-colors disabled:opacity-40",
                writer === w.value
                  ? "border-accent bg-accent/10 text-fg"
                  : "border-line text-muted hover:text-fg",
              )}
              data-testid="write-it-writer"
              data-value={w.value}
            >
              {w.label}
              {w.hint ? <span className="text-faint"> · {w.hint}</span> : null}
              {!w.available && w.reason ? <span className="text-faint"> · not available</span> : null}
            </button>
          ))}
        </div>
      </div>

      {kind === "series" && forWriter?.all ? (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="What to write">
          {(
            [
              ["one", forWriter.one.ok ? `Episode ${forWriter.one.episodes[0]!.number} only` : "One episode"],
              ["all", forWriter.all.ok ? `All ${forWriter.all.episodes.length} episodes` : "All episodes"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={scope === id}
              onClick={() => setScope(id)}
              className={cn(
                "rounded-full border px-3 py-1 text-[12px] transition-colors",
                scope === id ? "border-accent bg-accent/10 text-fg" : "border-line text-muted hover:text-fg",
              )}
              data-testid={`write-it-scope-${id}`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {quote && !quote.ok ? (
        <p className="text-[13px] text-warn" data-testid="write-it-unavailable">
          {quote.reason}
        </p>
      ) : quote ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="primary"
            onClick={() => setConfirming(true)}
            data-testid="write-it-open"
          >
            Write {what}…
          </Button>
          <span className="text-[12px] text-muted" data-testid="write-it-price">
            {quote.paid ? `up to ${money(quote.usd)}` : "free"} with {quote.label}
          </span>
        </div>
      ) : null}

      {confirming && quote?.ok ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="write-it-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          data-testid="write-it-confirm"
        >
          <div className="w-full max-w-md rounded-xl border border-line2 bg-panel p-5 shadow-2xl">
            <h2 id="write-it-confirm-title" className="text-[16px] font-semibold">
              Write {what}?
            </h2>
            <dl className="mt-3 space-y-1.5 text-[13px]">
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Writer</dt>
                <dd>{quote.label}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Cost</dt>
                <dd className="font-medium" data-testid="write-it-confirm-price">
                  {quote.paid ? `up to ${money(quote.usd)}` : "free"}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-[12px] text-muted">
              {quote.episodes.length > 1
                ? `Each episode is written in parts and arrives as its own proposal. Nothing goes into a script until you accept it.`
                : `It is written in parts and arrives as a proposal. Nothing goes into the script until you accept it.`}
              {quote.paid ? " The cost shown is the most it should take; it usually takes less." : ""}
            </p>
            <ActionForm action={writeWhole} successMessage="" className="mt-4 flex justify-end gap-2">
              <input type="hidden" name="projectSlug" value={slug} />
              <input type="hidden" name="model" value={chosen} />
              <input type="hidden" name="scope" value={scope} />
              {quote.paid ? (
                <input type="hidden" name="confirmedTotalUsd" value={quote.usd.toFixed(4)} />
              ) : null}
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" data-testid="write-it-confirm-go">
                Write · {quote.paid ? `up to ${money(quote.usd)}` : "free"}
              </Button>
            </ActionForm>
          </div>
        </div>
      ) : null}
    </div>
  );
}
