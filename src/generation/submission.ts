import { createHash, randomUUID } from "node:crypto";
import type { CreateAttemptInput } from "@/data/generation-repository";
import { buildShotContext, type ShotContext } from "@/domain/context";
import { assembleGenerationPackage, type GenerationPackage } from "@/domain/generation-package";
import { evaluateCompatibility, type CompatibilityReport } from "@/domain/generation/compatibility";
import {
  buildGenerationRequest,
  evaluateGate,
  extendPreflightWithCompatibility,
  type GenerationGate,
} from "@/domain/generation/gate";
import { buildPromptPlan } from "@/domain/generation/prompt-plan";
import type { CostEstimate, GenerationModel, ModelAvailability } from "@/domain/generation/schemas";
import { runPreflight, type PreflightReport } from "@/domain/preflight";
import type { GenerationAttempt, ProjectData } from "@/domain/schemas";
import type { GenerationConfig } from "./config";
import type { ModelRegistry } from "./registry";

/**
 * Everything needed to decide, explain and (if allowed) create a generation. Pure given its inputs:
 * used by the server action, the Generate panel, the CLI and the tests, so they can never disagree.
 */
export interface Evaluation {
  ctx: ShotContext;
  pkg: GenerationPackage;
  /** Preflight including `generation.compat.*` items for this model. */
  report: PreflightReport;
  model: GenerationModel | null;
  availability: ModelAvailability | null;
  compatibility: CompatibilityReport | null;
  estimate: CostEstimate | null;
  gate: GenerationGate;
}

export interface SharedShotEvaluation {
  ctx: ShotContext;
  pkg: GenerationPackage;
  basePreflight: PreflightReport;
}

export function buildSharedEvaluation(data: ProjectData, shotId: string, now?: Date): SharedShotEvaluation {
  const ctx = buildShotContext(data, shotId);
  return { ctx, pkg: assembleGenerationPackage(ctx, now), basePreflight: runPreflight(ctx) };
}

export function evaluateShotForModel(args: {
  data: ProjectData;
  shotId: string;
  registry: ModelRegistry;
  provider: string;
  modelId: string;
  acknowledged?: readonly string[];
  now?: Date;
  /** Reuse an already built context/package when evaluating several models for one shot. */
  shared?: SharedShotEvaluation;
}): Evaluation {
  const shared = args.shared ?? buildSharedEvaluation(args.data, args.shotId, args.now);
  const { ctx, pkg, basePreflight } = shared;
  const model = args.registry.model(args.provider, args.modelId);
  const availability = model ? args.registry.availabilityOf(model) : null;
  const compatibility = model ? evaluateCompatibility(pkg, model) : null;
  const report = extendPreflightWithCompatibility(basePreflight, compatibility);
  const adapter = model ? args.registry.adapter(model.provider) : null;
  let estimate: CostEstimate | null = null;
  if (model && adapter && compatibility?.compatible && compatibility.modality) {
    try {
      const plan = buildPromptPlan(pkg);
      const req = buildGenerationRequest({
        pkg,
        model,
        compatibility,
        plan,
        idempotencyKey: "estimate-only-key",
      });
      estimate = adapter.estimateCost(req, model);
    } catch {
      estimate = null;
    }
  }
  const gate = evaluateGate({
    preflight: basePreflight,
    pkg,
    model,
    availability,
    compatibility,
    acknowledged: args.acknowledged ?? [],
  });
  return { ctx, pkg, report, model, availability, compatibility, estimate, gate };
}

/** Deterministic per (shot, attempt number, package, model): a double click replays instead of duplicating. */
export function submissionKey(
  shotId: string,
  nextAttemptNumber: number,
  fingerprint: string,
  modelRef: string,
) {
  return createHash("sha256")
    .update(`${shotId}|${nextAttemptNumber}|${fingerprint}|${modelRef}`)
    .digest("hex");
}

export interface PreparedSubmission {
  evaluation: Evaluation;
  input: CreateAttemptInput | null;
}

/** Builds the immutable attempt + job input, or null when the gate refuses. */
export function prepareSubmission(args: {
  data: ProjectData;
  shotId: string;
  registry: ModelRegistry;
  provider: string;
  modelId: string;
  acknowledged: string[];
  userId: string | null;
  idempotencyKey: string;
  config: GenerationConfig;
  now?: Date;
  seed?: number | null;
  /** `GenerationRepository.projectRevision()` captured before `data` was loaded (null = unchecked). */
  projectRevision?: string | null;
}): PreparedSubmission {
  const now = args.now ?? new Date();
  const evaluation = evaluateShotForModel({ ...args, now });
  const { pkg, model, compatibility, gate, ctx, estimate } = evaluation;
  if (!gate.allowed || !model || !compatibility || !compatibility.modality)
    return { evaluation, input: null };

  const adapter = args.registry.adapter(model.provider)!;
  const plan = buildPromptPlan(pkg);
  const request = buildGenerationRequest({
    pkg,
    model,
    compatibility,
    plan,
    idempotencyKey: args.idempotencyKey,
    seed: args.seed ?? null,
  });
  const check = adapter.validateRequest(request, model);
  if (!check.ok) {
    return {
      evaluation: {
        ...evaluation,
        gate: {
          allowed: false,
          unacknowledged: [],
          blockers: check.errors.map((message, i) => ({
            code: `adapter.invalid.${i}`,
            source: "model" as const,
            message,
          })),
        },
      },
      input: null,
    };
  }
  const priced = estimate ?? adapter.estimateCost(request, model);
  const used = new Set<string>([
    ...request.references.map((r) => r.assetId),
    ...(request.startFrameAssetId ? [request.startFrameAssetId] : []),
    ...(request.endFrameAssetId ? [request.endFrameAssetId] : []),
    ...request.audioAssetIds,
  ]);
  const stamp = now.toISOString();
  const attempt: Omit<GenerationAttempt, "attemptNumber"> = {
    id: randomUUID(),
    projectId: ctx.project.id,
    shotId: ctx.shot.id,
    provider: model.provider,
    model: model.modelId,
    modality: ctx.shot.generation.modality,
    prompt: request.prompt.positive,
    negativePrompt: request.prompt.negative,
    packageSnapshot: JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>,
    packageFingerprint: pkg.provenance.fingerprint,
    modelSettings: {
      durationMs: request.durationMs,
      resolution: request.resolution,
      aspectRatio: request.aspectRatio,
      fps: request.fps,
      seed: request.seed,
      providerOptions: request.providerOptions,
    },
    inputAssetIds: [...used].sort(),
    outputAssetId: null,
    costUsd: null,
    durationMs: request.durationMs,
    status: "queued",
    reviewStatus: "unreviewed",
    rejectionCategories: [],
    reviewedAt: null,
    rejectionReason: "",
    notes: "",
    approved: false,
    requestModality: request.modality,
    promptPlan: plan,
    request: JSON.parse(JSON.stringify(request)) as Record<string, unknown>,
    compatibility: JSON.parse(JSON.stringify(compatibility)) as Record<string, unknown>,
    acknowledgedIgnored: [...args.acknowledged].sort(),
    createdBy: args.userId,
    createdAt: stamp,
  };
  return {
    evaluation,
    input: {
      attempt,
      job: {
        id: randomUUID(),
        idempotencyKey: args.idempotencyKey,
        maxAttempts: args.config.limits.maxJobAttempts,
        queuePriority: 0,
        currency: priced.currency,
      },
      estimate: priced,
      expectedShotUpdatedAt: ctx.shot.updatedAt,
      expectedProjectRevision: args.projectRevision ?? null,
      limits: {
        maxActivePerProject: args.config.limits.maxActivePerProject,
        maxSubmitsPerMinutePerUser: args.config.limits.maxSubmitsPerMinutePerUser,
      },
      now: stamp,
    },
  };
}
