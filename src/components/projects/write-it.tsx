"use client";

import { useMemo, useState } from "react";
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

/** Every Episode that can be written, each with its own price, for one writer. */
export type WriterQuote =
  | {
      ok: true;
      paid: boolean;
      label: string;
      episodes: Array<{ id: string; number: number; title: string; usd: number; minutes: number | null }>;
    }
  | { ok: false; reason: string };

/** The price of each Episode, per writer: the confirmation sums the ones picked. */
export type WriteQuotes = Record<string, WriterQuote>;

const RECOMMENDED = "recommended";
const money = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
/** The sum the server works out for the same Episodes (rounded the same way). */
const total = (xs: Array<{ usd: number }>) => Math.round(xs.reduce((s, e) => s + e.usd, 0) * 10000) / 10000;

/**
 * Write it: choose the writer (Prism's recommendation, or a named one) and, for a series, which unwritten Episodes to
 * write (every one is ticked to start with; tick any set); a film is written whole. "Write…" opens a confirmation that
 * names what will be written, by whom, and the most it can cost; nothing runs before "Write" there.
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
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const chosen = writer === RECOMMENDED ? recommended : writer;
  const quote = quotes[chosen];
  const series = kind === "series";
  const all = useMemo(() => (quote?.ok ? quote.episodes : []), [quote]);
  const picked = series ? all.filter((e) => !unticked.has(e.id)) : all.slice(0, 1);
  const usd = total(picked);
  const what = !series
    ? `the whole ${kind === "film" ? "film" : "short film"}`
    : picked.length === all.length && all.length > 1
      ? `all ${all.length} episodes`
      : picked.length === 1
        ? `episode ${picked[0]!.number}, "${picked[0]!.title}"`
        : `${picked.length} episodes`;
  const price = quote?.ok ? `${quote.paid ? `up to ${money(usd)}` : "free"} with ${quote.label}` : "";
  const recommendedLabel = writers.find((w) => w.value === recommended)?.label;
  const toggle = (id: string) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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

      {series && all.length > 1 ? (
        <fieldset className="space-y-1.5" data-testid="write-it-episodes">
          <div className="flex items-center gap-3 text-[12px]">
            <legend className="text-muted">
              Episodes to write ({picked.length} of {all.length})
            </legend>
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => setUnticked(new Set())}
              data-testid="write-it-all"
            >
              All
            </button>
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => setUnticked(new Set(all.map((e) => e.id)))}
              data-testid="write-it-none"
            >
              None
            </button>
          </div>
          <ul className="grid max-h-64 gap-1 overflow-y-auto pr-1 sm:grid-cols-2">
            {all.map((e) => (
              <li key={e.id}>
                <label className="flex items-baseline gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={!unticked.has(e.id)}
                    onChange={() => toggle(e.id)}
                    data-testid="write-it-episode"
                    data-number={e.number}
                  />
                  <span className="min-w-0 truncate">
                    {e.number}. {e.title}
                    {e.minutes ? <span className="text-faint"> · {e.minutes} min</span> : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
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
            disabled={picked.length === 0}
            onClick={() => setConfirming(true)}
            data-testid="write-it-open"
          >
            {picked.length === 0 ? "Pick an episode to write" : `Write ${what}…`}
          </Button>
          {picked.length ? (
            <span className="text-[12px] text-muted" data-testid="write-it-price">
              {price}
            </span>
          ) : null}
        </div>
      ) : null}

      {confirming && quote?.ok && picked.length ? (
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
                  {quote.paid ? `up to ${money(usd)}` : "free"}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-[12px] text-muted">
              {picked.length > 1
                ? `Each episode is written in parts and arrives as its own proposal. Nothing goes into a script until you accept it.`
                : `It is written in parts and arrives as a proposal. Nothing goes into the script until you accept it.`}
              {quote.paid ? " The cost shown is the most it should take; it usually takes less." : ""}
            </p>
            <ActionForm action={writeWhole} successMessage="" className="mt-4 flex justify-end gap-2">
              <input type="hidden" name="projectSlug" value={slug} />
              <input type="hidden" name="model" value={chosen} />
              {series ? (
                <input type="hidden" name="episodeIds" value={picked.map((e) => e.id).join(",")} />
              ) : (
                <input type="hidden" name="scope" value="one" />
              )}
              {quote.paid ? <input type="hidden" name="confirmedTotalUsd" value={usd.toFixed(4)} /> : null}
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" data-testid="write-it-confirm-go">
                Write · {quote.paid ? `up to ${money(usd)}` : "free"}
              </Button>
            </ActionForm>
          </div>
        </div>
      ) : null}
    </div>
  );
}
