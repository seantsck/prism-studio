"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { RefreshWhileActive } from "@/components/images/refresh-while-active";
import { userPrice } from "@/domain/pricing/user-price";
import { makeReferenceViews, stopReferenceViews } from "@/server/reference-view-actions";
import { addToReferenceSet, addViewsToReferenceSet } from "@/server/visual-bible-actions";
import { UseAsFront, ViewLock } from "./picture-actions";
import { ZoomImage } from "@/components/zoom-image";
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
  /** the picture shown (in the set, or the made take) */
  pictureAssetId?: string | null;
  /** a newer take of a view already in the set, to use instead of the picture in it */
  newer?: { attemptId: string; url: string | null } | null;
  /** every finished take of this view other than the picture in it: the options to choose from */
  takes?: Array<{ attemptId: string; url: string | null; engine: string }>;
  /** its picture is locked in place: not made again, not replaced */
  locked?: boolean;
  /** its generations still running (to stop them) */
  jobIds?: string[];
  /** its newest try (any state): what the run tracker follows */
  latestAttemptId?: string | null;
}

/** One press of Make: the views it covers, and each one's newest try before it (a new try is this run's). */
interface Run {
  ids: string[];
  before: Record<string, string | null>;
}
const runKey = (characterId: string) => `prism-reference-views-run:${characterId}`;

/** "Front" → "front view", "3/4 view" → "3/4 view", "Left profile" → "left profile view". */
const viewName = (label: string) => {
  const l = label.toLowerCase();
  return l.endsWith("view") ? l : `${l} view`;
};

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
  /** they wait for this new front view and are made from it */
  afterFront?: string;
  /** the right profile waits for this left profile and mirrors it */
  afterLeft?: string;
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
  // the run being followed (kept for this tab, so a refresh or a visit elsewhere does not lose it)
  const [run, setRunState] = useState<Run | null>(null);
  const setRun = useCallback(
    (r: Run | null) => {
      setRunState(r);
      try {
        if (r) sessionStorage.setItem(runKey(characterId), JSON.stringify(r));
        else sessionStorage.removeItem(runKey(characterId));
      } catch {
        /* storage unavailable: the run lives only in this page */
      }
    },
    [characterId],
  );
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(runKey(characterId));
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setRunState(JSON.parse(raw) as Run);
    } catch {
      /* nothing to restore */
    }
  }, [characterId]);
  // a view that started elsewhere (another tab, the Reference Studio) is no longer waiting
  const stillMakeable = new Set(
    views.filter((v) => v.state === "missing" || v.state === "made" || v.state === "in_set").map((v) => v.id),
  );
  const waitingLeft = stored?.items.filter((i) => stillMakeable.has(i.id)) ?? [];
  const waiting: Waiting | null = stored && waitingLeft.length ? { ...stored, items: waitingLeft } : null;

  const waitingIds = new Set(waiting?.items.map((i) => i.id) ?? []);
  // a missing view, or a made one to try again (another take; the first stays until one is added to the set)
  const makeable = views.filter(
    (v) =>
      (v.state === "missing" || v.state === "made" || v.state === "in_set") &&
      v.costUsd != null &&
      !v.locked &&
      !waitingIds.has(v.id),
  );
  // a missing view starts ticked, a made one unticked; what the creator changed stays as they left it
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const isPicked = (v: ChecklistView) => (v.state === "missing") !== toggled.has(v.id);
  const chosen = makeable.filter(isPicked);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const send = useCallback(
    async (
      items: { id: string; costUsd: number }[],
      batch: string,
      model: string,
      auto: boolean,
      afterFront?: string,
      afterLeft?: string,
    ) => {
      setSending(true);
      try {
        const form = new FormData();
        form.set("projectSlug", slug);
        form.set("characterId", characterId);
        form.set("views", items.map((i) => i.id).join(","));
        form.set("batchId", batch);
        form.set("model", model);
        if (afterFront) form.set("fromFront", afterFront);
        if (afterLeft) form.set("fromLeft", afterLeft);
        if (paid) form.set("confirmedTotalUsd", items.reduce((s, i) => s + i.costUsd, 0).toFixed(4));
        const res = await makeReferenceViews(form);
        if (res.ok) {
          const left = items.filter((i) => res.waiting.includes(i.id));
          setWaiting(
            left.length
              ? {
                  batch,
                  model,
                  items: left,
                  afterFront: res.afterFront ?? afterFront,
                  afterLeft: res.afterLeft ?? afterLeft,
                }
              : null,
          );
          if (!auto || res.started.length) setNote({ ok: true, text: res.message });
          // a new press starts a new run to follow, view by view, until the last one is finished
          if (!auto && (res.started.length || res.waiting.length))
            setRun({
              ids: items.map((i) => i.id),
              before: Object.fromEntries(
                items.map((i) => [i.id, views.find((v) => v.id === i.id)?.latestAttemptId ?? null]),
              ),
            });
          // what was sent is no longer ticked (a view made again is not made a third time by the next press)
          if (!auto)
            setToggled((t) => {
              const next = new Set(t);
              for (const i of items) next.delete(i.id);
              return next;
            });
        } else {
          setWaiting(null);
          setRun(null);
          setNote({ ok: false, text: res.error });
        }
      } catch {
        // a network blip: the waiting views stay, and the next refresh tries again
        if (!auto) setNote({ ok: false, text: "The request did not go through. Try again." });
      } finally {
        setSending(false);
      }
    },
    [slug, characterId, paid, setWaiting, setRun, views],
  );

  // start what waits as soon as the project has a free slot (re-checked on every refresh, at most every few seconds)
  const lastTry = useRef(0);
  useEffect(() => {
    if (!waiting || sending || activeInProject >= atOnce) return;
    if (Date.now() - lastTry.current < 4000) return;
    lastTry.current = Date.now();
    void send(waiting.items, waiting.batch, waiting.model, true, waiting.afterFront, waiting.afterLeft);
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

  // finished views not yet in the set, each with the take to add
  const madeToAdd = views.filter((v) => v.state === "made" && v.attemptId && !waitingIds.has(v.id));
  const stateOf = (id: string) => views.find((x) => x.id === id)?.state;
  const count = (s: ViewState) => views.filter((v) => v.state === s).length;
  const done = count("in_set") + count("made");
  const making = count("making");
  const queued = waiting?.items.length ?? 0;
  const failed = views.filter((v) => v.state === "missing" && v.failed && !waitingIds.has(v.id)).length;
  const busy = making > 0 || queued > 0;
  // the run: each of its views is waiting, being made, or finished (a new try that is no longer being made)
  const runViews = run
    ? run.ids.map((id) => {
        const v = views.find((x) => x.id === id);
        const fresh = !!v?.latestAttemptId && v.latestAttemptId !== run.before[id];
        const status = waitingIds.has(id)
          ? ("waiting" as const)
          : !fresh || v?.state === "making"
            ? ("making" as const)
            : v?.state === "missing"
              ? ("failed" as const)
              : ("finished" as const);
        return { id, label: v?.label ?? id, status };
      })
    : [];
  const runFinished = runViews.filter((r) => r.status === "finished" || r.status === "failed").length;
  const runFailed = runViews.filter((r) => r.status === "failed").length;
  const runDone = !!run && runFinished === runViews.length;

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

      {run ? (
        <div
          className={cn(
            "space-y-1.5 rounded-[3px] border p-2",
            runDone ? "border-pass/40 bg-pass/5" : "border-accent/40 bg-accent/5",
          )}
          data-testid="reference-views-run"
          data-done={runDone ? "1" : "0"}
          aria-live="polite"
        >
          <div className="flex items-baseline justify-between gap-2 text-[12px]">
            <span className="font-medium" data-testid="reference-views-run-status">
              {runDone
                ? runFailed
                  ? `Finished: ${runFinished - runFailed} of ${runViews.length} made, ${runFailed} did not finish`
                  : `All ${runViews.length} finished`
                : `Making ${runViews.length === 1 ? "1 view" : `${runViews.length} views`}: ${runFinished} of ${runViews.length} finished`}
            </span>
            {runDone ? (
              <button
                type="button"
                className="text-[11px] text-accent hover:underline"
                onClick={() => setRun(null)}
                data-testid="reference-views-run-dismiss"
              >
                Dismiss
              </button>
            ) : null}
          </div>
          <div className="flex h-2 overflow-hidden rounded-full bg-line" aria-hidden>
            <div
              className={runDone ? "bg-pass" : "bg-pass transition-all"}
              style={{ width: `${(runFinished / Math.max(1, runViews.length)) * 100}%` }}
            />
            {runDone ? null : <div className="flex-1 animate-pulse bg-accent/30" />}
          </div>
          <ol className="flex flex-wrap gap-1 text-[11px]">
            {runViews.map((r) => (
              <li
                key={r.id}
                className={cn(
                  "rounded-[3px] border px-1.5 py-0.5",
                  r.status === "finished"
                    ? "border-pass/40 text-pass"
                    : r.status === "failed"
                      ? "border-warn/40 text-warn"
                      : r.status === "making"
                        ? "border-accent/50 text-accent"
                        : "border-line text-muted",
                )}
                data-testid="reference-views-run-view"
                data-status={r.status}
              >
                {r.status === "finished"
                  ? "✓ "
                  : r.status === "failed"
                    ? "✕ "
                    : r.status === "making"
                      ? "● "
                      : "… "}
                {r.label}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {busy || done > 0 || failed > 0 ? (
        <div className="space-y-1" data-testid="reference-views-progress" aria-live="polite">
          {run ? null : (
            <div className="flex h-1.5 overflow-hidden rounded-full bg-line" aria-hidden>
              <div className="bg-pass" style={{ width: `${(done / views.length) * 100}%` }} />
              <div
                className="animate-pulse bg-accent"
                style={{ width: `${(making / views.length) * 100}%` }}
              />
              <div className="bg-accent/30" style={{ width: `${(queued / views.length) * 100}%` }} />
            </div>
          )}
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
                  setRun(null);
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

      {busy ? (
        <ActionForm
          action={stopReferenceViews}
          successMessage=""
          className="flex flex-wrap items-center gap-2"
          confirmMessage={`Stop making ${making + queued === 1 ? "this view" : `these ${making + queued} views`}? Views waiting their turn are not started or charged. A view the engine has already started may still be charged by it.`}
          onResult={(r) => {
            if (r.ok) {
              setWaiting(null);
              setRun(null);
              setNote({ ok: true, text: r.message ?? "Stopped." });
            }
          }}
          data-testid="reference-views-stop"
        >
          <input type="hidden" name="projectSlug" value={slug} />
          <input type="hidden" name="characterId" value={characterId} />
          {views.flatMap((v) =>
            (v.jobIds ?? []).map((j) => <input key={j} type="hidden" name="jobId" value={j} />),
          )}
          <Button type="submit" size="sm" data-testid="reference-views-stop-button">
            ■ Stop
          </Button>
          <span className="text-[11px] text-muted">
            New views can be made once these finish or are stopped.
          </span>
        </ActionForm>
      ) : null}

      <EnginePicker engine={engine} engines={engines} suggested={suggestedEngine} />

      {madeToAdd.length > 1 ? (
        <ActionForm
          action={addViewsToReferenceSet}
          successMessage=""
          className="flex flex-wrap items-center gap-2"
          data-testid="reference-views-add-all"
        >
          <input type="hidden" name="projectSlug" value={slug} />
          <input type="hidden" name="characterId" value={characterId} />
          {madeToAdd.map((v) => (
            <input key={v.id} type="hidden" name="viewTake" value={`${v.id}:${v.attemptId}`} />
          ))}
          <Button type="submit" variant="primary" size="sm" data-testid="reference-views-add-all-button">
            Add all {madeToAdd.length} made views to the set
          </Button>
          <span className="text-[11px] text-muted">They fill in the Visual Bible below.</span>
        </ActionForm>
      ) : null}

      <ul className="space-y-1" data-testid="reference-plan-views">
        {views.map((v) => {
          const isWaiting =
            waitingIds.has(v.id) && (v.state === "missing" || v.state === "made" || v.state === "in_set");
          const can =
            (v.state === "missing" || v.state === "made" || v.state === "in_set") &&
            v.costUsd != null &&
            !v.locked &&
            !busy &&
            !isWaiting;
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
                      aria-label={v.state === "missing" ? v.label : `Make the ${v.label.toLowerCase()} again`}
                      data-testid="reference-view-pick"
                    />
                  ) : null}
                  {v.pictureUrl ? (
                    <span data-testid="reference-view-picture-wrap">
                      <ZoomImage
                        src={v.pictureUrl}
                        alt={`${v.label}${v.state === "in_set" ? " in the set" : ", made"}`}
                        className="h-10 w-8 shrink-0 rounded-[2px] border border-line object-cover"
                        caption={`${v.label}${v.state === "in_set" ? (v.locked ? " · locked in the set" : " · in the set") : " · made"}`}
                        testId="reference-view-picture"
                      >
                        {v.state === "in_set" ? (
                          <ViewLock slug={slug} characterId={characterId} view={v.id} locked={!!v.locked} />
                        ) : null}
                        {v.pictureAssetId || v.attemptId ? (
                          <UseAsFront
                            slug={slug}
                            characterId={characterId}
                            assetId={v.pictureAssetId}
                            attemptId={v.state === "made" ? v.attemptId : null}
                            isFront={v.id === "front" && v.state === "in_set"}
                          />
                        ) : null}
                      </ZoomImage>
                    </span>
                  ) : null}
                  <span className={v.state === "in_set" ? "text-pass" : ""}>
                    {v.state === "in_set" ? "✓ " : ""}
                    {v.label}
                  </span>
                </label>
                {v.state === "in_set" && !isWaiting ? (
                  <span className="flex items-center gap-2">
                    {v.costUsd != null && picked ? (
                      <span className="text-[11.5px] text-muted" data-testid="reference-view-price">
                        again: {priceOf(v.costUsd)}
                      </span>
                    ) : null}
                    {v.newer && !v.locked ? (
                      <ActionForm
                        action={addToReferenceSet}
                        successMessage=""
                        quiet
                        className="flex items-center gap-1.5"
                        confirmMessage={`Use the new take as the ${v.label.toLowerCase()}? The one in the set now stays in your pictures.`}
                        data-testid="reference-view-use-newer"
                      >
                        {v.newer.url ? (
                          <ZoomImage
                            src={v.newer.url}
                            alt={`New take: ${v.label}`}
                            className="h-10 w-8 rounded-[2px] border border-accent/60 object-cover"
                            caption={`${v.label} · the new take (use it with the button beside it)`}
                          />
                        ) : null}
                        <input type="hidden" name="projectSlug" value={slug} />
                        <input type="hidden" name="characterId" value={characterId} />
                        <input type="hidden" name="attemptId" value={v.newer.attemptId} />
                        <input type="hidden" name="view" value={v.id} />
                        <input type="hidden" name="confirmReplace" value="1" />
                        <Button type="submit" size="sm" data-testid="reference-view-use-newer-button">
                          Use the new take
                        </Button>
                      </ActionForm>
                    ) : (
                      <span className="text-[11.5px] text-faint">
                        {v.locked ? "locked in the set" : "in the set"}
                      </span>
                    )}
                    <ViewLock slug={slug} characterId={characterId} view={v.id} locked={!!v.locked} />
                  </span>
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
                  <span className="text-[11.5px] text-muted">
                    {v.id === "right_profile" && waiting?.afterLeft && stateOf("profile") === "making"
                      ? "waiting for the left profile"
                      : waiting?.afterFront && stateOf("front") === "making"
                        ? "waiting for the front view"
                        : "waiting for a free slot"}
                  </span>
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
              {!v.locked && (v.state === "in_set" || v.state === "made") && (v.takes?.length ?? 0) > 0 ? (
                <div
                  className="mt-1 flex flex-wrap items-center gap-1.5 pl-2 text-[11px] text-muted"
                  data-testid="reference-view-takes"
                >
                  <span>Other takes:</span>
                  {v
                    .takes!.filter((t) => t.attemptId !== v.attemptId)
                    .slice(0, 8)
                    .map((t) => {
                      const use = (
                        <ActionForm
                          action={addToReferenceSet}
                          successMessage=""
                          quiet
                          className="inline"
                          confirmMessage={`Use this take (${t.engine}) as the ${v.label.toLowerCase()}? The one in the set now stays in your pictures.`}
                        >
                          <input type="hidden" name="projectSlug" value={slug} />
                          <input type="hidden" name="characterId" value={characterId} />
                          <input type="hidden" name="attemptId" value={t.attemptId} />
                          <input type="hidden" name="view" value={v.id} />
                          <input type="hidden" name="confirmReplace" value="1" />
                          <Button
                            type="submit"
                            size="sm"
                            variant="primary"
                            data-testid="reference-view-take-use"
                          >
                            Use as the {v.label.toLowerCase()}
                          </Button>
                        </ActionForm>
                      );
                      return (
                        <span key={t.attemptId} data-testid="reference-view-take" className="inline-block">
                          {t.url ? (
                            <ZoomImage
                              src={t.url}
                              alt={`${v.label}, ${t.engine}`}
                              className="h-10 w-8 rounded-[2px] border border-line object-cover hover:border-accent"
                              caption={`${v.label} · another take (${t.engine})`}
                            >
                              {use}
                            </ZoomImage>
                          ) : (
                            use
                          )}
                        </span>
                      );
                    })}
                  <span className="text-faint">click one to see it large and use it</span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {makeable.length > 0 ? (
        <div className="space-y-1">
          <Button
            type="button"
            variant="primary"
            disabled={chosen.length === 0 || sending || busy}
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
            {busy
              ? `Making ${making + queued === 1 ? "1 view" : `${making + queued} views`}…`
              : chosen.length === 0
                ? views.every((v) => v.state === "in_set")
                  ? "Tick a view to make it again"
                  : "Tick the views to make"
                : `Make ${chosen.length === 1 ? `the ${viewName(chosen[0]!.label)}` : `${chosen.length} views`} · ${paid ? `$${price.toFixed(2)}` : "free"}`}
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
      ) : null}
      {views.every((v) => v.state === "in_set") ? (
        <p className="text-pass" data-testid="reference-plan-total">
          The set is complete. Tick a view to make it again; the new take is offered beside it.
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
    <label className="flex items-center gap-2 text-[11.5px]">
      <span className="shrink-0 text-muted">Engine</span>
      <select
        value={picking ?? engine}
        onChange={(e) => {
          const next = new URLSearchParams(params.toString());
          next.set("engine", e.target.value);
          next.delete("new");
          setPending(e.target.value);
          router.replace(`${pathname}?${next.toString()}#reference-views`, { scroll: false });
        }}
        className="min-w-0 flex-1 text-[12px]"
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
