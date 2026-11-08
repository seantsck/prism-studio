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
import { composeCutout, MattingRefusal, type MattingEngine } from "../../matting/engine";
import { plainBackgroundKeyer } from "../../matting/keyer";
import { decodePng, encodePngRgba, isPng, PngError } from "../../matting/png";
import type {
  CompiledRequestSummary,
  GenerationProviderAdapter,
  ProviderContext,
  ProviderJobRef,
} from "../../provider";

/**
 * Phase 5B-I3: Remove Background as a provider adapter of the EXISTING generation queue and worker (provider
 * `prism-matting`). It is NOT generative: the engine returns an alpha matte only and the cutout keeps every source
 * RGB value (see matting/engine.ts). Runs inside the worker process: no upload, no credential, no cost
 * (`localNoCost`), deterministic (same source → same bytes → same checksum).
 *
 * Synchronous like OpenAI Images: `submit` computes the cutout and returns `succeeded`, and the worker ingests it under
 * the same lease. Because the engine is deterministic, a result lost to a restart is simply RECOMPUTED from the source
 * in `fetchResult` (idempotent), never "lost" and never duplicated: one job ingests exactly one output.
 */
export const PRISM_MATTING_PROVIDER_ID = "prism-matting";

/** Engines offered as models. A future segmentation engine (pending owner / legal decision) is one more entry. */
const ENGINES: readonly MattingEngine[] = [plainBackgroundKeyer];
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

const engineOf = (modelId: string) => ENGINES.find((e) => e.id === modelId) ?? null;

function model(e: MattingEngine, maxConcurrency: number): GenerationModel {
  return {
    provider: PRISM_MATTING_PROVIDER_ID,
    modelId: e.id,
    displayName: e.displayName,
    description:
      "Removes a plain / studio background from an existing image. Keeps the original pixels and adds an alpha channel (soft edges). Refuses busy backgrounds rather than producing a bad cutout.",
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
      // the output canvas is the SOURCE canvas: no fixed resolutions or aspect ratios
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
        // deterministic and free: recomputing is always safe
        idempotency: true,
        maxConcurrency,
        recommendedPollIntervalMs: 1_000,
        jobTimeoutMs: 5 * 60_000,
        rateLimitNotes: "Local CPU work inside the worker.",
      },
      commercial: { pricing: "flat", currency: "USD", costUnit: "free (local)", unitCost: 0 },
    },
  };
}

interface Held {
  png: Uint8Array;
  width: number;
  height: number;
  details: Record<string, unknown>;
  sourceSha256: string;
  startedAt: string;
  completedAt: string;
  at: number;
}

export class PrismMattingProvider implements GenerationProviderAdapter {
  private readonly held = new Map<string, Held>();
  constructor(private readonly opts: { maxConcurrency?: number } = {}) {}

  info(): GenerationProviderInfo {
    return {
      provider: PRISM_MATTING_PROVIDER_ID,
      displayName: "Prism background removal (local)",
      kind: "real",
      description:
        "Background removal inside Prism's own worker. Segmentation / matting, never a generative redraw; images never leave Prism.",
      requiredConfig: [],
      webhooks: false,
      localNoCost: true,
    };
  }

  listModels(): GenerationModel[] {
    return ENGINES.map((e) => model(e, this.opts.maxConcurrency ?? 2));
  }

  allowedOutputHosts(): string[] {
    return [];
  }

  compileRequest(request: GenerationRequest): CompiledRequestSummary {
    const e = engineOf(request.modelId);
    return {
      endpoint: `local matting (${request.modelId})`,
      fields: {
        engine: e?.id ?? request.modelId,
        engineVersion: e?.version ?? null,
        operation: "background_removal",
        output: "PNG, RGBA, source dimensions, source RGB unchanged",
      },
      attachments: request.references.slice(0, 1).map((r) => ({ role: "source", assetId: r.assetId })),
      notes: ["Nothing is generated: only an alpha channel is computed.", "Runs locally; free."],
    };
  }

  validateRequest(request: GenerationRequest, m: GenerationModel) {
    const errors: string[] = [];
    if (!engineOf(m.modelId)) errors.push(`Unknown background-removal engine ${m.modelId}.`);
    if (request.purpose !== "background_removal") errors.push("This engine only removes backgrounds.");
    if (request.references.length !== 1) errors.push("Background removal takes exactly one source image.");
    return { ok: errors.length === 0, errors };
  }

  estimateCost(): CostEstimate {
    return { amount: 0, currency: "USD", basis: "Local background removal: no provider cost", units: 0 };
  }

  private async cutout(request: GenerationRequest, ctx: ProviderContext): Promise<Omit<Held, "at">> {
    const bad = (code: string, message: string) =>
      new GenerationProviderError("invalid_request", code, message, { retryable: false });
    const engine = engineOf(request.modelId);
    if (!engine) throw bad("matting_unknown_engine", `Unknown background-removal engine ${request.modelId}.`);
    const source = request.references[0];
    if (!source) throw bad("matting_no_source", "Background removal needs a source image.");
    const startedAt = ctx.now().toISOString();
    const asset = await ctx.assets.read(source.assetId);
    if (!asset)
      throw bad("matting_source_unavailable", "The source image could not be read from Prism storage.");
    if (asset.bytes.length > MAX_SOURCE_BYTES)
      throw bad("matting_source_too_large", "The source image is too large.");
    if (!isPng(asset.bytes))
      throw bad(
        "matting_source_type",
        "Background removal currently accepts PNG images (generated images are PNG). Convert a JPEG or WebP first.",
      );
    try {
      const image = decodePng(asset.bytes);
      const matte = engine.matte(image);
      const png = encodePngRgba(composeCutout(image, matte));
      return {
        png,
        width: image.width,
        height: image.height,
        details: { ...matte.details, matte: matte.kind },
        sourceSha256: createHash("sha256").update(asset.bytes).digest("hex"),
        startedAt,
        completedAt: ctx.now().toISOString(),
      };
    } catch (err) {
      if (err instanceof MattingRefusal) throw bad(`matting_${err.code}`, err.message);
      if (err instanceof PngError) throw bad("matting_source_unreadable", err.message);
      throw err;
    }
  }

  async submit(
    request: GenerationRequest,
    _plan: PromptPlan,
    ctx: ProviderContext,
  ): Promise<GenerationSubmission> {
    const out = await this.cutout(request, ctx);
    const providerJobId = `matting-${randomUUID()}`;
    const now = Date.now();
    for (const [k, v] of this.held) if (now - v.at > 30 * 60_000) this.held.delete(k);
    this.held.set(providerJobId, { ...out, at: now });
    return {
      providerJobId,
      providerRequestId: null,
      state: "succeeded",
      providerStatus: "completed",
      acceptedAt: out.startedAt,
    };
  }

  async poll(): Promise<GenerationStatus> {
    // a local job is complete the moment it is submitted; fetchResult recomputes if this process lost it
    return {
      state: "succeeded",
      providerStatus: "completed",
      progress: 1,
      retryAfterMs: null,
      failure: null,
    };
  }

  async fetchResult(
    ref: ProviderJobRef,
    request: GenerationRequest,
    ctx: ProviderContext,
  ): Promise<GenerationResult> {
    const held = this.held.get(ref.providerJobId) ?? (await this.cutout(request, ctx));
    this.held.delete(ref.providerJobId);
    const engine = engineOf(request.modelId)!;
    const source = request.references[0]!;
    const outputSha256 = createHash("sha256").update(held.png).digest("hex");
    return {
      outputs: [
        {
          role: "primary",
          position: 0,
          kind: "image",
          filename: `cutout-${source.assetId.slice(0, 8)}.png`,
          mime: "image/png",
          source: { type: "bytes", base64: Buffer.from(held.png).toString("base64") },
          reported: { width: held.width, height: held.height, durationMs: null, fps: null },
        },
      ],
      provenance: {
        provider: PRISM_MATTING_PROVIDER_ID,
        model: request.modelId,
        providerJobId: ref.providerJobId,
        providerRequestId: null,
        providerModelVersion: engine.version,
        seed: null,
        startedAt: held.startedAt,
        completedAt: held.completedAt,
        actualDurationMs: null,
        actualResolution: { width: held.width, height: held.height },
        actualFps: null,
        finishReason: "completed",
        usedInputs: ["source"],
        settings: {
          operation: "background_removal",
          engine: engine.id,
          engineVersion: engine.version,
          engineLicense: engine.license,
          deterministic: engine.deterministic,
          sourceAssetId: source.assetId,
          sourceSha256: held.sourceSha256,
          output: { format: "png", channels: "rgba", alpha: "matte", rgbUnchanged: true },
        },
        metadata: { ...held.details, outputSha256, local: true, uploadedAnywhere: false },
      },
      cost: { amount: 0, currency: "USD", basis: "Local background removal: no provider cost", units: 0 },
    };
  }
}
