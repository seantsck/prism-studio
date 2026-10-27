import { describe, expect, it } from "vitest";
import type { ContinuityResult, ContinuitySeverity } from "@/domain/continuity/model";
import {
  assessShotQa,
  NO_SHOT_QA,
  rejectionReasonText,
  SHOT_QA_LABELS,
  SHOT_QA_STATES,
  type ShotQaAssessment,
  type ShotQaFindingInput,
  type ShotQaRunInput,
} from "@/domain/continuity/shot-qa";

/**
 * Phase 3A.1 Shot QA decision projection: one focused matrix. Pure fixtures shaped like stored findings (Phase 2C/2D
 * rows + overrides); no repository, no analyzer, no provider.
 */

const RUN: ShotQaRunInput = {
  id: "run-1",
  runNumber: 1,
  analysisStatus: "complete",
  analyzerKind: "model",
  planItems: [
    {
      criterionKey: "camera_movement",
      status: "unsupported",
      reason: "Needs direct-video analysis, which is not enabled. Stays unchecked.",
    },
    {
      criterionKey: "eyelines",
      status: "unsupported",
      reason: "Needs direct-video analysis, which is not enabled. Stays unchecked.",
    },
  ],
};
const FRESH = { stale: false, reasons: [] };

let n = 0;
function finding(
  criterionKey: string,
  severity: ContinuitySeverity,
  result: ContinuityResult,
  o: Partial<ShotQaFindingInput> = {},
): ShotQaFindingInput {
  n += 1;
  return {
    id: `f-${criterionKey}`,
    criterionKey,
    category: "other",
    severity,
    title: criterionKey,
    sourceRef: "Shot continuity",
    expected: "expected value",
    actual: "",
    result,
    resultSource: result === "unchecked" ? "none" : "analyzer",
    confidence: result === "unchecked" ? null : 0.8,
    notes: "",
    evidence: {},
    position: n,
    overrides: [],
    ...o,
  };
}

const YUMEKO_ID = finding("identity:yumeko", "critical", "fail", {
  category: "identity",
  title: "Yumeko — identity",
  sourceRef: 'Character identity references (2) · Character Continuity Lock "Yumeko — evening"',
  expected: "Late twenties, sharp jawline, long black hair",
  actual: "The face in the output has a rounder jaw and short hair.",
  evidence: {
    items: [
      {
        input: "frame:2500",
        assetId: "frame-asset",
        atMs: 2500,
        observation: "short hair",
        source: "output_frame",
      },
    ],
    contradictions: ["Hair length contradicts the locked reference."],
    limitations: ["Face partly in shadow."],
  },
});
const WARDROBE = finding("wardrobe:yumeko", "critical", "fail", {
  category: "wardrobe",
  title: "Yumeko — wardrobe",
  sourceRef: 'Look "Black Evening" (locked) · Character Continuity Lock "Yumeko — evening"',
  expected: "black evening gown",
  actual: "A red cocktail dress.",
});
const PF_OPENING = finding("production_frame", "critical", "fail", {
  category: "composition",
  title: "Opening image — Production Frame v3",
  sourceRef: "Production Frame v3 (the exact first frame of this attempt, frozen in its package)",
  actual: "The opening frame is a wider shot from the opposite side.",
});
const VIEW = finding("location_view", "major", "fail", {
  category: "location_set",
  title: "Location View — Doorway",
  actual: "An outdoor street, not the hotel doorway.",
});
const UMBRELLA = finding("forbiddenObjects:0", "major", "fail", {
  category: "props",
  title: "Must not appear: red umbrella",
  expected: "Absent: red umbrella",
  actual: "A red umbrella is visible at the left edge.",
});
const LIGHT_WARN = finding("lighting", "minor", "warn", {
  category: "lighting",
  title: "Lighting",
  expected: "warm key from the left",
});
const COUNT_WARN = finding("character_count", "major", "warn", {
  category: "character_count",
  title: "Visible character count",
  expected: "2",
});
const PROP_FAIL = finding("prop:fan", "minor", "fail", {
  category: "props",
  title: "Prop — Folding fan",
  expected: "black lace fan",
});
const MOVE_UNCHECKED = finding("camera_movement", "minor", "unchecked", {
  category: "camera",
  title: "Camera movement",
});
const EYELINE_UNCHECKED = finding("eyelines", "major", "unchecked", {
  category: "eyelines",
  title: "Eyelines",
});
const PASS = (k: string, s: ContinuitySeverity = "minor") => finding(k, s, "pass");
const DURATION_PASS = finding("duration", "major", "pass", {
  resultSource: "deterministic",
  expected: "4.5s",
  actual: "4.5s",
});

const assess = (
  findings: ShotQaFindingInput[],
  o: { run?: Partial<ShotQaRunInput>; stale?: string[] } = {},
) =>
  assessShotQa({
    run: { ...RUN, ...o.run },
    findings,
    freshness: o.stale ? { stale: true, reasons: o.stale } : FRESH,
  });

const override = (result: ContinuityResult, notes = "", createdAt = "2026-10-27T10:00:00Z") => ({
  result,
  notes,
  createdAt,
  createdBy: "user-1",
});

describe("Shot QA assessment states (advisory; never approval)", () => {
  it("no run → No QA yet", () => {
    expect(assessShotQa({ run: null, findings: [], freshness: null })).toEqual(NO_SHOT_QA);
    expect(NO_SHOT_QA.label).toBe("No QA yet");
  });

  it("fresh, fully evaluated, all pass → No blocking mismatch found (and it says it is not a creative approval)", () => {
    const a = assess([DURATION_PASS, PASS("lighting"), PASS("identity:x", "critical")]);
    expect(a.state).toBe("no_blocking_mismatch");
    expect(a.label).toBe("No blocking mismatch found");
    expect(a.headline).toMatch(/not a creative approval/);
    expect(a.issues).toEqual([]);
    expect(a.highestProblemSeverity).toBeNull();
    expect(a.suggestedRejectionReasons).toEqual([]);
  });

  it("a fresh critical fail → Critical mismatch, counted and first", () => {
    const a = assess([DURATION_PASS, LIGHT_WARN, YUMEKO_ID]);
    expect(a.state).toBe("critical_mismatch");
    expect(a.counts.criticalFailures).toBe(1);
    expect(a.highestProblemSeverity).toBe("critical");
    expect(a.issues[0]!.criterionKey).toBe("identity:yumeko");
  });

  it("a major fail (no critical) → Needs attention", () => {
    const a = assess([DURATION_PASS, UMBRELLA]);
    expect(a.state).toBe("needs_attention");
    expect(a.counts).toMatchObject({ criticalFailures: 0, majorFailures: 1 });
    expect(a.headline).toMatch(/1 mismatch to review; no critical mismatch/);
  });

  it("warnings only → Needs attention", () => {
    const a = assess([DURATION_PASS, LIGHT_WARN]);
    expect(a.state).toBe("needs_attention");
    expect(a.counts.warnings).toBe(1);
    expect(a.highestProblemSeverity).toBe("minor");
  });

  it("important criteria unchecked, nothing failing → Incomplete; unchecked never becomes a pass", () => {
    const a = assess([DURATION_PASS, EYELINE_UNCHECKED, MOVE_UNCHECKED]);
    expect(a.state).toBe("incomplete");
    expect(a.counts).toMatchObject({ unchecked: 2, importantUnchecked: 1, evaluated: 1 });
    const eyelines = a.issues.find((i) => i.criterionKey === "eyelines")!;
    expect(eyelines).toMatchObject({ kind: "unchecked", result: "unchecked" });
    expect(eyelines.uncheckedReason).toMatch(/direct-video analysis/);
    // only minor criteria unchecked: the answer is "no blocking mismatch in what was evaluated", not "incomplete"
    expect(assess([DURATION_PASS, MOVE_UNCHECKED]).state).toBe("no_blocking_mismatch");
  });

  it("a failed analysis that left important criteria unchecked says so", () => {
    const a = assess([DURATION_PASS, EYELINE_UNCHECKED], { run: { analysisStatus: "failed" } });
    expect(a.state).toBe("incomplete");
    expect(a.headline).toMatch(/the analysis failed/);
  });

  it("a stale run → QA stale, with its reasons, even over a critical failure; suggestions are withheld", () => {
    const a = assess([YUMEKO_ID, UMBRELLA], {
      stale: ["The Shot now selects Production Frame v4; this output was generated from v3."],
    });
    expect(a.state).toBe("qa_stale");
    expect(a.headline).toMatch(
      /no longer describes the current Shot: The Shot now selects Production Frame v4/,
    );
    expect(a.freshness!.reasons).toHaveLength(1);
    // history stays visible, but an old finding is not offered as a reason about the current Shot
    expect(a.issues.map((i) => i.criterionKey)).toEqual(["identity:yumeko", "forbiddenObjects:0"]);
    expect(a.suggestedRejectionReasons).toEqual([]);
  });

  it("a running analysis is never presented as clean", () => {
    const a = assess([DURATION_PASS, MOVE_UNCHECKED], { run: { analysisStatus: "running" } });
    expect(a.state).toBe("analysis_running");
  });

  it("every state has a label, and no label claims approval", () => {
    for (const s of SHOT_QA_STATES) expect(SHOT_QA_LABELS[s]).toBeTruthy();
    expect(Object.values(SHOT_QA_LABELS).join(" ")).not.toMatch(/approv|pass(ed)?\b/i);
  });
});

describe("human overrides drive the effective assessment; the system finding stays visible", () => {
  it("a reviewer FAIL → PASS removes the issue and its suggestion; the critical state clears", () => {
    const overridden = {
      ...YUMEKO_ID,
      overrides: [override("pass", "Same actress; lighting makes the jaw look round.")],
    };
    const a = assess([DURATION_PASS, overridden]);
    expect(a.state).toBe("no_blocking_mismatch");
    expect(a.overridesChangedResult).toBe(true);
    expect(a.counts.overridden).toBe(1);
    expect(a.suggestedRejectionReasons).toEqual([]);
    // the stored system finding itself was not touched
    expect(overridden.result).toBe("fail");
  });

  it("a reviewer PASS → FAIL creates an issue whose suggestion carries the reviewer's note, not the analyzer's observation", () => {
    const passed = finding("location_set", "major", "pass", {
      category: "location_set",
      title: "Set — Grand Celeste Lobby",
      actual: "Appears consistent with the lobby.",
      overrides: [override("fail", "Wrong lobby: these are the old elevators.")],
    });
    const a = assess([DURATION_PASS, passed]);
    expect(a.state).toBe("needs_attention");
    const issue = a.issues[0]!;
    expect(issue).toMatchObject({ kind: "fail", systemResult: "pass", result: "fail" });
    const s = a.suggestedRejectionReasons[0]!;
    expect(s.fromOverride).toBe(true);
    expect(s.text).toBe(
      "The set does not match Grand Celeste Lobby. Reviewer: Wrong lobby: these are the old elevators.",
    );
    expect(s.text).not.toMatch(/Appears consistent/);
  });

  it("a reviewer WARN → FAIL raises the band; the latest decision wins", () => {
    const f = {
      ...COUNT_WARN,
      overrides: [override("pass", "", "2026-10-27T09:00:00Z"), override("fail", "", "2026-10-27T11:00:00Z")],
    };
    const a = assess([f]);
    expect(a.issues[0]).toMatchObject({ kind: "fail", priority: 1 });
  });
});

describe("priority order is deterministic", () => {
  const all = () => [
    MOVE_UNCHECKED,
    LIGHT_WARN,
    EYELINE_UNCHECKED,
    PROP_FAIL,
    COUNT_WARN,
    UMBRELLA,
    VIEW,
    WARDROBE,
    PF_OPENING,
    YUMEKO_ID,
    DURATION_PASS,
  ];

  it("critical fail → major fail → minor fail → important warning → minor warning → important unchecked → other unchecked; ties by frozen position", () => {
    const a = assess(all());
    expect(a.issues.map((i) => i.criterionKey)).toEqual([
      // critical fails, in frozen criterion position order (fixture declaration order)
      "identity:yumeko",
      "wardrobe:yumeko",
      "production_frame",
      // major fails
      "location_view",
      "forbiddenObjects:0",
      // minor fail
      "prop:fan",
      // critical / major warning, then minor warning
      "character_count",
      "lighting",
      // important unchecked, then less important unchecked
      "eyelines",
      "camera_movement",
    ]);
    expect(a.issues.map((i) => i.priority)).toEqual([0, 0, 0, 1, 1, 2, 3, 4, 5, 6]);
  });

  it("the input order does not matter (same assessment from shuffled rows)", () => {
    const ordered = assess(all());
    const reversed = assess([...all()].reverse());
    expect(reversed).toEqual(ordered);
  });

  it("a Production Frame opening failure and a locked identity failure are top-priority issues", () => {
    const a = assess([LIGHT_WARN, UMBRELLA, PF_OPENING, YUMEKO_ID, DURATION_PASS]);
    expect(
      a.issues
        .slice(0, 2)
        .map((i) => i.criterionKey)
        .sort(),
    ).toEqual(["identity:yumeko", "production_frame"]);
    expect(a.issues.slice(0, 2).every((i) => i.priority === 0)).toBe(true);
  });
});

describe("issues preserve the evidence and never invent observations", () => {
  it("carries expected, observed, source, confidence, evidence, contradictions and limitations verbatim", () => {
    const issue = assess([YUMEKO_ID]).issues[0]!;
    expect(issue).toMatchObject({
      criterionKey: "identity:yumeko",
      category: "identity",
      severity: "critical",
      result: "fail",
      systemResult: "fail",
      override: null,
      title: "Yumeko — identity",
      expected: "Late twenties, sharp jawline, long black hair",
      observed: "The face in the output has a rounder jaw and short hair.",
      confidence: 0.8,
      contradictions: ["Hair length contradicts the locked reference."],
      limitations: ["Face partly in shadow."],
    });
    expect(issue.sourceRef).toMatch(/Character Continuity Lock/);
    expect(issue.evidence).toEqual([
      {
        input: "frame:2500",
        assetId: "frame-asset",
        atMs: 2500,
        observation: "short hair",
        source: "output_frame",
      },
    ]);
  });

  it("an unchecked criterion has no observation and its reason comes from the frozen plan", () => {
    const issue = assess([EYELINE_UNCHECKED]).issues[0]!;
    expect(issue.observed).toBe("");
    expect(issue.uncheckedReason).toBe("Needs direct-video analysis, which is not enabled. Stays unchecked.");
  });

  it("no opaque score exists anywhere in the assessment", () => {
    const a: ShotQaAssessment = assess([YUMEKO_ID, LIGHT_WARN, DURATION_PASS]);
    const keys = JSON.stringify(Object.keys(a)) + JSON.stringify(Object.keys(a.counts));
    expect(keys).not.toMatch(/score|percent|quality|grade/i);
  });
});

describe("suggested rejection reasons (deterministic, suggestions only)", () => {
  it("compose expectation + observation from the finding's own fields", () => {
    const a = assess([YUMEKO_ID, WARDROBE, PF_OPENING, VIEW, UMBRELLA, DURATION_PASS]);
    expect(a.suggestedRejectionReasons.map((s) => s.text)).toEqual([
      'Yumeko\'s identity does not match the locked Character reference "Yumeko — evening". Observed: The face in the output has a rounder jaw and short hair.',
      'Yumeko\'s wardrobe differs from the locked Look "Black Evening". Observed: A red cocktail dress.',
      "The opening image does not preserve Production Frame v3. Observed: The opening frame is a wider shot from the opposite side.",
      'The generated set does not match the selected Location View "Doorway". Observed: An outdoor street, not the hotel doorway.',
      "The Shot contains a forbidden object: red umbrella. Observed: A red umbrella is visible at the left edge.",
    ]);
    expect(a.suggestedRejectionReasons.every((s) => s.result === "fail" && !s.fromOverride)).toBe(true);
  });

  it("come only from effective fails and critical/major warnings — never from minor warnings or unchecked criteria", () => {
    const a = assess([LIGHT_WARN, COUNT_WARN, EYELINE_UNCHECKED, MOVE_UNCHECKED, PROP_FAIL]);
    expect(a.suggestedRejectionReasons.map((s) => s.criterionKey)).toEqual(["prop:fan", "character_count"]);
    expect(a.suggestedRejectionReasons[1]!.text).toBe(
      "Possibly: The visible character count differs from the expected 2.",
    );
  });

  it("a generic Production Frame failure is phrased as visual intent, not the opening image", () => {
    const generic = { ...PF_OPENING, title: "Production Frame v2 fidelity", actual: "" };
    expect(rejectionReasonText(assess([generic]).issues[0]!)).toBe(
      "The Shot does not preserve the visual intent of Production Frame v2.",
    );
  });

  it("deterministic findings state expected vs measured", () => {
    const dur = finding("duration", "major", "fail", {
      resultSource: "deterministic",
      title: "Duration",
      expected: "4.5s",
      actual: "5s",
    });
    expect(assess([dur]).suggestedRejectionReasons[0]!.text).toBe("Duration: expected 4.5s, got 5s.");
  });

  it("producing an assessment changes nothing it was given (no review status, no finding)", () => {
    const rows = [YUMEKO_ID, UMBRELLA];
    const before = JSON.stringify(rows);
    assess(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
