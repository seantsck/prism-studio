/**
 * ContinuityAnalysisJob lifecycle (mutable EXECUTION state; the ContinuityRun it serves is immutable analytical
 * history, exactly as GenerationJob ↔ GenerationAttempt). Mirrored by the database trigger in migration 0022 and
 * compared pair-by-pair in `db:continuity-analysis`.
 *
 *   queued ──claim──► claimed ──► processing ──► succeeded
 *      ▲                  │            │  └────► failed
 *      └── safe retry ────┴────────────┘
 *   any active ──► cancel_requested ──► cancelled
 *                                   └─► succeeded (analysis finished first: results are kept)
 *   queued ──► cancelled (never started)
 */
export const ANALYSIS_JOB_STATUSES = [
  "queued",
  "claimed",
  "processing",
  "succeeded",
  "failed",
  "cancel_requested",
  "cancelled",
] as const;
export type AnalysisJobStatus = (typeof ANALYSIS_JOB_STATUSES)[number];

const TRANSITIONS: Record<AnalysisJobStatus, readonly AnalysisJobStatus[]> = {
  queued: ["claimed", "cancelled", "failed"],
  claimed: ["processing", "queued", "failed", "cancel_requested", "cancelled"],
  processing: ["succeeded", "failed", "queued", "cancel_requested"],
  cancel_requested: ["cancelled", "failed", "succeeded"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const ANALYSIS_TERMINAL: readonly AnalysisJobStatus[] = ["succeeded", "failed", "cancelled"];
export const ANALYSIS_ACTIVE: readonly AnalysisJobStatus[] = [
  "queued",
  "claimed",
  "processing",
  "cancel_requested",
];

export const isAnalysisTerminal = (s: AnalysisJobStatus) => ANALYSIS_TERMINAL.includes(s);
export const isAnalysisActive = (s: AnalysisJobStatus) => ANALYSIS_ACTIVE.includes(s);
export const canAnalysisTransition = (from: AnalysisJobStatus, to: AnalysisJobStatus) =>
  TRANSITIONS[from].includes(to);
export const allowedAnalysisTransitions = (from: AnalysisJobStatus) => TRANSITIONS[from];

export class IllegalAnalysisTransitionError extends Error {
  constructor(
    readonly from: AnalysisJobStatus,
    readonly to: AnalysisJobStatus,
  ) {
    super(`Illegal continuity analysis job transition: ${from} → ${to}`);
    this.name = "IllegalAnalysisTransitionError";
  }
}

export function assertAnalysisTransition(from: AnalysisJobStatus, to: AnalysisJobStatus): void {
  if (!canAnalysisTransition(from, to)) throw new IllegalAnalysisTransitionError(from, to);
}

export const ANALYSIS_STATUS_LABELS: Record<AnalysisJobStatus, string> = {
  queued: "Queued",
  claimed: "Starting",
  processing: "Analysing",
  succeeded: "Complete",
  failed: "Failed",
  cancel_requested: "Cancelling",
  cancelled: "Cancelled",
};

/** Provider interaction state: what we know about whether the paid request left the process. */
export const PROVIDER_STATES = ["not_sent", "sending", "responded"] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];
