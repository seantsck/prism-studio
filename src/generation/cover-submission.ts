import { randomUUID } from "node:crypto";
import type { CreateSubjectImageAttemptInput } from "@/data/generation-repository";
import {
  buildCoverArtPlan,
  COVER_ART_POLICY,
  CoverArtError,
  type CoverArtInputs,
} from "@/domain/generation/cover-art";
import { spendBlockers } from "@/domain/generation/gate";
import {
  generationRequestSchema,
  type CostEstimate,
  type GenerationRequest,
} from "@/domain/generation/schemas";
import type { ProjectData } from "@/domain/schemas";
import type { GenerationConfig } from "./config";
import type { ModelRegistry } from "./registry";

/**
 * Cover art for a project on the EXISTING queue (an attempt whose subject is the project: migration 0069). The creator
 * chooses the model and the shape; a paid model is refused outright while the deployment's spend gate is closed (the
 * worker re-checks it before the provider call). Every refusal is a sentence the creator can act on.
 */
export interface PrepareCoverArtArgs {
  data: ProjectData;
  input: CoverArtInputs;
  registry: ModelRegistry;
  provider: string;
  modelId: string;
  aspectRatio: string;
  userId: string | null;
  idempotencyKey: string;
  config: GenerationConfig;
  now?: Date;
}

export type PreparedCoverArt =
  | { ok: true; input: CreateSubjectImageAttemptInput; estimate: CostEstimate; referencesSent: number }
  | { ok: false; reasons: string[] };

export function prepareCoverArt(args: PrepareCoverArtArgs): PreparedCoverArt {
  const model = args.registry.model(args.provider, args.modelId);
  const adapter = args.registry.adapter(args.provider);
  if (!model || !adapter) return { ok: false, reasons: ["That model is not available on this server."] };
  const availability = args.registry.availabilityOf(model);
  if (!availability.available)
    return {
      ok: false,
      reasons: [
        !availability.enabled
          ? "That provider is not enabled on this server."
          : !availability.paidGenerationEnabled
            ? "Paid generation is switched off on this server."
            : "That model is not available right now.",
      ],
    };
  const caps = model.capabilities;
  if (!caps.image) return { ok: false, reasons: [`${model.displayName} does not make still images.`] };
  if (!caps.image.aspectRatios.includes(args.aspectRatio))
    return {
      ok: false,
      reasons: [`${model.displayName} offers ${caps.image.aspectRatios.join(", ")}; choose one of those.`],
    };
  const canRefs = caps.modalities.includes("image_to_image") && caps.references.referenceImages;
  const canText = caps.modalities.includes("text_to_image");
  let built;
  try {
    built = buildCoverArtPlan(args.data, args.input, {
      maxReferences: canRefs ? caps.references.maxReferences : 0,
    });
  } catch (e) {
    if (e instanceof CoverArtError) return { ok: false, reasons: [e.message] };
    throw e;
  }
  const references = built.references;
  if (references.length === 0 && !canText)
    return { ok: false, reasons: [`${model.displayName} needs reference images; choose another engine.`] };
  const providerOptions: Record<string, string> = {};
  if (references.length) providerOptions.prismImageOperation = "reference";
  const request: GenerationRequest = generationRequestSchema.parse({
    schemaVersion: 1,
    modality: references.length ? "image_to_image" : "text_to_image",
    purpose: "cover_art",
    provider: model.provider,
    modelId: model.modelId,
    prompt: { positive: built.positive, negative: caps.references.negativePrompt ? built.negative : "" },
    durationMs: null,
    resolution: null,
    aspectRatio: args.aspectRatio,
    fps: null,
    seed: null,
    references,
    startFrameAssetId: null,
    endFrameAssetId: null,
    audioAssetIds: [],
    providerOptions,
    idempotencyKey: args.idempotencyKey,
  });
  const valid = adapter.validateRequest(request, model);
  if (!valid.ok) return { ok: false, reasons: valid.errors };
  const estimate = adapter.estimateCost(request, model);
  if (args.registry.billsMoney(model)) {
    const policy = args.registry.spendPolicy();
    const blocked = spendBlockers({ paidEnabled: policy.enabled, maxUsd: policy.maxUsd, estimate });
    if (blocked.length) return { ok: false, reasons: blocked.map((b) => b.message) };
  }
  const now = (args.now ?? new Date()).toISOString();
  return {
    ok: true,
    estimate,
    referencesSent: references.length,
    input: {
      attempt: {
        id: randomUUID(),
        projectId: args.data.project.id,
        shotId: null,
        characterId: null,
        locationId: null,
        projectCover: true,
        provider: model.provider,
        model: model.modelId,
        modality: "image",
        prompt: request.prompt.positive,
        negativePrompt: request.prompt.negative,
        packageSnapshot: built.packageSnapshot,
        packageFingerprint: built.packageFingerprint,
        modelSettings: {
          purpose: "cover_art",
          aspectRatio: args.aspectRatio,
          intent: "cover_art",
          providerOptions,
          promptPolicy: COVER_ART_POLICY,
          operation: built.operation,
          ...(args.input.direction.trim() ? { composer: { direction: args.input.direction.trim() } } : {}),
        },
        inputAssetIds: [...new Set(references.map((r) => r.assetId))].sort(),
        outputAssetId: null,
        costUsd: null,
        durationMs: null,
        status: "queued",
        reviewStatus: "unreviewed",
        rejectionCategories: [],
        reviewedAt: null,
        rejectionReason: "",
        notes: "",
        approved: false,
        requestModality: request.modality,
        promptPlan: built.plan,
        request: JSON.parse(JSON.stringify(request)) as Record<string, unknown>,
        compatibility: null,
        acknowledgedIgnored: [],
        adaptationPlan: null,
        createdBy: args.userId,
        createdAt: now,
      },
      job: {
        id: randomUUID(),
        idempotencyKey: args.idempotencyKey,
        maxAttempts: args.config.limits.maxJobAttempts,
        queuePriority: 0,
        currency: estimate.currency,
      },
      estimate,
      limits: {
        maxActivePerProject: args.config.limits.maxActivePerProject,
        maxSubmitsPerMinutePerUser: args.config.limits.maxSubmitsPerMinutePerUser,
      },
      now,
    },
  };
}
