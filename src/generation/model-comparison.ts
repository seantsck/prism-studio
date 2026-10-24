import { catalogModel } from "@/domain/generation/models/catalog";
import { evaluateModelFit, FIT_LABELS, type ModelFit } from "@/domain/generation/models/matrix";
import {
  deriveShotFeatureProfile,
  deriveShotRequirements,
  profileLabel,
  type ShotFeatureProfile,
  type ShotGenerationRequirements,
} from "@/domain/generation/models/requirements";
import { aggregateByModel, ofPurpose, type OutcomeRecord } from "@/domain/generation/performance";
import type { GenerationPurpose } from "@/domain/generation/schemas";
import {
  capabilityFit,
  recommendModels,
  type Recommendation,
  type RecommendationPreference,
} from "@/domain/generation/recommendation";
import type { InputMode } from "@/domain/generation/compatibility";
import type { ProjectData } from "@/domain/schemas";
import type { ModelRegistry } from "./registry";
import { buildSharedEvaluation } from "./submission";
import {
  variantKey,
  type AnimationVariantFacts,
  type ModelRow,
  type VariantView,
} from "./model-comparison-types";

export { variantKey, type ModelRow, type VariantView } from "./model-comparison-types";

/**
 * Serializable per-shot model comparison for the Generate workspace and the model pages. Pure given its inputs
 * (data, registry, outcomes): the same numbers the candidate-set planner and the gate use. Nothing here
 * contains credentials, URLs or asset bytes.
 */
export interface ModelComparison {
  rows: ModelRow[];
  profile: ShotFeatureProfile;
  profileLabel: string;
  requirements: ShotGenerationRequirements;
  recommendation: Recommendation;
  fingerprint: string;
}

/** "1920:1088" → "1920×1088". */
const canvasText = (px: string | undefined): string | null => (px ? px.replace(":", "×") : null);

/** What an Animate Production Frame candidate would receive and produce, from the same compatibility result. */
function animationFacts(fit: ModelFit): AnimationVariantFacts {
  const c = fit.compatibility;
  const plan = c.adaptation;
  return {
    exactFirstFrame: c.modality === "image_to_video" && Boolean(c.used.startFrameAssetId),
    productionMs: c.duration?.productionMs ?? plan?.duration.productionMs ?? null,
    providerMs: c.used.durationMs,
    deliveryMs: plan?.conform.trimToMs ?? c.duration?.productionMs ?? null,
    productionFraming: plan?.framing.productionLabel ?? null,
    providerCanvas: plan?.framing.providerLabel ?? c.used.aspectRatio,
    audioConditioning:
      c.used.audioAssetIds.length > 0
        ? "Performance supplied as conditioning (not the final dialogue)"
        : c.inputs.some((i) => i.kind === "audio")
          ? "Performance not used"
          : "No performance audio",
    nativeAudio: fit.nativeAudio,
    referencesOmittedKeyframe: fit.packaging.filter((p) => p.state === "not_used_mode").length,
  };
}

const toView = (
  fit: ModelFit,
  requirements: ShotGenerationRequirements,
  canvas: string | null,
): VariantView => ({
  animation: fit.purpose === "animate_production_frame" ? animationFacts(fit) : null,
  status: fit.status,
  statusLabel: FIT_LABELS[fit.status],
  blockers: fit.blockers,
  adaptations: fit.adaptations,
  limitations: fit.limitations,
  unknowns: fit.unknowns,
  packaging: fit.packaging,
  referencesUsed: fit.referencesUsed,
  duration: fit.duration.text,
  durationUnverified: fit.duration.unverified,
  framing: fit.framing.text,
  audio: fit.audio.text,
  estimateUsd: fit.estimate?.amountUsd ?? null,
  estimateBasis: fit.estimate?.basis ?? null,
  fitScore: Math.round(capabilityFit(fit, requirements) * 1000) / 1000,
  quality: fit.quality,
  canvas,
});

/** A still-image model: it generates images and no video (the Production Frame candidate models). */
const isStillModel = (m: { capabilities: { modalities: readonly string[]; video: unknown } }): boolean =>
  m.capabilities.video == null &&
  m.capabilities.modalities.some((x) => x === "text_to_image" || x === "image_to_image");

export function buildModelComparison(args: {
  data: ProjectData;
  shotId: string;
  registry: ModelRegistry;
  outcomes: readonly OutcomeRecord[];
  preference?: RecommendationPreference;
  /** Only these models (default: every registered model that can produce video). */
  filter?: (provider: string, modelId: string) => boolean;
  /**
   * What is being generated. `production_frame` compares the still-image models for a Production Frame candidate,
   * judged by still-image criteria only and by image history only. Default `shot_output` (video models).
   */
  purpose?: GenerationPurpose;
  now?: Date;
}): ModelComparison {
  const purpose: GenerationPurpose = args.purpose ?? "shot_output";
  const shared = buildSharedEvaluation(args.data, args.shotId, args.now);
  const { pkg, ctx } = shared;
  const protectedNotes = ctx.shot.generation.protectedComposition;
  const requirements = deriveShotRequirements(pkg, { protectedComposition: protectedNotes, purpose });
  const profile = deriveShotFeatureProfile(pkg, requirements);
  const outcomes = ofPurpose(args.outcomes, purpose);

  const models = args.registry
    .models()
    .filter((m) => (purpose === "production_frame" ? isStillModel(m) : m.capabilities.video != null))
    .filter((m) => (args.filter ? args.filter(m.provider, m.modelId) : true));

  interface Built {
    model: (typeof models)[number];
    variants: Record<string, VariantView>;
    fits: Record<string, ModelFit>;
    defaultKey: string;
    modes: InputMode[];
    tiers: string[];
    nativeAudio: boolean;
    qualities: Array<{ id: string; label: string; note: string }>;
    defaultQuality: string | null;
  }
  const built: Built[] = models.map((model) => {
    const cat = catalogModel(model.provider, model.modelId);
    const availability = args.registry.availabilityOf(model);
    // an animation of the Production Frame is always keyframe mode: no "references" choice that would demote it
    const modes: InputMode[] =
      model.capabilities.references.keyframesExcludeReferences && purpose === "shot_output"
        ? ["keyframes", "references"]
        : [];
    const tiers = cat && cat.tiers.length > 1 ? cat.tiers.map((t) => t.id) : [];
    // provider audio stays an explicit, default-OFF choice for every video purpose
    const nativeAudio = purpose !== "production_frame" && cat?.audio.nativeGeneration === "supported";
    const qualities = purpose === "production_frame" ? (cat?.image?.qualities ?? []) : [];
    const qualityList: Array<string | null> = qualities.length ? qualities.map((q) => q.id) : [null];
    const modeList: Array<InputMode | undefined> = modes.length ? modes : [undefined];
    const tierList: Array<string | null> = tiers.length ? tiers : [null];
    const audioList = nativeAudio ? [false, true] : [false];
    const variants: Record<string, VariantView> = {};
    const fits: Record<string, ModelFit> = {};
    for (const mode of modeList)
      for (const tier of tierList)
        for (const audio of audioList)
          for (const quality of qualityList) {
            const fit = evaluateModelFit({
              pkg,
              model,
              catalog: cat,
              availability,
              options: {
                inputMode: mode,
                tierId: tier,
                nativeAudio: audio,
                protectedNotes,
                purpose,
                quality,
              },
            });
            const key = variantKey(mode ?? null, tier ?? tiers[0] ?? null, audio, quality);
            const used = fit.compatibility.used;
            // the documented canvas of a catalog model; otherwise the canvas the compatibility engine planned
            const canvas =
              purpose !== "production_frame"
                ? null
                : (canvasText(cat?.tiers[0]?.ratios[used.aspectRatio ?? ""]) ??
                  (used.resolution ? `${used.resolution.width}×${used.resolution.height}` : null));
            variants[key] = toView(fit, requirements, canvas);
            fits[key] = fit;
          }
    const defaultQuality = purpose === "production_frame" ? (cat?.image?.defaultQuality ?? null) : null;
    const defaultKey = variantKey(modes[0] ?? null, tiers[0] ?? null, false, defaultQuality);
    return { model, variants, fits, defaultKey, modes, tiers, nativeAudio, qualities, defaultQuality };
  });

  const defaults = built.map((b) => b.fits[b.defaultKey]!);
  const recommendation = recommendModels({
    fits: defaults,
    outcomes,
    profile,
    requirements,
    preference: args.preference,
    purpose,
  });
  const perf = new Map(aggregateByModel(outcomes).map((p) => [`${p.provider}/${p.model}`, p] as const));

  const rows: ModelRow[] = built.map((b) => {
    const m = b.model;
    const a = args.registry.availabilityOf(m);
    const cat = catalogModel(m.provider, m.modelId);
    const rec = recommendation.models.find((r) => r.provider === m.provider && r.modelId === m.modelId)!;
    const h = perf.get(`${m.provider}/${m.modelId}`) ?? null;
    return {
      key: `${m.provider}/${m.modelId}`,
      provider: m.provider,
      providerName: a.providerName,
      modelId: m.modelId,
      label: m.displayName,
      description: m.description,
      kind: m.kind,
      role: cat?.role ?? null,
      available: a.available,
      unavailableReason: !a.enabled
        ? "disabled on this server"
        : !a.configured
          ? `not configured (${a.missingConfig.join(", ")})`
          : a.lifecycle === "retired"
            ? "retired"
            : !a.paidGenerationEnabled
              ? "paid generation is switched off"
              : null,
      purpose,
      qualities: b.qualities,
      defaultQuality: b.defaultQuality,
      modes: b.modes,
      tiers: b.tiers,
      nativeAudio: b.nativeAudio,
      defaultVariant: b.defaultKey,
      variants: b.variants,
      recommendation: {
        label: rec.label,
        rank: rec.rank,
        score: rec.score,
        confidence: rec.confidence,
        why: rec.why,
        concerns: rec.concerns,
        sample: rec.sample,
        historicalRate: rec.historicalRate,
      },
      history: h
        ? {
            reviewed: h.reviewed,
            approved: h.approved,
            shortlisted: h.shortlisted,
            rejected: h.rejected,
            preferredWins: h.preferredWins,
            reliability: h.reliability,
            topRejectionReasons: h.topRejectionReasons,
          }
        : null,
    };
  });

  return {
    rows,
    profile,
    profileLabel: profileLabel(profile),
    requirements,
    recommendation,
    fingerprint: pkg.provenance.fingerprint,
  };
}
