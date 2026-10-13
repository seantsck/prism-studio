import type { JobStatus } from "./schemas";

/**
 * Job lifecycle. Statuses are PHASES of work, not claims: "someone is working on it right now" is a
 * lease (lease_owner/lease_token/lease_expires_at), so one mechanism covers submit, poll and ingest.
 *
 *   queued ──► submitting ──► submitted ──► processing ──► ingesting ──► succeeded
 *      ▲            │              │            │             │
 *      └─ retry ────┘              └────────────┴──► failed ◄─┘
 *   any active ──► cancel_requested ──► cancelled
 *                                   └──► ingesting (provider completed first: output is preserved)
 *   queued ──► cancelled (never reached a provider)
 */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["submitting", "cancelled", "cancel_requested", "failed"],
  // submitting may skip straight ahead for fast / synchronous providers; transient submit errors re-queue.
  submitting: ["submitted", "processing", "ingesting", "queued", "failed", "cancel_requested", "cancelled"],
  submitted: ["processing", "ingesting", "failed", "cancel_requested"],
  processing: ["ingesting", "failed", "cancel_requested"],
  // ingesting may re-queue itself via the lease; a hard failure ends the job.
  ingesting: ["succeeded", "failed", "cancel_requested"],
  succeeded: [],
  failed: [],
  // "ingesting": the provider finished before the cancellation took effect; the paid output is kept.
  cancel_requested: ["cancelled", "failed", "ingesting"],
  cancelled: [],
};

export const TERMINAL_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "cancelled"];
export const ACTIVE_STATUSES: readonly JobStatus[] = [
  "queued",
  "submitting",
  "submitted",
  "processing",
  "ingesting",
  "cancel_requested",
];
/** Statuses a worker may pick up when `next_run_at` is due and no live lease exists. */
export const WORKABLE_STATUSES: readonly JobStatus[] = [
  "queued",
  "submitting", // lease expired mid-submit: re-run submit (idempotency key protects against duplicates)
  "submitted",
  "processing",
  "ingesting",
  "cancel_requested",
];

export const isTerminal = (s: JobStatus) => TERMINAL_STATUSES.includes(s);
export const isActive = (s: JobStatus) => ACTIVE_STATUSES.includes(s);

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
  ) {
    super(`Illegal generation job transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function allowedTransitions(from: JobStatus): readonly JobStatus[] {
  return TRANSITIONS[from];
}

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  submitting: "Submitting",
  submitted: "Submitted",
  processing: "Generating",
  ingesting: "Saving output",
  succeeded: "Complete",
  failed: "Failed",
  cancel_requested: "Cancelling",
  cancelled: "Cancelled",
};
