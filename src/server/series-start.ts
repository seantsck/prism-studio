import "server-only";
import type { Episode, ProjectData } from "@/domain/schemas";
import { estimateInputTokens, normalizeSourceText } from "@/domain/story/source";
import { canonical, estimateWritingInputTokens, scopeOf, writingOutputTokens } from "@/domain/story/writing";
import { estimateUsd } from "@/story/provider";
import { buildWritingContext } from "@/story/writing-context";
import { WRITING_INSTRUCTIONS, writingInput } from "@/story/writing-prompt";
import {
  episodeOneInstruction,
  freshProjectData,
  NEW_PROJECT_LIMITS,
  newProjectRecords,
  PREMISE_MAX,
  TITLE_MAX,
} from "@/domain/series-start";
import { FAKE_STORY_PROVIDER_ID } from "@/story/providers/fake";
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

/**
 * The model these one-click steps use: a REAL writer only. The free test writer returns a placeholder, so it is never
 * offered here unless this server asks for test models (PRISM_STUDIO_SHOW_TEST_MODELS=1, a test deployment); with no
 * real writer switched on, the steps say so instead of offering a placeholder.
 */
function firstAvailable() {
  const registry = getStoryRegistry();
  const tests = process.env.PRISM_STUDIO_SHOW_TEST_MODELS === "1";
  const models = registry
    .models()
    .filter((m) => m.available && (tests || m.provider !== FAKE_STORY_PROVIDER_ID));
  // a free model first when there is one (a test server), as Import Story suggests
  const listed = models.find((m) => !m.paid) ?? models[0];
  if (!listed) return { registry, model: null, reason: WRITING_AI_OFF };
  return { registry, model: registry.model(listed.provider, listed.modelId)!, reason: null };
}

/** Shown when no real writing model is switched on. */
export const WRITING_AI_OFF = "Prism's writing AI is switched off on this server.";

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

/**
 * The price of "Prism writes Episode 1" BEFORE the project exists: the same request priced for the longest new project
 * the form accepts (every field at its limit, in the densest script), so it is a true ceiling for whatever is typed. The
 * real request is priced again when it is made and accepted only within this confirmation.
 */
export function quoteNewSeriesDraft(): StepQuoteResult {
  const dense = (n: number) => "あ".repeat(n);
  const records = newProjectRecords({
    id: "00000000-0000-4000-8000-000000000000",
    userId: "00000000-0000-4000-8000-000000000001",
    title: dense(TITLE_MAX),
    slug: "ceiling",
    projectType: "series",
    description: dense(NEW_PROJECT_LIMITS.description),
    genre: dense(NEW_PROJECT_LIMITS.genre),
    tone: dense(NEW_PROJECT_LIMITS.tone),
    defaultLanguage: "x".repeat(NEW_PROJECT_LIMITS.language),
    premise: dense(PREMISE_MAX),
    now: new Date(0).toISOString(),
  });
  const data = freshProjectData(records);
  return quoteWriteEpisode(data, records.episodeOne!, records.bible.premise);
}
