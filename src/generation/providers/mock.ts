import { estimateCostFromCapabilities } from "@/domain/generation/cost";
import { GenerationProviderError } from "@/domain/generation/errors";
import { renderPromptPlan } from "@/domain/generation/prompt-plan";
import {
  generationModelSchema,
  type GenerationModel,
  type GenerationRequest,
  type GenerationResult,
  type GenerationStatus,
  type GenerationSubmission,
  type ModelCapabilities,
  type PromptPlan,
  type ProviderOutput,
} from "@/domain/generation/schemas";
import type {
  CompiledRequestSummary,
  GenerationProviderAdapter,
  ProviderContext,
  ProviderJobRef,
} from "../provider";
import { encodeMockPng, seedFromString } from "./mock-image";
import { MOCK_VIDEO_FIXTURE, MOCK_VIDEO_WEBM_BASE64 } from "./mock-video-fixture";

/**
 * Deterministic, free, asynchronous provider used for development, tests and demos. It behaves like a
 * real provider on purpose: submit returns a job id, poll walks queued → processing → succeeded, outputs
 * arrive later, and scripted failure scenarios exercise retry/cancel/timeout paths.
 *
 * Stateless by design: everything poll() needs is encoded in the provider job id, so a worker restart
 * (or a different worker) continues the same "remote" job.
 */
export const MOCK_PROVIDER_ID = "mock";

type Scenario = "success" | "transient_poll" | "rejected" | "hang" | "unknown_cost";

const baseCaps = (over: Partial<ModelCapabilities>): ModelCapabilities => ({
  modalities: ["text_to_video", "image_to_video"],
  references: {
    textPrompt: true,
    negativePrompt: true,
    referenceImages: true,
    maxReferences: 12,
    orderedReferences: true,
    characterReferences: true,
    styleReferences: true,
    locationReferences: true,
    startFrame: true,
    endFrame: true,
    referenceVideo: false,
    referenceAudio: true,
  },
  video: {
    minDurationMs: 1000,
    maxDurationMs: 12_000,
    durationStepMs: 500,
    allowedDurationsMs: null,
    cameraControl: true,
    motionPrompting: true,
    maxResolution: { width: 1920, height: 1080 },
    aspectRatios: ["2.39:1", "16:9", "9:16", "1:1", "21:9", "4:3"],
    fps: [],
  },
  image: null,
  audio: {
    nativeDialogueAudio: false,
    audioConditioning: true,
    lipSync: false,
    referenceAudio: true,
    soundGeneration: false,
  },
  operational: {
    mode: "async",
    polling: true,
    webhook: false,
    cancellation: true,
    idempotency: true,
    maxConcurrency: 4,
    recommendedPollIntervalMs: 1_000,
    jobTimeoutMs: 10 * 60_000,
    rateLimitNotes: "No limits (mock).",
  },
  commercial: { pricing: "per_second", currency: "USD", costUnit: "second of video", unitCost: 0.05 },
  ...over,
});

interface MockModelDef {
  model: GenerationModel;
  scenario: Scenario;
}

const defs: MockModelDef[] = [
  {
    scenario: "success",
    model: {
      provider: MOCK_PROVIDER_ID,
      modelId: "mock-video-1",
      displayName: "Mock Video 1",
      description: "Deterministic video model with full input support. Free; outputs a fixture clip.",
      kind: "mock",
      lifecycle: "active",
      capabilities: baseCaps({}),
    },
  },
  {
    scenario: "unknown_cost",
    model: {
      provider: MOCK_PROVIDER_ID,
      modelId: "mock-video-lite",
      displayName: "Mock Video Lite",
      description:
        "Limited model: 5 s or 10 s only, no end frame, no style references, no performed audio, no cancellation, billing unknown.",
      kind: "mock",
      lifecycle: "active",
      capabilities: baseCaps({
        references: {
          textPrompt: true,
          negativePrompt: false,
          referenceImages: true,
          maxReferences: 6,
          orderedReferences: false,
          characterReferences: true,
          styleReferences: false,
          locationReferences: true,
          startFrame: true,
          endFrame: false,
          referenceVideo: false,
          referenceAudio: false,
        },
        video: {
          minDurationMs: 5000,
          maxDurationMs: 10_000,
          durationStepMs: null,
          allowedDurationsMs: [5000, 10_000],
          cameraControl: false,
          motionPrompting: false,
          maxResolution: { width: 1280, height: 720 },
          aspectRatios: ["2.39:1", "16:9", "9:16"],
          fps: [24],
        },
        audio: {
          nativeDialogueAudio: true,
          audioConditioning: false,
          lipSync: false,
          referenceAudio: false,
          soundGeneration: false,
        },
        operational: {
          mode: "async",
          polling: true,
          webhook: false,
          cancellation: false,
          idempotency: false,
          maxConcurrency: 1,
          recommendedPollIntervalMs: 1_000,
          jobTimeoutMs: 10 * 60_000,
          rateLimitNotes: "No limits (mock).",
        },
        commercial: { pricing: "per_second", currency: "USD", costUnit: "second of video", unitCost: 0.03 },
      }),
    },
  },
  {
    scenario: "success",
    model: {
      provider: MOCK_PROVIDER_ID,
      modelId: "mock-video-169",
      displayName: "Mock Video 16:9",
      description:
        "Adaptation test model: 16:9 and 9:16 only, 5 s or 10 s only. Exercises framing/duration adaptation (crop, trim). Free.",
      kind: "mock",
      lifecycle: "active",
      capabilities: baseCaps({
        video: {
          minDurationMs: 5000,
          maxDurationMs: 10_000,
          durationStepMs: null,
          allowedDurationsMs: [5000, 10_000],
          cameraControl: true,
          motionPrompting: true,
          maxResolution: { width: 1280, height: 720 },
          aspectRatios: ["16:9", "9:16"],
          fps: [],
        },
      }),
    },
  },
  {
    scenario: "success",
    model: {
      provider: MOCK_PROVIDER_ID,
      modelId: "mock-video-t2v",
      displayName: "Mock Video (text only)",
      description:
        "Text-to-video only: takes no start frame. Exercises the Animate Production Frame rule that a model without image-to-video is incompatible. Free.",
      kind: "mock",
      lifecycle: "active",
      capabilities: baseCaps({ modalities: ["text_to_video"] }),
    },
  },
  {
    scenario: "transient_poll",
    model: {
      provider: MOCK_PROVIDER_ID,
      modelId: "mock-video-flaky",
      displayName: "Mock Video (flaky)",
      description: "Test scenario: the first two polls fail transiently; retries then succeed.",
      kind: "mock",
      lifecycle: "active",
      capabilities: baseCaps({}),
    },
  },
  {
    scenario: "rejected",
    model: {
      provider: MOCK_PROVIDER_ID,
      modelId: "mock-video-rejects",
      displayName: "Mock Video (rejects)",
      description: "Test scenario: the provider rejects the request (content policy). Never retried.",
      kind: "mock",
      lifecycle: "active",
      capabilities: baseCaps({}),
    },
  },
  {
    scenario: "hang",
    model: {
      provider: MOCK_PROVIDER_ID,
      modelId: "mock-video-hang",
      displayName: "Mock Video (hangs)",
      description: "Test scenario: stays 'processing' forever; Prism times the job out.",
      kind: "mock",
      lifecycle: "active",
      capabilities: baseCaps({
        operational: {
          mode: "async",
          polling: true,
          webhook: false,
          cancellation: true,
          idempotency: true,
          maxConcurrency: 4,
          recommendedPollIntervalMs: 1_000,
          jobTimeoutMs: 30_000,
          rateLimitNotes: "No limits (mock).",
        },
      }),
    },
  },
  {
    scenario: "success",
    model: {
      provider: MOCK_PROVIDER_ID,
      modelId: "mock-image-1",
      displayName: "Mock Image 1",
      description: "Deterministic image model. Free; outputs a generated gradient PNG.",
      kind: "mock",
      lifecycle: "active",
      capabilities: baseCaps({
        modalities: ["text_to_image", "image_to_image"],
        video: null,
        image: {
          resolutions: [{ width: 512, height: 288 }],
          aspectRatios: ["16:9", "9:16", "1:1"],
          transparency: false,
          editing: true,
        },
        audio: {
          nativeDialogueAudio: false,
          audioConditioning: false,
          lipSync: false,
          referenceAudio: false,
          soundGeneration: false,
        },
        references: {
          textPrompt: true,
          negativePrompt: true,
          referenceImages: true,
          maxReferences: 8,
          orderedReferences: true,
          characterReferences: true,
          styleReferences: true,
          locationReferences: true,
          startFrame: true,
          endFrame: false,
          referenceVideo: false,
          referenceAudio: false,
        },
        commercial: { pricing: "per_output", currency: "USD", costUnit: "image", unitCost: 0.02 },
      }),
    },
  },
  // Phase 2G.2 Production Frame candidate fixtures (free): a second native-ratio model that accepts few references,
  // and a wide-only model whose provider canvas differs from a 16:9 / 2.39:1 production frame (forces adaptation).
  {
    scenario: "success",
    model: {
      provider: MOCK_PROVIDER_ID,
      modelId: "mock-image-lite",
      displayName: "Mock Image Lite",
      description: "Deterministic image model with a small reference limit. Free.",
      kind: "mock",
      lifecycle: "active",
      capabilities: baseCaps({
        modalities: ["text_to_image", "image_to_image"],
        video: null,
        image: {
          resolutions: [{ width: 512, height: 288 }],
          aspectRatios: ["16:9", "1:1"],
          transparency: false,
          editing: true,
        },
        audio: {
          nativeDialogueAudio: false,
          audioConditioning: false,
          lipSync: false,
          referenceAudio: false,
          soundGeneration: false,
        },
        references: {
          textPrompt: true,
          negativePrompt: false,
          referenceImages: true,
          maxReferences: 2,
          orderedReferences: true,
          characterReferences: true,
          styleReferences: true,
          locationReferences: true,
          startFrame: false,
          endFrame: false,
          referenceVideo: false,
          referenceAudio: false,
        },
        commercial: { pricing: "per_output", currency: "USD", costUnit: "image", unitCost: 0.01 },
      }),
    },
  },
  {
    scenario: "success",
    model: {
      provider: MOCK_PROVIDER_ID,
      modelId: "mock-image-wide",
      displayName: "Mock Image Wide",
      description: "Deterministic wide-canvas image model (21:9 only). Free.",
      kind: "mock",
      lifecycle: "active",
      capabilities: baseCaps({
        modalities: ["text_to_image", "image_to_image"],
        video: null,
        image: {
          resolutions: [{ width: 672, height: 288 }],
          aspectRatios: ["21:9"],
          transparency: false,
          editing: true,
        },
        audio: {
          nativeDialogueAudio: false,
          audioConditioning: false,
          lipSync: false,
          referenceAudio: false,
          soundGeneration: false,
        },
        references: {
          textPrompt: true,
          negativePrompt: false,
          referenceImages: true,
          maxReferences: 8,
          orderedReferences: true,
          characterReferences: true,
          styleReferences: true,
          locationReferences: true,
          startFrame: false,
          endFrame: false,
          referenceVideo: false,
          referenceAudio: false,
        },
        commercial: { pricing: "per_output", currency: "USD", costUnit: "image", unitCost: 0.01 },
      }),
    },
  },
];

for (const d of defs) generationModelSchema.parse(d.model);

interface MockJobToken {
  v: 1;
  model: string;
  /** acceptedAt, epoch ms */
  t: number;
  /** stage delay in ms at submission time */
  d: number;
  k: string;
  mod: GenerationRequest["modality"];
  dur: number | null;
  ar: string | null;
  seed: number;
  neg: boolean;
}

const encodeToken = (t: MockJobToken) => `mock_${Buffer.from(JSON.stringify(t)).toString("base64url")}`;
function decodeToken(id: string): MockJobToken {
  try {
    const t = JSON.parse(Buffer.from(id.replace(/^mock_/, ""), "base64url").toString("utf8")) as MockJobToken;
    if (t.v === 1 && typeof t.t === "number") return t;
  } catch {
    /* fallthrough */
  }
  throw new GenerationProviderError("invalid_request", "mock_bad_job_id", "Unknown mock job id.");
}

export interface MockProviderOptions {
  /** Simulated latency per stage (queued, then processing). 0 completes on the first poll. */
  stageDelayMs?: number;
}

export class MockProvider implements GenerationProviderAdapter {
  private readonly delay: number;

  constructor(options: MockProviderOptions = {}) {
    this.delay = options.stageDelayMs ?? 1_500;
  }

  info() {
    return {
      provider: MOCK_PROVIDER_ID,
      displayName: "Mock (no external calls)",
      kind: "mock" as const,
      description: "Deterministic fake provider for development and tests. Never spends money.",
      requiredConfig: [],
      webhooks: false,
    };
  }

  listModels(): GenerationModel[] {
    return defs.map((d) => structuredClone(d.model));
  }

  private def(modelId: string): MockModelDef {
    const d = defs.find((x) => x.model.modelId === modelId);
    if (!d)
      throw new GenerationProviderError("invalid_request", "unknown_model", `Unknown mock model ${modelId}`);
    return d;
  }

  compileRequest(request: GenerationRequest, plan: PromptPlan): CompiledRequestSummary {
    const v = request.durationMs != null;
    return {
      endpoint: `mock:/v1/${v ? "video" : "image"} (${request.modality})`,
      fields: {
        model: request.modelId,
        prompt: renderPromptPlan(plan),
        negative_prompt: request.prompt.negative || null,
        ...(v ? { duration_seconds: (request.durationMs ?? 0) / 1000 } : {}),
        resolution: request.resolution ? `${request.resolution.width}x${request.resolution.height}` : null,
        aspect_ratio: request.aspectRatio,
        fps: request.fps,
        seed: request.seed,
        idempotency_key: request.idempotencyKey,
      },
      attachments: [
        ...(request.startFrameAssetId ? [{ role: "start_frame", assetId: request.startFrameAssetId }] : []),
        ...(request.endFrameAssetId ? [{ role: "end_frame", assetId: request.endFrameAssetId }] : []),
        ...request.references.map((r) => ({
          role: `reference:${r.role}`,
          assetId: r.assetId,
          note: r.label,
        })),
        ...request.audioAssetIds.map((assetId) => ({ role: "audio", assetId })),
      ],
      notes: ["Mock adapter: the prompt is rendered section by section; no network call is made."],
    };
  }

  validateRequest(request: GenerationRequest, model: GenerationModel) {
    const errors: string[] = [];
    if (!model.capabilities.modalities.includes(request.modality)) errors.push("Modality not supported");
    if (request.modality.endsWith("video") && !request.durationMs)
      errors.push("Video requests need a duration");
    return { ok: errors.length === 0, errors };
  }

  estimateCost(request: GenerationRequest, model: GenerationModel) {
    const px = request.resolution ? (request.resolution.width * request.resolution.height) / 1_000_000 : null;
    return estimateCostFromCapabilities(model.capabilities, {
      durationMs: request.durationMs,
      outputs: 1,
      megapixels: px,
    });
  }

  async submit(
    request: GenerationRequest,
    _plan: PromptPlan,
    ctx: ProviderContext,
  ): Promise<GenerationSubmission> {
    const { model } = this.def(request.modelId);
    const check = this.validateRequest(request, model);
    if (!check.ok) {
      throw new GenerationProviderError("invalid_request", "invalid_request", check.errors.join("; "));
    }
    const accepted = ctx.now();
    const token: MockJobToken = {
      v: 1,
      model: request.modelId,
      t: accepted.getTime(),
      d: this.delay,
      k: request.idempotencyKey,
      mod: request.modality,
      dur: request.durationMs,
      ar: request.aspectRatio,
      seed: request.seed ?? seedFromString(`${request.idempotencyKey}:${request.prompt.positive}`),
      neg: Boolean(request.prompt.negative),
    };
    return {
      providerJobId: encodeToken(token),
      providerRequestId: `mockreq_${seedFromString(request.idempotencyKey).toString(16)}`,
      state: this.delay === 0 ? "processing" : "queued",
      providerStatus: this.delay === 0 ? "processing" : "queued",
      acceptedAt: accepted.toISOString(),
    };
  }

  async poll(ref: ProviderJobRef, ctx: ProviderContext): Promise<GenerationStatus> {
    const token = decodeToken(ref.providerJobId);
    const { scenario } = this.def(token.model);
    if (scenario === "transient_poll" && ref.pollCount < 2) {
      throw new GenerationProviderError(
        "provider_unavailable",
        "http_503",
        "Mock provider temporarily unavailable.",
        { retryAfterMs: 1 },
      );
    }
    const elapsed = ctx.now().getTime() - token.t;
    if (scenario === "hang") {
      return { state: "processing", providerStatus: "processing", progress: 0.4, retryAfterMs: 1_000 };
    }
    if (elapsed < token.d) {
      return {
        state: "queued",
        providerStatus: "queued",
        progress: 0,
        retryAfterMs: Math.max(1, token.d - elapsed),
      };
    }
    if (elapsed < token.d * 2) {
      return {
        state: "processing",
        providerStatus: "processing",
        progress: 0.5,
        retryAfterMs: Math.max(1, token.d * 2 - elapsed),
      };
    }
    if (scenario === "rejected") {
      throw new GenerationProviderError(
        "content_rejected",
        "content_policy",
        "The mock provider rejected this request (simulated content policy).",
      );
    }
    return { state: "succeeded", providerStatus: "succeeded", progress: 1, retryAfterMs: null };
  }

  async cancel(ref: ProviderJobRef): Promise<{ confirmed: boolean }> {
    const token = decodeToken(ref.providerJobId);
    const { model } = this.def(token.model);
    // Models without cancellation support never confirm: the UI must say the job may still run remotely.
    return { confirmed: model.capabilities.operational.cancellation };
  }

  async fetchResult(
    ref: ProviderJobRef,
    request: GenerationRequest,
    ctx: ProviderContext,
  ): Promise<GenerationResult> {
    const token = decodeToken(ref.providerJobId);
    const { model, scenario } = this.def(token.model);
    const isVideo = token.mod.endsWith("video");
    const now = ctx.now().toISOString();
    const outputs: ProviderOutput[] = [];

    const [w, h] =
      token.ar === "9:16"
        ? [288, 512]
        : token.ar === "1:1"
          ? [384, 384]
          : token.ar === "21:9"
            ? [672, 288]
            : [512, 288];
    const png = encodeMockPng(w, h, token.seed);
    const base64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
    const stem = `mock-${token.model}-${(token.seed >>> 0).toString(16)}`;

    if (isVideo) {
      outputs.push({
        role: "primary",
        position: 0,
        kind: "video",
        filename: `${stem}.webm`,
        mime: MOCK_VIDEO_FIXTURE.mime,
        source: { type: "bytes", base64: MOCK_VIDEO_WEBM_BASE64 },
        reported: {
          width: MOCK_VIDEO_FIXTURE.width,
          height: MOCK_VIDEO_FIXTURE.height,
          durationMs: MOCK_VIDEO_FIXTURE.durationMs,
          fps: MOCK_VIDEO_FIXTURE.fps,
        },
      });
      outputs.push({
        role: "preview",
        position: 1,
        kind: "image",
        filename: `${stem}-preview.png`,
        mime: "image/png",
        source: { type: "bytes", base64: base64(png) },
        reported: { width: w, height: h, durationMs: null, fps: null },
      });
    } else {
      outputs.push({
        role: "primary",
        position: 0,
        kind: "image",
        filename: `${stem}.png`,
        mime: "image/png",
        source: { type: "bytes", base64: base64(png) },
        reported: { width: w, height: h, durationMs: null, fps: null },
      });
    }

    const estimate = this.estimateCost(request, model);
    const billingKnown = scenario !== "unknown_cost";
    return {
      outputs,
      provenance: {
        provider: MOCK_PROVIDER_ID,
        model: token.model,
        providerJobId: ref.providerJobId,
        providerRequestId: `mockreq_${seedFromString(token.k).toString(16)}`,
        providerModelVersion: "mock-1.0",
        seed: token.seed,
        startedAt: new Date(token.t).toISOString(),
        completedAt: now,
        actualDurationMs: isVideo ? MOCK_VIDEO_FIXTURE.durationMs : null,
        actualResolution: {
          width: isVideo ? MOCK_VIDEO_FIXTURE.width : w,
          height: isVideo ? MOCK_VIDEO_FIXTURE.height : h,
        },
        actualFps: isVideo ? MOCK_VIDEO_FIXTURE.fps : null,
        finishReason: "completed",
        usedInputs: [
          ...(request.startFrameAssetId ? ["start_frame"] : []),
          ...(request.endFrameAssetId ? ["end_frame"] : []),
          ...request.references.map((r) => `reference:${r.role}`),
          ...request.audioAssetIds.map(() => "audio"),
        ],
        settings: {
          modality: token.mod,
          requestedDurationMs: token.dur,
          aspectRatio: token.ar,
          negativePromptSent: token.neg && model.capabilities.references.negativePrompt,
        },
        metadata: {
          mock: true,
          note: "Fixture output: duration/resolution are those of the fixture, not the request.",
          requestedDurationMs: token.dur,
        },
      },
      cost: {
        amount: billingKnown ? estimate.amount : null,
        currency: estimate.currency,
        basis: billingKnown ? `mock: ${estimate.basis}` : "provider reported no billing information",
        units: billingKnown ? estimate.units : null,
      },
    };
  }

  allowedOutputHosts(): string[] {
    return [];
  }
}
