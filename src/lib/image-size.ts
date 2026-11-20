/** Reads pixel dimensions from PNG / JPEG / GIF / WebP headers without decoding the image. */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (o: number, n: number) => String.fromCharCode(...bytes.slice(o, o + n));

  // PNG: signature + IHDR
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, 3) === "PNG") {
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  // GIF
  if (bytes.length >= 10 && ascii(0, 3) === "GIF") {
    return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
  }
  // WebP
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const kind = ascii(12, 4);
    if (kind === "VP8X") {
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width: w, height: h };
    }
    if (kind === "VP8 ")
      return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    if (kind === "VP8L") {
      const bits = v.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  // JPEG: scan markers for a start-of-frame segment
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) return null;
      const marker = bytes[o + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        o += 2;
        continue;
      }
      const len = v.getUint16(o + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: v.getUint16(o + 5), width: v.getUint16(o + 7) };
      o += 2 + len;
    }
  }
  return null;
}

/**
 * The EXIF orientation (1 to 8) a JPEG carries, or null when it carries none or the bytes are not a JPEG. A camera
 * usually stores a portrait photograph turned on its side plus this flag: a viewer that honours the flag shows it
 * upright, a tool that ignores it sees it sideways. Only the header segments are read; no pixel is decoded.
 */
export function readJpegOrientation(bytes: Uint8Array): number | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 2;
  while (o + 4 <= bytes.length) {
    if (bytes[o] !== 0xff) return null;
    const marker = bytes[o + 1]!;
    // the picture data starts: EXIF, when present, comes before it
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      o += marker === 0xff ? 1 : 2;
      continue;
    }
    const size = v.getUint16(o + 2);
    if (size < 2) return null;
    const start = o + 4;
    const end = Math.min(o + 2 + size, bytes.length);
    const isExif =
      marker === 0xe1 &&
      end - start >= 14 &&
      String.fromCharCode(...bytes.slice(start, start + 4)) === "Exif" &&
      bytes[start + 4] === 0 &&
      bytes[start + 5] === 0;
    if (isExif) return tiffOrientation(v, start + 6, end);
    o += 2 + size;
  }
  return null;
}

/** Tag 0x0112 of the first image directory of a TIFF block (the body of an EXIF segment). */
function tiffOrientation(v: DataView, tiff: number, end: number): number | null {
  const order = v.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const little = order === 0x4949;
  if (v.getUint16(tiff + 2, little) !== 42) return null;
  const ifd = tiff + v.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return null;
  const entries = v.getUint16(ifd, little);
  for (let i = 0; i < entries; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return null;
    if (v.getUint16(entry, little) !== 0x0112) continue;
    const value = v.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

/** true: the orientation turns or mirrors the stored pixels (anything but "upright as stored"). */
export const isTurned = (orientation: number | null | undefined): boolean =>
  typeof orientation === "number" && orientation >= 2 && orientation <= 8;

/** true: the orientation swaps width and height when it is honoured (a quarter turn). */
export const swapsSides = (orientation: number | null | undefined): boolean =>
  typeof orientation === "number" && orientation >= 5 && orientation <= 8;
