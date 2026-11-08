import { deflateSync, inflateSync } from "node:zlib";

/**
 * Phase 5B-I3: a small, dependency-free PNG codec for the local matting path (node:zlib only).
 *
 *  decode  8-bit, non-interlaced PNG: grayscale (0), RGB (2), palette (3, with tRNS), gray+alpha (4), RGBA (6).
 *          Anything else (16-bit, Adam7 interlace, sub-byte depths) is refused with a clear reason, never guessed.
 *  encode  RGBA, 8-bit, filter 0, deterministic (same pixels → same bytes → same checksum).
 */
export interface RgbaImage {
  width: number;
  height: number;
  /** width × height × 4 bytes, row-major, straight (non-premultiplied) alpha. */
  data: Uint8Array;
}

export class PngError extends Error {}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Refuse absurd sizes before allocating (a 1.5 GB RGBA buffer is a denial-of-service, not an image). */
export const MAX_PIXELS = 40_000_000;

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

interface Chunk {
  type: string;
  data: Buffer;
}

function chunks(bytes: Uint8Array): Chunk[] {
  if (!isPng(bytes)) throw new PngError("Not a PNG file.");
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Chunk[] = [];
  let o = 8;
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    if (o + 12 + len > buf.length) throw new PngError("Truncated PNG chunk.");
    out.push({ type, data: buf.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
    if (type === "IEND") break;
  }
  return out;
}

/** True when the PNG can carry transparency (an alpha channel or a tRNS chunk). Cheap: reads only the chunk list. */
export function pngHasAlpha(bytes: Uint8Array): boolean {
  try {
    const cs = chunks(bytes);
    const ihdr = cs.find((c) => c.type === "IHDR");
    if (!ihdr) return false;
    const colorType = ihdr.data[9];
    return colorType === 4 || colorType === 6 || cs.some((c) => c.type === "tRNS");
  } catch {
    return false;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  const cs = chunks(bytes);
  const ihdr = cs.find((c) => c.type === "IHDR");
  if (!ihdr || ihdr.data.length < 13) throw new PngError("PNG has no header.");
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8]!;
  const colorType = ihdr.data[9]!;
  const interlace = ihdr.data[12]!;
  if (width < 1 || height < 1) throw new PngError("PNG has no pixels.");
  if (width * height > MAX_PIXELS) throw new PngError("The image is too large to process.");
  if (depth !== 8) throw new PngError("Only 8-bit PNG images are supported.");
  if (interlace !== 0) throw new PngError("Interlaced PNG images are not supported.");
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new PngError("Unsupported PNG colour type.");
  const palette = cs.find((c) => c.type === "PLTE")?.data;
  const trns = cs.find((c) => c.type === "tRNS")?.data;
  if (colorType === 3 && !palette) throw new PngError("Palette PNG without a palette.");

  const raw = inflateSync(Buffer.concat(cs.filter((c) => c.type === "IDAT").map((c) => c.data)));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new PngError("PNG image data is incomplete.");
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= channels ? px[dst + x - channels]! : 0;
      const b = y > 0 ? px[dst - stride + x]! : 0;
      const c = x >= channels && y > 0 ? px[dst - stride + x - channels]! : 0;
      let r: number;
      switch (filter) {
        case 0:
          r = v;
          break;
        case 1:
          r = v + a;
          break;
        case 2:
          r = v + b;
          break;
        case 3:
          r = v + ((a + b) >> 1);
          break;
        case 4:
          r = v + paeth(a, b, c);
          break;
        default:
          throw new PngError("Corrupt PNG filter.");
      }
      px[dst + x] = r & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    const o = i * 4;
    switch (colorType) {
      case 6:
        data[o] = px[p]!;
        data[o + 1] = px[p + 1]!;
        data[o + 2] = px[p + 2]!;
        data[o + 3] = px[p + 3]!;
        break;
      case 2: {
        data[o] = px[p]!;
        data[o + 1] = px[p + 1]!;
        data[o + 2] = px[p + 2]!;
        const key =
          trns && trns.length >= 6
            ? trns.readUInt16BE(0) === px[p] &&
              trns.readUInt16BE(2) === px[p + 1] &&
              trns.readUInt16BE(4) === px[p + 2]
            : false;
        data[o + 3] = key ? 0 : 255;
        break;
      }
      case 0: {
        const g = px[p]!;
        data[o] = data[o + 1] = data[o + 2] = g;
        data[o + 3] = trns && trns.length >= 2 && trns.readUInt16BE(0) === g ? 0 : 255;
        break;
      }
      case 4:
        data[o] = data[o + 1] = data[o + 2] = px[p]!;
        data[o + 3] = px[p + 1]!;
        break;
      case 3: {
        const idx = px[p]!;
        if (idx * 3 + 2 >= palette!.length) throw new PngError("PNG palette index out of range.");
        data[o] = palette![idx * 3]!;
        data[o + 1] = palette![idx * 3 + 1]!;
        data[o + 2] = palette![idx * 3 + 2]!;
        data[o + 3] = trns && idx < trns.length ? trns[idx]! : 255;
        break;
      }
    }
  }
  return { width, height, data };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  let c = 0xffffffff;
  for (const b of out.subarray(4, 8 + data.length)) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

export function encodePngRgba(img: RgbaImage): Uint8Array {
  const { width, height, data } = img;
  if (data.length !== width * height * 4) throw new PngError("RGBA buffer does not match the image size.");
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(SIGNATURE),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw, { level: 6 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
