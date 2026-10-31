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
import {
  ANALYSIS_RESPONSE_JSON_SCHEMA,
  uncheckedFinding,
  validateBatchResponse,
} from "@/domain/continuity/analysis/schema";
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
  OPENAI_ANALYZER_ID,
  OPENAI_ANALYZER_VERSION,
  OPENAI_IMAGE_DETAIL,
  OPENAI_PRICING,
  openaiImageTokens,
  type OpenAIConfig,
} from "./config";
import {
  OpenAITransportError,
  type OpenAIContentPart,
  type OpenAIInputItem,
  type OpenAIRequest,
  type OpenAIResponse,
  type OpenAITransport,
} from "./transport";

/** Image-set capabilities the analyzer is asked to judge (temporal ones need video: not offered here). */
const IMAGE_CAPABILITIES: readonly AnalyzerCapability[] = [
  "image_identity",
  "wardrobe",
  "object_presence",
  "scene_match",
  "character_count",
  "composition",
  "lighting",
];

/** Formats the Responses API documents for image input. */
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Output ceiling for one answer. Reasoning tokens count against `max_output_tokens`, so it is not tight. */
export function openaiMaxOutputTokens(criteria: number, cap: number): number {
  return Math.min(cap, 2048 + 450 * criteria);
}

export interface OpenAIProviderOptions {
  config: OpenAIConfig;
  transport: OpenAITransport;
  pricing?: PricingTable;
}

export class OpenAIContinuityAnalyzer implements ContinuityAnalysisProvider {
  readonly id = OPENAI_ANALYZER_ID;
  readonly version = OPENAI_ANALYZER_VERSION;
  readonly kind = "model" as const;
  readonly label = "OpenAI multimodal continuity analyzer";
  readonly model: string;
  private readonly cfg: OpenAIConfig;
  private readonly transport: OpenAITransport;
  private readonly pricingTable: PricingTable;

  constructor(opts: OpenAIProviderOptions) {
    this.cfg = opts.config;
    this.model = opts.config.model;
    this.transport = opts.transport;
    this.pricingTable = opts.pricing ?? OPENAI_PRICING;
  }

  capabilities() {
    return IMAGE_CAPABILITIES;
  }
  /**
   * 3A.4D: OpenAI has NO sequence-transition contract (two-video cut analysis is never faked through stills here), so a
   * transition job can never execute on it.
   */
  analysisVersion(mode: AnalysisMode): string | null {
    return mode === "sequence_transition" ? null : this.version;
  }
  crossCutCalibration() {
    return { version: "openai-no-sequence", acceptedFamilies: [] as string[] };
  }
  /** Image-set only: direct video is not offered by this adapter. */
  modes(): readonly AnalysisMode[] {
    return ["image_set"];
  }
  videoCapabilities(): readonly AnalyzerCapability[] {
    return [];
  }
  plannerView(): PlannerAnalyzer {
    return {
      id: this.id,
      model: this.model,
      capabilities: this.capabilities(),
      modes: this.modes(),
      videoCapabilities: [],
    };
  }

  /** Pricing for the configured model; null = unknown model: cost cannot be estimated and the gate blocks. */
  pricing(): ModelPricing | null {
    return this.pricingTable.models.find((m) => m.provider === "openai" && m.model === this.model) ?? null;
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
      const promptChars =
        prompt.parts.reduce((n, p) => n + (p.text?.length ?? 0), 0) + prompt.systemInstruction.length;
      const media = [...batch.referenceInputIds, ...batch.outputInputIds].flatMap((id) =>
        byId.get(id) ? [byId.get(id)!] : [],
      );
      const maxOutputTokens = openaiMaxOutputTokens(batch.criterionKeys.length, this.cfg.maxOutputTokensCap);
      const tokens = estimateTokens({
        media,
        promptChars,
        criteria: batch.criterionKeys.length,
        maxOutputTokens,
        budget: input.plan.budget ?? DEFAULT_ANALYSIS_BUDGET,
        imageTokenFn: openaiImageTokens,
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
        ? `${input.plan.batches.length} request(s), ≤ ~${inputTokens} input tokens (image tokens are a ceiling, not a quote), ceiling ${maxOut} output tokens incl. reasoning, +1 correction worst case (pricing ${this.pricingTable.version})`
        : `No pricing is configured for model ${this.model}: cost unknown`,
    };
  }

  private toParts(spec: ReturnType<typeof buildPrompt>, media: Map<string, MediaBytes>): OpenAIContentPart[] {
    const parts: OpenAIContentPart[] = [];
    for (const p of spec.parts) {
      if (p.kind === "text") {
        parts.push({ type: "input_text", text: p.text ?? "" });
        continue;
      }
      const m = media.get(p.inputId ?? "");
      if (!m)
        throw new AnalysisBatchError("invalid_input", "missing_media", `Input ${p.inputId} was not loaded.`);
      if (!IMAGE_MIMES.has(m.mime)) {
        throw new AnalysisBatchError(
          "invalid_input",
          "unsupported_media",
          `Input ${p.inputId} is ${m.mime}, which this analyzer cannot send as an image.`,
        );
      }
      parts.push({
        type: "input_image",
        imageUrl: `data:${m.mime};base64,${Buffer.from(m.bytes).toString("base64")}`,
        detail: OPENAI_IMAGE_DETAIL,
      });
    }
    return parts;
  }

  private request(
    spec: ReturnType<typeof buildPrompt>,
    input: OpenAIInputItem[],
    criteria: number,
    ctx: AnalysisContext,
  ): OpenAIRequest {
    return {
      model: this.model,
      instructions: spec.systemInstruction,
      input,
      jsonSchema: ANALYSIS_RESPONSE_JSON_SCHEMA,
      schemaName: "continuity_analysis",
      maxOutputTokens: openaiMaxOutputTokens(criteria, this.cfg.maxOutputTokensCap),
      reasoningEffort: this.cfg.reasoningEffort,
      timeoutMs: this.cfg.timeoutMs,
      signal: ctx.signal,
    };
  }

  /**
   * EXACTLY ONE transport invocation. No retry loop and no SDK retry: a 429/503 proves the provider processed
   * nothing, but WHEN to ask again is the durable queue's decision (persisted `next_run_at`). A timeout or a
   * lost connection is ambiguous (the request may have been processed and billed) and surfaces as
   * `outcome_unknown`; it is never re-sent (no documented idempotency guarantee for Responses `create`).
   *
   * `beforeTransportCall` runs first and may refuse locally (ceiling reached): that throws before the transport
   * is touched, so a local policy block is never mistaken for a request that left the process.
   */
  private async call(
    req: OpenAIRequest,
    ctx: AnalysisContext,
    calls: UsageCall[],
    kind: UsageCall["kind"],
    batch: AnalysisBatch,
  ): Promise<OpenAIResponse> {
    await ctx.beforeTransportCall?.({ batch, kind });
    try {
      const res = await this.transport.create(req);
      const u = res.usage;
      // OpenAI reports reasoning tokens as a SUBSET of output tokens: split them so the shared cost code
      // (output + thoughts at the output rate) never double-counts.
      const reasoning = u?.reasoningTokens ?? null;
      const answerOut = u?.outputTokens != null ? Math.max(0, u.outputTokens - (reasoning ?? 0)) : null;
      calls.push({
        kind,
        inputTokens: u?.inputTokens ?? null,
        outputTokens: answerOut,
        thoughtsTokens: u?.outputTokens != null ? (reasoning ?? 0) : null,
        cachedInputTokens: u?.cachedTokens ?? null,
      });
      return res;
    } catch (err) {
      if (err instanceof AnalysisBatchError) throw err;
      const e =
        err instanceof OpenAITransportError
          ? err
          : new OpenAITransportError("network", null, "Analysis request failed.");
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
        e.providerCode && e.category === "config"
          ? `http_${e.httpStatus}_${e.providerCode}`
          : `http_${e.httpStatus ?? "error"}`,
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
    const userTurn: OpenAIInputItem = { role: "user", content: this.toParts(spec, args.media) };
    const calls: UsageCall[] = [];

    const first = await this.call(
      this.request(spec, [userTurn], batch.criterionKeys.length, ctx),
      ctx,
      calls,
      "analysis",
      batch,
    );

    // A refusal (Structured Outputs `refusal` item) or a content-filter stop is NOT a continuity result.
    const refusal = (res: OpenAIResponse): boolean =>
      res.refusal != null || res.incompleteReason === "content_filter";
    const refused = (res: OpenAIResponse): BatchOutcome => ({
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
      const correction: OpenAIInputItem[] = [
        userTurn,
        { role: "assistant", content: [{ type: "output_text", text: (first.text ?? "").slice(0, 8000) }] },
        {
          role: "user",
          content: [{ type: "input_text", text: buildCorrectionText(outcome.errors, first.text ?? "") }],
        },
      ];
      last = await this.call(
        this.request(spec, correction, batch.criterionKeys.length, ctx),
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
