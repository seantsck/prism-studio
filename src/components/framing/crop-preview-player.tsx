"use client";

import { useState } from "react";
import type { Rect } from "@/domain/framing/crop";

/**
 * Original vs final-crop preview of a generated clip.
 *
 * The browser clips the ORIGINAL with CSS from the plan's crop window, so a filmmaker can judge the crop
 * before (or without) rendering a delivery file. When a conformed delivery master exists it is played
 * instead of the CSS clip. Nothing here changes any file; the real delivery asset is always server-generated.
 */
type Mode = "original" | "final" | "split";

export function CropPreviewPlayer({
  originalUrl,
  deliveryUrl,
  retained,
  providerRatio,
  productionLabel,
  providerLabel,
  originalSize,
  deliverySize,
  durationMs,
}: {
  originalUrl: string;
  /** The server-conformed delivery master, when one is selected. */
  deliveryUrl: string | null;
  /** Crop window (0..1 of the original) from the frozen plan. Null = no crop. */
  retained: Rect | null;
  providerRatio: number;
  productionLabel: string | null;
  providerLabel: string | null;
  originalSize: { width: number | null; height: number | null };
  deliverySize: { width: number | null; height: number | null } | null;
  durationMs: number | null;
}) {
  const [mode, setMode] = useState<Mode>(retained || deliveryUrl ? "final" : "original");

  const clipped = (
    <div
      className="relative w-full overflow-hidden border border-line bg-black"
      style={{
        aspectRatio: retained
          ? String((retained.width * providerRatio) / retained.height)
          : String(providerRatio),
      }}
      data-testid="css-crop-preview"
    >
      <video
        src={originalUrl}
        controls
        preload="metadata"
        playsInline
        muted
        className="absolute max-w-none"
        style={
          retained
            ? {
                width: `${100 / retained.width}%`,
                height: `${100 / retained.height}%`,
                left: `${(-retained.x / retained.width) * 100}%`,
                top: `${(-retained.y / retained.height) * 100}%`,
              }
            : { width: "100%", height: "100%", left: 0, top: 0 }
        }
      />
    </div>
  );

  const original = (
    <video
      src={originalUrl}
      controls
      preload="metadata"
      playsInline
      className="w-full border border-line bg-black"
      data-testid="original-video"
    />
  );
  const delivery = deliveryUrl ? (
    <video
      src={deliveryUrl}
      controls
      preload="metadata"
      playsInline
      className="w-full border border-line bg-black"
      data-testid="delivery-video"
    />
  ) : (
    clipped
  );
  const dims = (s: { width: number | null; height: number | null } | null) =>
    s?.width && s.height ? `${s.width}×${s.height}` : "—";
  const finalLabel = deliveryUrl
    ? `Delivery master ${dims(deliverySize)}`
    : retained
      ? "Final crop (preview — CSS clip of the original)"
      : "Final";

  return (
    <div className="space-y-2" data-testid="crop-preview">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {(["original", "final", "split"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            data-testid={`preview-${m}`}
            aria-pressed={mode === m}
            className={`border px-2 py-0.5 ${
              mode === m ? "border-accent text-accent" : "border-line text-muted hover:text-fg"
            }`}
          >
            {m === "original" ? "Original" : m === "final" ? "Final crop" : "Split"}
          </button>
        ))}
        <span className="ml-2 text-faint">
          Original {providerLabel ?? ""} {dims(originalSize)}
          {durationMs ? ` · ${(durationMs / 1000).toFixed(2)}s` : ""} →{" "}
          {productionLabel ?? "production frame"}
        </span>
      </div>
      {mode === "original" ? (
        <div>
          <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted">Provider original</div>
          {original}
        </div>
      ) : mode === "final" ? (
        <div>
          <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted">{finalLabel}</div>
          {delivery}
        </div>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          <div>
            <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted">Provider original</div>
            {original}
          </div>
          <div>
            <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted">{finalLabel}</div>
            {delivery}
          </div>
        </div>
      )}
    </div>
  );
}
