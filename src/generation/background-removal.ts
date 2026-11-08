import { createHash, randomUUID } from "node:crypto";
import type { CreateSubjectImageAttemptInput } from "@/data/generation-repository";
import { spendBlockers } from "@/domain/generation/gate";
import { generationRequestSchema, type CostEstimate, type PromptPlan } from "@/domain/generation/schemas";
import { hasStoredImage } from "@/domain/generation/subject-image";
import type { ProjectData } from "@/domain/schemas";
import type { GenerationConfig } from "./config";
import { PRISM_MATTING_PROVIDER_ID } from "./providers/prism-matting/adapter";
import type { ModelRegistry } from "./registry";

/**
 * Phase 5B-I3: prepares "Remove Background" for a Character image on the EXISTING queue (a subject attempt whose
 * purpose is `background_removal`). The source must be one of THIS project's stored images; the caller (the server
 * action) also checks it belongs to the Character. Nothing is generated: there is no Bible prompt, only the source.
 *
 * Lineage: source Asset → this attempt (`modelSettings.backgroundRemovalSourceAssetId`, `inputAssetIds`) → the cutout
 * Asset the worker ingests. The source is never modified.
 */
export const DEFAULT_MATTING_ENGINE = "plain-background-keyer-1";

export type PreparedBackgroundRemoval =
  | { ok: true; input: CreateSubjectImageAttemptInput; estimate: CostEstimate }
  | { ok: false; reasons: string[] };

export function prepareBackgroundRemoval(args: {
  data: ProjectData;
  characterId: string;
  sourceAssetId: string;
  registry: ModelRegistry;
  userId: string | null;
  idempotencyKey: string;
  config: GenerationConfig;
  /** Default: the local plain-background engine. */
  engine?: string;
  now?: Date;
}): PreparedBackgroundRemoval {
  const character = args.data.characters.find((c) => c.id === args.characterId);
  if (!character) return { ok: false, reasons: ["That character no longer exists."] };
  const source = args.data.assets.find((a) => a.id === args.sourceAssetId);
  if (!hasStoredImage(source) || source.projectId !== args.data.project.id)
    return { ok: false, reasons: ["That image no longer exists in this project."] };
  const engine = args.engine ?? DEFAULT_MATTING_ENGINE;
  const model = args.registry.model(PRISM_MATTING_PROVIDER_ID, engine);
  const adapter = args.registry.adapter(PRISM_MATTING_PROVIDER_ID);
  if (!model || !adapter)
    return { ok: false, reasons: ["Background removal is not available on this server."] };
  if (!args.registry.availabilityOf(model).available)
    return { ok: false, reasons: ["Background removal is not enabled on this server."] };

  const plan: PromptPlan = {
    version: 1,
    sections: [
      {
        key: "subject",
        title: "Background removal",
        lines: [`Cut out ${character.name} from the background (segmentation; nothing is generated).`],
      },
    ],
  };
  const request = generationRequestSchema.parse({
    schemaVersion: 1,
    modality: "image_to_image",
    purpose: "background_removal",
    provider: model.provider,
    modelId: model.modelId,
    prompt: { positive: plan.sections[0]!.lines[0]!, negative: "" },
    durationMs: null,
    resolution: source.width && source.height ? { width: source.width, height: source.height } : null,
    aspectRatio: null,
    fps: null,
    seed: null,
    references: [{ assetId: source.id, role: "identity", order: 0, label: "the source image" }],
    startFrameAssetId: null,
    endFrameAssetId: null,
    audioAssetIds: [],
    providerOptions: {},
    idempotencyKey: args.idempotencyKey,
  });
  const valid = adapter.validateRequest(request, model);
  if (!valid.ok) return { ok: false, reasons: valid.errors };
  const estimate = adapter.estimateCost(request, model);
  // the spend gate applies to any engine that bills (the local engine does not)
  if (args.registry.billsMoney(model)) {
    const policy = args.registry.spendPolicy();
    const blocked = spendBlockers({ paidEnabled: policy.enabled, maxUsd: policy.maxUsd, estimate });
    if (blocked.length) return { ok: false, reasons: blocked.map((b) => b.message) };
  }
  const packageSnapshot = {
    kind: "background_removal",
    characterId: character.id,
    sourceAssetId: source.id,
    sourceChecksum: source.checksum,
    engine: model.modelId,
  };
  const now = (args.now ?? new Date()).toISOString();
  return {
    ok: true,
    estimate,
    input: {
      attempt: {
        id: randomUUID(),
        projectId: args.data.project.id,
        shotId: null,
        characterId: character.id,
        locationId: null,
        provider: model.provider,
        model: model.modelId,
        modality: "image",
        prompt: request.prompt.positive,
        negativePrompt: "",
        packageSnapshot,
        packageFingerprint: createHash("sha256").update(JSON.stringify(packageSnapshot)).digest("hex"),
        modelSettings: {
          purpose: "background_removal",
          intent: "cutout",
          providerOptions: {},
          // lineage: the image the cutout is made from (never modified)
          backgroundRemovalSourceAssetId: source.id,
        },
        inputAssetIds: [source.id],
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
        requestModality: "image_to_image",
        promptPlan: plan,
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
