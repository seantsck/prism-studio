import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SEMANTIC_CUT_FAMILIES } from "@/domain/continuity/sequence";
import {
  edgeMediaMap,
  fixtureInput,
  gradeSequenceTrial,
  inlineOnlyProblems,
  runSequenceCalibration,
  SEQUENCE_CALIBRATION_PREREGISTERED,
  SEQUENCE_RUN_CONTROL,
} from "../calibration/sequence-calibration";
import {
  SEQUENCE_CALIBRATION_ACCEPTANCE,
  SEQUENCE_CALIBRATION_PROTOCOL,
  SEQUENCE_FIXTURES,
  type SequenceCalibrationFixture,
} from "../calibration/sequence-fixtures";
import { sequenceOracle, type OracleBehaviour } from "../calibration/sequence-oracle";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { readGeminiConfig } from "../providers/gemini/config";
import { FakeGeminiTransport, type FakeStep } from "../providers/gemini/fake-transport";
import { geminiResponseJsonSchema } from "../providers/gemini/response-schema";
import { SdkGeminiTransport } from "../providers/gemini/sdk-transport";
import { GeminiTransportError, type GeminiRequest } from "../providers/gemini/transport";
import {
  calibrationConfig,
  calibrationProvider,
  REVIEWED_PROCESSOR,
  stubEdges,
  stubMaterials,
  stubPreregistration,
} from "./sequence-calibration-stub";

/**
 * Phase 3A.4E: the runner over the REAL provider path with a fake transport (the media are stubs here; the media test
 * covers real ffmpeg). The global fetch is trapped: nothing can leave the process.
 */
let realFetch: typeof fetch;
let outbound = 0;
beforeEach(() => {
  outbound = 0;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    outbound += 1;
    throw new Error("network trapped");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  expect(outbound).toBe(0);
});

const materials = stubMaterials();
const NOW = new Date("2026-11-01T00:00:00Z");
/** The gates of a live run, with the transport still fake. */
const LIVE = {
  live: true,
  quota: { maxRpm: 1000, maxTpm: 100_000_000, maxRpd: 1000 },
  livePreregistration: stubPreregistration(materials),
  processorIdentity: REVIEWED_PROCESSOR,
  sleep: async () => undefined,
};

async function run(
  script: OracleBehaviour | ((req: GeminiRequest, n: number) => FakeStep),
  o: { maxTransportCalls?: number; maxUsd?: number } = {},
) {
  const transport = new FakeGeminiTransport(
    typeof script === "function" ? script : sequenceOracle(materials, script),
  );
  const report = await runSequenceCalibration({
    provider: calibrationProvider(transport),
    materials,
    maxTransportCalls: o.maxTransportCalls ?? 120,
    maxUsd: o.maxUsd ?? 5,
    now: NOW,
    sleep: async () => undefined,
  });
  return { report, transport };
}
const decisions = (r: Awaited<ReturnType<typeof run>>["report"]) =>
  Object.fromEntries(Object.entries(r.families).map(([k, v]) => [k, v.decision]));

describe("the truthful oracle", () => {
  it("accepts all ten families in exactly 60 requests, with no upload or correction", async () => {
    const { report, transport } = await run("truthful");
    expect(report.status).toBe("completed");
    expect(report.trialsAttempted).toBe(60);
    expect(report.transportCalls).toBe(60);
    expect(report.analysisAttempts).toBe(60);
    expect(report.correctionAttempts).toBe(0);
    expect(report.uploadAttempts).toBe(0);
    for (const f of SEMANTIC_CUT_FAMILIES)
      expect(report.families[f]).toMatchObject({ decision: "accepted", correct: 6, required: 6 });
    expect(transport.uploads).toEqual([]);
    for (const r of transport.requests) {
      expect(r.inlineVideos).toBe(2);
      expect(r.inlineMedia).toBe(4); // two clips + two edge stills
      expect(r.videoFps).toEqual([4, 4]);
      expect(r.fileParts).toBe(0);
    }
  });

  it("the report carries the frozen identity and never a secret", async () => {
    const { report } = await run("truthful");
    expect(report).toMatchObject({
      version: "sequence-calibration-v1",
      transport: "fake",
      analyzer: "gemini",
      analyzerVersion: "gemini-sequence-1",
      prompt: "continuity-gemini-transition-v1",
      rubric: "sequence-rubric-1",
      schema: 2,
      edgePolicy: "cut-edge-static-v1",
      fps: 4,
      fixtureCount: 20,
      trialsPerFixture: 3,
      plannedQualityRequests: 60,
      transportCeiling: 120,
      productionConfigUnchanged: true,
      protocol: SEQUENCE_CALIBRATION_PROTOCOL,
      inferenceSettings: {
        thinkingLevel: "LOW",
        maxOutputTokensCap: 8192,
        temperature: 0,
        timeoutMs: 120_000,
      },
      livePreregistrationVerified: false,
    });
    expect(report.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.interSceneControl.requests).toBe(0);
    expect(report.trials[0]).toMatchObject({
      bothSides: true,
      correctionUsed: false,
      windowGrade: "not_applicable",
    });
    expect(JSON.stringify(report)).not.toContain("test-key-not-a-real-credential");
  });

  it("the request carries production's contract and no fixture truth", async () => {
    let captured: GeminiRequest | null = null;
    const oracle = sequenceOracle(materials, "truthful");
    const { transport } = await run((req, n) => {
      captured ??= req;
      return oracle(req, n);
    });
    const req = captured! as GeminiRequest;
    const text = req.turns[0]!.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    for (const f of SEQUENCE_FIXTURES) {
      expect(text).not.toContain(f.id);
      expect(text).not.toContain(f.description);
      expect(text).not.toContain(f.notes);
    }
    expect(text).not.toMatch(/calibration|conflict|positive/i);
    for (const id of ["left:clip", "right:clip", "left:last", "right:first"]) expect(text).toContain(id);
    expect(req.responseJsonSchema).toEqual(geminiResponseJsonSchema("sequence_transition", 1));
    expect(transport.calls).toBe(60);
  });

  it("every request, correction included, really carries the frozen model and settings", async () => {
    const seen: GeminiRequest[] = [];
    const oracle = sequenceOracle(materials, "malformed_then_truthful");
    await run((req, n) => {
      seen.push(req);
      return oracle(req, n);
    });
    expect(seen).toHaveLength(120);
    for (const r of seen) {
      expect(r.model).toBe("gemini-3.8-flash");
      expect(r.thinkingLevel).toBe("LOW");
      expect(r.temperature).toBe(0);
      expect(r.timeoutMs).toBe(120_000);
      expect(r.maxOutputTokens).toBeLessThanOrEqual(8192);
    }
  });

  it("every fixture input is the production transition contract, and its clip transfer is frozen inline", () => {
    const provider = calibrationProvider(new FakeGeminiTransport([]));
    SEQUENCE_FIXTURES.forEach((f, i) => {
      const input = fixtureInput(f, i, materials.get(f.id)!, provider);
      expect(input.subjectKind).toBe("transition");
      expect(input.analyzerVersion).toBe("gemini-sequence-1");
      expect(input.promptVersions.sequence_transition).toBe("continuity-gemini-transition-v1");
      expect(input.rubricVersion).toBe("sequence-rubric-1");
      expect(input.schemaVersion).toBe(2);
      expect(input.edgePolicy).toBe("cut-edge-static-v1");
      expect(input.calibration.version).toBe("sequence-calibration-v1");
      expect(input.media.map((m) => m.inputId).sort()).toEqual(
        ["left:clip", "left:last", "right:clip", "right:first"].sort(),
      );
      expect(input.plan.batches).toHaveLength(1);
      expect(input.plan.batches[0]).toMatchObject({
        mode: "sequence_transition",
        sampling: { policy: "cut-edge-static-v1", fps: 4 },
      });
      for (const m of input.media.filter((x) => x.kind === "video")) expect(m.edge?.transfer).toBe("inline");
      // no fixture truth anywhere in the frozen input
      const frozen = JSON.stringify(input);
      expect(frozen).not.toContain(f.id);
      expect(frozen).not.toContain(f.description);
    });
  });
});

describe("a bad analyzer is caught, per family", () => {
  const allRejected = async (behaviour: OracleBehaviour, correctPerFamily: number) => {
    const { report } = await run(behaviour);
    expect(report.status).toBe("completed");
    for (const f of SEMANTIC_CUT_FAMILIES)
      expect(report.families[f], f).toMatchObject({ decision: "rejected", correct: correctPerFamily });
    return report;
  };
  it("always pass", () => allRejected("always_pass", 3));
  it("warn on a conflict", () => allRejected("warn_on_conflict", 3));
  it("fail on a positive", () => allRejected("fail_on_positive", 3));
  it("warn on a positive", () => allRejected("warn_on_positive", 3));
  it("unchecked", () => allRejected("unchecked", 0));
  it("a missing answer", () => allRejected("missing_answer", 0));

  it("one-sided evidence: the validator refuses it, the one correction fails too", async () => {
    const report = await allRejected("one_sided", 0);
    expect(report.correctionAttempts).toBe(60);
    expect(report.transportCalls).toBe(120);
    expect(report.corrections).toHaveLength(60);
    expect(report.corrections[0]!.validated).toBe(false);
    expect(report.trials[0]).toMatchObject({ result: "error", errorCategory: "schema_invalid" });
  });

  it("a timestamp past the clip", () => allRejected("bad_timestamp", 0));

  it("a malformed answer that stays malformed", () => allRejected("malformed", 0));

  it("evidence outside the frozen event window rejects ONLY the windowed family", async () => {
    const { report } = await run("out_of_window");
    expect(report.status).toBe("completed");
    expect(report.families.action_match).toMatchObject({ decision: "rejected", correct: 0 });
    const t = report.trials.find((x) => x.family === "action_match")!;
    expect(t).toMatchObject({ windowGrade: "outside", correct: false, bothSides: true });
    for (const f of SEMANTIC_CUT_FAMILIES.filter((x) => x !== "action_match"))
      expect(report.families[f], f).toMatchObject({ decision: "accepted", correct: 6 });
  });

  it("one wrong trial rejects its family and leaves the others accepted (6/6: no majority)", async () => {
    const truthful = sequenceOracle(materials, "truthful");
    let lighting = 0;
    const { report } = await run((req, n) => {
      const data = req.turns[0]!.parts.find((p) => p.type === "text" && p.text.startsWith("DATA"));
      const isLighting = data?.type === "text" && data.text.includes("cut:lighting");
      if (isLighting && ++lighting === 6) {
        const step = truthful(req, n) as Extract<FakeStep, { kind: "json" }>;
        const body = structuredClone(step.body) as { criteria: Array<{ result: string }> };
        body.criteria[0]!.result = body.criteria[0]!.result === "pass" ? "fail" : "pass";
        return { kind: "json", body };
      }
      return truthful(req, n);
    });
    expect(report.families.lighting).toMatchObject({ decision: "rejected", correct: 5 });
    expect(decisions(report).screen_direction).toBe("accepted");
    expect(Object.values(decisions(report)).filter((d) => d === "accepted")).toHaveLength(9);
  });
});

describe("screen direction needs temporal evidence", () => {
  const onlyDirectionRejected = async (behaviour: OracleBehaviour) => {
    const { report } = await run(behaviour);
    expect(report.status).toBe("completed");
    expect(report.families.screen_direction).toMatchObject({ decision: "rejected", correct: 0 });
    const t = report.trials.find((x) => x.family === "screen_direction")!;
    expect(t).toMatchObject({ temporalGrade: "insufficient", correct: false, bothSides: true });
    expect(t.result).toBe(t.expected);
    for (const f of SEMANTIC_CUT_FAMILIES.filter((x) => x !== "screen_direction"))
      expect(report.families[f], f).toMatchObject({ decision: "accepted", correct: 6 });
  };
  it("the right answer on stills alone is not accepted", () => onlyDirectionRejected("direction_still_only"));
  it("an interval on one side only is not accepted", () =>
    onlyDirectionRejected("direction_one_side_temporal"));
  it("intervals under the frozen minimum are not accepted", () =>
    onlyDirectionRejected("direction_short_interval"));
  it("valid intervals on both sides are accepted", async () => {
    const { report } = await run("truthful");
    expect(report.families.screen_direction).toMatchObject({ decision: "accepted", correct: 6 });
    expect(report.trials.find((x) => x.family === "screen_direction")!.temporalGrade).toBe("sufficient");
    expect(report.trials.find((x) => x.family === "axis")!.temporalGrade).toBe("not_applicable");
  });
});

describe("the grader", () => {
  const f = (id: string) => SEQUENCE_FIXTURES.find((x) => x.id === id) as SequenceCalibrationFixture;
  const finding = (result: "pass" | "warn" | "fail" | "unchecked", inputs: string[]) => ({
    criterionKey: "k",
    result,
    confidence: 0.9,
    summary: "s",
    evidence: inputs.map((input) => ({
      input,
      assetId: null,
      atMs: null,
      endMs: null,
      observation: "o",
      source: "output_frame" as const,
    })),
    contradictions: [],
    limitations: [],
  });
  const both = ["left:last", "right:first"];
  const edge = stubEdges("x");
  it("the strict table", () => {
    const grade = (id: string, r: "pass" | "warn" | "fail" | "unchecked", inputs = both) =>
      gradeSequenceTrial(f(id), finding(r, inputs), edge).correct;
    expect(grade("axis-positive", "pass")).toBe(true);
    expect(grade("axis-positive", "warn")).toBe(false);
    expect(grade("axis-positive", "fail")).toBe(false);
    expect(grade("axis-positive", "unchecked")).toBe(false);
    expect(grade("axis-conflict", "fail")).toBe(true);
    expect(grade("axis-conflict", "warn")).toBe(false);
    expect(grade("axis-conflict", "pass")).toBe(false);
    expect(grade("axis-conflict", "unchecked")).toBe(false);
    expect(gradeSequenceTrial(f("axis-conflict"), null, edge).correct).toBe(false);
  });
  it("the right verdict still needs edge evidence from both sides; a reference does not count", () => {
    const grade = (inputs: string[]) => gradeSequenceTrial(f("axis-conflict"), finding("fail", inputs), edge);
    expect(grade(["left:last"])).toMatchObject({ correct: false, bothSides: false });
    expect(grade(["left:last", "ref:right:look:1"])).toMatchObject({ correct: false, bothSides: false });
  });
});

describe("corrections", () => {
  it("a corrected answer is a valid trial, recorded and flagged for owner review, never a clean first pass", async () => {
    const { report } = await run("malformed_then_truthful");
    expect(report.correctionAttempts).toBe(60);
    expect(report.transportCalls).toBe(120);
    expect(report.trials[0]).toMatchObject({
      correct: true,
      correctionUsed: true,
      correctionValidated: true,
    });
    expect(report.corrections[0]).toMatchObject({
      fixture: SEQUENCE_FIXTURES[0]!.id,
      trial: 1,
      validated: true,
    });
    for (const f of SEMANTIC_CUT_FAMILIES)
      expect(report.families[f]).toMatchObject({
        decision: "accepted",
        corrections: 6,
        ownerReviewRequired: true,
      });
    expect(SEQUENCE_CALIBRATION_ACCEPTANCE.correctionRule).toContain("owner review");
  });

  it("a ceiling above the envelope authorizes nothing more: it is clamped to 120", async () => {
    const { report } = await run("malformed_then_truthful", { maxTransportCalls: 500 });
    expect(report.transportCeiling).toBe(120);
    expect(report.transportCalls).toBe(120);
    expect(report.correctionAttempts).toBe(60);
  });

  it("an ordinary run uses only the 60 primaries, whatever it is authorized for", async () => {
    const { report } = await run("truthful", { maxTransportCalls: 120 });
    expect(report.transportCalls).toBe(60);
    expect(report.correctionAttempts).toBe(0);
  });
});

describe("refusals before the first request", () => {
  const refused = async (args: Partial<Parameters<typeof runSequenceCalibration>[0]>, re: RegExp) => {
    const transport = new FakeGeminiTransport(sequenceOracle(materials, "truthful"));
    await expect(
      runSequenceCalibration({
        provider: calibrationProvider(transport),
        materials,
        maxTransportCalls: 120,
        maxUsd: 5,
        now: NOW,
        ...args,
      }),
    ).rejects.toThrow(re);
    expect(transport.calls).toBe(0);
  };
  it("a ceiling of the 60 primaries: corrections would silently vanish", () =>
    refused({ maxTransportCalls: 60 }, /at least 120/));
  it("a ceiling one short of the envelope", () => refused({ maxTransportCalls: 119 }, /at least 120/));
  it("a non-integer request ceiling", () => refused({ maxTransportCalls: 120.5 }, /at least 120/));
  it("NaN dollars", () => refused({ maxUsd: Number.NaN }, /finite dollar/));
  it("a worst case above the dollars", () => refused({ maxUsd: 0.01 }, /worst-case estimate/));
  it("live without declared limits", () => refused({ live: true }, /RPM\/TPM\/RPD/));
  it("TPM below the paced worst case", () =>
    refused(
      { ...LIVE, quota: { maxRpm: 100, maxTpm: 1000, maxRpd: 1000 } },
      /tokens\/min, above the TPM limit/,
    ));
  it("RPD one short of the 120-request envelope, not merely the 60 primaries", () =>
    refused({ ...LIVE, quota: { maxRpm: 10, maxTpm: 10_000_000, maxRpd: 119 } }, /above the RPD limit/));
  it("a clip over the inline threshold: v1 is inline-only", async () => {
    const big = new Map(materials);
    const id = SEQUENCE_FIXTURES[7]!.id;
    big.set(id, stubEdges(id, GeminiAnalysisProvider.INLINE_VIDEO_MAX_BYTES + 1));
    const provider = calibrationProvider(new FakeGeminiTransport([]));
    expect(inlineOnlyProblems(provider, big)[0]).toContain(id);
    await refused({ materials: big }, /inline-only/);
  });
  it("an unknown price blocks the run", async () => {
    const transport = new FakeGeminiTransport([]);
    const provider = new GeminiAnalysisProvider({
      config: calibrationConfig(),
      transport,
      pricing: { version: "none", models: [] } as never,
      testCrossCutCalibration: { version: "x", acceptedFamilies: [...SEMANTIC_CUT_FAMILIES] },
    });
    await expect(
      runSequenceCalibration({ provider, materials, maxTransportCalls: 120, maxUsd: 5, now: NOW }),
    ).rejects.toThrow(/unknown cost blocks/);
  });
  it("a provider that accepts no family plans nothing: production Gemini can never run the calibration", async () => {
    const transport = new FakeGeminiTransport([]);
    const provider = new GeminiAnalysisProvider({ config: calibrationConfig(), transport });
    await expect(
      runSequenceCalibration({ provider, materials, maxTransportCalls: 120, maxUsd: 5, now: NOW }),
    ).rejects.toThrow(/must plan exactly one sequence batch/);
    expect(transport.calls).toBe(0);
  });
});

describe("a live run proves it is the reviewed experiment, at the runner itself", () => {
  const liveRun = async (
    o: Partial<Parameters<typeof runSequenceCalibration>[0]>,
    transport = new FakeGeminiTransport(sequenceOracle(materials, "truthful")),
  ) => ({
    transport,
    result: await runSequenceCalibration({
      provider: calibrationProvider(transport),
      materials,
      maxTransportCalls: 120,
      maxUsd: 5,
      now: NOW,
      ...LIVE,
      ...o,
    }).then(
      (report) => ({ report, error: null }),
      (error: Error) => ({ report: null, error }),
    ),
  });
  const refusedAtZero = async (o: Parameters<typeof liveRun>[0], re: RegExp) => {
    const { result, transport } = await liveRun(o);
    expect(result.error?.message).toMatch(re);
    expect(result.error?.message).toMatch(/nothing was sent/);
    expect(transport.calls).toBe(0);
  };
  const providerWith = (env: Record<string, string>) =>
    new GeminiAnalysisProvider({
      config: readGeminiConfig({
        PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
        GEMINI_API_KEY: "test-key-not-a-real-credential",
        PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
        ...env,
      }),
      transport: new FakeGeminiTransport(sequenceOracle(materials, "truthful")),
      testCrossCutCalibration: calibrationProvider(new FakeGeminiTransport([])).crossCutCalibration(),
    });
  const pre = stubPreregistration(materials);

  it("no preregistration", () =>
    refusedAtZero({ livePreregistration: undefined }, /needs a matching preregistration/));
  it("a wrong input hash", () =>
    refusedAtZero({ livePreregistration: { ...pre, inputHash: "0".repeat(64) } }, /input hash/));
  it("the real constant over media that hash differently", () =>
    refusedAtZero({ livePreregistration: SEQUENCE_CALIBRATION_PREREGISTERED }, /input hash/));
  it("a wrong definition hash", () =>
    refusedAtZero({ livePreregistration: { ...pre, definitionHash: "0".repeat(64) } }, /definition hash/));
  it("a preregistration naming another protocol", () =>
    refusedAtZero(
      { livePreregistration: { ...pre, protocol: { ...pre.protocol, promptVersion: "other" } } },
      /protocol is not this calibration version's/,
    ));
  it("a wrong model", () =>
    refusedAtZero(
      { provider: providerWith({ PRISM_STUDIO_GEMINI_ANALYSIS_MODEL: "gemini-3.6-flash" }) },
      /model is gemini-3\.6-flash/,
    ));
  it("a wrong thinking level", () =>
    refusedAtZero(
      { provider: providerWith({ PRISM_STUDIO_GEMINI_THINKING_LEVEL: "HIGH" }) },
      /thinkingLevel is HIGH/,
    ));
  it("a wrong timeout", () =>
    refusedAtZero(
      { provider: providerWith({ PRISM_STUDIO_GEMINI_TIMEOUT_MS: "5000" }) },
      /timeoutMs is 5000/,
    ));
  it("a wrong output cap", () => {
    const provider = providerWith({});
    const real = provider.inferenceSettings.bind(provider);
    provider.inferenceSettings = () => ({ ...real(), maxOutputTokensCap: 4096 });
    return refusedAtZero({ provider }, /maxOutputTokensCap is 4096/);
  });
  it("a provider whose settings cannot be read", () => {
    const provider = providerWith({}) as unknown as { inferenceSettings?: unknown };
    provider.inferenceSettings = undefined;
    return refusedAtZero({ provider: provider as never }, /thinkingLevel is unknown/);
  });
  it("a wrong ffmpeg build, even with identical media", () =>
    refusedAtZero(
      { processorIdentity: { ...REVIEWED_PROCESSOR, toolVersion: "8.0-other" } },
      /media processor is ffmpeg\/1 \(8\.0-other\)/,
    ));
  it("a wrong adapter version", () =>
    refusedAtZero(
      { processorIdentity: { ...REVIEWED_PROCESSOR, adapterVersion: "2" } },
      /media processor is ffmpeg\/2/,
    ));
  it("an unknown processor", () =>
    refusedAtZero({ processorIdentity: undefined }, /media processor is unknown/));

  it("the exact reviewed identity may proceed, and the report records it", async () => {
    const { result, transport } = await liveRun({});
    expect(result.error).toBeNull();
    expect(transport.calls).toBe(60);
    expect(result.report).toMatchObject({
      transport: "live",
      status: "completed",
      livePreregistrationVerified: true,
      matchesPreregisteredHash: true,
      processor: REVIEWED_PROCESSOR,
      protocol: SEQUENCE_CALIBRATION_PROTOCOL,
    });
    expect(result.report!.quota!.plannedAnalysisRequests).toBe(120);
  });

  it("the RPD preflight allows exactly the 120-request envelope", async () => {
    const { result } = await liveRun({ quota: { maxRpm: 1000, maxTpm: 100_000_000, maxRpd: 120 } });
    expect(result.error).toBeNull();
    expect(result.report!.quota!.plannedAnalysisRequests).toBe(120);
  });

  it("offline runs stay free to use arbitrary materials without a preregistration", async () => {
    const { report } = await run("truthful");
    expect(report.livePreregistrationVerified).toBe(false);
    expect(report.matchesPreregisteredHash).toBe(false);
    expect(report.status).toBe("completed");
  });
});

describe("run control: fail fast, never retry", () => {
  const err = (
    category: GeminiTransportError["category"],
    status: number | null,
    message = "provider said no",
  ) => new GeminiTransportError(category, status, message);
  for (const [status, category, reason] of [
    [401, "auth", "provider_authentication_error"],
    [402, "invalid_input", "provider_billing_error"],
    [403, "auth", "provider_authorization_error"],
    [404, "invalid_input", "provider_model_unavailable"],
  ] as const)
    it(`the first ${status} aborts: not measured, not a quality result`, async () => {
      const { report, transport } = await run({ error: err(category, status) });
      expect(transport.calls).toBe(1);
      expect(report.status).toBe("aborted_provider");
      expect(report.abort?.reason).toBe(reason);
      for (const f of SEMANTIC_CUT_FAMILIES) expect(report.families[f].decision).toBe("not_measured");
      expect(report.costStatus).toBe("unknown");
      expect(report.actualUsd).toBeNull();
    });

  it("the first 429 aborts, and says quota or billing only when the provider did", async () => {
    const plain = await run({ error: err("rate_limit", 429, "slow down") });
    expect(plain.transport.calls).toBe(1);
    expect(plain.report.abort?.reason).toBe("quota_or_rate_limit");
    const billing = await run({ error: err("rate_limit", 429, "You exceeded your current quota") });
    expect(billing.report.abort?.reason).toBe("quota_or_billing_exhausted");
  });

  it(`${SEQUENCE_RUN_CONTROL.maxConsecutive5xx} consecutive 5xx abort; a single one is only an error trial`, async () => {
    const { report, transport } = await run({ error: err("server_error", 500) });
    expect(transport.calls).toBe(3);
    expect(report.abort?.reason).toBe("provider_unavailable");
    const truthful = sequenceOracle(materials, "truthful");
    const single = await run((req, n) =>
      n === 0 ? { kind: "error", error: err("server_error", 500) } : truthful(req, n),
    );
    expect(single.report.status).toBe("completed");
    expect(single.report.trialsAttempted).toBe(60);
    expect(single.transport.calls).toBe(60); // never retried
    expect(single.report.families[SEQUENCE_FIXTURES[0]!.family]).toMatchObject({
      decision: "rejected",
      correct: 5,
    });
  });

  it("2 consecutive identical 400s abort as a request-contract failure, not 60 burned requests", async () => {
    const { report, transport } = await run({ error: err("invalid_input", 400, "Invalid schema 123456") });
    expect(transport.calls).toBe(2);
    expect(report.abort?.reason).toBe("request_contract_invalid");
    let n400 = 0;
    const different = await run(() => ({
      kind: "error",
      error: err("invalid_input", 400, n400++ % 2 ? "bad alpha" : "bad beta"),
    }));
    expect(different.report.status).toBe("completed");
  });

  it("an ambiguous timeout is an unanswered trial, never retried; repeated ones abort", async () => {
    const truthful = sequenceOracle(materials, "truthful");
    const once = await run((req, n) =>
      n === 0 ? { kind: "error", error: err("timeout", null) } : truthful(req, n),
    );
    expect(once.transport.calls).toBe(60);
    expect(once.report.trials[0]).toMatchObject({ result: "error", errorCategory: "outcome_unknown" });
    expect(once.report.costStatus).toBe("unknown");
    expect(once.report.actualUsd).toBeNull();
    expect(once.report.knownUsageUsd).toBeGreaterThan(0);
    const repeated = await run({ error: err("network", null) });
    expect(repeated.transport.calls).toBe(SEQUENCE_RUN_CONTROL.maxConsecutiveOutcomeUnknown);
    expect(repeated.report.abort?.reason).toBe("outcome_unknown_repeated");
  });

  it("known usage above the dollar ceiling stops the run", async () => {
    const truthful = sequenceOracle(materials, "truthful");
    const { report } = await run((req, n) => {
      const step = truthful(req, n) as Extract<FakeStep, { kind: "json" }>;
      return { ...step, usage: { promptTokens: 10_000_000, candidatesTokens: 1_000_000 } };
    });
    expect(report.status).toBe("aborted_local_policy");
    expect(report.abort?.reason).toBe("local_policy");
    expect(report.transportCalls).toBeLessThan(60);
  });
});

describe("cost honesty", () => {
  it("every generation reported usage: a known figure", async () => {
    const { report } = await run("truthful");
    expect(report.costStatus).toBe("known");
    expect(report.actualUsd).toBeGreaterThan(0);
    expect(report.actualUsd).toBe(report.knownUsageUsd);
    expect(report.usageReportedCalls).toBe(60);
  });
  it("a call without usage: UNKNOWN, with the known usage as a lower bound", async () => {
    const truthful = sequenceOracle(materials, "truthful");
    const { report } = await run((req, n) => {
      const step = truthful(req, n) as Extract<FakeStep, { kind: "json" }>;
      return n === 5
        ? {
            ...step,
            usage: {
              promptTokens: undefined as never,
              candidatesTokens: undefined as never,
              thoughtsTokens: undefined as never,
            },
          }
        : step;
    });
    expect(report.costStatus).toBe("unknown");
    expect(report.actualUsd).toBeNull();
    expect(report.knownUsageUsd).toBeGreaterThan(0);
  });
  it("an access failure proves nothing about its billing: UNKNOWN, not zero", async () => {
    const { report } = await run({ error: new GeminiTransportError("auth", 403, "no") });
    expect(report.actualUsd).toBeNull();
    expect(report.costStatus).toBe("unknown");
  });
  it("the estimate is the real one: worst case over 120 requests, above the expected cost", async () => {
    const { report } = await run("truthful");
    const e = report.estimate;
    expect(e.perFixture).toHaveLength(20);
    expect(e.worstCaseTransportRequests).toBe(120);
    expect(e.worstCaseUsd).toBeGreaterThan(e.expectedUsd);
    expect(e.expectedUsd).toBeGreaterThan(0);
    expect(e.estimatedInputTokens).toBeGreaterThan(0);
    const sum = e.perFixture.reduce((n, p) => n + p.maxUsd, 0) * 3;
    expect(e.worstCaseUsd).toBeCloseTo(sum, 5);
  });
});

describe("pacing", () => {
  it("starts no faster than floor(RPM × 0.8), corrections included, with an injected clock", async () => {
    let t = 0;
    const waits: number[] = [];
    const transport = new FakeGeminiTransport(sequenceOracle(materials, "malformed_then_truthful"));
    const report = await runSequenceCalibration({
      provider: calibrationProvider(transport),
      materials,
      maxTransportCalls: 120,
      maxUsd: 5,
      now: NOW,
      ...LIVE,
      quota: { maxRpm: 10, maxTpm: 10_000_000, maxRpd: 1000 },
      clock: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    expect(report.quota).toMatchObject({
      effectiveRpm: 8,
      minIntervalMs: 7500,
      plannedAnalysisRequests: 120,
    });
    expect(waits).toHaveLength(119);
    expect(waits.every((w) => w === 7500)).toBe(true);
    expect(report.transport).toBe("live");
  });
});

describe("the real SDK transport over a stubbed fetch", () => {
  it("one request per call: a 5xx is one fetch, and a sequence request reaches it with both clips inline", async () => {
    let fetches = 0;
    let body = "";
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      fetches += 1;
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ error: { code: 500, message: "boom", status: "INTERNAL" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const provider = calibrationProvider(new SdkGeminiTransport({ apiKey: "test-key", fetchImpl }));
    const f = SEQUENCE_FIXTURES[0]!;
    const edge = materials.get(f.id)!;
    const input = fixtureInput(f, 0, edge, provider);
    await expect(
      provider.analyzeBatch({
        batch: input.plan.batches[0]!,
        input,
        media: edgeMediaMap(edge),
        ctx: { now: () => NOW, sleep: async () => undefined, canCorrect: () => true },
      }),
    ).rejects.toMatchObject({ httpStatus: 500 });
    expect(fetches).toBe(1);
    expect(body).toContain('"video/mp4"');
    expect((body.match(/video\/mp4/g) ?? []).length).toBe(2);
    expect(body).toContain('"fps":4');
  });
});
