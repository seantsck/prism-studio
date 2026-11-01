import { fingerprint } from "../hash";
import type { SpendBlocker } from "./analysis/cost";

/**
 * Automatic Shot QA orchestration (Phase 3A.2). Pure: policy validation, automatic-run identities and the decision of
 * what an authenticated reconciliation should do. Nothing here reads, writes, sends or spends.
 *
 *   generation succeeds ──► (signed-in app reconciles) ──► free deterministic QA, automatically
 *                                                     └──► semantic QA only under an explicit Project policy
 *
 * Automatic QA never approves, rejects, retries, regenerates or selects anything: it creates QA runs only.
 */

export const SEMANTIC_MODES = ["off", "suggest", "automatic"] as const;
export type SemanticMode = (typeof SEMANTIC_MODES)[number];

export const SEMANTIC_MODE_LABELS: Record<SemanticMode, string> = {
  off: "Off",
  suggest: "Suggest",
  automatic: "Automatic",
};

/** One Project's persisted QA policy. `revision === 0` = never saved (the default: semantic automation off). */
export interface ProjectQaPolicy {
  projectId: string;
  semanticMode: SemanticMode;
  analyzer: string | null;
  externalMediaAllowed: boolean;
  maxCostPerRunUsd: number | null;
  maxCostPerDayUsd: number | null;
  /**
   * 3A.3 (migration 0045): the owner allows sending the FULL selected delivery video to the chosen analyzer for
   * temporal Shot QA. Separate from `externalMediaAllowed` (bounded frames/references) and never implied by it, by a
   * credential, by the semantic mode or by a past manual analysis. Default false: no 3A.2 policy gains it.
   */
  directVideoAllowed: boolean;
  /**
   * 3A.4F (migration 0047): the Project's separate standing authorisation for cuts. Independent of `semanticMode` in
   * both directions; never inferred from it. Default off.
   */
  sequenceSemanticMode: SemanticMode;
  /** A safety cap on one automatic wave, not a queue length; it never overrides the shared active-job limit. */
  maxTransitionsPerBatch: number;
  revision: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** The default and hard maximum of `maxTransitionsPerBatch` (the database enforces the same range). */
export const MAX_TRANSITIONS_PER_BATCH = 20;

export const defaultQaPolicy = (projectId: string): ProjectQaPolicy => ({
  projectId,
  semanticMode: "off",
  analyzer: null,
  externalMediaAllowed: false,
  maxCostPerRunUsd: null,
  maxCostPerDayUsd: null,
  directVideoAllowed: false,
  sequenceSemanticMode: "off",
  maxTransitionsPerBatch: MAX_TRANSITIONS_PER_BATCH,
  revision: 0,
  updatedBy: null,
  updatedAt: null,
});

export type QaPolicyInput = Pick<
  ProjectQaPolicy,
  "semanticMode" | "analyzer" | "externalMediaAllowed" | "maxCostPerRunUsd" | "maxCostPerDayUsd"
> & {
  /** Absent (a 3A.2 caller) = false. */
  directVideoAllowed?: boolean;
  /** Absent (a 3A.2 / 3A.3 caller) = off. */
  sequenceSemanticMode?: SemanticMode;
  /** Absent = the default. */
  maxTransitionsPerBatch?: number;
};

/**
 * Whether an analysis may send the full output video (3A.3). A manual run needs the Project's full-video permission
 * (plus its own per-run acknowledgement, checked at submit); an AUTOMATIC run also needs the standing external-media
 * consent, because nobody acknowledges it at the time.
 */
export function directVideoPermitted(
  policy: Pick<ProjectQaPolicy, "directVideoAllowed" | "externalMediaAllowed">,
  path: "manual" | "automatic",
): boolean {
  return policy.directVideoAllowed === true && (path === "manual" || policy.externalMediaAllowed === true);
}

const finite = (n: number | null): n is number => n != null && Number.isFinite(n) && n >= 0;

/**
 * Structural honesty of a policy (the same rules the database enforces). `automatic` is a STANDING authorisation: it
 * needs an analyzer, explicit consent to send the frozen media, and two finite ceilings. Nothing is ever implied.
 */
export function qaPolicyErrors(p: QaPolicyInput): string[] {
  const out: string[] = [];
  if (!(SEMANTIC_MODES as readonly string[]).includes(p.semanticMode)) out.push("Choose a semantic QA mode.");
  for (const [v, label] of [
    [p.maxCostPerRunUsd, "per-run"],
    [p.maxCostPerDayUsd, "24-hour"],
  ] as const) {
    if (v != null && !finite(v)) out.push(`The ${label} ceiling must be a non-negative amount.`);
  }
  if (finite(p.maxCostPerRunUsd) && finite(p.maxCostPerDayUsd) && p.maxCostPerRunUsd > p.maxCostPerDayUsd)
    out.push("The per-run ceiling cannot exceed the 24-hour ceiling.");
  if (p.analyzer != null && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(p.analyzer)) out.push("Unknown analyzer.");
  if (p.semanticMode === "automatic") {
    if (!p.analyzer) out.push("Automatic semantic QA needs an analyzer.");
    if (!p.externalMediaAllowed)
      out.push("Automatic semantic QA needs your standing consent to send the frozen media to the analyzer.");
    if (!finite(p.maxCostPerRunUsd)) out.push("Automatic semantic QA needs a finite per-run ceiling.");
    if (!finite(p.maxCostPerDayUsd))
      out.push("Automatic semantic QA needs a finite 24-hour Project ceiling.");
  }
  const sequenceMode = p.sequenceSemanticMode ?? "off";
  if (!(SEMANTIC_MODES as readonly string[]).includes(sequenceMode))
    out.push("Choose a Sequence Continuity automation mode.");
  const cap = p.maxTransitionsPerBatch ?? MAX_TRANSITIONS_PER_BATCH;
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_TRANSITIONS_PER_BATCH)
    out.push(`The transitions per batch must be a whole number from 1 to ${MAX_TRANSITIONS_PER_BATCH}.`);
  if (sequenceMode === "automatic") {
    if (!p.analyzer) out.push("Automatic Sequence Continuity needs an analyzer.");
    if (!p.externalMediaAllowed)
      out.push("Automatic Sequence Continuity needs your standing consent to send media to the analyzer.");
    if (p.directVideoAllowed !== true)
      out.push("Automatic Sequence Continuity needs your permission to send Shot video.");
    if (!finite(p.maxCostPerRunUsd))
      out.push("Automatic Sequence Continuity needs a finite per-run ceiling.");
    if (!finite(p.maxCostPerDayUsd))
      out.push("Automatic Sequence Continuity needs a finite 24-hour Project ceiling.");
  }
  return out;
}

/** Whether this policy needs migration 0047 to be stored honestly. */
export const qaPolicyNeedsSequenceColumns = (p: QaPolicyInput) =>
  (p.sequenceSemanticMode ?? "off") !== "off" ||
  (p.maxTransitionsPerBatch ?? MAX_TRANSITIONS_PER_BATCH) !== MAX_TRANSITIONS_PER_BATCH;

// ───────────────────────── automatic identities ─────────────────────────

export const AUTO_DETERMINISTIC_VERSION = "auto-deterministic-v1";
/** The stable nonce of an automatic semantic submission (a manual one uses a fresh nonce, so a person can re-run). */
export const AUTO_SEMANTIC_NONCE = "auto-semantic-v1";

/**
 * The identity of the ONE automatic deterministic run for this exact truth. No wall-clock time participates: the same
 * attempt, subject, criteria, references, package and rules always give the same key; any change gives a new one.
 */
export function deterministicAutomationKey(t: {
  attemptId: string;
  subjectFingerprint: string;
  criteriaFingerprint: string;
  referenceFingerprint: string;
  packageFingerprint: string;
  rulesVersion: string;
}): string {
  return fingerprint([
    AUTO_DETERMINISTIC_VERSION,
    t.attemptId,
    t.subjectFingerprint,
    t.criteriaFingerprint,
    t.referenceFingerprint,
    t.packageFingerprint,
    t.rulesVersion,
  ]).slice(0, 64);
}

// ───────────────────────── semantic gates ─────────────────────────

export interface AnalyzerAvailability {
  id: string;
  /** Runnable here (configured, credential present, model known); a preview-only analyzer is not runnable. */
  usable: boolean;
  kind: "mock" | "model";
  missingConfig: string[];
}

/**
 * Policy and availability gates that need no estimate (cheap, checked first). Empty = may proceed to the budget
 * check. Order is stable so the first reason is the most fundamental one.
 */
export function semanticPolicyBlockers(
  policy: ProjectQaPolicy,
  analyzer: AnalyzerAvailability | null,
): SpendBlocker[] {
  const out: SpendBlocker[] = [];
  if (policy.semanticMode !== "automatic") return out;
  for (const e of qaPolicyErrors(policy)) out.push({ code: "policy.incomplete", message: e });
  if (out.length > 0) return out;
  if (!analyzer) {
    out.push({
      code: "analyzer.unavailable",
      message: `The Project's analyzer "${policy.analyzer}" is not enabled on this server.`,
    });
  } else if (!analyzer.usable) {
    out.push({
      code: "analyzer.not_runnable",
      message: `The Project's analyzer "${policy.analyzer}" cannot run here${
        analyzer.missingConfig.length ? ` (missing ${analyzer.missingConfig.join(", ")})` : ""
      }.`,
    });
  }
  return out;
}

/** The Sequence equivalent of `semanticPolicyBlockers`: the cheap gates of a standing authorisation for cuts. */
export function sequencePolicyBlockers(
  policy: ProjectQaPolicy,
  analyzer: AnalyzerAvailability | null,
): SpendBlocker[] {
  if (policy.sequenceSemanticMode !== "automatic") return [];
  const errors = qaPolicyErrors(policy);
  if (errors.length > 0) return errors.map((message) => ({ code: "policy.incomplete", message }));
  if (!analyzer)
    return [
      {
        code: "analyzer.unavailable",
        message: `The Project's analyzer "${policy.analyzer}" is not enabled on this server.`,
      },
    ];
  if (!analyzer.usable)
    return [
      {
        code: "analyzer.not_runnable",
        message: `The Project's analyzer "${policy.analyzer}" cannot run here${
          analyzer.missingConfig.length ? ` (missing ${analyzer.missingConfig.join(", ")})` : ""
        }.`,
      },
    ];
  return [];
}

/**
 * The Project's own ceilings, applied ON TOP OF the server's global spend gate (which `submitAnalysis` still applies to
 * every paid analyzer). A Project ceiling can only make things stricter. An unknown estimate never auto-submits.
 */
export function projectBudgetBlockers(args: {
  policy: ProjectQaPolicy;
  maxEstimateUsd: number | null;
  projectSpentLast24hUsd: number;
}): SpendBlocker[] {
  const { policy } = args;
  const run = policy.maxCostPerRunUsd;
  const day = policy.maxCostPerDayUsd;
  if (run == null || day == null)
    return [{ code: "project_budget.no_limit", message: "The Project has no finite automatic QA ceilings." }];
  if (args.maxEstimateUsd == null)
    return [
      {
        code: "project_budget.unknown_cost",
        message: "The analysis cost cannot be estimated, so automatic submission is not allowed.",
      },
    ];
  const out: SpendBlocker[] = [];
  if (args.maxEstimateUsd > run)
    out.push({
      code: "project_budget.over_run_limit",
      message: `Estimated worst-case cost $${args.maxEstimateUsd.toFixed(4)} exceeds the Project per-run ceiling of $${run.toFixed(4)}.`,
    });
  if (args.projectSpentLast24hUsd + args.maxEstimateUsd > day)
    out.push({
      code: "project_budget.over_day_limit",
      message: `Project daily budget reached: $${args.projectSpentLast24hUsd.toFixed(4)} used in the last 24 h of a $${day.toFixed(2)} ceiling.`,
    });
  return out;
}

// ───────────────────────── reconciliation outcome ─────────────────────────

export const RECONCILE_OUTCOMES = [
  "not_eligible",
  "already_current",
  "deterministic_created",
  "semantic_suggested",
  "semantic_queued",
  "semantic_already_queued",
  "semantic_blocked",
  "failed",
] as const;
export type ReconcileOutcome = (typeof RECONCILE_OUTCOMES)[number];

export interface ReconcileResult {
  /** Every outcome that applied, in order (e.g. ["semantic_blocked", "deterministic_created"]). */
  outcomes: ReconcileOutcome[];
  /** Concrete reasons: eligibility, policy blockers, budget blockers, failures. Never hidden behind "ok". */
  reasons: string[];
  runId: string | null;
  jobId: string | null;
}

export type EligibilityReason =
  "attempt_missing" | "not_migrated" | "not_succeeded" | "no_output" | "no_production_truth";

export const ELIGIBILITY_MESSAGES: Record<EligibilityReason, string> = {
  attempt_missing: "That attempt no longer exists in this Project.",
  not_migrated: "Automatic Shot QA needs database migration 0044, which is not applied to this database yet.",
  not_succeeded: "Only a completed generation gets automatic QA.",
  no_output: "This attempt has no output to check.",
  no_production_truth: "The Shot's production truth could not be assembled.",
};

/** Same eligibility as a manual continuity review: a succeeded attempt with a judgeable subject and a Shot. */
export function autoQaEligibility(args: {
  attemptInProject: boolean;
  /** The database can hold automatic runs and the Project policy (migration 0044). */
  automationReady: boolean;
  status: string;
  hasSubject: boolean;
  hasTruth: boolean;
}): EligibilityReason | null {
  if (!args.attemptInProject) return "attempt_missing";
  // before 0044 nothing automatic can be stored: decide that BEFORE any media is read or probed
  if (!args.automationReady) return "not_migrated";
  if (args.status !== "succeeded") return "not_succeeded";
  if (!args.hasTruth) return "no_production_truth";
  if (!args.hasSubject) return "no_output";
  return null;
}

/**
 * What a reconciliation should attempt, given what already exists for the CURRENT truth and the cheap policy gates.
 * Budget gates (which need an estimate) are applied afterwards by the service; when they block, deterministic QA is
 * still ensured. Semantic automatic + all gates → ONE semantic run (it carries the deterministic findings), never a
 * deterministic run AND a semantic run for the same truth.
 */
export function planReconcile(args: {
  eligibility: EligibilityReason | null;
  policy: ProjectQaPolicy;
  deterministicCovered: boolean;
  semanticCovered: boolean;
  policyBlockers: SpendBlocker[];
}):
  | { action: "none"; outcome: "not_eligible" | "already_current" | "semantic_already_queued" }
  | {
      action: "deterministic";
      semantic: "off" | "suggest" | "blocked";
      blockers: SpendBlocker[];
    }
  | { action: "semantic"; fallbackDeterministic: boolean } {
  if (args.eligibility) return { action: "none", outcome: "not_eligible" };
  if (args.semanticCovered) return { action: "none", outcome: "semantic_already_queued" };
  const mode = args.policy.semanticMode;
  if (mode === "automatic" && args.policyBlockers.length === 0)
    return { action: "semantic", fallbackDeterministic: !args.deterministicCovered };
  if (args.deterministicCovered) return { action: "none", outcome: "already_current" };
  return {
    action: "deterministic",
    semantic: mode === "automatic" ? "blocked" : mode,
    blockers: mode === "automatic" ? args.policyBlockers : [],
  };
}
