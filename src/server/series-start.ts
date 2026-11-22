import "server-only";
import { BIBLE_AI_FIELDS, bibleDraftInstruction, bibleRefineInstruction } from "@/domain/bible-ai";
import type { Episode, ProjectData } from "@/domain/schemas";
import {
  REFINE_NOTE_MAX,
  seasonPlanInstruction,
  seasonRefineInstruction,
  wholeScriptInstruction,
} from "@/domain/series-start";
import { estimateInputTokens, normalizeSourceText } from "@/domain/story/source";
import { canonical, LIMITS, longFormPlan, scopeOf } from "@/domain/story/writing";
import { estimateUsd, type StoryModel } from "@/story/provider";
import { FAKE_STORY_PROVIDER_ID } from "@/story/providers/fake";
import { getStoryRegistry } from "./story";
import { priceWriting } from "./writing-price";

/**
 * Starting a series (or a film) from a prompt: plan the season, write one or every Episode (or the whole film), turn the
 * script into a Production Proposal. These are the writers on offer and the prices of those steps, worked out with the
 * same function the writing action uses, so the amount a creator confirms is the amount it accepts. Nothing here queues
 * or spends.
 */

export interface Writer {
  /** "provider/modelId" */
  value: string;
  label: string;
  paid: boolean;
  available: boolean;
  reason: string | null;
}

/** Shown when no real writing model is switched on. */
export const WRITING_AI_OFF = "Prism's writing AI is switched off on this server.";

/**
 * The writers these steps offer: REAL ones only. The free test writer returns a placeholder, so it is listed only on a
 * test server (PRISM_STUDIO_SHOW_TEST_MODELS=1).
 */
export function writers(): Writer[] {
  const tests = process.env.PRISM_STUDIO_SHOW_TEST_MODELS === "1";
  return getStoryRegistry()
    .models()
    .filter((m) => tests || m.provider !== FAKE_STORY_PROVIDER_ID)
    .map((m) => ({
      value: `${m.provider}/${m.modelId}`,
      label: m.label,
      paid: m.paid,
      available: m.available,
      reason: m.available ? null : m.reason,
    }));
}

/** "Recommended by Prism": a free writer on a test server, else the first real one switched on. */
export function recommendedWriter(): Writer | null {
  const usable = writers().filter((w) => w.available);
  return usable.find((w) => !w.paid) ?? usable[0] ?? null;
}

/** The model a step uses: the one named (when it is offered and switched on), else the recommended one. */
export function resolveWriter(
  value: string | null | undefined,
): { model: StoryModel; writer: Writer } | null {
  const offered = writers().filter((w) => w.available);
  const writer = (value && offered.find((w) => w.value === value)) || recommendedWriter();
  if (!writer) return null;
  const [provider, ...rest] = writer.value.split("/");
  const model = getStoryRegistry().model(provider!, rest.join("/"));
  return model ? { model, writer } : null;
}

/** The longest plan a refine can send: every Episode with the longest title and synopsis it can be saved with. */
export function planCeiling(data: ProjectData): ProjectData {
  return {
    ...data,
    episodes: data.episodes.map((e) => ({ ...e, title: "あ".repeat(120), synopsis: "あ".repeat(2000) })),
  };
}

/** The longest Bible (or Bible draft) a refine can send: every field at its longest. */
const BIBLE_CEILING = () =>
  Object.fromEntries(BIBLE_AI_FIELDS.map((f) => [f.key, "あ".repeat(LIMITS.ideaDetail)]));

export interface Quote {
  ok: true;
  model: string;
  label: string;
  paid: boolean;
  usd: number;
}
export type QuoteResult = Quote | { ok: false; reason: string };

const over = (model: StoryModel, usd: number, what: string): string | null => {
  const max = getStoryRegistry().spend.maxUsd;
  return model.paid && usd > max
    ? `${what} would cost up to $${usd.toFixed(4)}, over this server's limit of $${max.toFixed(2)} per request.`
    : null;
};

/**
 * The season plan: one brainstorm on Episode 1, an idea per Episode. Refining (`refine`) sends the current plan and the
 * creator's note; since the note is typed after the price is shown, it is priced for the longest note in the densest
 * script, a ceiling for whatever is typed.
 */
export function quoteSeasonPlan(
  data: ProjectData,
  writer?: string | null,
  opts: { refine?: boolean } = {},
): QuoteResult {
  const r = resolveWriter(writer);
  if (!r) return { ok: false, reason: WRITING_AI_OFF };
  // refining sends the plan as it is when the creator presses it (edits included): priced for the longest one
  const priced = opts.refine ? planCeiling(data) : data;
  const episode = [...priced.episodes].sort((a, b) => a.number - b.number)[0];
  if (!episode) return { ok: false, reason: "This project has no Episode yet." };
  const text = canonical(episode.scriptText);
  const p = priceWriting({
    data: priced,
    episode,
    text,
    scope: scopeOf(text, "episode", { start: 0, end: text.length }, null),
    mode: "brainstorm",
    instruction: opts.refine
      ? seasonRefineInstruction(data, data.episodes.length, "あ".repeat(REFINE_NOTE_MAX))
      : seasonPlanInstruction(data, data.episodes.length),
    count: data.episodes.length,
    targetText: text,
    draftText: null,
    conversation: [],
    model: r.model,
    withPlan: opts.refine,
  });
  const refused = over(r.model, p.usd, opts.refine ? "Refining the plan" : "Planning the season");
  if (refused || p.tooLong) return { ok: false, reason: refused ?? "The plan is too long for the model." };
  return { ok: true, model: r.writer.value, label: r.writer.label, paid: r.model.paid, usd: p.usd };
}

/** One whole Episode (or the whole film), written in parts. */
export function quoteWhole(data: ProjectData, episode: Episode, writer?: string | null): QuoteResult {
  const r = resolveWriter(writer);
  if (!r) return { ok: false, reason: WRITING_AI_OFF };
  const text = canonical(episode.scriptText);
  const p = priceWriting({
    data,
    episode,
    text,
    scope: scopeOf(text, "episode", { start: 0, end: text.length }, null),
    mode: "continue",
    instruction: wholeScriptInstruction(data, episode),
    count: 1,
    targetText: text,
    draftText: null,
    conversation: [],
    model: r.model,
    longForm: longFormPlan(data.project.projectType, r.model.maxOutputTokens || 32_000),
  });
  const refused = over(r.model, p.usd, `Writing "${episode.title}"`);
  if (refused || p.tooLong) return { ok: false, reason: refused ?? "The script is too long for the model." };
  return { ok: true, model: r.writer.value, label: r.writer.label, paid: r.model.paid, usd: p.usd };
}

/** The Episodes "write it" would write: the first unwritten one, or every unwritten one (a film has one). */
export function episodesToWrite(data: ProjectData, scope: "one" | "all"): Episode[] {
  const empty = [...data.episodes].sort((a, b) => a.number - b.number).filter((e) => !e.scriptText.trim());
  return scope === "one" || data.project.projectType !== "series" ? empty.slice(0, 1) : empty;
}

export type WritingQuote =
  | (Quote & { episodes: Array<{ id: string; number: number; title: string; usd: number }> })
  | { ok: false; reason: string };

/** The total for writing those Episodes (each its own request, each within the per-request limit). */
export function quoteWriting(data: ProjectData, scope: "one" | "all", writer?: string | null): WritingQuote {
  const targets = episodesToWrite(data, scope);
  if (targets.length === 0) return { ok: false, reason: "Every Episode already has a script." };
  const priced: Array<{ id: string; number: number; title: string; usd: number }> = [];
  let first: Quote | null = null;
  for (const e of targets) {
    const q = quoteWhole(data, e, writer);
    if (!q.ok) return q;
    first ??= q;
    priced.push({ id: e.id, number: e.number, title: e.title, usd: q.usd });
  }
  const total = Math.round(priced.reduce((s, e) => s + e.usd, 0) * 10000) / 10000;
  return { ...first!, usd: total, episodes: priced };
}

/** Turning an Episode's script into a Production Proposal (Import Story). */
export function quoteAnalyzeEpisode(episode: Episode, writer?: string | null): QuoteResult {
  const r = resolveWriter(writer);
  if (!r) return { ok: false, reason: WRITING_AI_OFF };
  const text = normalizeSourceText(episode.scriptText);
  if (!text) return { ok: false, reason: "Episode 1 has no script yet." };
  const inputTokens = estimateInputTokens(text);
  if (inputTokens + r.model.maxOutputTokens > r.model.contextTokens)
    return { ok: false, reason: "The script is too long to analyse in one go." };
  const usd = estimateUsd(r.model, inputTokens);
  const refused = over(r.model, usd, "Analysing the script");
  if (refused) return { ok: false, reason: refused };
  return { ok: true, model: r.writer.value, label: r.writer.label, paid: r.model.paid, usd };
}

/**
 * Drafting the Bible (from the premise and the plan) or refining it (the current Bible and a note, priced for the
 * longest note in the densest script, a ceiling for whatever is typed): one brainstorm on Episode 1, an idea per field.
 */
export function quoteBible(
  data: ProjectData,
  writer?: string | null,
  opts: { refine?: boolean } = {},
): QuoteResult {
  const r = resolveWriter(writer);
  if (!r) return { ok: false, reason: WRITING_AI_OFF };
  const episode = [...data.episodes].sort((a, b) => a.number - b.number)[0];
  if (!episode)
    return { ok: false, reason: "Add an Episode first: Prism's Bible requests are kept with Episode 1." };
  const text = canonical(episode.scriptText);
  const p = priceWriting({
    data,
    episode,
    text,
    scope: scopeOf(text, "episode", { start: 0, end: text.length }, null),
    mode: "brainstorm",
    instruction: opts.refine
      ? bibleRefineInstruction(data, "あ".repeat(REFINE_NOTE_MAX))
      : bibleDraftInstruction(data),
    count: BIBLE_AI_FIELDS.length,
    targetText: text,
    draftText: null,
    conversation: [],
    model: r.model,
    withPlan: true,
    withBible: opts.refine,
    // refining sends the Bible (or Prism's draft) as it is when the creator presses it: priced for the longest one
    bibleText: opts.refine ? BIBLE_CEILING() : null,
  });
  const refused = over(r.model, p.usd, opts.refine ? "Refining the Bible" : "Drafting the Bible");
  if (refused || p.tooLong) return { ok: false, reason: refused ?? "The Bible is too long for the model." };
  return { ok: true, model: r.writer.value, label: r.writer.label, paid: r.model.paid, usd: p.usd };
}
