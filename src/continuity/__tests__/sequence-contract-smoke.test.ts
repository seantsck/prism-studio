import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geminiResponseJsonSchema } from "../providers/gemini/response-schema";
import {
  runSequenceContractSmoke,
  runSequenceSmokeCli,
  sequenceSmokeIdentity,
  SEQUENCE_DIAGNOSTIC,
  SEQUENCE_DIAGNOSTIC_CRITERION,
  SEQUENCE_SMOKE_LIMITS,
  smokeFakeAnswer,
} from "../calibration/sequence-contract-smoke";
import { SEQUENCE_FIXTURES } from "../calibration/sequence-fixtures";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { FakeGeminiTransport } from "../providers/gemini/fake-transport";
import { GeminiTransportError, type GeminiRequest } from "../providers/gemini/transport";
import { calibrationConfig, stubEdges } from "./sequence-calibration-stub";

/** Phase 3A.4E: the sequence analyzer-contract smoke, offline. One request, no upload, no correction, no truth. */
const sdk = vi.hoisted(() => ({ created: 0 }));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    constructor() {
      sdk.created += 1;
      throw new Error("the Gemini SDK client must not be created in this test");
    }
  },
}));

let realFetch: typeof fetch;
let outbound = 0;
beforeEach(() => {
  sdk.created = 0;
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
  expect(sdk.created).toBe(0);
});

const edges = stubEdges("diagnostic");
const provider = (script: ConstructorParameters<typeof FakeGeminiTransport>[0]) => {
  const transport = new FakeGeminiTransport(script);
  return {
    transport,
    provider: new GeminiAnalysisProvider({
      config: calibrationConfig(),
      transport,
      testCrossCutCalibration: sequenceSmokeIdentity(),
    }),
  };
};
const smoke = (p: GeminiAnalysisProvider, e = edges) =>
  runSequenceContractSmoke({ provider: p, maxUsd: 0.05, edges: e, now: new Date("2026-11-01T00:00:00Z") });

describe("the smoke", () => {
  it("sends exactly one sequence request: two clips, two stills, sided ids, the production schema", async () => {
    let req: GeminiRequest | null = null;
    const answer = smokeFakeAnswer();
    const { provider: p, transport } = provider((r) => {
      req = r;
      return answer(r);
    });
    const report = await smoke(p);
    expect(report).toMatchObject({
      status: "pass",
      providerAccepted: true,
      localValidation: "ok",
      analyzerVersion: "gemini-sequence-1",
      mode: "sequence_transition",
      prompt: "continuity-gemini-transition-v1",
      requests: 1,
      uploadAttempts: 0,
      correctionAttempts: 0,
      costStatus: "known",
      finding: { result: "pass", evidence: 2 },
    });
    expect(transport.calls).toBe(1);
    expect(transport.uploads).toEqual([]);
    expect(transport.requests[0]).toMatchObject({
      inlineMedia: 4,
      inlineVideos: 2,
      fileParts: 0,
      videoFps: [4, 4],
    });
    const sent = req! as GeminiRequest;
    expect(sent.responseJsonSchema).toEqual(geminiResponseJsonSchema("sequence_transition", 1));
    const text = sent.turns[0]!.parts.flatMap((x) => (x.type === "text" ? [x.text] : [])).join("\n");
    for (const id of ["left:clip", "right:clip", "left:last", "right:first"]) expect(text).toContain(id);
    expect(text).toContain(SEQUENCE_DIAGNOSTIC_CRITERION.key);
  });

  it("carries no calibration fixture or truth", async () => {
    let text = "";
    const answer = smokeFakeAnswer();
    const { provider: p } = provider((r) => {
      text = r.turns[0]!.parts.flatMap((x) => (x.type === "text" ? [x.text] : [])).join("\n");
      return answer(r);
    });
    await smoke(p);
    for (const f of SEQUENCE_FIXTURES) {
      expect(text).not.toContain(f.id);
      expect(text).not.toContain(f.description);
      expect(f.left.video).not.toBe(SEQUENCE_DIAGNOSTIC.video);
    }
    expect(SEQUENCE_FIXTURES.some((f) => f.left.video.includes("0x1e3a5f"))).toBe(false);
  });

  it("an invalid answer is never corrected: one request, local invalid", async () => {
    const { provider: p, transport } = provider([{ kind: "text", text: "not json" }]);
    const report = await smoke(p);
    expect(report).toMatchObject({
      status: "provider_accepted_local_invalid",
      localValidation: "failed",
      providerAccepted: true,
      requests: 1,
      correctionAttempts: 0,
    });
    expect(transport.calls).toBe(1);
  });

  it("one-sided evidence is a contract failure the local validator catches", async () => {
    const { provider: p, transport } = provider([
      {
        kind: "json",
        body: {
          criteria: [
            {
              criterionId: SEQUENCE_DIAGNOSTIC_CRITERION.key,
              result: "pass",
              confidence: 0.9,
              summary: "s",
              evidence: [{ input: "left:last", timestampMs: null, endMs: null, observation: "o" }],
              contradictions: [],
              limitations: [],
            },
          ],
        },
      },
    ]);
    expect((await smoke(p)).status).toBe("provider_accepted_local_invalid");
    expect(transport.calls).toBe(1);
  });

  it("a provider 400 is a rejection, with no retry", async () => {
    const { provider: p, transport } = provider([
      { kind: "error", error: new GeminiTransportError("invalid_input", 400, "Invalid response schema") },
    ]);
    const report = await smoke(p);
    expect(report).toMatchObject({ status: "provider_rejected", httpStatus: 400, providerAccepted: false });
    expect(transport.calls).toBe(1);
    expect(report.costStatus).toBe("unknown");
    expect(report.actualUsd).toBeNull();
  });

  it("an ambiguous timeout is reported as such, with no retry", async () => {
    const { provider: p, transport } = provider([
      { kind: "error", error: new GeminiTransportError("timeout", null, "timed out") },
    ]);
    expect((await smoke(p)).status).toBe("outcome_unknown");
    expect(transport.calls).toBe(1);
  });

  it("refuses before sending: a clip that would need an upload, and a dollar ceiling under the estimate", async () => {
    const { provider: p, transport } = provider(smokeFakeAnswer());
    const big = stubEdges("big", GeminiAnalysisProvider.INLINE_VIDEO_MAX_BYTES + 1);
    await expect(smoke(p, big)).rejects.toThrow(/would need an upload; nothing was sent/);
    await expect(runSequenceContractSmoke({ provider: p, maxUsd: 0.000001, edges })).rejects.toThrow(
      /unknown or above/,
    );
    expect(transport.calls).toBe(0);
  });

  it("the ceilings are hard: operator dollars never raise $0.05", () => {
    expect(SEQUENCE_SMOKE_LIMITS).toEqual({ maxRequests: 1, maxUsd: 0.05, uploads: 0, corrections: 0 });
  });

  it("production Gemini (no family accepted) cannot plan it", async () => {
    const p = new GeminiAnalysisProvider({
      config: calibrationConfig(),
      transport: new FakeGeminiTransport([]),
    });
    await expect(smoke(p)).rejects.toThrow(/exactly one sequence batch/);
  });
});

describe("the smoke CLI", () => {
  const READY = [
    "--live",
    "--model",
    "gemini-3.8-flash",
    "--max-usd",
    "0.05",
    "--i-understand-this-sends-synthetic-video-and-costs-money",
    "--out",
    "never.json",
  ] as const;
  const ENV = {
    PRISM_STUDIO_SEQUENCE_CALIBRATION_LIVE: "1",
    PRISM_STUDIO_ALLOW_PAID_ANALYSIS: "1",
    GEMINI_API_KEY: "test-key-not-a-real-credential",
  };
  const drop = (name: string, values = 0) => {
    const i = READY.indexOf(name as (typeof READY)[number]);
    return READY.filter((_, j) => j < i || j > i + values);
  };
  async function cli(argv: readonly string[], env: Record<string, string | undefined>, big = false) {
    const errors: string[] = [];
    const logs: string[] = [];
    const written: string[] = [];
    const createLiveTransport = vi.fn(async () => new FakeGeminiTransport(smokeFakeAnswer()));
    const code = await runSequenceSmokeCli({
      argv,
      env,
      createLiveTransport,
      prepare: async () =>
        big ? stubEdges("big", GeminiAnalysisProvider.INLINE_VIDEO_MAX_BYTES + 1) : edges,
      log: (l) => void logs.push(l),
      error: (l) => void errors.push(l),
      writeReport: (_p, j) => void written.push(j),
    });
    return { code, errors, logs, written, createLiveTransport };
  }

  for (const [name, argv, env, re] of [
    [
      "no acknowledgement",
      drop("--i-understand-this-sends-synthetic-video-and-costs-money"),
      ENV,
      /--i-understand/,
    ],
    [
      "no live env",
      READY,
      { ...ENV, PRISM_STUDIO_SEQUENCE_CALIBRATION_LIVE: undefined },
      /CALIBRATION_LIVE=1/,
    ],
    ["no paid env", READY, { ...ENV, PRISM_STUDIO_ALLOW_PAID_ANALYSIS: undefined }, /ALLOW_PAID_ANALYSIS=1/],
    ["no model", drop("--model", 1), ENV, /--model is required/],
    ["no dollars", drop("--max-usd", 1), ENV, /--max-usd must be/],
    ["no credential", READY, { ...ENV, GEMINI_API_KEY: undefined }, /GEMINI_API_KEY is not set/],
  ] as const)
    it(`${name}: exit 2, zero transports`, async () => {
      const r = await cli(argv, env);
      expect(r.code).toBe(2);
      expect(r.errors.join(" ")).toMatch(re);
      expect(r.createLiveTransport).not.toHaveBeenCalled();
    });

  it("media that would need an upload refuses before any transport", async () => {
    const r = await cli(READY, ENV, true);
    expect(r.code).toBe(2);
    expect(r.errors.join(" ")).toMatch(/upload/);
    expect(r.createLiveTransport).not.toHaveBeenCalled();
  });

  it("the default is offline: no flags, no env, no factory", async () => {
    const r = await cli(["--out", "x.json"], {});
    expect(r.code).toBe(0);
    expect(r.createLiveTransport).not.toHaveBeenCalled();
    expect(r.logs.join("\n")).toContain("FAKE transport");
    expect(r.logs.join("\n")).toContain("no quality meaning");
  });

  it("with every gate passed: one factory call and an exit 0 on pass", async () => {
    const r = await cli(READY, ENV);
    expect(r.code).toBe(0);
    expect(r.createLiveTransport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(r.written[0]!)).toMatchObject({ status: "pass", requests: 1 });
  });
});
