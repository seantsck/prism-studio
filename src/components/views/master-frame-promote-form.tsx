"use client";

import { startTransition, useActionState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import type { ActionConfirmation, ActionResult } from "@/server/action-result";
import { promoteMasterFrame } from "@/server/production-frame-actions";

/**
 * "Use 3D Master Frame" with the Phase 4C confirmation contract. A fresh frame promotes at once. A stale or
 * unknown-provenance frame comes back as a typed confirmation (nothing created or selected); "Use anyway" resubmits
 * with the digest of exactly what was shown. If the 3D setup changed meanwhile, the server refuses that digest and
 * returns the current state, which is shown for a new decision. The browser never sends its own stale / unknown view.
 */
export function MasterFramePromoteForm({
  slug,
  shotId,
  masterFrameId,
  disabled,
  children,
}: {
  slug: string;
  shotId: string;
  masterFrameId: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const [state, run, pending] = useActionState<ActionResult | null, FormData>(
    async (_prev, form) => promoteMasterFrame(form),
    null,
  );
  const confirmation: ActionConfirmation | null =
    state && !state.ok && state.confirmationRequired && state.confirmation ? state.confirmation : null;

  const submit = (digest: string | null) => {
    const fd = new FormData();
    fd.set("projectSlug", slug);
    fd.set("shotId", shotId);
    fd.set("masterFrameId", masterFrameId);
    if (digest) fd.set("confirmDigest", digest);
    startTransition(() => run(fd));
  };

  return (
    <div
      className="border border-line px-2.5 py-1.5"
      data-testid={`pf-master-row-${masterFrameId}`}
      aria-busy={pending}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px]">{children}</span>
        <Button
          data-testid={`pf-use-master-${masterFrameId}`}
          size="sm"
          type="button"
          disabled={disabled || pending}
          onClick={() => submit(null)}
        >
          Use 3D Master Frame
        </Button>
      </div>
      {confirmation ? (
        <div
          className="mt-1.5 space-y-1 text-[11px]"
          data-testid={`pf-master-confirm-${masterFrameId}`}
          role="alert"
        >
          <div className="text-warn">{state && !state.ok ? state.error : null}</div>
          {confirmation.messages.map((m) => (
            <div key={m} className="text-warn" data-testid="pf-master-confirm-reason">
              {m}
            </div>
          ))}
          <Button
            data-testid={`pf-use-master-anyway-${masterFrameId}`}
            size="sm"
            type="button"
            disabled={pending}
            onClick={() => submit(confirmation.digest)}
          >
            Use anyway
          </Button>
        </div>
      ) : null}
      <div className="mt-1 min-h-4 text-[11px]" aria-live="polite">
        {pending ? (
          <span className="inline-flex items-center gap-1 text-muted">
            <Loader2 className="h-3 w-3 animate-spin" /> Saving…
          </span>
        ) : state && state.ok ? (
          <span className="inline-flex items-center gap-1 text-pass" data-testid="pf-master-promoted">
            <Check className="h-3 w-3" /> {state.message ?? "Production Frame saved"}
          </span>
        ) : state && !state.ok && !confirmation ? (
          <span className="inline-flex items-start gap-1 text-fail" role="alert">
            <AlertTriangle className="mt-px h-3 w-3 shrink-0" /> {state.error}
          </span>
        ) : null}
      </div>
    </div>
  );
}
