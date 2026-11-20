import { isTurned } from "@/lib/image-size";

/**
 * Adding a reference photograph: what is sent for each file the creator chooses. Pure: the browser reads the file
 * (its size, its dimensions, the rotation flag a camera wrote), this decides, and the browser carries it out.
 *
 * A chosen file is sent exactly as it is whenever it can be. Two things make that impossible or unwise, and in both a
 * copy made in the browser is sent instead, and SAID to be a copy:
 *   - the file is larger than one upload can carry on this deployment (a host limit, not Prism's own);
 *   - a camera stored the photograph turned on its side with a rotation flag, which some tools ignore.
 * The copy's record (what was chosen, why a copy was made) is kept on the stored image. The chosen file itself never
 * leaves the creator's device in that case, so Prism never claims to hold it.
 */

/** The formats a reference photograph can be added in (what the image models here take as an input image). */
export const UPLOAD_PHOTO_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
/** The long sides tried for a copy, largest first. 4096 keeps a canvas within what every current browser draws. */
export const UPLOAD_COPY_LONG_SIDES = [4096, 2048, 1536] as const;
/** A copy made to fit the upload limit starts here: more than an image model uses, and small in bytes. */
export const UPLOAD_SMALLER_LONG_SIDE = 2048;

export type UploadCopyReason = "turned" | "too_large";

/** What a browser can tell about a chosen file before anything is sent. */
export interface UploadCandidate {
  name: string;
  /** The browser's claim. The server reads the real type from the bytes. */
  mime: string;
  bytes: number;
  /** As displayed (the browser applies a camera's rotation flag). null: the browser could not open the picture. */
  width: number | null;
  height: number | null;
  /** The EXIF orientation a JPEG carries, when it carries one. */
  orientation?: number | null;
}

export type UploadPlan =
  | { action: "send" }
  | {
      action: "copy";
      reasons: UploadCopyReason[];
      /** The long sides to try, in order, until a copy fits the upload limit. */
      longSides: number[];
    }
  | { action: "refuse"; reason: "format" | "unreadable"; message: string };

const FORMAT_WORD: Record<string, string> = {
  gif: "GIF",
  avif: "AVIF",
  tif: "TIFF",
  tiff: "TIFF",
  bmp: "BMP",
  svg: "SVG",
  "svg+xml": "SVG",
  pdf: "PDF",
  psd: "Photoshop",
  raw: "Camera raw",
  dng: "Camera raw",
  cr2: "Camera raw",
  nef: "Camera raw",
  arw: "Camera raw",
};

const extensionOf = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();
const normalMime = (mime: string) => mime.toLowerCase().replace("image/jpg", "image/jpeg");

/** "2.8 MB" / "310 KB": a file size as the Studio shows it. */
export function fileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Decides what is sent for one chosen file: the file as it is, a copy made in the browser, or nothing. */
export function planUpload(file: UploadCandidate, maxUploadBytes: number): UploadPlan {
  const mime = normalMime(file.mime);
  if (!(UPLOAD_PHOTO_MIMES as readonly string[]).includes(mime)) {
    const kind = mime.startsWith("image/") ? mime.slice(6) : extensionOf(file.name);
    if (kind === "heic" || kind === "heif")
      return {
        action: "refuse",
        reason: "format",
        message:
          "HEIC photos (the iPhone camera format) cannot be added here. Export the photo as JPEG and add that.",
      };
    const word = FORMAT_WORD[kind];
    return {
      action: "refuse",
      reason: "format",
      message: word
        ? `${word} files cannot be added here. Save the picture as JPEG, PNG or WebP and add that.`
        : "This is not a JPEG, PNG or WebP picture.",
    };
  }
  if (!file.width || !file.height)
    return {
      action: "refuse",
      reason: "unreadable",
      message: "This file could not be opened as a picture. It may be damaged, or not really an image.",
    };
  const turned = isTurned(file.orientation);
  const tooLarge = file.bytes > maxUploadBytes;
  if (!turned && !tooLarge) return { action: "send" };
  const long = Math.max(file.width, file.height);
  // an upright copy keeps the picture's size where a browser can draw it; a copy made to fit starts smaller
  const first = Math.min(long, tooLarge ? UPLOAD_SMALLER_LONG_SIDE : UPLOAD_COPY_LONG_SIDES[0]);
  const longSides = [first, ...UPLOAD_COPY_LONG_SIDES.filter((s) => s < first)];
  return {
    action: "copy",
    reasons: [...(turned ? (["turned"] as const) : []), ...(tooLarge ? (["too_large"] as const) : [])],
    longSides,
  };
}

/** The size of a copy whose long side is `longSide`: the picture's shape is kept, and it is never enlarged. */
export function copySize(width: number, height: number, longSide: number): { width: number; height: number } {
  const scale = Math.min(1, longSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The copies to try, in order, until one fits the upload limit. Resolution is given up last: at the first size a JPEG
 * is tried once more, a little more compressed, before the copy is made smaller.
 */
export function copyTries(
  plan: Extract<UploadPlan, { action: "copy" }>,
  jpeg: boolean,
): Array<{ longSide: number; quality: number }> {
  return plan.longSides.flatMap((longSide, at) =>
    jpeg
      ? at === 0
        ? [
            { longSide, quality: 0.92 },
            { longSide, quality: 0.85 },
          ]
        : [{ longSide, quality: 0.92 }]
      : [{ longSide, quality: 0.9 }],
  );
}

/**
 * Why the copy that was made is a copy. An upright copy that had to be made smaller to fit one upload is a smaller
 * copy too, and is recorded as one.
 */
export function copyReasons(
  planned: readonly UploadCopyReason[],
  picture: { width: number; height: number },
  copy: { width: number; height: number },
): UploadCopyReason[] {
  const reduced = copy.width < picture.width || copy.height < picture.height;
  return reduced && !planned.includes("too_large") ? [...planned, "too_large"] : [...planned];
}

const EXTENSION: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** A copy carries its own file name, so it is never mistaken for the file it was made from. */
export function uploadCopyName(name: string, width: number, height: number, mime: string): string {
  const base = name.replace(/\.[a-z0-9]+$/i, "").trim() || "photo";
  return `${base}-copy-${width}x${height}.${EXTENSION[normalMime(mime)] ?? "jpg"}`;
}

/** What is kept on a stored image that is a browser-made copy: the file the creator chose, as their browser saw it. */
export interface UploadCopyRecord {
  name: string;
  bytes: number;
  width: number;
  height: number;
  reasons: UploadCopyReason[];
}

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Reads a copy's record from the upload form or from stored metadata. Anything malformed is no record at all. */
export function parseUploadCopy(raw: unknown): UploadCopyRecord | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim() || raw.length > 1_000) return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const reasons = Array.isArray(r.reasons)
    ? ([...new Set(r.reasons)].filter((x) => x === "turned" || x === "too_large") as UploadCopyReason[])
    : [];
  if (typeof r.name !== "string" || !r.name.trim() || reasons.length === 0) return null;
  if (!positive(r.bytes) || !positive(r.width) || !positive(r.height)) return null;
  return {
    name: r.name.trim().slice(0, 200),
    bytes: Math.round(r.bytes),
    width: Math.round(r.width),
    height: Math.round(r.height),
    reasons,
  };
}

/** One sentence, for the creator: why this stored image is a copy, and what it was made from. */
export function uploadCopySentence(copy: UploadCopyRecord): string {
  const turned = copy.reasons.includes("turned");
  const tooLarge = copy.reasons.includes("too_large");
  const what =
    turned && tooLarge ? "An upright, smaller copy" : turned ? "An upright copy" : "A smaller copy";
  const why = [
    ...(turned ? ["the camera had stored the photo turned, with a rotation flag"] : []),
    ...(tooLarge ? ["one upload here could not carry it at full size"] : []),
  ].join(", and ");
  return `${what} made in the browser when it was added: ${why}. The file chosen was ${copy.name} (${copy.width} × ${copy.height}, ${fileSize(copy.bytes)}); it was not uploaded.`;
}
