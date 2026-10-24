import type { GenerationPackage } from "../generation-package";
import { parseGenerationPurpose, type GenerationPurpose } from "./schemas";
import { deriveShotFeatureProfile, type ShotFeatureProfile } from "./models/requirements";
import type { OutcomeRecord } from "./performance";
import { latestReviews, type GenerationReview } from "./reviews";

/** Raw facts about one attempt, as both repositories can produce them. */
export interface RawAttemptOutcome {
  attemptId: string;
  projectId: string;
  provider: string;
  model: string;
  /** The frozen request's purpose (absent = `shot_output`). */
  purpose?: GenerationPurpose;
  status: string;
  /** The frozen GenerationPackage JSON of the attempt (profile is derived from it, never stored twice). */
  packageSnapshot: unknown;
  createdAt: string;
  job: {
    createdAt: string;
    submittedAt: string | null;
    completedAt: string | null;
    /** Failure category of the job (rate_limit, provider_unavailable, ...), when it failed. */
    errorCategory?: string | null;
    errorCode?: string | null;
  } | null;
  /** Provider-reported cost; null when unknown (never replaced by the estimate). */
  actualCostUsd: number | null;
  estimatedCostUsd: number | null;
}

/**
 * The purpose frozen on an attempt's request JSON. Absence (every attempt before Phase 2G.2, and every generic Shot
 * output) means `shot_output` and is returned as undefined; unknown values are treated the same way.
 */
export function purposeOfRequestJson(request: unknown): GenerationPurpose | undefined {
  const p = parseGenerationPurpose((request as { purpose?: unknown } | null)?.purpose);
  return p === "shot_output" ? undefined : p;
}

/** Defensive: attempts frozen under older package shapes yield no profile instead of throwing. */
export function profileOfSnapshot(snapshot: unknown): ShotFeatureProfile | null {
  try {
    const s = snapshot as Partial<GenerationPackage> | null;
    if (!s || !Array.isArray(s.characters) || !s.camera || !s.timing || !s.style || !s.storyIntent)
      return null;
    return deriveShotFeatureProfile(s as GenerationPackage);
  } catch {
    return null;
  }
}

const ms = (a: string | null, b: string | null): number | null => {
  if (!a || !b) return null;
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) && d >= 0 ? d : null;
};

export function buildOutcomeRecords(args: {
  attempts: readonly RawAttemptOutcome[];
  reviews: readonly GenerationReview[];
  /** attempt id → candidate set id */
  memberships: ReadonlyMap<string, string>;
  /** attempt ids that won their set (marked Best, or promoted) */
  preferredAttemptIds: ReadonlySet<string>;
  /** The project is a benchmark / synthetic-fixture project (explicit classification, not inferred). */
  benchmark?: boolean;
}): OutcomeRecord[] {
  const latest = latestReviews(args.reviews);
  return args.attempts.map((a) => {
    const r = latest.get(a.attemptId) ?? null;
    return {
      attemptId: a.attemptId,
      projectId: a.projectId,
      provider: a.provider,
      model: a.model,
      ...(a.purpose ? { purpose: a.purpose } : {}),
      decision: r?.decision ?? "unreviewed",
      negativeTags: r?.negativeTags ?? [],
      positiveTags: r?.positiveTags ?? [],
      preferred: args.preferredAttemptIds.has(a.attemptId),
      inCandidateSet: args.memberships.has(a.attemptId),
      actualCostUsd: a.actualCostUsd,
      estimatedCostUsd: a.estimatedCostUsd,
      // provider accepted → finished and ingested; queued → finished (honest names, see docs/model-performance.md)
      generationMs: ms(a.job?.submittedAt ?? null, a.job?.completedAt ?? null),
      totalMs: ms(a.job?.createdAt ?? a.createdAt, a.job?.completedAt ?? null),
      profile: profileOfSnapshot(a.packageSnapshot),
      benchmark: args.benchmark === true,
      status: a.status,
      errorCategory: a.job?.errorCategory ?? null,
      errorCode: a.job?.errorCode ?? null,
      createdAt: a.createdAt,
    };
  });
}
