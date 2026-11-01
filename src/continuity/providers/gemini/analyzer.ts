import type { AnalyzerCapability } from "@/domain/continuity/model";
import {
  actualCost as computeActualCost,
  estimateCost,
  estimateTokens,
  type ActualCost,
  type CostEstimateUsd,
  type ModelPricing,
  type PricingTable,
} from "@/domain/continuity/analysis/cost";
import type { PlannerAnalyzer } from "@/domain/continuity/analysis/plan";
import { buildCorrectionText, buildPrompt } from "@/domain/continuity/analysis/prompt";
import { uncheckedFinding, validateBatchResponse } from "@/domain/continuity/analysis/schema";
import {
  DEFAULT_ANALYSIS_BUDGET,
  type AnalysisBatch,
  type AnalysisMode,
  type ContinuityAnalysisInput,
  type NormalizedFinding,
} from "@/domain/continuity/analysis/types";
import {
  AnalysisBatchError,
  type AnalysisContext,
  type BatchOutcome,
  type ContinuityAnalysisProvider,
  type MediaBytes,
  type UsageCall,
} from "@/continuity/analysis/provider";
import {
  GEMINI_ANALYZER_ID,
  GEMINI_ANALYZER_VERSION,
  GEMINI_CROSS_CUT_ACCEPTED_FAMILIES,
  GEMINI_CROSS_CUT_CALIBRATED,
  GEMINI_CROSS_CUT_CALIBRATION_VERSION,
  GEMINI_MODELS,
  GEMINI_PRICING,
  GEMINI_SEQUENCE_ANALYSIS_VERSION,
  type GeminiConfig,
} from "./config";
import { geminiResponseJsonSchema } from "./response-schema";
import {
  GeminiTransportError,
  type GeminiPart,
  type GeminiRequest,
  type GeminiResponse,
  type GeminiTransport,
  type GeminiTurn,
} from "./transport";

/** Image-set capabilities Gemini is asked to judge. Temporal ones need direct video and are opt-in. */
const IMAGE_CAPABILITIES: readonly AnalyzerCapability[] = [
  "image_identity",
  "wardrobe",
  "object_presence",
  "scene_match",
  "character_count",
  "composition",
  "lighting",
];
/**
 * Temporal capabilities Prism has VALIDATED for Gemini direct video. `lip_sync` and `audio` are deliberately absent:
 * lip sync is calibration-gated (docs/temporal-video-qa.md) and stays unchecked until a live calibration passes its
 * pre-registered threshold; accepting video+audio input is not evidence of lip-sync judgement.
 */
const VIDEO_CAPABILITIES: readonly AnalyzerCapability[] = ["video_temporal"];
export const GEMINI_LIP_SYNC_CALIBRATED = false;

const REFUSAL_FINISH = new Set([
  "SAFETY",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "RECITATION",
]);

export function maxOutputTokensFor(criteria: number, cap: number): number {
  return Math.min(cap, Math.max(1024, 1024 + 450 * criteria));
}

export interface GeminiProviderOptions {
  config: GeminiConfig;
  transport: GeminiTransport;
  pricing?: PricingTable;
  /**
   * TESTS AND THE CALIBRATION HARNESS ONLY: the semantic cut families to treat as accepted, so the request constructor
   * can be exercised end to end. The registry never passes it: production uses `GEMINI_CROSS_CUT_ACCEPTED_FAMILIES`
   * (empty in 3A.4D) and its calibration identity.
   */
  testCrossCutCalibration?: { version: string; acceptedFamilies: readonly string[] };
}

/**
 * Maps a failed Files-API upload honestly. A confirmed 429/503 means the provider refused it (safe to requeue). A
 * timeout, network or 5xx failure is AMBIGUOUS: the bytes may have reached Gemini and a temporary file may exist that
 * Prism never learned the name of (so cannot delete; Gemini deletes it automatically after 48 hours). It is
 * `outcome_unknown`, never retried automatically and never reported as "nothing was sent". No analysis request was
 * made after a failed upload, so no analysis cost was incurred by it.
 */
function uploadError(err: unknown): AnalysisBatchError {
  const e = err instanceof GeminiTransportError ? err : null;
  const status = e?.httpStatus ?? undefined;
  if (e?.category === "rate_limit" || e?.category === "overloaded")
    return new AnalysisBatchError(
      e.category,
      "video_upload_refused",
      "The analyzer refused the video upload (busy); nothing was analysed. It will be retried later.",
      [],
      false,
      e.retryAfterMs ?? undefined,
      status,
    );
  if (e?.category === "auth" || e?.category === "invalid_input")
    return new AnalysisBatchError(
      e.category,
      "video_upload_rejected",
      "The analyzer rejected the video upload; nothing was analysed.",
      [],
      false,
      undefined,
      status,
    );
  return new AnalysisBatchError(
    "outcome_unknown",
    "video_upload_outcome_unknown",
    "The video upload did not complete and its outcome is unknown: the provider may hold a temporary copy that Prism cannot delete (Gemini deletes it automatically after 48 hours). Nothing was analysed; it will not be retried automatically.",
    [],
    false,
    undefined,
    status,
  );
}

export class GeminiAnalysisProvider implements ContinuityAnalysisProvider {
  readonly id = GEMINI_ANALYZER_ID;
  readonly version = GEMINI_ANALYZER_VERSION;
  readonly kind = "model" as const;
  readonly label = "Gemini multimodal continuity analyzer";
  readonly model: string;
  private readonly cfg: GeminiConfig;
  private readonly transport: GeminiTransport;
  private readonly pricingTable: PricingTable;
  private readonly calibration: { version: string; acceptedFamilies: readonly string[] };

  constructor(opts: GeminiProviderOptions) {
    this.cfg = opts.config;
    this.model = opts.config.model;
    this.transport = opts.transport;
    this.pricingTable = opts.pricing ?? GEMINI_PRICING;
    this.calibration = opts.testCrossCutCalibration ?? {
      version: GEMINI_CROSS_CUT_CALIBRATION_VERSION,
      acceptedFamilies: GEMINI_CROSS_CUT_CALIBRATED ? GEMINI_CROSS_CUT_ACCEPTED_FAMILIES : [],
    };
  }

  /** The settings every request carries, read by `request()` and by a preregistered calibration's identity check. */
  inferenceSettings() {
    return {
      thinkingLevel: this.cfg.thinkingLevel,
      maxOutputTokensCap: this.cfg.maxOutputTokensCap,
      temperature: 0,
      timeoutMs: this.cfg.timeoutMs,
    };
  }

  /** Shot modes share v3; the cut contract has its own version (`gemini-sequence-1`). */
  analysisVersion(mode: AnalysisMode): string | null {
    return mode === "sequence_transition" ? GEMINI_SEQUENCE_ANALYSIS_VERSION : this.version;
  }
  crossCutCalibration() {
    return { version: this.calibration.version, acceptedFamilies: [...this.calibration.acceptedFamilies] };
  }

  /**
   * Image capabilities, plus the internal `cross_cut` (it can execute the cut CONTRACT) whenever sequence media may be
   * sent here. `cross_cut` never plans a family by itself: each family needs calibration acceptance.
   */
  capabilities(): readonly AnalyzerCapability[] {
    return this.directVideoAvailable() ? [...IMAGE_CAPABILITIES, "cross_cut"] : IMAGE_CAPABILITIES;
  }
  /** The server gate AND a model whose verified record accepts video input. */
  private directVideoAvailable(): boolean {
    return (
      this.cfg.directVideo &&
      Boolean(GEMINI_MODELS.find((m) => m.id === this.model)?.inputs.includes("video"))
    );
  }
  /** Cut-edge clips are bounded video: the sequence mode needs the same server video gate as direct video. */
  modes(): readonly AnalysisMode[] {
    return this.directVideoAvailable() ? ["image_set", "direct_video", "sequence_transition"] : ["image_set"];
  }
  videoCapabilities() {
    return this.directVideoAvailable() ? VIDEO_CAPABILITIES : [];
  }
  videoTransfer(byteSize: number): "inline" | "provider_file" {
    return byteSize > GeminiAnalysisProvider.INLINE_VIDEO_MAX_BYTES ? "provider_file" : "inline";
  }
  plannerView(): PlannerAnalyzer {
    return {
      id: this.id,
      model: this.model,
      capabilities: this.capabilities(),
      modes: this.modes(),
      videoCapabilities: this.videoCapabilities(),
      crossCutFamilies: this.calibration.acceptedFamilies,
    };
  }

  /** Pricing for the configured model; null = unknown model: cost cannot be estimated and the gate blocks. */
  pricing(): ModelPricing | null {
    return this.pricingTable.models.find((m) => m.provider === "gemini" && m.model === this.model) ?? null;
  }

  actualCost(calls: UsageCall[], at: Date): ActualCost {
    const pricing = this.pricing();
    if (!pricing) {
      return {
        amountUsd: null,
        inputTokens: null,
        outputTokens: null,
        thoughtsTokens: null,
        pricingVersion: this.pricingTable.version,
      };
    }
    return computeActualCost(calls, pricing, this.pricingTable, at);
  }

  estimate(input: ContinuityAnalysisInput, at: Date): CostEstimateUsd {
    const pricing = this.pricing();
    const byId = new Map(input.media.map((m) => [m.inputId, m] as const));
    const byKey = new Map(input.criteria.map((c) => [c.key, c] as const));
    let expected = 0;
    let max = 0;
    let inputTokens = 0;
    let maxOut = 0;
    for (const batch of input.plan.batches) {
      const prompt = buildPrompt({
        batch,
        criteria: batch.criterionKeys.flatMap((k) => (byKey.get(k) ? [byKey.get(k)!] : [])),
        media: input.media,
        framing: { productionAspectRatio: input.framing.productionAspectRatio },
      });
      const promptChars = prompt.parts.reduce((n, p) => n + (p.text?.length ?? 0), 0);
      const media = [...batch.referenceInputIds, ...batch.outputInputIds].flatMap((id) =>
        byId.get(id) ? [byId.get(id)!] : [],
      );
      const maxOutputTokens = maxOutputTokensFor(batch.criterionKeys.length, this.cfg.maxOutputTokensCap);
      const tokens = estimateTokens({
        media,
        promptChars,
        criteria: batch.criterionKeys.length,
        maxOutputTokens,
        budget: input.plan.budget ?? DEFAULT_ANALYSIS_BUDGET,
        videoFps: batch.sampling?.fps,
      });
      inputTokens += tokens.inputTokens;
      maxOut += tokens.maxOutputTokens;
      if (!pricing) continue;
      const one = estimateCost(tokens, pricing, this.pricingTable, at);
      // worst case: one correction call re-sends the input plus the previous (max-size) answer
      const correction = estimateCost(
        { ...tokens, inputTokens: tokens.inputTokens + tokens.maxOutputTokens + 300 },
        pricing,
        this.pricingTable,
        at,
      );
      expected += one.expectedUsd;
      max += one.maxUsd + correction.maxUsd;
    }
    return {
      expectedUsd: pricing ? Math.round(expected * 1e6) / 1e6 : Number.NaN,
      maxUsd: pricing ? Math.round(max * 1e6) / 1e6 : Number.NaN,
      tokens: { inputTokens, expectedOutputTokens: Math.round(maxOut / 2), maxOutputTokens: maxOut },
      pricingVersion: this.pricingTable.version,
      basis: pricing
        ? `${input.plan.batches.length} request(s), ~${inputTokens} input tokens, ceiling ${maxOut} output tokens, +1 correction worst case (pricing ${this.pricingTable.version})`
        : `No pricing is configured for model ${this.model}: cost unknown`,
    };
  }

  /**
   * Largest video sent inline. Prism-owned and conservative (well under the documented inline request limit, prompt
   * text included); anything bigger goes through a TEMPORARY Files-API copy that is deleted after the analysis.
   */
  static readonly INLINE_VIDEO_MAX_BYTES = 12 * 1024 * 1024;

  private async toParts(
    spec: ReturnType<typeof buildPrompt>,
    media: Map<string, MediaBytes>,
    ctx: AnalysisContext,
    batch: AnalysisBatch,
    approvedTransfer: ReadonlyMap<string, string> = new Map(),
  ): Promise<GeminiPart[]> {
    const parts: GeminiPart[] = [];
    for (const p of spec.parts) {
      if (p.kind === "text") {
        parts.push({ type: "text", text: p.text ?? "" });
        continue;
      }
      const m = media.get(p.inputId ?? "");
      if (!m)
        throw new AnalysisBatchError("invalid_input", "missing_media", `Input ${p.inputId} was not loaded.`);
      const isVideo = m.mime.startsWith("video/");
      if (isVideo && batch.mode !== "direct_video" && batch.mode !== "sequence_transition")
        throw new AnalysisBatchError(
          "invalid_input",
          "video_not_planned",
          "A still-image batch cannot send video.",
        );
      // 3A.4D: a cut-edge clip leaves Prism ONLY by the transfer method the person confirmed for that exact clip;
      // a provider never silently picks another (more persistent) one. Refused before any upload or request.
      const approved = approvedTransfer.get(p.inputId ?? "");
      if (isVideo && approved !== undefined && approved !== this.videoTransfer(m.bytes.length))
        throw new AnalysisBatchError(
          "local_policy_block",
          "transfer_not_approved",
          `Input ${p.inputId} would be sent as ${this.videoTransfer(m.bytes.length)}, but ${approved} was confirmed; nothing was sent.`,
        );
      const videoFps = isVideo ? batch.sampling?.fps : undefined;
      if (isVideo && !videoFps)
        throw new AnalysisBatchError(
          "invalid_input",
          "no_sampling_policy",
          "A direct-video batch has no frozen sampling policy; nothing was sent.",
        );
      if (isVideo && this.videoTransfer(m.bytes.length) === "provider_file") {
        if (!this.transport.uploadFile) {
          throw new AnalysisBatchError(
            "invalid_input",
            "video_too_large",
            "The video is too large to send inline and Files API is unavailable.",
          );
        }
        // the upload is an outbound request: it is counted (and may be refused) BEFORE it happens
        await ctx.beforeTransportCall?.({ batch, kind: "upload" });
        let f: { name: string; uri: string };
        try {
          f = await this.transport.uploadFile({
            bytes: m.bytes,
            mimeType: m.mime,
            displayName: p.inputId ?? "video",
          });
        } catch (err) {
          throw uploadError(err);
        }
        ctx.onProviderFile?.(f.name);
        parts.push({ type: "file", mimeType: m.mime, fileUri: f.uri, videoFps });
      } else {
        parts.push({
          type: "inline",
          mimeType: m.mime,
          dataBase64: Buffer.from(m.bytes).toString("base64"),
          ...(videoFps ? { videoFps } : {}),
        });
      }
    }
    return parts;
  }

  async cleanupFiles(refs: string[]) {
    const out: Array<{ ref: string; state: "deleted" | "cleanup_failed" }> = [];
    for (const ref of refs) {
      try {
        if (!this.transport.deleteFile) throw new Error("no delete support");
        await this.transport.deleteFile(ref);
        out.push({ ref, state: "deleted" });
      } catch {
        out.push({ ref, state: "cleanup_failed" });
      }
    }
    return out;
  }

  private request(
    spec: ReturnType<typeof buildPrompt>,
    turns: GeminiTurn[],
    criteria: number,
    ctx: AnalysisContext,
    mode: AnalysisMode,
  ): GeminiRequest {
    const settings = this.inferenceSettings();
    return {
      model: this.model,
      systemInstruction: spec.systemInstruction,
      turns,
      responseJsonSchema: geminiResponseJsonSchema(mode, criteria),
      maxOutputTokens: maxOutputTokensFor(criteria, settings.maxOutputTokensCap),
      temperature: settings.temperature,
      thinkingLevel: settings.thinkingLevel,
      timeoutMs: settings.timeoutMs,
      signal: ctx.signal,
    };
  }

  /**
   * EXACTLY ONE transport invocation. There is no retry loop here: a 429/503 proves the provider processed
   * nothing, but when to ask again is the durable queue's decision (persisted `next_run_at`, exponential
   * backoff), never a rapid in-process loop. A timeout or network failure is ambiguous (the request may have been
   * processed and billed) and surfaces as `outcome_unknown`; it is never re-sent.
   *
   * `beforeTransportCall` runs first and may refuse locally (ceiling reached): that throws before the transport
   * is touched, so a local policy block is never mistaken for a request that left the process.
   */
  private async call(
    req: GeminiRequest,
    ctx: AnalysisContext,
    calls: UsageCall[],
    kind: UsageCall["kind"],
    batch: AnalysisBatch,
  ): Promise<GeminiResponse> {
    await ctx.beforeTransportCall?.({ batch, kind });
    try {
      const res = await this.transport.generate(req);
      calls.push({
        kind,
        inputTokens: res.usage?.promptTokens ?? null,
        outputTokens: res.usage?.candidatesTokens ?? null,
        thoughtsTokens: res.usage?.thoughtsTokens ?? null,
      });
      return res;
    } catch (err) {
      if (err instanceof AnalysisBatchError) throw err;
      const e =
        err instanceof GeminiTransportError
          ? err
          : new GeminiTransportError("network", null, "Analysis request failed.");
      if (e.category === "timeout" || e.category === "network") {
        throw new AnalysisBatchError(
          "outcome_unknown",
          e.category,
          "The analysis request did not complete and may have been processed. Prism will not re-send it automatically; start a new analysis if needed.",
          calls,
          true,
        );
      }
      throw new AnalysisBatchError(
        e.category,
        `http_${e.httpStatus ?? "error"}`,
        e.message,
        calls,
        e.httpStatus != null,
        e.retryAfterMs ?? undefined,
        e.httpStatus ?? undefined,
      );
    }
  }

  async analyzeBatch(args: {
    batch: AnalysisBatch;
    input: ContinuityAnalysisInput;
    media: Map<string, MediaBytes>;
    ctx: AnalysisContext;
  }): Promise<BatchOutcome> {
    const { batch, input, ctx } = args;
    const byKey = new Map(input.criteria.map((c) => [c.key, c] as const));
    const spec = buildPrompt({
      batch,
      criteria: batch.criterionKeys.flatMap((k) => (byKey.get(k) ? [byKey.get(k)!] : [])),
      media: input.media,
      framing: { productionAspectRatio: input.framing.productionAspectRatio },
    });
    const approved = new Map(
      input.media.flatMap((m) => (m.edge?.transfer ? [[m.inputId, m.edge.transfer] as const] : [])),
    );
    const userTurn: GeminiTurn = {
      role: "user",
      parts: await this.toParts(spec, args.media, ctx, batch, approved),
    };
    const calls: UsageCall[] = [];

    const first = await this.call(
      this.request(spec, [userTurn], batch.criterionKeys.length, ctx, batch.mode),
      ctx,
      calls,
      "analysis",
      batch,
    );

    const refusal = (res: GeminiResponse): boolean =>
      Boolean(res.blockReason) || (res.finishReason != null && REFUSAL_FINISH.has(res.finishReason));
    const refused = (res: GeminiResponse): BatchOutcome => ({
      batchId: batch.id,
      findings: batch.criterionKeys.map((k) =>
        uncheckedFinding(
          k,
          "provider_refusal",
          "The provider declined to evaluate this criterion; it is unchecked, not failed.",
        ),
      ),
      calls,
      correctionUsed: calls.some((c) => c.kind === "correction"),
      providerRef: res.responseId,
      refused: true,
    });
    if (refusal(first)) return refused(first);

    let outcome = validateBatchResponse(first.text, batch, input.media);
    let last = first;
    let correctionUsed = false;
    if (!outcome.ok) {
      if (ctx.canCorrect && !ctx.canCorrect()) {
        // the run's correction allowance is spent: fail visibly instead of exceeding the approved call count
        throw new AnalysisBatchError(
          "schema_invalid",
          "correction_budget_exhausted",
          `The analyzer's answer was invalid and this run's correction allowance is used up (${outcome.errors.slice(0, 3).join("; ")}).`,
          calls,
          true,
        );
      }
      // exactly ONE correction request (media is re-sent: continuation is not relied upon)
      correctionUsed = true;
      const correction: GeminiTurn[] = [
        userTurn,
        { role: "model", parts: [{ type: "text", text: (first.text ?? "").slice(0, 8000) }] },
        {
          role: "user",
          parts: [{ type: "text", text: buildCorrectionText(outcome.errors, first.text ?? "") }],
        },
      ];
      last = await this.call(
        this.request(spec, correction, batch.criterionKeys.length, ctx, batch.mode),
        ctx,
        calls,
        "correction",
        batch,
      );
      if (refusal(last)) return refused(last);
      outcome = validateBatchResponse(last.text, batch, input.media);
      if (!outcome.ok) {
        throw new AnalysisBatchError(
          "schema_invalid",
          "schema_invalid_after_correction",
          `The analyzer's answer was invalid even after one correction (${outcome.errors.slice(0, 3).join("; ")}).`,
          calls,
          true,
        );
      }
    }
    const findings: NormalizedFinding[] = [
      ...outcome.findings,
      ...outcome.missing.map((k) =>
        uncheckedFinding(k, "not_returned", "The analyzer did not return an answer for this criterion."),
      ),
    ];
    return {
      batchId: batch.id,
      findings,
      calls,
      correctionUsed,
      providerRef: last.responseId,
      refused: false,
    };
  }
}
