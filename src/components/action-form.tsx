"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  type FormHTMLAttributes,
  type ReactNode,
} from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import type { ActionResult } from "@/server/action-result";
import { cn } from "@/lib/utils";
import { actionStatusVisible } from "./action-form-status";

type ServerAction = (form: FormData) => Promise<ActionResult>;

interface ActionFormProps extends Omit<FormHTMLAttributes<HTMLFormElement>, "action" | "onSubmit"> {
  action: ServerAction;
  children: ReactNode;
  /** Text shown briefly after success. Pass "" to stay silent. */
  successMessage?: string;
  /** Clear the inputs after a successful submit (e.g. "add take"). */
  resetOnSuccess?: boolean;
  /** Hide the "Saving…" / "Saved" status line (the surrounding UI already shows the state). A failure is always shown. */
  quiet?: boolean;
  /** Ask the user to confirm first (destructive actions). */
  confirmMessage?: string;
}

/**
 * <form> for server actions with consistent feedback:
 *   - controls are disabled while the request is in flight (no double submits),
 *   - "Saving…" while pending, "Saved" after success (aria-live),
 *   - expected failures (validation, locked entity, asset in use…) render inline instead of an error page.
 * The browser never sees stack traces or SQL: the server returns a sanitised message.
 */
export function ActionForm({
  action,
  children,
  successMessage = "Saved",
  resetOnSuccess = false,
  quiet = false,
  confirmMessage,
  className,
  ...rest
}: ActionFormProps) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    async (_prev, form) => action(form),
    null,
  );
  const ref = useRef<HTMLFormElement>(null);
  // The "Saved" note is visible until this particular result is dismissed by the timer below.
  const [dismissed, setDismissed] = useState<ActionResult | null>(null);
  const showSaved = state?.ok === true && dismissed !== state;

  useEffect(() => {
    if (state?.ok !== true) return;
    if (resetOnSuccess) ref.current?.reset();
    const t = setTimeout(() => setDismissed(state), 2200);
    return () => clearTimeout(t);
  }, [state, resetOnSuccess]);

  return (
    <form
      ref={ref}
      className={className}
      // Submitted manually (not via <form action>) so React does not auto-reset the inputs when the
      // action returns a validation error: the user keeps what they typed.
      onSubmit={(e) => {
        e.preventDefault();
        if (confirmMessage && !window.confirm(confirmMessage)) return;
        const data = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
        startTransition(() => formAction(data));
      }}
      aria-busy={pending}
      {...rest}
    >
      <fieldset disabled={pending} className={cn("contents")}>
        {children}
      </fieldset>
      {actionStatusVisible({ quiet, pending, state, showSaved }) ? (
        <div
          className="mt-1.5 min-h-4 text-[11px]"
          aria-live="polite"
          role={state && !state.ok ? "alert" : undefined}
        >
          {pending ? (
            <span className="inline-flex items-center gap-1 text-muted">
              <Loader2 className="h-3 w-3 animate-spin" /> Saving…
            </span>
          ) : state && !state.ok ? (
            <span className="inline-flex items-start gap-1 text-fail">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              <span>
                {state.error}
                {state.fieldErrors
                  ? Object.entries(state.fieldErrors).map(([k, v]) => (
                      <span key={k} className="block text-[10.5px] text-fail/80">
                        {k === "_" ? v : `${k}: ${v}`}
                      </span>
                    ))
                  : null}
              </span>
            </span>
          ) : showSaved && successMessage ? (
            <span className="inline-flex items-center gap-1 text-pass">
              <Check className="h-3 w-3" /> {successMessage}
            </span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
