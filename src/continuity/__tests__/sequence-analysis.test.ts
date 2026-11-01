import { describe, expect, it } from "vitest";
import {
  buildSequencePlan,
  executionIdentity,
  NOT_CALIBRATED_SEQUENCE_REASON,
  sequenceInputSide,
  transitionInputProblem,
} from "@/domain/continuity/analysis/sequence-plan";
import { buildPrompt, SYSTEM_INSTRUCTION_TRANSITION_V1 } from "@/domain/continuity/analysis/prompt";
import { validateBatchResponse } from "@/domain/continuity/analysis/schema";
import {
  ANALYSIS_MODES,
  ANALYSIS_SCHEMA_VERSION,
  PROMPT_VERSIONS,
  RUBRIC_VERSION,
  SEQUENCE_RUBRIC_VERSION,
  type AnalysisMedia,
  type TransitionContinuityAnalysisInput,
} from "@/domain/continuity/analysis/types";
import { CONTINUITY_RULES_VERSION } from "@/domain/continuity/model";
import { SEMANTIC_CUT_FAMILIES, type CutCriterion } from "@/domain/continuity/sequence";
import { MockAnalysisProvider } from "../analysis/mock-provider";
import type { MediaBytes } from "../analysis/provider";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { GEMINI_ANALYZER_VERSION, readGeminiConfig } from "../providers/gemini/config";
import { FakeGeminiTransport } from "../providers/gemini/fake-transport";
import { OpenAIContinuityAnalyzer } from "../providers/openai/analyzer";
import { readOpenAIConfig } from "../providers/openai/config";
import { FakeOpenAITransport, openaiAnswerAll } from "../providers/openai/fake-transport";

/** Phase 3A.4D: the sequence-transition contract, offline (no media processing, no network). */

const crit = (key: string, o: Partial<CutCriterion> = {}): CutCriterion => ({
  key,
  category: "screen_direction",
  severity: "major",
  title: key,
  sourceRef: "Shot",
  expected: `${key} carries across the cut`,
  handler: "analyzer",
  family: "screen_direction",
  applicability: "applies",
  intentCoverable: true,
  position: 0,
  ...o,
});
const CRITERIA: CutCriterion[] = [
  crit("cut:picture", { handler: "deterministic", family: null, category: "other" }),
  crit("cut:screen_direction"),
  crit("cut:wardrobe:c1", { family: "wardrobe", category: "wardrobe" }),
  crit("cut:geography", { family: "geography", category: "geography", applicability: "n_a" }),
];
const edge = (side: "left" | "right", start: number, end: number) => ({
  policy: "cut-edge-static-v1",
  parentAssetId: `parent-${side}`,
  parentChecksum: `p-${side}`,
  startMs: start,
  endMs: end,
  sourceInMs: side === "left" ? 500 : 1000,
  itemEditStartMs: side === "left" ? 0 : 3500,
});
const m = (o: Partial<AnalysisMedia> & Pick<AnalysisMedia, "inputId" | "kind">): AnalysisMedia => ({
  role: "edge",
  label: o.inputId,
  assetId: `asset-${o.inputId}`,
  checksum: `sum-${o.inputId}`,
  mime: o.kind === "video" ? "video/mp4" : "image/png",
  width: 640,
  height: 360,
  byteSize: 100_000,
  durationMs: null,
  atMs: null,
  ...o,
});
const MEDIA: AnalysisMedia[] = [
  m({ inputId: "left:clip", kind: "video", durationMs: 2000, side: "left", edge: edge("left", 2000, 4000) }),
  m({
    inputId: "right:clip",
    kind: "video",
    durationMs: 1750,
    side: "right",
    edge: edge("right", 1000, 2750),
  }),
  m({ inputId: "left:last", kind: "output_frame", atMs: 3958, side: "left", edge: edge("left", 3958, 3958) }),
  m({
    inputId: "right:first",
    kind: "output_frame",
    atMs: 1000,
    side: "right",
    edge: edge("right", 1000, 1000),
  }),
  m({ inputId: "ref:left:look:1", kind: "reference", role: "look", side: "left" }),
  m({ inputId: "ref:right:look:1", kind: "reference", role: "look", side: "right" }),
];
const USES = { "ref:left:look:1": ["cut:wardrobe:c1"], "ref:right:look:1": ["cut:wardrobe:c1"] };

const mock = new MockAnalysisProvider();
const geminiCfg = readGeminiConfig({
  PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
  GEMINI_API_KEY: "test-key-not-real",
  PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
});
const plan = (analyzer = mock.plannerView(), directVideoAllowed = true, media = MEDIA) =>
  buildSequencePlan({ analyzer, criteria: CRITERIA, media, referenceUses: USES, directVideoAllowed });

function input(
  provider: { id: string; model: string } = mock,
  p = plan(),
): TransitionContinuityAnalysisInput {
  return {
    version: 1,
    subjectKind: "transition",
    runKey: "r",
    transition: {
      transitionKey: "k",
      editId: "e",
      episodeId: "ep",
      editRevision: 1,
      leftItemId: "l",
      rightItemId: "r",
      leftShotId: "sa",
      rightShotId: "sb",
      subjectFingerprint: "s",
      leftSubjectFingerprint: "ls",
      rightSubjectFingerprint: "rs",
      criteriaFingerprint: "c",
      referenceFingerprint: "f",
      rulesVersion: "3a.4",
    },
    edgePolicy: "cut-edge-static-v1",
    calibration: { version: "test", acceptedFamilies: [...SEMANTIC_CUT_FAMILIES] },
    criteria: CRITERIA.filter((c) => c.handler === "analyzer" && c.applicability === "applies").map((c) => ({
      key: c.key,
      category: c.category,
      severity: c.severity,
      title: c.title,
      sourceRef: c.sourceRef,
      expected: c.expected,
      capability: "cross_cut",
      family: c.family!,
    })),
    media: MEDIA,
    framing: { productionAspectRatio: "16:9" },
    analyzer: provider.id,
    analyzerVersion: "x",
    model: provider.model,
    promptVersions: { sequence_transition: PROMPT_VERSIONS.sequence_transition },
    rubricVersion: SEQUENCE_RUBRIC_VERSION,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    plan: p,
  };
}

const answer = (evidence: unknown[], result = "pass", id = "cut:screen_direction") =>
  JSON.stringify({
    criteria: [
      {
        criterionId: id,
        result,
        confidence: 0.6,
        summary: "s",
        evidence,
        contradictions: [],
        limitations: [],
      },
    ],
  });
const ev = (input: string, timestampMs: number | null, endMs: number | null = null) => ({
  input,
  timestampMs,
  endMs,
  observation: "seen",
});

describe("Shot identities are unchanged by 3A.4D", () => {
  it("versions, prompts, rubric and schema", () => {
    expect(CONTINUITY_RULES_VERSION).toBe("3a.1");
    expect(GEMINI_ANALYZER_VERSION).toBe("3");
    expect(PROMPT_VERSIONS.image_set).toBe("continuity-gemini-image-v1");
    expect(PROMPT_VERSIONS.direct_video).toBe("continuity-gemini-video-v2");
    expect(PROMPT_VERSIONS.sequence_transition).toBe("continuity-gemini-transition-v1");
    expect(RUBRIC_VERSION).toBe("continuity-rubric-1");
    expect(SEQUENCE_RUBRIC_VERSION).toBe("sequence-rubric-1");
    expect(ANALYSIS_SCHEMA_VERSION).toBe(2);
    expect(ANALYSIS_MODES).toEqual(["image_set", "direct_video", "sequence_transition"]);
  });
});

describe("provider contract (mode-scoped versions, calibration)", () => {
  it("Gemini: Shot modes v3, sequence gemini-sequence-1; production accepts the nine calibrated families", () => {
    const g = new GeminiAnalysisProvider({ config: geminiCfg, transport: new FakeGeminiTransport([]) });
    expect(g.version).toBe("3");
    expect(g.analysisVersion("image_set")).toBe("3");
    expect(g.analysisVersion("direct_video")).toBe("3");
    expect(g.analysisVersion("sequence_transition")).toBe("gemini-sequence-1");
    expect(g.modes()).toContain("sequence_transition");
    expect(g.crossCutCalibration().acceptedFamilies).toHaveLength(9);
    expect(g.crossCutCalibration().acceptedFamilies).not.toContain("eyeline");
    expect(g.plannerView().crossCutFamilies).toEqual(g.crossCutCalibration().acceptedFamilies);
  });
  it("OpenAI: no sequence contract", () => {
    const o = new OpenAIContinuityAnalyzer({
      config: readOpenAIConfig({ PRISM_STUDIO_CONTINUITY_ANALYZERS: "openai", OPENAI_API_KEY: "test" }),
      transport: new FakeOpenAITransport(openaiAnswerAll("pass")),
    });
    expect(o.modes()).not.toContain("sequence_transition");
    expect(o.analysisVersion("sequence_transition")).toBeNull();
  });
  it("Mock: exposes the sequence mode, labelled MOCK, free", () => {
    expect(mock.modes()).toContain("sequence_transition");
    expect(mock.analysisVersion("sequence_transition")).toBe("mock-sequence-1");
    expect(mock.analysisVersion("image_set")).toBe("2");
  });
});

describe("sequence planner", () => {
  it("mock + consent + media: plans applicable semantic criteria; never n_a or deterministic", () => {
    const p = plan();
    const planned = p.items.filter((i) => i.status === "planned").map((i) => i.criterionKey);
    expect(planned.sort()).toEqual(["cut:screen_direction", "cut:wardrobe:c1"]);
    expect(p.items.find((i) => i.criterionKey === "cut:geography")!.status).toBe("not_applicable");
    expect(p.items.find((i) => i.criterionKey === "cut:picture")!.status).toBe("deterministic");
    for (const b of p.batches) {
      expect(b.mode).toBe("sequence_transition");
      expect(b.outputInputIds).toEqual(["left:clip", "right:clip", "left:last", "right:first"]);
      expect(b.sampling).toEqual({ policy: "cut-edge-static-v1", fps: 4 });
    }
    // only the wardrobe batch carries the sided Look references
    const w = p.batches.find((b) => b.criterionKeys.includes("cut:wardrobe:c1"))!;
    expect(w.referenceInputIds).toEqual(["ref:left:look:1", "ref:right:look:1"]);
    expect(
      p.batches.find((b) => b.criterionKeys.includes("cut:screen_direction"))!.referenceInputIds,
    ).toEqual([]);
  });
  it("production Gemini plans its accepted families; a family nobody accepted stays unsupported", () => {
    const g = new GeminiAnalysisProvider({ config: geminiCfg, transport: new FakeGeminiTransport([]) });
    const p = plan(g.plannerView());
    expect(
      p.items
        .filter((i) => i.status === "planned")
        .map((i) => i.criterionKey)
        .sort(),
    ).toEqual(["cut:screen_direction", "cut:wardrobe:c1"]);
  });
  it("Gemini on a model the decision was not measured on: every family unsupported, nothing sent", () => {
    const g = new GeminiAnalysisProvider({
      config: { ...geminiCfg, model: "gemini-3.6-flash" },
      transport: new FakeGeminiTransport([]),
    });
    const p = plan(g.plannerView());
    expect(p.batches).toEqual([]);
    for (const k of ["cut:screen_direction", "cut:wardrobe:c1"]) {
      const it = p.items.find((i) => i.criterionKey === k)!;
      expect(it.status).toBe("unsupported");
      expect(it.reason).toBe(NOT_CALIBRATED_SEQUENCE_REASON);
    }
    expect(p.manifest.entries.every((e) => !e.sent)).toBe(true);
    expect(p.manifest.entries.find((e) => e.inputId === "left:clip")!.omissionReason).toBe(
      "sequence_not_calibrated",
    );
  });
  it("cross_cut alone never plans a family", () => {
    const p = plan({ ...mock.plannerView(), crossCutFamilies: [] });
    expect(p.batches).toEqual([]);
  });
  it("direct-video consent false: not allowed, no media sent", () => {
    const p = plan(mock.plannerView(), false);
    expect(p.batches).toEqual([]);
    expect(p.items.find((i) => i.criterionKey === "cut:screen_direction")!.status).toBe("not_allowed");
    expect(p.manifest.entries.find((e) => e.inputId === "right:clip")!.omissionReason).toBe(
      "sequence_video_not_allowed",
    );
  });
  it("missing / oversized / unchecksummed edge media: no batch", () => {
    const without = MEDIA.filter((x) => x.inputId !== "right:clip");
    expect(plan(mock.plannerView(), true, without).batches).toEqual([]);
    const long = MEDIA.map((x) => (x.inputId === "left:clip" ? { ...x, durationMs: 3500 } : x));
    expect(plan(mock.plannerView(), true, long).batches).toEqual([]);
    const unsummed = MEDIA.map((x) => (x.inputId === "left:last" ? { ...x, checksum: null } : x));
    expect(plan(mock.plannerView(), true, unsummed).batches).toEqual([]);
  });
});

describe("sided evidence validation (sequence only)", () => {
  const batch = plan().batches.find((b) => b.criterionKeys.includes("cut:screen_direction"))!;
  const ok = (raw: string) => validateBatchResponse(raw, batch, MEDIA);
  it("accepts left timestamped clip + right timestamped clip", () => {
    expect(ok(answer([ev("left:clip", 1500, 2000), ev("right:clip", 0, 900)])).ok).toBe(true);
  });
  it("accepts left clip + right exact edge still", () => {
    expect(ok(answer([ev("left:clip", 1999), ev("right:first", null)])).ok).toBe(true);
  });
  it("refuses one-sided judgements", () => {
    expect(ok(answer([ev("left:clip", 100), ev("left:last", null)])).ok).toBe(false);
    expect(ok(answer([ev("right:clip", 100)])).ok).toBe(false);
  });
  it("a sided reference does not count as edge evidence", () => {
    const wb = plan().batches.find((b) => b.criterionKeys.includes("cut:wardrobe:c1"))!;
    const r = validateBatchResponse(
      answer([ev("left:clip", 10), ev("ref:right:look:1", null)], "warn", "cut:wardrobe:c1"),
      wb,
      MEDIA,
    );
    expect(r.ok).toBe(false);
  });
  it("bounds each clip by ITS OWN duration", () => {
    expect(ok(answer([ev("left:clip", 1900), ev("right:clip", 1800)])).ok).toBe(false); // right is 1750 ms
    expect(ok(answer([ev("left:clip", 2001), ev("right:clip", 10)])).ok).toBe(false);
    expect(ok(answer([ev("left:clip", 10, 2100), ev("right:clip", 10)])).ok).toBe(false);
  });
  it("refuses an interval on a still, a wrong still time, an unknown input and an n_a answer", () => {
    expect(ok(answer([ev("left:last", 3958, 3999), ev("right:clip", 10)])).ok).toBe(false);
    expect(ok(answer([ev("left:last", 12), ev("right:clip", 10)])).ok).toBe(false);
    expect(ok(answer([ev("left:clip", 10), ev("right:other", null)])).ok).toBe(false);
    expect(ok(answer([ev("left:clip", 10), ev("right:clip", 10)], "pass", "cut:geography")).ok).toBe(false);
  });
  it("unchecked needs no evidence", () => {
    expect(ok(answer([], "unchecked")).ok).toBe(true);
  });
  it("direct-video Shot evidence still does NOT require two sides", () => {
    const video: AnalysisMedia = m({ inputId: "video", kind: "video", durationMs: 5000 });
    const r = validateBatchResponse(
      answer([ev("video", 100)], "pass", "temporal:1"),
      {
        mode: "direct_video",
        criterionKeys: ["temporal:1"],
        referenceInputIds: [],
        outputInputIds: ["video"],
      },
      [video],
    );
    expect(r.ok).toBe(true);
  });
});

describe("sequence prompt", () => {
  it("is a dedicated two-sided prompt with sided labels", () => {
    const i = input();
    const b = i.plan.batches.find((x) => x.criterionKeys.includes("cut:wardrobe:c1"))!;
    const spec = buildPrompt({ batch: b, criteria: i.criteria, media: i.media, framing: i.framing });
    expect(spec.promptVersion).toBe("continuity-gemini-transition-v1");
    expect(spec.systemInstruction).toBe(SYSTEM_INSTRUCTION_TRANSITION_V1);
    for (const phrase of [
      "LEFT",
      "RIGHT",
      "editorial taste",
      "NOT an approval",
      "unchecked = the evidence is insufficient",
    ])
      expect(spec.systemInstruction).toContain(phrase);
    expect(spec.systemInstruction).not.toMatch(/n_a\b(?! answer)/);
    expect(spec.data.inputs.map((x) => [x.inputId, x.side])).toEqual([
      ["left:clip", "left"],
      ["left:last", "left"],
      ["ref:left:look:1", "left"],
      ["right:clip", "right"],
      ["right:first", "right"],
      ["ref:right:look:1", "right"],
    ]);
  });
});

describe("canonical side authority (input id, never the redundant field)", () => {
  it("sequenceInputSide", () => {
    expect(sequenceInputSide("left:clip")).toBe("left");
    expect(sequenceInputSide("left:last")).toBe("left");
    expect(sequenceInputSide("ref:left:look:1")).toBe("left");
    expect(sequenceInputSide("right:clip")).toBe("right");
    expect(sequenceInputSide("right:first")).toBe("right");
    expect(sequenceInputSide("ref:right:identity:2")).toBe("right");
    expect(sequenceInputSide("video")).toBeNull();
    expect(sequenceInputSide("ref:look:1")).toBeNull();
  });
  it("the frozen input contract refuses a contradicting side, a bad prefix, a missing / duplicated edge input", () => {
    expect(transitionInputProblem(input())).toBeNull();
    const flip = (id: string, side: "left" | "right") => {
      const i = input();
      i.media = i.media.map((x) => (x.inputId === id ? { ...x, side } : x));
      return transitionInputProblem(i);
    };
    expect(flip("left:clip", "right")).toMatch(/claims the right side/);
    expect(flip("right:clip", "left")).toMatch(/claims the left side/);
    const bad = input();
    bad.media = bad.media.map((x) => (x.inputId === "ref:left:look:1" ? { ...x, inputId: "ref:look:1" } : x));
    expect(transitionInputProblem(bad)).toMatch(/not a canonically sided/);
    const missing = input();
    missing.media = missing.media.filter((x) => x.inputId !== "right:first");
    expect(transitionInputProblem(missing)).toMatch(/exactly one right:first/);
    const twice = input();
    twice.media = [...twice.media, twice.media[0]!];
    expect(transitionInputProblem(twice)).toMatch(/exactly one left:clip/);
    const kind = input();
    kind.media = kind.media.map((x) => (x.inputId === "left:last" ? { ...x, kind: "video" as const } : x));
    expect(transitionInputProblem(kind)).toMatch(/left:last must be output_frame/);
  });
  it("evidence sides come from the input id: a lying `side` field never makes evidence two-sided", () => {
    const lying = MEDIA.map((x) => (x.inputId === "left:last" ? { ...x, side: "right" as const } : x));
    const b = plan().batches.find((x) => x.criterionKeys.includes("cut:screen_direction"))!;
    // left:clip + left:last (which claims "right") is still ONE-sided
    expect(validateBatchResponse(answer([ev("left:clip", 10), ev("left:last", null)]), b, lying).ok).toBe(
      false,
    );
  });
});

describe("execution identity", () => {
  it("transition input with only sequence batches; refuses Shot modes in a transition input", () => {
    expect(executionIdentity(input())).toMatchObject({ ok: true, subject: "transition" });
    const bad = input();
    bad.plan = { ...bad.plan, batches: [{ ...bad.plan.batches[0]!, mode: "direct_video" }] };
    expect(executionIdentity(bad)).toMatchObject({ ok: false });
  });
});

describe("Gemini sequence request (fake transport only)", () => {
  const bytes = (i: AnalysisMedia): MediaBytes => ({
    inputId: i.inputId,
    mime: i.kind === "video" ? "video/mp4" : "image/png",
    bytes: new Uint8Array(64),
  });
  const media = new Map(MEDIA.map((x) => [x.inputId, bytes(x)]));
  const g = (t: FakeGeminiTransport) =>
    new GeminiAnalysisProvider({
      config: geminiCfg,
      transport: t,
      testCrossCutCalibration: { version: "test-only", acceptedFamilies: [...SEMANTIC_CUT_FAMILIES] },
    });
  const good = {
    criteria: [
      {
        criterionId: "cut:wardrobe:c1",
        result: "warn",
        confidence: 0.4,
        summary: "jacket colour differs",
        evidence: [ev("left:clip", 1200, 1800), ev("right:first", null)],
        contradictions: [],
        limitations: [],
      },
    ],
  };
  it("sends two videos, two stills, sided refs, the sequence prompt and schema", async () => {
    const t = new FakeGeminiTransport([{ kind: "json", body: good }]);
    const p = g(t);
    const i = input(p, plan(p.plannerView()));
    const b = i.plan.batches.find((x) => x.criterionKeys.includes("cut:wardrobe:c1"))!;
    const out = await p.analyzeBatch({
      batch: b,
      input: i,
      media,
      ctx: { now: () => new Date(), sleep: async () => {} },
    });
    expect(out.findings[0]).toMatchObject({ criterionKey: "cut:wardrobe:c1", result: "warn" });
    const r = t.requests[0]!;
    expect(r.systemInstruction).toBe(SYSTEM_INSTRUCTION_TRANSITION_V1);
    expect(r.inlineVideos).toBe(2);
    expect(r.inlineMedia).toBe(6); // 2 clips + 2 stills + 2 sided refs
    expect(r.videoFps).toEqual([4, 4]);
    expect(r.textParts.join("\n")).toContain("LEFT SIDE");
    expect(r.textParts.join("\n")).toContain("ref:right:look:1");
  });
  it("a clip whose approved transfer differs from what Gemini would do is refused before any upload/request", async () => {
    const t = new FakeGeminiTransport([{ kind: "json", body: good }]);
    const p = g(t);
    const i = input(p, plan(p.plannerView()));
    i.media = i.media.map((x) =>
      x.inputId === "left:clip" ? { ...x, edge: { ...x.edge!, transfer: "provider_file" as const } } : x,
    );
    const b = i.plan.batches.find((x) => x.criterionKeys.includes("cut:wardrobe:c1"))!;
    await expect(
      p.analyzeBatch({ batch: b, input: i, media, ctx: { now: () => new Date(), sleep: async () => {} } }),
    ).rejects.toMatchObject({ category: "local_policy_block", code: "transfer_not_approved" });
    expect(t.calls).toBe(0);
    expect(t.uploads).toEqual([]);
  });

  it("one correction for a one-sided answer, then fails visibly", async () => {
    const oneSided = { criteria: [{ ...good.criteria[0], evidence: [ev("left:clip", 10)] }] };
    const t = new FakeGeminiTransport([
      { kind: "json", body: oneSided },
      { kind: "json", body: oneSided },
    ]);
    const p = g(t);
    const i = input(p, plan(p.plannerView()));
    const b = i.plan.batches.find((x) => x.criterionKeys.includes("cut:wardrobe:c1"))!;
    await expect(
      p.analyzeBatch({ batch: b, input: i, media, ctx: { now: () => new Date(), sleep: async () => {} } }),
    ).rejects.toMatchObject({ code: "schema_invalid_after_correction" });
    expect(t.calls).toBe(2);
  });
  it("a correction that adds the right side is accepted", async () => {
    const oneSided = { criteria: [{ ...good.criteria[0], evidence: [ev("left:clip", 10)] }] };
    const t = new FakeGeminiTransport([
      { kind: "json", body: oneSided },
      { kind: "json", body: good },
    ]);
    const p = g(t);
    const i = input(p, plan(p.plannerView()));
    const b = i.plan.batches.find((x) => x.criterionKeys.includes("cut:wardrobe:c1"))!;
    const out = await p.analyzeBatch({
      batch: b,
      input: i,
      media,
      ctx: { now: () => new Date(), sleep: async () => {} },
    });
    expect(out.correctionUsed).toBe(true);
    expect(t.calls).toBe(2);
  });
});
