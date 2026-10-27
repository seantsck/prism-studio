import type { ContinuityCategory, ContinuityResult, ContinuitySeverity } from "./model";
import type { StaleReasons } from "./status";

/**
 * Shot QA decision layer (Phase 3A.1). Pure, derived, never stored.
 *
 *   "Did the generated output produce the Shot we asked for, what specifically appears wrong, and what should the
 *    filmmaker review?"
 *
 * It reads ONE stored continuity run (its frozen findings, the human overrides, the frozen analysis plan) and the run's
 * freshness against current production truth, and answers in plain terms. Three concerns stay separate:
 *   generation status   did the provider return media?                (Attempt.status)
 *   Shot QA             does the media appear to satisfy production truth?   (this module, advisory)
 *   creative review     does the filmmaker accept it?                 (Attempt.reviewStatus, a person only)
 *
 * There is no score. Nothing here approves, rejects, selects or changes any creative state; a rejection SUGGESTION is
 * text a person may choose to use.
 */

export const SHOT_QA_STATES = [
  "no_qa",
  "qa_stale",
  "critical_mismatch",
  "analysis_running",
  "needs_attention",
  "incomplete",
  "no_blocking_mismatch",
] as const;
export type ShotQaState = (typeof SHOT_QA_STATES)[number];

export const SHOT_QA_LABELS: Record<ShotQaState, string> = {
  no_qa: "No QA yet",
  qa_stale: "QA stale",
  critical_mismatch: "Critical mismatch",
  analysis_running: "QA running",
  needs_attention: "Needs attention",
  incomplete: "Incomplete",
  no_blocking_mismatch: "No blocking mismatch found",
};

export const SHOT_QA_AUTHORITY_NOTE =
  "Shot QA is advice. It never approves or rejects an output: you decide, and a suggestion is only used if you choose it.";

export interface ShotQaOverrideInput {
  result: ContinuityResult;
  notes: string;
  createdAt: string;
  createdBy: string | null;
}

/** One stored finding with its override history (structurally a `ContinuityFinding` + its overrides). */
export interface ShotQaFindingInput {
  id: string;
  criterionKey: string;
  category: ContinuityCategory;
  severity: ContinuitySeverity;
  title: string;
  sourceRef: string;
  expected: string;
  actual: string;
  result: ContinuityResult;
  resultSource: "deterministic" | "analyzer" | "none";
  confidence: number | null;
  notes: string;
  evidence: Record<string, unknown>;
  position: number;
  overrides: ShotQaOverrideInput[];
}

export interface ShotQaRunInput {
  id: string;
  runNumber: number;
  analysisStatus: "queued" | "running" | "complete" | "failed";
  analyzerKind: string;
  /** The run's frozen analysis plan items (why a criterion was not analysed); empty before Phase 2D. */
  planItems: Array<{ criterionKey: string; status: string; reason: string }>;
}

export interface ShotQaEvidenceItem {
  input: string;
  assetId: string | null;
  atMs: number | null;
  observation: string;
  source: string;
}

export type ShotQaIssueKind = "fail" | "warn" | "unchecked";

export interface ShotQaIssue {
  findingId: string;
  criterionKey: string;
  category: ContinuityCategory;
  severity: ContinuitySeverity;
  kind: ShotQaIssueKind;
  /** The effective result (a person's latest decision, else the system's). */
  result: ContinuityResult;
  systemResult: ContinuityResult;
  resultSource: ShotQaFindingInput["resultSource"];
  override: ShotQaOverrideInput | null;
  title: string;
  sourceRef: string;
  expected: string;
  /** What the deterministic check / analyzer reported, verbatim ("" when nobody judged it). Never invented. */
  observed: string;
  confidence: number | null;
  evidence: ShotQaEvidenceItem[];
  contradictions: string[];
  limitations: string[];
  /** Why nobody judged it (the frozen plan's reason), for unchecked issues. */
  uncheckedReason: string | null;
  position: number;
  /** 0 critical fail · 1 major fail · 2 minor fail · 3 critical/major warning · 4 minor warning · 5 important unchecked · 6 other unchecked */
  priority: number;
}

export interface RejectionSuggestion {
  findingId: string;
  criterionKey: string;
  severity: ContinuitySeverity;
  result: "fail" | "warn";
  /** Deterministic text composed from the finding's own fields (never a model's prose). */
  text: string;
  /** The effective result came from a person's override. */
  fromOverride: boolean;
}

export interface ShotQaAssessment {
  state: ShotQaState;
  label: string;
  /** One plain sentence answering "did Prism find a mismatch?". */
  headline: string;
  run: {
    id: string;
    runNumber: number;
    analysisStatus: ShotQaRunInput["analysisStatus"];
    analyzerKind: string;
  } | null;
  /** null: the run's freshness could not be computed (no current production truth to compare with). */
  freshness: StaleReasons | null;
  counts: {
    total: number;
    evaluated: number;
    criticalFailures: number;
    majorFailures: number;
    minorFailures: number;
    warnings: number;
    unchecked: number;
    /** Critical or major criteria nobody has judged. */
    importantUnchecked: number;
    notApplicable: number;
    overridden: number;
  };
  /** The most severe problem (a fail or a warning) after overrides; null when there is none. */
  highestProblemSeverity: ContinuitySeverity | null;
  /** At least one person's decision differs from what the system concluded. */
  overridesChangedResult: boolean;
  /** Every fail, warning and unchecked criterion, in deterministic priority order. */
  issues: ShotQaIssue[];
  /** Withheld (empty) while the run is stale: an old finding is not evidence about the current Shot. */
  suggestedRejectionReasons: RejectionSuggestion[];
}

export const NO_SHOT_QA: ShotQaAssessment = {
  state: "no_qa",
  label: SHOT_QA_LABELS.no_qa,
  headline: "Prism has not checked this output against production truth yet.",
  run: null,
  freshness: null,
  counts: {
    total: 0,
    evaluated: 0,
    criticalFailures: 0,
    majorFailures: 0,
    minorFailures: 0,
    warnings: 0,
    unchecked: 0,
    importantUnchecked: 0,
    notApplicable: 0,
    overridden: 0,
  },
  highestProblemSeverity: null,
  overridesChangedResult: false,
  issues: [],
  suggestedRejectionReasons: [],
};

const important = (s: ContinuitySeverity) => s === "critical" || s === "major";

function priorityOf(result: ContinuityResult, severity: ContinuitySeverity): number | null {
  if (result === "fail") return severity === "critical" ? 0 : severity === "major" ? 1 : 2;
  if (result === "warn") return important(severity) ? 3 : 4;
  if (result === "unchecked") return important(severity) ? 5 : 6;
  return null;
}

const latestOverride = (xs: ShotQaOverrideInput[]) =>
  [...xs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function evidenceItems(ev: Record<string, unknown>): ShotQaEvidenceItem[] {
  const items = Array.isArray(ev.items) ? (ev.items as Array<Record<string, unknown>>) : [];
  return items.map((it) => ({
    input: typeof it.input === "string" ? it.input : "",
    assetId: typeof it.assetId === "string" ? it.assetId : null,
    atMs: typeof it.atMs === "number" ? it.atMs : null,
    observation: typeof it.observation === "string" ? it.observation : "",
    source: typeof it.source === "string" ? it.source : "",
  }));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The decision projection of one stored run (or of none). Same inputs ⇒ same assessment. */
export function assessShotQa(args: {
  run: ShotQaRunInput | null;
  findings: ShotQaFindingInput[];
  freshness: StaleReasons | null;
}): ShotQaAssessment {
  const { run, freshness } = args;
  if (!run) return NO_SHOT_QA;

  const planReason = new Map(run.planItems.map((i) => [i.criterionKey, i] as const));
  const effective = args.findings.map((f) => {
    const override = latestOverride(f.overrides);
    return { f, override, result: override?.result ?? f.result };
  });

  const issues: ShotQaIssue[] = [];
  for (const { f, override, result } of effective) {
    const priority = priorityOf(result, f.severity);
    if (priority === null) continue;
    const plan = planReason.get(f.criterionKey);
    issues.push({
      findingId: f.id,
      criterionKey: f.criterionKey,
      category: f.category,
      severity: f.severity,
      kind: result as ShotQaIssueKind,
      result,
      systemResult: f.result,
      resultSource: f.resultSource,
      override,
      title: f.title,
      sourceRef: f.sourceRef,
      expected: f.expected,
      observed: f.actual,
      confidence: f.confidence,
      evidence: evidenceItems(f.evidence),
      contradictions: strings(f.evidence.contradictions),
      limitations: strings(f.evidence.limitations),
      uncheckedReason:
        result === "unchecked"
          ? plan && plan.status !== "planned"
            ? plan.reason
            : f.resultSource === "none"
              ? "Nobody has judged this criterion yet."
              : f.notes || null
          : null,
      position: f.position,
      priority,
    });
  }
  // deterministic: priority band, then the criterion's frozen position, then its key
  issues.sort(
    (a, b) =>
      a.priority - b.priority || a.position - b.position || a.criterionKey.localeCompare(b.criterionKey),
  );

  const count = (r: ContinuityResult) => effective.filter((e) => e.result === r).length;
  const failBy = (s: ContinuitySeverity) =>
    effective.filter((e) => e.result === "fail" && e.f.severity === s).length;
  const counts = {
    total: effective.length,
    evaluated: count("pass") + count("warn") + count("fail"),
    criticalFailures: failBy("critical"),
    majorFailures: failBy("major"),
    minorFailures: failBy("minor"),
    warnings: count("warn"),
    unchecked: count("unchecked"),
    importantUnchecked: effective.filter((e) => e.result === "unchecked" && important(e.f.severity)).length,
    notApplicable: count("n_a"),
    overridden: effective.filter((e) => e.override !== null).length,
  };
  const problems = issues.filter((i) => i.kind !== "unchecked");
  const highestProblemSeverity = problems.length
    ? (["critical", "major", "minor"] as const).find((s) => problems.some((p) => p.severity === s))!
    : null;
  const stale = freshness?.stale ?? false;
  const running = run.analysisStatus === "queued" || run.analysisStatus === "running";
  const failures = counts.criticalFailures + counts.majorFailures + counts.minorFailures;

  const state: ShotQaState = stale
    ? "qa_stale"
    : counts.criticalFailures > 0
      ? "critical_mismatch"
      : running
        ? "analysis_running"
        : failures > 0 || counts.warnings > 0
          ? "needs_attention"
          : counts.importantUnchecked > 0
            ? "incomplete"
            : "no_blocking_mismatch";

  const headline = (() => {
    switch (state) {
      case "qa_stale":
        return `This QA run no longer describes the current Shot: ${freshness!.reasons[0] ?? "production truth changed"} Run QA again before relying on it.`;
      case "critical_mismatch":
        return `Prism found ${plural(counts.criticalFailures, "critical mismatch", "critical mismatches")} with production truth.`;
      case "analysis_running":
        return "Analysis is still running: what is shown so far is partial.";
      case "needs_attention":
        return `Prism found ${[
          failures ? plural(failures, "mismatch", "mismatches") : "",
          counts.warnings ? plural(counts.warnings, "warning") : "",
        ]
          .filter(Boolean)
          .join(" and ")} to review; no critical mismatch.`;
      case "incomplete":
        return `No mismatch found so far, but ${plural(counts.importantUnchecked, "important criterion", "important criteria")} ${counts.importantUnchecked === 1 ? "is" : "are"} unchecked${run.analysisStatus === "failed" ? " (the analysis failed)" : ""}.`;
      case "no_blocking_mismatch":
        return `No blocking mismatch found in the ${plural(counts.evaluated, "evaluated criterion", "evaluated criteria")}. This is not a creative approval.`;
      default:
        return NO_SHOT_QA.headline;
    }
  })();

  return {
    state,
    label: SHOT_QA_LABELS[state],
    headline,
    run: {
      id: run.id,
      runNumber: run.runNumber,
      analysisStatus: run.analysisStatus,
      analyzerKind: run.analyzerKind,
    },
    freshness,
    counts,
    highestProblemSeverity,
    overridesChangedResult: effective.some((e) => e.override !== null && e.override.result !== e.f.result),
    issues,
    suggestedRejectionReasons: stale ? [] : suggestRejectionReasons(issues),
  };
}

// ───────────────────────── rejection-reason suggestions ─────────────────────────

/** Every effective FAIL, and every critical / major WARNING, in issue priority order. Never from an unchecked one. */
export function suggestRejectionReasons(issues: ShotQaIssue[]): RejectionSuggestion[] {
  return issues
    .filter((i) => i.kind === "fail" || (i.kind === "warn" && important(i.severity)))
    .map((i) => ({
      findingId: i.findingId,
      criterionKey: i.criterionKey,
      severity: i.severity,
      result: i.kind as "fail" | "warn",
      text: rejectionReasonText(i),
      fromOverride: i.override !== null && i.override.result !== i.systemResult,
    }));
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const sentence = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);
const subjectOf = (title: string) => title.split(" — ")[0]!.trim();
const tailOf = (title: string) => title.split(" — ").slice(1).join(" — ").trim();
const absent = (expected: string) => expected.replace(/^Absent:\s*/, "").trim();

const DETERMINISTIC_KEYS = new Set([
  "output",
  "duration",
  "aspect_ratio",
  "resolution",
  "fps",
  "container",
  "audio_stream",
  "delivery_master",
]);

/** The production expectation in one sentence, composed from the finding's own frozen fields. */
function expectationSentence(i: ShotQaIssue): string {
  const [kind] = i.criterionKey.split(":");
  const name = subjectOf(i.title);
  const lock = /Character Continuity Lock "([^"]+)"/.exec(i.sourceRef)?.[1] ?? null;
  const look = /Look "([^"]+)"/.exec(i.sourceRef)?.[1] ?? null;
  const lockedLook = /Look "[^"]+" \(locked\)/.test(i.sourceRef);
  const version = /Production Frame (v\d+)/.exec(i.title)?.[1] ?? "";
  switch (kind) {
    case "identity":
      return lock
        ? `${name}'s identity does not match the locked Character reference "${lock}".`
        : `${name}'s identity does not match ${name}'s identity references.`;
    case "wardrobe":
      return look
        ? `${name}'s wardrobe differs from the ${lockedLook ? "locked " : ""}Look "${look}".`
        : `${name}'s wardrobe differs from "${clip(i.expected, 80)}".`;
    case "hair":
    case "makeup":
    case "jewelry":
      return `${name}'s ${kind} differs from ${look ? `the Look "${look}"` : "the Look"} (expected: ${clip(i.expected, 80)}).`;
    case "production_frame":
      return i.title.startsWith("Opening image")
        ? `The opening image does not preserve Production Frame ${version}.`
        : `The Shot does not preserve the visual intent of Production Frame ${version}.`;
    case "location_view":
      return `The generated set does not match the selected Location View "${tailOf(i.title)}".`;
    case "location_set":
      return `The set does not match ${tailOf(i.title) || "the Shot's Location"}.`;
    case "forbiddenObjects":
      return `The Shot contains a forbidden object: ${absent(i.expected)}.`;
    case "forbiddenPeople":
      return `The Shot shows a forbidden person: ${absent(i.expected)}.`;
    case "forbiddenActions":
      return `The Shot shows a forbidden action: ${absent(i.expected)}.`;
    case "character_count":
      return `The visible character count differs from the expected ${i.expected}.`;
    case "prop":
      return `The prop "${tailOf(i.title)}" is missing or wrong (expected: ${clip(i.expected, 80)}).`;
    case "camera_framing":
      return `Camera framing differs from "${clip(i.expected, 80)}".`;
    case "camera_movement":
      return `Camera movement differs from "${clip(i.expected, 80)}".`;
    default:
      if (DETERMINISTIC_KEYS.has(kind!))
        return `${i.title}: expected ${i.expected}${i.observed ? `, got ${clip(i.observed, 80)}` : ""}.`;
      return `${i.title} does not match "${clip(i.expected, 100)}".`;
  }
}

/** Deterministic rejection-reason text: expectation + (when it supports the result) the recorded observation. */
export function rejectionReasonText(i: ShotQaIssue): string {
  let text = expectationSentence(i);
  if (i.kind === "warn") text = `Possibly: ${text}`;
  const [kind] = i.criterionKey.split(":");
  const humanChanged = i.override !== null && i.override.result !== i.systemResult;
  // the analyzer's observation is quoted only when it supports the effective result (never against a reviewer)
  if (!humanChanged && i.observed && i.resultSource === "analyzer" && !DETERMINISTIC_KEYS.has(kind!))
    text = `${text} Observed: ${sentence(clip(i.observed, 160))}`;
  if (humanChanged && i.override!.notes.trim())
    text = `${text} Reviewer: ${sentence(clip(i.override!.notes, 160))}`;
  return text;
}
