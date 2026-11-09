import { createHash } from "node:crypto";
import { RunwayProvider } from "../src/generation/providers/runway/adapter";
import { safeFetch } from "../src/generation/safe-fetch";
import type { GenerationRequest, PromptPlan } from "../src/domain/generation/schemas";
import type { ProviderContext, ProviderJobRef } from "../src/generation/provider";

const TOTAL_CAP_USD = 0.12;
const provider = new RunwayProvider({ env: process.env, maxConcurrency: 1 });
if (!process.env.RUNWAYML_API_SECRET?.trim()) throw new Error("RUNWAYML_API_SECRET is missing");

const plan = (sections: PromptPlan["sections"]): PromptPlan => ({ version: 1, sections });
const imagePlan = plan([
  { key: "subject", title: "Subject", lines: ["A fictional red-coated traveler holding a yellow umbrella."] },
  { key: "environment", title: "Environment", lines: ["Quiet mountain road at dusk, blue lamp post, misty distant hills."] },
  { key: "composition", title: "Composition", lines: ["Cinematic wide composition, subject slightly frame right."] },
  { key: "lighting", title: "Lighting", lines: ["Soft blue-hour ambient light with a warm practical lamp glow."] },
  { key: "hard_constraints", title: "Hard constraints", lines: ["No text, logos, brands, or recognizable real people."] },
]);
const imageReq: GenerationRequest = {
  schemaVersion: 1,
  modality: "text_to_image",
  purpose: "production_frame",
  provider: "runway",
  modelId: "muse_image",
  prompt: { positive: "fictional traveler on a mountain road at dusk", negative: "" },
  durationMs: null,
  resolution: null,
  aspectRatio: "21:9",
  fps: null,
  seed: null,
  references: [],
  startFrameAssetId: null,
  endFrameAssetId: null,
  audioAssetIds: [],
  providerOptions: {},
  idempotencyKey: "runway-live-smoke-image-0001",
};
const imageModel = provider.listModels().find((m) => m.modelId === imageReq.modelId);
if (!imageModel) throw new Error("Muse Image is not in the Prism registry");
const imageValidation = provider.validateRequest(imageReq, imageModel);
if (!imageValidation.ok) throw new Error("Image validation failed: " + imageValidation.errors.join("; "));
const imageEstimate = provider.estimateCost(imageReq, imageModel);
if (imageEstimate.amount == null || imageEstimate.amount > 0.02) {
  throw new Error("Image estimate exceeds the smoke ceiling: " + JSON.stringify(imageEstimate));
}

const emptyCtx: ProviderContext = {
  now: () => new Date(),
  assets: { read: async () => null },
};
async function wait(ref: ProviderJobRef, req: GenerationRequest, ctx: ProviderContext, label: string) {
  for (let n = 0; n < 120; n++) {
    const status = await provider.poll({ ...ref, pollCount: n }, ctx);
    console.log(label + " status=" + status.providerStatus + " state=" + status.state);
    if (status.state === "succeeded") return provider.fetchResult({ ...ref, pollCount: n }, req, ctx);
    if (status.state === "failed" || status.state === "cancelled") {
      throw new Error(label + " failed: " + JSON.stringify(status.failure ?? { state: status.state }));
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(5000, status.retryAfterMs ?? 5000)));
  }
  throw new Error(label + " timed out");
}

console.log("RUNWAY LIVE SMOKE: starting Muse Image; estimated=$" + imageEstimate.amount.toFixed(2));
const imageSub = await provider.submit(imageReq, imagePlan, emptyCtx);
const imageRef: ProviderJobRef = {
  providerJobId: imageSub.providerJobId,
  model: imageReq.modelId,
  pollCount: 0,
  submittedAt: imageSub.acceptedAt,
  idempotencyKey: imageReq.idempotencyKey,
};
const imageResult = await wait(imageRef, imageReq, emptyCtx, "image");
const imageOut = imageResult.outputs[0];
if (!imageOut || imageOut.source.type !== "url") throw new Error("Runway image returned no URL output");
const imageDownload = await safeFetch(
  imageOut.source.url,
  { allowedHosts: provider.allowedOutputHosts() },
  { maxBytes: 25_000_000, timeoutMs: 120_000, maxRedirects: 3 },
);
if (imageDownload.bytes.length < 1000) throw new Error("Runway image output is unexpectedly small");
const imageSha = createHash("sha256").update(imageDownload.bytes).digest("hex");
console.log(
  "RUNWAY LIVE SMOKE: image succeeded actual=$" +
    String(imageResult.cost.amount) +
    " credits=" +
    String(imageResult.cost.units) +
    " bytes=" +
    imageDownload.bytes.length +
    " sha256=" +
    imageSha.slice(0, 16) +
    "…",
);

const FRAME_ID = "runway-live-smoke-frame";
const frameCtx: ProviderContext = {
  now: () => new Date(),
  assets: {
    read: async (assetId) =>
      assetId === FRAME_ID
        ? {
            bytes: imageDownload.bytes,
            mime: imageDownload.contentType?.split(";")[0] || imageOut.mime || "image/png",
            filename: imageOut.filename,
          }
        : null,
  },
};
const videoPlan = plan([
  { key: "action", title: "Action", lines: ["Animate only subtle natural motion after the first frame: coat fabric and umbrella shift gently in the breeze."] },
  { key: "camera", title: "Camera", lines: ["Very slow cinematic push-in. Preserve framing and horizon."] },
  { key: "performance", title: "Performance", lines: ["The fictional traveler remains restrained and nearly still."] },
  { key: "continuity", title: "Continuity", lines: ["Preserve the exact first-frame subject, red coat, yellow umbrella, road, lamp post, and dusk environment."] },
  { key: "hard_constraints", title: "Hard constraints", lines: ["Do not add people, text, logos, props, or change wardrobe."] },
]);
const videoReq: GenerationRequest = {
  schemaVersion: 1,
  modality: "image_to_video",
  purpose: "animate_production_frame",
  provider: "runway",
  modelId: "gen4_turbo",
  prompt: { positive: "subtle motion, slow push-in", negative: "" },
  durationMs: 2000,
  resolution: null,
  aspectRatio: "21:9",
  fps: null,
  seed: null,
  references: [],
  startFrameAssetId: FRAME_ID,
  endFrameAssetId: null,
  audioAssetIds: [],
  providerOptions: {},
  idempotencyKey: "runway-live-smoke-video-0001",
};
const videoModel = provider.listModels().find((m) => m.modelId === videoReq.modelId);
if (!videoModel) throw new Error("Gen-4 Turbo is not in the Prism registry");
const videoValidation = provider.validateRequest(videoReq, videoModel);
if (!videoValidation.ok) throw new Error("Video validation failed: " + videoValidation.errors.join("; "));
const videoEstimate = provider.estimateCost(videoReq, videoModel);
const totalEstimate = (imageEstimate.amount ?? Infinity) + (videoEstimate.amount ?? Infinity);
if (videoEstimate.amount == null || videoEstimate.amount > 0.10 || totalEstimate > TOTAL_CAP_USD) {
  throw new Error("Video/total estimate exceeds smoke ceiling: image=" + imageEstimate.amount + " video=" + videoEstimate.amount);
}
console.log("RUNWAY LIVE SMOKE: starting Gen-4 Turbo 2s; estimated=$" + videoEstimate.amount.toFixed(2));
const videoSub = await provider.submit(videoReq, videoPlan, frameCtx);
const videoRef: ProviderJobRef = {
  providerJobId: videoSub.providerJobId,
  model: videoReq.modelId,
  pollCount: 0,
  submittedAt: videoSub.acceptedAt,
  idempotencyKey: videoReq.idempotencyKey,
};
const videoResult = await wait(videoRef, videoReq, frameCtx, "video");
const videoOut = videoResult.outputs[0];
if (!videoOut || videoOut.source.type !== "url") throw new Error("Runway video returned no URL output");
const videoDownload = await safeFetch(
  videoOut.source.url,
  { allowedHosts: provider.allowedOutputHosts() },
  { maxBytes: 100_000_000, timeoutMs: 180_000, maxRedirects: 3 },
);
if (videoDownload.bytes.length < 10_000) throw new Error("Runway video output is unexpectedly small");
const videoSha = createHash("sha256").update(videoDownload.bytes).digest("hex");
const actualTotal = (imageResult.cost.amount ?? 0) + (videoResult.cost.amount ?? 0);
if (actualTotal > TOTAL_CAP_USD) throw new Error("Provider-reported spend exceeded cap: $" + actualTotal);
console.log(
  "RUNWAY LIVE SMOKE: video succeeded actual=$" +
    String(videoResult.cost.amount) +
    " credits=" +
    String(videoResult.cost.units) +
    " bytes=" +
    videoDownload.bytes.length +
    " sha256=" +
    videoSha.slice(0, 16) +
    "…",
);
console.log("RUNWAY LIVE SMOKE PASS total_provider_reported_usd=$" + actualTotal.toFixed(2));
