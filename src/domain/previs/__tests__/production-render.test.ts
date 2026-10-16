import { describe, expect, it } from "vitest";
import { bookmarkFromCamera, productionRenderSpec } from "../camera";
import type { PrevisCamera } from "../types";

const cam: PrevisCamera = {
  id: "cam",
  label: "CAM-A",
  position: { x: 1.2, y: 1.6, z: 7 },
  rotation: { x: -0.1, y: 0.35, z: 0 },
  focalLengthMm: 50,
};

describe("productionRenderSpec", () => {
  it("is derived only from the frozen bookmark: pose, lens on the declared basis, production aspect", () => {
    const spec = productionRenderSpec(bookmarkFromCamera(cam));
    expect(spec.position).toEqual(cam.position);
    expect(spec.rotation).toEqual(cam.rotation);
    // 50 mm on the 24 mm vertical basis
    expect(spec.fovVerticalDegrees).toBeCloseTo(27.0, 0);
    expect(spec.width).toBe(1912);
    expect(spec.height).toBe(800);
    expect(spec.aspect).toBeCloseTo(2.39, 2);
  });

  it("refuses an unknown basis, projection or a non-positive focal length", () => {
    const b = bookmarkFromCamera(cam);
    expect(() => productionRenderSpec({ ...b, focalLengthBasis: "full-frame" as never })).toThrow(/basis/);
    expect(() => productionRenderSpec({ ...b, projection: "orthographic" as never })).toThrow(/projection/);
    expect(() => productionRenderSpec({ ...b, focalLengthMm: 0 })).toThrow(/focal length/);
  });

  it("does not alias the bookmark", () => {
    const b = bookmarkFromCamera(cam);
    const spec = productionRenderSpec(b);
    spec.position.x = 99;
    expect(b.position.x).toBe(1.2);
  });
});
