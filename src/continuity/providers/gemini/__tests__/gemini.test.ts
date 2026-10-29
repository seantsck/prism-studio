import { describe, expect, it, vi } from "vitest";
import { encodeMockPng } from "@/generation/providers/mock-image";
import { ctx, makeInput, mediaFor } from "@/continuity/analysis/__tests__/fixtures";
import { AnalysisBatchError, type ContinuityAnalysisProvider } from "@/continuity/analysis/provider";
import { MockAnalysisProvider } from "@/continuity/analysis/mock-provider";
import { GEMINI_MODELS, GEMINI_PRICING, geminiModelBlocker, readGeminiConfig, geminiState } from "../config";
import { GeminiAnalysisProvider } from "../analyzer";
import { FakeGeminiTransport, answerAll, type FakeStep } from "../fake-transport";
import { GeminiTransportError, type GeminiRequest } from "../transport";
import { mapSdkError } from "../sdk-transport";
import { actualCost } from "@/domain/continuity/analysis/cost";

const cfg = readGeminiConfig({
  PRISM_STUDIO_CONTINUITY_ANALYZERS: "mock,gemini",
  GEMINI_API_KEY: "AIza-test-key-should-never-leak",
});
const input = makeInput();
const batch = input.plan.batches[0]!;
const make = (script: FakeStep[] | ((r: GeminiRequest, n: number) => FakeStep)) => {
  const transport = new FakeGeminiTransport(script);
  return { transport, provider: new GeminiAnalysisProvider({ config: cfg, transport }) };
};
const run = (
  provider: ContinuityAnalysisProvider,
  over: Partial<Parameters<ContinuityAnalysisProvider["analyzeBatch"]>[0]> = {},
) => provider.analyzeBatch({ batch, input, media: mediaFor(input), ctx: ctx(), ...over });
const answer = (key: string, over: Record<string, unknown> = {}) => ({
  criterionId: key,
  result: "pass",
  confidence: 0.9,
  summary: "Consistent.",
  evidence: [{ input: "frame:0", timestampMs: null, observation: "Visible." }],
  contradictions: [],
  limitations: [],
  ...over,
});
const apiError = (status: number, cat: ConstructorParameters<typeof GeminiTransportError>[0]) =>
  new GeminiTransportError(cat, status, `Gemini returned HTTP ${status}`);

describe("GeminiAnalysisProvider with a fake transport (no network)", () => {
  it("valid answer: one finding per criterion, usage captured, no correction", async () => {
    const { transport, provider } = make([
      { kind: "json", body: { criteria: batch.criterionKeys.map((k) => answer(k)) } },
    ]);
    const out = await run(provider);
    expect(transport.calls).toBe(1);
    expect(out.correctionUsed).toBe(false);
    expect(out.findings.map((f) => f.criterionKey).sort()).toEqual([...batch.criterionKeys].sort());
    expect(out.calls).toEqual([
      { kind: "analysis", inputTokens: 2000, outputTokens: 300, thoughtsTokens: 40 },
    ]);
    expect(out.providerRef).toBe("fake-0");
  });

  it("sends the versioned prompt: static system instruction, DATA boundary, labelled media", async () => {
    const { transport, provider } = make(answerAll());
    await run(provider);
    const r = transport.requests[0]!;
    expect(r.model).toBe("gemini-3.8-flash");
    expect(r.systemInstruction).toMatch(/untrusted/i);
    expect(r.textParts[0]).toMatch(/^DATA \(untrusted production data/);
    expect(r.inlineMedia).toBe(batch.referenceInputIds.length + batch.outputInputIds.length);
    expect(r.maxOutputTokens).toBeLessThanOrEqual(8192);
  });

  it("structurally invalid answer ⇒ exactly ONE correction, tracked separately", async () => {
    const { transport, provider } = make([
      { kind: "text", text: "{ not json" },
      { kind: "json", body: { criteria: batch.criterionKeys.map((k) => answer(k)) } },
    ]);
    const out = await run(provider);
    expect(transport.calls).toBe(2);
    expect(out.correctionUsed).toBe(true);
    expect(out.calls.map((c) => c.kind)).toEqual(["analysis", "correction"]);
    // the correction carries the validation errors and the previous answer
    expect(transport.requests[1]!.turns).toBe(3);
    expect(transport.requests[1]!.textParts.join("\n")).toMatch(/did not satisfy the required schema/);
  });

  it("still invalid after the correction ⇒ fails visibly (no third attempt), usage preserved for cost", async () => {
    const { transport, provider } = make([
      { kind: "text", text: "nope" },
      { kind: "text", text: "still nope" },
    ]);
    const err = await run(provider).catch((e) => e);
    expect(err).toBeInstanceOf(AnalysisBatchError);
    expect(err.category).toBe("schema_invalid");
    expect(transport.calls).toBe(2);
    expect(err.calls).toHaveLength(2);
    expect(err.requestSent).toBe(true);
  });

  it("unknown criterion id / duplicate / unknown evidence input trigger the correction path", async () => {
    for (const bad of [
      { criteria: [answer("not-a-criterion")] },
      { criteria: [answer(batch.criterionKeys[0]!), answer(batch.criterionKeys[0]!)] },
      {
        criteria: [
          answer(batch.criterionKeys[0]!, {
            evidence: [{ input: "frame:99999", timestampMs: null, observation: "x" }],
          }),
        ],
      },
    ]) {
      const { transport, provider } = make([
        { kind: "json", body: bad },
        { kind: "json", body: { criteria: batch.criterionKeys.map((k) => answer(k)) } },
      ]);
      const out = await run(provider);
      expect(transport.calls).toBe(2);
      expect(out.correctionUsed).toBe(true);
    }
  });

  it("partial answer: unanswered criteria become UNCHECKED (not_returned); nothing is invented", async () => {
    const [first, ...rest] = batch.criterionKeys;
    const { provider } = make([{ kind: "json", body: { criteria: [answer(first!)] } }]);
    const out = await run(provider);
    expect(out.findings.find((f) => f.criterionKey === first)!.result).toBe("pass");
    for (const k of rest) {
      const f = out.findings.find((x) => x.criterionKey === k)!;
      expect(f.result).toBe("unchecked");
      expect(f.limitations).toContain("not_returned");
    }
  });

  it("provider safety refusal ⇒ UNCHECKED with provider_refusal, never FAIL", async () => {
    for (const step of [
      { kind: "block", blockReason: "SAFETY" } as const,
      { kind: "finish", finishReason: "IMAGE_SAFETY" } as const,
    ]) {
      const { transport, provider } = make([step]);
      const out = await run(provider);
      expect(out.refused).toBe(true);
      expect(transport.calls).toBe(1);
      for (const f of out.findings) {
        expect(f.result).toBe("unchecked");
        expect(f.limitations).toContain("provider_refusal");
      }
    }
  });

  it("429 and 503 are NOT retried in-process: exactly one transport call, the durable queue decides when", async () => {
    for (const [status, cat] of [
      [429, "rate_limit"],
      [503, "overloaded"],
    ] as const) {
      const sleep = vi.fn(async () => undefined);
      const { transport, provider } = make([{ kind: "error", error: apiError(status, cat) }]);
      const err = await run(provider, { ctx: { ...ctx(), sleep } }).catch((e) => e);
      expect(err).toBeInstanceOf(AnalysisBatchError);
      expect(err.category).toBe(cat);
      expect(err.httpStatus).toBe(status);
      expect(err.requestSent).toBe(true);
      expect(err.calls).toHaveLength(0); // no usage reported: nothing is invented
      expect(transport.calls).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("a local refusal before the transport is NOT a request: the transport is never touched", async () => {
    const { transport, provider } = make([{ kind: "json", body: { criteria: [] } }]);
    const block = new AnalysisBatchError(
      "local_policy_block",
      "transport_call_ceiling",
      "ceiling",
      [],
      false,
    );
    const err = await run(provider, {
      ctx: {
        ...ctx(),
        beforeTransportCall: async () => {
          throw block;
        },
      },
    }).catch((e) => e);
    expect(err).toBe(block);
    expect(err.category).toBe("local_policy_block");
    expect(err.requestSent).toBe(false);
    expect(transport.calls).toBe(0);
  });

  it("the correction counts as a transport call and is refused when the run's allowance is spent", async () => {
    const seen: string[] = [];
    const { transport, provider } = make([
      { kind: "text", text: "not json" },
      { kind: "json", body: { criteria: batch.criterionKeys.map((k) => answer(k)) } },
    ]);
    const err = await run(provider, {
      ctx: {
        ...ctx(),
        beforeTransportCall: async ({ kind }) => {
          seen.push(kind);
        },
        canCorrect: () => false,
      },
    }).catch((e) => e);
    expect(err.category).toBe("schema_invalid");
    expect(err.code).toBe("correction_budget_exhausted");
    expect(seen).toEqual(["analysis"]);
    expect(transport.calls).toBe(1);

    const allowed = make([
      { kind: "text", text: "not json" },
      { kind: "json", body: { criteria: batch.criterionKeys.map((k) => answer(k)) } },
    ]);
    const kinds: string[] = [];
    const out = await run(allowed.provider, {
      ctx: {
        ...ctx(),
        beforeTransportCall: async ({ kind }) => {
          kinds.push(kind);
        },
        canCorrect: () => true,
      },
    });
    expect(kinds).toEqual(["analysis", "correction"]);
    expect(out.correctionUsed).toBe(true);
  });

  it("500 is not auto-retried; auth and invalid-input fail permanently", async () => {
    for (const [status, cat] of [
      [500, "server_error"],
      [401, "auth"],
      [400, "invalid_input"],
    ] as const) {
      const { transport, provider } = make([{ kind: "error", error: apiError(status, cat) }]);
      const err = await run(provider).catch((e) => e);
      expect(err.category).toBe(cat);
      expect(transport.calls).toBe(1);
    }
  });

  it("timeout / network are AMBIGUOUS: reported as outcome_unknown and never re-sent", async () => {
    for (const cat of ["timeout", "network"] as const) {
      const { transport, provider } = make([
        { kind: "error", error: new GeminiTransportError(cat, null, "x") },
      ]);
      const err = await run(provider).catch((e) => e);
      expect(err.category).toBe("outcome_unknown");
      expect(err.requestSent).toBe(true);
      expect(transport.calls).toBe(1);
    }
  });

  it("a huge response is rejected, then corrected once", async () => {
    const { transport, provider } = make([
      { kind: "text", text: '{"criteria":[' + "x".repeat(70_000) },
      { kind: "json", body: { criteria: batch.criterionKeys.map((k) => answer(k)) } },
    ]);
    const out = await run(provider);
    expect(transport.calls).toBe(2);
    expect(out.correctionUsed).toBe(true);
  });

  it("the API key never appears in requests, outcomes, estimates or errors", async () => {
    const { transport, provider } = make(answerAll());
    const out = await run(provider);
    const blob = JSON.stringify([
      transport.requests,
      out,
      provider.estimate(input, new Date()),
      provider.plannerView(),
    ]);
    expect(blob).not.toContain("AIza-test-key");
    const e = mapSdkError({ status: 400, message: "bad request AIza-test-key-should-never-leak" });
    expect(e.category).toBe("invalid_input");
  });

  it("maps SDK failures without copying payloads", () => {
    expect(mapSdkError({ status: 429, message: "quota" }).category).toBe("rate_limit");
    expect(mapSdkError({ status: 503, message: "x" }).category).toBe("overloaded");
    expect(mapSdkError({ status: 403, message: "x" }).category).toBe("auth");
    expect(mapSdkError({ name: "AbortError", message: "aborted" }).category).toBe("timeout");
    expect(mapSdkError(new TypeError("fetch failed")).category).toBe("network");
  });

  it("estimate: conservative ceiling for the whole plan, including one correction per request", () => {
    const { provider } = make(answerAll());
    const est = provider.estimate(input, new Date("2026-10-13T00:00:00Z"));
    expect(est.maxUsd).toBeGreaterThan(est.expectedUsd);
    expect(est.maxUsd).toBeLessThan(0.25);
    expect(est.pricingVersion).toBe(GEMINI_PRICING.version);
    // unknown model ⇒ unknown cost (NaN is never shown as a number; the gate treats it as unknown)
    const odd = new GeminiAnalysisProvider({
      config: { ...cfg, model: "gemini-unknown-x" },
      transport: new FakeGeminiTransport([]),
    });
    expect(Number.isNaN(odd.estimate(input, new Date()).maxUsd)).toBe(true);
  });

  it("actual cost is derived from provider usage (incl. thinking at the output rate, incl. correction)", async () => {
    const { provider } = make([
      { kind: "text", text: "bad", usage: { promptTokens: 1000, candidatesTokens: 10, thoughtsTokens: 5 } },
      {
        kind: "json",
        body: { criteria: batch.criterionKeys.map((k) => answer(k)) },
        usage: { promptTokens: 1200, candidatesTokens: 300, thoughtsTokens: 20 },
      },
    ]);
    const out = await run(provider);
    const a = actualCost(out.calls, provider.pricing()!, GEMINI_PRICING, new Date("2026-10-13T00:00:00Z"));
    expect(a.inputTokens).toBe(2200);
    expect(a.outputTokens).toBe(310);
    expect(a.thoughtsTokens).toBe(25);
    expect(a.amountUsd).toBeCloseTo((2200 * 0.75 + 335 * 3.75) / 1e6, 5);
  });

  it("config states are safe booleans/enums only", () => {
    expect(geminiState(readGeminiConfig({}))).toBe("disabled");
    expect(geminiState(readGeminiConfig({ PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini" }))).toBe(
      "missing_credential",
    );
    expect(geminiState(cfg)).toBe("configured");
  });
});

describe("model selection (one analyzer, model-specific capability and price)", () => {
  const withModel = (model?: string) =>
    readGeminiConfig({
      PRISM_STUDIO_CONTINUITY_ANALYZERS: "mock,gemini",
      GEMINI_API_KEY: "AIza-test-key-should-never-leak",
      ...(model ? { PRISM_STUDIO_GEMINI_ANALYSIS_MODEL: model } : {}),
    });

  it("gemini-3.8-flash stays the default and gemini-3.6-flash is selectable by id", () => {
    expect(withModel().model).toBe("gemini-3.8-flash");
    expect(withModel("gemini-3.6-flash").model).toBe("gemini-3.6-flash");
    for (const m of ["gemini-3.8-flash", "gemini-3.6-flash"]) {
      expect(geminiModelBlocker(m)).toBeNull();
      expect(geminiState(withModel(m))).toBe("configured");
    }
    const spec = GEMINI_MODELS.find((m) => m.id === "gemini-3.6-flash")!;
    expect(spec.status).toBe("stable");
    expect(spec.inputs).toContain("image");
    expect(spec.structuredOutputs).toBe(true);
  });

  it("both models run through the SAME analyzer class and send their own model id", async () => {
    for (const model of ["gemini-3.8-flash", "gemini-3.6-flash"]) {
      const transport = new FakeGeminiTransport(answerAll("pass"));
      const provider = new GeminiAnalysisProvider({ config: withModel(model), transport });
      expect(provider.id).toBe("gemini");
      expect(provider.model).toBe(model);
      await run(provider);
      expect(transport.requests.every((r) => r.model === model)).toBe(true);
    }
  });

  it("pricing is selected by model and by date (the 2027 step applies to both)", () => {
    for (const model of ["gemini-3.8-flash", "gemini-3.6-flash"]) {
      const provider = new GeminiAnalysisProvider({
        config: withModel(model),
        transport: new FakeGeminiTransport([]),
      });
      const usage = [
        { kind: "analysis" as const, inputTokens: 1_000_000, outputTokens: 1_000_000, thoughtsTokens: 0 },
      ];
      expect(provider.actualCost(usage, new Date("2026-11-01")).amountUsd).toBeCloseTo(0.75 + 3.75, 6);
      expect(provider.actualCost(usage, new Date("2027-02-01")).amountUsd).toBeCloseTo(1.5 + 7.5, 6);
      expect(provider.actualCost(usage, new Date("2026-11-01")).pricingVersion).toBe(GEMINI_PRICING.version);
      expect(provider.estimate(input, new Date("2026-11-01")).maxUsd).toBeGreaterThan(0);
    }
  });

  it("an unlisted model is blocked: unsupported state, no price, no executable provider", async () => {
    const cfg2 = withModel("gemini-9.9-ultra");
    expect(geminiModelBlocker("gemini-9.9-ultra")).toMatch(/not a verified/);
    expect(geminiState(cfg2)).toBe("unsupported_model");
    const { createAnalysisProviders, analyzerStatuses } = await import("@/continuity/analysis/registry");
    const env = {
      PRISM_STUDIO_CONTINUITY_ANALYZERS: "mock,gemini",
      GEMINI_API_KEY: "AIza-test-key-should-never-leak",
      PRISM_STUDIO_GEMINI_ANALYSIS_MODEL: "gemini-9.9-ultra",
      PRISM_STUDIO_ALLOW_PAID_ANALYSIS: "true",
      PRISM_STUDIO_MAX_ANALYSIS_USD_PER_RUN: "0.10",
    };
    expect(createAnalysisProviders(env).has("gemini")).toBe(false);
    const status = analyzerStatuses(env).find((s) => s.id === "gemini")!;
    expect(status.state).toBe("unsupported_model");
    expect(status.usable).toBe(false);
    const provider = new GeminiAnalysisProvider({
      config: cfg2,
      transport: new FakeGeminiTransport([]),
    });
    expect(provider.pricing()).toBeNull();
    expect(Number.isNaN(provider.estimate(input, new Date("2026-11-01")).maxUsd)).toBe(true);
  });
});

describe("direct video (architecture; fake transport only, disabled by default)", () => {
  const vcfg = readGeminiConfig({
    PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
    GEMINI_API_KEY: "k",
    PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
  });
  const mkVideo = (provider: GeminiAnalysisProvider) => {
    const inp = makeInput({}, provider.plannerView(), { directVideoAllowed: true });
    const b = inp.plan.batches.find((x) => x.mode === "direct_video")!;
    return { inp, b };
  };

  it("is OFF unless explicitly enabled: no direct_video mode, temporal criteria unsupported", () => {
    const off = new GeminiAnalysisProvider({ config: cfg, transport: new FakeGeminiTransport([]) });
    expect(off.modes()).toEqual(["image_set"]);
    expect(off.videoCapabilities()).toEqual([]);
    const p = makeInput({}, off.plannerView()).plan;
    expect(p.items.find((i) => i.criterionKey === "screen_direction")!.status).toBe("unsupported");
    expect(p.batches.some((b) => b.mode === "direct_video")).toBe(false);
  });

  it("when enabled, temporal criteria get a direct_video batch with the video prompt version", () => {
    const on = new GeminiAnalysisProvider({ config: vcfg, transport: new FakeGeminiTransport([]) });
    expect(on.modes()).toContain("direct_video");
    const { b } = mkVideo(on);
    expect(b).toMatchObject({
      mode: "direct_video",
      promptVersion: "continuity-gemini-video-v2",
      outputInputIds: ["video"],
      sampling: { policy: "shot-temporal-static-v1", fps: 4 },
    });
    expect(b.criterionKeys).toContain("screen_direction");
  });

  it("small video is sent inline; the video system instruction states timestamps are approximate", async () => {
    const transport = new FakeGeminiTransport((req) => {
      const data = JSON.parse(
        req.turns[0]!.parts.flatMap((p) => (p.type === "text" ? [p.text] : []))[0]!.replace(/^[^{]*/, ""),
      ) as { criteria: Array<{ criterionId: string }> };
      return {
        kind: "json",
        body: {
          criteria: data.criteria.map((c) => ({
            criterionId: c.criterionId,
            result: "warn",
            confidence: 0.6,
            summary: "Direction reverses near the end.",
            evidence: [
              { input: "video", timestampMs: 3400, endMs: null, observation: "Moves left-to-right." },
            ],
            contradictions: [],
            limitations: ["sampling is approximate"],
          })),
        },
      };
    });
    const provider = new GeminiAnalysisProvider({ config: vcfg, transport });
    const { inp, b } = mkVideo(provider);
    const media = new Map([["video", { inputId: "video", mime: "video/mp4", bytes: new Uint8Array(2048) }]]);
    const out = await provider.analyzeBatch({ batch: b, input: inp, media, ctx: ctx() });
    expect(transport.uploads).toHaveLength(0);
    expect(transport.requests[0]!.inlineMedia).toBe(1);
    expect(transport.requests[0]!.inlineVideos).toBe(1);
    expect(transport.requests[0]!.videoFps).toEqual([4]);
    expect(transport.requests[0]!.videoSchema).toBe(true);
    expect(transport.requests[0]!.systemInstruction).toMatch(/frame-accurate/i);
    const f = out.findings[0]!;
    expect(f.evidence[0]).toMatchObject({ input: "video", atMs: 3400, endMs: null, source: "video" });
  });

  it("a large video goes through the Files API, is recorded, and is deleted best-effort afterwards", async () => {
    const transport = new FakeGeminiTransport(answerAll("pass", "video"));
    const provider = new GeminiAnalysisProvider({ config: vcfg, transport });
    const { inp, b } = mkVideo(provider);
    const refs: string[] = [];
    const media = new Map([
      ["video", { inputId: "video", mime: "video/mp4", bytes: new Uint8Array(13 * 1024 * 1024) }],
    ]);
    await provider.analyzeBatch({
      batch: b,
      input: inp,
      media,
      ctx: { ...ctx(), onProviderFile: (r) => refs.push(r) },
    });
    expect(transport.uploads).toHaveLength(1);
    expect(refs).toEqual([transport.uploads[0]!.name]);
    expect(transport.requests[0]!.inlineMedia).toBe(0); // referenced by file URI, not inlined
    expect(transport.requests[0]!.fileParts).toBe(1);
    expect(transport.requests[0]!.videoFps).toEqual([4]);
    expect(await provider.cleanupFiles(refs)).toEqual([{ ref: refs[0], state: "deleted" }]);
    expect(transport.deleted).toEqual(refs);
    transport.failDelete = true;
    expect(await provider.cleanupFiles(["files/x"])).toEqual([{ ref: "files/x", state: "cleanup_failed" }]);
  });
});

describe("identity fixture with a deterministic fake 'vision' transport", () => {
  /** Fake vision: result is pass iff the output frame bytes equal a reference's bytes (same synthetic character). */
  const visionFake = (req: GeminiRequest): FakeStep => {
    const media = req.turns[0]!.parts.flatMap((p) => (p.type === "inline" ? [p.dataBase64] : []));
    const texts = req.turns[0]!.parts.flatMap((p) => (p.type === "text" ? [p.text] : []));
    const data = JSON.parse(texts[0]!.slice(texts[0]!.indexOf("{"))) as {
      criteria: Array<{ criterionId: string }>;
      inputs: Array<{ inputId: string }>;
    };
    const refs = data.inputs.filter((i) => i.inputId.startsWith("ref:")).length;
    const referenceSet = new Set(media.slice(0, refs));
    const outputs = media.slice(refs);
    const same = outputs.some((o) => referenceSet.has(o));
    return {
      kind: "json",
      body: {
        criteria: data.criteria.map((c) => ({
          criterionId: c.criterionId,
          result: same ? "pass" : "fail",
          confidence: 0.9,
          summary: same ? "Matches the reference." : "Does not match the reference.",
          evidence: [
            { input: data.inputs.at(-1)!.inputId, timestampMs: null, observation: "synthetic comparison" },
          ],
          contradictions: same ? [] : ["different synthetic character"],
          limitations: [],
        })),
      },
    };
  };
  const identityBatch = input.plan.batches.find((b) => b.criterionKeys.includes("identity:charA"))!;

  const bytesFor = (seedRef: number, seedOut: number) => {
    const m = mediaFor(input);
    for (const id of identityBatch.referenceInputIds)
      m.set(id, { inputId: id, mime: "image/png", bytes: encodeMockPng(32, 18, seedRef) });
    for (const id of identityBatch.outputInputIds)
      m.set(id, { inputId: id, mime: "image/png", bytes: encodeMockPng(32, 18, seedOut) });
    return m;
  };

  it("same synthetic character ⇒ PASS; a different one ⇒ FAIL (no real AI involved)", async () => {
    const { provider } = make(visionFake);
    const same = await provider.analyzeBatch({
      batch: identityBatch,
      input,
      media: bytesFor(7, 7),
      ctx: ctx(),
    });
    expect(same.findings.find((f) => f.criterionKey === "identity:charA")!.result).toBe("pass");
    const other = await provider.analyzeBatch({
      batch: identityBatch,
      input,
      media: bytesFor(7, 99),
      ctx: ctx(),
    });
    const f = other.findings.find((x) => x.criterionKey === "identity:charA")!;
    expect(f.result).toBe("fail");
    expect(f.contradictions.length).toBeGreaterThan(0);
    expect(f.evidence[0]!.source).toBe("output_frame");
  });
});

describe.each([
  ["MockAnalysisProvider", () => new MockAnalysisProvider() as ContinuityAnalysisProvider],
  ["GeminiAnalysisProvider (fake transport)", () => make(answerAll()).provider as ContinuityAnalysisProvider],
])("analyzer contract: %s", (_name, factory) => {
  const provider = factory();
  it("declares capabilities/modes honestly and plans only what it supports", () => {
    expect(provider.capabilities().length).toBeGreaterThan(0);
    expect(provider.modes()).toContain("image_set");
    expect(provider.plannerView().id).toBe(provider.id);
    const p = makeInput({}, provider.plannerView()).plan;
    for (const it of p.items.filter((i) => i.status === "planned")) {
      expect(provider.capabilities()).toContain(it.capability);
    }
    expect(p.items.find((i) => i.criterionKey === "lip_sync")!.status).toBe("unsupported");
  });
  it("returns exactly one finding per criterion of the batch, valid enums, evidence within the request", async () => {
    const inp = makeInput({}, provider.plannerView());
    for (const b of inp.plan.batches) {
      const out = await provider.analyzeBatch({ batch: b, input: inp, media: mediaFor(inp), ctx: ctx() });
      expect(out.findings.map((f) => f.criterionKey).sort()).toEqual([...b.criterionKeys].sort());
      const allowed = new Set([...b.referenceInputIds, ...b.outputInputIds]);
      for (const f of out.findings) {
        expect(["pass", "warn", "fail", "unchecked"]).toContain(f.result);
        if (f.confidence != null) expect(f.confidence).toBeGreaterThanOrEqual(0);
        if (f.confidence != null) expect(f.confidence).toBeLessThanOrEqual(1);
        for (const e of f.evidence) expect(allowed.has(e.input)).toBe(true);
        expect(Object.keys(f)).not.toContain("severity");
      }
    }
  });
  it("estimates without throwing and never returns a negative cost", () => {
    const inp = makeInput({}, provider.plannerView());
    const e = provider.estimate(inp, new Date());
    expect(e.expectedUsd).toBeGreaterThanOrEqual(0);
  });
  it("is deterministic for identical inputs", async () => {
    const inp = makeInput({}, provider.plannerView());
    const b = inp.plan.batches[0]!;
    const a1 = await provider.analyzeBatch({ batch: b, input: inp, media: mediaFor(inp), ctx: ctx() });
    const a2 = await factory().analyzeBatch({ batch: b, input: inp, media: mediaFor(inp), ctx: ctx() });
    expect(a1.findings.map((f) => [f.criterionKey, f.result])).toEqual(
      a2.findings.map((f) => [f.criterionKey, f.result]),
    );
  });
});
