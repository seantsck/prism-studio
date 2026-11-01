import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shotByCode } from "@/domain/__tests__/helpers";
import { cutsOf, editOf, videoItem, world } from "@/domain/continuity/__tests__/cut-fixtures";
import {
  ANALYSIS_SCHEMA_VERSION,
  PROMPT_VERSIONS,
  RUBRIC_VERSION,
  SEQUENCE_RUBRIC_VERSION,
} from "@/domain/continuity/analysis/types";
import {
  CUT_EDGE_POLICY,
  SEMANTIC_CUT_FAMILIES,
  SEQUENCE_RULES_VERSION,
  type CutCriterion,
} from "@/domain/continuity/sequence";
import { createAnalysisProviders } from "../analysis/registry";
import {
  familyReports,
  frozenGeminiEnvProblems,
  gradeEvidenceWindows,
  gradeTemporalEvidence,
  interSceneControl,
  SEQUENCE_CALIBRATION_PREREGISTERED,
} from "../calibration/sequence-calibration";
import {
  FAMILY_CRITERIA,
  INTER_SCENE_CONTROL_FAMILIES,
  SEQUENCE_CALIBRATION_ACCEPTANCE,
  SEQUENCE_CALIBRATION_MODEL,
  SEQUENCE_CALIBRATION_PLAN,
  SEQUENCE_CALIBRATION_PROTOCOL,
  SEQUENCE_CALIBRATION_VERSION,
  SEQUENCE_FIXTURES,
  sequenceCalibrationDefinition,
  sequenceDefinitionHash,
  sequenceInputHash,
  type SequenceFixtureChecksums,
} from "../calibration/sequence-fixtures";
import { CALIBRATION_VERSION } from "../calibration/temporal-calibration";
import {
  GEMINI_ANALYZER_VERSION,
  GEMINI_DEFAULT_MODEL,
  GEMINI_SDK,
  GEMINI_CROSS_CUT_ACCEPTED_FAMILIES,
  GEMINI_CROSS_CUT_CALIBRATED,
  GEMINI_SEQUENCE_ANALYSIS_VERSION,
  readGeminiConfig,
} from "../providers/gemini/config";
import { FakeGeminiTransport } from "../providers/gemini/fake-transport";
import { FFMPEG_ADAPTER_NAME, FFMPEG_ADAPTER_VERSION } from "@/media/ffmpeg";
import { calibrationProvider, stubEdges } from "./sequence-calibration-stub";

/** Phase 3A.4E: the frozen experiment, the frozen identities and the production gate. Pure; no media, no network. */

describe("fixture integrity", () => {
  it("20 fixtures: one positive and one conflict for each of the ten production families, nothing else", () => {
    expect(SEQUENCE_FIXTURES).toHaveLength(SEQUENCE_CALIBRATION_PLAN.fixtures);
    expect(SEMANTIC_CUT_FAMILIES).toHaveLength(10);
    expect(new Set(SEQUENCE_FIXTURES.map((f) => f.family))).toEqual(new Set(SEMANTIC_CUT_FAMILIES));
    for (const family of SEMANTIC_CUT_FAMILIES) {
      const mine = SEQUENCE_FIXTURES.filter((f) => f.family === family);
      expect(mine.map((f) => [f.control, f.correct]).sort()).toEqual([
        ["conflict", "fail"],
        ["positive", "pass"],
      ]);
    }
    expect(SEQUENCE_FIXTURES.map((f) => f.family)).not.toContain("character_position");
    expect(new Set(SEQUENCE_FIXTURES.map((f) => f.id)).size).toBe(20);
    expect(Object.keys(FAMILY_CRITERIA).sort()).toEqual([...SEMANTIC_CUT_FAMILIES].sort());
  });

  it("the plan is 20 × 3 = 60, and each correction can add at most one request", () => {
    expect(SEQUENCE_CALIBRATION_PLAN).toEqual({
      fixtures: 20,
      trials: 3,
      qualityRequests: 60,
      maxCorrections: 60,
      maxTransportRequests: 120,
    });
  });

  it("the render specs are deterministic data: parents longer than the used interval, each with a tone to strip", () => {
    for (const f of SEQUENCE_FIXTURES) {
      for (const [s, c] of [
        [f.left, f.cut.left],
        [f.right, f.cut.right],
      ] as const) {
        expect(s.durationMs).toBe(5000);
        expect(c.outMs - c.inMs).toBeGreaterThan(CUT_EDGE_POLICY.windowMs);
        expect(s.durationMs).toBeGreaterThan(c.outMs);
        expect(s.audio).toContain("sine=");
        expect(s.video).not.toMatch(/random|noise|localtime|gmtime/);
      }
    }
  });

  it("no fixture claims a frame exit its pixels do not show (the 3A.3 v1 truth defect)", () => {
    for (const f of SEQUENCE_FIXTURES.filter((x) => x.family === "screen_direction")) {
      expect(`${f.description}`).not.toMatch(/\bexits\b/i);
      expect(FAMILY_CRITERIA.screen_direction.expected).not.toMatch(/exits/i);
    }
  });

  it("identity and wardrobe stay separable: appearance keeps the garment, wardrobe keeps the head", () => {
    const appearance = SEQUENCE_FIXTURES.find((f) => f.id === "character-appearance-conflict")!;
    const wardrobe = SEQUENCE_FIXTURES.find((f) => f.id === "wardrobe-conflict")!;
    const torso = /drawbox=x=250:y=140:w=140:h=180:color=(\w+)/;
    expect(appearance.left.video.match(torso)![1]).toBe(appearance.right.video.match(torso)![1]);
    const before = (v: string) => v.slice(0, v.search(torso));
    expect(before(wardrobe.left.video)).toBe(before(wardrobe.right.video));
    expect(wardrobe.left.video.match(torso)![1]).not.toBe(wardrobe.right.video.match(torso)![1]);
    expect(before(appearance.left.video)).not.toBe(before(appearance.right.video));
  });

  it("evidence windows sit at the cut, only where the evidence is time-specific", () => {
    const windowed = SEQUENCE_FIXTURES.filter((f) => f.evidenceWindows);
    expect(windowed.map((f) => f.family)).toEqual(["action_match", "action_match"]);
    for (const f of windowed) expect(f.evidenceWindows).toEqual({ left: [1500, 2000], right: [0, 500] });
  });

  it("every family's criterion is production's own: a real `buildEpisodeCuts` cut, with a real shared prop", () => {
    const w = world();
    const prop = w.data.props[0]!;
    shotByCode(w.data, "2B").propIds = [prop.id];
    shotByCode(w.data, "2E").propIds = [prop.id];
    w.data.looks = []; // like the proxy, the real Character has no Look: production's own "Look none"
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2B"), videoItem(w, "2E")]));
    const semantic = cut.criteria.filter((c) => c.handler === "analyzer");
    const character = /^(.*): same person/.exec(
      semantic.find((c) => c.family === "character_appearance")!.title,
    )![1]!;
    // only the synthetic names differ: the real Character and Prop become the proxies
    const asProxy = (s: string) =>
      s.replaceAll(prop.name, "Yellow baton").replaceAll(character, "Proxy figure");
    for (const family of SEMANTIC_CUT_FAMILIES) {
      const real = semantic.find((c) => c.family === family);
      expect(real, family).toBeTruthy();
      const mine = FAMILY_CRITERIA[family];
      expect(
        {
          category: mine.category,
          severity: mine.severity,
          title: mine.title,
          expected: mine.expected,
          sourceRef: mine.sourceRef,
        },
        family,
      ).toEqual({
        category: real!.category,
        severity: real!.severity,
        title: asProxy(real!.title),
        expected: asProxy(real!.expected),
        sourceRef: asProxy(real!.sourceRef),
      });
    }
    expect(semantic.find((c) => c.family === "prop")!.key).toBe(`cut:prop:${prop.id}`);
  });
});

describe("frozen rule", () => {
  it("3/3 per fixture, 6/6 per family, frozen tolerance", () => {
    expect(SEQUENCE_CALIBRATION_ACCEPTANCE).toMatchObject({
      trials: 3,
      minCorrectPerFixture: 3,
      correctPerFamily: 6,
      positiveExpected: "pass",
      conflictExpected: "fail",
      samplingPrecisionMs: 250,
      eventSlackMs: 250,
      eventToleranceMs: 500,
    });
  });

  it("the window grade: a still at the cut is inside; far-away evidence and a whole-clip interval are outside", () => {
    const edge = stubEdges("x");
    const f = {
      evidenceWindows: { left: [1500, 2000], right: [0, 500] } as {
        left: [number, number];
        right: [number, number];
      },
    };
    const ev = (input: string, atMs: number | null, endMs: number | null = null) => ({
      input,
      assetId: null,
      atMs,
      endMs,
      observation: "o",
      source: "video" as const,
    });
    const grade = (evidence: ReturnType<typeof ev>[]) => gradeEvidenceWindows(f, { evidence }, edge);
    expect(grade([ev("left:last", 4459), ev("right:first", 500)])).toBe("inside");
    expect(grade([ev("left:clip", 1750, 2000), ev("right:clip", 0, 250)])).toBe("inside");
    // the frozen edges: window ± 500 ms is inclusive
    expect(grade([ev("left:clip", 1000), ev("right:clip", 1000)])).toBe("inside");
    expect(grade([ev("left:clip", 999), ev("right:clip", 0)])).toBe("outside");
    expect(grade([ev("left:clip", 1500), ev("right:clip", 1001)])).toBe("outside");
    expect(grade([ev("left:clip", 0, 2000), ev("right:clip", 0)])).toBe("outside");
    expect(grade([ev("left:clip", 1500)])).toBe("outside");
    expect(grade([ev("ref:left:look:1", null), ev("right:first", 500)])).toBe("outside");
    expect(gradeEvidenceWindows({}, { evidence: [] }, edge)).toBe("not_applicable");
  });

  it("screen direction needs a long enough interval from BOTH clips; stills add to it but never replace it", () => {
    const ev = (input: string, atMs: number | null, endMs: number | null = null) => ({
      input,
      assetId: null,
      atMs,
      endMs,
      observation: "o",
      source: "video" as const,
    });
    const family = "screen_direction" as const;
    const grade = (evidence: ReturnType<typeof ev>[]) => gradeTemporalEvidence({ family }, { evidence });
    const left = ev("left:clip", 500, 750);
    const right = ev("right:clip", 0, 2000);
    expect(SEQUENCE_CALIBRATION_ACCEPTANCE.temporalEvidence).toMatchObject({
      families: ["screen_direction"],
      inputs: ["left:clip", "right:clip"],
      minIntervalMs: 250,
    });
    expect(grade([left, right])).toBe("sufficient");
    expect(grade([left, right, ev("left:last", 4459)])).toBe("sufficient");
    expect(grade([ev("left:last", 4459), ev("right:first", 500)])).toBe("insufficient");
    expect(grade([left, ev("right:first", 500)])).toBe("insufficient");
    expect(grade([ev("left:clip", 500, 749), right])).toBe("insufficient");
    expect(grade([ev("left:clip", 500), right])).toBe("insufficient");
    expect(grade([ev("left:clip", 750, 500), right])).toBe("insufficient");
    expect(gradeTemporalEvidence({ family }, null)).toBe("insufficient");
    expect(gradeTemporalEvidence({ family: "axis" }, { evidence: [] })).toBe("not_applicable");
  });

  it("each family is decided independently; a correction is disclosed for owner review; an abort accepts nothing", () => {
    const trials = SEQUENCE_FIXTURES.flatMap((f) =>
      [1, 2, 3].map((trial) => ({
        fixture: f.id,
        family: f.family,
        control: f.control,
        trial,
        expected: f.correct,
        result: f.correct,
        correct: !(f.family === "lighting" && f.control === "conflict" && trial === 3),
        evidence: [],
        bothSides: true,
        windowGrade: "not_applicable" as const,
        temporalGrade: "not_applicable" as const,
        correctionUsed: f.family === "axis" && trial === 1 && f.control === "positive",
        correctionValidated: f.family === "axis" && trial === 1 && f.control === "positive" ? true : null,
        providerRef: null,
        note: "",
      })),
    );
    const reports = familyReports(trials, "completed");
    expect(reports.lighting).toMatchObject({ decision: "rejected", correct: 5, required: 6 });
    expect(reports.screen_direction).toMatchObject({
      decision: "accepted",
      correct: 6,
      ownerReviewRequired: false,
    });
    expect(reports.axis).toMatchObject({ decision: "accepted", corrections: 1, ownerReviewRequired: true });
    for (const r of Object.values(familyReports(trials, "aborted_provider")))
      expect(r.decision).not.toBe("accepted");
  });
});

describe("hash", () => {
  const checksums: Record<string, SequenceFixtureChecksums> = Object.fromEntries(
    SEQUENCE_FIXTURES.map((f) => [
      f.id,
      {
        leftParent: `${f.id}-lp`,
        rightParent: `${f.id}-rp`,
        leftClip: `${f.id}-lc`,
        rightClip: `${f.id}-rc`,
        leftStill: `${f.id}-ls`,
        rightStill: `${f.id}-rs`,
      },
    ]),
  );
  const base = sequenceCalibrationDefinition();
  const baseHash = sequenceInputHash(checksums, base);
  const withFixture = (patch: Partial<(typeof SEQUENCE_FIXTURES)[number]>) => ({
    ...base,
    fixtures: base.fixtures.map((f, i) => (i === 0 ? { ...f, ...patch } : f)),
  });

  it("is stable for the same input", () => {
    expect(sequenceInputHash(checksums, sequenceCalibrationDefinition())).toBe(baseHash);
    expect(sequenceDefinitionHash()).toBe(sequenceDefinitionHash());
  });

  const protocol = (patch: Record<string, unknown>) =>
    ({ ...base, protocol: { ...base.protocol, ...patch } }) as unknown as typeof base;
  const first = SEQUENCE_FIXTURES[0]!;
  const changes: Array<[string, ReturnType<typeof sequenceCalibrationDefinition>]> = [
    ["correct answer", withFixture({ correct: "fail" })],
    ["description", withFixture({ description: "other" })],
    ["render recipe", withFixture({ left: { ...first.left, video: `${first.left.video},hflip` } })],
    ["source duration", withFixture({ right: { ...first.right, durationMs: 6000 } })],
    ["cut position", withFixture({ cut: { ...first.cut, left: { inMs: 0, outMs: 4500 } } })],
    ["evidence window", withFixture({ evidenceWindows: { left: [0, 1] } })],
    [
      "expected truth",
      { ...base, criteria: { ...base.criteria, axis: { ...base.criteria.axis, expected: "x" } } },
    ],
    [
      "acceptance",
      { ...base, acceptance: { ...base.acceptance, eventSlackMs: 500 } as unknown as typeof base.acceptance },
    ],
    ["protocol model", protocol({ model: "gemini-3.6-flash" })],
    ["protocol thinking level", protocol({ thinkingLevel: "HIGH" })],
    ["protocol output cap", protocol({ maxOutputTokensCap: 4096 })],
    ["protocol temperature", protocol({ temperature: 1 })],
    ["protocol SDK", protocol({ sdk: "@google/genai@2.30.0" })],
    ["protocol timeout", protocol({ timeoutMs: 60_000 })],
    ["protocol prompt", protocol({ promptVersion: "other" })],
    ["protocol analyzer", protocol({ analyzerVersion: "gemini-sequence-2" })],
    ["protocol rubric", protocol({ rubricVersion: "other" })],
    ["protocol schema", protocol({ schemaVersion: 3 })],
    ["protocol edge policy", protocol({ edgePolicy: "cut-edge-static-v2" })],
    ["ffmpeg build", protocol({ processor: { ...base.protocol.processor, toolVersion: "8.0" } })],
    ["adapter version", protocol({ processor: { ...base.protocol.processor, adapterVersion: "2" } })],
    ["processor name", protocol({ processor: { ...base.protocol.processor, name: "other" } })],
    ["prompt", { ...base, promptVersion: "other" as typeof base.promptVersion }],
    ["analyzer", { ...base, analyzerVersion: "gemini-sequence-2" as typeof base.analyzerVersion }],
    ["rubric", { ...base, rubricVersion: "other" as typeof base.rubricVersion }],
    ["schema", { ...base, schemaVersion: 3 as typeof base.schemaVersion }],
    [
      "calibration version",
      { ...base, calibrationVersion: "sequence-calibration-v2" as typeof base.calibrationVersion },
    ],
    [
      "edge policy",
      { ...base, edgePolicy: { ...base.edgePolicy, windowMs: 3000 } as unknown as typeof base.edgePolicy },
    ],
  ];
  for (const [name, definition] of changes)
    it(`changes with the ${name}`, () => {
      expect(sequenceInputHash(checksums, definition)).not.toBe(baseHash);
    });

  it("changes with any rendered or derived checksum", () => {
    for (const k of [
      "leftParent",
      "rightParent",
      "leftClip",
      "rightClip",
      "leftStill",
      "rightStill",
    ] as const) {
      const other = { ...checksums, [first.id]: { ...checksums[first.id]!, [k]: "changed" } };
      expect(sequenceInputHash(other, base), k).not.toBe(baseHash);
    }
  });

  it("the reviewed definition hash is the current definition (a changed experiment fails here first)", () => {
    expect(sequenceDefinitionHash()).toBe(SEQUENCE_CALIBRATION_PREREGISTERED.definitionHash);
  });

  it("the old hash is recorded as superseded before the first live run, and is never the reviewed one", () => {
    const old = "14c679499d38c5cad5ea6c91bba8ebe1073e1c579681cba0049318d4e5509f95";
    expect(SEQUENCE_CALIBRATION_PREREGISTERED.inputHash).not.toBe(old);
    expect(SEQUENCE_CALIBRATION_PREREGISTERED.superseded).toEqual([
      { inputHash: old, status: "superseded before first live run" },
    ]);
  });
});

describe("the frozen protocol", () => {
  it("is exactly this experiment", () => {
    expect(SEQUENCE_CALIBRATION_MODEL).toBe("gemini-3.8-flash");
    expect(SEQUENCE_CALIBRATION_PROTOCOL).toEqual({
      calibrationVersion: "sequence-calibration-v1",
      model: "gemini-3.8-flash",
      analyzerVersion: "gemini-sequence-1",
      promptVersion: "continuity-gemini-transition-v1",
      rubricVersion: "sequence-rubric-1",
      schemaVersion: 2,
      edgePolicy: "cut-edge-static-v1",
      thinkingLevel: "LOW",
      maxOutputTokensCap: 8192,
      temperature: 0,
      sdk: "@google/genai@2.29.0",
      timeoutMs: 120_000,
      processor: { name: "ffmpeg", adapterVersion: "1", toolVersion: "9.0.1-full_build-www.gyan.dev" },
    });
    expect(SEQUENCE_CALIBRATION_PREREGISTERED.protocol).toBe(SEQUENCE_CALIBRATION_PROTOCOL);
  });

  it("the literals are today's production values, so any later drift is visible and refused", () => {
    const p = SEQUENCE_CALIBRATION_PROTOCOL;
    expect(p.analyzerVersion).toBe(GEMINI_SEQUENCE_ANALYSIS_VERSION);
    expect(p.promptVersion).toBe(PROMPT_VERSIONS.sequence_transition);
    expect(p.rubricVersion).toBe(SEQUENCE_RUBRIC_VERSION);
    expect(p.schemaVersion).toBe(ANALYSIS_SCHEMA_VERSION);
    expect(p.edgePolicy).toBe(CUT_EDGE_POLICY.id);
    expect(p.sdk).toBe(GEMINI_SDK);
    expect(p.model).toBe(GEMINI_DEFAULT_MODEL);
    expect(p.processor.name).toBe(FFMPEG_ADAPTER_NAME);
    expect(p.processor.adapterVersion).toBe(FFMPEG_ADAPTER_VERSION);
    const cfg = readGeminiConfig({});
    expect(cfg.thinkingLevel).toBe(p.thinkingLevel);
    expect(cfg.maxOutputTokensCap).toBe(p.maxOutputTokensCap);
    expect(cfg.timeoutMs).toBe(p.timeoutMs);
    const installed = JSON.parse(
      readFileSync(path.join(process.cwd(), "node_modules/@google/genai/package.json"), "utf8"),
    ) as { version: string };
    expect(`@google/genai@${installed.version}`).toBe(p.sdk);
  });

  it("the environment cannot silently change a frozen setting or redirect the SDK", () => {
    expect(frozenGeminiEnvProblems({})).toEqual([]);
    expect(
      frozenGeminiEnvProblems({
        PRISM_STUDIO_GEMINI_ANALYSIS_MODEL: "gemini-3.8-flash",
        PRISM_STUDIO_GEMINI_THINKING_LEVEL: "low",
        PRISM_STUDIO_GEMINI_TIMEOUT_MS: "120000",
      }),
    ).toEqual([]);
    for (const [name, value] of [
      ["PRISM_STUDIO_GEMINI_ANALYSIS_MODEL", "gemini-3.6-flash"],
      ["PRISM_STUDIO_GEMINI_THINKING_LEVEL", "HIGH"],
      ["PRISM_STUDIO_GEMINI_THINKING_LEVEL", "nonsense"],
      ["PRISM_STUDIO_GEMINI_TIMEOUT_MS", "5000"],
      ["GOOGLE_GEMINI_BASE_URL", "https://example.invalid"],
      ["GOOGLE_GENAI_API_VERSION", "v1"],
      ["GOOGLE_GENAI_USE_VERTEXAI", "1"],
    ] as const)
      expect(frozenGeminiEnvProblems({ [name]: value })[0], name).toContain(name);
  });
});

describe("the inter-Scene control", () => {
  const realCut = () => {
    const w = world();
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "1C"), videoItem(w, "2A")]));
    expect(cut.crossesScene).toBe(true);
    return cut;
  };
  const semantic = (criteria: readonly CutCriterion[]) => criteria.filter((c) => c.handler === "analyzer");

  it("matches a real Scene-boundary cut: Prism owns n_a for exactly these families", () => {
    const real = semantic(realCut().criteria);
    expect(real.every((c) => c.applicability === "n_a")).toBe(true);
    expect(real.map((c) => c.family).sort()).toEqual([...INTER_SCENE_CONTROL_FAMILIES].sort());
  });

  it("sends zero requests with every family trusted, and is never a graded trial", () => {
    const provider = calibrationProvider(new FakeGeminiTransport([]));
    for (const control of [
      interSceneControl(provider, stubEdges("control")),
      interSceneControl(provider, stubEdges("control"), semantic(realCut().criteria)),
    ]) {
      expect(control.requests).toBe(0);
      expect(control.prismOwnedNa).toBe(true);
      expect(control.criteria.every((c) => c.status === "not_applicable")).toBe(true);
    }
    expect(SEQUENCE_FIXTURES.some((f) => /scene/i.test(f.id))).toBe(false);
  });
});

describe("identities are unchanged, and production holds only the accepted decision", () => {
  it("the calibration version is its own; every analyzer identity is untouched", () => {
    expect(SEQUENCE_CALIBRATION_VERSION).toBe("sequence-calibration-v1");
    expect(CALIBRATION_VERSION).toBe("temporal-calibration-v2");
    expect(GEMINI_ANALYZER_VERSION).toBe("3");
    expect(GEMINI_SEQUENCE_ANALYSIS_VERSION).toBe("gemini-sequence-1");
    expect(PROMPT_VERSIONS.sequence_transition).toBe("continuity-gemini-transition-v1");
    expect(PROMPT_VERSIONS.direct_video).toBe("continuity-gemini-video-v2");
    expect(SEQUENCE_RUBRIC_VERSION).toBe("sequence-rubric-1");
    expect(RUBRIC_VERSION).toBe("continuity-rubric-1");
    expect(ANALYSIS_SCHEMA_VERSION).toBe(2);
    expect(SEQUENCE_RULES_VERSION).toBe("3a.4");
    expect(CUT_EDGE_POLICY).toEqual({ id: "cut-edge-static-v1", windowMs: 2000, fps: 4, audio: "stripped" });
  });

  it("production: the accepted decision without eyeline, and lip sync still off", () => {
    expect(GEMINI_CROSS_CUT_CALIBRATED).toBe(true);
    expect(GEMINI_CROSS_CUT_ACCEPTED_FAMILIES).toHaveLength(9);
    expect(GEMINI_CROSS_CUT_ACCEPTED_FAMILIES).not.toContain("eyeline");
    // the 3A.3 state: video_temporal is the one video capability; lip sync stays separately gated off
    expect(calibrationProvider(new FakeGeminiTransport([])).videoCapabilities()).toEqual(["video_temporal"]);
  });

  it("the live-calibration env never widens the registry's Gemini beyond the accepted families", () => {
    const providers = createAnalysisProviders(
      {
        PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
        GEMINI_API_KEY: "test-key-not-a-real-credential",
        PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
        PRISM_STUDIO_SEQUENCE_CALIBRATION_LIVE: "1",
      },
      { transport: new FakeGeminiTransport([]) },
    );
    const g = providers.get("gemini")!;
    expect(g.crossCutCalibration().acceptedFamilies).toEqual([...GEMINI_CROSS_CUT_ACCEPTED_FAMILIES]);
    expect(g.plannerView().crossCutFamilies).toEqual([...GEMINI_CROSS_CUT_ACCEPTED_FAMILIES]);
    expect(g.crossCutCalibration().version).toBe(SEQUENCE_CALIBRATION_VERSION);
  });

  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  const src = path.join(process.cwd(), "src");

  it("the calibration-only family option is used nowhere outside the harness and tests", () => {
    const users = files(src)
      .filter(
        (f) =>
          /\.tsx?$/.test(f) && !f.includes("__tests__") && !f.includes(`${path.sep}calibration${path.sep}`),
      )
      .filter((f) => readFileSync(f, "utf8").includes("testCrossCutCalibration"))
      .map((f) => path.relative(src, f).replace(/\\/g, "/"));
    expect(users).toEqual(["continuity/providers/gemini/analyzer.ts"]);
  });

  it("nothing outside tests and the harness imports the harness, and the harness never writes production config", () => {
    const importers = files(src)
      .filter(
        (f) =>
          /\.tsx?$/.test(f) && !f.includes("__tests__") && !f.includes(`${path.sep}calibration${path.sep}`),
      )
      .filter((f) => /calibration\/sequence-/.test(readFileSync(f, "utf8")));
    expect(importers).toEqual([]);
    for (const f of files(path.join(src, "continuity/calibration")).filter((x) => x.includes("sequence-"))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toContain("GEMINI_CROSS_CUT_ACCEPTED_FAMILIES =");
      expect(text, f).not.toMatch(/writeFileSync\([^)]*config/);
    }
  });
});
