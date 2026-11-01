import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_SCHEMA_VERSION,
  PROMPT_VERSIONS,
  RUBRIC_VERSION,
  SEQUENCE_RUBRIC_VERSION,
} from "@/domain/continuity/analysis/types";
import {
  buildSequencePlan,
  NOT_CALIBRATED_SEQUENCE_REASON,
} from "@/domain/continuity/analysis/sequence-plan";
import {
  CUT_EDGE_POLICY,
  SEMANTIC_CUT_FAMILIES,
  type CutCriterion,
  type SemanticCutFamily,
} from "@/domain/continuity/sequence";
import { createAnalysisProviders } from "../analysis/registry";
import { buildCutInput } from "../calibration/sequence-calibration";
import {
  FAMILY_CRITERIA,
  SEQUENCE_CALIBRATION_PROTOCOL,
  SEQUENCE_CALIBRATION_VERSION,
} from "../calibration/sequence-fixtures";
import { CALIBRATION_VERSION } from "../calibration/temporal-calibration";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import {
  GEMINI_ANALYZER_VERSION,
  GEMINI_CROSS_CUT_ACCEPTED_FAMILIES,
  GEMINI_CROSS_CUT_CALIBRATED,
  GEMINI_CROSS_CUT_CALIBRATED_ON,
  GEMINI_CROSS_CUT_CALIBRATION_VERSION,
  GEMINI_SDK,
  GEMINI_SEQUENCE_ANALYSIS_VERSION,
  readGeminiConfig,
} from "../providers/gemini/config";
import { FakeGeminiTransport } from "../providers/gemini/fake-transport";
import { sequenceIdempotencyKey } from "../sequence-review";
import { stubEdges } from "./sequence-calibration-stub";

/**
 * Phase 3A.4E-C: the owner-accepted result of the live `sequence-calibration-v1` run, as production sees it. Pure and
 * offline: a fake transport that is never called.
 */
const ACCEPTED = [
  "screen_direction",
  "axis",
  "character_appearance",
  "wardrobe",
  "prop",
  "object_continuity",
  "geography",
  "lighting",
  "action_match",
];

const production = (env: Record<string, string> = {}) => {
  const transport = new FakeGeminiTransport([]);
  return {
    transport,
    provider: new GeminiAnalysisProvider({
      config: readGeminiConfig({
        PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
        GEMINI_API_KEY: "test-key-not-a-real-credential",
        PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
        ...env,
      }),
      transport,
    }),
  };
};

const criterion = (family: SemanticCutFamily): CutCriterion => ({
  ...FAMILY_CRITERIA[family],
  handler: "analyzer",
  family,
  applicability: "applies",
  intentCoverable: true,
  position: 0,
});
const edge = stubEdges("acceptance");
const planOf = (provider: GeminiAnalysisProvider, family: SemanticCutFamily) => {
  const input = buildCutInput({ ref: "acceptance", criterion: criterion(family), edge, provider });
  return { input, plan: input.plan, item: input.plan.items[0]! };
};

describe("the recorded decision", () => {
  it("is exactly the nine owner-accepted families, under the frozen experiment's version", () => {
    expect(GEMINI_CROSS_CUT_CALIBRATED).toBe(true);
    expect(GEMINI_CROSS_CUT_CALIBRATION_VERSION).toBe("sequence-calibration-v1");
    expect(GEMINI_CROSS_CUT_CALIBRATION_VERSION).toBe(SEQUENCE_CALIBRATION_VERSION);
    expect([...GEMINI_CROSS_CUT_ACCEPTED_FAMILIES]).toEqual(ACCEPTED);
    expect(GEMINI_CROSS_CUT_ACCEPTED_FAMILIES).not.toContain("eyeline");
    expect(Object.isFrozen(GEMINI_CROSS_CUT_ACCEPTED_FAMILIES)).toBe(true);
    // every accepted name is a real family, and eyeline is the only one left out
    expect(SEMANTIC_CUT_FAMILIES.filter((f) => !ACCEPTED.includes(f))).toEqual(["eyeline"]);
  });

  it("production Gemini exposes exactly that, through the provider and the registry", () => {
    const { provider } = production();
    expect(provider.crossCutCalibration()).toEqual({
      version: "sequence-calibration-v1",
      acceptedFamilies: ACCEPTED,
    });
    expect(provider.plannerView().crossCutFamilies).toEqual(ACCEPTED);
    const g = createAnalysisProviders(
      {
        PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
        GEMINI_API_KEY: "test-key-not-a-real-credential",
        PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
      },
      { transport: new FakeGeminiTransport([]) },
    ).get("gemini")!;
    expect(g.crossCutCalibration().acceptedFamilies).toEqual(ACCEPTED);
  });

  it("the calibrated identity is exactly the frozen protocol's, and production really sends it", () => {
    const p = SEQUENCE_CALIBRATION_PROTOCOL;
    expect(GEMINI_CROSS_CUT_CALIBRATED_ON).toEqual({
      model: "gemini-3.8-flash",
      thinkingLevel: "LOW",
      maxOutputTokensCap: 8192,
      temperature: 0,
      timeoutMs: 120_000,
    });
    expect(GEMINI_CROSS_CUT_CALIBRATED_ON).toEqual({
      model: p.model,
      thinkingLevel: p.thinkingLevel,
      maxOutputTokensCap: p.maxOutputTokensCap,
      temperature: p.temperature,
      timeoutMs: p.timeoutMs,
    });
    const { provider } = production();
    expect(provider.model).toBe(p.model);
    expect(provider.inferenceSettings()).toEqual({
      thinkingLevel: p.thinkingLevel,
      maxOutputTokensCap: p.maxOutputTokensCap,
      temperature: p.temperature,
      timeoutMs: p.timeoutMs,
    });
  });

  it("the production contract is the frozen protocol's: a change without a new decision fails here", () => {
    const p = SEQUENCE_CALIBRATION_PROTOCOL;
    expect(p.calibrationVersion).toBe(GEMINI_CROSS_CUT_CALIBRATION_VERSION);
    expect(p.analyzerVersion).toBe(GEMINI_SEQUENCE_ANALYSIS_VERSION);
    expect(p.promptVersion).toBe(PROMPT_VERSIONS.sequence_transition);
    expect(p.rubricVersion).toBe(SEQUENCE_RUBRIC_VERSION);
    expect(p.schemaVersion).toBe(ANALYSIS_SCHEMA_VERSION);
    expect(p.edgePolicy).toBe(CUT_EDGE_POLICY.id);
    expect(p.sdk).toBe(GEMINI_SDK);
    expect(p.sdk).toBe("@google/genai@2.29.0");
    const installed = JSON.parse(
      readFileSync(path.join(process.cwd(), "node_modules/@google/genai/package.json"), "utf8"),
    ) as { version: string };
    expect(`@google/genai@${installed.version}`).toBe(p.sdk);
    // and what a real production input carries
    const { input } = planOf(production().provider, "axis");
    expect(input.calibration.version).toBe(p.calibrationVersion);
    expect(input.analyzerVersion).toBe(p.analyzerVersion);
    expect(input.plan.batches[0]!.promptVersion).toBe(p.promptVersion);
    expect(input.rubricVersion).toBe(p.rubricVersion);
    expect(input.schemaVersion).toBe(p.schemaVersion);
    expect(input.edgePolicy).toBe(p.edgePolicy);
  });
});

describe("off the calibrated identity, no family is trusted", () => {
  const config = readGeminiConfig({
    PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
    GEMINI_API_KEY: "test-key-not-a-real-credential",
    PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
  });
  /** The settings are read through `inferenceSettings()`, so a changed literal is caught too. */
  class ChangedTemperature extends GeminiAnalysisProvider {
    override inferenceSettings() {
      return { ...super.inferenceSettings(), temperature: 1 };
    }
  }
  const cases: Array<[string, (t: FakeGeminiTransport) => GeminiAnalysisProvider]> = [
    [
      "model",
      (transport) =>
        new GeminiAnalysisProvider({ config: { ...config, model: "gemini-3.6-flash" }, transport }),
    ],
    [
      "thinking level",
      (transport) => new GeminiAnalysisProvider({ config: { ...config, thinkingLevel: "HIGH" }, transport }),
    ],
    [
      "output cap",
      (transport) =>
        new GeminiAnalysisProvider({ config: { ...config, maxOutputTokensCap: 4096 }, transport }),
    ],
    [
      "timeout",
      (transport) => new GeminiAnalysisProvider({ config: { ...config, timeoutMs: 5000 }, transport }),
    ],
    ["temperature", (transport) => new ChangedTemperature({ config, transport })],
  ];
  for (const [name, make] of cases)
    it(`${name}: empty accepted families, unsupported planning, zero transport calls`, () => {
      const transport = new FakeGeminiTransport([]);
      const provider = make(transport);
      expect(provider.crossCutCalibration().acceptedFamilies).toEqual([]);
      expect(provider.plannerView().crossCutFamilies).toEqual([]);
      for (const family of SEMANTIC_CUT_FAMILIES) {
        const { plan, item } = planOf(provider, family);
        expect(plan.batches, family).toEqual([]);
        expect(item, family).toMatchObject({ status: "unsupported", reason: NOT_CALIBRATED_SEQUENCE_REASON });
      }
      expect(transport.calls).toBe(0);
    });

  it("the environment reaches the same result", () => {
    const envs: Array<Record<string, string>> = [
      { PRISM_STUDIO_GEMINI_ANALYSIS_MODEL: "gemini-3.6-flash" },
      { PRISM_STUDIO_GEMINI_THINKING_LEVEL: "HIGH" },
      { PRISM_STUDIO_GEMINI_TIMEOUT_MS: "5000" },
    ];
    for (const env of envs)
      expect(production(env).provider.crossCutCalibration().acceptedFamilies).toEqual([]);
  });
});

describe("per-family gating in the production planner", () => {
  for (const family of ACCEPTED as SemanticCutFamily[])
    it(`${family}: planned, one sequence batch, nothing sent by planning`, () => {
      const { provider, transport } = production();
      const { plan, item } = planOf(provider, family);
      expect(item.status).toBe("planned");
      expect(plan.batches).toHaveLength(1);
      expect(plan.batches[0]!.mode).toBe("sequence_transition");
      expect(transport.calls).toBe(0);
    });

  it("eyeline: unsupported with the calibration reason; the master boolean trusts nothing by itself", () => {
    const { provider, transport } = production();
    const { plan, item } = planOf(provider, "eyeline");
    expect(item.status).toBe("unsupported");
    expect(item.reason).toBe("Sequence continuity for this family has not passed calibration yet.");
    expect(plan.batches).toEqual([]);
    expect(plan.manifest.entries.every((e) => !e.sent)).toBe(true);
    expect(transport.calls).toBe(0);
  });

  it("on one cut, eyeline stays out while the accepted families plan", () => {
    const { provider } = production();
    const { input } = planOf(provider, "axis");
    const plan = buildSequencePlan({
      analyzer: provider.plannerView(),
      criteria: SEMANTIC_CUT_FAMILIES.map(criterion),
      media: input.media,
      referenceUses: {},
      directVideoAllowed: true,
    });
    const status = (f: SemanticCutFamily) =>
      plan.items.find((i) => i.criterionKey === FAMILY_CRITERIA[f].key);
    for (const f of ACCEPTED as SemanticCutFamily[]) expect(status(f)?.status, f).toBe("planned");
    expect(status("eyeline")?.status).toBe("unsupported");
    expect(plan.batches.flatMap((b) => b.criterionKeys)).not.toContain(FAMILY_CRITERIA.eyeline.key);
    expect(plan.items).toHaveLength(10);
  });

  it("acceptance is not execution: without Project consent an accepted family sends nothing", () => {
    const { provider } = production();
    const { input } = planOf(provider, "screen_direction");
    const plan = buildSequencePlan({
      analyzer: provider.plannerView(),
      criteria: [criterion("screen_direction")],
      media: input.media,
      referenceUses: {},
      directVideoAllowed: false,
    });
    expect(plan.batches).toEqual([]);
    expect(plan.items[0]!.status).toBe("not_allowed");
  });

  it("acceptance is not execution: without the server's video gate an accepted family cannot plan", () => {
    const provider = new GeminiAnalysisProvider({
      config: readGeminiConfig({
        PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
        GEMINI_API_KEY: "test-key-not-a-real-credential",
      }),
      transport: new FakeGeminiTransport([]),
    });
    expect(provider.modes()).not.toContain("sequence_transition");
    const { plan, item } = planOf(provider, "screen_direction");
    expect(plan.batches).toEqual([]);
    expect(item.status).not.toBe("planned");
  });
});

describe("identity", () => {
  it("the calibration decision changes transition job identity, so an uncalibrated job cannot cover it", () => {
    const truth = {
      transitionKey: "k",
      subjectFingerprint: "s",
      leftSubjectFingerprint: "l",
      rightSubjectFingerprint: "r",
      criteriaFingerprint: "c",
      referenceFingerprint: "f",
      rulesVersion: "3a.4",
    };
    const uncalibrated = new GeminiAnalysisProvider({
      config: readGeminiConfig({ GEMINI_API_KEY: "test-key-not-a-real-credential" }),
      transport: new FakeGeminiTransport([]),
      testCrossCutCalibration: { version: "gemini-cross-cut-uncalibrated", acceptedFamilies: [] },
    });
    const key = (p: GeminiAnalysisProvider) =>
      sequenceIdempotencyKey(truth, p, "continuity-gemini-transition-v1", "nonce");
    expect(key(production().provider)).not.toBe(key(uncalibrated));
    expect(key(production().provider)).toBe(key(production().provider));
  });

  it("acceptance changed no request contract", () => {
    expect(GEMINI_SEQUENCE_ANALYSIS_VERSION).toBe("gemini-sequence-1");
    expect(PROMPT_VERSIONS.sequence_transition).toBe("continuity-gemini-transition-v1");
    expect(SEQUENCE_RUBRIC_VERSION).toBe("sequence-rubric-1");
    expect(ANALYSIS_SCHEMA_VERSION).toBe(2);
    expect(CUT_EDGE_POLICY.id).toBe("cut-edge-static-v1");
    const { input } = planOf(production().provider, "axis");
    expect(input.calibration.version).toBe("sequence-calibration-v1");
    expect([...input.calibration.acceptedFamilies].sort()).toEqual([...ACCEPTED].sort());
    expect(input.analyzerVersion).toBe("gemini-sequence-1");
  });

  it("Shot analysis is untouched: version 3, temporal v2, video_temporal only, lip sync off", () => {
    const { provider } = production();
    expect(GEMINI_ANALYZER_VERSION).toBe("3");
    expect(provider.analysisVersion("direct_video")).toBe("3");
    expect(provider.analysisVersion("image_set")).toBe("3");
    expect(PROMPT_VERSIONS.direct_video).toBe("continuity-gemini-video-v2");
    expect(RUBRIC_VERSION).toBe("continuity-rubric-1");
    expect(CALIBRATION_VERSION).toBe("temporal-calibration-v2");
    expect(provider.videoCapabilities()).toEqual(["video_temporal"]);
  });
});
