import type { OutcomeRecord } from "./performance";

/**
 * Informational generation-model health (Phase 2E; the generation counterpart of Phase 2D's analyzer health).
 * Derived from real attempts only. It NEVER routes, disables or switches a paid model.
 */
export type ModelHealthState =
  | "not_configured"
  | "disabled"
  | "unavailable"
  | "rate_limited"
  | "recent_provider_failure"
  | "recent_success"
  | "configured";

export interface ModelHealth {
  state: ModelHealthState;
  note: string;
  recentFailures: number;
}

const PROVIDER_FAILURES = ["provider_unavailable", "timeout", "transient"];

export function generationModelHealth(args: {
  enabled: boolean;
  configured: boolean;
  /** retired / unavailable in the catalog */
  available: boolean;
  records: readonly OutcomeRecord[];
}): ModelHealth {
  if (!args.available) return { state: "unavailable", note: "retired or unavailable", recentFailures: 0 };
  if (!args.enabled) return { state: "disabled", note: "disabled on this server", recentFailures: 0 };
  if (!args.configured)
    return { state: "not_configured", note: "credentials not configured", recentFailures: 0 };
  const terminal = [...args.records]
    .filter((r) => r.status === "succeeded" || r.status === "failed")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recent = terminal.slice(0, 5);
  const failures = recent.filter((r) => r.status === "failed").length;
  const last = terminal[0];
  if (!last)
    return {
      state: "configured",
      note: "configured, no generations yet (availability unknown)",
      recentFailures: 0,
    };
  if (last.status === "failed") {
    const cat = last.errorCategory ?? "";
    if (cat === "rate_limit")
      return { state: "rate_limited", note: "last generation was rate limited", recentFailures: failures };
    if (PROVIDER_FAILURES.includes(cat))
      return {
        state: "recent_provider_failure",
        note: `last generation failed (${cat.replace(/_/g, " ")})`,
        recentFailures: failures,
      };
    return {
      state: "recent_provider_failure",
      note: `last generation failed${cat ? ` (${cat.replace(/_/g, " ")})` : ""}`,
      recentFailures: failures,
    };
  }
  return {
    state: "recent_success",
    note:
      failures > 0
        ? `last generation succeeded (${failures} failure(s) in the last 5)`
        : "last generation succeeded",
    recentFailures: failures,
  };
}
