import type { GenerationAttempt } from "../schemas";
import type { JobStatus } from "./schemas";

/** The attempt's execution status mirrors its job's phase. Review is stored separately. */
export function attemptStatusForJob(status: JobStatus): GenerationAttempt["status"] {
  switch (status) {
    case "queued":
      return "queued";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}
