/**
 * The header of a JPEG, as a camera writes it: the EXIF orientation flag, then the frame's stored dimensions. No
 * picture data follows, which is all the server reads of an upload (it never decodes pixels). `stored` is the layout
 * of the bytes; a portrait phone photograph is typically stored landscape with orientation 6.
 */
export function jpegHeader(
  stored: { width: number; height: number },
  opts: { orientation?: number | null; littleEndian?: boolean; jfifFirst?: boolean } = {},
): Uint8Array {
  const little = opts.littleEndian ?? false;
  const u16 = (n: number, le = false) => (le ? [n & 0xff, (n >> 8) & 0xff] : [(n >> 8) & 0xff, n & 0xff]);
  const u32 = (n: number, le = false) =>
    le
      ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
      : [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const out: number[] = [0xff, 0xd8];
  if (opts.jfifFirst)
    out.push(0xff, 0xe0, ...u16(16), 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, ...u16(1), ...u16(1), 0, 0);
  if (opts.orientation != null) {
    const tiff = [
      ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
      ...u16(42, little),
      ...u32(8, little),
      ...u16(1, little), // one entry
      ...u16(0x0112, little), // Orientation
      ...u16(3, little), // SHORT
      ...u32(1, little),
      ...u16(opts.orientation, little),
      0,
      0,
      ...u32(0, little), // no further directory
    ];
    out.push(0xff, 0xe1, ...u16(2 + 6 + tiff.length), 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff);
  }
  out.push(
    ...[0xff, 0xc0, ...u16(17), 8, ...u16(stored.height), ...u16(stored.width), 3],
    ...[1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    ...[0xff, 0xd9],
  );
  return new Uint8Array(out);
}
