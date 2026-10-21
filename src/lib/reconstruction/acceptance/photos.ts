import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isWithin } from "../local/work-root";

/**
 * The REAL_ROOM photo directory (M2D.3D1): the operator's private photographs, read in place and NEVER modified.
 *
 *   - one directory, not recursive; only regular files whose BYTES are JPEG or PNG count (the extension is not trusted)
 *   - a link (symlink / junction) is refused, never followed: nothing outside the chosen directory is read
 *   - other entries (sidecars, subdirectories, videos) are listed as skipped, never read
 *   - 3–300 photographs, each ≤ 64 MB; their order is deterministic: file names compared code point by code point
 *   - the directory must be outside the Prism repository (capture photos must never be committed)
 *   - file names are never passed to a tool or a shell: the engine copies each photo to `input/000001.jpg …`
 */

export const PHOTO_LIMITS = { min: 3, max: 300, maxBytes: 64 * 1024 * 1024 } as const;

export interface AcceptancePhoto {
  ordinal: number;
  /** absolute, real path (read only; never written, never reported) */
  path: string;
  mime: "image/jpeg" | "image/png";
  byteSize: number;
  sha256: string;
  width: number | null;
  height: number | null;
}

export interface PhotoScan {
  photos: AcceptancePhoto[];
  totalBytes: number;
  skipped: { links: number; directories: number; notImages: number };
}

export class AcceptanceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcceptanceInputError";
  }
}

const JPEG = (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const PNG = (b: Uint8Array) =>
  b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v);

/** Width/height from a PNG IHDR or a JPEG SOFn marker (no decoder). Null when the header cannot be read. */
export function imageDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (PNG(b) && b.length >= 24) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (!JPEG(b)) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

async function head(file: string, n: number): Promise<Uint8Array> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function sha256Of(file: string): Promise<string> {
  const fh = await open(file, "r");
  try {
    const h = createHash("sha256");
    for await (const chunk of fh.createReadStream()) h.update(chunk as Buffer);
    return h.digest("hex");
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Code-point order (not locale order): the same names give the same order on every machine. */
export const comparePhotoNames = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function scanPhotoDirectory(dir: string, o: { repoRoot: string }): Promise<PhotoScan> {
  if (!path.isAbsolute(dir)) throw new AcceptanceInputError("--input must be an absolute directory path.");
  const st = await lstat(dir).catch(() => null);
  if (!st) throw new AcceptanceInputError("The photo directory does not exist.");
  if (st.isSymbolicLink()) throw new AcceptanceInputError("The photo directory must not be a link.");
  if (!st.isDirectory()) throw new AcceptanceInputError("--input is not a directory.");
  const real = await realpath(dir);
  if (isWithin(await realpath(o.repoRoot), real))
    throw new AcceptanceInputError(
      "Keep acceptance photographs OUTSIDE the Prism repository (they are private and must never be committed).",
    );

  const skipped = { links: 0, directories: 0, notImages: 0 };
  const candidates: Array<{
    name: string;
    full: string;
    mime: AcceptancePhoto["mime"];
    size: number;
    dims: ReturnType<typeof imageDimensions>;
  }> = [];
  const names = (await readdir(real)).sort(comparePhotoNames);
  for (const name of names) {
    const full = path.join(real, name);
    const ls = await lstat(full);
    if (ls.isSymbolicLink()) {
      skipped.links++;
      continue;
    }
    if (ls.isDirectory()) {
      skipped.directories++;
      continue;
    }
    if (!ls.isFile()) {
      skipped.notImages++;
      continue;
    }
    // a junction or reparse point can still resolve elsewhere: the real path must stay in the directory
    const rp = await realpath(full);
    if (path.dirname(rp) !== real) {
      skipped.links++;
      continue;
    }
    const h = await head(full, 64 * 1024);
    const mime = JPEG(h) ? "image/jpeg" : PNG(h) ? "image/png" : null;
    if (!mime) {
      skipped.notImages++;
      continue;
    }
    if (ls.size > PHOTO_LIMITS.maxBytes)
      throw new AcceptanceInputError(
        `A photograph is larger than ${PHOTO_LIMITS.maxBytes / 1024 / 1024} MB (${candidates.length + 1} in name order).`,
      );
    candidates.push({ name, full: rp, mime, size: ls.size, dims: imageDimensions(h) });
  }
  if (candidates.length < PHOTO_LIMITS.min)
    throw new AcceptanceInputError(
      `Found ${candidates.length} JPEG/PNG photographs; at least ${PHOTO_LIMITS.min} are needed.`,
    );
  if (candidates.length > PHOTO_LIMITS.max)
    throw new AcceptanceInputError(
      `Found ${candidates.length} photographs; at most ${PHOTO_LIMITS.max} are supported.`,
    );

  const photos: AcceptancePhoto[] = [];
  const seen = new Set<string>();
  for (const [ordinal, c] of candidates.entries()) {
    const sha256 = await sha256Of(c.full);
    if (seen.has(sha256))
      throw new AcceptanceInputError(
        `Photograph ${ordinal + 1} (in name order) is a duplicate of an earlier one.`,
      );
    seen.add(sha256);
    // the file must not have changed while it was being read
    if ((await stat(c.full)).size !== c.size)
      throw new AcceptanceInputError(`Photograph ${ordinal + 1} changed while it was being read.`);
    photos.push({
      ordinal,
      path: c.full,
      mime: c.mime,
      byteSize: c.size,
      sha256,
      width: c.dims?.width ?? null,
      height: c.dims?.height ?? null,
    });
  }
  return { photos, totalBytes: photos.reduce((n, p) => n + p.byteSize, 0), skipped };
}

/**
 * The acceptance OUTPUT directory: absolute, outside the repository, not inside (or equal to) the photo directory,
 * and new or empty (a previous run's evidence is never overwritten).
 */
export async function checkOutputDirectory(
  out: string,
  o: { repoRoot: string; inputDir?: string },
): Promise<void> {
  if (!path.isAbsolute(out)) throw new AcceptanceInputError("--output must be an absolute directory path.");
  const resolved = path.resolve(out);
  const repo = await realpath(o.repoRoot);
  if (isWithin(repo, resolved))
    throw new AcceptanceInputError("--output must be outside the Prism repository.");
  if (o.inputDir) {
    const input = await realpath(o.inputDir).catch(() => path.resolve(o.inputDir!));
    if (isWithin(input, resolved) || isWithin(resolved, input))
      throw new AcceptanceInputError("--output must not be inside the photo directory (nor contain it).");
  }
  const st = await lstat(resolved).catch(() => null);
  if (!st) return;
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new AcceptanceInputError("--output exists and is not a plain directory.");
  if ((await readdir(resolved)).length > 0)
    throw new AcceptanceInputError(
      "--output must be a new or empty directory (earlier evidence is never overwritten).",
    );
}
