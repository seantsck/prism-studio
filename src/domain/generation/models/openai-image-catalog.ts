import type {
  CatalogImageSpec,
  CatalogModel,
  CatalogPricing,
  CatalogTier,
  CatalogVerification,
  CreditRule,
} from "./types";

/**
 * Phase 5B-I2: GPT Image called DIRECTLY through OpenAI's Images API (`images.generate` / `images.edit`), provider id
 * `openai-image`. Model definitions live here; the adapter (src/generation/providers/openai-image) only translates.
 *
 * Sources (read 2026-11-07):
 *   - openai@7.32.0 resources/images.d.ts: the typed request (ImageModel union, sizes, quality, background, mask)
 *   - https://developers.openai.com/api/docs/guides/image-generation
 *   - https://developers.openai.com/api/reference/resources/images/methods/edit
 *   - https://developers.openai.com/api/docs/pricing and the model pages (gpt-image-2.5-sunburst / -flare)
 *   - https://developers.openai.com/api/docs/deprecations
 *
 * Registered: the two models the guide recommends for new integrations, both typed by the installed SDK, both with
 * native transparent backgrounds (not "preview"), both Zero-Data-Retention eligible.
 *   gpt-image-2.5-flare     fastest high-quality everyday generation
 *   gpt-image-2.5-sunburst  editing precision (the edit endpoint's default model)
 * Not registered:
 *   - gpt-image-2.6-sunburst / -flare: AVAILABLE UPSTREAM, NOT YET DEFAULT (see OPENAI_IMAGE_UPSTREAM_NOT_DEFAULT).
 * The direct Images API is used (not the Responses image-generation tool, which also serves 2.5) because a Prism job is a
 * discrete generation or edit, not a conversational image session.
 *   - gpt-image-2: transparency is preview only; gpt-image-1.5 / -1-mini / chatgpt-image-latest shut down 2026-12-01;
 *     gpt-image-1 / dall-e-* are shut down.
 *
 * PRICING IS TOKEN-BASED (text in $5, image in $8, image out $30 per 1M tokens for both models). OpenAI publishes no
 * per-image price and no output-token counts for 2.5, so the per-image figures below are a PROVISIONAL UPPER BOUND:
 * the published output-token counts for low / medium / high at 1024x1024, 1024x1536 and 1536x1024 (the largest of the
 * three for each quality), times a 1.5 safety margin, at $30 per 1M. They must be recalibrated from the `usage`
 * reported by the first owner-approved paid run. Actual cost is ALWAYS computed from the reported usage; when the
 * provider reports none, the actual cost is recorded as unknown, never guessed.
 */
export const OPENAI_IMAGE_PROVIDER_ID = "openai-image";
export const OPENAI_IMAGE_SDK_REF = "openai@7.32.0";
export const OPENAI_IMAGE_CATALOG_VERIFIED_AT = "2026-11-07";
export const OPENAI_IMAGE_PRICING_VERSION = "openai-image-2026-11-07-provisional";

/** USD per 1M tokens (pricing page, standard tier; both registered models). */
export const OPENAI_IMAGE_TOKEN_RATES = { textInput: 5, imageInput: 8, imageOutput: 30 } as const;

/** Published output-token counts (image-generation guide), the largest of the three standard sizes per quality. */
export const OPENAI_IMAGE_PUBLISHED_OUTPUT_TOKENS = { low: 408, medium: 1584, high: 6240 } as const;
export const OPENAI_IMAGE_ESTIMATE_MARGIN = 1.5;
/** Provisional upper bound of image-INPUT tokens per reference image (not published for 2.5). */
export const OPENAI_IMAGE_PROVISIONAL_INPUT_TOKENS_PER_IMAGE = 6_000;

const SOURCES = [
  "openai@7.32.0 resources/images.d.ts",
  "developers.openai.com/api/docs/guides/image-generation (2026-11-07)",
  "developers.openai.com/api/reference/resources/images/methods/edit (2026-11-07)",
  "developers.openai.com/api/docs/pricing (2026-11-07)",
  "developers.openai.com/api/docs/deprecations (2026-11-07)",
];

const verification = (unstated: string[]): CatalogVerification => ({
  verifiedAt: OPENAI_IMAGE_CATALOG_VERIFIED_AT,
  sources: SOURCES,
  sdkVersion: OPENAI_IMAGE_SDK_REF,
  providerApiVersion: "v1",
  unstated,
});

const NO_VIDEO_RULE: CreditRule = {
  perSecond: {},
  perReferenceImage: 0,
  perReferenceVideoSecond: null,
  referenceVideoBilledCapSeconds: null,
  minimumCredits: null,
};

/** One credit = one US cent here, so the catalog's per-image figures read as cents. */
const USD_PER_CREDIT = 0.01;
const cents = (tokens: number, usdPerMillion: number) =>
  Math.ceil(((tokens * usdPerMillion) / 1_000_000) * 100 * 100) / 100;
const outputCents = (q: keyof typeof OPENAI_IMAGE_PUBLISHED_OUTPUT_TOKENS) =>
  cents(
    OPENAI_IMAGE_PUBLISHED_OUTPUT_TOKENS[q] * OPENAI_IMAGE_ESTIMATE_MARGIN,
    OPENAI_IMAGE_TOKEN_RATES.imageOutput,
  );

const pricing = (): CatalogPricing => ({
  version: OPENAI_IMAGE_PRICING_VERSION,
  verifiedAt: OPENAI_IMAGE_CATALOG_VERIFIED_AT,
  source: "https://developers.openai.com/api/docs/pricing",
  usdPerCredit: USD_PER_CREDIT,
  currency: "USD",
  rule: NO_VIDEO_RULE,
  imageRule: {
    perImage: {
      low: { std: outputCents("low") },
      medium: { std: outputCents("medium") },
      high: { std: outputCents("high") },
    },
    defaultQuality: "medium",
    perReferenceImage: cents(
      OPENAI_IMAGE_PROVISIONAL_INPUT_TOKENS_PER_IMAGE,
      OPENAI_IMAGE_TOKEN_RATES.imageInput,
    ),
    referenceBilling: "per_request",
  },
});

const NO_DURATION = {
  allowedSeconds: null,
  minSeconds: 0,
  maxSeconds: 0,
  stepSeconds: null,
  verified: true,
  note: "Not applicable: a still image has no duration.",
} as const;

/**
 * Pixel canvases as "W:H" (the catalog's canvas notation; the adapter sends "WxH"). The three standard sizes, plus
 * 16:9 / 9:16 custom sizes inside the documented custom-size rules for 2.5 (sides multiples of 16, ratio within 1:3..3:1,
 * 655,360..8,294,400 px). Every canvas is no larger in area than 1536x1024, the largest size with a published count.
 */
const STANDARD: CatalogTier = {
  id: "std",
  label: "Standard (up to 1536 px)",
  canvas: { width: 1536, height: 1024 },
  ratios: {
    "1:1": "1024:1024",
    "3:2": "1536:1024",
    "2:3": "1024:1536",
    "16:9": "1536:864",
    "9:16": "864:1536",
  },
};

const inputs: CatalogModel["inputs"] = {
  startFrame: "unsupported",
  endFrame: "unsupported",
  referenceImages: "supported",
  maxReferenceImages: 16,
  referenceVideo: "unsupported",
  maxReferenceVideoSeconds: null,
  referenceAudio: "unsupported",
  maxReferenceAudioSeconds: null,
  keyframesExcludeReferences: "unsupported",
  negativePrompt: "unsupported",
};

const image = (): CatalogImageSpec => ({
  qualities: [
    { id: "low", label: "Low", note: "fastest, lowest token cost" },
    { id: "medium", label: "Medium", note: "Prism's default" },
    { id: "high", label: "High", note: "most output tokens of the offered qualities" },
  ],
  defaultQuality: "medium",
  referenceAddressing: "order",
  outputFormats: ["png"],
  providerMaxOutputCount: 10,
  notExposed: [
    "quality xhigh / max: no published output-token count, so no honest pre-submit estimate yet",
    "outputCount > 1: Prism sends n=1 so one attempt is one reviewable image",
    "size auto and canvases above 1536 px: no published token count (sizes above 2560x1440 are experimental)",
    "output formats jpeg / webp / gif / svg: Prism stores lossless PNG (alpha-capable)",
    "moderation=low: the provider default (auto) is kept",
    "input_fidelity: not documented for 2.5 (gpt-image-2 says omit it); omitted",
    "markup edits and complexity: documented for 2.5 / 2.6 but not typed by openai@7.32.0",
    "streaming partial images: one final image per attempt",
  ],
});

const COMMON_UNSTATED = [
  "Output-token counts for 2.5 are not published; the estimate uses the older published counts × 1.5 (provisional).",
  "Image-input tokens per reference are not published for 2.5; the estimate assumes at most 6,000 per image (provisional).",
  "Custom 16:9 / 9:16 canvases are assumed to cost no more than 1536x1024 (smaller area).",
  "Masked inpainting is prompt-guided: the documentation warns the result may not follow the mask exactly.",
];

export const OPENAI_IMAGE_MODELS: readonly CatalogModel[] = [
  {
    provider: OPENAI_IMAGE_PROVIDER_ID,
    modelId: "gpt-image-2.5-flare",
    displayName: "GPT Image 2.5 Flare (OpenAI direct)",
    family: "gpt_image",
    role: "reference_rich",
    summary:
      "OpenAI's fastest high-quality image model, called directly. Text-to-image, editing with up to 16 images, and native transparent backgrounds.",
    availability: "available",
    availabilityNote: "",
    verification: verification(COMMON_UNSTATED),
    modalities: ["text_to_image", "image_to_image"],
    inputs,
    audio: { nativeGeneration: "unsupported", referenceConditioning: "unsupported" },
    duration: NO_DURATION,
    tiers: [STANDARD],
    aspectRatios: ["1:1", "3:2", "2:3", "16:9", "9:16"],
    textToVideoAspectRatios: null,
    promptMaxChars: 32_000,
    pricing: pricing(),
    image: image(),
    concurrencyNote: "Usage-tier limits (Build tier: 250K TPM / 20 images per minute).",
  },
  {
    provider: OPENAI_IMAGE_PROVIDER_ID,
    modelId: "gpt-image-2.5-sunburst",
    displayName: "GPT Image 2.5 Sunburst (OpenAI direct)",
    family: "gpt_image",
    role: "reference_rich",
    summary:
      "OpenAI's image model for editing precision, called directly. Text-to-image, editing with up to 16 images, and native transparent backgrounds.",
    availability: "available",
    availabilityNote: "",
    verification: verification(COMMON_UNSTATED),
    modalities: ["text_to_image", "image_to_image"],
    inputs,
    audio: { nativeGeneration: "unsupported", referenceConditioning: "unsupported" },
    duration: NO_DURATION,
    tiers: [STANDARD],
    aspectRatios: ["1:1", "3:2", "2:3", "16:9", "9:16"],
    textToVideoAspectRatios: null,
    promptMaxChars: 32_000,
    pricing: pricing(),
    image: image(),
    concurrencyNote: "Usage-tier limits (Build tier: 250K TPM / 20 images per minute).",
  },
];

/**
 * Models OpenAI offers that Prism knows about but does NOT offer yet. Never registered as models (nothing can select
 * them); kept so the architecture, the docs and the tests name the exact conditions for adopting them.
 */
export const OPENAI_IMAGE_UPSTREAM_NOT_DEFAULT = [
  {
    modelId: "gpt-image-2.6-sunburst",
    status: "available upstream, not yet default",
    upstreamReleased: "2026-11-04",
    until: [
      "the installed SDK types the model (no untyped workaround)",
      "Prism's privacy requirements are satisfied",
      "its Zero Data Retention status is acceptable for unreleased customer material (not listed as of 2026-11-07)",
    ],
  },
  {
    modelId: "gpt-image-2.6-flare",
    status: "available upstream, not yet default",
    upstreamReleased: "2026-11-04",
    until: [
      "the installed SDK types the model (no untyped workaround)",
      "Prism's privacy requirements are satisfied",
      "its Zero Data Retention status is acceptable for unreleased customer material (not listed as of 2026-11-07)",
    ],
  },
] as const;
