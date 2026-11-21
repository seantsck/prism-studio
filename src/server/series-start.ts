import "server-only";
import type { Episode, ProjectData } from "@/domain/schemas";
import { estimateInputTokens, normalizeSourceText } from "@/domain/story/source";
import { canonical, estimateWritingInputTokens, scopeOf, writingOutputTokens } from "@/domain/story/writing";
import { estimateUsd } from "@/story/provider";
import { buildWritingContext } from "@/story/writing-context";
import { WRITING_INSTRUCTIONS, writingInput } from "@/story/writing-prompt";
import { episodeOneInstruction } from "@/domain/series-start";
import { getStoryRegistry } from "./story";

/**
 * Starting a series from a prompt: the premise → Episode 1's screenplay (the existing writing assistant, "Continue" on
 * the empty Episode) → a Production Proposal (the existing Import Story) → the creator reviews and applies it. These are
 * the prices of the two AI steps, worked out exactly as the actions that run them work them out, so the amount on each
 * button is the amount they will accept. Nothing here queues or spends.
 */

export interface StepQuote {
  ok: true;
  /** "provider/modelId", sent with the request so it is priced with the same model. */
  model: string;
  label: string;
  paid: boolean;
  usd: number;
}
export type StepQuoteResult = StepQuote | { ok: false; reason: string };

function firstAvailable() {
  const registry = getStoryRegistry();
  // a free model first, as Import Story suggests; the creator can still choose another on those pages
  const models = registry.models();
  const listed = models.find((m) => m.available && !m.paid) ?? models.find((m) => m.available);
  if (!listed) return { registry, model: null, reason: "Prism AI is not set up on this server." };
  return { registry, model: registry.model(listed.provider, listed.modelId)!, reason: null };
}

export function quoteWriteEpisode(data: ProjectData, episode: Episode, premise: string): StepQuoteResult {
  const { registry, model, reason } = firstAvailable();
  if (!model) return { ok: false, reason: reason! };
  const text = canonical(episode.scriptText);
  const scope = scopeOf(text, "episode", { start: 0, end: text.length }, null);
  const instruction = episodeOneInstruction(data, premise);
  const context = buildWritingContext({ data, episode, text, scope, instruction, conversation: [] });
  const promptText = writingInput({
    mode: "continue",
    instruction,
    count: 1,
    scopeKind: scope.kind,
    context,
    targetText: text.slice(scope.start, scope.end),
    draftText: null,
  });
  const inputTokens = estimateWritingInputTokens(WRITING_INSTRUCTIONS, promptText);
  const maxOutputTokens = writingOutputTokens(
    "continue",
    1,
    scope.end - scope.start,
    model.maxOutputTokens || 32_000,
  );
  if (model.paid && inputTokens + maxOutputTokens > model.contextTokens)
    return { ok: false, reason: "The request is too long for the model." };
  const usd = estimateUsd(model, inputTokens, maxOutputTokens);
  if (model.paid && usd > registry.spend.maxUsd)
    return { ok: false, reason: `It would cost up to $${usd.toFixed(4)}, over this server's limit.` };
  return { ok: true, model: `${model.provider}/${model.modelId}`, label: model.label, paid: model.paid, usd };
}

export function quoteAnalyzeEpisode(episode: Episode): StepQuoteResult {
  const { registry, model, reason } = firstAvailable();
  if (!model) return { ok: false, reason: reason! };
  const text = normalizeSourceText(episode.scriptText);
  if (!text) return { ok: false, reason: "Episode 1 has no script yet." };
  const inputTokens = estimateInputTokens(text);
  if (inputTokens + model.maxOutputTokens > model.contextTokens)
    return { ok: false, reason: "The script is too long to analyse in one go." };
  const usd = estimateUsd(model, inputTokens);
  if (model.paid && usd > registry.spend.maxUsd)
    return { ok: false, reason: `It would cost up to $${usd.toFixed(4)}, over this server's limit.` };
  return { ok: true, model: `${model.provider}/${model.modelId}`, label: model.label, paid: model.paid, usd };
}
