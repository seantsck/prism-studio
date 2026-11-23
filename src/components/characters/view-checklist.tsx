"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { RefreshWhileActive } from "@/components/images/refresh-while-active";
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
  /** the newest try at this view failed: why (it can be made again) */
  failed?: string | null;
}

/** Views the creator confirmed that have not started yet: the project had no free slot for them. */
interface Waiting {
  batch: string;
  items: { id: string; costUsd: number }[];
}

const storeKey = (characterId: string) => `prism-reference-views-waiting:${characterId}`;
function readWaiting(characterId: string): Waiting | null {
  try {
    const raw = sessionStorage.getItem(storeKey(characterId));
    const w = raw ? (JSON.parse(raw) as Waiting) : null;
    return w && typeof w.batch === "string" && Array.isArray(w.items) && w.items.length ? w : null;
  } catch {
    return null;
  }
}
function writeWaiting(characterId: string, w: Waiting | null) {
  try {
    if (w && w.items.length) sessionStorage.setItem(storeKey(characterId), JSON.stringify(w));
    else sessionStorage.removeItem(storeKey(characterId));
  } catch {
    /* storage unavailable: the waiting views live only in this page */
  }
}

/**
 * The six reference views as a checklist: tick the ones to make, one by one or all at once, and the button carries
 * the exact total of what is ticked (each view is charged its own price, so the total is the sum of the prices shown).
 *
 * A project runs only so many generations at once (`atOnce`). Views that do not fit wait here, are not charged, and
 * are sent again as slots free up (the page re-reads itself while anything is being made or waiting), at the prices
 * the creator confirmed; the server prices them again and starts nothing if the price went up. A summary at the top
 * says how many are done, being made and waiting. The ticks are the creator's: they never move on their own.
 */
export function ViewChecklist({
  slug,
  characterId,
  views,
  paid,
  modelLabel,
  batchId,
  atOnce,
  activeInProject,
  studioHref,
}: {
  slug: string;
  characterId: string;
  views: ChecklistView[];
  paid: boolean;
  modelLabel: string;
  batchId: string;
  atOnce: number;
  /** generations running in this project now (any subject), out of `atOnce` */
  activeInProject: number;
  studioHref: string;
}) {
  const [waiting, setWaitingState] = useState<Waiting | null>(null);
  const setWaiting = useCallback(
    (w: Waiting | null) => {
      setWaitingState(w && w.items.length ? w : null);
      writeWaiting(characterId, w);
    },
    [characterId],
  );
  useEffect(() => setWaitingState(readWaiting(characterId)), [characterId]);

  const waitingIds = new Set(waiting?.items.map((i) => i.id) ?? []);
  const makeable = views.filter((v) => v.state === "missing" && v.costUsd != null && !waitingIds.has(v.id));
  // ticks the creator removed stay removed; a view that becomes makeable later starts ticked
  const [unpicked, setUnpicked] = useState<Set<string>>(new Set());
  const chosen = makeable.filter((v) => !unpicked.has(v.id));
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const send = useCallback(
    async (items: { id: string; costUsd: number }[], batch: string, auto: boolean) => {
      setSending(true);
      try {
        const form = new FormData();
        form.set("projectSlug", slug);
        form.set("characterId", characterId);
        form.set("views", items.map((i) => i.id).join(","));
        form.set("batchId", batch);
        if (paid) form.set("confirmedTotalUsd", items.reduce((s, i) => s + i.costUsd, 0).toFixed(4));
        const res = await makeReferenceViews(form);
        if (res.ok) {
          const left = items.filter((i) => res.waiting.includes(i.id));
          setWaiting(left.length ? { batch, items: left } : null);
          if (!auto || res.started.length) setNote({ ok: true, text: res.message });
        } else {
          setWaiting(null);
          setNote({ ok: false, text: res.error });
        }
      } catch {
        // a network blip: the waiting views stay, and the next refresh tries again
        if (!auto) setNote({ ok: false, text: "The request did not go through. Try again." });
      } finally {
        setSending(false);
      }
    },
    [slug, characterId, paid, setWaiting],
  );

  // a view that started elsewhere (another tab, the Reference Studio) is no longer waiting
  useEffect(() => {
    if (!waiting) return;
    const stillMissing = new Set(views.filter((v) => v.state === "missing").map((v) => v.id));
    const left = waiting.items.filter((i) => stillMissing.has(i.id));
    if (left.length !== waiting.items.length) setWaiting(left.length ? { ...waiting, items: left } : null);
  }, [views, waiting, setWaiting]);

  // start what waits as soon as the project has a free slot (re-checked on every refresh, at most every few seconds)
  const lastTry = useRef(0);
  useEffect(() => {
    if (!waiting || sending || activeInProject >= atOnce) return;
    if (Date.now() - lastTry.current < 4000) return;
    lastTry.current = Date.now();
    void send(waiting.items, waiting.batch, true);
  }, [waiting, sending, activeInProject, atOnce, views, send]);

  const priceOf = (usd: number) => (paid ? `$${(userPrice(usd) ?? 0).toFixed(2)}` : "free");
  const sumPrice = (usds: number[]) =>
    Math.round(usds.reduce((s, u) => s + (userPrice(u) ?? 0), 0) * 100) / 100;
  const price = sumPrice(chosen.map((v) => v.costUsd!));
  const toggle = (id: string) =>
    setUnpicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const all = makeable.length > 0 && chosen.length === makeable.length;

  const count = (s: ViewState) => views.filter((v) => v.state === s).length;
  const done = count("in_set") + count("made");
  const making = count("making");
  const queued = waiting?.items.length ?? 0;
  const failed = views.filter((v) => v.state === "missing" && v.failed && !waitingIds.has(v.id)).length;
  const busy = making > 0 || queued > 0;

  return (
    <div className="space-y-2">
      <RefreshWhileActive active={busy} intervalMs={3000} />
      <div className="flex items-baseline justify-between">
        <div className="font-medium">2. Six views</div>
        {makeable.length > 1 ? (
          <button
            type="button"
            className="text-[11.5px] text-accent hover:underline"
            onClick={() => setUnpicked(all ? new Set(makeable.map((v) => v.id)) : new Set())}
            data-testid="reference-views-select-all"
          >
            {all ? "Select none" : "Select all"}
          </button>
        ) : null}
      </div>

      {busy || done > 0 || failed > 0 ? (
        <div className="space-y-1" data-testid="reference-views-progress" aria-live="polite">
          <div className="flex h-1.5 overflow-hidden rounded-full bg-line" aria-hidden>
            <div className="bg-pass" style={{ width: `${(done / views.length) * 100}%` }} />
            <div className="animate-pulse bg-accent" style={{ width: `${(making / views.length) * 100}%` }} />
            <div className="bg-accent/30" style={{ width: `${(queued / views.length) * 100}%` }} />
          </div>
          <p className="text-[11.5px]">
            <span className="text-pass">{done} done</span>
            {" · "}
            <span className={making ? "text-accent" : "text-muted"} data-testid="reference-views-making">
              {making} being made
            </span>
            {" · "}
            <span className="text-muted" data-testid="reference-views-waiting">
              {queued} waiting
            </span>
            {failed ? (
              <>
                {" · "}
                <span className="text-warn" data-testid="reference-views-failed">
                  {failed} failed
                </span>
              </>
            ) : null}
            <span className="text-faint">
              {" "}
              ({Math.min(activeInProject, atOnce)} of {atOnce} slots busy in this project)
            </span>
          </p>
          {queued ? (
            <p className="text-[11px] text-muted">
              Waiting views start on their own as slots free up while this page is open, and are charged only
              when they start.{" "}
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => {
                  setWaiting(null);
                  setNote({
                    ok: true,
                    text: "The waiting views were cancelled. Nothing was charged for them.",
                  });
                }}
                data-testid="reference-views-cancel-waiting"
              >
                Cancel waiting
              </button>
            </p>
          ) : null}
        </div>
      ) : null}

      <ul className="space-y-1" data-testid="reference-plan-views">
        {views.map((v) => {
          const isWaiting = waitingIds.has(v.id) && v.state === "missing";
          const can = v.state === "missing" && v.costUsd != null && !isWaiting;
          const picked = can && !unpicked.has(v.id);
          return (
            <li
              key={v.id}
              data-testid="reference-view"
              data-view={v.id}
              data-state={isWaiting ? "waiting" : v.state}
              data-picked={picked ? "1" : "0"}
              data-failed={isWaiting || v.state !== "missing" || !v.failed ? "0" : "1"}
            >
              <label
                className={cn(
                  "flex items-center justify-between gap-2 rounded-[3px] border px-2 py-1",
                  can ? "cursor-pointer border-line hover:border-line2" : "border-line",
                  picked && "border-accent/60 bg-accent/5",
                  v.state === "making" && "border-accent/40",
                )}
              >
                <span className="flex items-center gap-2">
                  {can ? (
                    <input
                      type="checkbox"
                      checked={picked}
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
                  <span className="flex items-center gap-1 text-[11.5px] text-accent">
                    <span
                      className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
                      aria-hidden
                    />
                    being made…
                  </span>
                ) : v.state === "made" ? (
                  <Link href={studioHref} className="text-[11.5px] text-accent hover:underline">
                    made: add it to the set
                  </Link>
                ) : isWaiting ? (
                  <span className="text-[11.5px] text-muted">waiting for a free slot</span>
                ) : v.costUsd == null ? (
                  <span className="text-[11.5px] text-warn" title={v.problem ?? ""}>
                    {v.problem ?? "can't be made right now"}
                  </span>
                ) : (
                  <span className="text-[11.5px] text-muted" data-testid="reference-view-price-line">
                    {v.failed ? (
                      <span className="text-warn" title={v.failed} data-testid="reference-view-failed">
                        last try failed ·{" "}
                      </span>
                    ) : null}
                    <span data-testid="reference-view-price">{priceOf(v.costUsd)}</span>
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>

      {makeable.length > 0 ? (
        <div className="space-y-1">
          <Button
            type="button"
            variant="primary"
            disabled={chosen.length === 0 || sending}
            onClick={() =>
              void send(
                chosen.map((v) => ({ id: v.id, costUsd: v.costUsd! })),
                `${batchId}-${chosen.map((v) => v.id).join("-")}`.slice(0, 64),
                false,
              )
            }
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
            {chosen.length > Math.max(0, atOnce - activeInProject)
              ? ` This project makes ${atOnce} at a time: what doesn't fit waits and starts on its own as slots free up.`
              : ""}
          </p>
        </div>
      ) : views.every((v) => v.state === "in_set") ? (
        <p className="text-pass" data-testid="reference-plan-total">
          The set is complete.
        </p>
      ) : null}
      {note ? (
        <p
          className={cn("text-[11.5px]", note.ok ? "text-muted" : "text-fail")}
          role={note.ok ? "status" : "alert"}
          data-testid="reference-views-note"
        >
          {note.text}
        </p>
      ) : null}
    </div>
  );
}
