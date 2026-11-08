import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { composeCutout, MattingRefusal } from "../matting/engine";
import { busyFixturePng, FIXTURE_BACKGROUND, portraitFixture, portraitFixturePng } from "../matting/fixture";
import { plainBackgroundKeyer } from "../matting/keyer";
import { decodePng, encodePngRgba, pngHasAlpha, PngError } from "../matting/png";
import { encodeMockPng } from "../providers/mock-image";
import { encodeRgbaPng } from "../providers/openai-image/fake-transport";

/** Phase 5B-I3: the dependency-free PNG codec and the plain-background keyer (pure, no I/O). */
function pngWith(
  ihdr: { w: number; h: number; depth: number; color: number; interlace?: number },
  raw: Buffer,
  extra: Buffer[] = [],
) {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    return out; // CRC is not checked by the decoder
  };
  const h = Buffer.alloc(13);
  h.writeUInt32BE(ihdr.w, 0);
  h.writeUInt32BE(ihdr.h, 4);
  h[8] = ihdr.depth;
  h[9] = ihdr.color;
  h[12] = ihdr.interlace ?? 0;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", h),
      ...extra,
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

describe("PNG codec", () => {
  it("round-trips RGBA exactly and is deterministic", () => {
    const img = portraitFixture(40, 50);
    const a = encodePngRgba(img);
    expect(decodePng(a)).toEqual(img);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(encodePngRgba(img)))).toBe(0);
  });

  it("decodes RGB (the mock provider's output), RGBA with alpha, and palette with tRNS", () => {
    const rgb = decodePng(encodeMockPng(20, 10, 7));
    expect([rgb.width, rgb.height]).toEqual([20, 10]);
    expect(rgb.data[3]).toBe(255);
    const rgba = decodePng(encodeRgbaPng(16, 16));
    expect(rgba.data[3]).toBe(0); // the fake transport's transparent corner
    // 2×1 palette image: index 0 transparent red, index 1 opaque blue
    const plte = Buffer.from([255, 0, 0, 0, 0, 255]);
    const chunk = (type: string, d: Buffer) => {
      const o = Buffer.alloc(12 + d.length);
      o.writeUInt32BE(d.length, 0);
      o.write(type, 4, "ascii");
      d.copy(o, 8);
      return o;
    };
    const pal = decodePng(
      pngWith({ w: 2, h: 1, depth: 8, color: 3 }, Buffer.from([0, 0, 1]), [
        chunk("PLTE", plte),
        chunk("tRNS", Buffer.from([0])),
      ]),
    );
    expect(Array.from(pal.data)).toEqual([255, 0, 0, 0, 0, 0, 255, 255]);
  });

  it("refuses what it does not support, with a reason (16-bit, interlaced, not a PNG)", () => {
    expect(() => decodePng(pngWith({ w: 1, h: 1, depth: 16, color: 2 }, Buffer.alloc(7)))).toThrow(/8-bit/);
    expect(() =>
      decodePng(pngWith({ w: 1, h: 1, depth: 8, color: 2, interlace: 1 }, Buffer.alloc(4))),
    ).toThrow(/Interlaced/);
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(PngError);
  });

  it("reports transparency from the bytes", () => {
    expect(pngHasAlpha(encodeRgbaPng(16, 16))).toBe(true);
    expect(pngHasAlpha(encodeMockPng(16, 16, 1))).toBe(false);
    expect(pngHasAlpha(new Uint8Array([0, 1]))).toBe(false);
  });
});

describe("plain-background keyer", () => {
  it("removes a plain background with soft edges, keeps every RGB value, keeps enclosed near-background areas", () => {
    const src = decodePng(portraitFixturePng());
    const matte = plainBackgroundKeyer.matte(src);
    expect(matte.kind).toBe("soft");
    const cut = composeCutout(src, matte);
    expect(cut.data.length).toBe(src.data.length);
    for (let i = 0; i < src.width * src.height; i++)
      for (let c = 0; c < 3; c++) expect(cut.data[i * 4 + c]).toBe(src.data[i * 4 + c]);
    expect(cut.data[3]).toBe(0); // a background corner
    const face = (Math.round(src.height * 0.32) * src.width + src.width / 2) * 4 + 3;
    expect(cut.data[face]).toBe(255);
    const collar = (Math.round(src.height * 0.62) * src.width + src.width / 2) * 4 + 3;
    expect(cut.data[collar]).toBe(255);
    expect(matte.details).toMatchObject({ background: [...FIXTURE_BACKGROUND] });
    const softCount = Array.from(matte.alpha).filter((a) => a > 0 && a < 255).length;
    expect(softCount).toBeGreaterThan(100);
  });

  it("is deterministic", () => {
    const src = decodePng(portraitFixturePng());
    expect(plainBackgroundKeyer.matte(src).alpha).toEqual(plainBackgroundKeyer.matte(src).alpha);
  });

  it("refuses a busy background instead of producing a bad cutout", () => {
    expect(() => plainBackgroundKeyer.matte(decodePng(busyFixturePng()))).toThrow(MattingRefusal);
    try {
      plainBackgroundKeyer.matte(decodePng(busyFixturePng()));
    } catch (e) {
      expect((e as MattingRefusal).code).toBe("background_not_plain");
    }
  });

  it("refuses an image that is only background", () => {
    const flat = new Uint8Array(64 * 64 * 4).fill(200);
    expect(() => plainBackgroundKeyer.matte({ width: 64, height: 64, data: flat })).toThrow(/No subject/);
  });

  it("an already-transparent source pixel never becomes more opaque", () => {
    const src = decodePng(portraitFixturePng(64, 80));
    src.data[(40 * 64 + 32) * 4 + 3] = 10; // inside the subject
    const cut = composeCutout(src, plainBackgroundKeyer.matte(src));
    expect(cut.data[(40 * 64 + 32) * 4 + 3]).toBe(10);
  });
});
