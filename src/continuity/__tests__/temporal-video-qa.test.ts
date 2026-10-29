import { describe, expect, it, vi } from "vitest";
import {
  analysisSpendBlockers,
  estimateTokens,
  type AnalysisSpendPolicy,
} from "@/domain/continuity/analysis/cost";
import { buildAnalysisPlan, videoIneligibility } from "@/domain/continuity/analysis/plan";
import { validateBatchResponse } from "@/domain/continuity/analysis/schema";
import {
  formatEvidenceTime,
  LIP_SYNC_NOT_CALIBRATED,
  TEMPORAL_SAMPLING_V1,
  temporalCoverage,
  videoInputTokens,
} from "@/domain/continuity/analysis/temporal";
import {
  DEFAULT_ANALYSIS_BUDGET,
  type AnalysisBatch,
  type AnalysisMedia,
  type PlanItem,
} from "@/domain/continuity/analysis/types";
import {
  defaultQaPolicy,
  directVideoPermitted,
  projectBudgetBlockers,
  type ProjectQaPolicy,
} from "@/domain/continuity/automation";
import { CRITERIA, MEDIA, ctx as analysisCtx, makeInput } from "../analysis/__tests__/fixtures";
import {
  LIMITS,
  PAID,
  makeWorker,
  processor,
  setup,
  type QueueCtx,
} from "../analysis/__tests__/queue-harness";
import { AnalysisBatchError, type ContinuityAnalysisProvider } from "../analysis/provider";
import { analysisIdempotencyKey, plansDirectVideo, submitAnalysis } from "../analysis/submit";
import { reconcileAttemptQa, type AutoQaDeps } from "../automation";
import { GEMINI_LIP_SYNC_CALIBRATED, GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { GEMINI_ANALYZER_VERSION, GEMINI_PRICING, readGeminiConfig } from "../providers/gemini/config";
import { FakeGeminiTransport, answerAll, type FakeStep } from "../providers/gemini/fake-transport";
import { GeminiTransportError, type GeminiRequest } from "../providers/gemini/transport";
import { OpenAIContinuityAnalyzer } from "../providers/openai/analyzer";
import { readOpenAIConfig } from "../providers/openai/config";
import { FakeOpenAITransport, openaiAnswerAll } from "../providers/openai/fake-transport";

/**
 * Phase 3A.3 Temporal Video QA: planning, consent, evidence, cost, provider files, mixed image/video runs, retries
 * and automatic orchestration. Fake transports only: no Gemini, OpenAI, generation or paid call.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const hasFfmpeg = await processor.available();
const media = hasFfmpeg ? describe : describe.skip;

const ON = readGeminiConfig({
  PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
  GEMINI_API_KEY: "k",
  PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
});
const OFF = readGeminiConfig({ PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini", GEMINI_API_KEY: "k" });
const gemini = (script: ConstructorParameters<typeof FakeGeminiTransport>[0], config = ON) => {
  const transport = new FakeGeminiTransport(script);
  return { transport, provider: new GeminiAnalysisProvider({ config, transport }) };
};
const isVideoRequest = (req: GeminiRequest) => JSON.stringify(req.responseJsonSchema).includes('"endMs"');
const item = (plan: { items: PlanItem[] }, key: string) => plan.items.find((i) => i.criterionKey === key)!;

// ───────────────────────── planning (pure) ─────────────────────────

describe("temporal planning: server gate, Project consent, video eligibility, lip-sync gate", () => {
  const video = MEDIA.find((m) => m.kind === "video")!;

  it("direct video OFF on the server: temporal criteria stay unsupported, nothing is sent", () => {
    const { provider } = gemini([], OFF);
    const p = buildAnalysisPlan({
      analyzer: provider.plannerView(),
      criteria: CRITERIA,
      media: MEDIA,
      directVideoAllowed: true,
    });
    expect(item(p, "screen_direction")).toMatchObject({ status: "unsupported" });
    expect(item(p, "screen_direction").reason).toMatch(/server disabled|does not offer/);
    expect(p.batches.some((b) => b.mode === "direct_video")).toBe(false);
    expect(p.manifest.entries.find((e) => e.kind === "video")).toMatchObject({
      sent: false,
      omissionReason: "direct_video_disabled",
    });
  });

  it("server ON but the Project has NOT allowed full video: still criteria planned, temporal not sent", () => {
    const { provider } = gemini([]);
    const p = buildAnalysisPlan({ analyzer: provider.plannerView(), criteria: CRITERIA, media: MEDIA });
    expect(item(p, "screen_direction")).toMatchObject({ status: "not_allowed" });
    expect(item(p, "screen_direction").reason).toMatch(/has not allowed full-video analysis/);
    expect(p.batches.length).toBeGreaterThan(0);
    expect(p.batches.every((b) => b.mode === "image_set")).toBe(true);
    expect(p.manifest.entries.find((e) => e.kind === "video")).toMatchObject({
      sent: false,
      omissionReason: "direct_video_not_allowed",
    });
  });

  it("consent + server gate + supported video: temporal criteria become ONE direct-video batch with the frozen sampling", () => {
    const { provider } = gemini([]);
    const p = buildAnalysisPlan({
      analyzer: provider.plannerView(),
      criteria: CRITERIA,
      media: MEDIA,
      directVideoAllowed: true,
    });
    const vb = p.batches.filter((b) => b.mode === "direct_video");
    expect(vb).toHaveLength(1);
    expect(vb[0]).toMatchObject({
      outputInputIds: ["video"],
      referenceInputIds: [],
      promptVersion: "continuity-gemini-video-v2",
      sampling: { policy: "shot-temporal-static-v1", fps: 4 },
    });
    // still batches never carry the full video
    for (const b of p.batches.filter((x) => x.mode === "image_set"))
      expect(b.outputInputIds).not.toContain("video");
    expect(p.manifest.entries.find((e) => e.kind === "video")).toMatchObject({
      sent: true,
      derivative: null,
    });
    expect(item(p, "lip_sync")).toMatchObject({ status: "unsupported", reason: LIP_SYNC_NOT_CALIBRATED });
  });

  it("an image output (no video): temporal criteria are no_media with a clear reason", () => {
    const { provider } = gemini([]);
    const p = buildAnalysisPlan({
      analyzer: provider.plannerView(),
      criteria: CRITERIA,
      media: MEDIA.filter((m) => m.kind !== "video"),
      directVideoAllowed: true,
    });
    expect(item(p, "screen_direction")).toMatchObject({ status: "no_media" });
    expect(item(p, "screen_direction").reason).toMatch(/not a video/);
  });

  it("video outside Prism's bounds is refused BEFORE transport (duration, size, format, unknown duration)", () => {
    expect(videoIneligibility(video, TEMPORAL_SAMPLING_V1)).toBeNull();
    expect(videoIneligibility({ ...video, durationMs: 40_000 }, TEMPORAL_SAMPLING_V1)).toMatch(/longer/);
    expect(videoIneligibility({ ...video, durationMs: null }, TEMPORAL_SAMPLING_V1)).toMatch(/unknown/);
    expect(videoIneligibility({ ...video, byteSize: 200 * 1024 * 1024 }, TEMPORAL_SAMPLING_V1)).toMatch(
      /larger/,
    );
    expect(videoIneligibility({ ...video, mime: "video/quicktime" }, TEMPORAL_SAMPLING_V1)).toMatch(/format/);
    // no recorded checksum: Prism could not prove which file it sends, so the video is never planned
    expect(videoIneligibility({ ...video, checksum: null }, TEMPORAL_SAMPLING_V1)).toMatch(/checksum/);
    const { provider } = gemini([]);
    const p = buildAnalysisPlan({
      analyzer: provider.plannerView(),
      criteria: CRITERIA,
      media: MEDIA.map((m) => (m.kind === "video" ? { ...m, durationMs: 40_000 } : m)),
      directVideoAllowed: true,
    });
    expect(item(p, "screen_direction")).toMatchObject({ status: "no_media" });
    expect(p.manifest.entries.find((e) => e.kind === "video")!.omissionReason).toBe("video_not_eligible");
  });

  it("OpenAI never plans direct video (video input is unsupported by its models), even with consent", () => {
    const openai = new OpenAIContinuityAnalyzer({
      config: readOpenAIConfig({
        PRISM_STUDIO_CONTINUITY_ANALYZERS: "openai",
        OPENAI_API_KEY: "sk-test-0000",
      }),
      transport: new FakeOpenAITransport(openaiAnswerAll("pass")),
    });
    expect(openai.modes()).toEqual(["image_set"]);
    expect(openai.videoCapabilities()).toEqual([]);
    const p = buildAnalysisPlan({
      analyzer: openai.plannerView(),
      criteria: CRITERIA,
      media: MEDIA,
      directVideoAllowed: true,
    });
    expect(item(p, "screen_direction")).toMatchObject({ status: "unsupported" });
    expect(p.batches.some((b) => b.mode === "direct_video")).toBe(false);
  });

  it("lip sync is calibration-gated: Gemini declares video_temporal only", () => {
    expect(GEMINI_LIP_SYNC_CALIBRATED).toBe(false);
    const { provider } = gemini([]);
    expect(provider.videoCapabilities()).toEqual(["video_temporal"]);
    // 3 = the compact, batch-aware Gemini response schema (v2's was refused with HTTP 400); prompt/schema unchanged
    expect(GEMINI_ANALYZER_VERSION).toBe("3");
  });

  it("the planner never sends video without consent even when the caller forgets to pass it (default false)", () => {
    const { provider } = gemini([]);
    const p = buildAnalysisPlan({ analyzer: provider.plannerView(), criteria: CRITERIA, media: MEDIA });
    expect(p.manifest.entries.some((e) => e.kind === "video" && e.sent)).toBe(false);
  });
});

describe("Project full-video permission (0045)", () => {
  const P = (o: Partial<ProjectQaPolicy> = {}) => ({ ...defaultQaPolicy("p1"), ...o });
  it("defaults to false; manual needs it; automatic also needs the standing media consent", () => {
    expect(defaultQaPolicy("p").directVideoAllowed).toBe(false);
    expect(directVideoPermitted(P(), "manual")).toBe(false);
    expect(directVideoPermitted(P({ directVideoAllowed: true }), "manual")).toBe(true);
    expect(directVideoPermitted(P({ directVideoAllowed: true }), "automatic")).toBe(false);
    expect(
      directVideoPermitted(P({ directVideoAllowed: true, externalMediaAllowed: true }), "automatic"),
    ).toBe(true);
    // the 3A.2 standing media consent alone never implies the full video
    expect(directVideoPermitted(P({ externalMediaAllowed: true }), "automatic")).toBe(false);
  });
});

// ───────────────────────── evidence ─────────────────────────

describe("temporal evidence validation (schema 2)", () => {
  const vmedia: AnalysisMedia[] = MEDIA;
  const vb: AnalysisBatch = {
    id: "b9",
    mode: "direct_video",
    promptVersion: "continuity-gemini-video-v2",
    criterionKeys: ["screen_direction"],
    referenceInputIds: [],
    outputInputIds: ["video"],
    omittedReferenceInputIds: [],
    sampling: { policy: "shot-temporal-static-v1", fps: 4 },
  };
  const answer = (evidence: unknown[], result = "pass", extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      criteria: [
        {
          criterionId: "screen_direction",
          result,
          confidence: 0.7,
          summary: "Moves right-to-left.",
          evidence,
          contradictions: [],
          limitations: [],
          ...extra,
        },
      ],
    });
  const ev = (o: Record<string, unknown> = {}) => ({
    input: "video",
    timestampMs: 1000,
    endMs: 2500,
    observation: "Crosses the frame.",
    ...o,
  });

  it("accepts a timestamp + interval inside the clip and normalises it", () => {
    const out = validateBatchResponse(answer([ev()]), vb, vmedia);
    expect(out.ok).toBe(true);
    if (out.ok)
      expect(out.findings[0]!.evidence[0]).toMatchObject({
        input: "video",
        atMs: 1000,
        endMs: 2500,
        source: "video",
      });
  });

  it.each([
    ["timestamp < 0", ev({ timestampMs: -1 })],
    ["timestamp after the clip (4500 ms)", ev({ timestampMs: 4600, endMs: null })],
    ["interval runs backwards", ev({ timestampMs: 3000, endMs: 2000 })],
    ["interval ends after the clip", ev({ endMs: 5000 })],
    ["evidence on an unsent input", ev({ input: "frame:0" })],
    ["non-integer timestamp", ev({ timestampMs: 1000.5 })],
    ["video evidence without a timestamp", ev({ timestampMs: null, endMs: null })],
  ])("rejects %s", (_name, bad) => {
    expect(validateBatchResponse(answer([bad]), vb, vmedia).ok).toBe(false);
  });

  it("endpoints are inclusive by decision: [0, durationMs] for a moment and an interval end; one past is rejected", () => {
    // durationMs (4500) is the clip's final instant as Prism records it; provider timestamps are coarse (the
    // sampling interval), so an event in the last sample may legitimately be reported AT the duration
    expect(validateBatchResponse(answer([ev({ timestampMs: 0, endMs: null })]), vb, vmedia).ok).toBe(true);
    expect(validateBatchResponse(answer([ev({ timestampMs: 4500, endMs: null })]), vb, vmedia).ok).toBe(true);
    expect(validateBatchResponse(answer([ev({ timestampMs: 4000, endMs: 4500 })]), vb, vmedia).ok).toBe(true);
    expect(validateBatchResponse(answer([ev({ timestampMs: 4500, endMs: 4500 })]), vb, vmedia).ok).toBe(true);
    expect(validateBatchResponse(answer([ev({ timestampMs: 4501, endMs: null })]), vb, vmedia).ok).toBe(
      false,
    );
    expect(validateBatchResponse(answer([ev({ timestampMs: 4000, endMs: 4501 })]), vb, vmedia).ok).toBe(
      false,
    );
  });

  it("direct-video evidence must cite THE sent video: a reference sent alongside it cannot carry a timestamp", () => {
    const withRef: AnalysisBatch = { ...vb, referenceInputIds: ["ref:identity:1"] };
    expect(
      validateBatchResponse(answer([ev({ input: "ref:identity:1", endMs: null })]), withRef, vmedia).ok,
    ).toBe(false);
    expect(validateBatchResponse(answer([ev({ input: "sheet" })]), vb, vmedia).ok).toBe(false);
  });

  it("a pass/warn/fail with NO timestamped video evidence is rejected; unchecked without evidence is fine", () => {
    expect(validateBatchResponse(answer([], "fail"), vb, vmedia).ok).toBe(false);
    expect(validateBatchResponse(answer([], "unchecked"), vb, vmedia).ok).toBe(true);
  });

  it.each([["severity"], ["approved"], ["score"]])("rejects a provider-supplied %s", (field) => {
    expect(validateBatchResponse(answer([ev()], "pass", { [field]: "major" }), vb, vmedia).ok).toBe(false);
  });

  it("an image-set answer can never invent a time range or a timestamp on a still", () => {
    const ib = {
      criterionKeys: ["screen_direction"],
      referenceInputIds: ["ref:identity:1"],
      outputInputIds: ["frame:0"],
      mode: "image_set" as const,
    };
    const media2: AnalysisMedia[] = [
      ...MEDIA.filter((m) => m.inputId === "ref:identity:1"),
      { ...MEDIA.find((m) => m.kind === "output_frame")!, inputId: "frame:0", atMs: 0 },
    ];
    const still = (e: Record<string, unknown>) =>
      JSON.stringify({
        criteria: [
          {
            criterionId: "screen_direction",
            result: "pass",
            confidence: 0.5,
            summary: "ok",
            evidence: [{ input: "frame:0", timestampMs: null, observation: "x", ...e }],
            contradictions: [],
            limitations: [],
          },
        ],
      });
    expect(validateBatchResponse(still({}), ib, media2).ok).toBe(true);
    expect(validateBatchResponse(still({ timestampMs: 0 }), ib, media2).ok).toBe(true); // the frame's own time
    expect(validateBatchResponse(still({ endMs: 2000 }), ib, media2).ok).toBe(false); // no ranges on stills
    expect(validateBatchResponse(still({ timestampMs: 1200 }), ib, media2).ok).toBe(false);
    expect(validateBatchResponse(still({ input: "ref:identity:1", timestampMs: 5 }), ib, media2).ok).toBe(
      false,
    );
  });

  it("malformed temporal evidence takes the ONE correction, then fails visibly", async () => {
    const bad: FakeStep = {
      kind: "json",
      body: JSON.parse(answer([ev({ timestampMs: 99_999, endMs: null })])),
    };
    const { transport, provider } = gemini([bad, bad]);
    const input = makeInput({}, provider.plannerView(), { directVideoAllowed: true });
    const b = input.plan.batches.find((x) => x.mode === "direct_video")!;
    const mediaBytes = new Map([
      ["video", { inputId: "video", mime: "video/mp4", bytes: new Uint8Array(64) }],
    ]);
    await expect(
      provider.analyzeBatch({ batch: b, input, media: mediaBytes, ctx: analysisCtx() }),
    ).rejects.toMatchObject({ category: "schema_invalid", code: "schema_invalid_after_correction" });
    expect(transport.calls).toBe(2);
  });
});

// ───────────────────────── cost ─────────────────────────

describe("direct-video cost estimate (conservative; the ceiling is the spend gate)", () => {
  it("grows with duration, is non-negative, and is at least the documented per-frame + audio cost", () => {
    const t = (ms: number) => videoInputTokens(ms, TEMPORAL_SAMPLING_V1);
    expect(t(2000)).toBeLessThan(t(8000));
    expect(t(0)).toBeGreaterThan(0);
    // documented: 258 tokens/frame (default resolution) + 32 tokens/s audio, at the policy's 4 fps
    expect(t(10_000)).toBeGreaterThanOrEqual(40 * 258 + 10 * 32);
    const est = (ms: number | null) =>
      estimateTokens({
        media: [{ kind: "video", width: null, height: null, durationMs: ms }],
        promptChars: 1000,
        criteria: 3,
        maxOutputTokens: 2000,
        budget: DEFAULT_ANALYSIS_BUDGET,
        videoFps: 4,
      }).inputTokens;
    expect(est(8000)).toBeGreaterThan(est(4000));
    // an unknown duration is priced at the maximum temporal length, never shrunk
    expect(est(null)).toBe(est(TEMPORAL_SAMPLING_V1.maxDurationMs));
  });

  it("uses the configured model pricing; a direct-video plan costs more than the same plan without video", () => {
    const { provider } = gemini([]);
    const withVideo = provider.estimate(
      makeInput({}, provider.plannerView(), { directVideoAllowed: true }),
      new Date("2026-11-01"),
    );
    const without = provider.estimate(makeInput({}, provider.plannerView()), new Date("2026-11-01"));
    expect(withVideo.maxUsd).toBeGreaterThan(without.maxUsd);
    expect(withVideo.pricingVersion).toBe(GEMINI_PRICING.version);
  });

  it("Project and global gates both block an over-ceiling or unknown estimate; direct video bypasses neither", () => {
    const policy = { ...defaultQaPolicy("p"), maxCostPerRunUsd: 0.001, maxCostPerDayUsd: 1 };
    expect(projectBudgetBlockers({ policy, maxEstimateUsd: 0.01, projectSpentLast24hUsd: 0 })).not.toEqual(
      [],
    );
    expect(projectBudgetBlockers({ policy, maxEstimateUsd: null, projectSpentLast24hUsd: 0 })[0]!.code).toBe(
      "project_budget.unknown_cost",
    );
    const global: AnalysisSpendPolicy = { enabled: true, maxUsdPerRun: 0.001, maxUsdPerDay: 1 };
    expect(analysisSpendBlockers({ policy: global, maxEstimateUsd: 0.01, spentLast24hUsd: 0 })).not.toEqual(
      [],
    );
    expect(analysisSpendBlockers({ policy: global, maxEstimateUsd: null, spentLast24hUsd: 0 })).not.toEqual(
      [],
    );
  });

  it("actual cost comes ONLY from provider usage: no usage is UNKNOWN, never zero", () => {
    const { provider } = gemini([]);
    expect(
      provider.actualCost(
        [{ kind: "analysis", inputTokens: null, outputTokens: null, thoughtsTokens: null }],
        new Date("2026-11-01"),
      ).amountUsd,
    ).toBeNull();
    expect(
      provider.actualCost(
        [{ kind: "analysis", inputTokens: 10_000, outputTokens: 500, thoughtsTokens: 0 }],
        new Date("2026-11-01"),
      ).amountUsd,
    ).toBeGreaterThan(0);
  });
});

// ───────────────────────── provider files ─────────────────────────

describe("Gemini direct video transfer: inline vs temporary provider file", () => {
  const big = new Uint8Array(13 * 1024 * 1024);
  it("a large video is uploaded ONLY after the upload is counted; a refused count uploads nothing", async () => {
    const { transport, provider } = gemini(answerAll("pass", "video"));
    const input = makeInput({}, provider.plannerView(), { directVideoAllowed: true });
    const b = input.plan.batches.find((x) => x.mode === "direct_video")!;
    const kinds: string[] = [];
    const files: string[] = [];
    await provider.analyzeBatch({
      batch: b,
      input,
      media: new Map([["video", { inputId: "video", mime: "video/mp4", bytes: big }]]),
      ctx: {
        ...analysisCtx(),
        beforeTransportCall: async ({ kind }) => void kinds.push(kind),
        onProviderFile: (r) => void files.push(r),
      },
    });
    expect(kinds).toEqual(["upload", "analysis"]);
    expect(files).toEqual(["files/fake-1"]);
    expect(transport.uploads).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({ fileParts: 1, inlineVideos: 0, videoFps: [4] });
    // the frozen plan / manifest never contains the provider URI
    expect(JSON.stringify(input)).not.toContain("fake://");

    const t2 = gemini(answerAll("pass", "video"));
    await expect(
      t2.provider.analyzeBatch({
        batch: b,
        input,
        media: new Map([["video", { inputId: "video", mime: "video/mp4", bytes: big }]]),
        ctx: {
          ...analysisCtx(),
          beforeTransportCall: async () => {
            throw new AnalysisBatchError("local_policy_block", "ceiling", "limit reached");
          },
        },
      }),
    ).rejects.toMatchObject({ category: "local_policy_block" });
    expect(t2.transport.uploads).toHaveLength(0);
    expect(t2.transport.calls).toBe(0);
  });

  it.each([
    ["timeout", null, "outcome_unknown"],
    ["network", null, "outcome_unknown"],
    ["server_error", 500, "outcome_unknown"],
    ["rate_limit", 429, "rate_limit"],
    ["overloaded", 503, "overloaded"],
    ["auth", 401, "auth"],
    ["invalid_input", 400, "invalid_input"],
  ] as const)(
    "a failed upload (%s) is classified honestly and no analysis request follows it",
    async (category, status, expected) => {
      const { transport, provider } = gemini(answerAll("pass", "video"));
      transport.uploadFile = async () => {
        throw new GeminiTransportError(category, status, "upload failed");
      };
      const input = makeInput({}, provider.plannerView(), { directVideoAllowed: true });
      const b = input.plan.batches.find((x) => x.mode === "direct_video")!;
      const err = await provider
        .analyzeBatch({
          batch: b,
          input,
          media: new Map([["video", { inputId: "video", mime: "video/mp4", bytes: big }]]),
          ctx: analysisCtx(),
        })
        .catch((e: unknown) => e as AnalysisBatchError);
      expect(err).toBeInstanceOf(AnalysisBatchError);
      expect((err as AnalysisBatchError).category).toBe(expected);
      // an ambiguous upload may have reached the provider: never "nothing was sent", never auto-retried
      expect((err as AnalysisBatchError).message).not.toMatch(/nothing was sent/i);
      if (expected === "outcome_unknown")
        expect((err as AnalysisBatchError).message).toMatch(/temporary copy.*48 hours/);
      expect(transport.calls).toBe(0);
    },
  );

  it("a small video is inline (no provider file); cleanup reports deleted / cleanup_failed and never throws", async () => {
    const { transport, provider } = gemini(answerAll("pass", "video"));
    const input = makeInput({}, provider.plannerView(), { directVideoAllowed: true });
    const b = input.plan.batches.find((x) => x.mode === "direct_video")!;
    await provider.analyzeBatch({
      batch: b,
      input,
      media: new Map([["video", { inputId: "video", mime: "video/mp4", bytes: new Uint8Array(1024) }]]),
      ctx: analysisCtx(),
    });
    expect(transport.uploads).toHaveLength(0);
    expect(transport.requests[0]).toMatchObject({ inlineVideos: 1, fileParts: 0, videoFps: [4] });
    expect(provider.videoTransfer(1024)).toBe("inline");
    expect(provider.videoTransfer(13 * 1024 * 1024)).toBe("provider_file");
    transport.failDelete = true;
    expect(await provider.cleanupFiles(["files/a"])).toEqual([{ ref: "files/a", state: "cleanup_failed" }]);
  });

  it("a still-image batch can never carry video", async () => {
    const { provider } = gemini(answerAll("pass"));
    const input = makeInput({}, provider.plannerView(), { directVideoAllowed: true });
    const still = input.plan.batches.find((x) => x.mode === "image_set")!;
    const forged = { ...still, referenceInputIds: [], outputInputIds: ["video"] };
    await expect(
      provider.analyzeBatch({
        batch: forged,
        input,
        media: new Map([["video", { inputId: "video", mime: "video/mp4", bytes: new Uint8Array(10) }]]),
        ctx: analysisCtx(),
      }),
    ).rejects.toMatchObject({ code: "video_not_planned" });
  });
});

// ───────────────────────── display helpers ─────────────────────────

describe("temporal coverage and evidence time labels", () => {
  it("is honest about precision and never calls 'analysed' 'passed'", () => {
    expect(formatEvidenceTime(3000)).toBe("≈ 00:03.0");
    expect(formatEvidenceTime(1000, 2500)).toBe("≈ 00:01.0–00:02.5");
    const cov = temporalCoverage({
      criteria: [
        { key: "camera_movement", title: "Camera movement", capability: "video_temporal" },
        { key: "lip_sync", title: "Lip sync", capability: "lip_sync" },
        { key: "identity:a", title: "Identity", capability: "image_identity" },
      ],
      planItems: [
        { criterionKey: "camera_movement", status: "planned", reason: "" },
        { criterionKey: "lip_sync", status: "unsupported", reason: LIP_SYNC_NOT_CALIBRATED },
      ],
      results: new Map([["camera_movement", { result: "fail", resultSource: "analyzer" }]]),
    });
    expect(cov).toMatchObject({ total: 2, evaluated: 1 });
    expect(cov.unchecked).toEqual([{ key: "lip_sync", title: "Lip sync", reason: LIP_SYNC_NOT_CALIBRATED }]);
  });
});

// ───────────────────────── identity / coverage ─────────────────────────

describe("analysis coverage identity", () => {
  it("adds `temporal` only when the full video is planned: every image-only key stays exactly as in 3A.2", async () => {
    const ctx = await setup();
    const { provider } = gemini([]);
    const base = analysisIdempotencyKey(ctx.inputs, provider, "n");
    expect(analysisIdempotencyKey(ctx.inputs, provider, "n", { temporal: false })).toBe(base);
    expect(analysisIdempotencyKey(ctx.inputs, provider, "n", { temporal: true })).not.toBe(base);
    // an older analyzer version (v1, image-only era) is a different identity for the same truth
    const v1 = Object.assign(Object.create(provider) as GeminiAnalysisProvider, { version: "1" });
    expect(analysisIdempotencyKey(ctx.inputs, v1, "n")).not.toBe(base);
    expect(plansDirectVideo({ inputs: ctx.inputs, provider, directVideoAllowed: true })).toBe(true);
    expect(plansDirectVideo({ inputs: ctx.inputs, provider, directVideoAllowed: false })).toBe(false);
    expect(
      plansDirectVideo({ inputs: ctx.inputs, provider: gemini([], OFF).provider, directVideoAllowed: true }),
    ).toBe(false);
  });

  it("an INELIGIBLE video is never temporal coverage: consent on gives the same image-only identity (no duplicate run)", async () => {
    const ctx = await setup();
    const { provider } = gemini([]);
    for (const bad of [
      { durationMs: 60_000 },
      { checksum: null },
      { mime: "video/quicktime" },
      { byteSize: null },
    ]) {
      const inputs = { ...ctx.inputs, subject: { ...ctx.inputs.subject!, ...bad } };
      expect(plansDirectVideo({ inputs, provider, directVideoAllowed: true })).toBe(false);
    }
  });
});

// ───────────────────────── queue: mixed runs, retries, ack, checksum ─────────────────────────

media(
  "mixed image-set + direct-video run through the shared queue (memory store, real ffmpeg, fake transport)",
  () => {
    const submitWith = (
      ctx: QueueCtx,
      provider: ContinuityAnalysisProvider,
      directVideo?: { allowed: boolean; acknowledged: boolean },
      nonce = "n1",
    ) =>
      submitAnalysis({
        inputs: ctx.inputs,
        view: ctx.view,
        assets: ctx.data.assets,
        provider,
        policy: PAID,
        deps: ctx.deps,
        acknowledged: true,
        nonce,
        limits: LIMITS,
        directVideo,
        now: ctx.h.clock.now,
      });

    it("one run, image batches + a video batch with exactly their own media; findings merged with time evidence", async () => {
      const ctx = await setup();
      const g = gemini(answerAll("pass"));
      const { run, job } = await submitWith(ctx, g.provider, { allowed: true, acknowledged: true });
      const plan = job.inputSnapshot.plan;
      expect(plan.batches.some((b) => b.mode === "image_set")).toBe(true);
      const vb = plan.batches.filter((b) => b.mode === "direct_video");
      expect(vb).toHaveLength(1);
      expect(job.inputSnapshot.schemaVersion).toBe(2);
      expect(job.inputSnapshot.analyzerVersion).toBe(GEMINI_ANALYZER_VERSION);
      // the frozen video is exactly the current subject, by asset id and checksum
      const v = job.inputSnapshot.media.find((m) => m.kind === "video")!;
      expect(v.assetId).toBe(ctx.inputs.subject!.id);
      expect(v.checksum).toBe(ctx.inputs.subject!.checksum);
      expect(job.inputAssetIds).toContain(ctx.inputs.subject!.id);

      await makeWorker(ctx.h, g.provider).w.tick();
      const done = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
      expect(done.status).toBe("succeeded");
      const videoReqs = g.transport.requests.filter((r) => r.videoSchema);
      const stillReqs = g.transport.requests.filter((r) => !r.videoSchema);
      expect(videoReqs).toHaveLength(1);
      expect(videoReqs[0]).toMatchObject({ inlineVideos: 1, videoFps: [4] });
      expect(stillReqs.length).toBeGreaterThan(0);
      for (const r of stillReqs) expect(r.inlineVideos).toBe(0); // still batches never get the full video
      const after = (await ctx.h.repo.mediaQa.getRun(run.run.id))!;
      const temporalKey = vb[0]!.criterionKeys[0]!;
      const tf = after.findings.find((f) => f.finding.criterionKey === temporalKey)!.finding;
      expect(tf.resultSource).toBe("analyzer");
      const items = (tf.evidence as { items: Array<{ source: string; atMs: number; endMs: number }> }).items;
      expect(items[0]).toMatchObject({ source: "video" });
      expect(items[0]!.endMs).toBeGreaterThan(items[0]!.atMs);
      // lip sync / unsupported criteria stay unchecked with the plan's reason; no creative state changes
      expect(after.run.analysisStatus).toBe("complete");
      expect(ctx.view.attempt.reviewStatus).toBe(
        (await ctx.h.repo.generation.getAttemptView(ctx.attemptId))!.attempt.reviewStatus,
      );
    });

    it("a durable retry resumes at the first incomplete batch: completed batches (image or video) are never re-sent", async () => {
      const ctx = await setup();
      let videoAttempts = 0;
      const g = gemini((req, n) => {
        if (isVideoRequest(req) && videoAttempts++ === 0)
          return { kind: "error", error: new GeminiTransportError("overloaded", 503, "busy") };
        void n;
        return answerAll("pass")(req);
      });
      const { job } = await submitWith(ctx, g.provider, { allowed: true, acknowledged: true });
      const batches = job.inputSnapshot.plan.batches.length;
      const { w } = makeWorker(ctx.h, g.provider);
      await w.tick();
      const mid = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
      expect(mid.status).toBe("queued");
      const sentBefore = g.transport.calls;
      ctx.h.clock.advance(10 * 60_000);
      await w.tick();
      const done = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
      expect(done.status).toBe("succeeded");
      // only the batch that had no answer was sent again
      expect(g.transport.calls - sentBefore).toBe(
        batches - mid.batchResults.filter((b) => b.complete).length,
      );
      expect(g.transport.requests.filter((r) => r.videoSchema)).toHaveLength(2);
    });

    it("a manual run that plans the full video needs its OWN full-video acknowledgement; without consent no video is planned", async () => {
      const ctx = await setup();
      const g = gemini(answerAll("pass"));
      await expect(submitWith(ctx, g.provider, { allowed: true, acknowledged: false })).rejects.toMatchObject(
        {
          code: "needs_video_ack",
        },
      );
      const { job } = await submitWith(ctx, g.provider, { allowed: false, acknowledged: false }, "n2");
      expect(job.inputSnapshot.plan.batches.some((b) => b.mode === "direct_video")).toBe(false);
      expect(job.inputSnapshot.plan.manifest.entries.find((e) => e.kind === "video")?.sent).toBe(false);
    });

    it("a video whose bytes no longer match the frozen checksum fails as infrastructure; nothing is sent", async () => {
      const ctx = await setup();
      const g = gemini(answerAll("pass"));
      const { job } = await submitWith(ctx, g.provider, { allowed: true, acknowledged: true });
      const subject = ctx.inputs.subject!;
      await ctx.h.sink.put(
        subject.objectPath!,
        new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]),
      );
      await makeWorker(ctx.h, g.provider).w.tick();
      const failed = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
      expect(failed.status).toBe("failed");
      expect(g.transport.calls).toBe(0);
    });
  },
);

// ───────────────────────── automatic orchestration ─────────────────────────

media("automatic semantic QA and full-video consent (3A.2 orchestration, 3A.3 coverage)", () => {
  const availability = [{ id: "gemini", usable: true, kind: "model" as const, missingConfig: [] }];
  const AUTO = (o: Partial<ProjectQaPolicy> = {}): ProjectQaPolicy => ({
    ...defaultQaPolicy("p"),
    semanticMode: "automatic",
    analyzer: "gemini",
    externalMediaAllowed: true,
    maxCostPerRunUsd: 0.5,
    maxCostPerDayUsd: 5,
    revision: 1,
    ...o,
  });
  const deps = (ctx: QueueCtx, provider: ContinuityAnalysisProvider): AutoQaDeps => ({
    ...ctx.deps,
    providers: new Map([[provider.id, provider]]),
    availability,
    paid: PAID,
    limits: LIMITS,
  });
  const reconcile = async (ctx: QueueCtx, provider: ContinuityAnalysisProvider, policy: ProjectQaPolicy) =>
    reconcileAttemptQa({
      data: await ctx.h.data(),
      view: (await ctx.h.repo.generation.getAttemptView(ctx.attemptId))!,
      policy,
      deps: deps(ctx, provider),
    });
  const jobs = (ctx: QueueCtx) => ctx.h.repo.mediaQa.listAttemptAnalysisJobs(ctx.attemptId);

  it("an existing 3A.2 automatic policy (0045 default false) never sends the full video", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    const r = await reconcile(ctx, g.provider, AUTO()); // directVideoAllowed: false (the 0045 default)
    expect(r.outcomes).toContain("semantic_queued");
    const [job] = await jobs(ctx);
    expect(job!.inputSnapshot.plan.batches.every((b) => b.mode === "image_set")).toBe(true);
    expect(job!.inputSnapshot.plan.items.some((i) => i.status === "not_allowed")).toBe(true);
    expect(job!.inputSnapshot.plan.manifest.entries.find((e) => e.kind === "video")?.sent).toBe(false);
  });

  it("owner opts in → exactly ONE new temporal-capable run for unchanged truth; repeats dedupe; opting out stops new video jobs", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    await reconcile(ctx, g.provider, AUTO());
    const first = await jobs(ctx);
    expect(first).toHaveLength(1);

    const optIn = AUTO({ directVideoAllowed: true, revision: 2 });
    expect((await reconcile(ctx, g.provider, optIn)).outcomes).toContain("semantic_queued");
    const second = await jobs(ctx);
    expect(second).toHaveLength(2);
    const temporalJob = second.find((j) => j.id !== first[0]!.id)!;
    expect(temporalJob.inputSnapshot.plan.batches.some((b) => b.mode === "direct_video")).toBe(true);
    // the image-only job is untouched history (not rewritten, not stale-marked by the analyzer change)
    expect(second.find((j) => j.id === first[0]!.id)!.inputSnapshot).toEqual(first[0]!.inputSnapshot);

    expect((await reconcile(ctx, g.provider, optIn)).outcomes).toEqual(["semantic_already_queued"]);
    expect(await jobs(ctx)).toHaveLength(2);

    // opting out: future submissions are image-only again, which already exists; the video job stays as it was
    const optOut = AUTO({ directVideoAllowed: false, revision: 3 });
    expect((await reconcile(ctx, g.provider, optOut)).outcomes).toEqual(["semantic_already_queued"]);
    const third = await jobs(ctx);
    expect(third).toHaveLength(2);
    expect(third.find((j) => j.id === temporalJob.id)!.inputSnapshot).toEqual(temporalJob.inputSnapshot);

    // re-enabling with nothing else changed: the earlier temporal run already covers this exact truth + analyzer
    const reOptIn = AUTO({ directVideoAllowed: true, revision: 4 });
    expect((await reconcile(ctx, g.provider, reOptIn)).outcomes).toEqual(["semantic_already_queued"]);
    expect(await jobs(ctx)).toHaveLength(2);
  });

  it("automatic full video needs the standing external-media consent too (direct-video permission alone is not enough)", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    const r = await reconcile(
      ctx,
      g.provider,
      AUTO({ directVideoAllowed: true, externalMediaAllowed: false }),
    );
    expect(r.outcomes).not.toContain("semantic_queued");
    expect(
      (await jobs(ctx)).every((j) => j.inputSnapshot.plan.batches.every((b) => b.mode === "image_set")),
    ).toBe(true);
    expect(g.transport.calls).toBe(0);
  });

  it("a Gemini v1 (image-only era) automatic run of the same truth does not suppress a temporal run", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    const v1 = Object.assign(Object.create(g.provider) as GeminiAnalysisProvider, { version: "1" });
    expect((await reconcile(ctx, v1, AUTO())).outcomes).toContain("semantic_queued");
    expect((await reconcile(ctx, g.provider, AUTO({ directVideoAllowed: true }))).outcomes).toContain(
      "semantic_queued",
    );
    const all = await jobs(ctx);
    expect(all).toHaveLength(2);
    expect(all.map((j) => j.inputSnapshot.analyzerVersion).sort()).toEqual(["1", GEMINI_ANALYZER_VERSION]);
  });

  it("a Gemini v2 automatic job (old request contract, refused with HTTP 400) does not cover the v3 request", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    const v2 = Object.assign(Object.create(g.provider) as GeminiAnalysisProvider, { version: "2" });
    const policy = AUTO({ directVideoAllowed: true });
    expect((await reconcile(ctx, v2, policy)).outcomes).toContain("semantic_queued");
    // same truth, same stable nonce: only the analyzer version tells the fixed request apart
    expect((await reconcile(ctx, g.provider, policy)).outcomes).toContain("semantic_queued");
    const all = await jobs(ctx);
    expect(all.map((j) => j.inputSnapshot.analyzerVersion).sort()).toEqual(["2", "3"]);
    expect(new Set(all.map((j) => j.idempotencyKey)).size).toBe(2);
  });
});
