"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui";
import { inspectReferenceImage, type ReferenceInspection } from "@/domain/generation/reference-studio";
import {
  copyReasons,
  copySize,
  copyTries,
  fileSize,
  planUpload,
  uploadCopyName,
  type UploadCopyRecord,
} from "@/domain/generation/reference-upload";
import { readJpegOrientation } from "@/lib/image-size";
import { cn } from "@/lib/utils";
import type { StudioState } from "@/server/reference-studio";
import { uploadReferencePhoto } from "@/server/reference-studio-actions";

type Subject = NonNullable<StudioState["selected"]>;

/** How many photos wait at once: enough for a whole reference session, few enough to read before sending. */
export const UPLOAD_QUEUE_LIMIT = 20;
/** A JPEG's camera data sits in its first segments; this much of the file is read to find the rotation flag. */
const HEAD_BYTES = 128 * 1024;

export interface UploadItem {
  id: string;
  /** The file the creator chose. */
  name: string;
  /** What will be sent: the chosen file, or a copy made here. null while it is being read, or when it is refused. */
  file: File | null;
  /** A picture of exactly what will be sent (the chosen file while it is still being read). */
  preview: string | null;
  inspection: ReferenceInspection | null;
  /** Set when what will be sent is a copy made in this browser: the record of the chosen file. */
  copy: UploadCopyRecord | null;
  state: "checking" | "ready" | "refused" | "uploading" | "failed";
  /** Why it is refused or failed; or, on a ready photo, something the creator should know. */
  message: string | null;
}

export interface PhotoUpload {
  items: UploadItem[];
  /** What the photos show: "reference", an identity slot, or "look:<id>". */
  as: string;
  setAs: (value: string) => void;
  busy: boolean;
  /** How many photos the last upload added. */
  added: number;
  notice: string | null;
  input: RefObject<HTMLInputElement | null>;
  add: (files: File[]) => void;
  remove: (id: string) => void;
  start: () => void;
  /** Opens the file dialog. */
  choose: () => void;
}

const isJpeg = (mime: string) => mime === "image/jpeg" || mime === "image/jpg";

interface Opened {
  image: HTMLImageElement;
  width: number;
  height: number;
  close: () => void;
}

/**
 * Opens a picture the way the browser displays it, a camera's rotation flag applied. Through an image element: every
 * current browser honours the flag there, both for the size it reports and when the element is drawn on a canvas.
 * null: the file will not open as a picture.
 */
async function open(blob: Blob): Promise<Opened | null> {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
  if (!image.naturalWidth || !image.naturalHeight) {
    URL.revokeObjectURL(url);
    return null;
  }
  return {
    image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    close: () => URL.revokeObjectURL(url),
  };
}

async function measure(blob: Blob): Promise<{ width: number; height: number } | null> {
  const opened = await open(blob);
  if (!opened) return null;
  opened.close();
  return { width: opened.width, height: opened.height };
}

/** Draws the picture upright at `size` and encodes it. null: this browser could not make the copy. */
async function encodeCopy(
  file: Blob,
  size: { width: number; height: number },
  mime: "image/jpeg" | "image/webp",
  quality: number,
): Promise<Blob | null> {
  const opened = await open(file);
  if (!opened) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(opened.image, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
    // a browser that cannot write WebP answers with PNG: still a picture Prism takes
    if (!blob || !["image/jpeg", "image/png", "image/webp"].includes(blob.type)) return null;
    // the copy must open, at the size it was drawn (a canvas that was too large for the device comes back empty)
    const made = await measure(blob);
    return made && made.width === size.width && made.height === size.height ? blob : null;
  } finally {
    opened.close();
  }
}

type Prepared =
  | {
      ok: true;
      file: File;
      copy: UploadCopyRecord | null;
      inspection: ReferenceInspection;
      message: string | null;
    }
  | { ok: false; message: string };

/** Reads one chosen file and settles what will be sent for it. Nothing leaves the browser here. */
async function prepare(file: File, maxUploadBytes: number): Promise<Prepared> {
  const mime = file.type.toLowerCase();
  let orientation: number | null = null;
  if (isJpeg(mime)) {
    try {
      orientation = readJpegOrientation(new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer()));
    } catch {
      orientation = null;
    }
  }
  const size = mime.startsWith("image/") ? await measure(file) : null;
  const plan = planUpload(
    {
      name: file.name,
      mime,
      bytes: file.size,
      width: size?.width ?? null,
      height: size?.height ?? null,
      orientation,
    },
    maxUploadBytes,
  );
  if (plan.action === "refuse" || !size) {
    return { ok: false, message: plan.action === "refuse" ? plan.message : "This file could not be opened." };
  }
  const inspect = (f: Blob, s: { width: number; height: number }) =>
    inspectReferenceImage({ width: s.width, height: s.height, mime: f.type, byteSize: f.size, metadata: {} });
  if (plan.action === "send")
    return { ok: true, file, copy: null, inspection: inspect(file, size), message: null };

  const tooLarge = plan.reasons.includes("too_large");
  for (const { longSide, quality } of copyTries(plan, isJpeg(mime))) {
    const dims = copySize(size.width, size.height, longSide);
    const blob = await encodeCopy(file, dims, isJpeg(mime) ? "image/jpeg" : "image/webp", quality);
    if (!blob) break;
    if (blob.size > maxUploadBytes) continue;
    const reasons = copyReasons(plan.reasons, size, dims);
    return {
      ok: true,
      file: new File([blob], uploadCopyName(file.name, dims.width, dims.height, blob.type), {
        type: blob.type,
      }),
      copy: { name: file.name, bytes: file.size, width: size.width, height: size.height, reasons },
      inspection: inspect(blob, dims),
      message: null,
    };
  }
  if (tooLarge)
    return {
      ok: false,
      message: `${fileSize(file.size)} is more than one upload can carry here (${fileSize(maxUploadBytes)}), and a smaller copy could not be made in this browser. Save a copy about 2048 px on its long side and add that.`,
    };
  // turned only: the file itself is fine, so it is added as it is and the Studio keeps saying it is stored turned
  return {
    ok: true,
    file,
    copy: null,
    inspection: inspect(file, size),
    message:
      "Your camera stored this photo turned, and an upright copy could not be made in this browser. It is added as it is.",
  };
}

/**
 * The Studio's upload queue for ONE Character or Location. Chosen or dropped photos are read first (size, format, a
 * camera's rotation flag, whether one upload can carry them), shown for what will actually be sent, and only then
 * uploaded, one request per photo, when the creator presses Upload.
 */
export function usePhotoUpload({
  slug,
  subject,
  maxUploadBytes,
  onAdded,
}: {
  slug: string;
  subject: Subject;
  maxUploadBytes: number;
  /** The first photo an upload added as a reference of the subject itself (it becomes the starting image). */
  onAdded: (assetId: string) => void;
}): PhotoUpload {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [as, setAs] = useState("reference");
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const alive = useRef(true);
  const urls = useRef(new Set<string>());
  useEffect(() => {
    alive.current = true;
    const held = urls.current;
    // A photo dropped beside the Studio (on the navigation, say) must not replace the page with the picture, which
    // is what a browser does with a dropped file nobody takes.
    const keepPage = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", keepPage);
    window.addEventListener("drop", keepPage);
    return () => {
      alive.current = false;
      window.removeEventListener("dragover", keepPage);
      window.removeEventListener("drop", keepPage);
      for (const url of held) URL.revokeObjectURL(url);
      held.clear();
    };
  }, []);

  const hold = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    urls.current.add(url);
    return url;
  };
  const release = (url: string | null) => {
    if (!url) return;
    URL.revokeObjectURL(url);
    urls.current.delete(url);
  };
  const patch = (id: string, change: Partial<UploadItem>) =>
    setItems((list) => list.map((i) => (i.id === id ? { ...i, ...change } : i)));

  const add = (files: File[]) => {
    if (files.length === 0 || subject.locked || busy) return;
    const room = Math.max(0, UPLOAD_QUEUE_LIMIT - items.length);
    const taken = files.slice(0, room);
    setAdded(0);
    setNotice(
      taken.length < files.length
        ? `${UPLOAD_QUEUE_LIMIT} photos at a time: ${files.length - taken.length} left out. Upload these, then add the rest.`
        : null,
    );
    const fresh = taken.map((file): UploadItem => {
      seq.current += 1;
      return {
        id: `photo-${seq.current}`,
        name: file.name,
        file: null,
        preview: file.type.startsWith("image/") ? hold(file) : null,
        inspection: null,
        copy: null,
        state: "checking",
        message: null,
      };
    });
    setItems((list) => [...list, ...fresh]);
    void (async () => {
      // one at a time: a phone photograph is large once opened
      for (const [at, item] of fresh.entries()) {
        const result = await prepare(taken[at]!, maxUploadBytes);
        if (!alive.current) return;
        if (!result.ok) {
          patch(item.id, { state: "refused", message: result.message });
          continue;
        }
        // the preview is the picture that will be sent: a copy shows the copy
        const preview = result.copy ? hold(result.file) : item.preview;
        if (result.copy) release(item.preview);
        patch(item.id, {
          state: "ready",
          file: result.file,
          copy: result.copy,
          inspection: result.inspection,
          message: result.message,
          preview,
        });
      }
    })();
  };

  const remove = (id: string) => {
    if (busy) return;
    setItems((list) => {
      release(list.find((i) => i.id === id)?.preview ?? null);
      return list.filter((i) => i.id !== id);
    });
    setNotice(null);
  };

  const start = () => {
    const ready = items.filter((i) => (i.state === "ready" || i.state === "failed") && i.file);
    if (busy || ready.length === 0 || items.some((i) => i.state === "checking")) return;
    const forLook = as.startsWith("look:");
    const slot = as !== "reference" && !forLook;
    if (slot && ready.length > 1) return;
    setBusy(true);
    setAdded(0);
    setNotice(null);
    void (async () => {
      let count = 0;
      let first: string | null = null;
      for (const item of ready) {
        patch(item.id, { state: "uploading", message: null });
        const form = new FormData();
        form.set("projectSlug", slug);
        form.set("subjectKind", subject.kind);
        form.set("subjectId", subject.id);
        form.set("as", as);
        form.set("file", item.file!, item.file!.name);
        if (item.copy) form.set("copyOf", JSON.stringify(item.copy));
        let result: Awaited<ReturnType<typeof uploadReferencePhoto>>;
        try {
          result = await uploadReferencePhoto(form);
        } catch {
          result = {
            ok: false,
            error: "The upload did not reach Prism. Check your connection and try again.",
          };
        }
        if (!alive.current) return;
        if (result.ok) {
          count += 1;
          first ??= result.assetId ?? null;
          release(item.preview);
          setItems((list) => list.filter((i) => i.id !== item.id));
        } else patch(item.id, { state: "failed", message: result.error });
      }
      setBusy(false);
      setAdded(count);
      // a slot holds one photo: the next one added is an ordinary reference again
      if (slot && count > 0) setAs("reference");
      if (first && !forLook) onAdded(first);
    })();
  };

  return {
    items,
    as,
    setAs,
    busy,
    added,
    notice,
    input,
    add,
    remove,
    start,
    choose: () => input.current?.click(),
  };
}

const VERDICT_TONE = {
  good: "text-pass",
  usable: "text-fg",
  low: "text-warn",
  unknown: "text-muted",
} as const;

const SLOTS = [
  ["front", "Front of the face"],
  ["three_quarter", "3/4 view"],
  ["profile", "Profile"],
  ["full_body", "Full body"],
] as const;

function copyNote(copy: UploadCopyRecord, maxUploadBytes: number): string {
  const turned = copy.reasons.includes("turned");
  const tooLarge = copy.reasons.includes("too_large");
  const from = `${copy.width} × ${copy.height}, ${fileSize(copy.bytes)}`;
  if (turned && tooLarge)
    return `Your camera stored this photo turned on its side, and an upright copy at full size is more than one upload can carry here (${fileSize(maxUploadBytes)}). This upright, smaller copy is added instead. Your file (${from}) stays with you.`;
  if (turned)
    return "Your camera stored this photo turned on its side. This upright copy is added, so every tool sees it the right way up.";
  return `${fileSize(copy.bytes)} is more than one upload can carry here (${fileSize(maxUploadBytes)}). This smaller copy is added instead. Your full-size file (${from}) stays with you.`;
}

/**
 * The place to add reference photographs: always on screen, takes a drop or the file dialog, several photos at once.
 * Each photo is listed with what will really be sent before the creator uploads anything.
 */
export function PhotoDropZone({
  upload,
  subject,
  maxUploadBytes,
  roomy,
  dragging,
}: {
  upload: PhotoUpload;
  subject: Subject;
  maxUploadBytes: number;
  /** true: the subject has no picture yet, so adding one is the first thing to do and gets the room. */
  roomy: boolean;
  /** true: files are being dragged over the Studio. */
  dragging: boolean;
}) {
  const { items, as, setAs, busy, added, notice, input, add, remove, start, choose } = upload;
  const ready = items.filter((i) => (i.state === "ready" || i.state === "failed") && i.file);
  const checking = items.some((i) => i.state === "checking");
  const slot = as !== "reference" && !as.startsWith("look:");
  const tooMany = slot && ready.length > 1;
  const locked = subject.locked;
  // a photo over the limit is still taken: a smaller copy is made here, and the list says so for that photo
  const formats = `JPEG, PNG or WebP, several at once. A photo over ${fileSize(maxUploadBytes)} is added as a smaller copy.`;

  return (
    <div data-testid="studio-upload" data-dragging={dragging ? "true" : "false"}>
      <input
        ref={input}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-label={`Reference photos of ${subject.name}`}
        disabled={locked || busy}
        onChange={(e) => {
          add(Array.from(e.target.files ?? []));
          // the same file can be chosen again after it was removed
          e.target.value = "";
        }}
        data-testid="studio-upload-file"
      />
      <div
        className={cn(
          "rounded-[3px] border border-dashed transition-colors",
          roomy ? "px-3 py-5 text-center" : "flex items-start gap-2 px-2.5 py-2",
          dragging && !locked ? "border-accent bg-accent/10" : "border-line2",
        )}
        data-testid="studio-upload-zone"
      >
        <ImagePlus
          aria-hidden
          className={cn("shrink-0 text-muted", roomy ? "mx-auto mb-1.5 h-5 w-5" : "mt-0.5 h-3.5 w-3.5")}
        />
        <div className="min-w-0">
          {locked ? (
            <p className="text-[11.5px] text-warn">
              {subject.name} is locked: unlock it on the Locations page to add a photo.
            </p>
          ) : (
            <>
              <p className={cn("text-fg", roomy ? "text-[13px] font-medium" : "text-[12px]")}>
                {dragging
                  ? `Drop to add to ${subject.name}`
                  : roomy
                    ? `Add reference photos of ${subject.name}`
                    : "Add reference photos"}
              </p>
              <p className={cn("text-muted", roomy ? "mt-0.5 text-[12px]" : "text-[11.5px]")}>
                Drop them here, or{" "}
                <button
                  type="button"
                  className="text-accent hover:underline disabled:opacity-50"
                  onClick={choose}
                  disabled={busy}
                  data-testid="studio-upload-choose"
                >
                  choose files
                </button>
                .
              </p>
              <p className={cn("text-[10.5px] text-faint", roomy ? "mt-2" : "mt-0.5")}>{formats}</p>
            </>
          )}
        </div>
      </div>

      {items.length > 0 ? (
        <div className="mt-1.5 space-y-1.5" data-testid="studio-upload-queue">
          <ul className="space-y-1">
            {items.map((i) => (
              <li
                key={i.id}
                className="flex gap-2 rounded-[3px] border border-line bg-bg p-1.5"
                data-testid="studio-upload-item"
                data-state={i.state}
                data-copy={i.copy ? i.copy.reasons.join(" ") : ""}
              >
                <div className="h-[50px] w-[40px] shrink-0 overflow-hidden rounded-[2px] bg-[#232326]">
                  {i.preview && i.state !== "refused" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={i.preview} alt="" className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1 text-[11.5px]">
                  <div className="truncate font-medium" title={i.name}>
                    {i.name}
                  </div>
                  {i.state === "checking" ? (
                    <div className="inline-flex items-center gap-1 text-muted">
                      <Loader2 className="h-3 w-3 animate-spin" /> Reading…
                    </div>
                  ) : i.state === "refused" ? (
                    <p className="text-warn" role="alert" data-testid="studio-upload-refused">
                      {i.message}
                    </p>
                  ) : (
                    <>
                      {i.inspection ? (
                        <div className="text-muted" data-testid="studio-upload-facts">
                          {i.inspection.width} × {i.inspection.height} px · {i.inspection.format} ·{" "}
                          {fileSize(i.inspection.bytes)} ·{" "}
                          <span className={VERDICT_TONE[i.inspection.verdict]}>{i.inspection.summary}</span>
                        </div>
                      ) : null}
                      {i.copy ? (
                        <p className="mt-0.5 text-muted" data-testid="studio-upload-copy">
                          {copyNote(i.copy, maxUploadBytes)}
                        </p>
                      ) : null}
                      {i.state === "uploading" ? (
                        <div className="mt-0.5 inline-flex items-center gap-1 text-muted">
                          <Loader2 className="h-3 w-3 animate-spin" /> Uploading…
                        </div>
                      ) : i.message ? (
                        <p
                          className={cn("mt-0.5", i.state === "failed" ? "text-fail" : "text-warn")}
                          role={i.state === "failed" ? "alert" : undefined}
                          data-testid="studio-upload-message"
                        >
                          {i.message}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
                <button
                  type="button"
                  className="self-start rounded-[2px] p-0.5 text-muted hover:text-fg disabled:opacity-40"
                  onClick={() => remove(i.id)}
                  disabled={busy}
                  aria-label={`Remove ${i.name}`}
                  data-testid="studio-upload-remove"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-1.5">
            {subject.kind === "character" ? (
              <select
                value={as}
                onChange={(e) => setAs(e.target.value)}
                disabled={busy}
                aria-label="What these photos show"
                className="min-w-0 flex-1"
                data-testid="studio-upload-as"
              >
                <option value="reference">
                  {ready.length > 1 ? "References" : "A reference"} of {subject.name}
                </option>
                {SLOTS.map(([id, label]) => (
                  <option key={id} value={id} disabled={subject.filledSlots.includes(id)}>
                    {label}
                    {subject.filledSlots.includes(id) ? " (already set)" : ""}
                  </option>
                ))}
                {subject.looks.map((l) => (
                  <option key={l.id} value={`look:${l.id}`} disabled={l.locked}>
                    Wardrobe: {l.name}
                    {l.locked ? " (locked)" : ""}
                  </option>
                ))}
              </select>
            ) : null}
            <Button
              type="button"
              onClick={start}
              disabled={busy || checking || ready.length === 0 || tooMany || locked}
              data-testid="studio-upload-submit"
            >
              {busy
                ? "Uploading…"
                : ready.length > 1
                  ? `Upload ${ready.length} photos`
                  : ready.length === 1
                    ? "Upload photo"
                    : "Upload"}
            </Button>
          </div>
          {tooMany ? (
            <p className="text-[11.5px] text-warn" data-testid="studio-upload-one-per-slot">
              That choice holds one photo. Remove the others, or add them all as references.
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="mt-1 text-[11.5px]" aria-live="polite" data-testid="studio-upload-status">
        {notice ? <span className="text-warn">{notice}</span> : null}
        {!notice && added > 0 && !busy ? (
          <span className="text-pass">
            {added === 1 ? "1 photo added" : `${added} photos added`} to {subject.name}&rsquo;s pictures.
          </span>
        ) : null}
      </p>
    </div>
  );
}
