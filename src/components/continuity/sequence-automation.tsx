"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { SequenceReconcileResult } from "@/domain/continuity/sequence-automation";
import { createSequenceStatusPoller } from "@/domain/continuity/sequence-status";
import { reconcileSequenceQaAction } from "@/server/sequence-review-actions";

/**
 * Phase 3A.4F trigger. The server-rendered Supervisor decided (from reads only) that a wave is due; this asks the
 * explicit, idempotent reconciliation ONCE per `dueKey` and refreshes. The server re-reads everything first. There is no
 * settling timer: a cut that is still settling is picked up by a later visit or refresh.
 */
export function SequenceAutoReconciler({
  projectSlug,
  episodeId,
  dueKey,
}: {
  projectSlug: string;
  episodeId: string;
  dueKey: string | null;
}) {
  const router = useRouter();
  const fired = useRef<string | null>(null);
  const [done, setDone] = useState<{ key: string; result: SequenceReconcileResult } | null>(null);

  useEffect(() => {
    if (!dueKey || fired.current === dueKey) return;
    fired.current = dueKey;
    const form = new FormData();
    form.set("projectSlug", projectSlug);
    form.set("episodeId", episodeId);
    reconcileSequenceQaAction(form)
      .then((result) => {
        setDone({ key: dueKey, result });
        if (result.outcome === "queued" || result.outcome === "already_queued") router.refresh();
      })
      .catch(() =>
        setDone({
          key: dueKey,
          result: {
            outcome: "failed",
            reasons: ["Automatic Sequence QA could not run: the request did not reach the server."],
            totalCuts: 0,
            dueCuts: 0,
            settlingCuts: 0,
            blockedCuts: 0,
            queued: 0,
            remainingDue: 0,
            jobIds: [],
          },
        }),
      );
  }, [dueKey, projectSlug, episodeId, router]);

  const pending = dueKey !== null && done?.key !== dueKey;
  const result = done?.result ?? null;
  const problem = result && !["queued", "already_queued", "nothing_due", "settling"].includes(result.outcome);
  if (!pending && !problem) return null;
  return (
    <div className="text-[11px]" aria-live="polite" data-testid="sequence-auto-reconcile">
      {pending ? <span className="text-muted">Queuing due cuts…</span> : null}
      {!pending && problem ? (
        <span className="text-warn" data-testid="sequence-auto-problem" data-outcome={result.outcome}>
          {result.reasons.join(" ") || `Automatic Sequence QA: ${result.outcome}.`}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Refreshes the Supervisor when this edit's jobs or the Project's shared capacity change. It reads Prism's own job state
 * through a narrow owner-only endpoint and only ever refreshes: the server re-reads everything, and the reconciler above
 * stays the only thing that asks for a wave. `poll` is false while merely settling, so no timer exists then.
 */
export function SequenceJobPoller({
  projectSlug,
  editId,
  initialSignature,
  poll,
}: {
  projectSlug: string;
  editId: string;
  /** the status the server rendered: a job that finished before the first poll is noticed on that first response */
  initialSignature: string;
  poll: boolean;
}) {
  const router = useRouter();
  const poller = useRef<ReturnType<typeof createSequenceStatusPoller> | null>(null);

  useEffect(() => {
    if (!poll) return;
    const url = `/api/projects/${projectSlug}/continuity/sequence-status?edit=${editId}`;
    const p = createSequenceStatusPoller({
      initialSignature,
      fetchSignature: async () => {
        const r = await fetch(url, { cache: "no-store" });
        return r.ok ? ((await r.json()) as { signature: string }).signature : null;
      },
      refresh: () => router.refresh(),
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (h) => window.clearInterval(h),
    });
    poller.current = p;
    return () => {
      poller.current = null;
      p.stop();
    };
    // a new render's signature updates the running poller below; it must not restart the timer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll, projectSlug, editId, router]);

  useEffect(() => poller.current?.rendered(initialSignature), [initialSignature]);

  return null;
}
