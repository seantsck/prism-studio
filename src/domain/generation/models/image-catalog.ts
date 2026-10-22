import type {
  CatalogImageSpec,
  CatalogModel,
  CatalogPricing,
  CatalogTier,
  CatalogVerification,
  CreditRule,
  ImageCreditRule,
} from "./types";

/**
 * The Phase 2G.2 still-image set, served through the existing Runway adapter (`client.textToImage.create`).
 *
 * Sources (read 2026-10-21):
 *   - @runwayml/sdk@4.22.0 resources/text-to-image.d.ts: the typed request union (model ids, ratio unions,
 *     reference limits, tags, quality and format options)
 *   - https://docs.dev.runwayml.com/guides/pricing/  (image credit table; $0.01 per credit)
 *   - https://docs.dev.runwayml.com/api.md           (POST /v1/text_to_image reference: prompt and reference limits)
 * A model is registered only when its request shape, reference limit, ratios, quality options, price AND SDK typing
 * can all be verified. Anything a source does not state is recorded in \`unstated\`, never guessed.
 *
 *   gpt_image_2_5_flare  reference-rich quality: up to 16 TAGGED references, a quality ladder, 32,000-char prompt
 *   muse_image           inexpensive: 1 credit per image at every size, up to 10 references
 *   seedream5_lite       alternative model family (ByteDance Seedream): up to 14 ordered references, 4 credits
 *
 * Registered here but NOT offered (SDK-blocked): see IMAGE_SDK_BLOCKED_MODELS.
 * Not registered although typed and priced (kept out of 2G.2 scope, not blocked): gemini_image3.1_flash,
 * gemini_image3_pro, gen4_image(_turbo), gpt_image_2, seedream5_pro, grok_imagine_image_2, ideogram_4_0/4_5,
 * gemini_2.5_flash. Adding one is a catalog entry plus its family compiler.
 *
 * Nothing here ranks a model as "best": Prism recommends per Shot from capability fit, references, framing, cost and
 * the filmmaker's own history.
 */
export const RUNWAY_IMAGE_SDK_REF = "@runwayml/sdk@4.22.0";
export const RUNWAY_IMAGE_API_VERSION_REF = "2024-11-06";
export const IMAGE_CATALOG_VERIFIED_AT = "2026-10-21";
export const RUNWAY_IMAGE_PRICING_VERSION = "runway-image-2026-10-21";
const USD_PER_CREDIT = 0.01;

const SOURCES = [
  "@runwayml/sdk@4.22.0 resources/text-to-image.d.ts",
  "docs.dev.runwayml.com/guides/pricing (2026-10-21)",
  "docs.dev.runwayml.com/api.md POST /v1/text_to_image (2026-10-21)",
];

const verification = (unstated: string[]): CatalogVerification => ({
  verifiedAt: IMAGE_CATALOG_VERIFIED_AT,
  sources: SOURCES,
  sdkVersion: RUNWAY_IMAGE_SDK_REF,
  providerApiVersion: RUNWAY_IMAGE_API_VERSION_REF,
  unstated,
});

const NO_VIDEO_RULE: CreditRule = {
  perSecond: {},
  perReferenceImage: 0,
  perReferenceVideoSecond: null,
  referenceVideoBilledCapSeconds: null,
  minimumCredits: null,
};

const pricing = (imageRule: ImageCreditRule): CatalogPricing => ({
  version: RUNWAY_IMAGE_PRICING_VERSION,
  verifiedAt: "2026-10-21",
  source: "https://docs.dev.runwayml.com/guides/pricing/",
  usdPerCredit: USD_PER_CREDIT,
  currency: "USD",
  rule: NO_VIDEO_RULE,
  imageRule,
});

const NO_DURATION = {
  allowedSeconds: null,
  minSeconds: 0,
  maxSeconds: 0,
  stepSeconds: null,
  verified: true,
  note: "Not applicable: a still image has no duration.",
} as const;

const tier = (id: string, w: number, h: number, ratios: Record<string, string>): CatalogTier => ({
  id,
  label: id,
  canvas: { width: w, height: h },
  ratios,
});

const imageInputs = (maxRefs: number): CatalogModel["inputs"] => ({
  startFrame: "unsupported",
  endFrame: "unsupported",
  referenceImages: "supported",
  maxReferenceImages: maxRefs,
  referenceVideo: "unsupported",
  maxReferenceVideoSeconds: null,
  referenceAudio: "unsupported",
  maxReferenceAudioSeconds: null,
  keyframesExcludeReferences: "unsupported",
  negativePrompt: "unsupported",
});

const NO_AUDIO = { nativeGeneration: "unsupported", referenceConditioning: "unsupported" } as const;

const spec = (s: CatalogImageSpec): CatalogImageSpec => s;

export const RUNWAY_IMAGE_MODELS: readonly CatalogModel[] = [
  {
    provider: "runway",
    modelId: "gpt_image_2_5_flare",
    displayName: "GPT Image 2.5 Flare",
    family: "gpt_image",
    role: "reference_rich",
    summary:
      "OpenAI-family image model hosted by Runway. Up to 16 references, each addressable by a tag, and a quality ladder.",
    availability: "available",
    availabilityNote: "",
    verification: verification([
      "The pricing table prices canvases as '1K / 2K' versus '4K' but does not define the pixel boundary: Prism offers only canvases with a long edge of at most 2048 px (the 1K/2K rate) and does not offer the 4K canvases.",
      "How a tag is addressed inside promptText is documented only as 'may be used to reference the image in prompt text'; Prism writes @Tag, the form Runway documents for its Gen-4 image models.",
      "Transparent output is not listed for this model.",
    ]),
    modalities: ["text_to_image", "image_to_image"],
    inputs: imageInputs(16),
    audio: NO_AUDIO,
    duration: NO_DURATION,
    tiers: [
      tier("2k", 2048, 880, {
        // nearest documented canvases (all with a long edge <= 2048 px, within 1% of the label)
        "21:9": "2048:880",
        "16:9": "1920:1088",
        "3:2": "1920:1280",
        "4:3": "1920:1440",
        "5:4": "1920:1536",
        "1:1": "1920:1920",
        "4:5": "1536:1920",
        "3:4": "1440:1920",
        "2:3": "1280:1920",
        "9:16": "1088:1920",
      }),
    ],
    aspectRatios: ["21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"],
    textToVideoAspectRatios: null,
    promptMaxChars: 32_000,
    pricing: pricing({
      perImage: {
        low: { "2k": 1 },
        medium: { "2k": 5 },
        high: { "2k": 16 },
        xhigh: { "2k": 28 },
        max: { "2k": 63 },
      },
      defaultQuality: "medium",
      perReferenceImage: 1,
      referenceBilling: "per_output",
    }),
    image: spec({
      qualities: [
        { id: "low", label: "Low", note: "1 credit" },
        { id: "medium", label: "Medium", note: "5 credits" },
        { id: "high", label: "High", note: "16 credits (the provider default when quality is omitted)" },
        { id: "xhigh", label: "Extra high", note: "28 credits" },
        { id: "max", label: "Max", note: "63 credits" },
      ],
      defaultQuality: "medium",
      referenceAddressing: "tags",
      outputFormats: null,
      providerMaxOutputCount: 10,
      notExposed: [
        "background (opaque|auto): not a quality or cost lever",
        "outputCount > 1: Prism sends 1 so one attempt is one reviewable image",
        "auto ratio and 4K canvases: no exact canvas, and the 4K price boundary is not stated",
      ],
    }),
    concurrencyNote: "Account usage tier dependent; extra tasks are THROTTLED server-side.",
  },
  {
    provider: "runway",
    modelId: "muse_image",
    displayName: "Muse Image",
    family: "muse_image",
    role: "fast_low_cost",
    summary: "Inexpensive stills: 1 credit per image at every size, up to 10 reference images.",
    availability: "available",
    availabilityNote: "",
    verification: verification([
      "No quality option is typed or documented.",
      "Reference tags are not documented; references are described to the model by their order in the prompt.",
      "No exact 16:9 or 9:16 canvas exists: the nearest offered ratios are 7:4 and 4:7.",
    ]),
    modalities: ["text_to_image", "image_to_image"],
    inputs: imageInputs(10),
    audio: NO_AUDIO,
    duration: NO_DURATION,
    tiers: [
      tier("default", 2352, 1008, {
        "21:9": "2352:1008",
        "7:4": "2016:1152",
        "3:2": "1920:1280",
        "4:3": "1792:1344",
        "1:1": "1600:1600",
        "3:4": "1344:1792",
        "2:3": "1280:1920",
        "4:7": "1152:2016",
      }),
    ],
    aspectRatios: ["21:9", "7:4", "3:2", "4:3", "1:1", "3:4", "2:3", "4:7"],
    textToVideoAspectRatios: null,
    promptMaxChars: 4000,
    pricing: pricing({
      perImage: { default: { default: 1 } },
      defaultQuality: "default",
      perReferenceImage: 0,
      referenceBilling: "none",
    }),
    image: spec({
      qualities: [],
      defaultQuality: null,
      referenceAddressing: "order",
      outputFormats: ["png", "webp", "jpeg"],
      providerMaxOutputCount: 10,
      notExposed: [
        "outputCount > 1: Prism sends 1 so one attempt is one reviewable image",
        "auto ratio: no exact canvas",
      ],
    }),
    concurrencyNote: "Account usage tier dependent; extra tasks are THROTTLED server-side.",
  },
  {
    provider: "runway",
    modelId: "seedream5_lite",
    displayName: "Seedream 5 Lite",
    family: "seedream",
    role: "alternative_family",
    summary: "ByteDance Seedream family: up to 14 ordered references, 4 credits per image at every size.",
    availability: "available",
    availabilityNote: "",
    verification: verification([
      "No quality option is typed or documented.",
      "Reference tags are not documented; the model addresses references by upload order ('Figure 1, Figure 2').",
      "The ratio type also accepts freeform sizes (width x height between 3,686,400 and 16,777,216 pixels); Prism uses only the typed canvases.",
    ]),
    modalities: ["text_to_image", "image_to_image"],
    inputs: imageInputs(14),
    audio: NO_AUDIO,
    duration: NO_DURATION,
    tiers: [
      tier("default", 3136, 1344, {
        "21:9": "3136:1344",
        "16:9": "2848:1600",
        "3:2": "2496:1664",
        "4:3": "2304:1728",
        "1:1": "2048:2048",
        "3:4": "1728:2304",
        "2:3": "1664:2496",
        "9:16": "1600:2848",
      }),
    ],
    aspectRatios: ["21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"],
    textToVideoAspectRatios: null,
    promptMaxChars: 4000,
    pricing: pricing({
      perImage: { default: { default: 4 } },
      defaultQuality: "default",
      perReferenceImage: 0,
      referenceBilling: "none",
    }),
    image: spec({
      qualities: [],
      defaultQuality: null,
      referenceAddressing: "order",
      outputFormats: ["png", "jpeg"],
      providerMaxOutputCount: 4,
      notExposed: [
        "grounding (live web search): non-deterministic and unrelated to the Shot's production intent",
        "outputCount > 1: Prism sends 1 so one attempt is one reviewable image",
      ],
    }),
    concurrencyNote: "Account usage tier dependent; extra tasks are THROTTLED server-side.",
  },
];

/**
 * Image models Runway PRICES or DOCUMENTS but that the pinned SDK does not type, so Prism cannot offer them
 * without bypassing the typed SDK (which it never does). A test fails when an SDK upgrade starts typing one.
 */
export interface ImageSdkBlockedModel {
  provider: "runway";
  modelId: string;
  displayName: string;
  credits: string;
  verifiedAt: string;
  blocker: string;
}

export const IMAGE_SDK_BLOCKED_MODELS: readonly ImageSdkBlockedModel[] = [
  {
    provider: "runway",
    modelId: "nano_banana_2.1",
    displayName: "Nano Banana 2.1",
    credits: "4 (1K), 6 (2K), 12 (4K) per image",
    verifiedAt: "2026-10-21",
    blocker:
      "Listed on the pricing page, but absent from the TextToImageCreateParams union of @runwayml/sdk 4.22.0 (checked 2026-10-21). Add a catalog entry and a compiler family when a release types it.",
  },
];
