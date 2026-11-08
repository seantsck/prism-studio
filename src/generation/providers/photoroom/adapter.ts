import { createHash, randomUUID } from "node:crypto";
import { GenerationProviderError } from "@/domain/generation/errors";
import type {
  CostEstimate,
  GenerationModel,
  GenerationProviderInfo,
  GenerationRequest,
  GenerationResult,
  GenerationStatus,
  GenerationSubmission,
  PromptPlan,
} from "@/domain/generation/schemas";
import { decodePng, isPng, pngHasAlpha, type RgbaImage } from "../../matting/png";
import type {
  CompiledRequestSummary,
  GenerationProviderAdapter,
  ProviderContext,
  ProviderJobRef,
} from "../../provider";
import {
  PHOTOROOM_API_SURFACE,
  PHOTOROOM_INPUT_MIMES,
  PHOTOROOM_MAX_INPUT_BYTES,
  PHOTOROOM_MODEL_ID,
  PHOTOROOM_PRICING_VERSION,
  PHOTOROOM_PROVIDER_ID,
  PHOTOROOM_SECRET_ENV,
  photoroomUsdPerImage,
} from "./config";
import { PhotoroomTransportError, type PhotoroomResult, type PhotoroomTransport } from "./transport";

/**
 * Phase 5B-I3b: Photoroom Remove Background — the hosted, production-quality MATTING implementation next to Prism's
 * local keyer. Classified as matting (never generative editing). Only ever runs after an explicit creator action
 * ("High Quality Removal"); never as an automatic fallback.
 *
 *  - Credentials: `PRISM_STUDIO_PROVIDER_PHOTOROOM_API_KEY`, WORKER ONLY. The web queues it as worker-backed.
 *  - Paid: billed per image at the configured price; the spend gate applies at submit and again in the worker.
 *  - Synchronous: `submit` makes the one billable call and the worker ingests it under the same lease. No idempotency
 *    key exists, so an ambiguous call is never re-sent (the worker's resubmission guard), and a result held by a process
 *    that died is reported honestly instead of being requested (and billed) again.
 *  - Pixel identity: Photoroom's foreground is the provider's process (`foregroundPreservation: "provider-process"`).
 *    Prism records whether the opaque pixels' RGB matches the source ONLY when it could check it from the bytes.
 */
const CALL_TIMEOUT_MS = 60_000;

interface Held {
  result: PhotoroomResult;
  width: number;
  height: number;
  rgbUnchangedVerified: boolean | null;
  sourceSha256: string;
  startedAt: string;
  completedAt: string;
  at: number;
}

export interface PhotoroomProviderOptions {
  env?: Record<string, string | undefined>;
  transportFactory?: (apiKey: string) => PhotoroomTransport | Promise<PhotoroomTransport>;
}

/** Whether every OPAQUE output pixel kept the source's RGB (null when it cannot be checked from the bytes). */
function opaqueRgbMatches(source: RgbaImage | null, cut: RgbaImage): boolean | null {
  if (!source || source.width !== cut.width || source.height !== cut.height) return null;
  for (let i = 0; i < cut.width * cut.height; i++) {
    if (cut.data[i * 4 + 3] !== 255) continue;
    for (let c = 0; c < 3; c++) if (cut.data[i * 4 + c] !== source.data[i * 4 + c]) return false;
  }
  return true;
}

export class PhotoroomProvider implements GenerationProviderAdapter {
  private readonly env: Record<string, string | undefined>;
  private readonly transportFactory: (apiKey: string) => PhotoroomTransport | Promise<PhotoroomTransport>;
  private readonly held = new Map<string, Held>();

  constructor(opts: PhotoroomProviderOptions = {}) {
    this.env = opts.env ?? process.env;
    this.transportFactory =
      opts.transportFactory ??
      (async (apiKey) => {
        const { HttpPhotoroomTransport } = await import("./http-transport");
        return new HttpPhotoroomTransport({ apiKey });
      });
  }

  info(): GenerationProviderInfo {
    return {
      provider: PHOTOROOM_PROVIDER_ID,
      displayName: "Photoroom",
      kind: "real",
      description:
        "Photoroom Remove Background: hosted, production-quality background removal (matting, not generation). Paid per image; used only on an explicit High Quality Removal.",
      requiredConfig: [PHOTOROOM_SECRET_ENV],
      webhooks: false,
    };
  }

  private usdPerImage(): number {
    return photoroomUsdPerImage(this.env);
  }

  listModels(): GenerationModel[] {
    return [
      {
        provider: PHOTOROOM_PROVIDER_ID,
        modelId: PHOTOROOM_MODEL_ID,
        displayName: "High Quality Removal (Photoroom)",
        description:
          "Hosted background removal for complex backgrounds: hair, fabric, busy scenes. Returns a PNG with alpha.",
        kind: "real",
        lifecycle: "active",
        capabilities: {
          modalities: ["image_to_image"],
          references: {
            textPrompt: false,
            negativePrompt: false,
            referenceImages: true,
            maxReferences: 1,
            orderedReferences: false,
            characterReferences: true,
            styleReferences: false,
            locationReferences: false,
            startFrame: false,
            endFrame: false,
            referenceVideo: false,
            referenceAudio: false,
            keyframesExcludeReferences: false,
          },
          video: null,
          image: { resolutions: [], aspectRatios: [], transparency: true, editing: false },
          audio: {
            nativeDialogueAudio: false,
            audioConditioning: false,
            lipSync: false,
            referenceAudio: false,
            soundGeneration: false,
          },
          operational: {
            mode: "sync",
            polling: false,
            webhook: false,
            cancellation: false,
            idempotency: false,
            maxConcurrency: 2,
            recommendedPollIntervalMs: 1_000,
            jobTimeoutMs: 5 * 60_000,
            rateLimitNotes: "Photoroom default: 60 images per minute.",
          },
          commercial: {
            pricing: "per_output",
            currency: "USD",
            costUnit: "image",
            unitCost: this.usdPerImage(),
          },
        },
      },
    ];
  }

  allowedOutputHosts(): string[] {
    return [];
  }

  compileRequest(request: GenerationRequest): CompiledRequestSummary {
    return {
      endpoint: `POST /v1/segment (${PHOTOROOM_API_SURFACE})`,
      fields: {
        format: "png",
        channels: "rgba",
        size: "full",
        crop: false,
        estimatedUsd: this.usdPerImage(),
      },
      attachments: request.references.slice(0, 1).map((r) => ({ role: "source", assetId: r.assetId })),
      notes: ["The source image is sent to Photoroom.", "Matting, not generation."],
    };
  }

  validateRequest(request: GenerationRequest) {
    const errors: string[] = [];
    if (request.modelId !== PHOTOROOM_MODEL_ID) errors.push(`Unknown Photoroom model ${request.modelId}.`);
    if (request.purpose !== "background_removal")
      errors.push("Photoroom is used only to remove backgrounds.");
    if (request.references.length !== 1) errors.push("Background removal takes exactly one source image.");
    return { ok: errors.length === 0, errors };
  }

  estimateCost(): CostEstimate {
    const usd = this.usdPerImage();
    return {
      amount: usd,
      currency: "USD",
      basis: `Photoroom Remove Background: $${usd} per image (${PHOTOROOM_PRICING_VERSION})`,
      units: 1,
    };
  }

  private async transport(): Promise<PhotoroomTransport> {
    const key = this.env[PHOTOROOM_SECRET_ENV]?.trim();
    if (!key) {
      throw new GenerationProviderError(
        "auth",
        "photoroom_not_configured",
        "High Quality Removal is not configured on this server.",
        { retryable: false },
      );
    }
    return this.transportFactory(key);
  }

  async submit(
    request: GenerationRequest,
    _plan: PromptPlan,
    ctx: ProviderContext,
  ): Promise<GenerationSubmission> {
    const bad = (code: string, message: string) =>
      new GenerationProviderError("invalid_request", code, message, { retryable: false });
    const v = this.validateRequest(request);
    if (!v.ok) throw bad("photoroom_invalid_request", v.errors[0]!);
    const transport = await this.transport();
    const source = request.references[0]!;
    const asset = await ctx.assets.read(source.assetId);
    if (!asset)
      throw bad("photoroom_source_unavailable", "The source image could not be read from Prism storage.");
    const mime = (asset.mime ?? "").toLowerCase().replace("image/jpg", "image/jpeg");
    if (!(PHOTOROOM_INPUT_MIMES as readonly string[]).includes(mime))
      throw bad("photoroom_source_type", "High Quality Removal accepts PNG, JPEG or WebP images.");
    if (asset.bytes.length > PHOTOROOM_MAX_INPUT_BYTES)
      throw bad("photoroom_source_too_large", "The source image is larger than 50 MB.");
    const startedAt = ctx.now().toISOString();
    let result: PhotoroomResult;
    try {
      result = await transport.segment({
        image: { bytes: asset.bytes, mime, filename: asset.filename || `${source.assetId}.png` },
        timeoutMs: CALL_TIMEOUT_MS,
        signal: ctx.signal,
      });
    } catch (err) {
      throw mapPhotoroomError(err);
    }
    // normalize: Prism stores a PNG with alpha. Anything else is refused (never stored as if it were a cutout).
    if (!isPng(result.bytes) || !pngHasAlpha(result.bytes))
      throw new GenerationProviderError(
        "permanent",
        "photoroom_unexpected_output",
        "Photoroom did not return a PNG with transparency.",
        { retryable: false },
      );
    let cut: RgbaImage | null = null;
    try {
      cut = decodePng(result.bytes);
    } catch {
      cut = null;
    }
    let sourceImage: RgbaImage | null = null;
    if (isPng(asset.bytes)) {
      try {
        sourceImage = decodePng(asset.bytes);
      } catch {
        sourceImage = null;
      }
    }
    const providerJobId = `photoroom-${randomUUID()}`;
    const now = Date.now();
    for (const [k, h] of this.held) if (now - h.at > 60 * 60_000) this.held.delete(k);
    this.held.set(providerJobId, {
      result,
      width: cut?.width ?? 0,
      height: cut?.height ?? 0,
      rgbUnchangedVerified: cut ? opaqueRgbMatches(sourceImage, cut) : null,
      sourceSha256: createHash("sha256").update(asset.bytes).digest("hex"),
      startedAt,
      completedAt: ctx.now().toISOString(),
      at: now,
    });
    return {
      providerJobId,
      providerRequestId: null,
      state: "succeeded",
      providerStatus: "completed",
      acceptedAt: startedAt,
    };
  }

  async poll(ref: ProviderJobRef): Promise<GenerationStatus> {
    if (this.held.has(ref.providerJobId))
      return {
        state: "succeeded",
        providerStatus: "completed",
        progress: 1,
        retryAfterMs: null,
        failure: null,
      };
    return {
      state: "failed",
      providerStatus: "result_not_retained",
      progress: null,
      retryAfterMs: null,
      failure: notRetained(),
    };
  }

  async fetchResult(ref: ProviderJobRef, request: GenerationRequest): Promise<GenerationResult> {
    const held = this.held.get(ref.providerJobId);
    if (!held) {
      const f = notRetained();
      throw new GenerationProviderError(f.category, f.code, f.message, { retryable: false });
    }
    const source = request.references[0]!;
    const usd = this.usdPerImage();
    return {
      outputs: [
        {
          role: "primary",
          position: 0,
          kind: "image",
          filename: `cutout-hq-${source.assetId.slice(0, 8)}.png`,
          mime: "image/png",
          source: { type: "bytes", base64: Buffer.from(held.result.bytes).toString("base64") },
          reported: {
            width: held.width > 0 ? held.width : null,
            height: held.height > 0 ? held.height : null,
            durationMs: null,
            fps: null,
          },
        },
      ],
      provenance: {
        provider: PHOTOROOM_PROVIDER_ID,
        model: PHOTOROOM_MODEL_ID,
        providerJobId: ref.providerJobId,
        providerRequestId: null,
        providerModelVersion: PHOTOROOM_API_SURFACE,
        seed: null,
        startedAt: held.startedAt,
        completedAt: held.completedAt,
        actualDurationMs: null,
        actualResolution: held.width > 0 ? { width: held.width, height: held.height } : null,
        actualFps: null,
        finishReason: "completed",
        usedInputs: ["source"],
        settings: {
          operation: "background_removal",
          classification: "matting",
          engine: PHOTOROOM_MODEL_ID,
          apiSurface: PHOTOROOM_API_SURFACE,
          request: { format: "png", channels: "rgba", size: "full", crop: false },
          sourceAssetId: source.assetId,
          sourceSha256: held.sourceSha256,
          output: {
            format: "png",
            channels: "rgba",
            alpha: "matte",
            // the provider's own process, NOT Prism's local guarantee
            foregroundPreservation: "provider-process",
            // checked from the bytes when possible: true / false, or null = could not be verified
            rgbUnchangedVerified: held.rgbUnchangedVerified,
          },
        },
        metadata: {
          uncertaintyScore: held.result.uncertaintyScore,
          reportedContentType: held.result.contentType,
          outputSha256: createHash("sha256").update(held.result.bytes).digest("hex"),
          pricingVersion: PHOTOROOM_PRICING_VERSION,
          uploadedTo: "photoroom",
        },
      },
      // Photoroom reports no per-request cost: the configured contract price is what one successful call bills
      cost: {
        amount: usd,
        currency: "USD",
        basis: `Photoroom Remove Background: $${usd} per successful image (${PHOTOROOM_PRICING_VERSION})`,
        units: 1,
      },
    };
  }
}

function notRetained() {
  return {
    category: "permanent" as const,
    code: "photoroom_result_not_retained",
    message:
      "Photoroom processed the image but the worker restarted before storing it. It may have been billed; run High Quality Removal again if needed.",
  };
}

/** Transport failure → Prism's taxonomy. An ambiguous outcome is never classified as a clean refusal. */
export function mapPhotoroomError(err: unknown): GenerationProviderError {
  if (err instanceof GenerationProviderError) return err;
  if (!(err instanceof PhotoroomTransportError))
    return new GenerationProviderError("transient", "photoroom_unknown", "The Photoroom request failed.");
  const s = err.status;
  if (s === 401 || s === 403)
    return new GenerationProviderError("auth", `photoroom_http_${s}`, "Photoroom refused the credentials.", {
      retryable: false,
    });
  if (s === 402)
    return new GenerationProviderError(
      "quota",
      "photoroom_no_credits",
      "The Photoroom account has no credits left.",
      {
        retryable: false,
      },
    );
  if (s === 429)
    return new GenerationProviderError(
      "rate_limit",
      "photoroom_rate_limited",
      "Photoroom is rate limiting requests.",
      {
        retryAfterMs: 5_000,
      },
    );
  if (s != null && s >= 400 && s < 500)
    return new GenerationProviderError(
      "invalid_request",
      `photoroom_http_${s}`,
      err.message || "Photoroom rejected the image.",
      {
        retryable: false,
      },
    );
  return new GenerationProviderError(
    err.code === "timeout" ? "timeout" : "provider_unavailable",
    `photoroom_${err.code}`,
    "Photoroom did not confirm the request; it may have been processed.",
  );
}
