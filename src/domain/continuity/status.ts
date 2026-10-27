import {
  type ReferenceItem,
  type ContinuityCategory,
  type ContinuityResult,
  type ContinuitySeverity,
  CONTINUITY_SEVERITIES,
} from "./model";

/** What the review UI and the dashboard need to know about one finding after human overrides. */
export interface EffectiveFinding {
  id: string;
  criterionKey: string;
  category: ContinuityCategory;
  severity: ContinuitySeverity;
  /** What the system (deterministic check / analyzer) concluded. */
  systemResult: ContinuityResult;
  /** The latest human decision, when one exists. Explicit and preserved: never silently merged. */
  override: { result: ContinuityResult; notes: string; createdAt: string; createdBy: string | null } | null;
  /** override?.result ?? systemResult */
  result: ContinuityResult;
}

export function effective(
  f: Omit<EffectiveFinding, "override" | "result"> & { systemResult: ContinuityResult },
  overrides: Array<{ result: ContinuityResult; notes: string; createdAt: string; createdBy: string | null }>,
): EffectiveFinding {
  const latest = [...overrides].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  return { ...f, override: latest, result: latest?.result ?? f.systemResult };
}

export interface ContinuitySummary {
  total: number;
  /** pass + warn + fail (a criterion somebody or something actually judged). */
  evaluated: number;
  passed: number;
  warnings: number;
  failed: number;
  notApplicable: number;
  unchecked: number;
  criticalFailures: number;
  majorFailures: number;
  minorFailures: number;
  /** Findings whose effective result came from a person. */
  overridden: number;
  /** "8/12" — passed of evaluated; an explicit sentence, never one opaque number. */
  passedOfEvaluated: string;
}

export function summarize(findings: EffectiveFinding[]): ContinuitySummary {
  const count = (r: ContinuityResult) => findings.filter((f) => f.result === r).length;
  const failBy = (s: ContinuitySeverity) =>
    findings.filter((f) => f.result === "fail" && f.severity === s).length;
  const passed = count("pass");
  const warnings = count("warn");
  const failed = count("fail");
  const evaluated = passed + warnings + failed;
  return {
    total: findings.length,
    evaluated,
    passed,
    warnings,
    failed,
    notApplicable: count("n_a"),
    unchecked: count("unchecked"),
    criticalFailures: failBy("critical"),
    majorFailures: failBy("major"),
    minorFailures: failBy("minor"),
    overridden: findings.filter((f) => f.override !== null).length,
    passedOfEvaluated: `${passed}/${evaluated}`,
  };
}

export const QA_STATUSES = ["not_started", "in_review", "passed", "passed_with_warnings", "failed"] as const;
export type QaStatus = (typeof QA_STATUSES)[number];

export const QA_STATUS_LABELS: Record<QaStatus, string> = {
  not_started: "QA not started",
  in_review: "QA in review",
  passed: "QA passed",
  passed_with_warnings: "QA passed with warnings",
  failed: "QA failed",
};

/**
 * Separate from generation success AND from creative approval. A run is `in_review` until a person closes
 * it; closing it yields passed / passed_with_warnings / failed from the EFFECTIVE results.
 *   - any critical FAIL            → failed (it is never "continuity approved"; nothing is auto-rejected)
 *   - any other fail/warn/unchecked → passed_with_warnings (the reviewer accepted them, and it is recorded)
 *   - otherwise                    → passed
 */
export function qaStatus(args: {
  hasRun: boolean;
  analysisComplete: boolean;
  finalized: boolean;
  summary: ContinuitySummary | null;
}): QaStatus {
  if (!args.hasRun) return "not_started";
  if (!args.finalized || !args.summary || !args.analysisComplete) return "in_review";
  const s = args.summary;
  if (s.criticalFailures > 0) return "failed";
  if (s.failed > 0 || s.warnings > 0 || s.unchecked > 0) return "passed_with_warnings";
  return "passed";
}

/** Transparent aggregation line for the UI: nothing hidden behind a score. */
export function describeSummary(s: ContinuitySummary, analyzerKind: "mock" | "model" | "none"): string[] {
  const lines = [
    `Critical failures: ${s.criticalFailures}`,
    `Passed: ${s.passedOfEvaluated} evaluated`,
    `Warnings: ${s.warnings} · Failures: ${s.failed} (major ${s.majorFailures}, minor ${s.minorFailures})`,
    `Unchecked: ${s.unchecked} · Not applicable: ${s.notApplicable}`,
  ];
  lines.push(
    analyzerKind === "model"
      ? "Semantic analysis: completed by a model analyzer (advisory)."
      : analyzerKind === "mock"
        ? "Semantic analysis: MOCK ANALYSIS only (no real visual comparison)."
        : "Continuity confidence: not available until a semantic analyzer runs.",
  );
  return lines;
}

// ───────────────────────── freshness ─────────────────────────

export interface StaleReasons {
  stale: boolean;
  reasons: string[];
}

interface FreshnessSide {
  subjectFingerprint: string;
  criteriaFingerprint: string;
  referenceFingerprint: string;
  packageFingerprint: string;
  /** 3A.1 (optional): the rules version and frozen reference items, used only to say WHY a run went stale. */
  rulesVersion?: string;
  references?: ReferenceItem[];
}

const REFERENCE_ROLE_LABELS: Record<string, string> = {
  production_frame: "The Production Frame",
  location_view: "The Location View",
  identity: "A Character identity reference",
  look: "A Look / Character Continuity Lock image",
  storyboard: "The approved storyboard frame",
  location: "A Location reference image",
  lighting: "The lighting reference",
  reference: "A Shot reference image",
  previous_shot: "The previous Shot's approved output",
  next_shot: "The next Shot's storyboard frame",
  performance: "A selected performance take",
  constraint: "The production constraints",
  framing: "The delivery framing",
};

/** Which reference roles differ between two frozen reference sets (stable order: first seen). */
function changedReferenceRoles(before: ReferenceItem[], after: ReferenceItem[]): string[] {
  const key = (i: ReferenceItem) => `${i.assetId ?? ""}|${i.checksum ?? ""}|${i.text ?? ""}`;
  const byRole = (xs: ReferenceItem[]) => {
    const m = new Map<string, string[]>();
    for (const i of xs) m.set(i.role, [...(m.get(i.role) ?? []), key(i)].sort());
    return m;
  };
  const a = byRole(before);
  const b = byRole(after);
  const roles = [...new Set([...a.keys(), ...b.keys()])];
  return roles.filter((r) => JSON.stringify(a.get(r) ?? []) !== JSON.stringify(b.get(r) ?? []));
}

/** A run never changes. It is merely compared with what is true NOW. */
export function staleness(run: FreshnessSide, current: FreshnessSide): StaleReasons {
  const reasons: string[] = [];
  if (run.subjectFingerprint !== current.subjectFingerprint)
    reasons.push("The output or its delivery conform changed after this run.");
  if (run.criteriaFingerprint !== current.criteriaFingerprint) {
    reasons.push(
      run.rulesVersion && current.rulesVersion && run.rulesVersion !== current.rulesVersion
        ? `Prism's QA criteria changed after this run (rules ${run.rulesVersion} → ${current.rulesVersion}), or production truth (what is expected) changed.`
        : "Production truth (what is expected) changed after this run.",
    );
  }
  if (run.referenceFingerprint !== current.referenceFingerprint) {
    const roles =
      run.references && current.references ? changedReferenceRoles(run.references, current.references) : [];
    // the Shot moved on from the frozen Production Frame / Location View: say exactly how
    const moved = roles.includes("selection_change")
      ? (current.references ?? [])
          .filter((i) => i.role === "selection_change")
          .flatMap((i) => (i.text ?? "").split("\n").filter(Boolean))
      : [];
    const named = roles
      .filter((r) => r !== "selection_change")
      .map((r) => REFERENCE_ROLE_LABELS[r] ?? `A ${r} reference`);
    for (const n of named) reasons.push(`${n} changed after this run.`);
    reasons.push(...moved);
    if (named.length === 0 && moved.length === 0)
      reasons.push("A reference (identity, Look, storyboard, location...) changed after this run.");
  }
  return { stale: reasons.length > 0, reasons };
}

// ───────────────────────── advisories ─────────────────────────

/**
 * What the approval UI says before a person approves an output. Advice only: the human stays authoritative
 * and nothing here blocks the approval.
 */
export function approvalAdvisories(args: {
  status: QaStatus;
  stale: boolean;
  summary: ContinuitySummary | null;
}): string[] {
  const out: string[] = [];
  if (args.status === "not_started") out.push("Continuity QA has not been run for this output.");
  if (args.stale)
    out.push("Continuity QA is stale: production truth or the output changed since it was run.");
  if (args.summary && args.summary.criticalFailures > 0) {
    out.push(`${args.summary.criticalFailures} critical continuity failure(s) are recorded.`);
  }
  if (args.status === "in_review") out.push("Continuity review has not been closed.");
  return out;
}

export const SEVERITY_LABELS: Record<ContinuitySeverity, string> = {
  critical: "Critical",
  major: "Major",
  minor: "Minor",
};
export { CONTINUITY_SEVERITIES };
