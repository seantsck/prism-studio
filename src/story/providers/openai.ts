import { PROPOSAL_JSON_SCHEMA } from "@/domain/story/proposal";
import { OPENAI_MODELS, OPENAI_PRICING } from "@/continuity/providers/openai/config";
import {
  OpenAITransportError,
  type OpenAIInputItem,
  type OpenAITransport,
} from "@/continuity/providers/openai/transport";
import { analysisInput, revisionInput, STORY_INSTRUCTIONS } from "../prompt";
import type {
  StoryAnalysisRequest,
  StoryAnalysisResult,
  StoryIntelligenceProvider,
  StoryModel,
} from "../provider";

/**
 * Phase 5B-S1: OpenAI Story Intelligence — the FIRST real provider. It reuses Prism's existing, verified OpenAI
 * Responses transport (`openai@7.32.0`, SDK retries off, `store: false`, Structured Outputs with a strict JSON
 * schema) and the verified model + pricing configuration of the continuity analyzer: no new SDK, no new price source.
 *
 * Secret boundary: the key is read ONLY where the provider is constructed with `env` — the Story worker. The web
 * process builds this provider without a key to list the model and price it; it can never call it.
 *
 * At most TWO outbound calls per analysis: the answer and, if Prism's validator rejects it, one correction turn. A
 * timeout or network failure is an AMBIGUOUS outcome: it is never re-sent automatically.
 */
export const OPENAI_STORY_PROVIDER_ID = "openai";
export const OPENAI_STORY_SECRET_ENV = "PRISM_STUDIO_PROVIDER_OPENAI_STORY_API_KEY";
const MAX_OUTPUT_TOKENS = 32_000;

function storyModels(): StoryModel[] {
  return OPENAI_MODELS.filter((m) => m.structuredOutputs).flatMap((m) => {
    const rate = OPENAI_PRICING.models.find((p) => p.provider === "openai" && p.model === m.id)?.rates.at(-1);
    return rate
      ? [
          {
            provider: OPENAI_STORY_PROVIDER_ID,
            modelId: m.id,
            label: m.label,
            paid: true,
            pricing: {
              inputPerMillionUsd: rate.inputPerMillionUsd,
              outputPerMillionUsd: rate.outputPerMillionUsd,
              version: OPENAI_PRICING.version,
            },
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            contextTokens: 272_000,
          },
        ]
      : [];
  });
}

export class OpenAIStoryProvider implements StoryIntelligenceProvider {
  readonly id = OPENAI_STORY_PROVIDER_ID;

  constructor(
    private readonly opts: {
      env: Record<string, string | undefined>;
      /** Built lazily, only when an analysis actually runs (the worker); tests pass a FakeOpenAITransport. */
      transport?: (apiKey: string) => OpenAITransport;
    },
  ) {}

  models() {
    return storyModels();
  }

  private key() {
    return this.opts.env[OPENAI_STORY_SECRET_ENV]?.trim() || null;
  }

  unavailable(model: StoryModel) {
    if (!this.models().some((m) => m.modelId === model.modelId))
      return "That model is not configured for Prism AI.";
    return null; // the KEY is checked by the worker only (the web never holds it)
  }

  async analyze(req: StoryAnalysisRequest): Promise<StoryAnalysisResult> {
    const usage = { inputTokens: 0 as number | null, outputTokens: 0 as number | null };
    const key = this.key();
    if (!key)
      return {
        ok: false,
        code: "not_configured",
        message: "Prism AI (OpenAI) is not set up on the worker.",
        usage,
        providerCalls: 0,
        retryable: false,
      };
    const transport = this.opts.transport
      ? this.opts.transport(key)
      : new (await import("@/continuity/providers/openai/sdk-transport")).SdkOpenAITransport({ apiKey: key });
    const first: OpenAIInputItem = {
      role: "user",
      content: [
        {
          type: "input_text",
          text: req.revise
            ? revisionInput(req.text, req.revise.previous, req.revise.section, req.revise.note)
            : analysisInput(req.text, req.title),
        },
      ],
    };
    const input: OpenAIInputItem[] = [first];
    let calls = 0;
    for (let turn = 0; turn < 2; turn++) {
      calls++;
      let res;
      try {
        res = await transport.create({
          model: req.model.modelId,
          instructions: STORY_INSTRUCTIONS,
          input,
          jsonSchema: PROPOSAL_JSON_SCHEMA,
          schemaName: "production_proposal",
          maxOutputTokens: req.model.maxOutputTokens,
          reasoningEffort: "low",
          timeoutMs: 300_000,
          signal: req.signal,
        });
      } catch (err) {
        const e = err instanceof OpenAITransportError ? err : null;
        const ambiguous = !e || e.category === "timeout" || e.category === "network";
        return {
          ok: false,
          code: ambiguous ? "ambiguous" : "provider_error",
          message: e?.message ?? "The analysis request failed.",
          usage,
          providerCalls: calls,
          retryable: !ambiguous && (e!.category === "rate_limit" || e!.category === "overloaded"),
        };
      }
      usage.inputTokens = (usage.inputTokens ?? 0) + (res.usage?.inputTokens ?? 0);
      usage.outputTokens = (usage.outputTokens ?? 0) + (res.usage?.outputTokens ?? 0);
      if (!res.usage) {
        usage.inputTokens = null;
        usage.outputTokens = null;
      }
      if (res.refusal)
        return {
          ok: false,
          code: "refused",
          message: "The model declined to analyse this text.",
          usage,
          providerCalls: calls,
          retryable: false,
        };
      if (res.status === "incomplete")
        return {
          ok: false,
          code: "incomplete",
          message: `The analysis was cut short (${res.incompleteReason ?? "incomplete"}). Try a shorter text or a section.`,
          usage,
          providerCalls: calls,
          retryable: false,
        };
      const v = req.validate(res.text ?? "");
      if (v.ok) return { ok: true, proposal: v.proposal, usage, providerCalls: calls };
      // one correction turn: the model sees its answer and Prism's validation errors (never source excerpts)
      input.push({ role: "assistant", content: [{ type: "output_text", text: res.text ?? "" }] });
      input.push({
        role: "user",
        content: [
          {
            type: "input_text",
            text: `That answer is not a valid Production Proposal. Fix these problems and answer again with the complete object:\n- ${v.errors.join("\n- ")}`,
          },
        ],
      });
      if (turn === 1)
        return {
          ok: false,
          code: "invalid_output",
          message: `The analysis did not match the Production Proposal schema: ${v.errors.slice(0, 3).join("; ")}`,
          usage,
          providerCalls: calls,
          retryable: false,
        };
    }
    return {
      ok: false,
      code: "invalid_output",
      message: "No valid answer.",
      usage,
      providerCalls: calls,
      retryable: false,
    };
  }
}
