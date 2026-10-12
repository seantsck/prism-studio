"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { signIn, type SignInState } from "@/server/auth-actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, { error: null });
  return (
    <form action={action} className="space-y-3" aria-busy={pending}>
      <input type="hidden" name="next" value={next} />
      <label className="block">
        <span className="mb-1 block text-[11px] text-muted">Email</span>
        <input name="email" type="email" autoComplete="email" required autoFocus disabled={pending} />
      </label>
      <label className="block">
        <span className="mb-1 block text-[11px] text-muted">Password</span>
        <input name="password" type="password" autoComplete="current-password" required disabled={pending} />
      </label>
      {state.error ? (
        <p role="alert" className="text-[12px] text-fail">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-[3px] border border-accent bg-accent text-[12px] font-medium text-accentfg hover:brightness-110 disabled:opacity-60"
      >
        {pending ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </button>
    </form>
  );
}
