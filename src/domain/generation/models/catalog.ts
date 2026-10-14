import type { GenerationModel, ModelCapabilities } from "../schemas";
import type {
  CatalogModel,
  CatalogPricing,
  CatalogTier,
  CatalogVerification,
  CreditRule,
  PricingInputs,
  PricingResult,
} from "./types";

/**
 * The Phase 2E video-model comparison set, served through the existing Runway adapter.
 *
 * Sources (read 2026-10-13/14):
 *   - @runwayml/sdk@4.21.0 request types: resources/image-to-video.d.ts, text-to-video.d.ts, video-to-video.d.ts
 *     (4.22.0 adds only image models; its video request types are identical, so the pin stays at 4.21.0)
 *   - https://docs.dev.runwayml.com/guides/pricing/  (credit price table; $0.01 per credit)
 *   - https://docs.dev.runwayml.com/guides/models/   (model cards)
 * Where a source does not state something it is recorded in `verification.unstated` and the capability is
 * `unknown`. Nothing here is inferred from marketing material or from another model.
 *
 * Why these six (not all 50+): different strengths, one request-shape family each, all reachable through the
 * existing adapter with no new vendor integration.
 *   gen4.5        Runway flagship, start-frame conditioned
 *   gen4_turbo    lower-cost / faster Runway option, start frame required
 *   seedance2_5   reference-rich (up to 30 reference images, reference audio/video, first/last frame)
 *   hailuo3       cinematic competitor with image/video/audio references at lower cost
 *   veo3.1_fast   fast Veo with first/last frame and native audio
 *   veo3.1        premium Veo with native audio
 * Kling and WAN are NOT in this SDK version's video types for the families asked about (Kling is absent
 * entirely), so Kling is not offered. Adding a model is one entry here plus its family compiler if the request
 * shape is new.
 */
export const RUNWAY_SDK_REF = "@runwayml/sdk@4.21.0";
export const RUNWAY_API_VERSION_REF = "2024-11-06";
export const CATALOG_VERIFIED_AT = "2026-10-14";
export const RUNWAY_PRICING_VERSION = "runway-2026-10-13";
export const RUNWAY_USD_PER_CREDIT = 0.01;

const SOURCES = [
  "@runwayml/sdk@4.21.0 resources/image-to-video.d.ts",
  "@runwayml/sdk@4.21.0 resources/text-to-video.d.ts",
  "docs.dev.runwayml.com/guides/pricing (2026-10-13)",
  "docs.dev.runwayml.com/guides/models (2026-10-14)",
];

const verification = (unstated: string[]): CatalogVerification => ({
  verifiedAt: CATALOG_VERIFIED_AT,
  sources: SOURCES,
  sdkVersion: RUNWAY_SDK_REF,
  providerApiVersion: RUNWAY_API_VERSION_REF,
  unstated,
});

const pricing = (rule: CreditRule): CatalogPricing => ({
  version: RUNWAY_PRICING_VERSION,
  verifiedAt: "2026-10-13",
  source: "https://docs.dev.runwayml.com/guides/pricing/",
  usdPerCredit: RUNWAY_USD_PER_CREDIT,
  currency: "USD",
  rule,
});

const tier = (
  id: string,
  w: number | null,
  h: number | null,
  ratios: Record<string, string>,
): CatalogTier => ({
  id,
  label: id,
  canvas: w && h ? { width: w, height: h } : null,
  ratios,
});

const NO_DURATION_BOUNDS =
  "The documentation states no minimum or maximum duration for this model; the range is a permissive superset and the provider validates it.";

export const RUNWAY_VIDEO_MODELS: readonly CatalogModel[] = [
  {
    provider: "runway",
    modelId: "gen4.5",
    displayName: "Runway Gen-4.5",
    family: "runway_gen4",
    role: "flagship",
    summary: "Runway's flagship text/image-to-video. Whole seconds 2–10. First frame only.",
    availability: "available",
    availabilityNote: "",
    verification: verification([]),
    modalities: ["text_to_video", "image_to_video"],
    inputs: {
      startFrame: "supported",
      endFrame: "unsupported",
      referenceImages: "unsupported",
      maxReferenceImages: 0,
      referenceVideo: "unsupported",
      maxReferenceVideoSeconds: null,
      referenceAudio: "unsupported",
      maxReferenceAudioSeconds: null,
      keyframesExcludeReferences: "unknown",
      negativePrompt: "unsupported",
    },
    audio: { nativeGeneration: "unsupported", referenceConditioning: "unsupported" },
    duration: {
      allowedSeconds: null,
      minSeconds: 2,
      maxSeconds: 10,
      stepSeconds: 1,
      verified: true,
      note: "Integer 2–10 seconds (SDK types).",
    },
    tiers: [
      tier("default", 1280, 720, {
        "16:9": "1280:720",
        "9:16": "720:1280",
        "4:3": "1104:832",
        "1:1": "960:960",
        "3:4": "832:1104",
        "21:9": "1584:672",
      }),
    ],
    aspectRatios: ["16:9", "9:16", "4:3", "1:1", "3:4", "21:9"],
    textToVideoAspectRatios: ["16:9", "9:16"],
    promptMaxChars: 1000,
    planningCanvas: { width: 1584, height: 1104 },
    pricing: pricing({
      perSecond: { default: { silent: 12, audio: null } },
      perReferenceImage: 0,
      perReferenceVideoSecond: null,
      referenceVideoBilledCapSeconds: null,
      minimumCredits: null,
    }),
    concurrencyNote: "Account usage tier dependent; extra tasks are THROTTLED server-side.",
  },
  {
    provider: "runway",
    modelId: "gen4_turbo",
    displayName: "Runway Gen-4 Turbo",
    family: "runway_gen4",
    role: "fast_low_cost",
    summary: "Runway's fastest image-to-video model. A start frame is required; no text-to-video.",
    availability: "available",
    availabilityNote: "",
    verification: verification([
      "duration bounds (the SDK type is `number` with no range)",
      "text-to-video endpoint (the model is not in the text-to-video types)",
    ]),
    modalities: ["image_to_video"],
    inputs: {
      startFrame: "supported",
      endFrame: "unsupported",
      referenceImages: "unsupported",
      maxReferenceImages: 0,
      referenceVideo: "unsupported",
      maxReferenceVideoSeconds: null,
      referenceAudio: "unsupported",
      maxReferenceAudioSeconds: null,
      keyframesExcludeReferences: "unknown",
      negativePrompt: "unsupported",
    },
    audio: { nativeGeneration: "unsupported", referenceConditioning: "unsupported" },
    duration: {
      allowedSeconds: null,
      minSeconds: 1,
      maxSeconds: 10,
      stepSeconds: 1,
      verified: false,
      note: NO_DURATION_BOUNDS,
    },
    tiers: [
      tier("default", 1280, 720, {
        "16:9": "1280:720",
        "9:16": "720:1280",
        "4:3": "1104:832",
        "3:4": "832:1104",
        "1:1": "960:960",
        "21:9": "1584:672",
      }),
    ],
    aspectRatios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"],
    textToVideoAspectRatios: null,
    promptMaxChars: 1000,
    planningCanvas: { width: 1584, height: 1104 },
    pricing: pricing({
      perSecond: { default: { silent: 5, audio: null } },
      perReferenceImage: 0,
      perReferenceVideoSecond: null,
      referenceVideoBilledCapSeconds: null,
      minimumCredits: null,
    }),
    concurrencyNote: "Account usage tier dependent.",
  },
  {
    provider: "runway",
    modelId: "seedance2_5",
    displayName: "Seedance 2.5",
    family: "seedance",
    role: "reference_rich",
    summary:
      "Reference-rich: up to 30 reference images, reference audio and video, first/last frame, optional native audio.",
    availability: "available",
    availabilityNote: "",
    verification: verification([
      "minimum duration (docs: 'up to 30 seconds')",
      "maximum reference images on the image-to-video route (30 is documented for the text-to-video `references` field)",
      "whether `audio: true` produces speech or only sound",
    ]),
    modalities: ["text_to_video", "image_to_video", "video_to_video"],
    inputs: {
      startFrame: "supported",
      endFrame: "supported",
      referenceImages: "supported",
      maxReferenceImages: 30,
      referenceVideo: "supported",
      maxReferenceVideoSeconds: 30,
      referenceAudio: "supported",
      maxReferenceAudioSeconds: 30,
      keyframesExcludeReferences: "supported",
      negativePrompt: "unsupported",
    },
    audio: { nativeGeneration: "supported", referenceConditioning: "supported" },
    duration: {
      allowedSeconds: null,
      minSeconds: 1,
      maxSeconds: 30,
      stepSeconds: 1,
      verified: false,
      note: "Documented maximum 30 s; the minimum is not stated (permissive range, whole seconds).",
    },
    tiers: [
      tier("720p", 1280, 720, {
        "21:9": "1470:630",
        "16:9": "1280:720",
        "4:3": "1112:834",
        "1:1": "960:960",
        "3:4": "834:1112",
        "9:16": "720:1280",
      }),
      tier("480p", 854, 480, {
        "21:9": "992:432",
        "16:9": "854:480",
        "4:3": "752:560",
        "1:1": "640:640",
        "3:4": "560:752",
        "9:16": "480:854",
      }),
      tier("1080p", 1920, 1080, {
        "21:9": "2206:946",
        "16:9": "1920:1080",
        "4:3": "1664:1248",
        "1:1": "1440:1440",
        "3:4": "1248:1664",
        "9:16": "1080:1920",
      }),
    ],
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    textToVideoAspectRatios: null,
    promptMaxChars: 15000,
    pricing: pricing({
      // The published table lists ONE rate per tier and, unlike Veo, no audio surcharge, so audio output is
      // priced as silent. (If Runway adds an audio line, change the `audio` values here.)
      perSecond: {
        "480p": { silent: 20, audio: 20 },
        "720p": { silent: 30, audio: 30 },
        "1080p": { silent: 68, audio: 68 },
      },
      // reference images and audio are free; INPUT/reference video bills per second (see below)
      perReferenceImage: 0,
      perReferenceVideoSecond: { "480p": 10, "720p": 15, "1080p": 34 },
      referenceVideoBilledCapSeconds: 30,
      minimumCredits: 80,
    }),
    concurrencyNote: "Account usage tier dependent.",
  },
  {
    provider: "runway",
    modelId: "hailuo3",
    displayName: "MiniMax Hailuo 3.0",
    family: "hailuo",
    role: "cinematic",
    summary:
      "Multimodal competitor: up to 9 reference images, reference video (≤15 s) and audio (≤15 s), first/last frame; 768p or 2K.",
    availability: "available",
    availabilityNote: "",
    verification: verification([
      "duration bounds (the SDK type is `number`)",
      "prompt length limit",
      "native audio generation",
      "maximum reference images on the image-to-video route (9 is documented for text-to-video `references`)",
    ]),
    modalities: ["text_to_video", "image_to_video", "video_to_video"],
    inputs: {
      startFrame: "supported",
      endFrame: "supported",
      referenceImages: "supported",
      maxReferenceImages: 9,
      referenceVideo: "supported",
      maxReferenceVideoSeconds: 15,
      referenceAudio: "supported",
      maxReferenceAudioSeconds: 15,
      keyframesExcludeReferences: "supported",
      negativePrompt: "unsupported",
    },
    audio: { nativeGeneration: "unknown", referenceConditioning: "supported" },
    duration: {
      allowedSeconds: null,
      minSeconds: 1,
      maxSeconds: 30,
      stepSeconds: 1,
      verified: false,
      note: NO_DURATION_BOUNDS,
    },
    tiers: [
      tier("768p", 1280, 720, {
        "21:9": "21:9",
        "16:9": "16:9",
        "4:3": "4:3",
        "1:1": "1:1",
        "3:4": "3:4",
        "9:16": "9:16",
      }),
      tier("2k", null, null, {
        "21:9": "21:9",
        "16:9": "16:9",
        "4:3": "4:3",
        "1:1": "1:1",
        "3:4": "3:4",
        "9:16": "9:16",
      }),
    ],
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    textToVideoAspectRatios: null,
    promptMaxChars: null,
    pricing: pricing({
      perSecond: { "768p": { silent: 10, audio: null }, "2k": { silent: 15, audio: null } },
      perReferenceImage: 2,
      perReferenceVideoSecond: "same_as_output",
      referenceVideoBilledCapSeconds: 15,
      minimumCredits: null,
    }),
    concurrencyNote: "Account usage tier dependent.",
  },
  {
    provider: "runway",
    modelId: "veo3.1_fast",
    displayName: "Veo 3.1 Fast",
    family: "veo",
    role: "fast_low_cost",
    summary: "Fast Veo: 4/6/8 s, first and last frame, negative prompt, optional native audio.",
    availability: "available",
    availabilityNote: "",
    verification: verification([
      "native-audio behaviour beyond the `audio` flag (pricing doubles when audio is on)",
      "maximum resolution beyond the listed ratios",
    ]),
    modalities: ["text_to_video", "image_to_video"],
    inputs: {
      startFrame: "supported",
      endFrame: "supported",
      referenceImages: "unsupported",
      maxReferenceImages: 0,
      referenceVideo: "unsupported",
      maxReferenceVideoSeconds: null,
      referenceAudio: "unsupported",
      maxReferenceAudioSeconds: null,
      keyframesExcludeReferences: "unknown",
      negativePrompt: "supported",
    },
    audio: { nativeGeneration: "supported", referenceConditioning: "unsupported" },
    duration: {
      allowedSeconds: [4, 6, 8],
      minSeconds: 4,
      maxSeconds: 8,
      stepSeconds: null,
      verified: true,
      note: "Exactly 4, 6 or 8 seconds (SDK types).",
    },
    tiers: [
      tier("720p", 1280, 720, { "16:9": "1280:720", "9:16": "720:1280" }),
      tier("1080p", 1920, 1080, { "16:9": "1920:1080", "9:16": "1080:1920" }),
    ],
    aspectRatios: ["16:9", "9:16"],
    textToVideoAspectRatios: null,
    promptMaxChars: 1000,
    pricing: pricing({
      perSecond: { "720p": { silent: 10, audio: 15 }, "1080p": { silent: 10, audio: 15 } },
      perReferenceImage: 0,
      perReferenceVideoSecond: null,
      referenceVideoBilledCapSeconds: null,
      minimumCredits: null,
    }),
    concurrencyNote: "Account usage tier dependent.",
  },
  {
    provider: "runway",
    modelId: "veo3.1",
    displayName: "Veo 3.1",
    family: "veo",
    role: "premium_audio",
    summary: "Premium Veo: 4/6/8 s, first and last frame, negative prompt, optional native audio and speech.",
    availability: "available",
    availabilityNote: "",
    verification: verification([
      "native-audio behaviour beyond the `audio` flag (pricing doubles when audio is on)",
      "maximum resolution beyond the listed ratios",
    ]),
    modalities: ["text_to_video", "image_to_video"],
    inputs: {
      startFrame: "supported",
      endFrame: "supported",
      referenceImages: "unsupported",
      maxReferenceImages: 0,
      referenceVideo: "unsupported",
      maxReferenceVideoSeconds: null,
      referenceAudio: "unsupported",
      maxReferenceAudioSeconds: null,
      keyframesExcludeReferences: "unknown",
      negativePrompt: "supported",
    },
    audio: { nativeGeneration: "supported", referenceConditioning: "unsupported" },
    duration: {
      allowedSeconds: [4, 6, 8],
      minSeconds: 4,
      maxSeconds: 8,
      stepSeconds: null,
      verified: true,
      note: "Exactly 4, 6 or 8 seconds (SDK types).",
    },
    tiers: [
      tier("720p", 1280, 720, { "16:9": "1280:720", "9:16": "720:1280" }),
      tier("1080p", 1920, 1080, { "16:9": "1920:1080", "9:16": "1080:1920" }),
    ],
    aspectRatios: ["16:9", "9:16"],
    textToVideoAspectRatios: null,
    promptMaxChars: 1000,
    pricing: pricing({
      perSecond: { "720p": { silent: 20, audio: 40 }, "1080p": { silent: 20, audio: 40 } },
      perReferenceImage: 0,
      perReferenceVideoSecond: null,
      referenceVideoBilledCapSeconds: null,
      minimumCredits: null,
    }),
    concurrencyNote: "Account usage tier dependent.",
  },
];

export function catalogModel(provider: string, modelId: string): CatalogModel | null {
  return RUNWAY_VIDEO_MODELS.find((m) => m.provider === provider && m.modelId === modelId) ?? null;
}

export function defaultTier(model: CatalogModel): CatalogTier {
  return model.tiers[0]!;
}

export function tierById(model: CatalogModel, id: string | null | undefined): CatalogTier {
  return model.tiers.find((t) => t.id === id) ?? defaultTier(model);
}

/** Provider ratio value for an aspect label at a tier (null when the tier does not offer it). */
export function providerRatioFor(model: CatalogModel, aspect: string, tierId?: string | null): string | null {
  return tierById(model, tierId).ratios[aspect] ?? null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Largest width and height across every pixel-valued ratio and tier canvas the model offers. */
export function maxCanvas(model: CatalogModel): { width: number; height: number } | null {
  let width = 0;
  let height = 0;
  for (const t of model.tiers) {
    if (t.canvas) {
      width = Math.max(width, t.canvas.width);
      height = Math.max(height, t.canvas.height);
    }
    for (const v of Object.values(t.ratios)) {
      const m = /^(\d{3,5}):(\d{3,5})$/.exec(v);
      if (m) {
        width = Math.max(width, Number(m[1]));
        height = Math.max(height, Number(m[2]));
      }
    }
  }
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Credits and USD for a request, from the versioned pricing rule only. `null` credits = not computable (an
 * unknown tier). Never reinterprets past spend: actual cost always comes from the provider's reported credits.
 */
export function estimateCredits(model: CatalogModel, input: PricingInputs): PricingResult {
  const rule = model.pricing.rule;
  const rate = rule.perSecond[input.tierId] ?? rule.perSecond[defaultTier(model).id];
  if (!rate) {
    return { credits: null, amountUsd: null, basis: `No price for tier ${input.tierId}`, parts: [] };
  }
  const perSecond = input.nativeAudio ? rate.audio : rate.silent;
  if (perSecond == null) {
    return {
      credits: null,
      amountUsd: null,
      basis: `${model.displayName} has no published price for audio output`,
      parts: [],
    };
  }
  const parts: string[] = [`${perSecond} cr/s × ${input.seconds} s`];
  let credits = perSecond * input.seconds;
  const images = input.referenceImages + (input.startFrame ? 1 : 0) + (input.endFrame ? 1 : 0);
  if (rule.perReferenceImage > 0 && images > 0) {
    credits += rule.perReferenceImage * images;
    parts.push(`${rule.perReferenceImage} cr × ${images} image(s)`);
  }
  if (input.referenceVideoSeconds > 0 && rule.perReferenceVideoSecond != null) {
    const cap = rule.referenceVideoBilledCapSeconds ?? input.referenceVideoSeconds;
    const secs = Math.min(cap, input.referenceVideoSeconds);
    const per =
      rule.perReferenceVideoSecond === "same_as_output"
        ? perSecond
        : (rule.perReferenceVideoSecond[input.tierId] ?? 0);
    credits += per * secs;
    parts.push(`${per} cr/s × ${secs} s reference video`);
  }
  if (rule.minimumCredits != null && credits < rule.minimumCredits) {
    parts.push(`minimum ${rule.minimumCredits} cr per generation`);
    credits = rule.minimumCredits;
  }
  credits = round2(credits);
  return {
    credits,
    amountUsd: Math.round(credits * model.pricing.usdPerCredit * 10_000) / 10_000,
    basis: `${credits} credits (${parts.join(" + ")}) × ${model.pricing.usdPerCredit}/credit; ${model.pricing.version}`,
    parts,
  };
}

/**
 * The existing provider-independent `GenerationModel` for a catalog entry, so the compatibility engine, gate,
 * registry and worker keep working unchanged. Unknown capabilities become the conservative documented value
 * (never an optimistic one); the catalog entry keeps the full tri-state truth.
 */
export function toGenerationModel(m: CatalogModel, opts: { maxConcurrency?: number } = {}): GenerationModel {
  const first = defaultTier(m);
  const unitCost = estimateCredits(m, {
    seconds: 1,
    tierId: first.id,
    nativeAudio: false,
    referenceImages: 0,
    referenceVideoSeconds: 0,
    startFrame: false,
    endFrame: false,
  });
  const largest = m.planningCanvas ?? maxCanvas(m);
  const caps: ModelCapabilities = {
    modalities: m.modalities,
    references: {
      textPrompt: true,
      negativePrompt: m.inputs.negativePrompt === "supported",
      referenceImages: m.inputs.referenceImages === "supported",
      maxReferences: m.inputs.referenceImages === "supported" ? (m.inputs.maxReferenceImages ?? 0) : 0,
      orderedReferences: false,
      characterReferences: m.inputs.referenceImages === "supported",
      styleReferences: m.inputs.referenceImages === "supported",
      locationReferences: m.inputs.referenceImages === "supported",
      startFrame: m.inputs.startFrame === "supported",
      endFrame: m.inputs.endFrame === "supported",
      referenceVideo: m.inputs.referenceVideo === "supported",
      referenceAudio: m.inputs.referenceAudio === "supported",
      keyframesExcludeReferences: m.inputs.keyframesExcludeReferences === "supported",
    },
    video: {
      minDurationMs: m.duration.minSeconds * 1000,
      maxDurationMs: m.duration.maxSeconds * 1000,
      durationStepMs: m.duration.stepSeconds != null ? m.duration.stepSeconds * 1000 : null,
      allowedDurationsMs: m.duration.allowedSeconds?.map((s) => s * 1000) ?? null,
      cameraControl: false,
      motionPrompting: true,
      // largest pixel dimensions across the offered ratios (planning canvas; conform re-resolves the real output)
      maxResolution: largest,
      aspectRatios: m.aspectRatios,
      fps: [],
    },
    image: null,
    audio: {
      nativeDialogueAudio: m.audio.nativeGeneration === "supported",
      audioConditioning: false,
      lipSync: false,
      referenceAudio: m.audio.referenceConditioning === "supported",
      soundGeneration: m.audio.nativeGeneration === "supported",
    },
    operational: {
      mode: "async",
      polling: true,
      webhook: false,
      cancellation: true,
      idempotency: false,
      maxConcurrency: opts.maxConcurrency ?? 1,
      recommendedPollIntervalMs: 5_000,
      jobTimeoutMs: 30 * 60_000,
      rateLimitNotes: m.concurrencyNote,
    },
    commercial: {
      pricing: "per_second",
      currency: "USD",
      costUnit: `second of video (${unitCost.credits ?? "?"} credits at the default tier${
        m.pricing.rule.minimumCredits != null ? `, minimum ${m.pricing.rule.minimumCredits} credits` : ""
      })`,
      unitCost: unitCost.amountUsd,
    },
  };
  return {
    provider: m.provider,
    modelId: m.modelId,
    displayName: m.displayName,
    description: m.summary,
    kind: "real",
    lifecycle:
      m.availability === "retired" ? "retired" : m.availability === "deprecated" ? "deprecated" : "active",
    capabilities: caps,
  };
}
