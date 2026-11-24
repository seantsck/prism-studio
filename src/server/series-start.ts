import "server-only";
import { BIBLE_AI_FIELDS, bibleDraftInstruction, bibleRefineInstruction } from "@/domain/bible-ai";
import { characterAiFields, characterFillInstruction, partSizeOf } from "@/domain/character-ai";
import { LOCATION_AI_FIELDS, locationFillInstruction, type LocationAiKey } from "@/domain/location-ai";
import type { Episode, PartSize, ProjectData } from "@/domain/schemas";
import {
  emptyEpisodeOne,
  freshProjectData,
  newProjectRecords,
  REFINE_NOTE_MAX,
  seasonPlanInstruction,
  seasonRefineInstruction,
  redraftInstruction,
  REDRAFT_NOTE_MAX,
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
    longForm: longFormPlan(
      data.project.projectType,
      r.model.maxOutputTokens || 32_000,
      episode.targetMinutes,
    ),
  });
  const refused = over(r.model, p.usd, `Writing "${episode.title}"`);
  if (refused || p.tooLong) return { ok: false, reason: refused ?? "The script is too long for the model." };
  return { ok: true, model: r.writer.value, label: r.writer.label, paid: r.model.paid, usd: p.usd };
}

/**
 * Redrafting an Episode that has a screenplay: the whole Episode written anew in parts at its length, with the current
 * screenplay sent as the story to keep (priced for the longest note the creator can add).
 */
export function quoteRedraft(data: ProjectData, episode: Episode, writer?: string | null): QuoteResult {
  const r = resolveWriter(writer);
  if (!r) return { ok: false, reason: WRITING_AI_OFF };
  const text = canonical(episode.scriptText);
  if (!text.trim()) return { ok: false, reason: "This Episode has no screenplay to redraft yet." };
  const p = priceWriting({
    data,
    episode,
    text,
    scope: scopeOf(text, "episode", { start: 0, end: text.length }, null),
    mode: "rewrite",
    instruction: redraftInstruction(data, episode, "あ".repeat(REDRAFT_NOTE_MAX)),
    count: 1,
    targetText: text,
    draftText: null,
    conversation: [],
    model: r.model,
    longForm: longFormPlan(
      data.project.projectType,
      r.model.maxOutputTokens || 32_000,
      episode.targetMinutes,
    ),
    redraft: true,
  });
  const refused = over(r.model, p.usd, `Redrafting "${episode.title}"`);
  if (refused || p.tooLong) return { ok: false, reason: refused ?? "The script is too long for the model." };
  return { ok: true, model: r.writer.value, label: r.writer.label, paid: r.model.paid, usd: p.usd };
}

/** Which Episodes to write: the first unwritten one, every unwritten one, or the unwritten ones picked (by id). */
export type WriteScope = "one" | "all" | readonly string[];

/** The Episodes "write it" would write, in order (a film has one; a written Episode is never picked). */
export function episodesToWrite(data: ProjectData, scope: WriteScope): Episode[] {
  const empty = [...data.episodes].sort((a, b) => a.number - b.number).filter((e) => !e.scriptText.trim());
  if (data.project.projectType !== "series") return empty.slice(0, 1);
  if (scope === "one") return empty.slice(0, 1);
  if (scope === "all") return empty;
  const picked = new Set(scope);
  return empty.filter((e) => picked.has(e.id));
}

export type WritingQuote =
  | (Quote & {
      episodes: Array<{ id: string; number: number; title: string; usd: number; minutes: number | null }>;
    })
  | { ok: false; reason: string };

/** The total for writing those Episodes (each its own request, each within the per-request limit). */
export function quoteWriting(data: ProjectData, scope: WriteScope, writer?: string | null): WritingQuote {
  const targets = episodesToWrite(data, scope);
  if (targets.length === 0)
    return {
      ok: false,
      reason:
        typeof scope === "string" ? "Every Episode already has a script." : "Pick at least one episode.",
    };
  const priced: Array<{ id: string; number: number; title: string; usd: number; minutes: number | null }> =
    [];
  let first: Quote | null = null;
  for (const e of targets) {
    const q = quoteWhole(data, e, writer);
    if (!q.ok) return q;
    first ??= q;
    priced.push({ id: e.id, number: e.number, title: e.title, usd: q.usd, minutes: e.targetMinutes ?? null });
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

/**
 * Filling in a Character's sheet with Prism (or revising Prism's draft with a note): one brainstorm, an idea per field,
 * priced for the longest sheet and note that can be sent (a ceiling for whatever is written or typed), kept
 * with Episode 1 like the Bible's. A project with no Episode (the account's library) gets an empty Episode 1 when the
 * request is made; it is priced here as that empty Episode.
 */
export function quoteCharacterFill(
  data: ProjectData,
  characterId: string,
  writer?: string | null,
  opts: { refine?: boolean; size?: PartSize } = {},
): QuoteResult {
  const r = resolveWriter(writer);
  if (!r) return { ok: false, reason: WRITING_AI_OFF };
  const character = data.characters.find((c) => c.id === characterId);
  if (!character) return { ok: false, reason: "That character is not in this project." };
  const episode =
    [...data.episodes].sort((a, b) => a.number - b.number)[0] ??
    emptyEpisodeOne(data.project.id, new Date().toISOString());
  const text = canonical(episode.scriptText);
  const inStory = data.project.purpose !== "library";
  const p = priceWriting({
    data,
    episode,
    text,
    scope: scopeOf(text, "episode", { start: 0, end: text.length }, null),
    mode: "brainstorm",
    // the longest sheet and note that can be sent: a ceiling for whatever is written or typed
    instruction: characterFillInstruction(
      data,
      { ...character, ...CHARACTER_SHEET_CEILING },
      { note: "あ".repeat(REFINE_NOTE_MAX), revise: opts.refine, size: opts.size ?? partSizeOf(character) },
    ),
    count: characterAiFields(inStory, opts.size ?? partSizeOf(character)).length,
    targetText: text,
    draftText: null,
    conversation: [],
    model: r.model,
    withPlan: false,
    withBible: inStory,
    bibleText: null,
  });
  const refused = over(r.model, p.usd, "Filling in the character");
  if (refused || p.tooLong)
    return { ok: false, reason: refused ?? "The episode script is too long to send." };
  return { ok: true, model: r.writer.value, label: r.writer.label, paid: r.model.paid, usd: p.usd };
}

const CHARACTER_SHEET_CEILING = {
  description: "あ".repeat(1200),
  role: "あ".repeat(120),
  personality: "あ".repeat(1200),
  behaviorNotes: "あ".repeat(1200),
  physicalDescription: "あ".repeat(1200),
  signatureBehavior: "あ".repeat(1200),
  relationshipNotes: "あ".repeat(1200),
  continuityRules: ["あ".repeat(1200)],
};

/** Filling in a Location's sheet with Prism (or revising Prism's draft): priced like a Character's. */
export function quoteLocationFill(
  data: ProjectData,
  locationId: string,
  writer?: string | null,
  opts: { refine?: boolean } = {},
): QuoteResult {
  const r = resolveWriter(writer);
  if (!r) return { ok: false, reason: WRITING_AI_OFF };
  const location = data.locations.find((l) => l.id === locationId);
  if (!location) return { ok: false, reason: "That location is not in this project." };
  const episode =
    [...data.episodes].sort((a, b) => a.number - b.number)[0] ??
    emptyEpisodeOne(data.project.id, new Date().toISOString());
  const text = canonical(episode.scriptText);
  const ceiling = Object.fromEntries(LOCATION_AI_FIELDS.map((f) => [f.key, "あ".repeat(1200)])) as Record<
    LocationAiKey,
    string
  >;
  const p = priceWriting({
    data,
    episode,
    text,
    scope: scopeOf(text, "episode", { start: 0, end: text.length }, null),
    mode: "brainstorm",
    instruction: locationFillInstruction(data, location, ceiling, {
      note: "あ".repeat(REFINE_NOTE_MAX),
      revise: opts.refine,
    }),
    count: LOCATION_AI_FIELDS.length,
    targetText: text,
    draftText: null,
    conversation: [],
    model: r.model,
    withPlan: false,
    withBible: data.project.purpose !== "library",
    bibleText: null,
  });
  const refused = over(r.model, p.usd, "Filling in the location");
  if (refused || p.tooLong)
    return { ok: false, reason: refused ?? "The episode script is too long to send." };
  return { ok: true, model: r.writer.value, label: r.writer.label, paid: r.model.paid, usd: p.usd };
}

/**
 * The price of "Have Prism fill in the details" on the home page's create boxes, before the Character or Location
 * exists: priced as the longest one that box can make, in the account's library (no story, no Episode yet), so it is
 * never below the request that is then sent.
 */
export function quoteNewFill(kind: "character" | "location", writer?: string | null): QuoteResult {
  const now = new Date().toISOString();
  const records = newProjectRecords({
    id: crypto.randomUUID(),
    userId: "price-only",
    title: "Your library",
    slug: "your-library",
    projectType: "film",
    description: "",
    now,
  });
  const base = freshProjectData(records);
  const data: ProjectData = { ...base, project: { ...base.project, purpose: "library" }, episodes: [] };
  const id = crypto.randomUUID();
  const long = "あ".repeat(1200);
  if (kind === "character") {
    data.characters = [
      {
        id,
        projectId: data.project.id,
        name: "あ".repeat(80),
        role: "",
        description: long,
        personality: "",
        behaviorNotes: "",
        physicalDescription: long,
        continuityRules: [],
        signatureBehavior: "",
        relationshipNotes: "",
        createdAt: now,
        updatedAt: now,
      },
    ];
    return quoteCharacterFill(data, id, writer);
  }
  data.locations = [
    {
      id,
      projectId: data.project.id,
      name: "あ".repeat(80),
      description: long,
      geography: "",
      zones: [],
      entrances: [],
      lighting: "",
      recurringProps: [],
      referenceAssetIds: [],
      locked: false,
      set3d: null,
    },
  ];
  return quoteLocationFill(data, id, writer);
}
