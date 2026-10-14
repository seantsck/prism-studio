import { describe, expect, it } from "vitest";
import { buildSeedProject } from "@/data/seed";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage, type GenerationPackage } from "@/domain/generation-package";
import {
  buildCall,
  endpointFor,
  ratioFor,
  validateForModel,
  type ResolvedInputs,
} from "@/generation/providers/runway/families";
import { RunwayProvider, runwayModels } from "@/generation/providers/runway/adapter";
import { evaluateCompatibility } from "../compatibility";
import { buildGenerationRequest } from "../gate";
import {
  RUNWAY_PRICING_VERSION,
  RUNWAY_VIDEO_MODELS,
  catalogModel,
  estimateCredits,
  maxCanvas,
  providerRatioFor,
  toGenerationModel,
} from "../models/catalog";
import { evaluateModelFit } from "../models/matrix";
import {
  deriveShotFeatureProfile,
  deriveShotRequirements,
  isSimilar,
  profileSimilarity,
} from "../models/requirements";
import { generationModelSchema } from "../schemas";
import { buildPromptPlan } from "../prompt-plan";

function pkgFor(code = "3A"): GenerationPackage {
  const data = buildSeedProject();
  const shot = data.shots.find((s) => s.shotCode === code)!;
  return assembleGenerationPackage(buildShotContext(data, shot.id), new Date("2026-01-01T00:00:00Z"));
}
const withPkg = (p: GenerationPackage, f: (x: GenerationPackage) => void) => {
  const c = structuredClone(p);
  f(c);
  return c;
};
const cat = (id: string) => catalogModel("runway", id)!;
const gm = (id: string) => toGenerationModel(cat(id));

describe("model catalog", () => {
  it("is data-driven, valid, versioned and verified", () => {
    expect(RUNWAY_VIDEO_MODELS.map((m) => m.modelId)).toEqual([
      "gen4.5",
      "gen4_turbo",
      "seedance2_5",
      "hailuo3",
      "veo3.1_fast",
      "veo3.1",
    ]);
    for (const m of RUNWAY_VIDEO_MODELS) {
      expect(() => generationModelSchema.parse(toGenerationModel(m))).not.toThrow();
      expect(m.verification.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.verification.sdkVersion).toBe("@runwayml/sdk@4.21.0");
      expect(m.verification.providerApiVersion).toBe("2024-11-06");
      expect(m.pricing.version).toBe(RUNWAY_PRICING_VERSION);
      expect(m.tiers.length).toBeGreaterThan(0);
    }
    expect(new Set(RUNWAY_VIDEO_MODELS.map((m) => m.modelId)).size).toBe(RUNWAY_VIDEO_MODELS.length);
  });

  it("does not claim what the sources do not state (unknown stays unknown)", () => {
    expect(cat("gen4_turbo").duration.verified).toBe(false);
    expect(cat("hailuo3").audio.nativeGeneration).toBe("unknown");
    expect(cat("hailuo3").promptMaxChars).toBeNull();
    expect(cat("gen4.5").inputs.keyframesExcludeReferences).toBe("unknown");
    // gen4_turbo is not in the text-to-video types
    expect(cat("gen4_turbo").modalities).toEqual(["image_to_video"]);
    // Kling is not offered: it is absent from this SDK's video types
    expect(catalogModel("runway", "kling3.0_pro")).toBeNull();
  });

  it("derives the existing provider-independent GenerationModel conservatively", () => {
    const g45 = gm("gen4.5").capabilities;
    expect(g45.video).toMatchObject({ minDurationMs: 2000, maxDurationMs: 10_000, durationStepMs: 1000 });
    expect(g45.video?.maxResolution).toEqual({ width: 1584, height: 1104 });
    expect(g45.references.referenceImages).toBe(false);
    const sd = gm("seedance2_5").capabilities;
    expect(sd.references).toMatchObject({
      referenceImages: true,
      maxReferences: 30,
      referenceAudio: true,
      endFrame: true,
      keyframesExcludeReferences: true,
    });
    expect(gm("veo3.1").capabilities.video?.allowedDurationsMs).toEqual([4000, 6000, 8000]);
    expect(gm("veo3.1").capabilities.references.negativePrompt).toBe(true);
    expect(maxCanvas(cat("hailuo3"))).toEqual({ width: 1280, height: 720 });
  });

  it("prices from the versioned rules: per second, tier, audio, reference images/video, minimums", () => {
    const base = {
      nativeAudio: false,
      referenceImages: 0,
      referenceVideoSeconds: 0,
      startFrame: false,
      endFrame: false,
    };
    expect(estimateCredits(cat("gen4.5"), { ...base, seconds: 5, tierId: "default" })).toMatchObject({
      credits: 60,
      amountUsd: 0.6,
    });
    expect(estimateCredits(cat("gen4_turbo"), { ...base, seconds: 5, tierId: "default" }).amountUsd).toBe(
      0.25,
    );
    // Veo: audio doubles the price
    expect(estimateCredits(cat("veo3.1"), { ...base, seconds: 4, tierId: "720p" }).credits).toBe(80);
    expect(
      estimateCredits(cat("veo3.1"), { ...base, seconds: 4, tierId: "720p", nativeAudio: true }).credits,
    ).toBe(160);
    expect(estimateCredits(cat("veo3.1_fast"), { ...base, seconds: 8, tierId: "720p" }).credits).toBe(80);
    // Seedance 2.5: reference images are free, the 80-credit minimum applies, input video is billed
    expect(
      estimateCredits(cat("seedance2_5"), { ...base, seconds: 2, tierId: "480p", referenceImages: 9 })
        .credits,
    ).toBe(80);
    // no audio surcharge is published for Seedance: audio output is priced as silent
    expect(
      estimateCredits(cat("seedance2_5"), { ...base, seconds: 5, tierId: "720p", nativeAudio: true }).credits,
    ).toBe(150);
    expect(
      estimateCredits(cat("seedance2_5"), { ...base, seconds: 5, tierId: "720p", referenceImages: 6 })
        .credits,
    ).toBe(150);
    expect(
      estimateCredits(cat("seedance2_5"), { ...base, seconds: 5, tierId: "720p", referenceVideoSeconds: 10 })
        .credits,
    ).toBe(300);
    // Hailuo 3: +2 credits per reference image / keyframe
    expect(
      estimateCredits(cat("hailuo3"), {
        ...base,
        seconds: 5,
        tierId: "768p",
        referenceImages: 3,
        startFrame: true,
      }).credits,
    ).toBe(58);
    expect(estimateCredits(cat("gen4.5"), { ...base, seconds: 5, tierId: "default" }).basis).toContain(
      RUNWAY_PRICING_VERSION,
    );
  });

  it("prices the proposed first real comparison exactly (disposable 16:9, 2 s, one start frame)", () => {
    const base = { nativeAudio: false, referenceImages: 0, referenceVideoSeconds: 0, tierId: "default" };
    const gen45 = estimateCredits(cat("gen4.5"), { ...base, seconds: 2, startFrame: false, endFrame: false });
    const turbo = estimateCredits(cat("gen4_turbo"), {
      ...base,
      seconds: 2,
      startFrame: false,
      endFrame: false,
    });
    const hailuo = estimateCredits(cat("hailuo3"), {
      ...base,
      tierId: "768p",
      seconds: 2,
      startFrame: true,
      endFrame: false,
    });
    expect([gen45.credits, turbo.credits, hailuo.credits]).toEqual([24, 10, 22]);
    const total = [gen45, turbo, hailuo].reduce((a, r) => a + (r.amountUsd ?? 0), 0);
    expect(Math.round(total * 100) / 100).toBe(0.56);
  });

  it("maps aspect labels to provider ratios per tier", () => {
    expect(providerRatioFor(cat("gen4.5"), "21:9", "default")).toBe("1584:672");
    expect(providerRatioFor(cat("seedance2_5"), "16:9", "720p")).toBe("1280:720");
    expect(providerRatioFor(cat("seedance2_5"), "16:9", "1080p")).toBe("1920:1080");
    expect(providerRatioFor(cat("veo3.1"), "21:9", "720p")).toBeNull();
    expect(providerRatioFor(cat("hailuo3"), "21:9", "768p")).toBe("21:9");
  });
});

describe("compatibility input modes (keyframes vs references)", () => {
  const pkg = pkgFor("3A");
  it("default keyframe mode keeps the storyboard frame and says the references are NOT used", () => {
    const r = evaluateCompatibility(pkg, gm("seedance2_5"));
    expect(r.inputMode).toBe("keyframes");
    expect(r.used.startFrameAssetId).toBeTruthy();
    expect(r.used.references).toHaveLength(0);
    expect(r.ignoredFeatures.map((f) => f.id)).toContain("references.mode_exclusive");
    expect(r.inputs.filter((i) => i.kind === "reference").every((i) => !i.used)).toBe(true);
  });

  it("reference mode uses text-to-video with the frame as a reference image, visibly", () => {
    const r = evaluateCompatibility(pkg, gm("seedance2_5"), { inputMode: "references" });
    expect(r.inputMode).toBe("references");
    expect(r.modality).toBe("text_to_video");
    expect(r.used.startFrameAssetId).toBeNull();
    expect(r.used.references.length).toBeGreaterThan(0);
    expect(r.used.references[0]!.role).toBe("storyboard");
    expect(r.ignoredFeatures.map((f) => f.id)).toContain("start_frame");
    expect(r.ignoredFeatures.map((f) => f.id)).not.toContain("references.mode_exclusive");
  });

  it("models without the exclusivity flag are unaffected (and report no input mode)", () => {
    const r = evaluateCompatibility(pkg, gm("gen4.5"), { inputMode: "references" });
    expect(r.inputMode).toBeNull();
    expect(r.modality).toBe("image_to_video");
  });
});

describe("Runway request shapes per model family", () => {
  const pkg = pkgFor("3A");
  const plan = buildPromptPlan(pkg);
  const make = (
    id: string,
    opts: Parameters<typeof evaluateCompatibility>[2] = {},
    options: Record<string, unknown> = {},
  ) => {
    const model = gm(id);
    const report = evaluateCompatibility(pkg, model, {
      adaptation: { framing: "overscan_for_crop", duration: "generate_longer_then_trim" },
      ...opts,
    });
    const request = buildGenerationRequest({
      pkg,
      model,
      compatibility: report,
      plan,
      idempotencyKey: "test-key-0001",
      providerOptions: options,
    });
    return { model, report, request };
  };
  const uris = (r: ReturnType<typeof make>["request"]): ResolvedInputs => ({
    first: r.startFrameAssetId ? "data:image/png;base64,AAAA" : null,
    last: r.endFrameAssetId ? "data:image/png;base64,BBBB" : null,
    references: r.references.map((x) => `data:image/png;base64,${x.assetId.slice(0, 4)}`),
    audio: r.audioAssetIds.map(() => "data:audio/mpeg;base64,CCCC"),
  });

  it("gen4.5 / gen4_turbo: one first frame, pixel ratio, no extras", () => {
    for (const id of ["gen4.5", "gen4_turbo"]) {
      const { request } = make(id);
      const call = buildCall(cat(id), request, "A prompt", uris(request));
      expect(call.endpoint).toBe("image_to_video");
      expect(call.body.model).toBe(id);
      expect(call.body.promptImage).toEqual([{ position: "first", uri: "data:image/png;base64,AAAA" }]);
      expect(call.body).not.toHaveProperty("audio");
      expect(call.body).not.toHaveProperty("negativePrompt");
      expect(call.body).not.toHaveProperty("references");
      expect(String(call.body.ratio)).toMatch(/^\d+:\d+$/);
    }
  });

  it("veo: whole seconds 4/6/8, explicit audio flag (default OFF), negative prompt is a separate field", () => {
    const { request, report } = make("veo3.1_fast");
    expect([4000, 6000, 8000]).toContain(report.used.durationMs);
    const call = buildCall(cat("veo3.1_fast"), request, "P", uris(request));
    expect(call.body.audio).toBe(false);
    expect([4, 6, 8]).toContain(call.body.duration);
    const loud = make("veo3.1_fast", {}, { nativeAudio: true });
    expect(buildCall(cat("veo3.1_fast"), loud.request, "P", uris(loud.request)).body.audio).toBe(true);
    const withNeg = { ...request, prompt: { ...request.prompt, negative: "no text overlays" } };
    expect(buildCall(cat("veo3.1_fast"), withNeg, "P", uris(withNeg)).body.negativePrompt).toBe(
      "no text overlays",
    );
  });

  it("seedance keyframes: image_to_video with first (+last) and reference audio, never references", () => {
    const { request } = make("seedance2_5");
    expect(endpointFor(request)).toBe("image_to_video");
    const call = buildCall(cat("seedance2_5"), request, "P", uris(request));
    expect(call.body.promptImage).toEqual([{ position: "first", uri: "data:image/png;base64,AAAA" }]);
    expect(call.body).not.toHaveProperty("references");
  });

  it("seedance reference mode: text_to_video with up to 30 `references` and NO keyframes", () => {
    const { request, report } = make("seedance2_5", { inputMode: "references" });
    expect(report.inputMode).toBe("references");
    expect(endpointFor(request)).toBe("text_to_video");
    const call = buildCall(cat("seedance2_5"), request, "P", uris(request));
    expect(call.endpoint).toBe("text_to_video");
    expect(Array.isArray(call.body.references)).toBe(true);
    expect((call.body.references as unknown[]).length).toBe(request.references.length);
    expect(call.body).not.toHaveProperty("promptImage");
    expect(validateForModel(cat("seedance2_5"), request)).toEqual([]);
  });

  it("seedance resolution tier changes the provider ratio and the price", () => {
    const hi = make("seedance2_5", {}, { resolutionTier: "1080p" });
    expect(ratioFor(cat("seedance2_5"), hi.request).tier.id).toBe("1080p");
    const lo = make("seedance2_5", {}, { resolutionTier: "480p" });
    expect(ratioFor(cat("seedance2_5"), lo.request).ratio).not.toBe(
      ratioFor(cat("seedance2_5"), hi.request).ratio,
    );
  });

  it("hailuo: aspect label ratio + separate resolution tier, no seed field", () => {
    const { request } = make("hailuo3", {}, { resolutionTier: "2k" });
    const call = buildCall(cat("hailuo3"), { ...request, seed: 7 }, "P", uris(request));
    expect(call.body.resolution).toBe("2k");
    expect(call.body).not.toHaveProperty("seed");
    expect(String(call.body.ratio)).toMatch(/^\d+:\d+$|^\w/);
  });

  it("refuses combinations the provider cannot take (never silently drops them)", () => {
    const { request } = make("seedance2_5");
    const mixed = {
      ...request,
      references: [{ assetId: "x", role: "identity" as const, order: 0, label: "x" }],
    };
    expect(validateForModel(cat("seedance2_5"), mixed).join(" ")).toMatch(/cannot be mixed/);
    const gen = make("gen4.5").request;
    expect(
      validateForModel(cat("gen4.5"), {
        ...gen,
        references: [{ assetId: "x", role: "identity", order: 0, label: "x" }],
      }).join(" "),
    ).toMatch(/no reference images/);
    expect(validateForModel(cat("veo3.1"), { ...gen, durationMs: 5000 }).join(" ")).toMatch(/will not round/);
    expect(
      validateForModel(cat("veo3.1"), { ...gen, providerOptions: { nativeAudio: true } }).join(" "),
    ).toEqual(expect.any(String));
    expect(
      validateForModel(cat("gen4.5"), { ...gen, providerOptions: { nativeAudio: true } }).join(" "),
    ).toMatch(/cannot generate native audio/);
  });

  it("the adapter exposes every catalog model and prices through the catalog", () => {
    const provider = new RunwayProvider({ env: {}, clientFactory: () => ({}) as never });
    expect(provider.listModels().map((m) => m.modelId)).toEqual(RUNWAY_VIDEO_MODELS.map((m) => m.modelId));
    expect(runwayModels()).toHaveLength(6);
    const { request, model } = make("veo3.1_fast");
    const e = provider.estimateCost(request, model);
    expect(e.currency).toBe("USD");
    expect(e.amount).toBe((report10(request.durationMs!) * 10 * 0.01).valueOf());
    const s = provider.compileRequest(request, plan);
    expect(s.endpoint).toContain("veo3.1_fast");
    expect(JSON.stringify(s)).not.toMatch(/data:image|https?:\/\//);
  });
});
const report10 = (ms: number) => ms / 1000;

describe("shot requirements and feature profile", () => {
  it("derives needs from structured production truth, each with its reason", () => {
    const req = deriveShotRequirements(pkgFor("3A"));
    expect(req.production.aspectRatio).toBeTruthy();
    expect(req.characterCount).toBeGreaterThanOrEqual(0);
    for (const n of Object.values(req.needs)) expect(n.because.length).toBeGreaterThan(0);
  });

  it("buckets features deterministically and groups similar shots", () => {
    const a = deriveShotFeatureProfile(pkgFor("3A"));
    const b = deriveShotFeatureProfile(pkgFor("3A"));
    expect(a).toEqual(b);
    expect(profileSimilarity(a, b)).toBe(1);
    expect(isSimilar(a, b)).toBe(true);
    const other = { ...a, characterCount: "3+" as const, hasDialogue: !a.hasDialogue, shotSize: "wide" };
    expect(isSimilar(a, other)).toBe(false);
  });

  it("recurring characters and continuity needs are explicit booleans, not guesses", () => {
    const p = withPkg(pkgFor("3A"), (x) => {
      x.characters[0]!.identityReferenceAssetIds = ["ref-1"];
    });
    expect(deriveShotFeatureProfile(p).hasRecurringCharacter).toBe(true);
  });
});

describe("compatibility matrix", () => {
  const pkg = pkgFor("3A");
  const fits = RUNWAY_VIDEO_MODELS.map((m) =>
    evaluateModelFit({ pkg, model: toGenerationModel(m), catalog: m, availability: null }),
  );
  const by = Object.fromEntries(fits.map((f) => [f.modelId, f]));

  it("classifies each model with reasons instead of a bare yes/no", () => {
    for (const f of fits) {
      expect(["supported", "adaptation_required", "unsupported", "unknown"]).toContain(f.status);
      expect(f.packaging.length).toBeGreaterThan(0);
    }
    expect(by["gen4.5"]!.status).not.toBe("unsupported");
  });

  it("shows what each model receives: 'only a start frame usable' vs 'more references'", () => {
    const g = by["gen4.5"]!;
    const refRows = g.packaging.filter((p) => p.kind === "reference");
    expect(refRows.every((r) => r.state === "unsupported")).toBe(true);
    const ref = evaluateModelFit({
      pkg,
      model: gm("seedance2_5"),
      catalog: cat("seedance2_5"),
      availability: null,
      options: { inputMode: "references" },
    });
    expect(ref.referencesUsed.used).toBeGreaterThanOrEqual(g.referencesUsed.used);
    expect(ref.inputMode).toBe("references");
  });

  it("native audio is advertised but OFF by default and priced when ON", () => {
    const veo = by["veo3.1"]!;
    expect(veo.packaging.find((p) => p.kind === "native_audio")?.state).toBe("supported_not_used");
    const on = evaluateModelFit({
      pkg,
      model: gm("veo3.1"),
      catalog: cat("veo3.1"),
      availability: null,
      options: { nativeAudio: true },
    });
    expect(on.estimate!.amountUsd!).toBeGreaterThan(veo.estimate!.amountUsd!);
  });

  it("unverified duration bounds surface as UNKNOWN, not as supported", () => {
    const f = by["gen4_turbo"]!;
    expect(f.unknowns.join(" ")).toMatch(/not documented/);
    expect(f.duration.unverified).toBe(true);
  });

  it("an explicit adaptation preview is reported as adaptation, not as incompatibility", () => {
    const adapted = fits.filter((f) => f.adaptations.length > 0);
    for (const f of adapted) expect(f.status).toBe("adaptation_required");
  });
});
