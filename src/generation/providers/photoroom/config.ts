import { providerEnvName } from "../../config";

/**
 * Phase 5B-I3b: Photoroom "Remove Background" (Basic plan) as a hosted MATTING provider. Facts from Photoroom's own
 * documentation (read 2026-11-08):
 *   - POST https://sdk.photoroom.com/v1/segment, header `x-api-key`, multipart field `image_file`
 *     (docs.photoroom.com/remove-background-api-basic-plan/quickstart-guide)
 *   - inputs PNG / JPEG / WEBP / HEIC, ≤ 50 MB, ≤ 6,000 px on the widest side (docs.photoroom.com/llms-full.txt)
 *   - `format=png&channels=rgba&size=full&crop=false` returns an RGBA PNG; no idempotency key is documented
 *   - "Calls that result in an error will not consume an image" (FAQ); 60 images per minute by default (FAQ)
 *   - "Photoroom doesn't save the images that are processed through the Photoroom API" (FAQ)
 *   - Basic price per image: $0.02 (docs.photoroom.com/getting-started/pricing)
 *
 * PRICING LIVES HERE ONLY. A different contract price is one configuration change
 * (`PRISM_STUDIO_PHOTOROOM_USD_PER_IMAGE`), never a workflow or UI change.
 */
export const PHOTOROOM_PROVIDER_ID = "photoroom";
export const PHOTOROOM_MODEL_ID = "photoroom-remove-background";
export const PHOTOROOM_API_SURFACE = "photoroom-remove-background-v1 (POST /v1/segment)";
export const PHOTOROOM_SECRET_ENV = providerEnvName(PHOTOROOM_PROVIDER_ID, "api_key");
export const PHOTOROOM_DEFAULT_USD_PER_IMAGE = 0.02;
export const PHOTOROOM_PRICING_VERSION = "photoroom-basic-2026-11-08";
export const PHOTOROOM_INPUT_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export const PHOTOROOM_MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const PHOTOROOM_MAX_SIDE_PX = 6_000;
export const PHOTOROOM_PRIVACY_SHORT =
  "Processed by Photoroom. The provider states API images are discarded after processing.";
export const PHOTOROOM_PRIVACY_DETAILS = [
  "The source image is sent to Photoroom's API (servers in the eastern United States) only when you choose High Quality Removal.",
  'Photoroom states: "Photoroom doesn\'t save the images that are processed through the Photoroom API."',
  "Photoroom returns a PNG with an alpha channel; Prism stores it as a new image and never changes the original.",
  "Calls that end in an error are not billed by Photoroom.",
];

/** The configured price per image (USD). Invalid or missing overrides fall back to the documented Basic price. */
export function photoroomUsdPerImage(env: Record<string, string | undefined>): number {
  const raw = env.PRISM_STUDIO_PHOTOROOM_USD_PER_IMAGE?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : PHOTOROOM_DEFAULT_USD_PER_IMAGE;
}
