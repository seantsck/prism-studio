"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { SequenceReconcileResult } from "@/domain/continuity/sequence-automation";
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

const POLL_MS = 3000;

/**
 * Refreshes the Supervisor while this edit's transition jobs are active: Prism's own job state only, through a narrow
 * owner-only endpoint. It polls only with active jobs, so merely settling cuts start no timer and spend nothing.
 */
export function SequenceJobPoller({
  projectSlug,
  editId,
  active,
}: {
  projectSlug: string;
  editId: string;
  active: number;
}) {
  const router = useRouter();
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (active <= 0) return;
    let stopped = false;
    const url = `/api/projects/${projectSlug}/continuity/sequence-status?edit=${editId}`;
    const timer = setInterval(() => {
      void fetch(url, { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ signature: string }>) : null))
        .then((body) => {
          if (stopped || !body) return;
          if (last.current !== null && last.current !== body.signature) router.refresh();
          last.current = body.signature;
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, projectSlug, editId, router]);

  return null;
}
