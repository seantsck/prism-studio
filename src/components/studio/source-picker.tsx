"use client";

import { fileSize } from "@/domain/generation/reference-upload";
import { cn } from "@/lib/utils";
import type { StudioImage, StudioState } from "@/server/reference-studio";
import { PhotoDropZone, type PhotoUpload } from "./photo-upload";

const VERDICT_TONE = {
  good: "text-pass",
  usable: "text-fg",
  low: "text-warn",
  unknown: "text-muted",
} as const;

/**
 * "Start from": the subject's own pictures (the creator's photographs first, then what was made from them), and the
 * place to add more. What is selected here is exactly what a generation sends; nothing selected means the written
 * description.
 * Each selected image shows what Prism can honestly say about it: its size and format, whether it is a photograph or a
 * generated picture, what the Visual Bible uses it as, and where the project uses it.
 */
export function SourcePicker({
  subject,
  images,
  selected,
  single,
  maxUploadBytes,
  upload,
  dragging,
  onToggle,
  onClear,
}: {
  subject: NonNullable<StudioState["selected"]>;
  images: StudioImage[];
  selected: string[];
  /** true: exactly one image (the one being changed) */
  single: boolean;
  /** The largest file this site can receive in one upload (a hosting limit where it is small). */
  maxUploadBytes: number;
  upload: PhotoUpload;
  /** true: files are being dragged over the Studio. */
  dragging: boolean;
  onToggle: (assetId: string) => void;
  onClear: () => void;
}) {
  const chosen = selected.flatMap((id) => images.filter((i) => i.assetId === id));
  return (
    <div data-testid="studio-sources">
      <h2 className="mb-1.5 text-[12px] font-medium">{single ? "Image to change" : "Start from"}</h2>

      <ul className="flex flex-wrap gap-1.5" data-testid="studio-source-list">
        {!single ? (
          <li>
            <button
              type="button"
              aria-pressed={selected.length === 0}
              onClick={onClear}
              data-testid="studio-source-none"
              className={cn(
                "flex h-[72px] w-[58px] items-center justify-center rounded-[3px] border px-1 text-center text-[10px] leading-tight",
                selected.length === 0
                  ? "border-accent bg-accent/10 text-fg"
                  : "border-line2 text-muted hover:border-muted hover:text-fg",
              )}
            >
              Words only
            </button>
          </li>
        ) : null}
        {images.map((i) => {
          const at = selected.indexOf(i.assetId);
          return (
            <li key={i.assetId}>
              <button
                type="button"
                aria-pressed={at >= 0}
                aria-label={`${i.label} (${i.originLabel})`}
                title={`${i.label} · ${i.originLabel}`}
                onClick={() => onToggle(i.assetId)}
                data-testid="studio-source"
                data-asset={i.assetId}
                data-origin={i.origin ?? ""}
                className={cn(
                  "relative block h-[72px] w-[58px] overflow-hidden rounded-[3px] border bg-[#232326]",
                  at >= 0 ? "border-accent ring-1 ring-accent" : "border-line2 hover:border-muted",
                )}
              >
                {i.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={i.url} alt="" className="h-full w-full object-cover" />
                ) : null}
                {at >= 0 && !single && selected.length > 1 ? (
                  <span className="absolute left-0.5 top-0.5 rounded-[2px] bg-accent px-1 text-[10px] font-semibold text-accentfg">
                    {at + 1}
                  </span>
                ) : null}
                {i.origin === "generated" ? (
                  <span className="absolute inset-x-0 bottom-0 bg-black/70 text-center text-[9px] text-fg">
                    generated
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {images.length === 0 ? (
        <p className="mt-1 text-[11.5px] text-muted" data-testid="studio-no-picture">
          {subject.name} has no picture yet. Add a photo below, or make the first reference from the written
          description.
        </p>
      ) : null}

      <div className="mt-2">
        <PhotoDropZone
          upload={upload}
          subject={subject}
          maxUploadBytes={maxUploadBytes}
          roomy={images.length === 0}
          dragging={dragging}
        />
      </div>

      {chosen.map((i) => (
        <div
          key={i.assetId}
          className="mt-2 rounded-[3px] border border-line bg-bg p-2 text-[11.5px]"
          data-testid="studio-inspection"
          data-verdict={i.inspection.verdict}
        >
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{i.label}</span>
            <span className="text-muted" data-testid="studio-source-origin">
              {i.originLabel}
            </span>
          </div>
          <div className="mt-0.5 text-muted">
            {i.inspection.width && i.inspection.height
              ? `${i.inspection.width} × ${i.inspection.height} px`
              : "size unknown"}
            {" · "}
            {i.inspection.format}
            {i.inspection.bytes != null ? ` · ${fileSize(i.inspection.bytes)}` : ""}
            {" · "}
            <span className={VERDICT_TONE[i.inspection.verdict]} data-testid="studio-verdict">
              {i.inspection.summary}
            </span>
          </div>
          {i.roles.length > 0 ? <div className="mt-0.5 text-muted">Used as: {i.roles.join(", ")}</div> : null}
          {i.inspection.turned ? (
            <p className="mt-1 text-warn" data-testid="studio-source-turned">
              Stored turned by the camera. Add this photo again here and an upright copy is uploaded.
            </p>
          ) : null}
          {!i.inspection.usableAsInput ? (
            <p className="mt-1 text-warn" data-testid="studio-source-unusable">
              An image model cannot be given this file.{" "}
              {i.inspection.notes.find((n) => n.includes("JPEG")) ?? ""}
            </p>
          ) : null}
          <details className="mt-1">
            <summary className="text-muted hover:text-fg">Details and where it is used</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">
              {i.inspection.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              <li data-testid="studio-usage">
                In the project: {i.usage.summary}
                {i.usage.lines.length > 0 ? ` (${i.usage.lines.slice(0, 4).join("; ")})` : ""}
              </li>
            </ul>
          </details>
        </div>
      ))}
    </div>
  );
}
