import { describe, expect, it } from "vitest";
import { GeminiAnalysisProvider } from "../../providers/gemini/analyzer";
import { readGeminiConfig } from "../../providers/gemini/config";
import { FakeGeminiTransport, answerAll } from "../../providers/gemini/fake-transport";
import { OpenAIContinuityAnalyzer } from "../../providers/openai/analyzer";
import { readOpenAIConfig } from "../../providers/openai/config";
import { FakeOpenAITransport, openaiAnswerAll } from "../../providers/openai/fake-transport";
import { MockAnalysisProvider } from "../mock-provider";
import { AnalysisBatchError, sumUsage, type ContinuityAnalysisProvider } from "../provider";
import { ctx, makeInput, mediaFor } from "./fixtures";

/**
 * The SAME contract suite runs against every ContinuityAnalysisProvider. Provider differences live behind the
 * adapter; everything asserted here is what the queue, the plan, the findings and the UI may rely on.
 */
interface Row {
  name: string;
  /** Free analyzers cost nothing and cannot refuse. */
  paid: boolean;
  make(mode: "pass" | "refuse" | "no_usage" | "invalid_then_ok"): ContinuityAnalysisProvider;
}

const gemCfg = readGeminiConfig({
  PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
  GEMINI_API_KEY: "k".repeat(12),
});
const oaiCfg = readOpenAIConfig({
  PRISM_STUDIO_CONTINUITY_ANALYZERS: "openai",
  OPENAI_API_KEY: "k".repeat(12),
});

const rows: Row[] = [
  { name: "mock", paid: false, make: () => new MockAnalysisProvider() },
  {
    name: "gemini",
    paid: true,
    make: (mode) => {
      const pass = answerAll("pass");
      const t = new FakeGeminiTransport((req, n) =>
        mode === "refuse"
          ? { kind: "block", blockReason: "SAFETY" }
          : mode === "no_usage"
            ? (() => {
                const s = pass(req);
                return s.kind === "json"
                  ? {
                      ...s,
                      usage: {
                        promptTokens: null,
                        candidatesTokens: null,
                        thoughtsTokens: null,
                        totalTokens: null,
                      },
                    }
                  : s;
              })()
            : mode === "invalid_then_ok" && n === 0
              ? { kind: "text", text: "{ nope" }
              : pass(req),
      );
      return new GeminiAnalysisProvider({ config: gemCfg, transport: t });
    },
  },
  {
    name: "openai",
    paid: true,
    make: (mode) => {
      const pass = openaiAnswerAll("pass");
      const t = new FakeOpenAITransport((req, n) =>
        mode === "refuse"
          ? { kind: "refusal" }
          : mode === "no_usage"
            ? (() => {
                const s = pass(req);
                return s.kind === "json" ? { kind: "no_usage" as const, body: s.body } : s;
              })()
            : mode === "invalid_then_ok" && n === 0
              ? { kind: "text", text: "{ nope" }
              : pass(req),
      );
      return new OpenAIContinuityAnalyzer({ config: oaiCfg, transport: t });
    },
  },
];

const RESULTS = ["pass", "warn", "fail", "unchecked"];

describe.each(rows)("ContinuityAnalysisProvider contract: $name", (row) => {
  const run = async (mode: Parameters<Row["make"]>[0] = "pass") => {
    const provider = row.make(mode);
    const input = makeInput({}, provider.plannerView());
    const batch = input.plan.batches[0]!;
    const out = await provider.analyzeBatch({ batch, input, media: mediaFor(input), ctx: ctx() });
    return { provider, input, batch, out };
  };

  it("declares identity and a planner view consistent with itself", () => {
    const p = row.make("pass");
    expect(p.id).toBeTruthy();
    expect(p.model).toBeTruthy();
    expect(p.version).toBeTruthy();
    expect(["mock", "model"]).toContain(p.kind);
    const v = p.plannerView();
    expect(v).toMatchObject({ id: p.id, model: p.model });
    expect(v.modes).toEqual(p.modes());
    expect(v.capabilities).toEqual(p.capabilities());
    expect(p.modes()).toContain("image_set");
  });

  it("answers exactly the batch's criteria, with normalized findings and valid evidence", async () => {
    const { input, batch, out } = await run("pass");
    expect(out.batchId).toBe(batch.id);
    expect(out.findings.map((f) => f.criterionKey).sort()).toEqual([...batch.criterionKeys].sort());
    const sent = new Set([...batch.referenceInputIds, ...batch.outputInputIds]);
    const allowed = new Set(input.media.map((m) => m.inputId));
    for (const f of out.findings) {
      expect(RESULTS).toContain(f.result);
      expect(typeof f.summary).toBe("string");
      expect(Array.isArray(f.contradictions)).toBe(true);
      expect(Array.isArray(f.limitations)).toBe(true);
      expect(f.confidence === null || (f.confidence >= 0 && f.confidence <= 1)).toBe(true);
      for (const e of f.evidence) {
        expect(allowed.has(e.input)).toBe(true);
        expect(sent.has(e.input)).toBe(true);
      }
      // the provider never supplies Prism-owned fields
      expect(Object.keys(f).sort()).toEqual(
        [
          "confidence",
          "contradictions",
          "criterionKey",
          "evidence",
          "limitations",
          "result",
          "summary",
        ].sort(),
      );
    }
    expect(out.refused).toBe(false);
  });

  it("reports usage calls that sum consistently and an estimate that is a number", async () => {
    const { provider, input, out } = await run("pass");
    expect(out.calls.length).toBeGreaterThanOrEqual(1);
    const usage = sumUsage(out.calls);
    expect(usage.calls).toHaveLength(out.calls.length);
    const est = provider.estimate(input, new Date("2026-10-13"));
    expect(Number.isFinite(est.maxUsd)).toBe(true);
    expect(est.maxUsd).toBeGreaterThanOrEqual(est.expectedUsd);
    if (!row.paid) expect(est.maxUsd).toBe(0);
    else expect(est.maxUsd).toBeGreaterThan(0);
    const cost = provider.actualCost(out.calls, new Date("2026-10-13"));
    expect(cost.pricingVersion).toBeTruthy();
    if (!row.paid) expect(cost.amountUsd).toBe(0);
  });

  it("a missing correction never changes the result schema (one valid answer after one correction)", async () => {
    if (!row.paid) return;
    const { out } = await run("invalid_then_ok");
    expect(out.correctionUsed).toBe(true);
    expect(out.calls.map((c) => c.kind)).toEqual(["analysis", "correction"]);
    expect(out.findings.every((f) => f.result === "pass")).toBe(true);
  });

  it("a refusal is UNCHECKED, never FAIL", async () => {
    if (!row.paid) return;
    const { out } = await run("refuse");
    expect(out.refused).toBe(true);
    expect(out.findings.every((f) => f.result === "unchecked")).toBe(true);
  });

  it("absent usage metadata ⇒ actual cost UNKNOWN, never invented", async () => {
    if (!row.paid) return;
    const { provider, out } = await run("no_usage");
    expect(provider.actualCost(out.calls, new Date("2026-10-13")).amountUsd).toBeNull();
  });

  it("a missing media input is an invalid_input error (nothing sent)", async () => {
    const provider = row.make("pass");
    const input = makeInput({}, provider.plannerView());
    const batch = input.plan.batches[0]!;
    if (!row.paid) return;
    const media = mediaFor(input);
    media.delete(batch.referenceInputIds[0]!);
    const err = await provider.analyzeBatch({ batch, input, media, ctx: ctx() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalysisBatchError);
    expect((err as AnalysisBatchError).category).toBe("invalid_input");
  });
});

/**
 * 3A.3 direct-video contract: a provider either declares NO video at all (and the planner never gives it video), or
 * answers a direct-video batch with the SAME normalized finding shape, whose evidence is timestamped inside the clip.
 * There is no separate "temporal result" shape.
 */
describe.each([
  ...rows,
  {
    name: "gemini (direct video enabled on the server)",
    paid: true,
    make: () =>
      new GeminiAnalysisProvider({
        config: readGeminiConfig({
          PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
          GEMINI_API_KEY: "k".repeat(12),
          PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
        }),
        transport: new FakeGeminiTransport(answerAll("pass")),
      }),
  } satisfies Row,
])("direct-video contract: $name", (row) => {
  it("declares video honestly and, when it does, answers with ordinary timestamped findings", async () => {
    const provider = row.make("pass");
    const input = makeInput({}, provider.plannerView(), { directVideoAllowed: true });
    const vb = input.plan.batches.find((b) => b.mode === "direct_video");
    if (!provider.modes().includes("direct_video")) {
      expect(provider.videoCapabilities()).toEqual([]);
      expect(vb).toBeUndefined();
      return;
    }
    expect(provider.videoCapabilities()).not.toContain("lip_sync"); // calibration-gated
    expect(vb).toBeDefined();
    const video = input.media.find((m) => m.kind === "video")!;
    const bytes = mediaFor(input);
    bytes.set(video.inputId, { inputId: video.inputId, mime: "video/mp4", bytes: new Uint8Array(2048) });
    const out = await provider.analyzeBatch({ batch: vb!, input, media: bytes, ctx: ctx() });
    expect(out.findings.map((f) => f.criterionKey).sort()).toEqual([...vb!.criterionKeys].sort());
    for (const f of out.findings) {
      expect(Object.keys(f).sort()).toEqual(
        [
          "confidence",
          "contradictions",
          "criterionKey",
          "evidence",
          "limitations",
          "result",
          "summary",
        ].sort(),
      );
      for (const e of f.evidence) {
        expect(e.input).toBe(video.inputId);
        expect(e.source).toBe("video");
        expect(e.atMs).not.toBeNull();
        expect(e.atMs!).toBeGreaterThanOrEqual(0);
        expect(e.atMs!).toBeLessThanOrEqual(video.durationMs!);
        if (e.endMs != null) expect(e.endMs).toBeLessThanOrEqual(video.durationMs!);
      }
    }
  });
});
