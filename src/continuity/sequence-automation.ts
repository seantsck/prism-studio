import { createHash } from "node:crypto";
import type { AnalysisSpendPolicy } from "@/domain/continuity/analysis/cost";
import {
  sequencePolicyBlockers,
  type AnalyzerAvailability,
  type ProjectQaPolicy,
  type SemanticMode,
} from "@/domain/continuity/automation";
import { isAnalysisActive } from "@/domain/continuity/analysis/job-state";
import { buildEpisodeCuts, type CutTransition } from "@/domain/continuity/sequence";
import {
  AUTO_SEQUENCE_NONCE,
  compareCutPriority,
  cutSettlement,
  cutSettlementSources,
  planSequenceWave,
  SEQUENCE_SETTLE_MS,
  type CutSettlement,
  type CutSettlementClock,
  type SequenceReconcileOutcome,
  type SequenceReconcileResult,
  type WaveStop,
} from "@/domain/continuity/sequence-automation";
import type { EpisodeEditView } from "@/domain/edit/view";
import type { ProjectData } from "@/domain/schemas";
import type { EpisodeEditRepository } from "@/data/episode-edit-repository";
import type { MediaQaRepository, TransitionAnalysisJob } from "@/data/media-qa-repository";
import type { DeliveryDeps } from "@/media/delivery";
import type { ContinuityAnalysisProvider } from "./analysis/provider";
import {
  buildTransitionInput,
  MAX_MANUAL_SEQUENCE_CUTS,
  queueTransitionBatch,
  sequenceIdempotencyKey,
  SequenceReviewError,
} from "./sequence-review";

/**
 * Automatic Sequence Continuity orchestration (Phase 3A.4F): ONE explicit, idempotent operation under the signed-in
 * user's authority (owner RLS), never hidden inside a read or an edit write. The continuity worker only executes the
 * frozen job and never reads this policy. Never changes creative state: no approval, rejection, regeneration or edit.
 *
 * `loadSequenceAutoState` is reads only (page and operation share it); only `reconcileSequenceQa` derives or queues, and
 * only after every gate: truth, migration, policy, calibrated capability, settling, coverage, capacity, budget.
 */

export const AUTO_SEQUENCE_QUEUED_NOTE =
  "Queued automatically under the Project's Sequence Continuity policy";

export type SequenceCutStatus =
  /** an active automatic job for this exact truth */
  | "queued"
  /** an automatic job for this exact truth exists (any terminal status): covered, as Shot QA */
  | "covered"
  | "due"
  | "settling"
  /** a source has no reliable clock: never auto-submitted (manual review stays available) */
  | "settle_unknown"
  /** nothing here can be analysed: unusable media, or only families without calibration acceptance */
  | "not_analysable";

export interface SequenceCutState {
  cut: CutTransition;
  status: SequenceCutStatus;
  settlement: CutSettlement | null;
  automationKey: string | null;
  job: TransitionAnalysisJob | null;
  maxUsd: number | null;
  /** why it is not analysable */
  reason: string | null;
}

export interface SequenceAutoState {
  ready: boolean;
  policy: ProjectQaPolicy;
  provider: ContinuityAnalysisProvider | null;
  analyzer: AnalyzerAvailability | null;
  policyBlockers: string[];
  cuts: SequenceCutState[];
  /** due cuts in priority order */
  due: SequenceCutState[];
  freeSlots: number;
  activeSequenceJobs: number;
  wave: SequenceCutState[];
  remaining: SequenceCutState[];
  waveStop: WaveStop;
  waveReasons: string[];
  waveMaxUsd: number;
}

export interface SequenceAutoDeps {
  qa: Pick<
    MediaQaRepository,
    | "sequenceAutomationReady"
    | "findTransitionJobsByKeys"
    | "listActiveProjectAnalysisJobs"
    | "analysisSpentSince"
  >;
  edits: Pick<EpisodeEditRepository, "getCutSettlementClock">;
  providers: ReadonlyMap<string, ContinuityAnalysisProvider>;
  availability: readonly AnalyzerAvailability[];
  paid: AnalysisSpendPolicy;
  limits: { maxActivePerProject: number; maxJobAttempts: number };
  /** only a memory-mode E2E may shorten this (`getSequenceSettleMs`) */
  settleMs?: number;
}

/** The current truth, from reads only. Writes, derives and sends nothing. */
export async function loadSequenceAutoState(args: {
  data: ProjectData;
  view: EpisodeEditView;
  policy: ProjectQaPolicy;
  deps: SequenceAutoDeps;
  now: Date;
}): Promise<SequenceAutoState> {
  const { data, view, policy, deps, now } = args;
  const provider = policy.analyzer ? (deps.providers.get(policy.analyzer) ?? null) : null;
  const analyzer = policy.analyzer ? (deps.availability.find((a) => a.id === policy.analyzer) ?? null) : null;
  const ready = await deps.qa.sequenceAutomationReady();
  const empty: SequenceAutoState = {
    ready,
    policy,
    provider,
    analyzer,
    policyBlockers: [],
    cuts: [],
    due: [],
    freeSlots: 0,
    activeSequenceJobs: 0,
    wave: [],
    remaining: [],
    waveStop: "complete",
    waveReasons: [],
    waveMaxUsd: 0,
  };
  // off, or before 0047: no clock, job, spend or plan is even read
  if (!ready || policy.sequenceSemanticMode === "off") return empty;

  const policyBlockers = sequencePolicyBlockers(policy, provider ? analyzer : null).map((b) => b.message);
  const clock: CutSettlementClock = await deps.edits.getCutSettlementClock(data.project.id, view.edit.id);
  const cuts = [...buildEpisodeCuts({ data, view })].sort(compareCutPriority);
  // suggest plans as if allowed: the review it leads to states and enforces the missing permission itself
  const allowed = policy.sequenceSemanticMode === "suggest" || policy.directVideoAllowed;
  const planned = cuts.map((cut) => {
    if (!provider) return { cut, input: null, key: null };
    const input = buildTransitionInput({
      cut,
      view,
      data,
      provider,
      directVideoAllowed: allowed,
      edge: null,
      runKey: "automatic-plan",
    });
    const batch = input.plan.batches[0];
    return {
      cut,
      input,
      key: batch
        ? sequenceIdempotencyKey(cut.truth, provider, batch.promptVersion, AUTO_SEQUENCE_NONCE)
        : null,
    };
  });
  const keys = planned.flatMap((p) => (p.key ? [p.key] : []));
  const jobs = keys.length ? await deps.qa.findTransitionJobsByKeys(data.project.id, keys) : [];
  const active = await deps.qa.listActiveProjectAnalysisJobs(data.project.id);
  const freeSlots = Math.max(0, deps.limits.maxActivePerProject - active.length);

  const states: SequenceCutState[] = planned.map(({ cut, input, key }) => {
    const base = { cut, automationKey: key, settlement: null, job: null, reason: null, maxUsd: null };
    if (!provider || !input || !key)
      return {
        ...base,
        status: "not_analysable",
        reason:
          input?.plan.items.find((i) => i.mode === "sequence_transition")?.reason ??
          input?.plan.items.find((i) => i.status === "no_media" || i.status === "unsupported")?.reason ??
          (provider ? "No criterion of this cut can be analysed." : "The Project has no runnable analyzer."),
      };
    const job = jobs.find((j) => j.idempotencyKey === key) ?? null;
    if (job) return { ...base, job, status: isAnalysisActive(job.status) ? "queued" : "covered" };
    const settlement = cutSettlement({
      sources: cutSettlementSources(data, cut),
      clock,
      now,
      settleMs: deps.settleMs ?? SEQUENCE_SETTLE_MS,
    });
    const estimate = provider.estimate(input, now).maxUsd;
    return {
      ...base,
      settlement,
      maxUsd: Number.isFinite(estimate) ? estimate : null,
      status:
        settlement.state === "settled"
          ? "due"
          : settlement.state === "settling"
            ? "settling"
            : "settle_unknown",
    };
  });
  const due = states.filter((s) => s.status === "due");
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const plan = planSequenceWave({
    due,
    freeSlots,
    policy,
    costed: provider?.kind === "model",
    paid: deps.paid,
    // the SAME ledger as Shot QA: no separate Sequence budget exists
    projectSpentLast24hUsd: await deps.qa.analysisSpentSince(data.project.id, since),
    spentLast24hUsd: await deps.qa.analysisSpentSince(null, since),
  });
  return {
    ...empty,
    policyBlockers,
    cuts: states,
    due,
    freeSlots,
    activeSequenceJobs: active.filter((j) => j.subjectKind === "transition").length,
    wave: plan.wave,
    remaining: plan.remaining,
    waveStop: plan.stoppedBy,
    waveReasons: plan.reasons,
    waveMaxUsd: plan.totalMaxUsd,
  };
}

// ───────────────────────── what the Supervisor shows ─────────────────────────

export interface SequenceAutoView {
  mode: SemanticMode;
  ready: boolean;
  analyzer: string | null;
  calibration: { version: string; acceptedFamilies: number } | null;
  counts: {
    cuts: number;
    due: number;
    settling: number;
    unknown: number;
    blocked: number;
    covered: number;
    activeJobs: number;
  };
  batchCap: number;
  freeSlots: number;
  /** the worst case of every due cut; null when any is unknown */
  dueMaxUsd: number | null;
  waveCuts: number;
  waveMaxUsd: number;
  reasons: string[];
  /** automatic mode: the page should invoke the reconciliation, once per key */
  due: boolean;
  dueKey: string | null;
  /** suggest mode: the first bounded manual batch, through the existing disclosure */
  reviewBatch: { transitionKeys: string[]; analyzer: string; more: number } | null;
}

export function sequenceAutoView(state: SequenceAutoState): SequenceAutoView {
  const { policy, provider, cuts } = state;
  const mode = policy.sequenceSemanticMode;
  const count = (...s: SequenceCutState["status"][]) => cuts.filter((c) => s.includes(c.status)).length;
  const known = state.due.every((d) => d.maxUsd != null);
  const reasons = [...state.policyBlockers, ...state.waveReasons];
  if (state.ready && mode !== "off" && !provider && state.policyBlockers.length === 0)
    reasons.push("Choose a runnable analyzer in the Project's QA settings.");
  if (state.due.length > 0 && state.waveStop === "no_slots" && state.wave.length === 0)
    reasons.push(
      "No analysis slot is free: the Project's active jobs (Shot and Sequence share them) must finish.",
    );
  const automatic =
    state.ready && mode === "automatic" && state.policyBlockers.length === 0 && state.wave.length > 0;
  return {
    mode,
    ready: state.ready,
    analyzer: policy.analyzer,
    calibration: provider
      ? {
          version: provider.crossCutCalibration().version,
          acceptedFamilies: provider.crossCutCalibration().acceptedFamilies.length,
        }
      : null,
    counts: {
      cuts: cuts.length,
      due: state.due.length,
      settling: count("settling"),
      unknown: count("settle_unknown"),
      blocked: count("not_analysable"),
      covered: count("queued", "covered"),
      activeJobs: state.activeSequenceJobs,
    },
    batchCap: policy.maxTransitionsPerBatch,
    freeSlots: state.freeSlots,
    dueMaxUsd: known ? state.due.reduce((n, d) => n + (d.maxUsd ?? 0), 0) : null,
    waveCuts: state.wave.length,
    waveMaxUsd: state.waveMaxUsd,
    reasons,
    due: automatic,
    // the free slots are part of it: when a job finishes the next wave has a new key and the reconciler fires again
    dueKey: automatic
      ? createHash("sha256")
          .update([state.freeSlots, ...state.due.map((d) => d.automationKey), policy.revision].join("|"))
          .digest("hex")
      : null,
    reviewBatch:
      state.ready && mode === "suggest" && policy.analyzer && state.due.length > 0
        ? {
            analyzer: policy.analyzer,
            transitionKeys: state.due.slice(0, MAX_MANUAL_SEQUENCE_CUTS).map((d) => d.cut.transitionKey),
            more: Math.max(0, state.due.length - MAX_MANUAL_SEQUENCE_CUTS),
          }
        : null,
  };
}

// ───────────────────────── the reconciliation ─────────────────────────

/**
 * Queues the next wave of the CURRENT truth, idempotently. The caller re-read the Project, edit, media facts and policy
 * for this call; a browser's plan is never trusted. Every outcome and reason is returned; a failure is never "ok".
 */
export async function reconcileSequenceQa(args: {
  data: ProjectData;
  view: EpisodeEditView;
  policy: ProjectQaPolicy;
  auto: SequenceAutoDeps;
  deps: DeliveryDeps;
  now?: Date;
}): Promise<SequenceReconcileResult> {
  const { data, view, policy, auto, deps } = args;
  const now = args.now ?? deps.now?.() ?? new Date();
  const result = (
    outcome: SequenceReconcileOutcome,
    reasons: string[],
    state?: SequenceAutoState,
    queued: Array<{ job: { id: string } }> = [],
  ): SequenceReconcileResult => ({
    outcome,
    reasons,
    totalCuts: state?.cuts.length ?? 0,
    dueCuts: state?.due.length ?? 0,
    settlingCuts: state?.cuts.filter((c) => c.status === "settling").length ?? 0,
    blockedCuts:
      state?.cuts.filter((c) => c.status === "not_analysable" || c.status === "settle_unknown").length ?? 0,
    queued: queued.length,
    remainingDue: Math.max(0, (state?.due.length ?? 0) - queued.length),
    jobIds: queued.map((q) => q.job.id),
  });
  let state: SequenceAutoState | undefined;
  try {
    state = await loadSequenceAutoState({ data, view, policy, deps: auto, now });
    if (!state.ready)
      return result("not_ready", [
        "Sequence Continuity automation needs database migration 0047, which is not applied to this database yet.",
      ]);
    if (policy.sequenceSemanticMode === "off") return result("off", [], state);
    if (policy.sequenceSemanticMode === "suggest") return result("suggested", [], state);
    if (state.policyBlockers.length > 0) return result("policy_blocked", state.policyBlockers, state);
    if (!state.provider) return result("policy_blocked", ["The Project's analyzer is not available."], state);
    if (state.due.length === 0) {
      const settling = state.cuts.some((c) => c.status === "settling");
      const queued = state.cuts.some((c) => c.status === "queued");
      return result(settling ? "settling" : queued ? "already_queued" : "nothing_due", [], state);
    }
    if (state.wave.length === 0)
      return result(
        state.waveStop === "no_slots" ? "capacity_blocked" : "budget_blocked",
        state.waveReasons.length
          ? state.waveReasons
          : [`No analysis slot is free (limit ${auto.limits.maxActivePerProject} active per Project).`],
        state,
      );

    const provider = state.provider;
    const { wave } = state;
    const queued = await queueTransitionBatch({
      data,
      view,
      cuts: wave.map((w) => w.cut),
      keys: wave.map((w) => w.automationKey!),
      provider,
      qaPolicy: policy,
      deps,
      limits: auto.limits,
      now,
      authority: {
        kind: "automatic",
        queuedNote: AUTO_SEQUENCE_QUEUED_NOTE,
        // the EXACT media's worst case, against the same gates: one over budget refuses the WHOLE wave
        checkBudget: async (inputs) => {
          const estimates = inputs.map((i) => provider.estimate(i, now));
          const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
          const check = planSequenceWave({
            due: estimates.map((e) => ({ maxUsd: Number.isFinite(e.maxUsd) ? e.maxUsd : null })),
            freeSlots: inputs.length,
            policy,
            costed: provider.kind === "model",
            paid: auto.paid,
            projectSpentLast24hUsd: await auto.qa.analysisSpentSince(data.project.id, since),
            spentLast24hUsd: await auto.qa.analysisSpentSince(null, since),
          });
          if (check.wave.length !== inputs.length)
            throw new SequenceReviewError(
              "budget_blocked",
              `After preparing the exact media the wave no longer fits: ${check.reasons.join(" ") || "over budget"} Nothing was queued.`,
            );
          return estimates;
        },
      },
    });
    const fresh = queued.filter((q) => !q.duplicate);
    return result(fresh.length > 0 ? "queued" : "already_queued", [], state, fresh);
  } catch (err) {
    if (err instanceof SequenceReviewError)
      return result(
        err.code === "budget_blocked" || err.code === "cost_changed"
          ? "budget_blocked"
          : err.code === "limit"
            ? "capacity_blocked"
            : "failed",
        [err.message],
        state,
      );
    return result(
      "failed",
      [`Automatic Sequence QA could not run: ${err instanceof Error ? err.message : String(err)}`],
      state,
    );
  }
}
