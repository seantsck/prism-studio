import type { ProductionProposal } from "@/domain/story/proposal";
import type { ProposalSection } from "./prompt";

/**
 * Phase 5B-S1: the provider-neutral Story Intelligence boundary. Domain and UI code only ever see a Prism
 * ProductionProposal (validated by `validateProposal`); no vendor response shape crosses this interface.
 *
 *   analyzeScript   source text → a full proposal
 *   reviseProposal  source text + previous proposal + one section → a full proposal with that section revised
 *                   (analyzeSection is the same operation; S1 regenerates one section through it)
 *
 * Implementations: `FakeStoryProvider` (free, deterministic, no network) and `OpenAIStoryProvider` (the first real
 * provider). A Claude implementation only has to implement this interface.
 */
export interface StoryModel {
  provider: string;
  modelId: string;
  label: string;
  /** Free models never need a spend confirmation. */
  paid: boolean;
  /** Per 1M tokens, USD (paid models); used for the pre-request ceiling estimate and the actual cost. */
  pricing: { inputPerMillionUsd: number; outputPerMillionUsd: number; version: string } | null;
  /** The output budget sent with every request (also the estimate's output ceiling). */
  maxOutputTokens: number;
  contextTokens: number;
}

export interface StoryUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface StoryAnalysisRequest {
  model: StoryModel;
  /** The normalized source text (line numbers are added by the provider's prompt). */
  text: string;
  title: string | null;
  /** Set for a section revision. */
  revise?: { previous: ProductionProposal; section: ProposalSection; note: string };
  /** Validates an answer against the source; providers use it to request ONE correction before failing. */
  validate: (raw: unknown) => { ok: true; proposal: ProductionProposal } | { ok: false; errors: string[] };
  signal?: AbortSignal;
}

export type StoryAnalysisResult =
  | { ok: true; proposal: ProductionProposal; usage: StoryUsage; providerCalls: number }
  | {
      ok: false;
      code: "invalid_output" | "refused" | "incomplete" | "provider_error" | "not_configured" | "ambiguous";
      message: string;
      usage: StoryUsage;
      providerCalls: number;
      /** Whether the worker may try again (rate limit / overload); never for an ambiguous outcome. */
      retryable: boolean;
    };

export interface StoryIntelligenceProvider {
  readonly id: string;
  models(): StoryModel[];
  /** Missing credentials / not enabled: the reason, or null when usable. Checked by the web AND the worker. */
  unavailable(model: StoryModel): string | null;
  analyze(req: StoryAnalysisRequest): Promise<StoryAnalysisResult>;
}

/** Ceiling estimate (USD) for a request: input tokens + the full output budget at the model's prices. */
export function estimateUsd(model: StoryModel, inputTokens: number): number {
  if (!model.paid || !model.pricing) return 0;
  const raw =
    (inputTokens * model.pricing.inputPerMillionUsd +
      model.maxOutputTokens * model.pricing.outputPerMillionUsd) /
    1_000_000;
  return Math.ceil(raw * 10000) / 10000;
}

export function actualUsd(model: StoryModel, usage: StoryUsage): number | null {
  if (!model.paid || !model.pricing) return 0;
  if (usage.inputTokens == null || usage.outputTokens == null) return null;
  return (
    (usage.inputTokens * model.pricing.inputPerMillionUsd +
      usage.outputTokens * model.pricing.outputPerMillionUsd) /
    1_000_000
  );
}
