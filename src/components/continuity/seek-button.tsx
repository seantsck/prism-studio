"use client";

/**
 * Jumps the page's output video near an evidence timestamp. The analyzer's timestamps are approximate (provider
 * sampling is not frame-exact), so this lands NEAR the moment: it is a pointer for a human, not a measurement.
 */
export function SeekButton({ atMs, label }: { atMs: number; label?: string }) {
  return (
    <button
      type="button"
      data-testid="seek-evidence"
      className="text-accent hover:underline"
      onClick={() => {
        const v = document.querySelector<HTMLVideoElement>('video[data-testid="output-video"]');
        if (!v) return;
        v.currentTime = Math.max(0, atMs / 1000 - 0.1);
        v.scrollIntoView({ block: "center", behavior: "smooth" });
        void v.play().catch(() => undefined);
      }}
    >
      {label ?? `▶ ${(atMs / 1000).toFixed(2)}s`}
    </button>
  );
}
