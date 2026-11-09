import type { ProductionProposal } from "@/domain/story/proposal";
import type { ShotPlan, ShotPlanScope, ShotPlanningContext } from "@/domain/story/shot-list";
import type { ScopeKind, WritingMode, WritingResult } from "@/domain/story/writing";
import type { ProposalSection } from "./prompt";
import type { WritingContext } from "./writing-prompt";

/**
 * Phase 5B-S1: the provider-neutral Story Intelligence boundary. Domain and UI code only ever see a Prism
 * ProductionProposal (validated by `validateProposal`); no vendor response shape crosses this interface.
 *
 *   analyzeScript   source text → a full proposal
 *   reviseProposal  source text + previous proposal + one section → a full proposal with that section revised
 *                   (analyzeSection is the same operation; S1 regenerates one section through it)
 *
 * Phase 5B-S2 adds ONE writing operation, `write`, over provider-neutral domain inputs and outputs. Its `operation`
 * covers the conceptual calls:
 *   rewriteStoryRange   operation "rewrite"   (rewrite / dialogue / tone / condense / expand / custom modes)
 *   continueStory       operation "continue"
 *   brainstormStory     operation "brainstorm"
 *   reviseStoryProposal operation "revise"    (Revise again: a DRAFT alternative + a new instruction)
 * Phase 5B-S4 adds `planShots(ShotPlanRequest) → ShotPlan` (a whole Scene, or one Shot regenerated).
 * The answer is always a Prism `WritingResult` (validated by `validateWriting`), never a vendor shape.
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

export type WritingOperation = "rewrite" | "continue" | "brainstorm" | "revise";

export const writingOperation = (mode: WritingMode, revising: boolean): WritingOperation =>
  revising ? "revise" : mode === "continue" ? "continue" : mode === "brainstorm" ? "brainstorm" : "rewrite";

export interface WritingRequest {
  model: StoryModel;
  operation: WritingOperation;
  mode: WritingMode;
  scopeKind: ScopeKind;
  instruction: string;
  /** Alternatives (or ideas, for a brainstorm) requested. */
  count: number;
  targetText: string;
  /** Revise again: the alternative being revised. */
  draftText: string | null;
  context: WritingContext;
  /** The output budget frozen with the estimate (never above the model maximum). */
  maxOutputTokens: number;
  validate: (raw: unknown) => { ok: true; result: WritingResult } | { ok: false; errors: string[] };
  signal?: AbortSignal;
}

export type WritingCallResult =
  | { ok: true; result: WritingResult; usage: StoryUsage; providerCalls: number }
  | Extract<StoryAnalysisResult, { ok: false }>;

export interface StoryIntelligenceProvider {
  readonly id: string;
  models(): StoryModel[];
  /** Missing credentials / not enabled: the reason, or null when usable. Checked by the web AND the worker. */
  unavailable(model: StoryModel): string | null;
  analyze(req: StoryAnalysisRequest): Promise<StoryAnalysisResult>;
  /** Phase 5B-S2: one writing turn (rewrite / continue / brainstorm / revise). */
  write(req: WritingRequest): Promise<WritingCallResult>;
  /** Phase 5B-S4: a Shot List for one Scene (or one Shot of an earlier plan, regenerated). */
  planShots(req: ShotPlanRequest): Promise<ShotPlanCallResult>;
}

/** Phase 5B-S4: `planShots` — provider-neutral input (the frozen Scene snapshot) and output (a Prism ShotPlan). */
export interface ShotPlanRequest {
  model: StoryModel;
  context: ShotPlanningContext;
  sceneText: string;
  scope: ShotPlanScope;
  /** A one-Shot regeneration: the plan it revises. */
  basePlan: ShotPlan | null;
  maxOutputTokens: number;
  validate: (raw: unknown) => { ok: true; plan: ShotPlan } | { ok: false; errors: string[] };
  signal?: AbortSignal;
}

export type ShotPlanCallResult =
  | { ok: true; plan: ShotPlan; usage: StoryUsage; providerCalls: number }
  | Extract<StoryAnalysisResult, { ok: false }>;

/** Ceiling estimate (USD) for a request: input tokens + the full output budget at the model's prices. */
export function estimateUsd(
  model: StoryModel,
  inputTokens: number,
  outputTokens = model.maxOutputTokens,
): number {
  if (!model.paid || !model.pricing) return 0;
  const raw =
    (inputTokens * model.pricing.inputPerMillionUsd + outputTokens * model.pricing.outputPerMillionUsd) /
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
