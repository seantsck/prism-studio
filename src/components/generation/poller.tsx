"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Keeps a generation view fresh without server push: polls Prism's OWN narrow status endpoint (never a
 * provider) and re-renders the page when the status signature changes. Polling stops when nothing is active.
 */
export function GenerationPoller({
  projectSlug,
  shotId,
  signature,
  active,
  intervalMs = 1500,
}: {
  projectSlug: string;
  shotId?: string;
  signature: string;
  active: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const url = `/api/projects/${encodeURIComponent(projectSlug)}/generation/status${shotId ? `?shotId=${encodeURIComponent(shotId)}` : ""}`;
    const tick = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok || stopped) return;
        const body = (await res.json()) as { signature?: string };
        if (!stopped && body.signature !== undefined && body.signature !== signature) router.refresh();
      } catch {
        /* transient network error: the next tick retries */
      }
    };
    const timer = setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [projectSlug, shotId, signature, active, intervalMs, router]);

  return active ? (
    <span className="text-[10.5px] text-faint" aria-live="polite" data-testid="generation-polling">
      Updating live…
    </span>
  ) : null;
}
