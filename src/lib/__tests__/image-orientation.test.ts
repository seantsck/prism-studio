import { describe, expect, it } from "vitest";
import { isTurned, readImageSize, readJpegOrientation, swapsSides } from "../image-size";
import { jpegHeader } from "./jpeg-fixture";

describe("the rotation flag a camera writes into a JPEG", () => {
  it("is read in either byte order, for every orientation", () => {
    for (const littleEndian of [false, true])
      for (let orientation = 1; orientation <= 8; orientation++)
        expect(
          readJpegOrientation(jpegHeader({ width: 4032, height: 3024 }, { orientation, littleEndian })),
        ).toBe(orientation);
  });

  it("is found after other header segments, and the stored size is still read", () => {
    const bytes = jpegHeader({ width: 4032, height: 3024 }, { orientation: 6, jfifFirst: true });
    expect(readJpegOrientation(bytes)).toBe(6);
    // the stored layout: the flag does not change what the frame header says
    expect(readImageSize(bytes)).toEqual({ width: 4032, height: 3024 });
  });

  it("is null when there is none, when the value means nothing, or when the bytes are not a JPEG", () => {
    expect(readJpegOrientation(jpegHeader({ width: 800, height: 600 }))).toBeNull();
    expect(readJpegOrientation(jpegHeader({ width: 800, height: 600 }, { orientation: 0 }))).toBeNull();
    expect(readJpegOrientation(jpegHeader({ width: 800, height: 600 }, { orientation: 9 }))).toBeNull();
    expect(readJpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toBeNull();
    expect(readJpegOrientation(new Uint8Array())).toBeNull();
  });

  it("never throws on a file cut short anywhere in its header", () => {
    const whole = jpegHeader({ width: 4032, height: 3024 }, { orientation: 6, littleEndian: true });
    for (let length = 0; length < whole.length; length++)
      expect(() => readJpegOrientation(whole.slice(0, length))).not.toThrow();
    // garbage where the directory offset should be
    const broken = whole.slice();
    broken.set([0xff, 0xff, 0xff, 0x7f], 2 + 4 + 6 + 4);
    expect(readJpegOrientation(broken)).toBeNull();
  });

  it("knows which orientations turn the picture, and which of those swap its sides", () => {
    expect([null, undefined, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((o) => isTurned(o))).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect([1, 2, 3, 4, 5, 6, 7, 8].filter((o) => swapsSides(o))).toEqual([5, 6, 7, 8]);
  });
});
