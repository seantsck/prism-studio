"use client";

import Link from "next/link";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { requestPasswordReset } from "@/lib/auth/recovery";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { primaryButton } from "./auth-shell";

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    setPending(true);
    setResult(null);
    try {
      setResult(await requestPasswordReset(createSupabaseBrowserClient(), email));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="border border-line bg-panel p-4">
      {result?.ok ? (
        <div role="status" className="space-y-3">
          <p className="text-[12.5px]">{result.message}</p>
          <p className="text-[11.5px] text-muted">
            The link works once, in this browser, for a limited time. Open it here on this computer.
          </p>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-3" aria-busy={pending}>
          <p className="text-[12px] text-muted">
            Enter your account email and we&apos;ll send you a link to choose a new password.
          </p>
          <label className="block">
            <span className="mb-1 block text-[11px] text-muted">Email</span>
            <input name="email" type="email" autoComplete="email" required autoFocus disabled={pending} />
          </label>
          {result ? (
            <p role="alert" className="text-[12px] text-fail">
              {result.message}
            </p>
          ) : null}
          <button type="submit" disabled={pending} className={primaryButton}>
            {pending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending…
              </>
            ) : (
              "Send reset link"
            )}
          </button>
        </form>
      )}
      <Link
        href="/login"
        className="mt-4 inline-block text-[12px] text-accent underline-offset-2 hover:underline"
      >
        Back to sign in
      </Link>
    </div>
  );
}
