import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { processor } from "../analysis/__tests__/queue-harness";
import { AnalysisBatchError } from "../analysis/provider";
import {
  CALIBRATION_ACCEPTANCE,
  CALIBRATION_RUN_CONTROL,
  CALIBRATION_VERSION,
  PROVIDER_ACCESS_FAILURES,
  TEMPORAL_FIXTURES,
  acceptance,
  gradeTrial,
  http429Reason,
  liveReadinessProblems,
  planQuota,
  providerAccessFailure,
  renderFixture,
  runTemporalCalibration,
  type CalibrationFixture,
} from "../calibration/temporal-calibration";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { readGeminiConfig } from "../providers/gemini/config";
import { FakeGeminiTransport, answerAll, type FakeStep } from "../providers/gemini/fake-transport";
import {
  GeminiTransportError,
  type GeminiRequest,
  type GeminiTransport,
} from "../providers/gemini/transport";

/**
 * The temporal calibration harness, run WITHOUT provider spend: synthetic fixtures rendered by ffmpeg, a fake
 * transport, the pre-registered acceptance rule. A live run is a separate authorised gate.
 */
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });
const hasFfmpeg = await processor.available();
const media = hasFfmpeg ? describe : describe.skip;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const cfg = readGeminiConfig({
  PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
  GEMINI_API_KEY: "k",
  PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
});

describe("calibration design is pre-registered", () => {
  it("every criterion has a positive AND a negative/reverse fixture; thresholds are fixed constants", () => {
    const criteria = [...new Set(TEMPORAL_FIXTURES.map((f) => f.criterion))].sort();
    expect(criteria).toEqual(
      [
        "action_continuity",
        "camera_movement",
        "eyelines",
        "forbidden_action",
        "geography",
        "lip_sync",
        "screen_direction",
      ].sort(),
    );
    for (const c of criteria) {
      const fx = TEMPORAL_FIXTURES.filter((f) => f.criterion === c);
      expect(fx.some((f) => f.correct === "pass")).toBe(true);
      expect(fx.some((f) => f.correct === "fail")).toBe(true);
    }
    expect(CALIBRATION_ACCEPTANCE).toEqual({ trials: 3, minCorrectPerFixture: 3, eventSlackMs: 500 });
    // the 2026-10-28 first live attempt got zero model answers: not an evaluated trial, so v1 stands unchanged
    expect(CALIBRATION_VERSION).toBe("temporal-calibration-v1");
    expect(TEMPORAL_FIXTURES).toHaveLength(16);
    expect(CALIBRATION_RUN_CONTROL).toEqual({ abortOnHttp429: true, maxConsecutive5xx: 3, rpmSafety: 0.8 });
    expect(new Set(TEMPORAL_FIXTURES.map((f) => f.id)).size).toBe(TEMPORAL_FIXTURES.length);
  });

  it("an empty result set accepts nothing (unchecked/errors never count)", () => {
    expect(Object.values(acceptance([])).every((v) => v === false)).toBe(true);
  });

  it("grading is strict: a deliberate conflict must be `fail` (warn/unchecked are wrong); a pass fixture needs pass", () => {
    const neg = TEMPORAL_FIXTURES.find((f) => f.id === "forbidden-occurs")!;
    const pos = TEMPORAL_FIXTURES.find((f) => f.id === "forbidden-absent")!;
    const finding = (result: "pass" | "warn" | "fail" | "unchecked", atMs: number | null = 2200) => ({
      criterionKey: neg.criterion,
      result,
      confidence: 0.8,
      summary: "s",
      evidence:
        atMs == null
          ? []
          : [{ input: "video", assetId: null, atMs, observation: "o", source: "video" as const }],
      contradictions: [],
      limitations: [],
    });
    expect(gradeTrial(neg, finding("fail")).correct).toBe(true);
    expect(gradeTrial(neg, finding("warn")).correct).toBe(false);
    expect(gradeTrial(neg, finding("unchecked", null)).correct).toBe(false);
    expect(gradeTrial(neg, finding("fail", 300)).correct).toBe(false); // evidence outside the event window
    expect(gradeTrial(pos, finding("pass")).correct).toBe(true);
    expect(gradeTrial(pos, finding("warn")).correct).toBe(false); // hallucinated "possible" forbidden action
  });
});

media("synthetic fixtures + harness (real ffmpeg, fake transport, no spend)", () => {
  const rendered = new Map<string, Uint8Array>();
  const bySum = new Map<string, CalibrationFixture>();
  beforeAll(async () => {
    for (const f of TEMPORAL_FIXTURES) {
      const b = await renderFixture(f);
      rendered.set(f.id, b);
      bySum.set(sha(b), f);
    }
  });
  const render = async (f: CalibrationFixture) => rendered.get(f.id)!;

  /** A fake analyzer that knows the truth of each clip (by checksum): exercises grading end to end. */
  const oracle = (req: GeminiRequest): FakeStep => {
    const part = req.turns[0]!.parts.find((p) => p.type === "inline");
    const f =
      part && part.type === "inline" ? bySum.get(sha(Buffer.from(part.dataBase64, "base64"))) : undefined;
    const data = JSON.parse(
      req.turns[0]!.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))[0]!.replace(/^[^{]*/, ""),
    ) as { criteria: Array<{ criterionId: string }> };
    const [a, b] = f?.eventWindowMs ?? [500, 3500];
    return {
      kind: "json",
      body: {
        criteria: data.criteria.map((c) => ({
          criterionId: c.criterionId,
          result: f?.correct === "pass" ? "pass" : "fail",
          confidence: 0.8,
          summary: f?.description ?? "?",
          evidence: [{ input: "video", timestampMs: a, endMs: Math.max(a, b), observation: "observed" }],
          contradictions: [],
          limitations: [],
        })),
      },
    };
  };
  const alwaysPass = (req: GeminiRequest): FakeStep => {
    const step = oracle(req);
    if (step.kind !== "json") return step;
    const body = step.body as { criteria: Array<{ result: string }> };
    return { ...step, body: { criteria: body.criteria.map((c) => ({ ...c, result: "pass" })) } };
  };

  it("renders every fixture deterministically, at the stated duration, with audio only where intended", async () => {
    for (const f of TEMPORAL_FIXTURES) {
      const b = rendered.get(f.id)!;
      expect(b.length).toBeGreaterThan(1000);
      const probe = await processor.probe(b);
      expect(Math.abs((probe.durationMs ?? 0) - f.durationMs)).toBeLessThan(200);
      expect(probe.hasAudio).toBe(Boolean(f.audio));
    }
    const again = await renderFixture(TEMPORAL_FIXTURES[0]!);
    expect(sha(again)).toBe(sha(rendered.get(TEMPORAL_FIXTURES[0]!.id)!));
  });

  it("a truthful (oracle) analyzer passes the pre-registered rule for every criterion", async () => {
    const transport = new FakeGeminiTransport(oracle);
    const provider = new GeminiAnalysisProvider({ config: cfg, transport });
    const report = await runTemporalCalibration({
      provider,
      render,
      maxTransportCalls: TEMPORAL_FIXTURES.length * 3,
      maxUsd: 5,
      now: new Date("2026-11-01"),
    });
    expect(Object.values(report.accepted).every(Boolean)).toBe(true);
    expect(report.transportCalls).toBe(TEMPORAL_FIXTURES.length * 3);
    expect(transport.calls).toBe(TEMPORAL_FIXTURES.length * 3);
    expect(transport.requests.every((r) => r.videoFps.length === 1 && r.videoFps[0] === 4)).toBe(true);
    expect(report.estimatedMaxUsd).toBeGreaterThan(0);
  });

  it("an analyzer that always says pass fails the rule (reverse/negative fixtures catch it); lip sync stays off", async () => {
    const provider = new GeminiAnalysisProvider({
      config: cfg,
      transport: new FakeGeminiTransport(alwaysPass),
    });
    const report = await runTemporalCalibration({
      provider,
      render,
      maxTransportCalls: TEMPORAL_FIXTURES.length * 3,
      maxUsd: 5,
      now: new Date("2026-11-01"),
    });
    expect(Object.values(report.accepted).some(Boolean)).toBe(false);
    expect(report.lipSyncCapable).toBe(false);
  });

  it("refuses BEFORE any request when the request or dollar ceiling would be exceeded", async () => {
    const transport = new FakeGeminiTransport(oracle);
    const provider = new GeminiAnalysisProvider({ config: cfg, transport });
    await expect(
      runTemporalCalibration({ provider, render, maxTransportCalls: 5, maxUsd: 5 }),
    ).rejects.toThrow(/above the ceiling/);
    await expect(
      runTemporalCalibration({ provider, render, maxTransportCalls: 1000, maxUsd: 0.000001 }),
    ).rejects.toThrow(/exceeds the ceiling/);
    expect(transport.calls).toBe(0);
  });

  it("UNKNOWN cost (NaN / Infinity / negative / missing) or an invalid ceiling blocks BEFORE any request", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, undefined]) {
      const transport = new FakeGeminiTransport(oracle);
      const provider = new GeminiAnalysisProvider({ config: cfg, transport });
      const real = provider.estimate.bind(provider);
      provider.estimate = (input, now) => ({ ...real(input, now), maxUsd: bad as number });
      await expect(
        runTemporalCalibration({ provider, render, maxTransportCalls: 1000, maxUsd: 1000 }),
      ).rejects.toThrow(/unknown cost blocks the run/);
      expect(transport.calls).toBe(0);
    }
    for (const [maxTransportCalls, maxUsd] of [
      [Number.NaN, 5],
      [1.5, 5],
      [0, 5],
      [1000, Number.NaN],
      [1000, Number.POSITIVE_INFINITY],
      [1000, 0],
    ] as const) {
      const transport = new FakeGeminiTransport(oracle);
      const provider = new GeminiAnalysisProvider({ config: cfg, transport });
      await expect(runTemporalCalibration({ provider, render, maxTransportCalls, maxUsd })).rejects.toThrow(
        /nothing was sent/,
      );
      expect(transport.calls).toBe(0);
    }
  });
});

/**
 * Run control and cost honesty (no ffmpeg needed: stub bytes, fake transport, injected clock). Nothing here waits in
 * real time or touches the network.
 */
describe("calibration run control, cost honesty and live pacing", () => {
  const bytes = new Uint8Array(4096).fill(7);
  const render = async () => bytes;
  const at = new Date("2026-11-01");
  const q429 = () =>
    new GeminiTransportError(
      "rate_limit",
      429,
      "Gemini returned HTTP 429: You exceeded your current quota, please check your plan and billing details.",
    );
  const http = (status: number) =>
    new GeminiTransportError(
      status === 503 ? "overloaded" : "server_error",
      status,
      `Gemini returned HTTP ${status}`,
    );
  const ok = answerAll("pass");
  const run = (
    transport: GeminiTransport,
    extra: Partial<Parameters<typeof runTemporalCalibration>[0]> = {},
  ) =>
    runTemporalCalibration({
      provider: new GeminiAnalysisProvider({ config: cfg, transport }),
      render,
      maxTransportCalls: 48,
      maxUsd: 5,
      now: at,
      ...extra,
    });
  const quota = { maxRpm: 10, maxTpm: 10_000_000, maxRpd: 1000 };

  it("all-error run (no usage on any attempt): attempts are counted and actual cost is UNKNOWN, never $0", async () => {
    const transport = new FakeGeminiTransport(() => ({
      kind: "error",
      error: new GeminiTransportError("timeout", null, "timed out"),
    }));
    const r = await run(transport);
    expect(r.status).toBe("completed");
    expect(r.analysisAttempts).toBe(48);
    expect(r.usageReportedCalls).toBe(0);
    expect(r.answersReceived).toBe(0);
    expect(r.actualUsd).toBeNull();
    expect(r.costStatus).toBe("unknown");
    expect(Object.values(r.verdicts).every((v) => v === "not_accepted_provider_errors")).toBe(true);
  });

  it("mixed: one usage-bearing success + one error without usage is UNKNOWN (no partial sum as the total)", async () => {
    const fixtures = TEMPORAL_FIXTURES.slice(0, 2);
    const transport = new FakeGeminiTransport((req, n) =>
      n === 0 ? ok(req) : { kind: "error", error: http(500) },
    );
    const r = await run(transport, { fixtures, trials: 1 });
    expect(r.analysisAttempts).toBe(2);
    expect(r.usageReportedCalls).toBe(1);
    expect(r.actualUsd).toBeNull();
    expect(r.costStatus).toBe("unknown");
    expect(r.knownUsageUsd).toBeGreaterThan(0);
    expect(r.reportedTokens.inputTokens).toBe(2000);
  });

  it("all successes with complete usage: actual cost is the provider's finite figure", async () => {
    const transport = new FakeGeminiTransport(ok);
    const provider = new GeminiAnalysisProvider({ config: cfg, transport });
    const r = await runTemporalCalibration({ provider, render, maxTransportCalls: 48, maxUsd: 5, now: at });
    expect(r.costStatus).toBe("known");
    expect(Number.isFinite(r.actualUsd)).toBe(true);
    expect(r.actualUsd).toBeGreaterThan(0);
    expect(r.actualUsd).toBe(r.knownUsageUsd);
    expect(r.usageReportedCalls).toBe(48);
  });

  it("zero is reported only when no generation request left Prism", async () => {
    const transport = new FakeGeminiTransport(ok);
    const provider = new GeminiAnalysisProvider({ config: cfg, transport });
    provider.analyzeBatch = async () => {
      throw new AnalysisBatchError("invalid_input", "missing_media", "refused locally before any request");
    };
    const r = await runTemporalCalibration({ provider, render, maxTransportCalls: 48, maxUsd: 5, now: at });
    expect(transport.calls).toBe(0);
    expect(r.transportCalls).toBe(0);
    expect(r.analysisAttempts).toBe(0);
    expect(r.actualUsd).toBe(0);
    expect(r.costStatus).toBe("none_sent");
  });

  it("a success whose usage is missing (null fields, or no usage object) makes the cost UNKNOWN", async () => {
    const fixtures = TEMPORAL_FIXTURES.slice(0, 1);
    const nullFields = new FakeGeminiTransport((req) => {
      const step = ok(req);
      return step.kind === "json"
        ? { ...step, usage: { promptTokens: null, candidatesTokens: null, thoughtsTokens: null } }
        : step;
    });
    const a = await run(nullFields, { fixtures, trials: 1 });
    expect(a.answersReceived).toBe(1);
    expect(a.actualUsd).toBeNull();
    const inner = new FakeGeminiTransport(ok);
    const noUsage: GeminiTransport = {
      generate: async (req) => ({ ...(await inner.generate(req)), usage: null }),
    };
    const b = await run(noUsage, { fixtures, trials: 1 });
    expect(b.usageReportedCalls).toBe(0);
    expect(b.actualUsd).toBeNull();
    expect(b.costStatus).toBe("unknown");
  });

  it("the FIRST 429 aborts the run: partial report, unattempted trials counted, no criterion accepted", async () => {
    const transport = new FakeGeminiTransport((req, n) =>
      n < 6 ? ok(req) : { kind: "error", error: q429() },
    );
    const r = await run(transport);
    expect(transport.calls).toBe(7);
    expect(r.status).toBe("aborted_provider");
    expect(r.abort).toMatchObject({
      reason: "quota_or_billing_exhausted",
      httpStatus: 429,
      fixture: TEMPORAL_FIXTURES[6]!.id,
      trial: 1,
    });
    expect(r.trialsAttempted).toBe(7);
    expect(r.trialsUnattempted).toBe(41);
    expect(r.trials.at(-1)).toMatchObject({ result: "error", httpStatus: 429, errorCategory: "rate_limit" });
    expect(Object.values(r.accepted).some(Boolean)).toBe(false);
    // answered criteria are "incomplete"; criteria the model never saw are "not measured" (never "incorrect")
    const answered = new Set(r.trials.filter((t) => t.result !== "error").map((t) => t.criterion));
    expect(answered.size).toBeGreaterThan(0);
    for (const [c, v] of Object.entries(r.verdicts))
      expect(v).toBe(answered.has(c as never) ? "not_accepted_incomplete" : "not_measured_provider_error");
    expect(r.actualUsd).toBeNull(); // the 429 reported no usage
  });

  /** The exact shape of the second live attempt: 16 fixtures × 3 trials, the provider refuses the account. */
  const access = (status: number, message: string) =>
    new GeminiTransportError(status === 401 || status === 403 ? "auth" : "invalid_input", status, message);
  for (const [status, reason] of [
    [402, "provider_billing_error"],
    [401, "provider_authentication_error"],
    [403, "provider_authorization_error"],
    [404, "provider_model_unavailable"],
  ] as const) {
    it(`HTTP ${status} on the FIRST request aborts at once as ${reason}: 1 request, 47 unattempted, nothing measured`, async () => {
      const transport = new FakeGeminiTransport(() => ({
        kind: "error",
        error: access(status, `Gemini returned HTTP ${status}: provider refused the project`),
      }));
      const r = await run(transport);
      expect(transport.calls).toBe(1);
      expect(r.status).toBe("aborted_provider");
      expect(r.abort).toMatchObject({
        reason,
        category: reason,
        httpStatus: status,
        fixture: TEMPORAL_FIXTURES[0]!.id,
        trial: 1,
      });
      expect(r.trialsPlanned).toBe(48);
      expect(r.trialsAttempted).toBe(1);
      expect(r.trialsRejected).toBe(1);
      expect(r.trialsUnanswered).toBe(1);
      expect(r.trialsUnattempted).toBe(47);
      expect(r.analysisAttempts).toBe(1);
      expect(r.transportCalls).toBe(1);
      expect(r.uploadAttempts).toBe(0);
      expect(r.correctionAttempts).toBe(0);
      expect(r.answersReceived).toBe(0);
      // the account failure is never filed as the fixture's invalid input
      expect(r.trials).toEqual([
        expect.objectContaining({ result: "error", httpStatus: status, errorCategory: reason }),
      ]);
      // no quality conclusion: nothing accepted, nothing "incorrect", every criterion NOT MEASURED
      expect(Object.values(r.accepted).some(Boolean)).toBe(false);
      expect(Object.values(r.verdicts).every((v) => v === "not_measured_provider_error")).toBe(true);
      expect(r.lipSyncCapable).toBe(false);
      // no usage came back: cost is UNKNOWN (never assumed free), with $0 known usage
      expect(r.usageReportedCalls).toBe(0);
      expect(r.actualUsd).toBeNull();
      expect(r.costStatus).toBe("unknown");
      expect(r.knownUsageUsd).toBe(0);
    });
  }

  it("ordinary per-fixture input errors (400, 413, 422) stay error trials: the run continues and completes", async () => {
    for (const status of [400, 413, 422]) {
      const transport = new FakeGeminiTransport((req, n) =>
        n === 0
          ? {
              kind: "error",
              error: new GeminiTransportError("invalid_input", status, `Gemini returned HTTP ${status}`),
            }
          : ok(req),
      );
      const r = await run(transport);
      expect(transport.calls).toBe(48);
      expect(r.status).toBe("completed");
      expect(r.abort).toBeNull();
      expect(r.trials[0]).toMatchObject({
        result: "error",
        httpStatus: status,
        errorCategory: "invalid_input",
      });
      expect(r.trialsRejected).toBe(1);
      expect(r.trialsUnattempted).toBe(0);
    }
    // a local refusal (no HTTP status) is not an access failure either
    expect(providerAccessFailure(null)).toBeNull();
    expect(providerAccessFailure(400)).toBeNull();
    expect(providerAccessFailure(429)).toBeNull();
    expect(providerAccessFailure(500)).toBeNull();
    expect(PROVIDER_ACCESS_FAILURES).toEqual({
      401: "provider_authentication_error",
      402: "provider_billing_error",
      403: "provider_authorization_error",
      404: "provider_model_unavailable",
    });
  });

  it("a provider error body is redacted before it reaches the report (key, bearer header, api_key param)", async () => {
    const key = "AIzaSy-test-not-a-real-credential-000000";
    vi.stubEnv("GEMINI_API_KEY", key);
    try {
      const transport = new FakeGeminiTransport(() => ({
        kind: "error",
        error: access(
          402,
          `Gemini returned HTTP 402: credits depleted for ${key}; Authorization: Bearer abcdefgh12345678 api_key=zzzzzzzz`,
        ),
      }));
      const r = await run(transport);
      const json = JSON.stringify(r);
      expect(json).not.toContain(key);
      expect(json).not.toContain("abcdefgh12345678");
      expect(json).not.toContain("zzzzzzzz");
      expect(r.abort?.message).toContain("HTTP 402");
      expect(r.abort?.message).toContain("credits depleted");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("429 reasons are conservative: quota/billing only when the provider says so", () => {
    expect(
      http429Reason("You exceeded your current quota, please check your plan and billing details."),
    ).toBe("quota_or_billing_exhausted");
    expect(http429Reason("Gemini returned HTTP 429: Too Many Requests")).toBe("quota_or_rate_limit");
    expect(http429Reason("Gemini returned HTTP 429")).toBe("quota_or_rate_limit");
  });

  it("a single 5xx is an error trial (no retry); 3 consecutive 5xx abort as provider-unavailable", async () => {
    const fixtures = TEMPORAL_FIXTURES.slice(0, 4);
    const one = new FakeGeminiTransport((req, n) =>
      n === 1 ? { kind: "error", error: http(503) } : ok(req),
    );
    const a = await run(one, { fixtures, trials: 1 });
    expect(one.calls).toBe(4); // the 503 trial was not re-sent
    expect(a.status).toBe("completed");
    expect(a.trials[1]).toMatchObject({ result: "error", httpStatus: 503 });
    const broken = new FakeGeminiTransport((req, n) =>
      n === 0 ? ok(req) : { kind: "error", error: http(n % 2 ? 500 : 503) },
    );
    const b = await run(broken);
    expect(broken.calls).toBe(1 + CALIBRATION_RUN_CONTROL.maxConsecutive5xx);
    expect(b.status).toBe("aborted_provider");
    expect(b.abort?.reason).toBe("provider_unavailable");
    expect(b.trialsUnattempted).toBe(48 - 4);
  });

  it("live mode needs declared limits; invalid limits and an over-TPM/RPD plan refuse before any request", async () => {
    const transport = new FakeGeminiTransport(ok);
    await expect(run(transport, { live: true })).rejects.toThrow(/RPM\/TPM\/RPD.*nothing was sent/);
    for (const bad of [0, -1, 1.5, Number.NaN])
      await expect(run(transport, { quota: { ...quota, maxRpm: bad } })).rejects.toThrow(/nothing was sent/);
    await expect(run(transport, { quota: { ...quota, maxRpm: 1 } })).rejects.toThrow(/no paced request/);
    await expect(run(transport, { quota: { ...quota, maxTpm: 1000 } })).rejects.toThrow(
      /above the TPM limit/,
    );
    await expect(run(transport, { quota: { ...quota, maxRpd: 47 } })).rejects.toThrow(/above the RPD limit/);
    expect(transport.calls).toBe(0);
  });

  it("paced: requests start no faster than 80% of the declared RPM (injected clock; nothing really waits)", async () => {
    let t = 0;
    const slept: number[] = [];
    const starts: number[] = [];
    const transport = new FakeGeminiTransport((req) => {
      starts.push(t);
      t += 900; // provider latency
      return ok(req);
    });
    const r = await run(transport, {
      quota,
      clock: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
    });
    expect(r.quota).toMatchObject({ effectiveRpm: 8, minIntervalMs: 7500, plannedAnalysisRequests: 48 });
    expect(starts).toHaveLength(48);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(7500);
    expect(slept.every((ms) => ms === 7500 - 900)).toBe(true);
  });

  it("without declared limits (fake / CI) nothing is paced; with pacing, a 429 still aborts at once", async () => {
    const slept: number[] = [];
    await run(new FakeGeminiTransport(ok), {
      fixtures: TEMPORAL_FIXTURES.slice(0, 3),
      trials: 1,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(slept).toHaveLength(0);
    let t = 0;
    const transport = new FakeGeminiTransport((req, n) =>
      n === 2 ? { kind: "error", error: q429() } : ok(req),
    );
    const r = await run(transport, {
      quota,
      clock: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
    });
    expect(transport.calls).toBe(3);
    expect(slept).toHaveLength(2);
    expect(r.status).toBe("aborted_provider");
  });

  it("planQuota: worst-case tokens/min at the paced rate; requests vs the daily limit", () => {
    const plan = planQuota(quota, 48, [
      { inputTokens: 5000, maxOutputTokens: 2000 },
      { inputTokens: 6000, maxOutputTokens: 2000 },
    ]);
    expect(plan).toMatchObject({
      effectiveRpm: 8,
      minIntervalMs: 7500,
      maxInputTokensPerRequest: 6000,
      maxTokensPerRequest: 8000,
      worstCaseTokensPerMinute: 64_000,
    });
  });

  it("live readiness is operator-declared: every limit, RPD-remaining confirmation, billing, tier and spend cap", () => {
    expect(liveReadinessProblems({})).toHaveLength(7);
    expect(
      liveReadinessProblems({
        maxRpm: 1000,
        maxTpm: 1_000_000,
        maxRpd: 10_000,
        rpdRemainingConfirmed: true,
        billingActive: "yes",
        projectTier: "Tier 1",
        spendCap: "none",
      }),
    ).toEqual([]);
    expect(
      liveReadinessProblems({
        maxRpm: 1000,
        maxTpm: 1_000_000,
        maxRpd: 10_000,
        rpdRemainingConfirmed: true,
        billingActive: "no",
        projectTier: "Free",
        spendCap: "none",
      }),
    ).toEqual([expect.stringMatching(/--billing-active yes/)]);
  });
});
