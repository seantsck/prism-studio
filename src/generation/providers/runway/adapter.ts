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
  RUNWAY_PRICING_VERSION,
  RUNWAY_VIDEO_MODELS,
  toGenerationModel,
} from "@/domain/generation/models/catalog";
import type { CatalogModel } from "@/domain/generation/models/types";
import { compileRunwayPrompt, omissionsAsIgnoredFeatures } from "./compile";
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

type Create = (
  body: Record<string, unknown>,
  opts?: { signal?: AbortSignal | null; timeout?: number },
) => PromiseLike<{ id: string; estimatedCost?: { credits: number } }>;

/** The slice of the SDK this adapter uses. Real = `new RunwayML(...)`; tests inject an HTTP-level double. */
export interface RunwayClientLike {
  textToVideo: { create: Create };
  imageToVideo: { create: Create };
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

/** Every catalog video model as a provider-independent GenerationModel. */
export function runwayModels(maxConcurrency = 1): GenerationModel[] {
  return RUNWAY_VIDEO_MODELS.map((m) => toGenerationModel(m, { maxConcurrency }));
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
        "Runway API (developer platform): Runway Gen-4 models plus hosted Veo, Seedance and Hailuo. Paid generation: credits are consumed per second of video.",
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

  additionalIgnoredFeatures(request: GenerationRequest, plan: PromptPlan): IgnoredFeature[] {
    const model = this.cat(request.modelId);
    if (!model) return [];
    return omissionsAsIgnoredFeatures(this.compilePrompt(model, plan).omissions, promptLimit(model));
  }

  validateRequest(request: GenerationRequest, model: GenerationModel) {
    const cat = this.cat(model.modelId);
    if (!cat) return { ok: false, errors: [`Unsupported Runway model ${model.modelId}.`] };
    const errors = validateForModel(cat, request);
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
      ? validateForModel(model, request)
      : [`Unsupported Runway model ${request.modelId}.`];
    if (!model || errors.length > 0) {
      throw new GenerationProviderError("invalid_request", "runway_invalid_request", errors[0]!, {
        retryable: false,
      });
    }
    const client = this.client();
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
