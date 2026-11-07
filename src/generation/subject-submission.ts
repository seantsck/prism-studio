import { randomUUID } from "node:crypto";
import type { CreateSubjectImageAttemptInput } from "@/data/generation-repository";
import { spendBlockers } from "@/domain/generation/gate";
import {
  generationRequestSchema,
  type CostEstimate,
  type GenerationRequest,
} from "@/domain/generation/schemas";
import {
  buildSubjectImagePlan,
  SubjectImageError,
  type SubjectImageInputs,
} from "@/domain/generation/subject-image";
import type { ProjectData } from "@/domain/schemas";
import type { GenerationConfig } from "./config";
import type { ModelRegistry } from "./registry";

/**
 * Phase 5B-I1: prepares a Character / Location image generation for the EXISTING queue. The human chooses the model;
 * nothing here picks or switches one. Every refusal is a sentence the creator can act on, and a paid model is refused
 * outright while the deployment's spend gate is closed (the worker re-checks the same gate before the provider call).
 */
export interface PrepareSubjectImageArgs {
  data: ProjectData;
  input: SubjectImageInputs;
  registry: ModelRegistry;
  provider: string;
  modelId: string;
  /** null = the model's first offered ratio */
  aspectRatio: string | null;
  userId: string | null;
  idempotencyKey: string;
  config: GenerationConfig;
  now?: Date;
}

export type PreparedSubjectImage =
  | {
      ok: true;
      input: CreateSubjectImageAttemptInput;
      estimate: CostEstimate;
      referencesSent: number;
      referencesNotSent: number;
    }
  | { ok: false; reasons: string[] };

export function prepareSubjectImage(args: PrepareSubjectImageArgs): PreparedSubjectImage {
  let built;
  try {
    built = buildSubjectImagePlan(args.data, args.input);
  } catch (e) {
    if (e instanceof SubjectImageError) return { ok: false, reasons: [e.message] };
    throw e;
  }
  const model = args.registry.model(args.provider, args.modelId);
  const adapter = args.registry.adapter(args.provider);
  if (!model || !adapter) return { ok: false, reasons: ["That model is not available on this server."] };
  const availability = args.registry.availabilityOf(model);
  if (!availability.available) {
    const why = !availability.enabled
      ? "That provider is not enabled on this server."
      : availability.missingConfig.length
        ? `That model is not configured on this server (${availability.missingConfig.join(", ")}).`
        : !availability.paidGenerationEnabled
          ? "Paid generation is switched off on this server."
          : "That model is not available right now.";
    return { ok: false, reasons: [why] };
  }
  const caps = model.capabilities;
  if (!caps.image) return { ok: false, reasons: [`${model.displayName} does not make still images.`] };
  const canEdit = caps.modalities.includes("image_to_image") && caps.references.referenceImages;
  const canText = caps.modalities.includes("text_to_image");
  const useReferences = built.references.length > 0 && canEdit;
  if (!useReferences && !canText)
    return {
      ok: false,
      reasons: [`${model.displayName} needs reference images, and this subject has none yet.`],
    };
  const max = useReferences ? caps.references.maxReferences : 0;
  const references = useReferences ? built.references.slice(0, max).map((r, i) => ({ ...r, order: i })) : [];
  const aspectRatio = args.aspectRatio ?? caps.image.aspectRatios[0] ?? null;
  if (!aspectRatio || !caps.image.aspectRatios.includes(aspectRatio))
    return {
      ok: false,
      reasons: [`${model.displayName} offers ${caps.image.aspectRatios.join(", ")}; choose one of those.`],
    };
  const purpose = args.input.subject.kind === "character" ? "character_image" : "location_image";
  const request: GenerationRequest = generationRequestSchema.parse({
    schemaVersion: 1,
    modality: useReferences ? "image_to_image" : "text_to_image",
    purpose,
    provider: model.provider,
    modelId: model.modelId,
    prompt: { positive: built.positive, negative: caps.references.negativePrompt ? built.negative : "" },
    durationMs: null,
    resolution: null,
    aspectRatio,
    fps: null,
    seed: null,
    references,
    startFrameAssetId: null,
    endFrameAssetId: null,
    audioAssetIds: [],
    providerOptions: {},
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
  const subject = args.input.subject;
  return {
    ok: true,
    estimate,
    referencesSent: references.length,
    referencesNotSent: built.references.length - references.length,
    input: {
      attempt: {
        id: randomUUID(),
        projectId: args.data.project.id,
        shotId: null,
        characterId: subject.kind === "character" ? subject.characterId : null,
        locationId: subject.kind === "location" ? subject.locationId : null,
        provider: model.provider,
        model: model.modelId,
        modality: "image",
        prompt: request.prompt.positive,
        negativePrompt: request.prompt.negative,
        packageSnapshot: built.packageSnapshot,
        packageFingerprint: built.packageFingerprint,
        modelSettings: { purpose, aspectRatio, intent: subject.intent, providerOptions: {} },
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
