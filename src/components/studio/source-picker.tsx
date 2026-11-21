"use client";

import type { ReactNode } from "react";
import { fileSize } from "@/domain/generation/reference-upload";
import { cn } from "@/lib/utils";
import type { StudioImage, StudioState } from "@/server/reference-studio";
import { PhotoDropZone, type PhotoUpload } from "./photo-upload";
import { startPictureDrag } from "./reference-set";

const VERDICT_TONE = {
  good: "text-pass",
  usable: "text-fg",
  low: "text-warn",
  unknown: "text-muted",
} as const;

/**
 * "Start from": the subject's own pictures (the creator's photographs first, then what was made from them), and the
 * place to add more. What is selected here is exactly what a generation sends: every selected picture, together, in the
 * order of the numbers on them. Nothing selected means the written description. The line under the pictures says how
 * many are selected and that they are sent together.
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
  maxImages,
  ownPhotos,
  onToggle,
  onClear,
  onSelect,
  onShowLarge,
  setControl,
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
  /** How many images the chosen model takes in one request (0: unknown or none). */
  maxImages: number;
  /** The creator's own photographs of the subject, in order. */
  ownPhotos: string[];
  onToggle: (assetId: string) => void;
  onClear: () => void;
  /** Replaces the whole selection of starting images. */
  onSelect: (assetIds: string[]) => void;
  /** Puts the selected pictures on the stage (undefined while they are already there, or nothing is selected). */
  onShowLarge?: () => void;
  /** For a Character: the control that puts one of the creator's photos into the reference set. */
  setControl?: (image: StudioImage) => ReactNode;
}) {
  const chosen = selected.flatMap((id) => images.filter((i) => i.assetId === id));
  const several = !single && chosen.length > 1;
  const allPhotosChosen = ownPhotos.length > 0 && ownPhotos.every((id) => selected.includes(id));
  const tooMany = !single && maxImages > 0 && chosen.length > maxImages ? chosen.length - maxImages : 0;
  const thing = subject.kind === "character" ? "person" : "place";
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
                draggable
                onDragStart={(e) => startPictureDrag(e, { assetId: i.assetId, attemptId: i.attemptId })}
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
                  <span
                    className={cn(
                      "absolute inset-x-0 bottom-0 bg-black/70 text-center text-[9px]",
                      i.test ? "text-warn" : "text-fg",
                    )}
                  >
                    {i.test ? "test pattern" : "generated"}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {images.length > 0 ? (
        <p
          className="mt-1.5 text-[11.5px] text-muted"
          data-testid="studio-selection"
          data-count={chosen.length}
        >
          {single
            ? "One picture is changed at a time: click the one to change."
            : chosen.length === 0
              ? "Nothing selected: the picture is made from the written description alone."
              : chosen.length === 1
                ? "1 picture selected. Click more pictures to send them together."
                : `${chosen.length} pictures selected. They are sent together, as views of the same ${thing}.`}{" "}
          {tooMany > 0 ? (
            <span className="text-warn" data-testid="studio-selection-too-many">
              This model takes {maxImages}: the last {tooMany} will be left out.{" "}
            </span>
          ) : null}
          {!single && ownPhotos.length > 1 && !allPhotosChosen ? (
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => onSelect([...new Set([...selected, ...ownPhotos])])}
              data-testid="studio-select-photos"
            >
              Select all {ownPhotos.length} of my photos
            </button>
          ) : null}
          {onShowLarge && chosen.length > 0 ? (
            <>
              {" "}
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={onShowLarge}
                data-testid="studio-show-start"
              >
                {chosen.length === 1 ? "Show it large" : "Show them large"}
              </button>
            </>
          ) : null}
        </p>
      ) : null}
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
        <PictureFacts
          key={i.assetId}
          image={i}
          order={several ? selected.indexOf(i.assetId) + 1 : null}
          thing={thing}
          extra={setControl?.(i)}
        />
      ))}
    </div>
  );
}

/**
 * What Prism can honestly say about one selected picture. One picture gets the full card; several get a line each
 * (numbered in the order they are sent) that opens to the same facts, so a set of photographs stays readable. Anything
 * the creator should act on (a very long shape, a photo stored turned, a file no model takes) is always in view.
 */
function PictureFacts({
  image: i,
  order,
  thing,
  extra,
}: {
  image: StudioImage;
  /** Shown with the facts (for a photo of a Character: put it into the reference set). */
  extra?: ReactNode;
  /** Its place among several selected pictures, or null when it is the only one. */
  order: number | null;
  thing: string;
}) {
  const size =
    i.inspection.width && i.inspection.height
      ? `${i.inspection.width} × ${i.inspection.height} px`
      : "size unknown";
  const file = `${i.inspection.format}${i.inspection.bytes != null ? ` · ${fileSize(i.inspection.bytes)}` : ""}`;
  const origin = (
    <span className="text-muted" data-testid="studio-source-origin">
      {i.originLabel}
    </span>
  );
  const verdict = (
    <span className={VERDICT_TONE[i.inspection.verdict]} data-testid="studio-verdict">
      {i.inspection.summary}
    </span>
  );
  const usedAs = i.roles.length > 0 ? `Used as: ${i.roles.join(", ")}` : null;
  const warnings = (
    <>
      {i.test ? (
        <p className="mt-0.5 text-warn" data-testid="studio-source-test">
          A test pattern, not a picture of the {thing}. It is no use as a reference.
        </p>
      ) : null}
      {i.inspection.elongated ? (
        <p className="mt-0.5 text-warn" data-testid="studio-source-elongated">
          A very long shape (a full phone screenshot?). If the {thing} is small in the frame, or the picture
          shows anything else, crop it first.
        </p>
      ) : null}
      {i.inspection.turned ? (
        <p className="mt-0.5 text-warn" data-testid="studio-source-turned">
          Stored turned by the camera. Add this photo again here and an upright copy is uploaded.
        </p>
      ) : null}
      {!i.inspection.usableAsInput ? (
        <p className="mt-0.5 text-warn" data-testid="studio-source-unusable">
          An image model cannot be given this file. {i.inspection.notes.find((n) => n.includes("JPEG")) ?? ""}
        </p>
      ) : null}
    </>
  );
  const more = (
    <>
      {i.inspection.notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
      <li data-testid="studio-usage">
        In the project: {i.usage.summary}
        {i.usage.lines.length > 0 ? ` (${i.usage.lines.slice(0, 4).join("; ")})` : ""}
      </li>
    </>
  );
  return (
    <div
      className={cn(
        "rounded-[3px] border border-line bg-bg text-[11.5px]",
        order == null ? "mt-2 p-2" : "mt-1 px-2 py-1",
      )}
      data-testid="studio-inspection"
      data-verdict={i.inspection.verdict}
      data-asset={i.assetId}
    >
      {order == null ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{i.label}</span>
            {origin}
          </div>
          <div className="mt-0.5 text-muted">
            {size} · {file} · {verdict}
          </div>
          {usedAs ? <div className="mt-0.5 text-muted">{usedAs}</div> : null}
          {warnings}
          {extra}
          <details className="mt-1">
            <summary className="text-muted hover:text-fg">Details and where it is used</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">{more}</ul>
          </details>
        </>
      ) : (
        <>
          <details>
            <summary
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
              title="Details and where it is used"
            >
              <span className="rounded-[2px] bg-accent px-1 text-[10px] font-semibold text-accentfg">
                {order}
              </span>
              <span className="font-medium">{i.label}</span>
              {origin}
              <span className="text-muted">{size}</span>
              {verdict}
            </summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">
              <li>{file}</li>
              {usedAs ? <li>{usedAs}</li> : null}
              {more}
            </ul>
          </details>
          {warnings}
          {/* the actions on each picture stay in view, even when its facts are folded */}
          {extra}
        </>
      )}
    </div>
  );
}
