import { CONTINUITY_RULES_VERSION } from "@/domain/continuity/model";
import {
  AUTO_SEMANTIC_NONCE,
  autoQaEligibility,
  deterministicAutomationKey,
  ELIGIBILITY_MESSAGES,
  planReconcile,
  semanticPolicyBlockers,
  type AnalyzerAvailability,
  type EligibilityReason,
  type ProjectQaPolicy,
  type ReconcileOutcome,
  type ReconcileResult,
  type SemanticMode,
} from "@/domain/continuity/automation";
import type { AnalysisSpendPolicy } from "@/domain/continuity/analysis/cost";
import type { AttemptView } from "@/data/generation-repository";
import type { AnalysisJob, AttemptDelivery, ContinuityRunView } from "@/data/media-qa-repository";
import type { ProjectData } from "@/domain/schemas";
import { readVerified, type DeliveryDeps } from "@/media/delivery";
import { AnalysisSubmitError, analysisIdempotencyKey, submitAnalysis } from "./analysis/submit";
import type { ContinuityAnalysisProvider } from "./analysis/provider";
import { computeQaInputs, deterministicFindings, type QaInputs } from "./service";

/**
 * Automatic Shot QA orchestration (Phase 3A.2): ONE explicit, idempotent operation run under the signed-in user's
 * authority (owner RLS). It is never hidden inside a read. The generation worker is not involved: it cannot read QA
 * tables, Project truth or this policy. Semantic execution stays with the continuity worker, which runs the frozen,
 * already-authorised job.
 *
 * Never changes creative state: no approval, rejection, retry, regeneration or selection.
 */

export interface AutoQaDeps extends DeliveryDeps {
  /** Runnable analyzers on this server (`getAnalysisProviders`). */
  providers: Map<string, ContinuityAnalysisProvider>;
  /** Safe availability facts per analyzer (no credentials). */
  availability: AnalyzerAvailability[];
  /** The server's global analysis spend policy and limits: never bypassed, never raised by a Project. */
  paid: AnalysisSpendPolicy;
  limits: { maxActivePerProject: number; maxJobAttempts: number };
}

/** What the current truth of one attempt needs, from reads only. Shared by the page (to decide) and the operation. */
export interface AutoQaState {
  eligibility: EligibilityReason | null;
  inputs: QaInputs | null;
  deterministicKey: string | null;
  deterministicCovered: boolean;
  semanticKey: string | null;
  semanticCovered: boolean;
  semanticJob: AnalysisJob | null;
  provider: ContinuityAnalysisProvider | null;
  analyzer: AnalyzerAvailability | null;
}

export function autoQaState(args: {
  data: ProjectData;
  view: AttemptView;
  delivery: AttemptDelivery | null;
  runs: ContinuityRunView[];
  jobs: AnalysisJob[];
  policy: ProjectQaPolicy;
  providers: Map<string, ContinuityAnalysisProvider>;
  availability: AnalyzerAvailability[];
  now?: Date;
}): AutoQaState {
  const inputs = computeQaInputs({
    data: args.data,
    view: args.view,
    delivery: args.delivery,
    now: args.now,
  });
  const eligibility = autoQaEligibility({
    attemptInProject: args.view.attempt.projectId === args.data.project.id,
    status: args.view.attempt.status,
    hasTruth: inputs !== null,
    hasSubject: Boolean(inputs?.subject),
  });
  const provider = args.policy.analyzer ? (args.providers.get(args.policy.analyzer) ?? null) : null;
  const analyzer = args.policy.analyzer
    ? (args.availability.find((a) => a.id === args.policy.analyzer) ?? null)
    : null;
  if (eligibility || !inputs) {
    return {
      eligibility,
      inputs,
      deterministicKey: null,
      deterministicCovered: false,
      semanticKey: null,
      semanticCovered: false,
      semanticJob: null,
      provider,
      analyzer,
    };
  }
  const deterministicKey = deterministicAutomationKey({
    attemptId: args.view.attempt.id,
    subjectFingerprint: inputs.subjectFingerprint,
    criteriaFingerprint: inputs.criteriaFingerprint,
    referenceFingerprint: inputs.references.fingerprint,
    packageFingerprint: inputs.packageFingerprint,
    rulesVersion: CONTINUITY_RULES_VERSION,
  });
  // the automatic semantic identity: the existing job idempotency key with a STABLE nonce (no time involved)
  const semanticKey = provider ? analysisIdempotencyKey(inputs, provider, AUTO_SEMANTIC_NONCE) : null;
  const semanticJob = semanticKey ? (args.jobs.find((j) => j.idempotencyKey === semanticKey) ?? null) : null;
  return {
    eligibility,
    inputs,
    deterministicKey,
    deterministicCovered: args.runs.some((r) => r.run.automationKey === deterministicKey),
    semanticKey,
    semanticCovered: semanticJob !== null,
    semanticJob,
    provider,
    analyzer,
  };
}

/** What the UI shows about automation, kept separate from the Shot QA assessment state. */
export interface AutoQaView {
  eligible: boolean;
  reason: string | null;
  deterministic: "current" | "covered_by_semantic" | "due" | "not_eligible";
  semantic: {
    mode: SemanticMode;
    analyzer: string | null;
    state: "off" | "suggested" | "queued" | "due" | "blocked";
    reasons: string[];
  };
  /** The page should invoke the reconciliation (once per key). */
  due: boolean;
  /** Identity of what is due (deterministic + semantic keys), so a client fires once per truth. */
  dueKey: string | null;
}

export function autoQaView(state: AutoQaState, policy: ProjectQaPolicy): AutoQaView {
  const mode = policy.semanticMode;
  const blockers = semanticPolicyBlockers(policy, state.analyzer && state.provider ? state.analyzer : null);
  if (state.eligibility) {
    return {
      eligible: false,
      reason: ELIGIBILITY_MESSAGES[state.eligibility],
      deterministic: "not_eligible",
      semantic: { mode, analyzer: policy.analyzer, state: mode === "off" ? "off" : "blocked", reasons: [] },
      due: false,
      dueKey: null,
    };
  }
  const deterministic = state.deterministicCovered
    ? "current"
    : state.semanticCovered
      ? "covered_by_semantic"
      : "due";
  const semantic: AutoQaView["semantic"] =
    mode === "off"
      ? { mode, analyzer: policy.analyzer, state: "off", reasons: [] }
      : mode === "suggest"
        ? { mode, analyzer: policy.analyzer, state: "suggested", reasons: [] }
        : state.semanticCovered
          ? { mode, analyzer: policy.analyzer, state: "queued", reasons: [] }
          : blockers.length > 0
            ? { mode, analyzer: policy.analyzer, state: "blocked", reasons: blockers.map((b) => b.message) }
            : { mode, analyzer: policy.analyzer, state: "due", reasons: [] };
  const due = deterministic === "due" || semantic.state === "due";
  return {
    eligible: true,
    reason: null,
    deterministic,
    semantic,
    due,
    dueKey: due ? `${state.deterministicKey}|${semantic.state === "due" ? state.semanticKey : ""}` : null,
  };
}

/**
 * Deterministic-only QA for the current truth: probes the subject, records the frozen criteria / references /
 * fingerprints and the metadata findings. No analyzer, no external request, no cost, and no review frames or contact
 * sheet (nothing here needs them). Exactly one run per automation key, even under concurrency.
 */
export async function ensureDeterministicQaRun(args: {
  inputs: QaInputs;
  view: AttemptView;
  key: string;
  deps: DeliveryDeps;
}): Promise<{ run: ContinuityRunView; created: boolean }> {
  const { inputs, view, deps } = args;
  const subject = inputs.subject;
  if (!subject) throw new Error("This attempt has no output to check.");
  const now = (deps.now?.() ?? new Date()).toISOString();
  const bytes = await readVerified(subject, deps.storage);
  const probe = await deps.processor.probe(bytes);
  const result = await deps.qa.ensureAutomaticRun(
    {
      projectId: view.attempt.projectId,
      attemptId: view.attempt.id,
      subjectAssetId: subject.id,
      originalAssetId: inputs.original?.id ?? null,
      analyzer: "deterministic",
      analyzerVersion: CONTINUITY_RULES_VERSION,
      analyzerKind: "deterministic",
      rulesVersion: CONTINUITY_RULES_VERSION,
      analysisStatus: "queued",
      packageFingerprint: inputs.packageFingerprint,
      subjectFingerprint: inputs.subjectFingerprint,
      criteriaFingerprint: inputs.criteriaFingerprint,
      referenceFingerprint: inputs.references.fingerprint,
      referenceSet: JSON.parse(JSON.stringify(inputs.references)) as Record<string, unknown>,
      createdBy: deps.userId,
      now,
    },
    deterministicFindings(inputs, subject, probe),
    args.key,
  );
  if (result.created) await deps.qa.setAnalysisStatus(result.run.run.id, "complete", now);
  return result.created
    ? { run: (await deps.qa.getRun(result.run.run.id)) ?? result.run, created: true }
    : result;
}

/**
 * The reconciliation: establish automatic QA for the CURRENT truth of one succeeded attempt, idempotently. Transparent:
 * every outcome and reason is returned. A QA infrastructure failure never touches generation, delivery or review.
 */
export async function reconcileAttemptQa(args: {
  data: ProjectData;
  view: AttemptView;
  policy: ProjectQaPolicy;
  deps: AutoQaDeps;
}): Promise<ReconcileResult> {
  const { data, view, policy, deps } = args;
  const outcomes: ReconcileOutcome[] = [];
  const reasons: string[] = [];
  let runId: string | null = null;
  let jobId: string | null = null;
  try {
    const [delivery, runs, jobs] = await Promise.all([
      deps.qa.getDelivery(view.attempt.id),
      deps.qa.listAttemptRuns(view.attempt.id),
      deps.qa.listAttemptAnalysisJobs(view.attempt.id),
    ]);
    const state = autoQaState({
      data,
      view,
      delivery,
      runs,
      jobs,
      policy,
      providers: deps.providers,
      availability: deps.availability,
      now: deps.now?.(),
    });
    const blockers =
      policy.semanticMode === "automatic"
        ? semanticPolicyBlockers(policy, state.provider ? state.analyzer : null)
        : [];
    const plan = planReconcile({
      eligibility: state.eligibility,
      policy,
      deterministicCovered: state.deterministicCovered,
      semanticCovered: state.semanticCovered,
      policyBlockers: blockers,
    });
    if (plan.action === "none") {
      if (plan.outcome === "not_eligible") reasons.push(ELIGIBILITY_MESSAGES[state.eligibility!]);
      if (plan.outcome === "semantic_already_queued") jobId = state.semanticJob?.id ?? null;
      return { outcomes: [plan.outcome], reasons, runId: state.semanticJob?.runId ?? null, jobId };
    }
    const inputs = state.inputs!;

    let needDeterministic = plan.action === "deterministic";
    if (plan.action === "semantic") {
      try {
        const r = await submitAnalysis({
          inputs,
          view,
          assets: data.assets,
          provider: state.provider!,
          policy: deps.paid,
          deps,
          // the saved `automatic` policy IS the standing consent (checked by semanticPolicyBlockers)
          acknowledged: true,
          nonce: AUTO_SEMANTIC_NONCE,
          limits: deps.limits,
          projectPolicy: policy,
          now: deps.now?.(),
        });
        outcomes.push(r.duplicate ? "semantic_already_queued" : "semantic_queued");
        runId = r.run.run.id;
        jobId = r.job.id;
      } catch (err) {
        if (!(err instanceof AnalysisSubmitError)) throw err;
        outcomes.push("semantic_blocked");
        reasons.push(err.message);
        needDeterministic = plan.fallbackDeterministic;
      }
    } else if (plan.semantic === "suggest") {
      outcomes.push("semantic_suggested");
    } else if (plan.semantic === "blocked") {
      outcomes.push("semantic_blocked");
      reasons.push(...plan.blockers.map((b) => b.message));
    }

    if (needDeterministic) {
      const det = await ensureDeterministicQaRun({ inputs, view, key: state.deterministicKey!, deps });
      outcomes.push(det.created ? "deterministic_created" : "already_current");
      runId ??= det.run.run.id;
    } else if (plan.action === "semantic" && outcomes.includes("semantic_blocked")) {
      outcomes.push("already_current");
    }
    return { outcomes, reasons, runId, jobId };
  } catch (err) {
    return {
      outcomes: [...outcomes, "failed"],
      reasons: [
        ...reasons,
        `Automatic QA could not run: ${err instanceof Error ? err.message : String(err)}`,
      ],
      runId,
      jobId,
    };
  }
}
