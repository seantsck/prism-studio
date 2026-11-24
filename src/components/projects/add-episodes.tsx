"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { priceText } from "@/domain/pricing/user-price";
import { addEpisodes } from "@/server/series-actions";

/** The price of adding 1, 2, … episodes with one writer (index 0 = one episode). */
export type AddEpisodesQuote =
  { ok: true; paid: boolean; label: string; usd: number[] } | { ok: false; reason: string };

/**
 * Add episodes with Prism: how many, how long, an optional note and the writer; the price is shown and confirmed before
 * anything runs. Prism plans them from the episodes so far; the ideas come back below to be added (or set aside).
 */
export function AddEpisodes({
  slug,
  next,
  defaultMinutes,
  max,
  writers,
  recommended,
  quotes,
  busy,
}: {
  slug: string;
  /** the number the first new episode gets */
  next: number;
  defaultMinutes: number | null;
  max: number;
  writers: Array<{ value: string; label: string; paid: boolean }>;
  recommended: string;
  quotes: Record<string, AddEpisodesQuote>;
  /** Prism is already planning episodes for this project */
  busy: boolean;
}) {
  const [count, setCount] = useState(3);
  const [minutes, setMinutes] = useState(defaultMinutes ? String(defaultMinutes) : "");
  const [note, setNote] = useState("");
  const [writer, setWriter] = useState(recommended);
  const [confirming, setConfirming] = useState(false);
  const quote = quotes[writer];
  const n = Math.min(max, Math.max(1, Math.floor(count) || 1));
  const usd = quote?.ok ? (quote.usd[n - 1] ?? 0) : 0;
  const price = quote?.ok ? (quote.paid ? priceText(usd) : "free") : "";
  const range = n === 1 ? `episode ${next}` : `episodes ${next}–${next + n - 1}`;

  return (
    <div className="space-y-3 text-[12.5px]" data-testid="add-episodes">
      <p className="text-muted">
        Prism plans the next episodes from the ones so far, the Bible and the cast: a title and what happens
        in each. You review them, then add the ones you want. Their scripts are written after, from Start from
        a prompt.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-muted">How many</span>
          <input
            type="number"
            min={1}
            max={max}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            data-testid="add-episodes-count"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-muted">Length each (minutes)</span>
          <input
            type="number"
            min={1}
            max={600}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder="not set"
            data-testid="add-episodes-minutes"
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-muted">What should happen (optional)</span>
        <textarea
          rows={2}
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
          placeholder="For example: the engagement is announced; a rival appears; end the season on the wedding day."
          data-testid="add-episodes-note"
        />
      </label>
      {writers.length > 1 ? (
        <select
          value={writer}
          onChange={(e) => setWriter(e.target.value)}
          aria-label="Writer"
          data-testid="add-episodes-writer"
        >
          {writers.map((w) => (
            <option key={w.value} value={w.value}>
              {w.label}
              {w.paid ? "" : " (free)"}
            </option>
          ))}
        </select>
      ) : null}
      {quote && !quote.ok ? (
        <p className="text-warn" data-testid="add-episodes-unavailable">
          {quote.reason}
        </p>
      ) : quote ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() => setConfirming(true)}
            data-testid="add-episodes-open"
          >
            {busy ? "Prism is planning…" : `Plan ${n} episode${n === 1 ? "" : "s"} with Prism…`}
          </Button>
          <span className="text-muted" data-testid="add-episodes-price">
            {price} with {quote.label}
          </span>
        </div>
      ) : null}

      {confirming && quote?.ok ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-episodes-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          data-testid="add-episodes-confirm"
        >
          <div className="w-full max-w-md rounded-xl border border-line2 bg-panel p-5 shadow-2xl">
            <h2 id="add-episodes-confirm-title" className="text-[16px] font-semibold">
              Plan {range}?
            </h2>
            <dl className="mt-3 space-y-1.5 text-[13px]">
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Length each</dt>
                <dd>{minutes ? `${minutes} minutes` : "not set"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Writer</dt>
                <dd>{quote.label}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Price</dt>
                <dd className="font-medium" data-testid="add-episodes-confirm-price">
                  {price}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-[12px] text-muted">
              Prism plans them; nothing is added until you choose which to add.
              {quote.paid ? " This is the most it can cost, charged when you press Plan." : ""}
            </p>
            <ActionForm
              action={addEpisodes}
              successMessage=""
              className="mt-4 flex justify-end gap-2"
              onResult={(r) => {
                if (r.ok) {
                  setConfirming(false);
                  setNote("");
                }
              }}
            >
              <input type="hidden" name="projectSlug" value={slug} />
              <input type="hidden" name="count" value={n} />
              <input type="hidden" name="minutes" value={minutes} />
              <input type="hidden" name="note" value={note} />
              <input type="hidden" name="model" value={writer} />
              {quote.paid ? <input type="hidden" name="confirmedTotalUsd" value={usd.toFixed(4)} /> : null}
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" data-testid="add-episodes-go">
                Plan · {price}
              </Button>
            </ActionForm>
          </div>
        </div>
      ) : null}
    </div>
  );
}
