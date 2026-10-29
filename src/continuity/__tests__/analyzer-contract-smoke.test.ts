import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processor } from "../analysis/__tests__/queue-harness";
import {
  DIAGNOSTIC_CLIP,
  DIAGNOSTIC_CRITERION,
  SMOKE_LIMITS,
  runAnalyzerContractSmoke,
  runSmokeCli,
  smokeInput,
} from "../calibration/analyzer-contract-smoke";
import { TEMPORAL_FIXTURES, renderFixture } from "../calibration/temporal-calibration";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { readGeminiConfig } from "../providers/gemini/config";
import { FakeGeminiTransport, answerAll, type FakeStep } from "../providers/gemini/fake-transport";
import { geminiResponseJsonSchema } from "../providers/gemini/response-schema";
import { GeminiTransportError, type GeminiRequest } from "../providers/gemini/transport";

/**
 * The analyzer-contract smoke, offline: fake transports, a trapped fetch, stub bytes (one test renders the real
 * diagnostic clip with ffmpeg). Nothing leaves the process.
 */
vi.setConfig({ testTimeout: 120_000 });
const hasFfmpeg = await processor.available();
const cfg = readGeminiConfig({
  PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
  GEMINI_API_KEY: "k",
  PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
});
const bytes = new Uint8Array(4096).fill(3);
const render = async () => bytes;
const at = new Date("2026-11-01");
const make = (step: (r: GeminiRequest, n: number) => FakeStep) => {
  const transport = new FakeGeminiTransport(step);
  return { transport, provider: new GeminiAnalysisProvider({ config: cfg, transport }) };
};

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

describe("analyzer-contract smoke: the real analyzer request on a non-calibration clip", () => {
  it("is never a calibration fixture: diagnostic ids, a sacrificial criterion, no calibration truth", () => {
    const { provider } = make(answerAll());
    const input = smokeInput(provider, bytes);
    expect(input.media[0]!.assetId).toBe(`diagnostic:${DIAGNOSTIC_CLIP.id}`);
    expect(input.criteria.map((c) => c.key)).toEqual([DIAGNOSTIC_CRITERION.key]);
    expect(TEMPORAL_FIXTURES.some((f) => (f.criterion as string) === DIAGNOSTIC_CRITERION.key)).toBe(false);
    expect(TEMPORAL_FIXTURES.some((f) => f.id === DIAGNOSTIC_CLIP.id)).toBe(false);
    expect(TEMPORAL_FIXTURES.some((f) => f.expected === DIAGNOSTIC_CRITERION.expected)).toBe(false);
    expect(input.plan.batches).toHaveLength(1);
    expect(input.plan.batches[0]!.mode).toBe("direct_video");
  });

  it("PASS: one request, the compact batch-aware schema at 4 fps, the answer validated locally", async () => {
    const { transport, provider } = make(answerAll("pass"));
    const sent: GeminiRequest[] = [];
    const real = transport.generate.bind(transport);
    transport.generate = async (r) => (sent.push(r), real(r));
    const r = await runAnalyzerContractSmoke({ provider, maxUsd: 0.05, render, now: at });
    expect(r).toMatchObject({
      status: "pass",
      providerAccepted: true,
      localValidation: "ok",
      httpStatus: 200,
      requests: 1,
      uploadAttempts: 0,
      mode: "direct_video",
      costStatus: "known",
      analyzerVersion: "3",
    });
    expect(r.finding).toEqual({ result: "pass", evidence: expect.any(Number) });
    expect(transport.calls).toBe(1);
    expect(transport.requests[0]!.videoFps).toEqual([4]);
    expect(sent[0]!.responseJsonSchema).toEqual(geminiResponseJsonSchema("direct_video", 1));
  });

  it("HTTP 400 → provider_rejected after exactly one request (no retry, no correction), cost UNKNOWN", async () => {
    const { transport, provider } = make(() => ({
      kind: "error",
      error: new GeminiTransportError(
        "invalid_input",
        400,
        "Gemini returned HTTP 400: Request contains an invalid argument.",
      ),
    }));
    const r = await runAnalyzerContractSmoke({ provider, maxUsd: 0.05, render, now: at });
    expect(transport.calls).toBe(1);
    expect(r).toMatchObject({
      status: "provider_rejected",
      providerAccepted: false,
      localValidation: "not_reached",
      httpStatus: 400,
      requests: 1,
      actualUsd: null,
      costStatus: "unknown",
      finding: null,
    });
  });

  it("HTTP 200 with an answer Prism rejects → provider ACCEPTED but local validation FAILED (not a pass)", async () => {
    const { transport, provider } = make(() => ({ kind: "json", body: { ok: true } }));
    const r = await runAnalyzerContractSmoke({ provider, maxUsd: 0.05, render, now: at });
    expect(transport.calls).toBe(1); // no correction request
    expect(r).toMatchObject({
      status: "provider_accepted_local_invalid",
      providerAccepted: true,
      localValidation: "failed",
      httpStatus: 200,
    });
  });

  it("a timeout is outcome_unknown (never re-sent) with UNKNOWN cost", async () => {
    const { transport, provider } = make(() => ({
      kind: "error",
      error: new GeminiTransportError("timeout", null, "timed out"),
    }));
    const r = await runAnalyzerContractSmoke({ provider, maxUsd: 0.05, render, now: at });
    expect(transport.calls).toBe(1);
    expect(r).toMatchObject({ status: "outcome_unknown", costStatus: "unknown", actualUsd: null });
  });

  it("refuses BEFORE sending when the estimate exceeds the smoke's own $0.05 cap, whatever the caller asks", async () => {
    const { transport, provider } = make(answerAll());
    const real = provider.estimate.bind(provider);
    provider.estimate = (i, n) => ({ ...real(i, n), maxUsd: 0.06 });
    await expect(runAnalyzerContractSmoke({ provider, maxUsd: 10, render, now: at })).rejects.toThrow(
      /nothing was sent/,
    );
    provider.estimate = (i, n) => ({ ...real(i, n), maxUsd: Number.NaN });
    await expect(runAnalyzerContractSmoke({ provider, maxUsd: 0.05, render, now: at })).rejects.toThrow(
      /nothing was sent/,
    );
    expect(transport.calls).toBe(0);
    expect(SMOKE_LIMITS).toEqual({ maxRequests: 1, maxUsd: 0.05 });
  });

  it.skipIf(!hasFfmpeg)("the diagnostic clip is new: its pixels match no calibration fixture", async () => {
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    const clip = sha(await renderFixture({ ...DIAGNOSTIC_CLIP, audio: undefined }));
    const fixtures = await Promise.all(TEMPORAL_FIXTURES.map(async (f) => sha(await renderFixture(f))));
    expect(fixtures).not.toContain(clip);
  });
});

describe("smoke CLI", () => {
  const LIVE = [
    "--live",
    "--model",
    "gemini-3.8-flash",
    "--max-usd",
    "0.05",
    "--i-understand-this-sends-synthetic-video-and-costs-money",
    "--out",
    "smoke.json",
  ];
  const ENV = {
    PRISM_STUDIO_TEMPORAL_CALIBRATION_LIVE: "1",
    PRISM_STUDIO_ALLOW_PAID_ANALYSIS: "1",
    GEMINI_API_KEY: "test-key-not-a-real-credential",
  };
  const cli = async (
    argv: readonly string[],
    env: Record<string, string | undefined>,
    transport?: FakeGeminiTransport,
  ) => {
    const errors: string[] = [];
    const written: string[] = [];
    const factory = vi.fn(async () => transport ?? new FakeGeminiTransport(answerAll()));
    const code = await runSmokeCli({
      argv,
      env,
      createLiveTransport: factory,
      log: () => undefined,
      error: (l) => void errors.push(l),
      writeReport: (_p, j) => void written.push(j),
    });
    return { code, errors, written, factory };
  };

  for (const [name, argv, env, reason] of [
    ["no acknowledgement", LIVE.filter((a) => !a.startsWith("--i-understand")), ENV, /--i-understand/],
    [
      "live flag unset",
      LIVE,
      { ...ENV, PRISM_STUDIO_TEMPORAL_CALIBRATION_LIVE: undefined },
      /CALIBRATION_LIVE/,
    ],
    ["paid flag off", LIVE, { ...ENV, PRISM_STUDIO_ALLOW_PAID_ANALYSIS: "false" }, /ALLOW_PAID_ANALYSIS/],
    [
      "unverified model",
      LIVE.map((a) => (a === "gemini-3.8-flash" ? "gemini-unverified" : a)),
      ENV,
      /unverified/,
    ],
    ["invalid --max-usd", LIVE.map((a) => (a === "0.05" ? "Infinity" : a)), ENV, /--max-usd/],
    ["no credential", LIVE, { ...ENV, GEMINI_API_KEY: undefined }, /GEMINI_API_KEY/],
  ] as const) {
    it(`refuses (${name}) with exit 2 before any transport exists`, async () => {
      const r = await cli(argv, env);
      expect(r.code).toBe(2);
      expect(r.errors[0]).toMatch(/^REFUSED: /);
      expect(r.errors[0]).toMatch(reason);
      expect(r.errors[0]).toMatch(/Nothing was sent\.$/);
      expect(r.factory).not.toHaveBeenCalled();
      expect(r.written).toEqual([]);
    });
  }

  it.skipIf(!hasFfmpeg)("live (fake transport) PASS → exit 0; a 400 → exit 3 after one request", async () => {
    const ok = await cli(LIVE, ENV, new FakeGeminiTransport(answerAll("pass")));
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.written[0]!).status).toBe("pass");
    const bad = new FakeGeminiTransport(() => ({
      kind: "error",
      error: new GeminiTransportError("invalid_input", 400, "Gemini returned HTTP 400"),
    }));
    const rejected = await cli(LIVE, ENV, bad);
    expect(rejected.code).toBe(3);
    expect(bad.calls).toBe(1);
    expect(JSON.parse(rejected.written[0]!)).toMatchObject({ status: "provider_rejected", httpStatus: 400 });
    expect(rejected.written[0]).not.toContain(ENV.GEMINI_API_KEY);
  });
});
