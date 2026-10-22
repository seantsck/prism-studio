/**
 * Runway: every provider-specific constant lives here, in one place, so API/pricing changes are a one-file edit.
 * Verified against @runwayml/sdk types and docs.dev.runwayml.com: video 2026-10-13 (4.21.0; the video request types are
 * byte-identical in 4.22.0, re-audited 2026-10-21), still images 2026-10-21 (4.22.0).
 */
export const RUNWAY_PROVIDER_ID = "runway";

/** Name of the ONLY credential. Server/worker environment only; never NEXT_PUBLIC_, never logged. */
export const RUNWAY_SECRET_ENV = "RUNWAYML_API_SECRET";

/**
 * `X-Runway-Version` request header. The SDK pins its own default; Prism sets it explicitly so an SDK upgrade
 * can never silently change API behaviour. Change here (and re-verify the request/response shapes) only.
 */
export const RUNWAY_API_VERSION = "2024-11-06";

/** Pricing is versioned configuration, never scraped at runtime. */
export const RUNWAY_PRICING = {
  version: "2026-10-13",
  source: "https://docs.dev.runwayml.com/guides/pricing/",
  currency: "USD",
  usdPerCredit: 0.01,
  models: {
    "gen4.5": { creditsPerSecond: 12 },
  },
} as const;

export const RUNWAY_GEN45 = "gen4.5" as const;

/** Prism aspect ratio → Runway `ratio` (pixel dimensions), per modality (SDK ImageToVideo/TextToVideo Gen4_5). */
export const RUNWAY_RATIOS = {
  image_to_video: {
    "16:9": "1280:720",
    "9:16": "720:1280",
    "4:3": "1104:832",
    "1:1": "960:960",
    "3:4": "832:1104",
    "21:9": "1584:672",
  },
  text_to_video: {
    "16:9": "1280:720",
    "9:16": "720:1280",
  },
} as const;
export const RUNWAY_DEFAULT_RATIO = "16:9";

/** Prompt text limit (UTF-16 code units) for gen4.5. */
export const RUNWAY_MAX_PROMPT_CHARS = 1000;
/** Duration limits: integer seconds 2..10. */
export const RUNWAY_MIN_SECONDS = 2;
export const RUNWAY_MAX_SECONDS = 10;

/** Data URIs are limited to 5 MB encoded (~3.7 MB of bytes). Larger inputs use a short-lived signed URL. */
export const RUNWAY_MAX_DATA_URI_BYTES = 3_500_000;
export const RUNWAY_INPUT_URL_TTL_SECONDS = 300;
export const RUNWAY_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Output URLs are CDN-signed; hosts beyond these can be added with PRISM_STUDIO_RUNWAY_OUTPUT_HOSTS. */
export const RUNWAY_DEFAULT_OUTPUT_HOSTS = ["*.cloudfront.net", "*.runwayml.com"] as const;
