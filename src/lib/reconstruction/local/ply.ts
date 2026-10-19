import { open, stat } from "node:fs/promises";
import { MAX_SPLAT_GAUSSIANS } from "@/domain/previs/splat";
import { LocalReconstructionError } from "./types";

/**
 * Production Gaussian-splat PLY reader (3DGS layout, as written by Brush and the INRIA reference implementation).
 *
 *   - binary little-endian only; ASCII and big-endian are refused
 *   - exactly one element, `vertex`; list properties are refused
 *   - attributes are found BY NAME (never by position), so property order does not matter
 *   - required: x y z, f_dc_0..2, opacity, scale_0..2, rot_0..3 (each float or double); optional f_rest_0..N-1 with
 *     N ∈ {9, 24, 45} (spherical-harmonics degree 1, 2, 3), contiguous
 *   - other scalar properties (e.g. normals) are allowed and skipped
 *   - the file size must equal header + count × stride exactly (truncated or padded files are refused)
 *   - records are read in fixed-size chunks through ONE reused buffer: a 250 MB PLY is never held in memory
 *   - every essential value must be finite; a zero-length quaternion is refused
 *
 * Semantics (3DGS convention, the one Spark's own PLY reader applies): colour = 0.5 + SH_C0 · f_dc, alpha =
 * sigmoid(opacity), linear scale = exp(scale), rotation quaternion = (w, x, y, z) = (rot_0, rot_1, rot_2, rot_3),
 * f_rest is CHANNEL-major (all red coefficients, then green, then blue).
 */

export const SH_C0 = 0.28209479177387814;
const MAX_HEADER_BYTES = 64 * 1024;
const F_REST_TO_DEGREE: Record<number, number> = { 0: 0, 9: 1, 24: 2, 45: 3 };

type Scalar = "int8" | "uint8" | "int16" | "uint16" | "int32" | "uint32" | "float32" | "float64";
const SCALAR: Record<string, Scalar> = {
  char: "int8",
  int8: "int8",
  uchar: "uint8",
  uint8: "uint8",
  short: "int16",
  int16: "int16",
  ushort: "uint16",
  uint16: "uint16",
  int: "int32",
  int32: "int32",
  uint: "uint32",
  uint32: "uint32",
  float: "float32",
  float32: "float32",
  double: "float64",
  float64: "float64",
};
const SCALAR_BYTES: Record<Scalar, number> = {
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  float32: 4,
  float64: 8,
};

export const REQUIRED_PROPERTIES = [
  "x",
  "y",
  "z",
  "f_dc_0",
  "f_dc_1",
  "f_dc_2",
  "opacity",
  "scale_0",
  "scale_1",
  "scale_2",
  "rot_0",
  "rot_1",
  "rot_2",
  "rot_3",
] as const;

export interface PlyProperty {
  name: string;
  type: Scalar;
  offset: number;
}

export interface GaussianPlyHeader {
  vertexCount: number;
  properties: PlyProperty[];
  /** bytes per Gaussian record */
  stride: number;
  /** byte offset of the first record */
  dataOffset: number;
  fileBytes: number;
  shDegree: number;
  /** number of f_rest_* properties (0, 9, 24 or 45) */
  restCount: number;
}

/** One decoded Gaussian. The SAME object (and arrays) is reused for every record: copy what you keep. */
export interface GaussianRecord {
  index: number;
  x: number;
  y: number;
  z: number;
  /** f_dc_0..2 (raw SH DC coefficients) */
  dc: Float64Array;
  /** f_rest_*, in FILE order (channel-major) */
  rest: Float64Array;
  /** raw opacity (logit) */
  opacity: number;
  /** log scales */
  scale: Float64Array;
  /** rot_0..3 = w, x, y, z (not normalized) */
  rot: Float64Array;
}

export interface GaussianPlyInspection extends GaussianPlyHeader {
  bbox: { min: [number, number, number]; max: [number, number, number] };
  /** largest |coordinate| over all positions */
  maxAbsPosition: number;
  extent: [number, number, number];
  attributes: Record<string, { type: Scalar; offset: number }>;
  /** the largest single read buffer used (bytes) */
  peakChunkBytes: number;
}

const bad = (message: string) => new LocalReconstructionError("ply_invalid", message, "validating_ply");

/** Parses the header from the start of a file. Throws `ply_invalid` with a precise reason. */
export function parseGaussianPlyHeader(
  head: Uint8Array,
  fileBytes: number,
  maxGaussians: number = MAX_SPLAT_GAUSSIANS,
): GaussianPlyHeader {
  const text = new TextDecoder("latin1").decode(head.subarray(0, MAX_HEADER_BYTES));
  if (!text.startsWith("ply\n") && !text.startsWith("ply\r\n")) throw bad("This is not a PLY file.");
  const marker = text.search(/end_header\r?\n/);
  if (marker < 0) throw bad("The PLY header is missing or longer than 64 KB.");
  const dataOffset = marker + (text[marker + 10] === "\r" ? 12 : 11);
  const lines = text
    .slice(0, marker)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let format: string | null = null;
  let vertexCount = -1;
  let elements = 0;
  let inVertex = false;
  const properties: PlyProperty[] = [];
  let offset = 0;
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case "format":
        format = parts[1] ?? "";
        if (parts[2] !== "1.0") throw bad(`Unsupported PLY version "${parts[2] ?? ""}".`);
        break;
      case "comment":
      case "obj_info":
        break;
      case "element": {
        elements++;
        inVertex = parts[1] === "vertex";
        if (!inVertex)
          throw bad(`Unexpected PLY element "${(parts[1] ?? "").slice(0, 32)}" (only "vertex").`);
        const n = Number(parts[2]);
        if (!/^\d+$/.test(parts[2] ?? "") || !Number.isSafeInteger(n))
          throw bad("The vertex count is not valid.");
        vertexCount = n;
        break;
      }
      case "property": {
        if (!inVertex) throw bad("A PLY property appears outside the vertex element.");
        if (parts[1] === "list") throw bad("PLY list properties are not supported for Gaussian splats.");
        const type = SCALAR[parts[1] ?? ""];
        if (!type) throw bad(`Unsupported PLY scalar type "${(parts[1] ?? "").slice(0, 16)}".`);
        const name = parts[2] ?? "";
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw bad("A PLY property has an invalid name.");
        if (properties.some((p) => p.name === name)) throw bad(`The PLY property "${name}" appears twice.`);
        properties.push({ name, type, offset });
        offset += SCALAR_BYTES[type];
        break;
      }
      default:
        throw bad(`Unexpected PLY header line "${line.slice(0, 40)}".`);
    }
  }
  if (format === null) throw bad("The PLY header has no format line.");
  if (format === "ascii") throw bad("ASCII PLY files are not supported (binary little-endian only).");
  if (format !== "binary_little_endian")
    throw bad(`PLY format "${format.slice(0, 32)}" is not supported (binary little-endian only).`);
  if (elements !== 1 || vertexCount < 0) throw bad("A Gaussian PLY must contain exactly one vertex element.");
  if (vertexCount === 0) throw bad("The PLY contains no Gaussians.");
  if (vertexCount > maxGaussians) throw bad(`The PLY has ${vertexCount} Gaussians (limit ${maxGaussians}).`);

  const byName = new Map(properties.map((p) => [p.name, p]));
  const missing = REQUIRED_PROPERTIES.filter((n) => !byName.has(n));
  if (missing.length)
    throw bad(`This PLY is not a Gaussian splat (missing ${missing.slice(0, 4).join(", ")}).`);
  for (const n of REQUIRED_PROPERTIES) {
    const t = byName.get(n)!.type;
    if (t !== "float32" && t !== "float64") throw bad(`The PLY property "${n}" must be float or double.`);
  }
  const restNames = properties.map((p) => p.name).filter((n) => n.startsWith("f_rest_"));
  const restCount = restNames.length;
  const degree = F_REST_TO_DEGREE[restCount];
  if (degree === undefined)
    throw bad(`Unsupported number of spherical-harmonics coefficients (${restCount}).`);
  for (let i = 0; i < restCount; i++) {
    const p = byName.get(`f_rest_${i}`);
    if (!p) throw bad("The PLY's f_rest_* properties are not contiguous.");
    if (p.type !== "float32" && p.type !== "float64")
      throw bad(`The PLY property "f_rest_${i}" must be float or double.`);
  }
  const stride = offset;
  const expected = dataOffset + vertexCount * stride;
  if (fileBytes < expected) throw bad("The PLY is truncated (fewer bytes than its header declares).");
  if (fileBytes > expected) throw bad("The PLY has trailing data after its declared Gaussians.");
  return { vertexCount, properties, stride, dataOffset, fileBytes, shDegree: degree, restCount };
}

function reader(type: Scalar): (v: DataView, o: number) => number {
  switch (type) {
    case "float32":
      return (v, o) => v.getFloat32(o, true);
    case "float64":
      return (v, o) => v.getFloat64(o, true);
    case "int8":
      return (v, o) => v.getInt8(o);
    case "uint8":
      return (v, o) => v.getUint8(o);
    case "int16":
      return (v, o) => v.getInt16(o, true);
    case "uint16":
      return (v, o) => v.getUint16(o, true);
    case "int32":
      return (v, o) => v.getInt32(o, true);
    case "uint32":
      return (v, o) => v.getUint32(o, true);
  }
}

export interface ScanOptions {
  /** Gaussians decoded per read (the read buffer is chunkGaussians × stride bytes) */
  chunkGaussians?: number;
  maxGaussians?: number;
  signal?: AbortSignal;
}

/**
 * Streams every Gaussian of a PLY file through `onGaussian` (one reused record), validating as it goes, and returns
 * the header plus scene statistics. Only one chunk buffer is ever allocated.
 */
export async function scanGaussianPly(
  file: string,
  onGaussian?: (g: GaussianRecord) => void,
  opts: ScanOptions = {},
): Promise<GaussianPlyInspection> {
  const st = await stat(file).catch(() => null);
  if (!st || !st.isFile())
    throw new LocalReconstructionError("ply_missing", "The Gaussian PLY was not produced.", "validating_ply");
  const fh = await open(file, "r");
  try {
    const headBuf = new Uint8Array(Math.min(MAX_HEADER_BYTES, st.size));
    await fh.read(headBuf, 0, headBuf.length, 0);
    const h = parseGaussianPlyHeader(headBuf, st.size, opts.maxGaussians);
    const prop = (n: string) => h.properties.find((p) => p.name === n)!;
    const at = (n: string) => {
      const p = prop(n);
      const r = reader(p.type);
      return (v: DataView, base: number) => r(v, base + p.offset);
    };
    const rx = at("x"),
      ry = at("y"),
      rz = at("z");
    const rdc = [at("f_dc_0"), at("f_dc_1"), at("f_dc_2")];
    const rop = at("opacity");
    const rsc = [at("scale_0"), at("scale_1"), at("scale_2")];
    const rrot = [at("rot_0"), at("rot_1"), at("rot_2"), at("rot_3")];
    const rrest = Array.from({ length: h.restCount }, (_, i) => at(`f_rest_${i}`));

    const chunk = Math.max(1, Math.min(opts.chunkGaussians ?? 16_384, h.vertexCount));
    const buf = new Uint8Array(chunk * h.stride);
    const view = new DataView(buf.buffer);
    const g: GaussianRecord = {
      index: 0,
      x: 0,
      y: 0,
      z: 0,
      dc: new Float64Array(3),
      rest: new Float64Array(h.restCount),
      opacity: 0,
      scale: new Float64Array(3),
      rot: new Float64Array(4),
    };
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let maxAbs = 0;
    let index = 0;
    let pos = h.dataOffset;
    while (index < h.vertexCount) {
      if (opts.signal?.aborted)
        throw new LocalReconstructionError(
          "cancelled",
          "The reconstruction was cancelled.",
          "validating_ply",
        );
      const n = Math.min(chunk, h.vertexCount - index);
      const want = n * h.stride;
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead !== want) throw bad("The PLY ended before all its Gaussians were read.");
      pos += want;
      for (let k = 0; k < n; k++, index++) {
        const b = k * h.stride;
        g.index = index;
        g.x = rx(view, b);
        g.y = ry(view, b);
        g.z = rz(view, b);
        for (let c = 0; c < 3; c++) g.dc[c] = rdc[c]!(view, b);
        g.opacity = rop(view, b);
        for (let c = 0; c < 3; c++) g.scale[c] = rsc[c]!(view, b);
        for (let c = 0; c < 4; c++) g.rot[c] = rrot[c]!(view, b);
        for (let c = 0; c < h.restCount; c++) g.rest[c] = rrest[c]!(view, b);
        if (
          !Number.isFinite(g.x) ||
          !Number.isFinite(g.y) ||
          !Number.isFinite(g.z) ||
          !Number.isFinite(g.opacity) ||
          !g.dc.every(Number.isFinite) ||
          !g.scale.every(Number.isFinite) ||
          !g.rot.every(Number.isFinite) ||
          !g.rest.every(Number.isFinite)
        )
          throw bad(`Gaussian ${index} has a non-finite value.`);
        const qn = g.rot[0]! ** 2 + g.rot[1]! ** 2 + g.rot[2]! ** 2 + g.rot[3]! ** 2;
        if (!(qn > 1e-24)) throw bad(`Gaussian ${index} has a zero-length rotation quaternion.`);
        const p = [g.x, g.y, g.z];
        for (let c = 0; c < 3; c++) {
          if (p[c]! < min[c]!) min[c] = p[c]!;
          if (p[c]! > max[c]!) max[c] = p[c]!;
          const a = Math.abs(p[c]!);
          if (a > maxAbs) maxAbs = a;
        }
        onGaussian?.(g);
      }
    }
    return {
      ...h,
      bbox: { min, max },
      maxAbsPosition: maxAbs,
      extent: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      attributes: Object.fromEntries(h.properties.map((p) => [p.name, { type: p.type, offset: p.offset }])),
      peakChunkBytes: buf.length,
    };
  } finally {
    await fh.close();
  }
}

/** Validation only (no per-Gaussian callback). */
export const inspectGaussianPlyFile = (file: string, opts: ScanOptions = {}) =>
  scanGaussianPly(file, undefined, opts);
