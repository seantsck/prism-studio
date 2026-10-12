"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { updatePassword, type UpdatePasswordState } from "@/server/auth-actions";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/password-policy";
import { primaryButton } from "./auth-shell";

export function UpdatePasswordForm() {
  const [state, action, pending] = useActionState<UpdatePasswordState, FormData>(updatePassword, {
    error: null,
  });

  if (state.needsNewLink) {
    return (
      <div className="border border-line bg-panel p-4">
        <p role="alert" className="text-[12.5px] text-fail">
          {state.error}
        </p>
        <Link
          href="/forgot-password"
          className="mt-3 inline-block text-[12px] text-accent underline-offset-2 hover:underline"
        >
          Request another reset link
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 border border-line bg-panel p-4" aria-busy={pending}>
      <label className="block">
        <span className="mb-1 block text-[11px] text-muted">New password</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          autoFocus
          disabled={pending}
        />
        {state.fieldErrors?.password ? (
          <span className="mt-1 block text-[11.5px] text-fail">{state.fieldErrors.password}</span>
        ) : (
          <span className="mt-1 block text-[11px] text-faint">
            At least {PASSWORD_MIN_LENGTH} characters.
          </span>
        )}
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] text-muted">Confirm new password</span>
        <input name="confirm" type="password" autoComplete="new-password" required disabled={pending} />
        {state.fieldErrors?.confirm ? (
          <span className="mt-1 block text-[11.5px] text-fail">{state.fieldErrors.confirm}</span>
        ) : null}
      </label>
      {state.error ? (
        <p role="alert" className="text-[12px] text-fail">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating…
          </>
        ) : (
          "Update password"
        )}
      </button>
    </form>
  );
}
