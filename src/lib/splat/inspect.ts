import { Gunzip } from "fflate";
import {
  MAX_SPLAT_BYTES,
  MAX_SPLAT_GAUSSIANS,
  SPLAT_FORMAT_INFO,
  splatFormatFromFilename,
  type SplatFormat,
} from "@/domain/previs/splat";

/**
 * Structural validation of a Gaussian-splat file. Runs identically in the browser (fast feedback) and on the
 * server (the authority): the server never trusts a filename, a MIME type or the browser's check. Only formats the
 * bundled runtime really parses (and that M2D.1 tests load) are accepted; a PLY must be a *Gaussian* PLY.
 */

export type SplatInspection =
  | { ok: true; format: SplatFormat; mime: string; gaussianCount: number; byteSize: number }
  | { ok: false; error: string };

const fail = (error: string): SplatInspection => ({ ok: false, error });

const SPZ_MAGIC = 0x5053474e; // "NGSP" little-endian
const SH_VECS = [0, 3, 8, 15] as const;

const PLY_TYPE_BYTES: Record<string, number> = {
  char: 1,
  uchar: 1,
  int8: 1,
  uint8: 1,
  short: 2,
  ushort: 2,
  int16: 2,
  uint16: 2,
  int: 4,
  uint: 4,
  int32: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};
const PLY_REQUIRED = [
  "x",
  "y",
  "z",
  "scale_0",
  "scale_1",
  "scale_2",
  "rot_0",
  "rot_1",
  "rot_2",
  "rot_3",
  "opacity",
  "f_dc_0",
  "f_dc_1",
  "f_dc_2",
];
const MAX_PLY_HEADER = 64 * 1024;

function inspectSplatRecords(bytes: Uint8Array): SplatInspection {
  if (bytes.length === 0 || bytes.length % 32 !== 0)
    return fail("This is not a valid .splat file (its size is not a whole number of 32-byte Gaussians).");
  const count = bytes.length / 32;
  if (count > MAX_SPLAT_GAUSSIANS)
    return fail(`This splat has too many Gaussians (limit ${MAX_SPLAT_GAUSSIANS}).`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) {
    const o = i * 32;
    for (let k = 0; k < 6; k++) {
      // position (x,y,z) then scale (x,y,z), little-endian float32
      if (!Number.isFinite(view.getFloat32(o + k * 4, true)))
        return fail("This .splat file contains non-finite positions or scales.");
    }
  }
  return {
    ok: true,
    format: "splat",
    mime: SPLAT_FORMAT_INFO.splat.mime,
    gaussianCount: count,
    byteSize: bytes.length,
  };
}

function inspectGaussianPly(bytes: Uint8Array): SplatInspection {
  const headLen = Math.min(bytes.length, MAX_PLY_HEADER);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, headLen));
  const endIdx = head.indexOf("end_header");
  if (!head.startsWith("ply") || endIdx < 0) return fail("This is not a valid PLY file.");
  const nl = head.indexOf("\n", endIdx);
  if (nl < 0) return fail("This is not a valid PLY file.");
  const dataStart = nl + 1;
  const lines = head
    .slice(0, endIdx)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let format = "";
  let vertexCount = -1;
  let elements = 0;
  const props: Array<{ name: string; bytes: number }> = [];
  let inVertex = false;
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts[0] === "format") format = parts[1] ?? "";
    else if (parts[0] === "element") {
      elements++;
      inVertex = parts[1] === "vertex";
      if (inVertex) vertexCount = Number(parts[2]);
    } else if (parts[0] === "property" && inVertex) {
      if (parts[1] === "list") return fail("PLY list properties are not supported for Gaussian splats.");
      const size = PLY_TYPE_BYTES[parts[1] ?? ""];
      if (!size) return fail(`Unsupported PLY property type "${parts[1]}".`);
      props.push({ name: parts[2] ?? "", bytes: size });
    }
  }
  if (format !== "binary_little_endian")
    return fail(
      "Only binary little-endian PLY files are supported (this one is " + (format || "unknown") + ").",
    );
  if (elements !== 1 || vertexCount < 0 || !Number.isInteger(vertexCount))
    return fail("A Gaussian PLY must contain exactly one 'vertex' element.");
  const names = new Set(props.map((p) => p.name));
  const missing = PLY_REQUIRED.filter((n) => !names.has(n));
  if (missing.length > 0)
    return fail(
      `This PLY is not a Gaussian splat (missing ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? "…" : ""}).`,
    );
  if (vertexCount === 0) return fail("This PLY contains no Gaussians.");
  if (vertexCount > MAX_SPLAT_GAUSSIANS)
    return fail(`This splat has too many Gaussians (limit ${MAX_SPLAT_GAUSSIANS}).`);
  const stride = props.reduce((a, p) => a + p.bytes, 0);
  if (bytes.length !== dataStart + vertexCount * stride)
    return fail("This PLY's size does not match its header (truncated or padded file).");
  return {
    ok: true,
    format: "ply",
    mime: SPLAT_FORMAT_INFO.ply.mime,
    gaussianCount: vertexCount,
    byteSize: bytes.length,
  };
}

function inspectSpz(bytes: Uint8Array): SplatInspection {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b)
    return fail("This is not a valid .spz file (it is not gzip-compressed).");
  // Stream-inflate in small slices and stop as soon as the output disagrees with the header: never inflate a bomb.
  let header: Uint8Array | null = null;
  let expected = -1;
  let total = 0;
  let count = 0;
  let error: string | null = null;
  const collected: number[] = [];
  const gunzip = new Gunzip((chunk) => {
    if (error) return;
    if (!header) {
      for (const b of chunk.subarray(0, 16 - collected.length)) collected.push(b);
      if (collected.length >= 16) {
        header = Uint8Array.from(collected);
        const view = new DataView(header.buffer);
        if (view.getUint32(0, true) !== SPZ_MAGIC)
          return void (error = "This is not a valid .spz file (bad header).");
        const version = view.getUint32(4, true);
        if (version < 2 || version > 3)
          return void (error = `SPZ version ${version} is not supported (versions 2 and 3 are).`);
        count = view.getUint32(8, true);
        const sh = view.getUint8(12);
        if (sh > 3) return void (error = "This .spz has an unsupported spherical-harmonics degree.");
        if (count === 0) return void (error = "This .spz contains no Gaussians.");
        if (count > MAX_SPLAT_GAUSSIANS)
          return void (error = `This splat has too many Gaussians (limit ${MAX_SPLAT_GAUSSIANS}).`);
        const rot = version === 3 ? 4 : 3;
        expected = 16 + count * (9 + 1 + 3 + 3 + rot) + count * SH_VECS[sh]! * 3;
      }
    }
    total += chunk.length;
    if (expected >= 0 && total > expected) error = "This .spz is larger than its header allows.";
  });
  try {
    for (let i = 0; i < bytes.length && !error; i += 65536) {
      gunzip.push(bytes.subarray(i, Math.min(bytes.length, i + 65536)), i + 65536 >= bytes.length);
    }
  } catch {
    return fail("This .spz could not be decompressed (corrupt file).");
  }
  if (error) return fail(error);
  if (!header) return fail("This is not a valid .spz file.");
  if (total !== expected) return fail("This .spz is truncated (its contents do not match its header).");
  return {
    ok: true,
    format: "spz",
    mime: SPLAT_FORMAT_INFO.spz.mime,
    gaussianCount: count,
    byteSize: bytes.length,
  };
}

/**
 * Identify and validate a splat by CONTENT. The filename only has to agree with what the bytes are, so a renamed
 * file is refused with a clear message instead of being half-parsed by the runtime.
 */
export function inspectSplat(bytes: Uint8Array, filename: string): SplatInspection {
  if (bytes.length === 0) return fail("The file is empty.");
  if (bytes.length > MAX_SPLAT_BYTES)
    return fail(`This file is larger than the ${Math.round(MAX_SPLAT_BYTES / 1024 / 1024)} MB splat limit.`);
  const declared = splatFormatFromFilename(filename);
  if (!declared) return fail("Unsupported file type. Choose a .splat, .spz or Gaussian .ply file.");
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const isPly = bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79; // "ply"
  const actual: SplatFormat = isGzip ? "spz" : isPly ? "ply" : "splat";
  if (actual !== declared)
    return fail(
      `This file is named .${declared} but its contents look like ${actual === "splat" ? "a raw .splat" : actual}.`,
    );
  return declared === "spz"
    ? inspectSpz(bytes)
    : declared === "ply"
      ? inspectGaussianPly(bytes)
      : inspectSplatRecords(bytes);
}
