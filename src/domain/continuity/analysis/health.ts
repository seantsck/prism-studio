import type { AnalysisErrorCategory } from "./types";

/**
 * Minimal provider health (Phase 2D.1). Pure and informational: it is shown next to the analyzer picker and
 * NEVER routes, retries or disables anything. History is never erased: a past provider failure stays visible
 * until a later analysis from the same provider succeeds.
 *
 *   disabled                 not listed in PRISM_STUDIO_CONTINUITY_ANALYZERS
 *   not_configured           listed, but missing a credential or using an unsupported model
 *   configured               ready; no analysis history yet (availability unknown)
 *   available                ready, and the most recent finished analysis succeeded
 *   recent_provider_failure  ready, and the most recent finished analysis failed on the provider side
 */
export type ProviderHealthState =
  "disabled" | "not_configured" | "configured" | "available" | "recent_provider_failure";

export interface ProviderHealth {
  state: ProviderHealthState;
  /** Provider-side failures in the supplied history (all of it, not only the latest). */
  failures: number;
  lastFailureCategory: AnalysisErrorCategory | null;
  note: string;
}

/** Failures that say something about the PROVIDER's availability (not about this project's input or policy). */
export const PROVIDER_FAILURE_CATEGORIES: readonly AnalysisErrorCategory[] = [
  "overloaded",
  "rate_limit",
  "server_error",
  "timeout",
  "network",
  "outcome_unknown",
  "provider_overloaded_retry_exhausted",
];

export interface HealthJob {
  analyzer: string;
  status: string;
  lastErrorCategory: AnalysisErrorCategory | null;
  /** ISO time the job finished (failed/succeeded); null while active. */
  finishedAt: string | null;
}

const LABEL: Partial<Record<AnalysisErrorCategory, string>> = {
  overloaded: "overload (503)",
  rate_limit: "rate limit (429)",
  provider_overloaded_retry_exhausted: "overload, retries exhausted",
  server_error: "server error",
  timeout: "timeout",
  network: "network error",
  outcome_unknown: "unknown outcome",
};

export function providerHealth(args: {
  providerId: string;
  /** From the registry: configured | missing_credential | disabled | unsupported_model */
  configState: string;
  jobs: readonly HealthJob[];
}): ProviderHealth {
  const mine = args.jobs
    .filter((j) => j.analyzer === args.providerId && (j.status === "failed" || j.status === "succeeded"))
    .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
  const failed = mine.filter(
    (j) =>
      j.status === "failed" &&
      j.lastErrorCategory &&
      PROVIDER_FAILURE_CATEGORIES.includes(j.lastErrorCategory),
  );
  const last = mine.at(-1) ?? null;
  const lastFailure = failed.at(-1) ?? null;
  const base = { failures: failed.length, lastFailureCategory: lastFailure?.lastErrorCategory ?? null };

  if (args.configState === "disabled") return { ...base, state: "disabled", note: "disabled on this server" };
  if (args.configState !== "configured")
    return {
      ...base,
      state: "not_configured",
      note: args.configState === "unsupported_model" ? "unsupported model" : "not configured",
    };
  if (
    last &&
    last.status === "failed" &&
    last.lastErrorCategory &&
    PROVIDER_FAILURE_CATEGORIES.includes(last.lastErrorCategory)
  ) {
    const what = LABEL[last.lastErrorCategory] ?? last.lastErrorCategory;
    return {
      ...base,
      state: "recent_provider_failure",
      note: `configured, recent failure: ${what}${failed.length > 1 ? ` (${failed.length} in history)` : ""}`,
    };
  }
  if (last && last.status === "succeeded") {
    return {
      ...base,
      state: "available",
      note: failed.length
        ? `configured, last analysis succeeded (${failed.length} earlier failure(s))`
        : "configured, last analysis succeeded",
    };
  }
  return {
    ...base,
    state: "configured",
    note: failed.length
      ? `configured (${failed.length} earlier provider failure(s))`
      : "configured, no analysis history",
  };
}
