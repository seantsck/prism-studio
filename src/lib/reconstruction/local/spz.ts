import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { SpzWriter } from "@sparkjsdev/spark";
import { MAX_SPLAT_BYTES } from "@/domain/previs/splat";
import { inspectSplat } from "@/lib/splat/inspect";
import { scanGaussianPly, SH_C0, type GaussianPlyInspection } from "./ply";
import { LocalReconstructionError, type SpzConversionReport } from "./types";

/**
 * Production Gaussian PLY → SPZ conversion.
 *
 * The SPZ encoding itself is NOT Prism's: it is `SpzWriter` from `@sparkjsdev/spark` 0.1.10 (MIT), the same package,
 * at the same pinned version, whose `SpzReader` Prism's runtime uses to load splats. Prism only maps 3DGS PLY
 * attributes onto it, exactly as Spark's own PLY reader interprets them, and bounds and validates around it.
 *
 * SPZ is QUANTIZED compression, never lossless:
 *   position   24-bit fixed point; `fractionalBits` is chosen from the scene's real extent so nothing is clipped
 *              (a scene too large to fit is refused, never wrapped or silently clamped)
 *   alpha      sigmoid(opacity), 8 bits
 *   colour     0.5 + SH_C0·f_dc, 8 bits over a fixed range (values outside it are clamped by the format; counted)
 *   scale      exp(scale) stored as 8-bit log over [-10, ~6) (outside: clamped by the format; counted)
 *   rotation   normalized quaternion, "smallest three" 32 bits (SPZ v3)
 *   SH         every degree the PLY has (unless an explicit setting lowers it), 5 bits (degree 1) / 4 bits (2-3)
 *              over [-1, 1) (outside: clamped by the format; counted)
 * Coordinates are written exactly as the PLY has them (no axis conversion), which is also what Spark's own
 * transcoder does, so a converted splat renders in Prism exactly like the PLY it came from.
 *
 * Memory: SpzWriter assembles the whole uncompressed SPZ body in one buffer (16 + n × (20 + SH bytes)). That is
 * bounded by `maxRawBytes` before anything is allocated; the gzip output is streamed to disk.
 */

export const SPZ_ENCODER = "@sparkjsdev/spark@0.1.10 SpzWriter";
export const SPZ_FORMAT_VERSION = 3;
const MAX_FRACTIONAL_BITS = 12;
const MAX_FIXED = 0x7fffff;
const SH_VECS = [0, 3, 8, 15] as const;
/** default upper bound for the uncompressed SPZ body (≈4 M Gaussians at SH degree 3) */
export const DEFAULT_MAX_RAW_BYTES = 256 * 1024 * 1024;

export interface SpzConversionOptions {
  plyPath: string;
  spzPath: string;
  /** lower the SH degree EXPLICITLY (recorded as `shReduced`); default keeps the PLY's degree */
  shDegree?: number;
  /** the splat was trained with anti-aliasing (stored as the SPZ flag the renderer honours) */
  antialiased: boolean;
  maxRawBytes?: number;
  maxSpzBytes?: number;
  chunkGaussians?: number;
  signal?: AbortSignal;
}

export function spzBytesPerGaussian(shDegree: number): number {
  return 9 + 1 + 3 + 3 + 4 + SH_VECS[shDegree]! * 3;
}

/** The largest fractional-bit count that keeps every coordinate inside the signed 24-bit range, or null. */
export function chooseFractionalBits(maxAbsPosition: number): number | null {
  if (!Number.isFinite(maxAbsPosition)) return null;
  if (maxAbsPosition === 0) return MAX_FRACTIONAL_BITS;
  for (let fb = MAX_FRACTIONAL_BITS; fb >= 0; fb--)
    if (Math.round(maxAbsPosition * 2 ** fb) <= MAX_FIXED) return fb;
  return null;
}

const failConversion = (message: string) =>
  new LocalReconstructionError("spz_conversion_failed", message, "converting_spz");

/** The same byte mapping SpzWriter applies, used only to COUNT values the format will clamp. */
const outOfByte = (v: number) => v < -0.5 || v >= 255.5;
const colorByte = (r: number) => ((r - 0.5) / (SH_C0 / 0.15) + 0.5) * 255;
const scaleByte = (logScale: number) => (logScale + 10) * 16;
const shByte = (sh: number) => Math.round(sh * 128) + 128;

export async function convertPlyToSpz(opts: SpzConversionOptions): Promise<{
  report: SpzConversionReport;
  ply: GaussianPlyInspection;
}> {
  const maxRaw = opts.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES;
  const maxSpz = opts.maxSpzBytes ?? MAX_SPLAT_BYTES;
  // pass 1: full validation + the scene extent
  const ply = await scanGaussianPly(opts.plyPath, undefined, {
    chunkGaussians: opts.chunkGaussians,
    signal: opts.signal,
  });
  const shOut = opts.shDegree ?? ply.shDegree;
  if (!Number.isInteger(shOut) || shOut < 0 || shOut > ply.shDegree)
    throw failConversion(`The SH degree ${shOut} cannot be produced from a degree-${ply.shDegree} PLY.`);
  const fractionalBits = chooseFractionalBits(ply.maxAbsPosition);
  if (fractionalBits === null)
    throw failConversion(
      `The scene extends to ${ply.maxAbsPosition.toExponential(2)} units, beyond what SPZ's 24-bit positions can hold.`,
    );
  const rawBytes = 16 + ply.vertexCount * spzBytesPerGaussian(shOut);
  if (rawBytes > maxRaw)
    throw new LocalReconstructionError(
      "result_too_large",
      `Converting ${ply.vertexCount} Gaussians needs ${rawBytes} bytes, above the ${maxRaw} byte conversion limit.`,
      "converting_spz",
    );

  const writer = new SpzWriter({
    numSplats: ply.vertexCount,
    shDegree: shOut,
    fractionalBits,
    flagAntiAlias: opts.antialiased,
  });
  const clamped = { positions: 0, colors: 0, scales: 0, sh: 0 };
  const perChannel = ply.restCount / 3;
  const sh1 = new Float32Array(9);
  const sh2 = new Float32Array(15);
  const sh3 = new Float32Array(21);
  const fill = (target: Float32Array, first: number, count: number, rest: Float64Array) => {
    // PLY f_rest is channel-major (index = coefficient + channel × perChannel); SPZ / Spark interleave channels
    for (let k = 0; k < count; k++)
      for (let c = 0; c < 3; c++) {
        const v = rest[first + k + c * perChannel]!;
        target[k * 3 + c] = v;
        const b = shByte(v);
        if (b < 0 || b > 255) clamped.sh++;
      }
  };
  let written = 0;
  // pass 2: the same records, now encoded
  await scanGaussianPly(
    opts.plyPath,
    (g) => {
      const i = g.index;
      writer.setCenter(i, g.x, g.y, g.z);
      writer.setAlpha(i, 1 / (1 + Math.exp(-g.opacity)));
      const r = 0.5 + SH_C0 * g.dc[0]!;
      const gr = 0.5 + SH_C0 * g.dc[1]!;
      const b = 0.5 + SH_C0 * g.dc[2]!;
      if (outOfByte(colorByte(r)) || outOfByte(colorByte(gr)) || outOfByte(colorByte(b))) clamped.colors++;
      writer.setRgb(i, r, gr, b);
      for (let c = 0; c < 3; c++) if (outOfByte(scaleByte(g.scale[c]!))) clamped.scales++;
      writer.setScale(i, Math.exp(g.scale[0]!), Math.exp(g.scale[1]!), Math.exp(g.scale[2]!));
      // PLY rot_0..3 = (w, x, y, z); SpzWriter takes (x, y, z, w) and normalizes
      writer.setQuat(i, g.rot[1]!, g.rot[2]!, g.rot[3]!, g.rot[0]!);
      if (shOut >= 1) {
        fill(sh1, 0, 3, g.rest);
        if (shOut >= 2) fill(sh2, 3, 5, g.rest);
        if (shOut >= 3) fill(sh3, 8, 7, g.rest);
        writer.setSh(i, sh1, shOut >= 2 ? sh2 : undefined, shOut >= 3 ? sh3 : undefined);
      }
      written++;
    },
    { chunkGaussians: opts.chunkGaussians, signal: opts.signal },
  );
  clamped.positions = writer.clippedCount;
  if (written !== ply.vertexCount) throw failConversion("Not every Gaussian was converted.");
  if (clamped.positions > 0)
    throw failConversion(`${clamped.positions} positions did not fit SPZ's range; nothing was written.`);

  // gzip the SPZ body to disk in slices (the same container SpzWriter.finalize() produces, without a second copy)
  const partial = `${opts.spzPath}.partial`;
  const body = new Uint8Array(writer.buffer);
  try {
    await pipeline(
      Readable.from(
        (function* () {
          for (let o = 0; o < body.length; o += 1 << 20)
            yield body.subarray(o, Math.min(body.length, o + (1 << 20)));
        })(),
      ),
      createGzip({ level: 9 }),
      createWriteStream(partial, { flags: "wx" }),
      { signal: opts.signal },
    );
  } catch (e) {
    await rm(partial, { force: true });
    if (opts.signal?.aborted)
      throw new LocalReconstructionError("cancelled", "The reconstruction was cancelled.", "converting_spz");
    throw failConversion(`Writing the SPZ failed (${(e as Error).message.slice(0, 80)}).`);
  }
  const size = (await stat(partial)).size;
  if (size > maxSpz) {
    await rm(partial, { force: true });
    throw new LocalReconstructionError(
      "result_too_large",
      `The SPZ is ${size} bytes, above Prism's ${maxSpz} byte splat limit. Nothing was decimated.`,
      "converting_spz",
    );
  }
  await rename(partial, opts.spzPath);

  // the converter saying "done" is not enough: the M2D.1 validator must accept the result
  const bytes = await readFile(opts.spzPath);
  const inspected = inspectSplat(bytes, "result.spz");
  if (!inspected.ok)
    throw new LocalReconstructionError(
      "spz_invalid",
      `The converted SPZ is invalid: ${inspected.error}`,
      "validating_spz",
    );
  if (inspected.gaussianCount !== ply.vertexCount)
    throw new LocalReconstructionError(
      "spz_invalid",
      "The converted SPZ has a different Gaussian count.",
      "validating_spz",
    );
  return {
    ply,
    report: {
      encoder: SPZ_ENCODER,
      spzVersion: SPZ_FORMAT_VERSION,
      lossless: false,
      fractionalBits,
      shDegreeIn: ply.shDegree,
      shDegreeOut: shOut,
      shReduced: shOut < ply.shDegree,
      antialiased: opts.antialiased,
      clamped,
      gaussianCount: ply.vertexCount,
      rawBytes,
      byteSize: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
