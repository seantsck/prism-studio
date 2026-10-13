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
import { compileRunwayPrompt, omissionsAsIgnoredFeatures } from "./compile";
import {
  RUNWAY_API_VERSION,
  RUNWAY_DEFAULT_OUTPUT_HOSTS,
  RUNWAY_DEFAULT_RATIO,
  RUNWAY_GEN45,
  RUNWAY_IMAGE_MIMES,
  RUNWAY_INPUT_URL_TTL_SECONDS,
  RUNWAY_MAX_DATA_URI_BYTES,
  RUNWAY_MAX_PROMPT_CHARS,
  RUNWAY_MAX_SECONDS,
  RUNWAY_MIN_SECONDS,
  RUNWAY_PRICING,
  RUNWAY_PROVIDER_ID,
  RUNWAY_RATIOS,
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
  const credits = RUNWAY_PRICING.models[RUNWAY_GEN45].creditsPerSecond;
  return {
    provider: RUNWAY_PROVIDER_ID,
    modelId: RUNWAY_GEN45,
    displayName: "Runway Gen-4.5",
    description:
      "Text-to-video and image-to-video. 2–10 s in whole seconds. First frame only: no reference images, no audio input, no negative prompt.",
    kind: "real",
    lifecycle: "active",
    capabilities: {
      modalities: ["text_to_video", "image_to_video"],
      references: {
        textPrompt: true,
        negativePrompt: false,
        referenceImages: false,
        maxReferences: 0,
        orderedReferences: false,
        characterReferences: false,
        styleReferences: false,
        locationReferences: false,
        startFrame: true,
        endFrame: false,
        referenceVideo: false,
        referenceAudio: false,
      },
      video: {
        minDurationMs: RUNWAY_MIN_SECONDS * 1000,
        maxDurationMs: RUNWAY_MAX_SECONDS * 1000,
        durationStepMs: 1000,
        allowedDurationsMs: null,
        cameraControl: false,
        motionPrompting: true,
        // Largest pixel dimensions across the ratios Gen-4.5 offers (1584×672 … 1104×832).
        maxResolution: { width: 1584, height: 1104 },
        // Union across modalities; text-to-video is narrower and is enforced by validateRequest().
        aspectRatios: Object.keys(RUNWAY_RATIOS.image_to_video),
        fps: [],
      },
      image: null,
      audio: {
        nativeDialogueAudio: false,
        audioConditioning: false,
        lipSync: false,
        referenceAudio: false,
        soundGeneration: false,
      },
      operational: {
        mode: "async",
        polling: true,
        webhook: false,
        cancellation: true,
        // The SDK/API has no create-request idempotency key: an ambiguous submit is never blindly repeated.
        idempotency: false,
        maxConcurrency,
        recommendedPollIntervalMs: 5_000,
        jobTimeoutMs: 30 * 60_000,
        rateLimitNotes:
          "Concurrency and daily generation caps depend on the account usage tier; extra tasks are THROTTLED (queued server-side).",
      },
      commercial: {
        pricing: "per_second",
        currency: RUNWAY_PRICING.currency,
        costUnit: `second of video (${credits} credits)`,
        unitCost: round4(credits * RUNWAY_PRICING.usdPerCredit),
      },
    },
  };
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
        "Runway API (developer platform). Paid generation: credits are consumed per second of video.",
      requiredConfig: [RUNWAY_SECRET_ENV],
      webhooks: false,
    };
  }

  listModels(): GenerationModel[] {
    return [gen45Model(this.maxConcurrency)];
  }

  allowedOutputHosts(): string[] {
    const extra = (this.env.PRISM_STUDIO_RUNWAY_OUTPUT_HOSTS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/.test(s));
    return [...RUNWAY_DEFAULT_OUTPUT_HOSTS, ...extra];
  }

  // ───────────────────────── compile / validate / estimate (pure, no network) ─────────────────────────

  private ratioFor(request: GenerationRequest): { ratio: string | null; defaulted: boolean } {
    const table =
      request.modality === "image_to_video" ? RUNWAY_RATIOS.image_to_video : RUNWAY_RATIOS.text_to_video;
    const wanted = request.aspectRatio ?? RUNWAY_DEFAULT_RATIO;
    const ratio = (table as Record<string, string>)[wanted] ?? null;
    return { ratio, defaulted: request.aspectRatio == null };
  }

  compileRequest(request: GenerationRequest, plan: PromptPlan): CompiledRequestSummary {
    const compiled = compileRunwayPrompt(plan);
    const { ratio, defaulted } = this.ratioFor(request);
    const i2v = request.modality === "image_to_video";
    const notes = [...compiled.notes];
    if (defaulted) notes.push(`No aspect ratio on the shot: Prism asks for ${RUNWAY_DEFAULT_RATIO}.`);
    for (const o of compiled.omissions) {
      notes.push(
        `Prompt limit: ${o.omittedLines} of ${o.totalLines} ${o.label.toLowerCase()} line(s) not sent.`,
      );
    }
    return {
      endpoint: `POST /v1/${i2v ? "image_to_video" : "text_to_video"} (${request.modelId})`,
      fields: {
        model: request.modelId,
        promptText: compiled.text,
        promptTextLength: compiled.text.length,
        duration: request.durationMs != null ? secondsOf(request.durationMs) : null,
        ratio,
        seed: request.seed,
        outputFormat: "mp4",
        ...(i2v ? { promptImage: "[first frame: Prism asset, sent as a data URI or short-lived URL]" } : {}),
        apiVersion: RUNWAY_API_VERSION,
      },
      attachments: request.startFrameAssetId
        ? [{ role: "first_frame", assetId: request.startFrameAssetId }]
        : [],
      notes,
    };
  }

  additionalIgnoredFeatures(_request: GenerationRequest, plan: PromptPlan): IgnoredFeature[] {
    return omissionsAsIgnoredFeatures(compileRunwayPrompt(plan).omissions, RUNWAY_MAX_PROMPT_CHARS);
  }

  validateRequest(request: GenerationRequest, model: GenerationModel) {
    const errors: string[] = [];
    if (model.modelId !== RUNWAY_GEN45) errors.push(`Unsupported Runway model ${model.modelId}.`);
    if (request.modality !== "text_to_video" && request.modality !== "image_to_video") {
      errors.push(`Runway Gen-4.5 does not support ${request.modality}.`);
    }
    const ms = request.durationMs;
    if (ms == null || ms % 1000 !== 0 || ms < RUNWAY_MIN_SECONDS * 1000 || ms > RUNWAY_MAX_SECONDS * 1000) {
      errors.push(
        `Runway Gen-4.5 accepts whole-second durations from ${RUNWAY_MIN_SECONDS} to ${RUNWAY_MAX_SECONDS} s; this shot is ${
          ms == null ? "unset" : `${secondsOf(ms)} s`
        }. Prism will not round it.`,
      );
    }
    if (request.modality === "image_to_video" && !request.startFrameAssetId) {
      errors.push("Image-to-video needs a first frame (approved storyboard frame or start frame).");
    }
    if (request.modality === "text_to_video" && request.startFrameAssetId) {
      errors.push("A start frame was supplied but the text-to-video endpoint cannot use it.");
    }
    if (request.endFrameAssetId) errors.push("Runway Gen-4.5 has no end-frame input.");
    if (request.references.length > 0) errors.push("Runway Gen-4.5 takes no reference images.");
    if (request.audioAssetIds.length > 0) errors.push("Runway Gen-4.5 takes no audio input.");
    if (request.modality === "text_to_video" || request.modality === "image_to_video") {
      const { ratio } = this.ratioFor(request);
      if (!ratio) {
        const offered = Object.keys(
          request.modality === "image_to_video" ? RUNWAY_RATIOS.image_to_video : RUNWAY_RATIOS.text_to_video,
        ).join(", ");
        errors.push(
          `Aspect ratio ${request.aspectRatio} is not available for ${request.modality.replace(/_/g, "-")} (offers ${offered}).`,
        );
      }
    }
    if (!request.prompt.positive.trim()) errors.push("The prompt is empty.");
    return { ok: errors.length === 0, errors };
  }

  estimateCost(request: GenerationRequest, model: GenerationModel): CostEstimate {
    const per = RUNWAY_PRICING.models[model.modelId as typeof RUNWAY_GEN45];
    if (!per || request.durationMs == null) {
      return {
        amount: null,
        currency: RUNWAY_PRICING.currency,
        basis: "duration or model unknown",
        units: null,
      };
    }
    const seconds = secondsOf(request.durationMs);
    const credits = seconds * per.creditsPerSecond;
    return {
      amount: round4(credits * RUNWAY_PRICING.usdPerCredit),
      currency: RUNWAY_PRICING.currency,
      basis: `${credits} credits (${seconds}s × ${per.creditsPerSecond}/s) × $${RUNWAY_PRICING.usdPerCredit}/credit; Runway pricing ${RUNWAY_PRICING.version}`,
      units: credits,
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

  private async promptImage(request: GenerationRequest, ctx: ProviderContext): Promise<string> {
    const assetId = request.startFrameAssetId!;
    const bad = (code: string, message: string) =>
      new GenerationProviderError("invalid_request", code, message, { retryable: false });
    const asset = await ctx.assets.read(assetId);
    if (!asset)
      throw bad("runway_input_unavailable", "The first-frame image could not be read from Prism storage.");
    const mime = (asset.mime ?? "").toLowerCase().replace("image/jpg", "image/jpeg");
    if (!(RUNWAY_IMAGE_MIMES as readonly string[]).includes(mime)) {
      throw bad("runway_input_type", "Runway accepts JPEG, PNG or WebP first frames.");
    }
    if (asset.bytes.length <= RUNWAY_MAX_DATA_URI_BYTES) {
      return `data:${mime};base64,${Buffer.from(asset.bytes).toString("base64")}`;
    }
    const url = await ctx.assets.signedUrl?.(assetId, RUNWAY_INPUT_URL_TTL_SECONDS);
    if (!url) {
      throw bad(
        "runway_input_too_large",
        "The first-frame image is too large to embed and this storage cannot issue a short-lived URL.",
      );
    }
    return url;
  }

  async submit(
    request: GenerationRequest,
    plan: PromptPlan,
    ctx: ProviderContext,
  ): Promise<GenerationSubmission> {
    const check = this.validateRequest(request, gen45Model());
    if (!check.ok) {
      throw new GenerationProviderError("invalid_request", "runway_invalid_request", check.errors[0]!, {
        retryable: false,
      });
    }
    const client = this.client();
    const { ratio } = this.ratioFor(request);
    const base = {
      model: RUNWAY_GEN45,
      promptText: compileRunwayPrompt(plan).text,
      duration: secondsOf(request.durationMs!),
      ratio: ratio!,
      ...(request.seed != null ? { seed: request.seed } : {}),
    };
    try {
      let created: { id: string };
      if (request.modality === "image_to_video") {
        const uri = await this.promptImage(request, ctx);
        created = await client.imageToVideo.create(
          { ...base, promptImage: [{ position: "first", uri }] },
          { signal: ctx.signal },
        );
      } else {
        created = await client.textToVideo.create(base, { signal: ctx.signal });
      }
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
    const { ratio } = this.ratioFor(request);
    const [w, h] = (ratio ?? "").split(":").map(Number);
    const seconds = request.durationMs != null ? secondsOf(request.durationMs) : null;
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
            width: w && h ? w : null,
            height: w && h ? h : null,
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
        usedInputs: [...(request.startFrameAssetId ? ["start_frame"] : [])],
        settings: {
          model: request.modelId,
          modality: request.modality,
          ratio,
          durationSeconds: seconds,
          outputFormat: "mp4",
          seedRequested: request.seed,
        },
        metadata: {
          runwayApiVersion: RUNWAY_API_VERSION,
          credits,
          pricingVersion: RUNWAY_PRICING.version,
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
