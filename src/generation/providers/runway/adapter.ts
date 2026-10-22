import RunwayML from "@runwayml/sdk";
import type { IgnoredFeature } from "@/domain/generation/compatibility";
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
import type {
  CompiledRequestSummary,
  GenerationProviderAdapter,
  ProviderContext,
  ProviderJobRef,
} from "../../provider";
import {
  catalogModel,
  estimateCredits,
  estimateImageCredits,
  isImageCatalogModel,
  RUNWAY_MODELS,
  RUNWAY_PRICING_VERSION,
  toGenerationModel,
} from "@/domain/generation/models/catalog";
import type { CatalogModel } from "@/domain/generation/models/types";
import { compileRunwayImagePrompt, compileRunwayPrompt, omissionsAsIgnoredFeatures } from "./compile";
import {
  buildImageCall,
  imageQualityFor,
  imageRatioFor,
  IMAGE_OUTPUT_COUNT,
  referenceLegend,
  runwayImageTags,
  validateImageRequest,
  type ResolvedImageReference,
} from "./image-families";
import {
  buildCall,
  canvasOf,
  endpointFor,
  nativeAudioRequested,
  promptLimit,
  ratioFor,
  tierFor,
  validateForModel,
  type ResolvedInputs,
} from "./families";
import {
  RUNWAY_API_VERSION,
  RUNWAY_DEFAULT_OUTPUT_HOSTS,
  RUNWAY_GEN45,
  RUNWAY_IMAGE_MIMES,
  RUNWAY_INPUT_URL_TTL_SECONDS,
  RUNWAY_MAX_DATA_URI_BYTES,
  RUNWAY_PRICING,
  RUNWAY_PROVIDER_ID,
  RUNWAY_SECRET_ENV,
} from "./config";
import { mapRunwayError, mapRunwayFailure } from "./errors";

/** Typed against the SDK's own request union: no cast, no hand-written body. */
type CreateImage = (
  body: RunwayML.TextToImageCreateParams,
  opts?: { signal?: AbortSignal | null; timeout?: number },
) => PromiseLike<{ id: string; estimatedCost?: { credits: number } }>;

/**
 * Compile-time proof that the REAL SDK's `textToImage.create` satisfies the narrowed signature above (the client object is
 * narrowed once, at construction, for the video endpoints too). If an SDK change broke the image call shape, this line
 * would stop compiling instead of the mismatch hiding behind that narrowing.
 */
const sdkImageCreateMatches: RunwayML["textToImage"]["create"] extends (
  body: RunwayML.TextToImageCreateParams,
  opts?: never,
) => PromiseLike<{ id: string }>
  ? true
  : never = true;
void sdkImageCreateMatches;

type Create = (
  body: Record<string, unknown>,
  opts?: { signal?: AbortSignal | null; timeout?: number },
) => PromiseLike<{ id: string; estimatedCost?: { credits: number } }>;

/** The slice of the SDK this adapter uses. Real = `new RunwayML(...)`; tests inject an HTTP-level double. */
export interface RunwayClientLike {
  textToVideo: { create: Create };
  imageToVideo: { create: Create };
  /** Still images (SDK 4.22.0): Production Frame candidates. */
  textToImage: { create: CreateImage };
  tasks: {
    retrieve(id: string, opts?: { signal?: AbortSignal | null }): PromiseLike<RunwayTask>;
    delete(id: string, opts?: { signal?: AbortSignal | null }): PromiseLike<unknown>;
  };
}

/** Task shape (SDK `TaskRetrieveResponse`), narrowed to what Prism reads. */
export interface RunwayTask {
  id: string;
  status: "PENDING" | "THROTTLED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  createdAt?: string;
  progress?: number;
  output?: string[];
  failure?: string;
  failureCode?: string;
  cost?: { credits: number };
  estimatedCost?: { credits: number };
}

export interface RunwayProviderOptions {
  env?: Record<string, string | undefined>;
  /** Tests/fixtures inject a client; production builds the official SDK client from the environment secret. */
  clientFactory?: (apiKey: string) => RunwayClientLike;
  /** Provider-side concurrency Prism respects (account tier dependent). Default 1. */
  maxConcurrency?: number;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const secondsOf = (ms: number) => ms / 1000;

export function gen45Model(maxConcurrency = 1): GenerationModel {
  return toGenerationModel(catalogModel(RUNWAY_PROVIDER_ID, RUNWAY_GEN45)!, { maxConcurrency });
}

/** Every catalog model (video and still image) as a provider-independent GenerationModel. */
export function runwayModels(maxConcurrency = 1): GenerationModel[] {
  return RUNWAY_MODELS.map((m) => toGenerationModel(m, { maxConcurrency }));
}

export class RunwayProvider implements GenerationProviderAdapter {
  private readonly env: Record<string, string | undefined>;
  private readonly clientFactory: (apiKey: string) => RunwayClientLike;
  private readonly maxConcurrency: number;

  constructor(opts: RunwayProviderOptions = {}) {
    this.env = opts.env ?? process.env;
    this.maxConcurrency =
      opts.maxConcurrency ??
      Math.min(20, Math.max(1, Number.parseInt(this.env.PRISM_STUDIO_RUNWAY_MAX_CONCURRENCY ?? "", 10) || 1));
    this.clientFactory =
      opts.clientFactory ??
      ((apiKey) =>
        new RunwayML({
          apiKey,
          runwayVersion: RUNWAY_API_VERSION,
          // Prism, not the SDK, decides about repeating a request: a blind SDK retry of a create call could
          // start (and bill) a second task because Runway offers no idempotency key.
          maxRetries: 0,
          timeout: 30_000,
        }) as unknown as RunwayClientLike);
  }

  info(): GenerationProviderInfo {
    return {
      provider: RUNWAY_PROVIDER_ID,
      displayName: "Runway",
      kind: "real",
      description:
        "Runway API (developer platform): Runway Gen-4 models plus hosted Veo, Seedance and Hailuo video, and hosted still-image models (GPT Image, Seedream, Muse). Paid generation: credits are consumed per second of video or per image.",
      requiredConfig: [RUNWAY_SECRET_ENV],
      webhooks: false,
    };
  }

  listModels(): GenerationModel[] {
    return runwayModels(this.maxConcurrency);
  }

  allowedOutputHosts(): string[] {
    const extra = (this.env.PRISM_STUDIO_RUNWAY_OUTPUT_HOSTS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/.test(s));
    return [...RUNWAY_DEFAULT_OUTPUT_HOSTS, ...extra];
  }

  // ───────────────────────── compile / validate / estimate (pure, no network) ─────────────────────────

  private cat(modelId: string): CatalogModel | null {
    return catalogModel(RUNWAY_PROVIDER_ID, modelId);
  }

  /** The image prompt and the reference tags it names: pure given the frozen request and plan. */
  private compileImagePrompt(model: CatalogModel, request: GenerationRequest, plan: PromptPlan) {
    const tags =
      model.image?.referenceAddressing === "tags"
        ? runwayImageTags(request.references)
        : request.references.map(() => null);
    const legend = referenceLegend(model, request.references, tags);
    return {
      ...compileRunwayImagePrompt(plan, promptLimit(model), { modelName: model.displayName, legend }),
      tags,
    };
  }

  private compilePrompt(model: CatalogModel, plan: PromptPlan) {
    return compileRunwayPrompt(plan, promptLimit(model), {
      modelName: model.displayName,
      negativeSent: model.inputs.negativePrompt === "supported",
      audioReference: model.audio.referenceConditioning === "supported",
    });
  }

  compileRequest(request: GenerationRequest, plan: PromptPlan): CompiledRequestSummary {
    const model = this.cat(request.modelId);
    if (!model) {
      return {
        endpoint: `unknown Runway model ${request.modelId}`,
        fields: { model: request.modelId },
        attachments: [],
        notes: [`${request.modelId} is not in the Prism model catalog.`],
      };
    }
    if (isImageCatalogModel(model)) return this.compileImageRequest(model, request, plan);
    const compiled = this.compilePrompt(model, plan);
    const { ratio, tier, defaulted, aspect } = ratioFor(model, request);
    const endpoint = endpointFor(request);
    const notes = [...compiled.notes];
    if (defaulted) notes.push(`No aspect ratio on the shot: Prism asks for ${aspect}.`);
    for (const o of compiled.omissions) {
      notes.push(
        `Prompt limit: ${o.omittedLines} of ${o.totalLines} ${o.label.toLowerCase()} line(s) not sent.`,
      );
    }
    if (!model.duration.verified) {
      notes.push(`Duration bounds are not documented for ${model.displayName}; the provider validates them.`);
    }
    const attachments: CompiledRequestSummary["attachments"] = [];
    if (request.startFrameAssetId)
      attachments.push({ role: "first_frame", assetId: request.startFrameAssetId });
    if (request.endFrameAssetId) attachments.push({ role: "last_frame", assetId: request.endFrameAssetId });
    for (const r of request.references) attachments.push({ role: `reference:${r.role}`, assetId: r.assetId });
    for (const a of request.audioAssetIds) attachments.push({ role: "reference_audio", assetId: a });
    const credits = estimateCredits(model, this.pricingInputs(model, request));
    return {
      endpoint: `POST /v1/${endpoint} (${request.modelId})`,
      fields: {
        model: request.modelId,
        promptText: compiled.text,
        promptTextLength: compiled.text.length,
        duration: request.durationMs != null ? secondsOf(request.durationMs) : null,
        ratio,
        resolutionTier: model.tiers.length > 1 ? tier.id : null,
        seed: request.seed,
        outputFormat: "mp4",
        nativeAudio:
          model.audio.nativeGeneration === "supported" ? nativeAudioRequested(model, request) : null,
        negativePromptSent:
          model.inputs.negativePrompt === "supported" && Boolean(request.prompt.negative.trim()),
        estimatedCredits: credits.credits,
        apiVersion: RUNWAY_API_VERSION,
      },
      attachments,
      notes,
    };
  }

  private compileImageRequest(
    model: CatalogModel,
    request: GenerationRequest,
    plan: PromptPlan,
  ): CompiledRequestSummary {
    const compiled = this.compileImagePrompt(model, request, plan);
    const ratio = imageRatioFor(model, request);
    const quality = imageQualityFor(model, request);
    const credits = estimateImageCredits(model, this.imagePricingInputs(model, request));
    const notes = [...compiled.notes];
    for (const o of compiled.omissions) {
      notes.push(
        `Prompt limit: ${o.omittedLines} of ${o.totalLines} ${o.label.toLowerCase()} line(s) not sent.`,
      );
    }
    notes.push("One attempt is one image: Prism always requests outputCount 1.");
    return {
      endpoint: `POST /v1/text_to_image (${request.modelId})`,
      fields: {
        model: request.modelId,
        purpose: request.purpose ?? "shot_output",
        requestModality: request.modality,
        promptText: compiled.text,
        promptTextLength: compiled.text.length,
        ratio,
        quality,
        outputCount: IMAGE_OUTPUT_COUNT,
        referenceCount: request.references.length,
        referenceTags: compiled.tags,
        negativePromptSent: false,
        estimatedCredits: credits.credits,
        apiVersion: RUNWAY_API_VERSION,
      },
      attachments: request.references.map((r, i) => ({
        role: `reference:${r.role}${compiled.tags[i] ? `:@${compiled.tags[i]}` : `:#${i + 1}`}`,
        assetId: r.assetId,
      })),
      notes,
    };
  }

  private imagePricingInputs(model: CatalogModel, request: GenerationRequest) {
    return {
      tierId: model.tiers[0]!.id,
      quality: imageQualityFor(model, request),
      referenceImages: request.references.length,
      outputCount: IMAGE_OUTPUT_COUNT,
    };
  }

  additionalIgnoredFeatures(request: GenerationRequest, plan: PromptPlan): IgnoredFeature[] {
    const model = this.cat(request.modelId);
    if (!model) return [];
    if (isImageCatalogModel(model)) {
      return omissionsAsIgnoredFeatures(
        this.compileImagePrompt(model, request, plan).omissions,
        promptLimit(model),
      );
    }
    return omissionsAsIgnoredFeatures(this.compilePrompt(model, plan).omissions, promptLimit(model));
  }

  validateRequest(request: GenerationRequest, model: GenerationModel) {
    const cat = this.cat(model.modelId);
    if (!cat) return { ok: false, errors: [`Unsupported Runway model ${model.modelId}.`] };
    const errors = isImageCatalogModel(cat)
      ? validateImageRequest(cat, request)
      : validateForModel(cat, request);
    return { ok: errors.length === 0, errors };
  }

  private pricingInputs(model: CatalogModel, request: GenerationRequest) {
    return {
      seconds: request.durationMs != null ? secondsOf(request.durationMs) : 0,
      tierId: tierFor(model, request).id,
      nativeAudio: nativeAudioRequested(model, request),
      referenceImages: request.references.length,
      referenceVideoSeconds: 0,
      startFrame: Boolean(request.startFrameAssetId),
      endFrame: Boolean(request.endFrameAssetId),
    };
  }

  estimateCost(request: GenerationRequest, model: GenerationModel): CostEstimate {
    const cat = this.cat(model.modelId);
    if (cat && isImageCatalogModel(cat)) {
      const r = estimateImageCredits(cat, this.imagePricingInputs(cat, request));
      return { amount: r.amountUsd, currency: RUNWAY_PRICING.currency, basis: r.basis, units: r.credits };
    }
    if (!cat || request.durationMs == null) {
      return {
        amount: null,
        currency: RUNWAY_PRICING.currency,
        basis: "duration or model unknown",
        units: null,
      };
    }
    const r = estimateCredits(cat, this.pricingInputs(cat, request));
    return {
      amount: r.amountUsd,
      currency: RUNWAY_PRICING.currency,
      basis: r.basis,
      units: r.credits,
    };
  }

  // ───────────────────────── provider calls ─────────────────────────

  private client(): RunwayClientLike {
    const key = this.env[RUNWAY_SECRET_ENV]?.trim();
    if (!key) {
      throw new GenerationProviderError(
        "auth",
        "runway_not_configured",
        "Runway is not configured on this server.",
        { retryable: false },
      );
    }
    return this.clientFactory(key);
  }

  /** An input asset as a data URI (up to 3.5 MB) or a short-lived signed URL for larger ones. */
  private async inputUri(assetId: string, kind: "image" | "audio", ctx: ProviderContext): Promise<string> {
    const bad = (code: string, message: string) =>
      new GenerationProviderError("invalid_request", code, message, { retryable: false });
    const noun = kind === "image" ? "image" : "audio file";
    const asset = await ctx.assets.read(assetId);
    if (!asset) throw bad("runway_input_unavailable", `The ${noun} could not be read from Prism storage.`);
    const mime = (asset.mime ?? "").toLowerCase().replace("image/jpg", "image/jpeg");
    const typeOk =
      kind === "image" ? (RUNWAY_IMAGE_MIMES as readonly string[]).includes(mime) : mime.startsWith("audio/");
    if (!typeOk) {
      throw bad(
        "runway_input_type",
        kind === "image" ? "Runway accepts JPEG, PNG or WebP images." : "Runway accepts audio files only.",
      );
    }
    if (asset.bytes.length <= RUNWAY_MAX_DATA_URI_BYTES) {
      return `data:${mime};base64,${Buffer.from(asset.bytes).toString("base64")}`;
    }
    const url = await ctx.assets.signedUrl?.(assetId, RUNWAY_INPUT_URL_TTL_SECONDS);
    if (!url) {
      throw bad(
        "runway_input_too_large",
        `The ${noun} is too large to embed and this storage cannot issue a short-lived URL.`,
      );
    }
    return url;
  }

  async submit(
    request: GenerationRequest,
    plan: PromptPlan,
    ctx: ProviderContext,
  ): Promise<GenerationSubmission> {
    const model = this.cat(request.modelId);
    const errors = model
      ? isImageCatalogModel(model)
        ? validateImageRequest(model, request)
        : validateForModel(model, request)
      : [`Unsupported Runway model ${request.modelId}.`];
    if (!model || errors.length > 0) {
      throw new GenerationProviderError("invalid_request", "runway_invalid_request", errors[0]!, {
        retryable: false,
      });
    }
    const client = this.client();
    if (isImageCatalogModel(model)) return this.submitImage(client, model, request, plan, ctx);
    try {
      const uris: ResolvedInputs = { first: null, last: null, references: [], audio: [] };
      if (request.startFrameAssetId)
        uris.first = await this.inputUri(request.startFrameAssetId, "image", ctx);
      if (request.endFrameAssetId) uris.last = await this.inputUri(request.endFrameAssetId, "image", ctx);
      for (const r of request.references) uris.references.push(await this.inputUri(r.assetId, "image", ctx));
      for (const a of request.audioAssetIds) uris.audio.push(await this.inputUri(a, "audio", ctx));
      const { endpoint, body } = buildCall(model, request, this.compilePrompt(model, plan).text, uris);
      const created: { id: string } =
        endpoint === "image_to_video"
          ? await client.imageToVideo.create(body, { signal: ctx.signal })
          : await client.textToVideo.create(body, { signal: ctx.signal });
      if (!created?.id) {
        throw new GenerationProviderError("permanent", "runway_no_task_id", "Runway returned no task id.");
      }
      return {
        providerJobId: created.id,
        providerRequestId: null,
        state: "queued",
        providerStatus: "PENDING",
        acceptedAt: ctx.now().toISOString(),
      };
    } catch (err) {
      throw mapRunwayError(err);
    }
  }

  /** Production Frame candidates: ONE text_to_image task that returns ONE image. */
  private async submitImage(
    client: RunwayClientLike,
    model: CatalogModel,
    request: GenerationRequest,
    plan: PromptPlan,
    ctx: ProviderContext,
  ): Promise<GenerationSubmission> {
    try {
      const refs: ResolvedImageReference[] = [];
      for (const r of request.references) {
        refs.push({ uri: await this.inputUri(r.assetId, "image", ctx), role: r.role, label: r.label });
      }
      const compiled = this.compileImagePrompt(model, request, plan);
      const { body } = buildImageCall(model, request, compiled.text, refs);
      const created: { id: string } = await client.textToImage.create(body, { signal: ctx.signal });
      if (!created?.id) {
        throw new GenerationProviderError("permanent", "runway_no_task_id", "Runway returned no task id.");
      }
      return {
        providerJobId: created.id,
        providerRequestId: null,
        state: "queued",
        providerStatus: "PENDING",
        acceptedAt: ctx.now().toISOString(),
      };
    } catch (err) {
      throw mapRunwayError(err);
    }
  }

  async poll(ref: ProviderJobRef, ctx: ProviderContext): Promise<GenerationStatus> {
    let task: RunwayTask;
    try {
      task = await this.client().tasks.retrieve(ref.providerJobId, { signal: ctx.signal });
    } catch (err) {
      throw mapRunwayError(err);
    }
    // Non-aggressive, backing-off cadence (Runway: poll no faster than every 5 s, with backoff).
    const retryAfterMs = Math.min(30_000, 5_000 + ref.pollCount * 2_000);
    const base = { providerStatus: task.status, progress: null, retryAfterMs, failure: null };
    switch (task.status) {
      case "PENDING":
      case "THROTTLED": // accepted and stored by Runway; waiting for capacity. NOT a failure.
        return { ...base, state: "queued" };
      case "RUNNING":
        return {
          ...base,
          state: "processing",
          progress: typeof task.progress === "number" ? Math.min(1, Math.max(0, task.progress)) : null,
        };
      case "SUCCEEDED":
        return { ...base, state: "succeeded", progress: 1, retryAfterMs: null };
      case "CANCELLED":
        return { ...base, state: "cancelled", retryAfterMs: null };
      case "FAILED":
        return { ...base, state: "failed", retryAfterMs: null, failure: mapRunwayFailure(task.failureCode) };
      default:
        throw new GenerationProviderError(
          "permanent",
          "runway_unknown_status",
          "Runway returned an unknown task state.",
        );
    }
  }

  /** The single still image of a succeeded text_to_image task, with safe provenance only. */
  private imageResult(
    ref: ProviderJobRef,
    request: GenerationRequest,
    cat: CatalogModel,
    task: RunwayTask,
    url: string,
    credits: number | null,
    ctx: ProviderContext,
  ): GenerationResult {
    const ratio = imageRatioFor(cat, request);
    const canvas = canvasOf(ratio);
    const quality = imageQualityFor(cat, request);
    const png = cat.image?.outputFormats?.includes("png") === true;
    const tags = cat.image?.referenceAddressing === "tags" ? runwayImageTags(request.references) : null;
    return {
      outputs: [
        {
          role: "primary",
          position: 0,
          kind: "image",
          filename: `runway-${ref.providerJobId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}.png`,
          // We ask for png where the request has a format field; otherwise the real type is sniffed on ingest.
          mime: png ? "image/png" : null,
          // Transport only: consumed by safe-fetch/ingest and never persisted (not in the Asset, not in provenance).
          source: { type: "url", url },
          reported: {
            width: canvas?.width ?? null,
            height: canvas?.height ?? null,
            durationMs: null,
            fps: null,
          },
        },
      ],
      provenance: {
        provider: RUNWAY_PROVIDER_ID,
        model: request.modelId,
        providerJobId: ref.providerJobId,
        providerRequestId: null,
        providerModelVersion: null,
        seed: null,
        startedAt: task.createdAt ?? null,
        completedAt: ctx.now().toISOString(),
        actualDurationMs: null,
        actualResolution: null,
        actualFps: null,
        finishReason: "SUCCEEDED",
        usedInputs: request.references.map((r) => `reference:${r.role}`),
        settings: {
          model: request.modelId,
          purpose: request.purpose ?? "shot_output",
          modality: request.modality,
          ratio,
          providerCanvas: canvas,
          quality,
          outputCount: IMAGE_OUTPUT_COUNT,
          outputPosition: 0,
          outputFormat: png ? "png" : null,
          references: request.references.map((r, i) => ({
            assetId: r.assetId,
            role: r.role,
            tag: tags?.[i] ?? null,
          })),
        },
        metadata: {
          runwayApiVersion: RUNWAY_API_VERSION,
          credits,
          estimatedCredits: task.estimatedCost?.credits ?? null,
          pricingVersion: cat.pricing.version,
        },
      },
      cost:
        credits == null
          ? { amount: null, currency: RUNWAY_PRICING.currency, basis: "Runway reported no cost", units: null }
          : {
              amount: round4(credits * RUNWAY_PRICING.usdPerCredit),
              currency: RUNWAY_PRICING.currency,
              basis: `Runway reported ${credits} credits × $${RUNWAY_PRICING.usdPerCredit}/credit`,
              units: credits,
            },
    };
  }

  async cancel(
    ref: ProviderJobRef,
    ctx: ProviderContext,
  ): Promise<{ confirmed: boolean; completed?: boolean }> {
    const client = this.client();
    try {
      // DELETE on a FINISHED task deletes its output, so look first: never delete work that already completed.
      const before = await client.tasks.retrieve(ref.providerJobId, { signal: ctx.signal });
      if (before.status === "SUCCEEDED") return { confirmed: false, completed: true };
      if (before.status === "CANCELLED" || before.status === "FAILED") return { confirmed: true };
      await client.tasks.delete(ref.providerJobId, { signal: ctx.signal });
      const after = await client.tasks.retrieve(ref.providerJobId, { signal: ctx.signal }).then(
        (t) => t.status as RunwayTask["status"] | null,
        (err: { status?: number }) => (err?.status === 404 ? ("CANCELLED" as const) : null),
      );
      if (after === "SUCCEEDED") return { confirmed: false, completed: true };
      return { confirmed: after === "CANCELLED" || after === "FAILED" };
    } catch (err) {
      throw mapRunwayError(err);
    }
  }

  async fetchResult(
    ref: ProviderJobRef,
    request: GenerationRequest,
    ctx: ProviderContext,
  ): Promise<GenerationResult> {
    let task: RunwayTask;
    try {
      task = await this.client().tasks.retrieve(ref.providerJobId, { signal: ctx.signal });
    } catch (err) {
      throw mapRunwayError(err);
    }
    if (task.status !== "SUCCEEDED") {
      throw new GenerationProviderError(
        "transient",
        "runway_not_ready",
        "The Runway task is not finished yet.",
      );
    }
    const url = task.output?.[0];
    if (!url) {
      throw new GenerationProviderError(
        "permanent",
        "runway_no_output",
        "Runway reported success without an output.",
      );
    }
    const credits = typeof task.cost?.credits === "number" ? task.cost.credits : null;
    const cat = this.cat(request.modelId);
    if (cat && isImageCatalogModel(cat)) return this.imageResult(ref, request, cat, task, url, credits, ctx);
    const ratioInfo = cat ? ratioFor(cat, request) : null;
    const ratio = ratioInfo?.ratio ?? null;
    const canvas = canvasOf(ratio);
    const seconds = request.durationMs != null ? secondsOf(request.durationMs) : null;
    const used: string[] = [];
    if (request.startFrameAssetId) used.push("start_frame");
    if (request.endFrameAssetId) used.push("end_frame");
    for (const r of request.references) used.push(`reference:${r.role}`);
    if (request.audioAssetIds.length > 0) used.push("reference_audio");
    return {
      outputs: [
        {
          role: "primary",
          position: 0,
          kind: "video",
          filename: `runway-${ref.providerJobId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}.mp4`,
          mime: "video/mp4",
          // Transport only: consumed by safe-fetch/ingest and never persisted (not in the Asset, not in provenance).
          source: { type: "url", url },
          reported: {
            width: canvas?.width ?? null,
            height: canvas?.height ?? null,
            durationMs: request.durationMs,
            fps: null,
          },
        },
      ],
      provenance: {
        provider: RUNWAY_PROVIDER_ID,
        model: request.modelId,
        providerJobId: ref.providerJobId,
        providerRequestId: null,
        providerModelVersion: null,
        seed: request.seed,
        startedAt: task.createdAt ?? null,
        completedAt: ctx.now().toISOString(),
        actualDurationMs: null, // measured from the downloaded file by ingestion, not claimed
        actualResolution: null,
        actualFps: null,
        finishReason: "SUCCEEDED",
        usedInputs: used,
        settings: {
          model: request.modelId,
          modality: request.modality,
          ratio,
          resolutionTier: cat && cat.tiers.length > 1 ? ratioInfo?.tier.id : null,
          nativeAudio: cat ? nativeAudioRequested(cat, request) : false,
          durationSeconds: seconds,
          outputFormat: "mp4",
          seedRequested: request.seed,
        },
        metadata: {
          runwayApiVersion: RUNWAY_API_VERSION,
          credits,
          pricingVersion: cat ? cat.pricing.version : RUNWAY_PRICING_VERSION,
        },
      },
      cost:
        credits == null
          ? { amount: null, currency: RUNWAY_PRICING.currency, basis: "Runway reported no cost", units: null }
          : {
              amount: round4(credits * RUNWAY_PRICING.usdPerCredit),
              currency: RUNWAY_PRICING.currency,
              basis: `Runway reported ${credits} credits × $${RUNWAY_PRICING.usdPerCredit}/credit`,
              units: credits,
            },
    };
  }
}
