import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { processor } from "../analysis/__tests__/queue-harness";
import {
  CALIBRATION_ACCEPTANCE,
  TEMPORAL_FIXTURES,
  acceptance,
  renderFixture,
  runTemporalCalibration,
  type CalibrationFixture,
} from "../calibration/temporal-calibration";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { readGeminiConfig } from "../providers/gemini/config";
import { FakeGeminiTransport, type FakeStep } from "../providers/gemini/fake-transport";
import type { GeminiRequest } from "../providers/gemini/transport";

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
    expect(new Set(TEMPORAL_FIXTURES.map((f) => f.id)).size).toBe(TEMPORAL_FIXTURES.length);
  });

  it("an empty result set accepts nothing (unchecked/errors never count)", () => {
    expect(Object.values(acceptance([])).every((v) => v === false)).toBe(true);
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
});
