import { describe, expect, it } from "vitest";
import {
  attemptTransportGeometry,
  containPadGeometry,
  parseFrozenStartFrameTransport,
  planPrepadCenterCrop,
  prepadTransportErrors,
  PREPAD_CENTER_CROP_POLICY,
  type FrozenPrepadCenterCropTransport,
} from "@/domain/framing/transport";

const CROP = {
  behavior: "center" as const,
  source: "https://docs.dev.runwayml.com/assets/inputs/",
  verifiedAt: "2026-11-10",
};
const GEN45 = { min: 0.5, max: 2 };
const SHOT_3A = { width: 1536, height: 642 };
const OUT_21_9 = { width: 1584, height: 672 };
const ID = "b279371a-7376-4573-a88b-62cf614cdc25";

const plan = (
  source = SHOT_3A,
  outputCanvas = OUT_21_9,
  aspectRange = GEN45,
  providerCrop: typeof CROP | null = CROP,
) => planPrepadCenterCrop({ source, outputCanvas, aspectRange, providerCrop });

const frozen = (): FrozenPrepadCenterCropTransport => {
  const p = plan();
  if (!p.ok) throw new Error(p.reason);
  return {
    version: 1,
    policy: PREPAD_CENTER_CROP_POLICY,
    sourceAssetId: ID,
    background: "black",
    ...p.geometry,
  };
};

describe("contain-prepad-center-crop-v1 (Gen-4.5 wide start frames)", () => {
  it("Shot 3A: 1536×642 → 1584×662 at 0,65 on a 1584×792 (2:1) prompt image; centre crop 0,60 1584×672 → 0,5", () => {
    const p = plan();
    expect(p).toEqual({
      ok: true,
      geometry: {
        source: { width: 1536, height: 642 },
        content: { width: 1584, height: 662 },
        submittedCanvas: { width: 1584, height: 792 },
        submittedOffset: { x: 0, y: 65 },
        providerCrop: CROP,
        outputCanvas: { width: 1584, height: 672 },
        expectedCrop: { x: 0, y: 60, width: 1584, height: 672 },
        effectiveContent: { x: 0, y: 5, width: 1584, height: 662 },
      },
    });
    if (!p.ok) return;
    expect(p.geometry.submittedCanvas.width / p.geometry.submittedCanvas.height).toBe(2);
    // 65 synthetic rows above, 792 − 65 − 662 = 65 below; the crop removes 60 + 60 of them, leaving 5 + 5
    expect(p.geometry.submittedCanvas.height - p.geometry.submittedOffset.y - p.geometry.content.height).toBe(
      65,
    );
    expect(OUT_21_9.height - p.geometry.effectiveContent.y - p.geometry.effectiveContent.height).toBe(5);
  });

  it("reproduces exactly the validated Gen-4 Turbo (contain-pad-v1) effective geometry", () => {
    const p = plan();
    const turbo = containPadGeometry(SHOT_3A, OUT_21_9);
    expect(p.ok && p.geometry.effectiveContent).toEqual({
      x: turbo.x,
      y: turbo.y,
      width: turbo.width,
      height: turbo.height,
    });
  });

  it("never crops the canonical picture: the expected crop contains the whole scaled picture", () => {
    const p = plan();
    if (!p.ok) throw new Error(p.reason);
    const g = p.geometry;
    expect(g.content.width / g.content.height).toBeCloseTo(SHOT_3A.width / SHOT_3A.height, 2);
    expect(g.submittedOffset.y).toBeGreaterThanOrEqual(g.expectedCrop.y);
    expect(g.submittedOffset.y + g.content.height).toBeLessThanOrEqual(
      g.expectedCrop.y + g.expectedCrop.height,
    );
    expect(g.submittedOffset.x).toBeGreaterThanOrEqual(g.expectedCrop.x);
    expect(g.submittedOffset.x + g.content.width).toBeLessThanOrEqual(
      g.expectedCrop.x + g.expectedCrop.width,
    );
  });

  it("is not used when the output canvas is already inside the input range (wide but ≤ 2:1, or Turbo's 2.358)", () => {
    expect(plan(SHOT_3A, { width: 1280, height: 720 })).toEqual({
      ok: false,
      reason: expect.stringContaining("contain-pad-v1 applies"),
    });
    expect(plan(SHOT_3A, OUT_21_9, { min: 0.5, max: 2.358 }).ok).toBe(false);
  });

  it("portrait/narrow outputs pad columns symmetrically (generic, not Shot-specific)", () => {
    const p = plan({ width: 642, height: 1536 }, { width: 672, height: 1584 });
    expect(p).toMatchObject({
      ok: true,
      geometry: {
        content: { width: 662, height: 1584 },
        submittedCanvas: { width: 792, height: 1584 },
        submittedOffset: { x: 65, y: 0 },
        expectedCrop: { x: 60, y: 0, width: 672, height: 1584 },
        effectiveContent: { x: 5, y: 0, width: 662, height: 1584 },
      },
    });
  });

  it("a changed input range changes eligibility and geometry deterministically", () => {
    const narrow = plan(SHOT_3A, OUT_21_9, { min: 0.5, max: 1 });
    expect(narrow).toMatchObject({
      ok: true,
      geometry: {
        submittedCanvas: { width: 1584, height: 1584 },
        expectedCrop: { x: 0, y: 456, width: 1584, height: 672 },
        submittedOffset: { x: 0, y: 461 },
        effectiveContent: { x: 0, y: 5, width: 1584, height: 662 },
      },
    });
    expect(plan(SHOT_3A, OUT_21_9, { min: 0.5, max: 1 })).toEqual(narrow);
    expect(plan()).toEqual(plan());
  });

  it("refuses without a provider-documented centre crop, or without a documented range", () => {
    expect(plan(SHOT_3A, OUT_21_9, GEN45, null)).toEqual({
      ok: false,
      reason: expect.stringContaining("centre crop"),
    });
    expect(
      planPrepadCenterCrop({ source: SHOT_3A, outputCanvas: OUT_21_9, aspectRange: null, providerCrop: CROP })
        .ok,
    ).toBe(false);
  });

  it("refuses when the picture would need a different scale on the submitted canvas (crop could not be padding-only)", () => {
    // a square source is height-limited on 1584×672 but would grow on 1584×792
    expect(plan({ width: 1000, height: 1000 })).toEqual({
      ok: false,
      reason: expect.stringContaining("scaled differently"),
    });
  });

  it("freezes, parses and re-derives the record; tampering is detected", () => {
    const t = frozen();
    expect(parseFrozenStartFrameTransport(JSON.parse(JSON.stringify(t)))).toEqual(t);
    expect(prepadTransportErrors(t, GEN45, CROP)).toEqual([]);
    expect(prepadTransportErrors({ ...t, submittedOffset: { x: 0, y: 64 } }, GEN45, CROP)).toEqual([
      "The frozen pre-pad transport geometry does not match its own re-derivation.",
    ]);
    expect(
      prepadTransportErrors({ ...t, expectedCrop: { x: 0, y: 59, width: 1584, height: 672 } }, GEN45, CROP),
    ).not.toEqual([]);
    expect(prepadTransportErrors(t, { min: 0.5, max: 2.358 }, CROP)).not.toEqual([]);
    expect(prepadTransportErrors(t, GEN45, null)).not.toEqual([]);
    expect(parseFrozenStartFrameTransport({ ...t, submittedOffset: { x: 0, y: -1 } })).toBeNull();
    expect(parseFrozenStartFrameTransport({ ...t, providerCrop: { behavior: "resize" } })).toBeNull();
  });

  it("delivery conform gets the effective rect on the OUTPUT canvas, only for the frozen, unchanged source", () => {
    const t = frozen();
    const geometry = (size = SHOT_3A, record: unknown = t) =>
      attemptTransportGeometry({
        providerOptions: { prismStartFrameTransport: record },
        inputAssetIds: [ID],
        sourceSize: () => size,
      });
    expect(geometry()).toEqual({
      policy: PREPAD_CENTER_CROP_POLICY,
      sourceAssetId: ID,
      canvas: { width: 1584, height: 672 },
      content: { x: 0, y: 5, width: 1584, height: 662 },
    });
    expect(geometry({ width: 1536, height: 640 })).toBeNull();
    expect(
      geometry(SHOT_3A, { ...t, effectiveContent: { x: 0, y: 4, width: 1584, height: 662 } }),
    ).toBeNull();
  });
});
