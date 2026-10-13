import { describe, expect, it } from "vitest";
import {
  buildAdaptationPlan,
  nextSupportedDuration,
  parseAdaptationPlan,
  type AdaptationInput,
} from "../adaptation";
import { derivationKey, resolveConform } from "../conform";
import { centerCrop, padToFrame } from "../crop";
import { formatRatio, parseAspectRatio, sameRatio } from "../ratio";

const R169 = ["16:9", "9:16"];

const input = (over: Partial<AdaptationInput> = {}): AdaptationInput => ({
  video: true,
  production: { aspectRatio: "2.39:1", durationMs: 4500, fps: 24 },
  provider: {
    provider: "p",
    modelId: "m",
    aspectRatios: R169,
    requestedResolution: null,
    maxResolution: { width: 1280, height: 720 },
    duration: { minMs: 2000, maxMs: 10000, stepMs: 1000, allowedMs: null },
  },
  protectedNotes: [],
  ...over,
});

describe("aspect ratio parsing", () => {
  it("parses common forms", () => {
    expect(parseAspectRatio("2.39:1")!.value).toBeCloseTo(2.39);
    expect(parseAspectRatio("16:9")!.value).toBeCloseTo(16 / 9);
    expect(parseAspectRatio("16/9")!.value).toBeCloseTo(16 / 9);
    expect(parseAspectRatio("1280x720")!.value).toBeCloseTo(16 / 9);
    expect(parseAspectRatio("2.39")!.value).toBeCloseTo(2.39);
  });
  it("rejects garbage and zero", () => {
    for (const bad of ["", "abc", "0:1", "1:0", "-1:1", null, undefined]) {
      expect(parseAspectRatio(bad as string | null)).toBeNull();
    }
  });
  it("treats 1280x536 as 2.39:1 within tolerance, but not 21:9", () => {
    expect(sameRatio(1280 / 536, 2.39)).toBe(true);
    expect(sameRatio(21 / 9, 2.39)).toBe(false);
  });
  it("keeps the author's label", () => {
    expect(formatRatio(2.39, "2.39:1")).toBe("2.39:1");
    expect(formatRatio(16 / 9)).toBe("16:9");
  });
});

describe("crop math", () => {
  it("16:9 → 2.39:1 on 1280×720 is integer, even and centred", () => {
    const c = centerCrop({ width: 1280, height: 720 }, 2.39);
    expect(c.axis).toBe("vertical");
    expect(c.rect).toEqual({ x: 0, y: 92, width: 1280, height: 536 });
    expect(c.rect.height % 2).toBe(0);
    expect(c.rect.y % 2).toBe(0);
    expect(c.discardedFraction).toBeCloseTo(0.2556, 3);
    expect(c.actualRatio).toBeCloseTo(2.388, 2);
  });
  it("native ratio is returned whole", () => {
    const c = centerCrop({ width: 1920, height: 1080 }, 16 / 9);
    expect(c.axis).toBe("none");
    expect(c.rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(c.discardedFraction).toBe(0);
  });
  it("4:3 → 16:9 removes top/bottom", () => {
    const c = centerCrop({ width: 1440, height: 1080 }, 16 / 9);
    expect(c.axis).toBe("vertical");
    expect(c.rect.width).toBe(1440);
    expect(c.rect.height).toBe(810);
    expect(c.rect.y).toBe(134); // floor(270/4)*2
  });
  it("a narrow canvas cropped to a wide ratio removes a lot of height", () => {
    const c = centerCrop({ width: 720, height: 1280 }, 2.39);
    expect(c.discardedFraction).toBeGreaterThan(0.7);
  });
  it("wider canvas → narrower target removes left/right", () => {
    const c = centerCrop({ width: 2560, height: 1080 }, 16 / 9);
    expect(c.axis).toBe("horizontal");
    expect(c.rect.height).toBe(1080);
    expect(c.rect.width).toBe(1920);
    expect(c.rect.x).toBe(320);
  });
  it("never leaves the canvas for odd sizes", () => {
    for (const [w, h] of [
      [1279, 719],
      [1001, 563],
      [641, 361],
      [853, 479],
    ] as const) {
      const c = centerCrop({ width: w, height: h }, 2.39);
      expect(c.rect.x).toBeGreaterThanOrEqual(0);
      expect(c.rect.y).toBeGreaterThanOrEqual(0);
      expect(c.rect.x + c.rect.width).toBeLessThanOrEqual(w);
      expect(c.rect.y + c.rect.height).toBeLessThanOrEqual(h);
    }
  });
  it("letterbox / pillarbox pad without scaling", () => {
    const l = padToFrame({ width: 1280, height: 720 }, 2.39); // picture narrower than the frame
    expect(l.mode).toBe("pillarbox");
    expect(l.frame.height).toBe(720);
    expect(l.frame.width).toBe(1720);
    expect(l.placement.x).toBe(220);
    const p = padToFrame({ width: 1280, height: 720 }, 4 / 3);
    expect(p.mode).toBe("letterbox");
    expect(p.frame.width).toBe(1280);
    expect(p.frame.height).toBe(960);
    expect(p.placement.y).toBe(120);
    expect(p.barFraction).toBeCloseTo(0.25, 3);
  });
});

describe("generation adaptation plan", () => {
  it("native when the provider offers the production ratio and duration", () => {
    const p = buildAdaptationPlan(
      input({
        production: { aspectRatio: "16:9", durationMs: 5000, fps: 24 },
      }),
    );
    expect(p.status).toBe("native");
    expect(p.acknowledgements).toHaveLength(0);
    expect(p.conform.required).toBe(false);
  });

  it("does NOT pick a strategy by itself: needs_choice, with a recommendation", () => {
    const p = buildAdaptationPlan(input());
    expect(p.status).toBe("needs_choice");
    expect(p.framing.strategy).toBe("blocked");
    expect(p.framing.recommended).toBe("overscan_for_crop");
    expect(p.duration.recommended).toBe("generate_longer_then_trim");
    expect(p.blockedReasons.length).toBeGreaterThan(0);
  });

  it("2.39 on 16:9 with overscan + trim: the acceptance scenario", () => {
    const p = buildAdaptationPlan(
      input({
        provider: {
          ...input().provider,
          duration: { minMs: 5000, maxMs: 10000, stepMs: null, allowedMs: [5000, 10000] },
        },
        choice: { framing: "overscan_for_crop", duration: "generate_longer_then_trim" },
        protectedNotes: ["Yumeko's eyes inside the crop"],
      }),
    );
    expect(p.status).toBe("adapted");
    expect(p.framing.providerLabel).toBe("16:9");
    expect(p.framing.discardedFraction).toBeCloseTo(0.2556, 3);
    expect(p.framing.retained).toMatchObject({ x: 0, width: 1 });
    expect(p.duration.providerMs).toBe(5000);
    expect(p.duration.trimToMs).toBe(4500);
    expect(p.production.durationMs).toBe(4500);
    expect(p.production.aspectRatio).toBe("2.39:1");
    expect(p.acknowledgements.map((a) => a.id).sort()).toEqual(["adaptation.duration", "adaptation.framing"]);
    expect(p.promptAdaptation.provider.join(" ")).toMatch(/protected region/);
    expect(p.promptAdaptation.provider.join(" ")).toMatch(/Yumeko/);
    expect(p.promptAdaptation.production[0]).toMatch(/2\.39:1/);
    expect(p.conform).toMatchObject({
      required: true,
      framing: "crop",
      trimToMs: 4500,
      steps: ["crop", "trim"],
    });
  });

  it("plain crop does not add a prompt instruction (the crop is purely post-generation)", () => {
    const p = buildAdaptationPlan(
      input({ choice: { framing: "crop_to_production", duration: "generate_longer_then_trim" } }),
    );
    expect(p.promptAdaptation.provider).toEqual([]);
    expect(p.warnings.join(" ")).toMatch(/protected composition notes/i);
  });

  it("9:16 only provider cannot be cropped to 2.39:1 (unreasonable)", () => {
    const p = buildAdaptationPlan(
      input({
        provider: { ...input().provider, aspectRatios: ["9:16"] },
        choice: { framing: "crop_to_production", duration: "generate_longer_then_trim" },
      }),
    );
    expect(p.framing.status).toBe("blocked");
    expect(p.status).toBe("blocked");
    expect(p.framing.options.find((o) => o.strategy === "crop_to_production")!.usable).toBe(false);
  });

  it("letterbox needs a wider provider ratio, pillarbox a narrower one", () => {
    const wide = input({ production: { aspectRatio: "4:3", durationMs: 5000, fps: 24 } });
    const lb = buildAdaptationPlan({ ...wide, choice: { framing: "fit_with_letterbox" } });
    expect(lb.framing.status).toBe("adapted");
    expect(lb.framing.pad?.mode).toBe("letterbox");
    expect(lb.conform.framing).toBe("letterbox");
    const pb = buildAdaptationPlan({ ...wide, choice: { framing: "fit_with_pillarbox" } });
    expect(pb.framing.pad?.mode).toBe("pillarbox"); // 9:16 is narrower than 4:3
    const prod239 = buildAdaptationPlan(
      input({ choice: { framing: "fit_with_pillarbox", duration: "generate_longer_then_trim" } }),
    );
    expect(prod239.framing.pad?.mode).toBe("pillarbox");
    const impossible = buildAdaptationPlan(
      input({
        production: { aspectRatio: "3:1", durationMs: 5000, fps: 24 },
        choice: { framing: "fit_with_letterbox" },
      }),
    );
    expect(impossible.framing.status).toBe("blocked");
  });

  it("duration: never rounded, trim only when chosen, extension is not available", () => {
    expect(nextSupportedDuration({ minMs: 2000, maxMs: 10000, stepMs: 1000, allowedMs: null }, 4500)).toBe(
      5000,
    );
    expect(
      nextSupportedDuration({ minMs: 2000, maxMs: 10000, stepMs: 1000, allowedMs: null }, 10500),
    ).toBeNull();
    expect(
      nextSupportedDuration({ minMs: 5000, maxMs: 10000, stepMs: null, allowedMs: [5000, 10000] }, 7000),
    ).toBe(10000);

    const base = input({ production: { aspectRatio: "16:9", durationMs: 4500, fps: 24 } });
    expect(buildAdaptationPlan(base).duration.status).toBe("needs_choice");
    const ext = buildAdaptationPlan({ ...base, choice: { duration: "generate_shorter_and_extend" } });
    expect(ext.duration.status).toBe("blocked");
    const tooLong = buildAdaptationPlan({
      ...base,
      production: { aspectRatio: "16:9", durationMs: 12000, fps: 24 },
      choice: { duration: "generate_longer_then_trim" },
    });
    expect(tooLong.duration.status).toBe("blocked");
  });

  it("fingerprint is stable and changes with the plan", () => {
    const a = buildAdaptationPlan(
      input({ choice: { framing: "crop_to_production", duration: "generate_longer_then_trim" } }),
    );
    const b = buildAdaptationPlan(
      input({ choice: { framing: "crop_to_production", duration: "generate_longer_then_trim" } }),
    );
    const c = buildAdaptationPlan(
      input({ choice: { framing: "overscan_for_crop", duration: "generate_longer_then_trim" } }),
    );
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });

  it("a stored plan round-trips through JSON (frozen historical plans stay parseable)", () => {
    const p = buildAdaptationPlan(
      input({ choice: { framing: "overscan_for_crop", duration: "generate_longer_then_trim" } }),
    );
    const back = parseAdaptationPlan(JSON.parse(JSON.stringify(p)));
    expect(back).toEqual(p);
    expect(parseAdaptationPlan(null)).toBeNull();
    expect(parseAdaptationPlan({ nope: true })).toBeNull();
  });

  it("requested resolution with another ratio is re-derived for the provider canvas and clamped", () => {
    const p = buildAdaptationPlan(
      input({
        provider: { ...input().provider, requestedResolution: { width: 4096, height: 1716 } },
        choice: { framing: "crop_to_production", duration: "generate_longer_then_trim" },
      }),
    );
    expect(p.framing.providerCanvas).toEqual({ width: 1280, height: 720 });
  });
});

describe("delivery conform resolution", () => {
  const plan = buildAdaptationPlan(
    input({ choice: { framing: "crop_to_production", duration: "generate_longer_then_trim" } }),
  ).conform;

  it("resolves against the REAL output size, not the planned canvas", () => {
    const r = resolveConform(plan, { width: 1920, height: 1080, durationMs: 5000 });
    expect(r.crop).toEqual({ x: 0, y: 138, width: 1920, height: 804 });
    expect(r.output).toEqual({ width: 1920, height: 804 });
    expect(r.trimMs).toBe(4500);
  });
  it("does not extend a shorter output", () => {
    const r = resolveConform(plan, { width: 1280, height: 720, durationMs: 4000 });
    expect(r.trimMs).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/shorter/);
  });
  it("derivation keys are deterministic and sensitive to every part", () => {
    const k = (over: Partial<Parameters<typeof derivationKey>[0]> = {}) =>
      derivationKey({
        parentChecksum: "aa",
        operation: "conform",
        parameters: { a: 1 },
        processorVersion: "1",
        ...over,
      });
    expect(k()).toBe(k());
    expect(k()).not.toBe(k({ parentChecksum: "bb" }));
    expect(k()).not.toBe(k({ operation: "crop" }));
    expect(k()).not.toBe(k({ parameters: { a: 2 } }));
    expect(k()).not.toBe(k({ processorVersion: "2" }));
  });
});
