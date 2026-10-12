"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Last-resort boundary for unexpected render failures. Expected problems (validation, locked entities, asset in
 * use, upload rejected…) never reach here — they are returned inline by server actions. Technical detail
 * stays in the server log; the user only gets the reference digest.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ui]", error.digest ?? "no-digest");
  }, [error]);
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-6">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="mt-2 text-muted">
        This page could not be displayed. Your data has not been changed.
        {error.digest ? (
          <span className="mt-1 block font-mono text-[11px] text-faint">Reference: {error.digest}</span>
        ) : null}
      </p>
      <div className="mt-4 flex gap-3">
        <button
          onClick={reset}
          className="rounded-[3px] border border-accent bg-accent px-3 py-1 text-[12px] font-medium text-accentfg"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-[3px] border border-line2 px-3 py-1 text-[12px] text-muted hover:text-fg"
        >
          Back to projects
        </Link>
      </div>
    </main>
  );
}
