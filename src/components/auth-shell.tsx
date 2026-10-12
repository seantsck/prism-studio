import Link from "next/link";
import type { ReactNode } from "react";

/** Centered card used by every pre-session screen (login, forgot/update password, auth errors). */
export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <div className="mb-6">
        <div className="text-[11px] uppercase tracking-[0.18em] text-accent">Prism Studio</div>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{title}</h1>
      </div>
      {children}
    </main>
  );
}

export function DemoModeNotice({ what }: { what: string }) {
  return (
    <div className="border border-line bg-panel p-4 text-muted">
      <p>{what} is disabled in demo mode (in-memory data, single local user).</p>
      <Link href="/" className="mt-3 inline-block text-accent underline-offset-2 hover:underline">
        Open the demo workspace →
      </Link>
    </div>
  );
}

export const primaryButton =
  "inline-flex h-8 w-full items-center justify-center gap-2 rounded-[3px] border border-accent bg-accent text-[12px] font-medium text-accentfg hover:brightness-110 disabled:opacity-60";
