import type { GenerationAttempt } from "../schemas";
import type { GenerationJob } from "./schemas";
import { isActive } from "./job-state";

/**
 * The shot's generation lifecycle, DERIVED from three independent state machines. Nothing here is stored:
 *   prep state      (preflight readiness)
 *   execution state (latest job)
 *   review state    (attempt review)
 * so a stale cached "status" can never contradict the evidence.
 */
export type ShotGenerationState =
  "not_ready" | "ready" | "queued" | "generating" | "ready_for_review" | "approved" | "needs_redo";

export const SHOT_GENERATION_LABELS: Record<ShotGenerationState, string> = {
  not_ready: "NOT READY",
  ready: "READY",
  queued: "QUEUED",
  generating: "GENERATING",
  ready_for_review: "READY FOR REVIEW",
  approved: "APPROVED",
  needs_redo: "NEEDS REDO",
};

export interface LifecycleInput {
  ready: boolean;
  attempts: Array<Pick<GenerationAttempt, "id" | "attemptNumber" | "status" | "reviewStatus" | "approved">>;
  jobs: Array<Pick<GenerationJob, "attemptId" | "status">>;
}

export function deriveShotGenerationState(input: LifecycleInput): ShotGenerationState {
  if (input.attempts.some((a) => a.approved || a.reviewStatus === "approved")) return "approved";

  const activeJob = input.jobs.find((j) => isActive(j.status));
  if (activeJob) return activeJob.status === "queued" ? "queued" : "generating";

  const latest = [...input.attempts].sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
  if (latest) {
    if (latest.status === "succeeded" && latest.reviewStatus === "unreviewed") return "ready_for_review";
    if (latest.reviewStatus === "rejected" || latest.status === "failed" || latest.status === "cancelled") {
      return "needs_redo";
    }
  }
  return input.ready ? "ready" : "not_ready";
}
