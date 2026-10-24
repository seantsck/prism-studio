import { createHash, randomUUID } from "node:crypto";
import type { CandidateRepository, CandidateSetView } from "@/data/candidates-repository";
import { animationSource, type AnimationSourceFrame } from "@/domain/generation/animation";
import type { GenerationRepository } from "@/data/generation-repository";
import {
  CANDIDATE_LABELS,
  describeComparison,
  planSetSpend,
  type ComparisonDisclosure,
  type SetSpendPlan,
} from "@/domain/generation/candidates";
import type { InputMode, IgnoredFeature } from "@/domain/generation/compatibility";
import { catalogModel } from "@/domain/generation/models/catalog";
import { evaluateModelFit, type ModelFit } from "@/domain/generation/models/matrix";
import { deriveShotFeatureProfile, deriveShotRequirements } from "@/domain/generation/models/requirements";
import type { OutcomeRecord } from "@/domain/generation/performance";
import {
  freezeRecommendation,
  recommendModels,
  type Recommendation,
  type RecommendationPreference,
} from "@/domain/generation/recommendation";
import type { GenerationPurpose } from "@/domain/generation/schemas";
import type { ProjectData } from "@/domain/schemas";
import type { GenerationConfig } from "./config";
import type { ModelRegistry } from "./registry";
import {
  buildSharedEvaluation,
  evaluateShotForModel,
  prepareSubmission,
  type Evaluation,
} from "./submission";

/**
 * Candidate-set planning and submission (Phase 2E). One shared production package, several models, each
 * candidate its own attempt + job. Used by the server action, the DB suite and the tests so they cannot
 * disagree. Nothing here spends money on its own: submission needs an explicit confirmation of the total.
 */
export interface CandidateSelection {
  provider: string;
  modelId: string;
  inputMode?: InputMode | null;
  tierId?: string | null;
  nativeAudio?: boolean;
  /** Still-image quality (Production Frame candidates); null = the model's explicit Prism default. */
  quality?: string | null;
}

export interface CandidatePlanItem {
  label: string;
  selection: CandidateSelection;
  fit: ModelFit;
  evaluation: Evaluation;
  estimateUsd: number | null;
  billsMoney: boolean;
  /** Hard blockers (not acknowledgements): the candidate cannot be created until they are resolved. */
  blockers: string[];
  /** Production intent this candidate will not honour; the user acknowledges them all or nothing is created. */
  ignored: IgnoredFeature[];
}

export interface CandidateSetPlan {
  /** Why these candidates are generated. `production_frame`: still images the filmmaker may promote. */
  purpose: GenerationPurpose;
  items: CandidatePlanItem[];
  spend: SetSpendPlan;
  disclosure: ComparisonDisclosure;
  recommendation: Recommendation;
  /** Blockers from the set level (spend) and candidate level, flattened with their candidate label. */
  blockers: string[];
  allowed: boolean;
  packageFingerprint: string;
}

/** Phase 2H: the Shot's Production Frame selection moved while an animation set was being created. */
export const ANIMATION_SOURCE_CHANGED_MESSAGE =
  "The Production Frame selection changed while this animation set was being created. Review the current Production Frame and animate again.";

export class CandidateSetBlockedError extends Error {
  constructor(
    message: string,
    readonly plan: CandidateSetPlan,
  ) {
    super(message);
    this.name = "CandidateSetBlockedError";
  }
}

const toOptions = (s: CandidateSelection) => ({
  inputMode: s.inputMode ?? undefined,
  tierId: s.tierId ?? null,
  nativeAudio: Boolean(s.nativeAudio),
  quality: s.quality ?? null,
});

function providerOptionsOf(fit: ModelFit, s: CandidateSelection): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (fit.tierId) o.resolutionTier = fit.tierId;
  if (s.nativeAudio) o.nativeAudio = true;
  // image quality is always EXPLICIT when the model has one: never the provider's hidden default
  if (fit.quality) o.quality = fit.quality;
  return o;
}

export function planCandidateSet(args: {
  data: ProjectData;
  shotId: string;
  registry: ModelRegistry;
  config: GenerationConfig;
  selections: readonly CandidateSelection[];
  outcomes: readonly OutcomeRecord[];
  preference?: RecommendationPreference;
  /** Default `shot_output`. */
  purpose?: GenerationPurpose;
  now?: Date;
}): CandidateSetPlan {
  const purpose: GenerationPurpose = args.purpose ?? "shot_output";
  const shared = buildSharedEvaluation(args.data, args.shotId, args.now);
  const { pkg, ctx } = shared;
  const protectedNotes = ctx.shot.generation.protectedComposition;
  const items: CandidatePlanItem[] = args.selections.map((s, i) => {
    const model = args.registry.model(s.provider, s.modelId);
    if (!model) {
      throw new Error(`Unknown model ${s.provider}/${s.modelId}`);
    }
    const availability = args.registry.availabilityOf(model);
    const fit = evaluateModelFit({
      pkg,
      model,
      catalog: catalogModel(s.provider, s.modelId),
      availability,
      options: { ...toOptions(s), protectedNotes, purpose },
    });
    const evaluation = evaluateShotForModel({
      data: args.data,
      shotId: args.shotId,
      registry: args.registry,
      provider: s.provider,
      modelId: s.modelId,
      acknowledged: [],
      adaptation: fit.adaptationChoice,
      inputMode: fit.inputMode ?? undefined,
      providerOptions: providerOptionsOf(fit, s),
      purpose,
      now: args.now,
      shared,
    });
    const blockers = evaluation.gate.blockers.map((b) => b.message);
    return {
      label: CANDIDATE_LABELS[i] ?? String(i + 1),
      selection: s,
      fit,
      evaluation,
      estimateUsd: evaluation.estimate?.amount ?? null,
      billsMoney: args.registry.billsMoney(model),
      blockers,
      ignored: evaluation.gate.unacknowledged,
    };
  });

  const spend = planSetSpend({
    candidates: items.map((it) => ({
      billsMoney: it.billsMoney,
      estimateUsd: it.estimateUsd,
      displayName: it.fit.displayName,
    })),
    paidEnabled: args.config.paid.enabled,
    maxSetUsd: args.config.candidateSet.maxUsd,
    maxPerGenerationUsd: args.config.paid.maxUsd,
    maxCandidates: args.config.candidateSet.maxCandidates,
  });

  const requirements = deriveShotRequirements(pkg, { protectedComposition: protectedNotes, purpose });
  const profile = deriveShotFeatureProfile(pkg, requirements);
  const recommendation = recommendModels({
    fits: items.map((i) => i.fit),
    outcomes: args.outcomes,
    profile,
    requirements,
    preference: args.preference,
    purpose,
  });
  const disclosure = describeComparison(
    pkg,
    items.map((it) => ({ label: it.label, displayName: it.fit.displayName, fit: it.fit })),
    purpose,
  );

  const blockers = [
    ...spend.blockers.map((b) => b.message),
    ...items.flatMap((it) => it.blockers.map((m) => `${it.label} · ${it.fit.displayName}: ${m}`)),
  ];
  return {
    purpose,
    items,
    spend,
    disclosure,
    recommendation,
    blockers,
    allowed: blockers.length === 0,
    packageFingerprint: pkg.provenance.fingerprint,
  };
}

export interface CandidateSubmitResult {
  view: CandidateSetView;
  submitted: number;
  failed: Array<{ label: string; model: string; error: string }>;
}

/** Deterministic per (set, position, package, model): a repeated submit replays instead of duplicating. */
export const candidateKey = (setId: string, position: number, fingerprint: string, modelRef: string) =>
  createHash("sha256").update(`${setId}|${position}|${fingerprint}|${modelRef}`).digest("hex");

/**
 * Creates the set (planned members) and then each candidate's attempt + job INDEPENDENTLY: one candidate
 * failing to submit is recorded on its member and never aborts the others.
 */
export async function submitCandidateSet(args: {
  data: ProjectData;
  shotId: string;
  registry: ModelRegistry;
  config: GenerationConfig;
  generation: GenerationRepository;
  candidates: CandidateRepository;
  selections: readonly CandidateSelection[];
  /** The user saw every "will not be used" item of every candidate and accepts them. */
  acknowledgeAll: boolean;
  /** The maximum total the user confirmed on screen; the server recomputes and refuses a mismatch. */
  confirmedTotalUsd: number | null;
  title: string;
  purpose: string;
  userId: string | null;
  projectRevision: string | null;
  preference?: RecommendationPreference;
  /** Default `shot_output`. `production_frame`: one STILL image per candidate; the Shot is never changed. */
  generationPurpose?: GenerationPurpose;
  /**
   * Phase 2H (`animate_production_frame` only): reads the Shot's CURRENTLY selected Production Frame id from storage.
   * Checked before the set is created and before every candidate, so a set can never mix two source frames: if the
   * selection moves mid-way, the set is refused (or, once started, nothing more is submitted).
   */
  currentProductionFrameId?: () => Promise<string | null>;
  now?: Date;
}): Promise<CandidateSubmitResult> {
  const now = args.now ?? new Date();
  const outcomes = await args.candidates.listOutcomeRecords(args.data.project.id);
  const plan = planCandidateSet({
    data: args.data,
    shotId: args.shotId,
    registry: args.registry,
    config: args.config,
    selections: args.selections,
    outcomes,
    preference: args.preference,
    purpose: args.generationPurpose,
    now,
  });
  if (!plan.allowed)
    throw new CandidateSetBlockedError(plan.blockers[0] ?? "Candidate set is blocked.", plan);
  // Every candidate of one set shares ONE package (one Shot, one duration, one Production Frame): the source of an
  // animation set is that package's frame, frozen on the set as evidence.
  let animatedFrom: AnimationSourceFrame | null = null;
  if (plan.purpose === "animate_production_frame") {
    const source = animationSource(plan.items[0]!.evaluation.pkg);
    if (!source.ok) throw new CandidateSetBlockedError(source.issues[0]!.message, plan);
    animatedFrom = source.frame;
    if (args.currentProductionFrameId && (await args.currentProductionFrameId()) !== animatedFrom.frameId)
      throw new CandidateSetBlockedError(ANIMATION_SOURCE_CHANGED_MESSAGE, plan);
  }
  const needsAck = plan.items.some((i) => i.ignored.length > 0);
  if (needsAck && !args.acknowledgeAll) {
    throw new CandidateSetBlockedError(
      "Acknowledge what each candidate will not use before generating.",
      plan,
    );
  }
  if (plan.spend.paidCount > 0) {
    const shown = args.confirmedTotalUsd;
    const real = plan.spend.totalUsd;
    if (shown == null || real == null || Math.abs(shown - real) > 0.0001) {
      throw new CandidateSetBlockedError(
        "The estimated total changed or was not confirmed. Review the total and confirm again.",
        plan,
      );
    }
  }

  const setId = randomUUID();
  const view = await args.candidates.createSet({
    id: setId,
    projectId: args.data.project.id,
    shotId: args.shotId,
    title:
      args.title.trim() ||
      `${plan.items.length} models · ${plan.items.map((i) => i.fit.displayName).join(" / ")}`,
    purpose: args.purpose.trim(),
    packageFingerprint: plan.packageFingerprint,
    estimatedTotalUsd: plan.spend.totalUsd,
    ceilingUsd: args.config.candidateSet.maxUsd,
    recommendation: {
      ...freezeRecommendation(plan.recommendation),
      // machine-readable purpose of the set (no schema: it lives in the frozen recommendation JSON)
      generationPurpose: plan.purpose,
      // 2H: the one Production Frame every candidate starts from (id, version, image, checksum, intent fingerprint)
      ...(animatedFrom ? { animationSource: animatedFrom } : {}),
      // recommended vs chosen is itself product data: recorded, never nagged about
      chosen: plan.items.map((i) => ({
        provider: i.selection.provider,
        modelId: i.selection.modelId,
        label: i.label,
      })),
      recommendedTopModelId: plan.recommendation.topModelId,
      disclosure: plan.disclosure,
    },
    createdBy: args.userId,
    now: now.toISOString(),
    members: plan.items.map((it, position) => ({
      label: it.label,
      position,
      provider: it.selection.provider,
      model: it.selection.modelId,
      inputMode: it.fit.inputMode,
      tierId: it.fit.tierId,
      nativeAudio: it.fit.nativeAudio,
      estimateUsd: it.estimateUsd,
      plan: {
        generationPurpose: plan.purpose,
        quality: it.fit.quality,
        status: it.fit.status,
        adaptations: it.fit.adaptations,
        limitations: it.fit.limitations,
        unknowns: it.fit.unknowns,
        packaging: it.fit.packaging,
        referencesUsed: it.fit.referencesUsed,
        estimateBasis: it.fit.estimate?.basis ?? null,
        pricingVersion: catalogModel(it.selection.provider, it.selection.modelId)?.pricing.version ?? null,
      },
    })),
  });

  const failed: CandidateSubmitResult["failed"] = [];
  let submitted = 0;
  const cap = Math.max(args.config.limits.maxActivePerProject, plan.items.length);
  let sourceMoved = false;
  for (const [i, it] of plan.items.entries()) {
    const member = view.members[i]!;
    if (!sourceMoved && animatedFrom && args.currentProductionFrameId)
      sourceMoved = (await args.currentProductionFrameId()) !== animatedFrom.frameId;
    if (sourceMoved) {
      // never a mixed-source set: what was already submitted used the frozen frame; nothing else is sent
      failed.push({ label: it.label, model: it.fit.displayName, error: ANIMATION_SOURCE_CHANGED_MESSAGE });
      await args.candidates.markSubmitFailed(member.id, ANIMATION_SOURCE_CHANGED_MESSAGE).catch(() => undefined);
      continue;
    }
    try {
      const key = candidateKey(
        setId,
        i,
        plan.packageFingerprint,
        `${it.selection.provider}/${it.selection.modelId}`,
      );
      const prepared = prepareSubmission({
        data: args.data,
        shotId: args.shotId,
        registry: args.registry,
        provider: it.selection.provider,
        modelId: it.selection.modelId,
        acknowledged: it.ignored.map((f) => f.id),
        adaptation: it.fit.adaptationChoice,
        inputMode: it.fit.inputMode ?? undefined,
        providerOptions: providerOptionsOf(it.fit, it.selection),
        purpose: plan.purpose,
        userId: args.userId,
        idempotencyKey: key,
        config: args.config,
        projectRevision: args.projectRevision,
        now,
      });
      if (!prepared.input) {
        const why = prepared.evaluation.gate.blockers.map((b) => b.message).join(" · ") || "blocked";
        throw new Error(why);
      }
      const created = await args.generation.createAttemptWithJob({
        ...prepared.input,
        allowConcurrentOnShot: true,
        limits: {
          maxActivePerProject: cap,
          maxSubmitsPerMinutePerUser: Math.max(
            args.config.limits.maxSubmitsPerMinutePerUser,
            plan.items.length * 2,
          ),
        },
      });
      await args.candidates.attachAttempt(member.id, created.attempt.id);
      submitted += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ label: it.label, model: it.fit.displayName, error: message });
      await args.candidates.markSubmitFailed(member.id, message).catch(() => undefined);
    }
  }
  const finalView = (await args.candidates.getSet(setId)) ?? view;
  return { view: finalView, submitted, failed };
}
