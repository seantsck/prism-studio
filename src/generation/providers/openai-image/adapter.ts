import { createHash, randomUUID } from "node:crypto";
import type { IgnoredFeature } from "@/domain/generation/compatibility";
import { GenerationProviderError } from "@/domain/generation/errors";
import { catalogModel, estimateImageCredits, toGenerationModel } from "@/domain/generation/models/catalog";
import {
  OPENAI_IMAGE_MODELS,
  OPENAI_IMAGE_PRICING_VERSION,
  OPENAI_IMAGE_PROVIDER_ID,
  OPENAI_IMAGE_TOKEN_RATES,
} from "@/domain/generation/models/openai-image-catalog";
import type { CatalogModel } from "@/domain/generation/models/types";
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
import { providerEnvName } from "../../config";
import type {
  CompiledRequestSummary,
  GenerationProviderAdapter,
  ProviderContext,
  ProviderJobRef,
} from "../../provider";
import { compileRunwayImagePrompt, omissionsAsIgnoredFeatures } from "../runway/compile";
import { promptLimit } from "../runway/families";
import {
  imageQualityFor,
  imageRatioFor,
  referenceLegend,
  validateImageRequest,
} from "../runway/image-families";
import {
  OpenAIImageTransportError,
  type OpenAIImageCall,
  type OpenAIImageCallResult,
  type OpenAIImageInput,
  type OpenAIImageTransport,
} from "./transport";

/**
 * Phase 5B-I2: GPT Image DIRECTLY through OpenAI's Images API (provider `openai-image`).
 *
 *  - Credentials: `PRISM_STUDIO_PROVIDER_OPENAI_IMAGE_API_KEY`, held ONLY by the worker. The web lists, prices,
 *    validates and queues through `PRISM_STUDIO_WORKER_BACKED_PROVIDERS=openai-image` and never needs the key.
 *  - The Images API is SYNCHRONOUS (the image comes back in the response as base64). `submit` performs the one
 *    billable call and returns `succeeded`; the worker ingests it at once under the same lease. The bytes are held only
 *    in this process until ingested; if that process dies in between, the job fails honestly with
 *    `openai_image_result_not_retained` (the call may have been billed) instead of calling OpenAI again.
 *  - No idempotency key exists, so an ambiguous call is never re-sent (the worker's resubmission guard).
 *  - One attempt is one image (n=1), always PNG (lossless; alpha when the background is transparent).
 *  - Editing (image_to_image) sends the references in order: the FIRST is the image being edited. The source Asset is
 *    never modified: the output is ingested as a new immutable Asset, and the attempt records the inputs (lineage).
 *  - Transparency is an explicit option (`providerOptions.background = "transparent"`), sent natively.
 */
export const OPENAI_IMAGE_SECRET_ENV = providerEnvName(OPENAI_IMAGE_PROVIDER_ID, "api_key");
const SUPPORTED_INPUT_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
/** Edit inputs are below 50 MB per image (edit reference); Prism stays well under it. */
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const RESULT_TTL_MS = 60 * 60_000;
const CALL_TIMEOUT_MS = 5 * 60_000;

export type Background = "opaque" | "transparent";

export interface OpenAIImageProviderOptions {
  env?: Record<string, string | undefined>;
  /** Injected in tests; by default the real SDK transport is imported lazily on the first call. */
  transportFactory?: (apiKey: string) => OpenAIImageTransport | Promise<OpenAIImageTransport>;
  maxConcurrency?: number;
}

interface HeldResult {
  call: Omit<OpenAIImageCall, "images" | "mask" | "signal"> & { inputCount: number; masked: boolean };
  result: OpenAIImageCallResult;
  startedAt: string;
  completedAt: string;
  at: number;
}

export function backgroundOf(request: GenerationRequest): Background {
  return request.providerOptions?.background === "transparent" ? "transparent" : "opaque";
}

/** "1536:864" → "1536x864". */
const sizeOf = (ratio: string) => ratio.replace(":", "x");

export function openAIImageModels(maxConcurrency = 1): GenerationModel[] {
  return OPENAI_IMAGE_MODELS.map((m) => {
    const g = toGenerationModel(m, { maxConcurrency });
    return {
      ...g,
      capabilities: {
        ...g.capabilities,
        image: g.capabilities.image ? { ...g.capabilities.image, transparency: true, editing: true } : null,
        operational: {
          ...g.capabilities.operational,
          mode: "sync",
          polling: false,
          cancellation: false,
          idempotency: false,
          recommendedPollIntervalMs: 2_000,
          jobTimeoutMs: 10 * 60_000,
        },
        commercial: {
          ...g.capabilities.commercial,
          costUnit: `image (provisional upper bound; billed by tokens: $${OPENAI_IMAGE_TOKEN_RATES.imageOutput}/1M image-output tokens)`,
        },
      },
    };
  });
}

export class OpenAIImageProvider implements GenerationProviderAdapter {
  private readonly env: Record<string, string | undefined>;
  private readonly transportFactory: (apiKey: string) => OpenAIImageTransport | Promise<OpenAIImageTransport>;
  private readonly maxConcurrency: number;
  /** Results of calls this process made, until ingested (see the class comment). Never persisted, never logged. */
  private readonly held = new Map<string, HeldResult>();

  constructor(opts: OpenAIImageProviderOptions = {}) {
    this.env = opts.env ?? process.env;
    this.maxConcurrency =
      opts.maxConcurrency ??
      Math.min(
        10,
        Math.max(1, Number.parseInt(this.env.PRISM_STUDIO_OPENAI_IMAGE_MAX_CONCURRENCY ?? "", 10) || 1),
      );
    this.transportFactory =
      opts.transportFactory ??
      (async (apiKey) => {
        const { SdkOpenAIImageTransport } = await import("./sdk-transport");
        return new SdkOpenAIImageTransport({ apiKey });
      });
  }

  info(): GenerationProviderInfo {
    return {
      provider: OPENAI_IMAGE_PROVIDER_ID,
      displayName: "OpenAI Images",
      kind: "real",
      description:
        "GPT Image called directly through OpenAI's Images API: text-to-image, editing with up to 16 images, native transparent backgrounds. Paid generation, billed by tokens.",
      requiredConfig: [OPENAI_IMAGE_SECRET_ENV],
      webhooks: false,
    };
  }

  listModels(): GenerationModel[] {
    return openAIImageModels(this.maxConcurrency);
  }

  /** Outputs are inline bytes only. */
  allowedOutputHosts(): string[] {
    return [];
  }

  private cat(modelId: string): CatalogModel | null {
    return catalogModel(OPENAI_IMAGE_PROVIDER_ID, modelId);
  }

  private compilePrompt(model: CatalogModel, request: GenerationRequest, plan: PromptPlan) {
    const legend = referenceLegend(
      model,
      request.references,
      request.references.map(() => null),
    );
    const editNote =
      request.modality === "image_to_image" && request.references.length > 0
        ? "Edit reference image 1; keep everything not described as changed."
        : "";
    const compiled = compileRunwayImagePrompt(
      plan,
      promptLimit(model) - (editNote ? editNote.length + 1 : 0),
      {
        modelName: model.displayName,
        legend,
      },
    );
    return { ...compiled, text: editNote ? `${editNote}\n${compiled.text}` : compiled.text };
  }

  private shape(model: CatalogModel, request: GenerationRequest) {
    const ratio = imageRatioFor(model, request);
    const quality = (imageQualityFor(model, request) ?? "medium") as OpenAIImageCall["quality"];
    return {
      operation: (request.modality === "image_to_image"
        ? "edit"
        : "generate") as OpenAIImageCall["operation"],
      size: ratio ? sizeOf(ratio) : null,
      quality,
      background: backgroundOf(request),
      outputFormat: "png" as const,
    };
  }

  compileRequest(request: GenerationRequest, plan: PromptPlan): CompiledRequestSummary {
    const model = this.cat(request.modelId);
    if (!model) {
      return {
        endpoint: `unknown OpenAI image model ${request.modelId}`,
        fields: { model: request.modelId },
        attachments: [],
        notes: [`${request.modelId} is not in the Prism model catalog.`],
      };
    }
    const s = this.shape(model, request);
    const compiled = this.compilePrompt(model, request, plan);
    const notes = [...compiled.notes, "One attempt is one image: Prism always requests n=1, PNG."];
    for (const o of compiled.omissions)
      notes.push(
        `Prompt limit: ${o.omittedLines} of ${o.totalLines} ${o.label.toLowerCase()} line(s) not sent.`,
      );
    if (s.operation === "edit")
      notes.push("Reference image 1 is the image being edited; it is never overwritten.");
    if (s.background === "transparent") notes.push("Transparent background requested (PNG with alpha).");
    const estimate = this.estimateCost(request, toGenerationModel(model));
    return {
      endpoint: `POST /v1/images/${s.operation === "edit" ? "edits" : "generations"} (${request.modelId})`,
      fields: {
        model: request.modelId,
        purpose: request.purpose ?? "shot_output",
        requestModality: request.modality,
        prompt: compiled.text,
        promptLength: compiled.text.length,
        size: s.size,
        quality: s.quality,
        background: s.background,
        outputFormat: s.outputFormat,
        n: 1,
        inputImages: s.operation === "edit" ? request.references.length : 0,
        estimatedUsd: estimate.amount,
      },
      attachments: request.references.map((r, i) => ({
        role: `${i === 0 && s.operation === "edit" ? "edit_source" : "reference"}:${r.role}:#${i + 1}`,
        assetId: r.assetId,
      })),
      notes,
    };
  }

  additionalIgnoredFeatures(request: GenerationRequest, plan: PromptPlan): IgnoredFeature[] {
    const model = this.cat(request.modelId);
    if (!model) return [];
    return omissionsAsIgnoredFeatures(this.compilePrompt(model, request, plan).omissions, promptLimit(model));
  }

  validateRequest(request: GenerationRequest, model: GenerationModel) {
    const cat = this.cat(model.modelId);
    if (!cat) return { ok: false, errors: [`Unsupported OpenAI image model ${model.modelId}.`] };
    const errors = validateImageRequest(cat, request);
    const bg = request.providerOptions?.background;
    if (bg !== undefined && bg !== "transparent" && bg !== "opaque")
      errors.push(`${cat.displayName} background must be "opaque" or "transparent".`);
    return { ok: errors.length === 0, errors };
  }

  /**
   * A deterministic pre-submit UPPER BOUND: the catalog's provisional per-image output figure + per-reference input
   * figure, plus the prompt's text tokens bounded by its UTF-8 byte length (a token is never shorter than a byte).
   */
  estimateCost(request: GenerationRequest, model: GenerationModel): CostEstimate {
    const cat = this.cat(model.modelId);
    if (!cat) return { amount: null, currency: "USD", basis: "model unknown", units: null };
    const image = estimateImageCredits(cat, {
      tierId: cat.tiers[0]!.id,
      quality: imageQualityFor(cat, request),
      referenceImages: request.modality === "image_to_image" ? request.references.length : 0,
      outputCount: 1,
    });
    if (image.amountUsd == null) return { amount: null, currency: "USD", basis: image.basis, units: null };
    const promptBytes = Buffer.byteLength(
      [request.prompt.positive, request.prompt.negative].filter(Boolean).join("\n"),
      "utf8",
    );
    // the compiled prompt adds section labels and the reference legend: bound them generously too
    const textBound = promptBytes + 400 + request.references.length * 80;
    const textUsd = (textBound * OPENAI_IMAGE_TOKEN_RATES.textInput) / 1_000_000;
    const amount = Math.ceil((image.amountUsd + textUsd) * 10_000) / 10_000;
    return {
      amount,
      currency: "USD",
      basis: `Upper bound (provisional): ${image.basis}; + ≤${textBound} text tokens × $${OPENAI_IMAGE_TOKEN_RATES.textInput}/1M`,
      units: null,
    };
  }

  // ───────────────────────── the one billable call ─────────────────────────

  private async transport(): Promise<OpenAIImageTransport> {
    const key = this.env[OPENAI_IMAGE_SECRET_ENV]?.trim();
    if (!key) {
      throw new GenerationProviderError(
        "auth",
        "openai_image_not_configured",
        "OpenAI Images is not configured on this server.",
        { retryable: false },
      );
    }
    return this.transportFactory(key);
  }

  private async input(assetId: string, ctx: ProviderContext, what: string): Promise<OpenAIImageInput> {
    const bad = (code: string, message: string) =>
      new GenerationProviderError("invalid_request", code, message, { retryable: false });
    const asset = await ctx.assets.read(assetId);
    if (!asset)
      throw bad("openai_image_input_unavailable", `The ${what} could not be read from Prism storage.`);
    const mime = (asset.mime ?? "").toLowerCase().replace("image/jpg", "image/jpeg");
    if (!(SUPPORTED_INPUT_MIMES as readonly string[]).includes(mime))
      throw bad("openai_image_input_type", "OpenAI image editing accepts PNG, JPEG or WebP images.");
    if (asset.bytes.length > MAX_INPUT_BYTES)
      throw bad("openai_image_input_too_large", `The ${what} is larger than 25 MB.`);
    return { bytes: asset.bytes, mime, filename: asset.filename || `${assetId}.${mime.split("/")[1]}` };
  }

  private prune(now: number) {
    for (const [k, v] of this.held) if (now - v.at > RESULT_TTL_MS) this.held.delete(k);
  }

  async submit(
    request: GenerationRequest,
    plan: PromptPlan,
    ctx: ProviderContext,
  ): Promise<GenerationSubmission> {
    const model = this.cat(request.modelId);
    const errors = model
      ? validateImageRequest(model, request)
      : [`Unsupported OpenAI image model ${request.modelId}.`];
    if (!model || errors.length > 0) {
      throw new GenerationProviderError("invalid_request", "openai_image_invalid_request", errors[0]!, {
        retryable: false,
      });
    }
    const s = this.shape(model, request);
    if (!s.size) {
      throw new GenerationProviderError(
        "invalid_request",
        "openai_image_size",
        "No size for this aspect ratio.",
        {
          retryable: false,
        },
      );
    }
    const transport = await this.transport();
    const images: OpenAIImageInput[] = [];
    if (s.operation === "edit")
      for (const [i, r] of request.references.entries())
        images.push(await this.input(r.assetId, ctx, i === 0 ? "image to edit" : "reference image"));
    const prompt = this.compilePrompt(model, request, plan).text;
    const startedAt = ctx.now().toISOString();
    let result: OpenAIImageCallResult;
    try {
      result = await transport.call({
        operation: s.operation,
        model: request.modelId,
        prompt,
        size: s.size,
        quality: s.quality,
        background: s.background,
        outputFormat: s.outputFormat,
        images,
        mask: null,
        timeoutMs: CALL_TIMEOUT_MS,
        signal: ctx.signal,
      });
    } catch (err) {
      throw mapOpenAIImageError(err);
    }
    const providerJobId = `oai-img-${randomUUID()}`;
    const now = Date.now();
    this.prune(now);
    this.held.set(providerJobId, {
      call: {
        operation: s.operation,
        model: request.modelId,
        prompt,
        size: s.size,
        quality: s.quality,
        background: s.background,
        outputFormat: s.outputFormat,
        timeoutMs: CALL_TIMEOUT_MS,
        inputCount: images.length,
        masked: false,
      },
      result,
      startedAt,
      completedAt: ctx.now().toISOString(),
      at: now,
    });
    return {
      providerJobId,
      providerRequestId: result.requestId,
      state: "succeeded",
      providerStatus: "completed",
      acceptedAt: startedAt,
    };
  }

  async poll(ref: ProviderJobRef): Promise<GenerationStatus> {
    if (this.held.has(ref.providerJobId)) {
      return {
        state: "succeeded",
        providerStatus: "completed",
        progress: 1,
        retryAfterMs: null,
        failure: null,
      };
    }
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
    const { result, call } = held;
    const [w, h] = (result.size ?? call.size).split("x").map((n) => Number.parseInt(n, 10));
    const bytes = Buffer.from(result.b64, "base64");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const cost = actualCost(result.usage);
    return {
      outputs: [
        {
          role: "primary",
          position: 0,
          kind: "image",
          filename: `openai-image-${ref.providerJobId.slice(8, 20)}.png`,
          mime: "image/png",
          source: { type: "bytes", base64: result.b64 },
          reported: {
            width: Number.isFinite(w) && w! > 0 ? w! : null,
            height: Number.isFinite(h) && h! > 0 ? h! : null,
            durationMs: null,
            fps: null,
          },
        },
      ],
      provenance: {
        provider: OPENAI_IMAGE_PROVIDER_ID,
        model: request.modelId,
        providerJobId: ref.providerJobId,
        providerRequestId: result.requestId,
        providerModelVersion: null,
        seed: null,
        startedAt: held.startedAt,
        completedAt: held.completedAt,
        actualDurationMs: null,
        actualResolution: null,
        actualFps: null,
        finishReason: "completed",
        usedInputs: request.references.map((r, i) =>
          i === 0 && call.operation === "edit" ? `edit_source:${r.role}` : `reference:${r.role}`,
        ),
        settings: {
          model: request.modelId,
          purpose: request.purpose ?? "shot_output",
          modality: request.modality,
          operation: call.operation,
          size: call.size,
          quality: call.quality,
          background: call.background,
          outputFormat: call.outputFormat,
          n: 1,
          inputImages: call.inputCount,
          masked: call.masked,
          references: request.references.map((r, i) => ({
            assetId: r.assetId,
            role: r.role,
            position: i + 1,
          })),
        },
        metadata: {
          reportedSize: result.size,
          reportedBackground: result.background,
          reportedQuality: result.quality,
          reportedOutputFormat: result.outputFormat,
          providerCreated: result.created,
          usage: result.usage,
          outputSha256: checksum,
          pricingVersion: OPENAI_IMAGE_PRICING_VERSION,
          contentProvenance: "OpenAI documents C2PA metadata and a SynthID watermark on API images",
        },
      },
      cost,
    };
  }
}

/** Actual cost from the usage OpenAI reported (never estimated). Unknown when the provider reported none. */
export function actualCost(usage: OpenAIImageCallResult["usage"]): GenerationResult["cost"] {
  if (!usage || usage.outputTokens == null) {
    return { amount: null, currency: "USD", basis: "OpenAI reported no token usage", units: null };
  }
  const text = usage.textInputTokens ?? (usage.imageInputTokens == null ? (usage.inputTokens ?? 0) : 0);
  const imageIn = usage.imageInputTokens ?? 0;
  const out = usage.outputTokens;
  const r = OPENAI_IMAGE_TOKEN_RATES;
  const amount = (text * r.textInput + imageIn * r.imageInput + out * r.imageOutput) / 1_000_000;
  return {
    amount: Math.round(amount * 1_000_000) / 1_000_000,
    currency: "USD",
    basis: `OpenAI reported ${text} text-in, ${imageIn} image-in, ${out} image-out tokens at $${r.textInput}/$${r.imageInput}/$${r.imageOutput} per 1M`,
    units: text + imageIn + out,
  };
}

function notRetained() {
  return {
    category: "permanent" as const,
    code: "openai_image_result_not_retained",
    message:
      "The image was generated but the worker restarted before storing it. OpenAI may have billed it; generate again if needed.",
  };
}

/** Transport failure → Prism's taxonomy. Ambiguous outcomes (possibly billed) are never classified as refusals. */
export function mapOpenAIImageError(err: unknown): GenerationProviderError {
  if (err instanceof GenerationProviderError) return err;
  if (!(err instanceof OpenAIImageTransportError)) {
    return new GenerationProviderError("transient", "openai_image_unknown", "The OpenAI request failed.");
  }
  const { status, code } = err;
  if (code === "moderation_blocked")
    return new GenerationProviderError(
      "content_rejected",
      "openai_image_moderation_blocked",
      "OpenAI's safety system declined this image request.",
      { retryable: false },
    );
  if (status === 401 || status === 403)
    return new GenerationProviderError(
      "auth",
      `openai_image_http_${status}`,
      "OpenAI refused the credentials.",
      {
        retryable: false,
      },
    );
  if (status === 429) {
    const quota =
      code != null &&
      ["insufficient_quota", "billing_hard_limit_reached", "project_spend_limit_exceeded"].includes(code);
    return quota
      ? new GenerationProviderError(
          "quota",
          "openai_image_quota",
          "The OpenAI account has no remaining quota.",
          {
            retryable: false,
          },
        )
      : new GenerationProviderError(
          "rate_limit",
          "openai_image_rate_limited",
          "OpenAI is rate limiting requests.",
          {
            retryAfterMs: 30_000,
          },
        );
  }
  if (status != null && status >= 400 && status < 500)
    return new GenerationProviderError(
      "invalid_request",
      `openai_image_http_${status}`,
      err.message || "OpenAI rejected the request.",
      { retryable: false },
    );
  if (err.ambiguous) {
    return new GenerationProviderError(
      code === "timeout" ? "timeout" : "provider_unavailable",
      `openai_image_${code ?? "unavailable"}`,
      "OpenAI did not confirm the request; it may have been processed.",
    );
  }
  return new GenerationProviderError(
    "provider_unavailable",
    "openai_image_unavailable",
    "OpenAI is unavailable.",
  );
}
