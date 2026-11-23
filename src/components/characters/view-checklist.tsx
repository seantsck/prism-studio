"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { RefreshWhileActive } from "@/components/images/refresh-while-active";
import { userPrice } from "@/domain/pricing/user-price";
import { makeReferenceViews } from "@/server/reference-view-actions";
import { addToReferenceSet } from "@/server/visual-bible-actions";
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
  /** its picture: the one in the set, or the newest finished take waiting to be added */
  pictureUrl?: string | null;
  /** the finished take waiting to be added ("made") */
  attemptId?: string | null;
}

/** An engine that can make the views ("provider/modelId"). */
export interface ViewEngine {
  value: string;
  label: string;
  paid: boolean;
  available: boolean;
  /** why it cannot be chosen (empty when available) */
  unavailable: string;
}

/** Views the creator confirmed that have not started yet: the project had no free slot for them. */
interface Waiting {
  batch: string;
  /** the engine they were confirmed with */
  model: string;
  items: { id: string; costUsd: number }[];
}

const storeKey = (characterId: string) => `prism-reference-views-waiting:${characterId}`;
function readWaiting(characterId: string): Waiting | null {
  try {
    const raw = sessionStorage.getItem(storeKey(characterId));
    const w = raw ? (JSON.parse(raw) as Waiting) : null;
    return w &&
      typeof w.batch === "string" &&
      typeof w.model === "string" &&
      Array.isArray(w.items) &&
      w.items.length
      ? w
      : null;
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
  engine,
  engines,
  suggestedEngine,
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
  /** the engine the prices are for ("provider/modelId") */
  engine: string;
  engines: ViewEngine[];
  suggestedEngine: string;
  modelLabel: string;
  batchId: string;
  atOnce: number;
  /** generations running in this project now (any subject), out of `atOnce` */
  activeInProject: number;
  studioHref: string;
}) {
  const [stored, setWaitingState] = useState<Waiting | null>(null);
  const setWaiting = useCallback(
    (w: Waiting | null) => {
      setWaitingState(w && w.items.length ? w : null);
      writeWaiting(characterId, w);
    },
    [characterId],
  );
  // what was waiting when the page was left (same tab), read after hydration: storage is not on the server
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setWaitingState(readWaiting(characterId)), [characterId]);
  // a view that started elsewhere (another tab, the Reference Studio) is no longer waiting
  const stillMakeable = new Set(
    views.filter((v) => v.state === "missing" || v.state === "made").map((v) => v.id),
  );
  const waitingLeft = stored?.items.filter((i) => stillMakeable.has(i.id)) ?? [];
  const waiting: Waiting | null = stored && waitingLeft.length ? { ...stored, items: waitingLeft } : null;

  const waitingIds = new Set(waiting?.items.map((i) => i.id) ?? []);
  // a missing view, or a made one to try again (another take; the first stays until one is added to the set)
  const makeable = views.filter(
    (v) => (v.state === "missing" || v.state === "made") && v.costUsd != null && !waitingIds.has(v.id),
  );
  // a missing view starts ticked, a made one unticked; what the creator changed stays as they left it
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const isPicked = (v: ChecklistView) => (v.state === "missing") !== toggled.has(v.id);
  const chosen = makeable.filter(isPicked);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const send = useCallback(
    async (items: { id: string; costUsd: number }[], batch: string, model: string, auto: boolean) => {
      setSending(true);
      try {
        const form = new FormData();
        form.set("projectSlug", slug);
        form.set("characterId", characterId);
        form.set("views", items.map((i) => i.id).join(","));
        form.set("batchId", batch);
        form.set("model", model);
        if (paid) form.set("confirmedTotalUsd", items.reduce((s, i) => s + i.costUsd, 0).toFixed(4));
        const res = await makeReferenceViews(form);
        if (res.ok) {
          const left = items.filter((i) => res.waiting.includes(i.id));
          setWaiting(left.length ? { batch, model, items: left } : null);
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

  // start what waits as soon as the project has a free slot (re-checked on every refresh, at most every few seconds)
  const lastTry = useRef(0);
  useEffect(() => {
    if (!waiting || sending || activeInProject >= atOnce) return;
    if (Date.now() - lastTry.current < 4000) return;
    lastTry.current = Date.now();
    void send(waiting.items, waiting.batch, waiting.model, true);
  }, [waiting, sending, activeInProject, atOnce, views, send]);

  const priceOf = (usd: number) => (paid ? `$${(userPrice(usd) ?? 0).toFixed(2)}` : "free");
  const sumPrice = (usds: number[]) =>
    Math.round(usds.reduce((s, u) => s + (userPrice(u) ?? 0), 0) * 100) / 100;
  const price = sumPrice(chosen.map((v) => v.costUsd!));
  const toggle = (id: string) =>
    setToggled((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const missingOnes = makeable.filter((v) => v.state === "missing");
  const all = missingOnes.length > 0 && missingOnes.every(isPicked);

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
        <div className="font-medium">4. Six views</div>
        {missingOnes.length > 1 ? (
          <button
            type="button"
            className="text-[11.5px] text-accent hover:underline"
            onClick={() =>
              // Select all ticks every missing view (a view already made is made again only when ticked by hand)
              setToggled(all ? new Set(missingOnes.map((v) => v.id)) : new Set())
            }
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

      <EnginePicker engine={engine} engines={engines} suggested={suggestedEngine} />

      <ul className="space-y-1" data-testid="reference-plan-views">
        {views.map((v) => {
          const isWaiting = waitingIds.has(v.id) && (v.state === "missing" || v.state === "made");
          const can = (v.state === "missing" || v.state === "made") && v.costUsd != null && !isWaiting;
          const picked = can && isPicked(v);
          return (
            <li
              key={v.id}
              data-testid="reference-view"
              data-view={v.id}
              data-state={isWaiting ? "waiting" : v.state}
              data-picked={picked ? "1" : "0"}
              data-failed={isWaiting || v.state !== "missing" || !v.failed ? "0" : "1"}
            >
              <div
                className={cn(
                  "flex items-center justify-between gap-2 rounded-[3px] border px-2 py-1",
                  can ? "border-line hover:border-line2" : "border-line",
                  picked && "border-accent/60 bg-accent/5",
                  v.state === "making" && "border-accent/40",
                )}
              >
                <label className={cn("flex min-w-0 items-center gap-2", can && "cursor-pointer")}>
                  {can ? (
                    <input
                      type="checkbox"
                      checked={picked}
                      onChange={() => toggle(v.id)}
                      aria-label={v.state === "made" ? `Make the ${v.label.toLowerCase()} again` : v.label}
                      data-testid="reference-view-pick"
                    />
                  ) : null}
                  {v.pictureUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={v.pictureUrl}
                      alt={`${v.label}${v.state === "in_set" ? " in the set" : ", made"}`}
                      className="h-10 w-8 shrink-0 rounded-[2px] border border-line object-cover"
                      data-testid="reference-view-picture"
                    />
                  ) : null}
                  <span className={v.state === "in_set" ? "text-pass" : ""}>
                    {v.state === "in_set" ? "✓ " : ""}
                    {v.label}
                  </span>
                </label>
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
                ) : v.state === "made" && !isWaiting ? (
                  <span className="flex items-center gap-2">
                    {v.costUsd != null && picked ? (
                      <span className="text-[11.5px] text-muted" data-testid="reference-view-price">
                        again: {priceOf(v.costUsd)}
                      </span>
                    ) : null}
                    {v.attemptId ? (
                      <ActionForm
                        action={addToReferenceSet}
                        successMessage=""
                        quiet
                        className="inline"
                        data-testid="reference-view-add"
                      >
                        <input type="hidden" name="projectSlug" value={slug} />
                        <input type="hidden" name="characterId" value={characterId} />
                        <input type="hidden" name="attemptId" value={v.attemptId} />
                        <input type="hidden" name="view" value={v.id} />
                        <Button type="submit" size="sm" data-testid="reference-view-add-button">
                          Add to the set
                        </Button>
                      </ActionForm>
                    ) : (
                      <Link href={studioHref} className="text-[11.5px] text-accent hover:underline">
                        made: add it to the set
                      </Link>
                    )}
                  </span>
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
              </div>
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
                engine,
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

/**
 * The engine the views are made with. Changing it re-reads the page with the new engine's exact prices (`?engine=`);
 * nothing starts until the creator presses Make.
 */
function EnginePicker({
  engine,
  engines,
  suggested,
}: {
  engine: string;
  engines: ViewEngine[];
  suggested: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // the engine just picked, until the page comes back priced for it
  const [pending, setPending] = useState<string | null>(null);
  const picking = pending && pending !== engine ? pending : null;
  if (engines.length === 0) return null;
  return (
    <label className="flex flex-wrap items-center gap-2 text-[11.5px]">
      <span className="text-muted">Engine</span>
      <select
        value={picking ?? engine}
        onChange={(e) => {
          const next = new URLSearchParams(params.toString());
          next.set("engine", e.target.value);
          next.delete("new");
          setPending(e.target.value);
          router.replace(`${pathname}?${next.toString()}#reference-views`, { scroll: false });
        }}
        className="h-7 text-[12px]"
        style={{ width: "auto", maxWidth: "20rem" }}
        aria-label="Engine for the views"
        data-testid="reference-views-engine"
      >
        {engines.map((e) => (
          <option key={e.value} value={e.value} disabled={!e.available}>
            {e.label}
            {e.value === suggested ? " (suggested)" : ""}
            {!e.available ? ` (${e.unavailable})` : e.paid ? "" : " (free)"}
          </option>
        ))}
      </select>
      {picking ? <span className="text-muted">pricing…</span> : null}
    </label>
  );
}
