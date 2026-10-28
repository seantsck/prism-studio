"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ReconcileResult } from "@/domain/continuity/automation";
import { reconcileAttemptQaAction } from "@/server/media-actions";

/**
 * Phase 3A.2 trigger. The server-rendered page decided (from reads only) that automatic QA is due for this attempt's
 * current truth; this asks the explicit, idempotent reconciliation ONCE per truth (`dueKey`) and refreshes when
 * something was created. Duplicate observations (two tabs, re-renders) are harmless: the server dedupes atomically.
 * It is "eventually automatic": if nobody has Prism open when a generation finishes, the next visit does it.
 */
export function AutoQaReconciler({
  projectSlug,
  attemptId,
  dueKey,
}: {
  projectSlug: string;
  attemptId: string;
  dueKey: string | null;
}) {
  const router = useRouter();
  const fired = useRef<string | null>(null);
  const [done, setDone] = useState<{ key: string; result: ReconcileResult } | null>(null);

  useEffect(() => {
    if (!dueKey || fired.current === dueKey) return;
    fired.current = dueKey;
    const form = new FormData();
    form.set("projectSlug", projectSlug);
    form.set("attemptId", attemptId);
    reconcileAttemptQaAction(form)
      .then((result) => {
        setDone({ key: dueKey, result });
        if (result.outcomes.some((o) => o === "deterministic_created" || o === "semantic_queued"))
          router.refresh();
      })
      .catch(() =>
        setDone({
          key: dueKey,
          result: {
            outcomes: ["failed"],
            reasons: ["Automatic QA could not run: the request did not reach the server."],
            runId: null,
            jobId: null,
          },
        }),
      );
  }, [dueKey, projectSlug, attemptId, router]);

  const pending = dueKey !== null && done?.key !== dueKey;
  const result = done?.result ?? null;
  const failed = result?.outcomes.includes("failed");
  const blocked = result?.outcomes.includes("semantic_blocked");
  if (!pending && !failed && !blocked) return null;
  return (
    <div className="text-[11px]" aria-live="polite" data-testid="auto-qa-reconcile">
      {pending ? <span className="text-muted">Running automatic QA…</span> : null}
      {!pending && failed ? (
        <span className="text-warn" data-testid="auto-qa-failed">
          {result!.reasons.at(-1)}
        </span>
      ) : null}
      {!pending && blocked && !failed ? (
        <span className="text-warn" data-testid="auto-qa-blocked">
          Semantic auto-analysis blocked — {result!.reasons.join(" ")}
        </span>
      ) : null}
    </div>
  );
}
