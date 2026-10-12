/**
 * Upload validation: size limits, extension/MIME allow-lists and magic-byte sniffing. Pure, so it is unit
 * tested and shared by server actions. The server never trusts the browser's file.type or the filename.
 */

export type UploadKind = "image" | "audio" | "video" | "document";

export const MAX_BYTES: Record<UploadKind, number> = {
  image: 25 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
  video: 50 * 1024 * 1024, // matches the bucket's file_size_limit (0010_storage.sql)
  document: 10 * 1024 * 1024,
};

/** Detected container → canonical MIME + kind. */
interface Sniffed {
  mime: string;
  kind: UploadKind;
}

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to));

/** Identifies a file by its leading bytes. Returns null for anything not on the allow-list. */
export function sniffUpload(bytes: Uint8Array): Sniffed | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG") return { mime: "image/png", kind: "image" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: "image/jpeg", kind: "image" };
  if (ascii(bytes, 0, 4) === "GIF8") return { mime: "image/gif", kind: "image" };
  if (ascii(bytes, 0, 4) === "RIFF") {
    const form = ascii(bytes, 8, 12);
    if (form === "WEBP") return { mime: "image/webp", kind: "image" };
    if (form === "WAVE") return { mime: "audio/wav", kind: "audio" };
  }
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand === "avif" || brand === "avis") return { mime: "image/avif", kind: "image" };
    if (brand === "M4A " || brand === "M4B ") return { mime: "audio/mp4", kind: "audio" };
    if (brand === "qt  ") return { mime: "video/quicktime", kind: "video" };
    return { mime: "video/mp4", kind: "video" };
  }
  if (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
    return { mime: "audio/mpeg", kind: "audio" };
  if (ascii(bytes, 0, 4) === "OggS") return { mime: "audio/ogg", kind: "audio" };
  if (ascii(bytes, 0, 4) === "fLaC") return { mime: "audio/flac", kind: "audio" };
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return { mime: "video/webm", kind: "video" }; // EBML: webm audio is also reported as video/webm container
  if (ascii(bytes, 0, 4) === "%PDF") return { mime: "application/pdf", kind: "document" };
  if (ascii(bytes, 0, 4) === "glTF") return { mime: "model/gltf-binary", kind: "document" };
  return null;
}

const BLOCKED_EXTENSIONS = new Set([
  "exe", "dll", "bat", "cmd", "com", "msi", "scr", "ps1", "sh", "bash", "zsh", "js", "mjs", "cjs", "jar", "vbs",
  "html", "htm", "xhtml", "svg", "xml", "php", "py", "rb", "pl", "app", "apk", "dmg", "iso", "lnk", "wasm",
]);

export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export interface UploadCheck {
  ok: boolean;
  /** Message safe to show to the user. */
  reason?: string;
  mime?: string;
  kind?: UploadKind;
}

/**
 * Validates one uploaded file. `allowed` restricts the accepted kinds for the call site
 * (e.g. a performance take accepts only audio).
 */
export function checkUpload(
  file: { name: string; size: number; claimedMime?: string | null },
  bytes: Uint8Array,
  allowed: readonly UploadKind[],
): UploadCheck {
  if (bytes.length === 0 || file.size === 0) return { ok: false, reason: "The file is empty." };
  if (BLOCKED_EXTENSIONS.has(fileExtension(file.name)))
    return { ok: false, reason: "This file type is not allowed." };

  let sniffed = sniffUpload(bytes);
  if (!sniffed) return { ok: false, reason: "Unsupported or unrecognised file format." };
  // WebM / MP4 containers are shared by audio and video. When the call site only accepts audio, treat the
  // container as audio (browser MediaRecorder output); analyzeAudio then proves it actually contains audio.
  if (!allowed.includes("video") && allowed.includes("audio")) {
    if (sniffed.mime === "video/webm") sniffed = { mime: "audio/webm", kind: "audio" };
    else if (sniffed.mime === "video/mp4") sniffed = { mime: "audio/mp4", kind: "audio" };
  }
  if (!allowed.includes(sniffed.kind)) {
    return { ok: false, reason: `Expected ${allowed.join(" or ")} but this file is ${sniffed.kind}.` };
  }
  if (bytes.length > MAX_BYTES[sniffed.kind]) {
    return {
      ok: false,
      reason: `File is too large (limit ${Math.round(MAX_BYTES[sniffed.kind] / 1024 / 1024)} MB for ${sniffed.kind}).`,
    };
  }
  // A claimed type from a different family than the real content is a spoofing signal.
  const claimedFamily = file.claimedMime?.split("/")[0];
  const realFamily = sniffed.mime.split("/")[0];
  if (claimedFamily && claimedFamily !== "application" && claimedFamily !== "" && claimedFamily !== realFamily) {
    // webm audio vs video and m4a/mp4 overlap legitimately between audio and video families.
    const overlap = new Set(["audio", "video"]);
    if (!(overlap.has(claimedFamily) && overlap.has(realFamily))) {
      return { ok: false, reason: "The file content does not match its declared type." };
    }
  }
  return { ok: true, mime: sniffed.mime, kind: sniffed.kind };
}
