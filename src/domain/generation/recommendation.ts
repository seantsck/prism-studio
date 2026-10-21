import type { ModelFit } from "./models/matrix";
import { isSimilar, type ShotFeatureProfile, type ShotGenerationRequirements } from "./models/requirements";
import { ofPurpose, type OutcomeRecord } from "./performance";
import type { GenerationPurpose } from "./schemas";
import { NEGATIVE_LABELS, type NegativeTag } from "./reviews";

/**
 * ModelRecommendationEngine v1 ("model-routing-v1"): deterministic, advisory, explainable. No LLM, no
 * learned model, no hidden score: every number below is shown, every label comes with its reasons.
 *
 * ── The math (kept deliberately small) ──────────────────────────────────────────────────────────────────
 * 1. Capability fit F ∈ [0,1], from the model-fit matrix (never from marketing):
 *      F = 1 − min(0.30, 0.12·adaptations) − min(0.20, 0.04·limitations) − refLoss − audioLoss
 *            − min(0.10, 0.05·unknowns)
 *      refLoss   = (needs 2+ identity/Look refs ? 0.25 : 0.10) · (1 − used/total references)
 *      audioLoss = 0.15 when the shot has performance audio the model cannot use
 * 2. Human history H ∈ [0,1], a shrinkage estimate of the positive-review rate:
 *      value v = 1 (good/best), 0.6 (shortlisted), 0 (rejected); unreviewed attempts do not count
 *      weight w = 1.0 for a SIMILAR shot (≥4 of 5 key features match), 0.35 for the same model on a different
 *      kind of shot
 *      H = (Σ w·v + K·P0) / (Σ w + K),   P0 = 0.5, K = 4
 *    K is the prior strength: one lucky 1/1 gives H = 0.60, while 20/25 similar gives ≈ 0.76, so a single
 *    success can never outrank a real track record.
 *    nEff = Σ w. Confidence: LOW < 3, MEDIUM < 8, HIGH ≥ 8.
 *    A reason-specific penalty (≤ 0.15) applies when this model's rejections concentrate on a reason that
 *    matters for THIS shot (identity for a recurring character, wardrobe, lip sync/dialogue audio, camera
 *    motion): 0.5 · (count of that reason / (nEff + 4)).
 * 3. Cost C ∈ [0,1] among the compared candidates: 1 − (est − min)/(max − min); unknown cost = 0.5.
 * 4. Score = wF·F + wH·H' + wC·C where H' = H − reason penalty, with weights by preference:
 *      quality_first  F .35  H .55  C .10
 *      balanced       F .35  H .40  C .25
 *      cost_first     F .30  H .25  C .45
 *    Cold start (the whole candidate pool has nEff < 3): H carries no information, so its weight is dropped
 *    and F/C are renormalised, and the result says so.
 * Labels: incompatible · unavailable (not configured/retired on this server: advice only, never selectable) ·
 *         poor historical fit (nEff ≥ 3 and H ≤ 0.35) · recommended (top score, one only) ·
 *         unknown (capability facts missing) · worth trying.
 */
export const RECOMMENDATION_ENGINE_VERSION = "model-routing-v1";

export const PREFERENCES = ["quality_first", "balanced", "cost_first"] as const;
export type RecommendationPreference = (typeof PREFERENCES)[number];

export const PREFERENCE_LABELS: Record<RecommendationPreference, string> = {
  quality_first: "Quality first",
  balanced: "Balanced",
  cost_first: "Cost first",
};

const WEIGHTS: Record<RecommendationPreference, { f: number; h: number; c: number }> = {
  quality_first: { f: 0.35, h: 0.55, c: 0.1 },
  balanced: { f: 0.35, h: 0.4, c: 0.25 },
  cost_first: { f: 0.3, h: 0.25, c: 0.45 },
};

export const PRIOR_RATE = 0.5;
export const PRIOR_STRENGTH = 4;
export const SIMILAR_WEIGHT = 1;
export const OTHER_SHOT_WEIGHT = 0.35;
export const COLD_START_N = 3;
export const POOR_FIT_RATE = 0.35;

export type RecommendationLabel =
  "recommended" | "worth_trying" | "unknown" | "poor_historical_fit" | "incompatible" | "unavailable";

export const LABEL_TEXT: Record<RecommendationLabel, string> = {
  recommended: "Recommended",
  worth_trying: "Worth trying",
  unknown: "Unknown",
  poor_historical_fit: "Poor historical fit",
  incompatible: "Incompatible",
  unavailable: "Not available here",
};

export type Confidence = "low" | "medium" | "high";

export interface ModelRecommendation {
  provider: string;
  modelId: string;
  displayName: string;
  label: RecommendationLabel;
  /** Rank among compatible candidates (1 = best); null for incompatible. */
  rank: number | null;
  score: number | null;
  parts: { fit: number; history: number | null; cost: number | null; reasonPenalty: number };
  confidence: Confidence;
  /** Evidence counts. */
  sample: { similar: number; similarPositive: number; other: number; nEff: number };
  historicalRate: number | null;
  why: string[];
  concerns: string[];
}

export interface Recommendation {
  engineVersion: typeof RECOMMENDATION_ENGINE_VERSION;
  preference: RecommendationPreference;
  coldStart: boolean;
  /** One plain sentence about how much history there is. */
  historyNote: string;
  models: ModelRecommendation[];
  topModelId: string | null;
  profile: ShotFeatureProfile | null;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const valueOf = (d: OutcomeRecord["decision"]): number | null =>
  d === "approve" ? 1 : d === "shortlist" ? 0.6 : d === "reject" ? 0 : null;
const money = (n: number | null) => (n == null ? "unknown cost" : `$${n.toFixed(n < 1 ? 2 : 2)}`);

/** Capability fit F from a model fit (see the header comment). */
export function capabilityFit(fit: ModelFit, req: ShotGenerationRequirements | null): number {
  const adaptations = fit.adaptations.length;
  const limitations = fit.limitations.length;
  const { used, total } = fit.referencesUsed;
  const lostShare = total > 0 ? 1 - used / total : 0;
  const strong = req?.needs.multipleImageReferences.needed ?? false;
  const refLoss = (strong ? 0.25 : 0.1) * lostShare;
  const audioNeeded = req?.needs.audio.needed ?? false;
  const audioUsed = fit.compatibility.used.audioAssetIds.length > 0;
  const audioLoss = audioNeeded && !audioUsed ? 0.15 : 0;
  return clamp01(
    1 -
      Math.min(0.3, 0.12 * adaptations) -
      Math.min(0.2, 0.04 * limitations) -
      refLoss -
      audioLoss -
      Math.min(0.1, 0.05 * fit.unknowns.length),
  );
}

function relevantReasons(
  profile: ShotFeatureProfile | null,
  req: ShotGenerationRequirements | null,
): NegativeTag[] {
  const out: NegativeTag[] = [];
  if (profile?.hasRecurringCharacter) out.push("character_identity");
  if (profile?.needsWardrobeContinuity) out.push("wardrobe");
  if (req?.needs.audio.needed) out.push("lip_sync", "dialogue_audio");
  if (profile?.cameraMovement === "moving") out.push("camera_motion");
  return out;
}

function confidenceOf(nEff: number): Confidence {
  return nEff < 3 ? "low" : nEff < 8 ? "medium" : "high";
}

export function recommendModels(args: {
  fits: readonly ModelFit[];
  outcomes: readonly OutcomeRecord[];
  profile: ShotFeatureProfile | null;
  requirements: ShotGenerationRequirements | null;
  preference?: RecommendationPreference;
  /**
   * What is being generated. Only HUMAN reviews of the same purpose count: image candidates never feed the video
   * models' history and video reviews never feed the image models'. Default `shot_output`.
   */
  purpose?: GenerationPurpose;
}): Recommendation {
  const preference = args.preference ?? "balanced";
  const w = WEIGHTS[preference];
  // Benchmark / synthetic-fixture projects never feed production routing (their reviews exist to test tooling).
  const reviewed = ofPurpose(args.outcomes, args.purpose ?? "shot_output").filter(
    (o) => !o.benchmark && valueOf(o.decision) != null,
  );

  // history per model
  interface Hist {
    sumWv: number;
    sumW: number;
    similar: number;
    similarPositive: number;
    other: number;
    reasons: Map<NegativeTag, number>;
  }
  const hist = new Map<string, Hist>();
  for (const f of args.fits) {
    const key = `${f.provider}/${f.modelId}`;
    const h: Hist = { sumWv: 0, sumW: 0, similar: 0, similarPositive: 0, other: 0, reasons: new Map() };
    for (const o of reviewed) {
      if (`${o.provider}/${o.model}` !== key) continue;
      const v = valueOf(o.decision)!;
      const sim = args.profile != null && o.profile != null && isSimilar(args.profile, o.profile);
      const wt = sim ? SIMILAR_WEIGHT : OTHER_SHOT_WEIGHT;
      h.sumWv += wt * v;
      h.sumW += wt;
      if (sim) {
        h.similar += 1;
        if (v > 0) h.similarPositive += 1;
      } else h.other += 1;
      for (const t of o.negativeTags) h.reasons.set(t, (h.reasons.get(t) ?? 0) + wt);
    }
    hist.set(key, h);
  }
  const poolEff = [...hist.values()].reduce((a, h) => a + h.sumW, 0);
  const coldStart = poolEff < COLD_START_N;

  // cost normalisation among compatible candidates
  const compatible = args.fits.filter((f) => f.status !== "unsupported" && f.available);
  const costs = compatible.flatMap((f) => (f.estimate?.amountUsd != null ? [f.estimate.amountUsd] : []));
  const minC = costs.length ? Math.min(...costs) : 0;
  const maxC = costs.length ? Math.max(...costs) : 0;
  const costScore = (f: ModelFit): number | null => {
    if (f.estimate?.amountUsd == null) return 0.5;
    if (maxC === minC) return 1;
    return 1 - (f.estimate.amountUsd - minC) / (maxC - minC);
  };

  const reasons = relevantReasons(args.profile, args.requirements);
  const scored: ModelRecommendation[] = args.fits.map((f) => {
    const key = `${f.provider}/${f.modelId}`;
    const h = hist.get(key)!;
    const fit = capabilityFit(f, args.requirements);
    const rate = (h.sumWv + PRIOR_STRENGTH * PRIOR_RATE) / (h.sumW + PRIOR_STRENGTH);
    const historyRate = h.sumW > 0 ? rate : null;
    let penalty = 0;
    for (const t of reasons) {
      const c = h.reasons.get(t) ?? 0;
      if (c > 0) penalty += 0.5 * (c / (h.sumW + PRIOR_STRENGTH));
    }
    penalty = Math.min(0.15, penalty);
    const cost = costScore(f);
    const incompatible = f.status === "unsupported" || !f.available;
    const unavailable = f.status !== "unsupported" && !f.available;

    const why: string[] = [];
    const concerns: string[] = [];
    if (f.status === "supported")
      why.push("Supports the shot's requested inputs and timing without adaptation.");
    for (const a of f.adaptations) concerns.push(`Adaptation: ${a}`);
    if (f.referencesUsed.total > 0)
      (f.referencesUsed.used === f.referencesUsed.total ? why : concerns).push(
        `Uses ${f.referencesUsed.used} of ${f.referencesUsed.total} reference image(s).`,
      );
    if (f.compatibility.used.audioAssetIds.length > 0) why.push("Takes the performed audio as input.");
    for (const l of f.limitations.slice(0, 3)) concerns.push(l);
    for (const u of f.unknowns) concerns.push(`Unknown: ${u}`);
    for (const b of f.blockers.slice(0, 2)) concerns.push(`Blocked: ${b}`);
    if (!f.available) concerns.push(f.availabilityNote || "Not available.");
    if (h.similar > 0) {
      why.push(`${h.similarPositive}/${h.similar} liked on similar reviewed shots.`);
    } else if (h.other > 0) {
      concerns.push(`${h.other} review(s) on different kinds of shots only.`);
    }
    for (const [tag, c] of [...h.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
      if (reasons.includes(tag) && c >= 1)
        concerns.push(
          `${NEGATIVE_LABELS[tag]} was a rejection reason ${Math.round(c)}× (matters for this shot).`,
        );
    }
    if (f.estimate?.amountUsd != null) why.push(`Estimated ${money(f.estimate.amountUsd)}.`);
    else concerns.push("Cost cannot be estimated.");

    let score: number | null = null;
    if (!incompatible) {
      const hh = historyRate == null ? PRIOR_RATE : historyRate;
      if (coldStart) {
        const wf = w.f / (w.f + w.c);
        const wc = w.c / (w.f + w.c);
        score = wf * fit + wc * (cost ?? 0.5);
      } else {
        score = w.f * fit + w.h * clamp01(hh - penalty) + w.c * (cost ?? 0.5);
      }
      score = Math.round(score * 1000) / 1000;
    }
    return {
      provider: f.provider,
      modelId: f.modelId,
      displayName: f.displayName,
      label: unavailable ? "unavailable" : incompatible ? "incompatible" : "worth_trying",
      rank: null,
      score,
      parts: {
        fit: Math.round(fit * 1000) / 1000,
        history: historyRate != null ? Math.round(historyRate * 1000) / 1000 : null,
        cost: cost != null ? Math.round(cost * 1000) / 1000 : null,
        reasonPenalty: Math.round(penalty * 1000) / 1000,
      },
      confidence: confidenceOf(h.sumW),
      sample: {
        similar: h.similar,
        similarPositive: h.similarPositive,
        other: h.other,
        nEff: Math.round(h.sumW * 100) / 100,
      },
      historicalRate: historyRate != null ? Math.round(historyRate * 1000) / 1000 : null,
      why,
      concerns,
    };
  });

  // rank compatible ones: score desc, then cheaper, then model id (deterministic)
  const costOf = (m: ModelRecommendation) =>
    args.fits.find((f) => f.modelId === m.modelId && f.provider === m.provider)?.estimate?.amountUsd ??
    Number.POSITIVE_INFINITY;
  const ranked = scored
    .filter((m) => m.score != null)
    .sort((a, b) => b.score! - a.score! || costOf(a) - costOf(b) || a.modelId.localeCompare(b.modelId));
  ranked.forEach((m, i) => (m.rank = i + 1));

  const statusOf = (m: ModelRecommendation) =>
    args.fits.find((f) => f.modelId === m.modelId && f.provider === m.provider)!.status;
  let topId: string | null = null;
  for (const m of ranked) {
    const poor =
      m.sample.nEff >= COLD_START_N && m.historicalRate != null && m.historicalRate <= POOR_FIT_RATE;
    if (poor) m.label = "poor_historical_fit";
  }
  const top = ranked.find((m) => m.label !== "poor_historical_fit" && statusOf(m) !== "unknown") ?? null;
  if (top) {
    top.label = "recommended";
    topId = top.modelId;
  }
  for (const m of ranked) {
    if (m.label === "worth_trying" && statusOf(m) === "unknown") m.label = "unknown";
  }

  const similarCount = scored.reduce((a, m) => a + m.sample.similar, 0);
  const historyNote = coldStart
    ? "Not enough Prism history yet. Recommendation based mainly on model capabilities."
    : `Based on ${reviewed.length} human-reviewed generation(s) in this project (${similarCount} on similar shots) plus model capabilities.`;
  return {
    engineVersion: RECOMMENDATION_ENGINE_VERSION,
    preference,
    coldStart,
    historyNote,
    models: [...ranked, ...scored.filter((m) => m.score == null)],
    topModelId: topId,
    profile: args.profile,
  };
}

/** Compact, persistable summary of what was shown (stored when a paid selection is made). */
export function freezeRecommendation(r: Recommendation): Record<string, unknown> {
  return {
    engineVersion: r.engineVersion,
    preference: r.preference,
    coldStart: r.coldStart,
    historyNote: r.historyNote,
    topModelId: r.topModelId,
    profile: r.profile,
    models: r.models.map((m) => ({
      provider: m.provider,
      modelId: m.modelId,
      label: m.label,
      rank: m.rank,
      score: m.score,
      parts: m.parts,
      confidence: m.confidence,
      sample: m.sample,
      why: m.why,
      concerns: m.concerns,
    })),
  };
}
