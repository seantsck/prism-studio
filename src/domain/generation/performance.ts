import { isPositiveDecision, type NegativeTag, type PositiveTag, type ReviewDecision } from "./reviews";
import type { ShotFeatureProfile } from "./models/requirements";
import type { GenerationPurpose } from "./schemas";

/**
 * Model performance, derived from HUMAN reviews (Phase 2E). Pure and recomputed on demand: aggregates are not
 * persisted (they would go stale and hide how they were built). Small samples are labelled, never dressed up.
 */
export interface OutcomeRecord {
  attemptId: string;
  projectId: string;
  provider: string;
  model: string;
  /**
   * Why the attempt was requested. Absent on records from before Phase 2G.2 (= `shot_output`). A still-image
   * Production Frame candidate never contaminates a video model's profile, and vice versa.
   */
  purpose?: GenerationPurpose;
  /** Current human decision (latest review), "unreviewed" when none. */
  decision: ReviewDecision;
  negativeTags: NegativeTag[];
  positiveTags: PositiveTag[];
  /** Won its candidate set (was marked Best / promoted). */
  preferred: boolean;
  inCandidateSet: boolean;
  /** USD: actual when the provider reported it, else null (estimates are kept separately). */
  actualCostUsd: number | null;
  estimatedCostUsd: number | null;
  /** Provider-accepted → completed/ingested, ms. */
  generationMs: number | null;
  /** Queued → completed, ms. */
  totalMs: number | null;
  /** Feature profile of the frozen package the attempt was built from (null when unavailable). */
  profile: ShotFeatureProfile | null;
  /**
   * The attempt belongs to a benchmark / synthetic-fixture project (an explicit project classification). Such
   * records are kept and shown as TEST / BENCHMARK data but never feed production aggregates or routing.
   */
  benchmark: boolean;
  /** Execution status of the attempt. */
  status: string;
  /** Job failure category when it failed (rate_limit, provider_unavailable, ...). */
  errorCategory?: string | null;
  /** Provider/worker error code (e.g. submission_outcome_unknown), when the job failed. */
  errorCode?: string | null;
  createdAt: string;
}

/** The effective purpose of an outcome (absent = `shot_output`). */
export const outcomePurpose = (r: Pick<OutcomeRecord, "purpose">): GenerationPurpose =>
  r.purpose ?? "shot_output";

/**
 * The outcomes that inform a generation of this purpose. Still-image (Production Frame) history and Shot-output VIDEO
 * history never mix; the two video purposes (generic Shot output and Phase 2H animations of the Production Frame) are
 * both human verdicts on the Shot's moving output, so they inform each other.
 */
export function ofPurpose(records: readonly OutcomeRecord[], purpose: GenerationPurpose): OutcomeRecord[] {
  const still = purpose === "production_frame";
  return records.filter((r) => (outcomePurpose(r) === "production_frame") === still);
}

export type DataScope = "production" | "benchmark";

/** Records of one scope. The default is production: benchmark data is opt-in and always labelled. */
export function inScope(records: readonly OutcomeRecord[], scope: DataScope = "production"): OutcomeRecord[] {
  return records.filter((r) => (scope === "benchmark" ? r.benchmark : !r.benchmark));
}

export type Reliability = "none" | "very_low" | "low" | "moderate";

export function reliabilityOf(reviewed: number): Reliability {
  return reviewed === 0 ? "none" : reviewed < 3 ? "very_low" : reviewed < 10 ? "low" : "moderate";
}

export const RELIABILITY_NOTE: Record<Reliability, string> = {
  none: "No reviewed generations yet.",
  very_low: "Fewer than 3 reviews: an anecdote, not a trend.",
  low: "Fewer than 10 reviews: a hint, not a measurement.",
  moderate: "10 or more reviews. Still a personal sample, not a benchmark.",
};

export interface ModelPerformance {
  provider: string;
  model: string;
  generated: number;
  succeeded: number;
  failed: number;
  reviewed: number;
  approved: number;
  shortlisted: number;
  rejected: number;
  preferredWins: number;
  inCandidateSets: number;
  standalone: number;
  topRejectionReasons: Array<{ tag: NegativeTag; count: number }>;
  topStrengths: Array<{ tag: PositiveTag; count: number }>;
  avgActualCostUsd: number | null;
  medianActualCostUsd: number | null;
  medianGenerationMs: number | null;
  medianTotalMs: number | null;
  /** Spend on candidates a human rejected (not a judgment: the cost of exploring). */
  rejectedSpendUsd: number;
  spendUsd: number;
  unknownCostCount: number;
  /** Positive (good or shortlisted) reviews per $10 of known spend. */
  positivePer10Usd: number | null;
  preferredWinsPer10Usd: number | null;
  avgCostPerPositiveUsd: number | null;
  reliability: Reliability;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

function tally<T extends string>(items: T[]): Array<{ tag: T; count: number }> {
  const m = new Map<T, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 5);
}

export function summarize(provider: string, model: string, rows: readonly OutcomeRecord[]): ModelPerformance {
  const reviewedRows = rows.filter((r) => r.decision !== "unreviewed");
  const positive = reviewedRows.filter((r) => isPositiveDecision(r.decision));
  const rejected = reviewedRows.filter((r) => r.decision === "reject");
  const costs = rows.flatMap((r) => (r.actualCostUsd != null ? [r.actualCostUsd] : []));
  const spend = round4(costs.reduce((a, b) => a + b, 0));
  const rejectedSpend = round4(rejected.reduce((a, r) => a + (r.actualCostUsd ?? 0), 0));
  const wins = rows.filter((r) => r.preferred).length;
  return {
    provider,
    model,
    generated: rows.length,
    succeeded: rows.filter((r) => r.status === "succeeded").length,
    failed: rows.filter((r) => r.status === "failed").length,
    reviewed: reviewedRows.length,
    approved: reviewedRows.filter((r) => r.decision === "approve").length,
    shortlisted: reviewedRows.filter((r) => r.decision === "shortlist").length,
    rejected: rejected.length,
    preferredWins: wins,
    inCandidateSets: rows.filter((r) => r.inCandidateSet).length,
    standalone: rows.filter((r) => !r.inCandidateSet).length,
    topRejectionReasons: tally(rejected.flatMap((r) => r.negativeTags)),
    topStrengths: tally(positive.flatMap((r) => r.positiveTags)),
    avgActualCostUsd: costs.length ? round4(mean(costs)!) : null,
    medianActualCostUsd: costs.length ? round4(median(costs)!) : null,
    medianGenerationMs: median(rows.flatMap((r) => (r.generationMs != null ? [r.generationMs] : []))),
    medianTotalMs: median(rows.flatMap((r) => (r.totalMs != null ? [r.totalMs] : []))),
    rejectedSpendUsd: rejectedSpend,
    spendUsd: spend,
    unknownCostCount: rows.filter((r) => r.status === "succeeded" && r.actualCostUsd == null).length,
    positivePer10Usd: spend > 0 ? round4((positive.length / spend) * 10) : null,
    preferredWinsPer10Usd: spend > 0 ? round4((wins / spend) * 10) : null,
    avgCostPerPositiveUsd: positive.length > 0 && spend > 0 ? round4(spend / positive.length) : null,
    reliability: reliabilityOf(reviewedRows.length),
  };
}

/**
 * OPERATIONAL reliability of a model: did the provider accept and complete the request. Deliberately separate
 * from creative quality: a provider outage or a rejected request is never a human rejection, and a creative
 * reject is never an outage. Counts only; tiny samples are labelled by the caller, never turned into a score.
 */
export interface ProviderReliability {
  provider: string;
  model: string;
  /** Attempts that reached a terminal state (succeeded or failed). */
  terminal: number;
  succeeded: number;
  /** Failed after the provider accepted work (provider_unavailable, timeout, transient, rate_limit). */
  providerFailed: number;
  /** Refused at submission as a bad request / unsupported input (invalid_request, content_rejected). */
  invalidRequest: number;
  /** Submission outcome unknown: may have been accepted and billed; never auto-resubmitted. */
  ambiguousSubmission: number;
  /** Other failures (auth, quota, permanent). */
  otherFailed: number;
}

const INVALID_CATEGORIES = ["invalid_request", "content_rejected"];
const PROVIDER_CATEGORIES = ["provider_unavailable", "timeout", "transient", "rate_limit"];

export function providerReliability(
  records: readonly OutcomeRecord[],
  scope: DataScope = "production",
): ProviderReliability[] {
  const groups = new Map<string, ProviderReliability>();
  for (const r of inScope(records, scope)) {
    if (r.status !== "succeeded" && r.status !== "failed") continue;
    const key = `${r.provider}/${r.model}`;
    const g =
      groups.get(key) ??
      ({
        provider: r.provider,
        model: r.model,
        terminal: 0,
        succeeded: 0,
        providerFailed: 0,
        invalidRequest: 0,
        ambiguousSubmission: 0,
        otherFailed: 0,
      } as ProviderReliability);
    g.terminal++;
    if (r.status === "succeeded") g.succeeded++;
    else if (r.errorCode === "submission_outcome_unknown") g.ambiguousSubmission++;
    else if (INVALID_CATEGORIES.includes(r.errorCategory ?? "")) g.invalidRequest++;
    else if (PROVIDER_CATEGORIES.includes(r.errorCategory ?? "")) g.providerFailed++;
    else g.otherFailed++;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) =>
    `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`),
  );
}

export function aggregateByModel(
  records: readonly OutcomeRecord[],
  scope: DataScope = "production",
): ModelPerformance[] {
  const groups = new Map<string, OutcomeRecord[]>();
  for (const r of inScope(records, scope)) {
    const k = `${r.provider}/${r.model}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()]
    .map(([k, rows]) => {
      const [provider, ...rest] = k.split("/");
      return summarize(provider!, rest.join("/"), rows);
    })
    .sort((a, b) => b.reviewed - a.reviewed || a.model.localeCompare(b.model));
}

/** Shot-type bucket used for "model × shot type" tables: characters · shot size · dialogue. */
export function bucketOf(p: ShotFeatureProfile | null): string {
  if (!p) return "unclassified";
  const chars =
    p.characterCount === "0"
      ? "no character"
      : p.characterCount === "1"
        ? "single character"
        : `${p.characterCount} characters`;
  const size = p.shotSize !== "unspecified" ? p.shotSize : "unspecified shot";
  return `${chars} · ${size}${p.hasDialogue ? " · dialogue" : ""}`;
}

export interface BucketPerformance extends ModelPerformance {
  bucket: string;
}

/** Model history by shot type: "Seedance · two characters · dialogue: 6/8 positive". */
export function aggregateByModelAndBucket(
  records: readonly OutcomeRecord[],
  scope: DataScope = "production",
): BucketPerformance[] {
  const groups = new Map<string, OutcomeRecord[]>();
  for (const r of inScope(records, scope)) {
    const k = `${r.provider}/${r.model}\u0000${bucketOf(r.profile)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()]
    .map(([k, rows]) => {
      const [pm, bucket] = k.split("\u0000");
      const [provider, ...rest] = pm!.split("/");
      return { ...summarize(provider!, rest.join("/"), rows), bucket: bucket! };
    })
    .sort(
      (a, b) => a.bucket.localeCompare(b.bucket) || b.reviewed - a.reviewed || a.model.localeCompare(b.model),
    );
}

export function aggregateByProvider(
  records: readonly OutcomeRecord[],
  scope: DataScope = "production",
): ModelPerformance[] {
  const groups = new Map<string, OutcomeRecord[]>();
  for (const r of inScope(records, scope)) groups.set(r.provider, [...(groups.get(r.provider) ?? []), r]);
  return [...groups.entries()]
    .map(([provider, rows]) => summarize(provider, "(all models)", rows))
    .sort((a, b) => b.reviewed - a.reviewed || a.provider.localeCompare(b.provider));
}
