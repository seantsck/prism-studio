"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { priceText } from "@/domain/pricing/user-price";
import { redraftEpisode } from "@/server/series-actions";

export type RedraftQuote =
  { ok: true; paid: boolean; label: string; usd: number } | { ok: false; reason: string };

/**
 * Redraft the whole Episode: Prism writes a new complete screenplay at the Episode's length, keeping its story. The
 * creator picks the writer, may add a note, sees the price, and confirms; the draft arrives as a proposal in the
 * conversation, and the screenplay changes only when it is accepted (the current one stays in the history).
 */
export function RedraftEpisode({
  slug,
  episodeId,
  sessionId,
  minutes,
  writers,
  recommended,
  quotes,
  busy,
}: {
  slug: string;
  episodeId: string;
  sessionId: string | null;
  minutes: number | null;
  writers: Array<{ value: string; label: string; available: boolean; paid: boolean }>;
  recommended: string;
  quotes: Record<string, RedraftQuote>;
  /** a proposal of this conversation is being written: a second redraft waits */
  busy: boolean;
}) {
  const [writer, setWriter] = useState(recommended);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const quote = quotes[writer];
  const offered = writers.filter((w) => w.available);
  const price = quote?.ok ? (quote.paid ? priceText(quote.usd) : "free") : "";

  return (
    <div className="space-y-2 text-[12.5px]" data-testid="redraft-episode">
      <p className="text-muted">
        Prism writes a new complete screenplay of this episode
        {minutes ? ` at ${minutes} minutes` : ""}, from the Bible, the characters and the current script,
        keeping its story. It arrives below as a proposal: the screenplay changes only when you accept it, and
        the current one stays in the history.
      </p>
      {minutes ? null : (
        <p className="text-warn" data-testid="redraft-no-length">
          This episode has no length set, so Prism writes a standard-length episode. Set its length on the
          Episodes page first to choose one.
        </p>
      )}
      <label className="block">
        <span className="mb-1 block text-muted">What to change (optional)</span>
        <textarea
          rows={2}
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
          placeholder="For example: a longer first conversation between the leads, and end on a cliffhanger."
          data-testid="redraft-note"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {offered.length > 1 ? (
          <select
            value={writer}
            onChange={(e) => setWriter(e.target.value)}
            aria-label="Writer"
            data-testid="redraft-writer"
          >
            {offered.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
                {w.paid ? "" : " (free)"}
              </option>
            ))}
          </select>
        ) : null}
        {quote && !quote.ok ? (
          <span className="text-warn" data-testid="redraft-unavailable">
            {quote.reason}
          </span>
        ) : quote ? (
          <>
            <Button
              type="button"
              variant="primary"
              disabled={busy}
              onClick={() => setConfirming(true)}
              data-testid="redraft-open"
            >
              {busy ? "Prism is writing…" : "Redraft the episode…"}
            </Button>
            <span className="text-muted" data-testid="redraft-price">
              {price} with {quote.label}
            </span>
          </>
        ) : null}
      </div>

      {confirming && quote?.ok ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="redraft-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          data-testid="redraft-confirm"
        >
          <div className="w-full max-w-md rounded-xl border border-line2 bg-panel p-5 shadow-2xl">
            <h2 id="redraft-confirm-title" className="text-[16px] font-semibold">
              Redraft the whole episode?
            </h2>
            <dl className="mt-3 space-y-1.5 text-[13px]">
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Length</dt>
                <dd>{minutes ? `${minutes} minutes` : "standard"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Writer</dt>
                <dd>{quote.label}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Price</dt>
                <dd className="font-medium" data-testid="redraft-confirm-price">
                  {price}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-[12px] text-muted">
              It is written in parts and arrives as one proposal. Nothing changes until you accept it.
              {quote.paid ? " This is the most it can cost, charged when you press Redraft." : ""}
            </p>
            <ActionForm
              action={redraftEpisode}
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
              <input type="hidden" name="episodeId" value={episodeId} />
              {sessionId ? <input type="hidden" name="sessionId" value={sessionId} /> : null}
              <input type="hidden" name="model" value={writer} />
              <input type="hidden" name="note" value={note} />
              {quote.paid ? (
                <input type="hidden" name="confirmedTotalUsd" value={quote.usd.toFixed(4)} />
              ) : null}
              <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" data-testid="redraft-go">
                Redraft · {price}
              </Button>
            </ActionForm>
          </div>
        </div>
      ) : null}
    </div>
  );
}
