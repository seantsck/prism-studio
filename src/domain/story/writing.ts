import { z } from "zod";
import { parseScreenplay } from "@/domain/script";

/**
 * Phase 5B-S2: the AI writing assistant's domain. Pure.
 *
 * Prism PROPOSES writing; the creator decides what becomes canon. Every AI turn is a Story Revision Proposal (or a
 * brainstorm) over a TARGET RANGE of the canonical screenplay, written against a known base fingerprint. Nothing here
 * writes a screenplay: `applyAlternative` only computes the text an Accept would produce.
 */
export const WRITING_SCHEMA_VERSION = "prism.writing-proposal.v1" as const;

export const WRITING_MODES = [
  "custom",
  "rewrite",
  "continue",
  "dialogue",
  "tone",
  "condense",
  "expand",
  "brainstorm",
] as const;
export type WritingMode = (typeof WRITING_MODES)[number];

export const MODE_LABEL: Record<WritingMode, string> = {
  custom: "Ask Prism",
  rewrite: "Rewrite",
  continue: "Continue",
  dialogue: "Dialogue pass",
  tone: "Tone pass",
  condense: "Shorten",
  expand: "Expand",
  brainstorm: "Brainstorm",
};

/** What each mode asks of the writer (Prism's own words, sent with the request; never project text). */
export const MODE_TASK: Record<WritingMode, string> = {
  custom: "Revise the TARGET passage as the creator asks.",
  rewrite: "Rewrite the TARGET passage according to the creator's instruction.",
  continue:
    "Write what comes NEXT after the TARGET passage (a continuation from its end). Return only the new text, not the passage itself.",
  dialogue:
    "Dialogue pass: improve the dialogue in the TARGET passage. Keep every story event, who is present and what happens; change how it is said.",
  tone: "Tone pass: change the tone of the TARGET passage as instructed. Keep the story events.",
  condense:
    "Shorten the TARGET passage. Keep the core story information, events and turning points; cut repetition and excess.",
  expand:
    "Expand the TARGET passage: more texture, behaviour and beats, the same story events. Do not add new characters.",
  brainstorm:
    "Brainstorm: answer with IDEAS only (titles and short explanations). Do not write a replacement for the screenplay.",
};

/** The presets in the workspace: a mode plus the instruction used when the creator types none. */
export const WRITING_PRESETS = {
  ask: { label: "Ask Prism", mode: "custom", instruction: null },
  rewrite: {
    label: "Rewrite",
    mode: "rewrite",
    instruction: "Rewrite this so it reads better, without changing what happens.",
  },
  continue: { label: "Continue", mode: "continue", instruction: "Continue from here for about a page." },
  shorten: { label: "Shorten", mode: "condense", instruction: "Shorten this without changing the plot." },
  expand: { label: "Expand", mode: "expand", instruction: "Expand this with more texture and behaviour." },
  dialogue: {
    label: "Improve Dialogue",
    mode: "dialogue",
    instruction: "Make the dialogue more natural and specific to each character.",
  },
  tone: { label: "Change Tone", mode: "tone", instruction: null },
  tension: { label: "Increase Tension", mode: "tone", instruction: "Increase the tension." },
  funnier: { label: "Make Funnier", mode: "tone", instruction: "Make it funnier." },
  brainstorm: {
    label: "Brainstorm",
    mode: "brainstorm",
    instruction: "Give me five ideas to strengthen this scene.",
  },
} as const satisfies Record<string, { label: string; mode: WritingMode; instruction: string | null }>;
export type WritingPreset = keyof typeof WRITING_PRESETS;

export const SCOPE_KINDS = ["selection", "scene", "episode"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/**
 * The target, as character offsets into the canonical (LF-normalized) screenplay. `start === end` is an insertion
 * point (Continue). `sceneId` names the Scene the range lies in, when it lies in one.
 */
export interface WritingScope {
  kind: ScopeKind;
  sceneId: string | null;
  start: number;
  end: number;
  /** 1-based line range of the target in the base text (for display and provenance). */
  startLine: number;
  endLine: number;
}

/** The most alternatives (or ideas) the database records as requested; a larger plan carries its count in its context. */
export const MAX_RECORDED_COUNT = 10;

export const LIMITS = {
  instruction: 4000,
  alternatives: 5,
  /** A season plan has one idea per Episode (up to 500, planned PLAN_BATCH at a time). */
  ideas: 500,
  /** One alternative's text (a whole episode or film written in parts fits; the database allows 400 000). */
  text: 400_000,
  message: 2000,
  explanation: 1200,
  label: 40,
  facts: 8,
  fact: 300,
  ideaTitle: 200,
  ideaDetail: 1500,
  /** Episode scope only up to this many characters (a scene-sized request is enough for everything else). */
  episodeChars: 120_000,
} as const;

/** Canonical text: LF line endings only (the browser shows and selects LF text). Nothing else changes. */
export const canonical = (scriptText: string) => scriptText.replace(/\r\n?/g, "\n");

// ───────────────────────── creator request parsing ─────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
};

/** "Give me three versions" → 3; "five ways" → 5 (brainstorm). null when the instruction names no count. */
export function requestedCount(instruction: string, noun: "alternatives" | "ideas"): number | null {
  const words =
    noun === "alternatives"
      ? "versions?|alternatives?|options?|takes?|variations?"
      : "ways|ideas|options|suggestions";
  const m = instruction
    .toLowerCase()
    .match(new RegExp(`\\b(\\d+|${Object.keys(NUMBER_WORDS).join("|")})\\s+(?:\\w+\\s+){0,2}(${words})\\b`));
  if (!m) return null;
  const n = /\d/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!]!;
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/** An instruction that asks for ideas rather than text ("Give me five ways to…", "Brainstorm…"). */
export function looksLikeBrainstorm(instruction: string): boolean {
  const s = instruction.toLowerCase();
  if (/\b(versions?|alternatives?|rewrite|rewrites)\b/.test(s)) return false;
  return /^\s*(brainstorm|what are|what could|list|suggest|give me (\w+ )?(\w+ )?(ways|ideas|options|suggestions))/.test(
    s,
  );
}

// ───────────────────────── ranges ─────────────────────────

export function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Character offsets of 1-based lines [startLine, endLine] (end exclusive of the final newline). */
export function lineRangeOffsets(
  text: string,
  startLine: number,
  endLine: number,
): { start: number; end: number } {
  const lines = text.split("\n");
  const a = Math.max(1, Math.min(startLine, lines.length));
  const b = Math.max(a, Math.min(endLine, lines.length));
  let start = 0;
  for (let i = 0; i < a - 1; i++) start += lines[i]!.length + 1;
  let end = start;
  for (let i = a - 1; i < b; i++) end += lines[i]!.length + (i < b - 1 ? 1 : 0);
  return { start, end };
}

/** The scene a canonical text's Scenes occupy, by order (parsed), trimmed of trailing blank lines. */
export function parsedSceneRanges(text: string) {
  const lines = text.split("\n");
  return parseScreenplay(text).map((s) => {
    let end = s.endLine;
    while (end > s.startLine && !lines[end - 1]?.trim()) end--;
    return {
      slugline: s.slugline,
      startLine: s.startLine,
      endLine: end,
      ...lineRangeOffsets(text, s.startLine, end),
    };
  });
}

export function scopeOf(
  text: string,
  kind: ScopeKind,
  range: { start: number; end: number },
  sceneId: string | null,
): WritingScope {
  const start = Math.max(0, Math.min(range.start, text.length));
  const end = Math.max(start, Math.min(range.end, text.length));
  return {
    kind,
    sceneId,
    start,
    end,
    startLine: lineOfOffset(text, start),
    endLine: lineOfOffset(text, Math.max(start, end - 1)),
  };
}

// ───────────────────────── the answer ─────────────────────────

const str = (max: number) => z.string().max(max);
export const writingAlternativeSchema = z
  .object({
    label: str(LIMITS.label),
    text: str(LIMITS.text),
    explanation: str(LIMITS.explanation),
    /** Facts this writing implies about a Character. Kept IN the revision; never written to the Character record. */
    newCharacterFacts: z.array(str(LIMITS.fact)).max(LIMITS.facts),
  })
  .strict();
export const writingIdeaSchema = z
  .object({ title: str(LIMITS.ideaTitle), detail: str(LIMITS.ideaDetail) })
  .strict();
export const writingResultSchema = z
  .object({
    message: str(LIMITS.message),
    alternatives: z.array(writingAlternativeSchema).max(LIMITS.alternatives),
    ideas: z.array(writingIdeaSchema).max(LIMITS.ideas),
  })
  .strict();
export type WritingResult = z.infer<typeof writingResultSchema>;
export type WritingAlternative = z.infer<typeof writingAlternativeSchema>;

const O = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const S = { type: "string" };
/** Strict JSON Schema for Structured Outputs (kept in lockstep with `writingResultSchema`; a test walks both). */
export const WRITING_JSON_SCHEMA = O({
  message: S,
  alternatives: {
    type: "array",
    maxItems: LIMITS.alternatives,
    items: O({
      label: S,
      text: S,
      explanation: S,
      newCharacterFacts: { type: "array", items: S, maxItems: LIMITS.facts },
    }),
  },
  ideas: { type: "array", maxItems: LIMITS.ideas, items: O({ title: S, detail: S }) },
});

export interface WritingExpectation {
  mode: WritingMode;
  scopeKind: ScopeKind;
  /** Alternatives (revision modes) or ideas (brainstorm) requested. */
  count: number;
  targetText: string;
}

const headings = (t: string) => parseScreenplay(t).map((s) => s.slugline.trim().toUpperCase());
const hasHeadingLine = (t: string) =>
  t.split("\n").some((l) => /^(INT\/EXT|INT|EXT|I\/E)[.\s]/i.test(l.trim()));

/**
 * The ONE gate every provider answer passes before it is stored: JSON → strict schema → the shape the mode requires
 * (exactly N alternatives, or N ideas and no text) → screenplay structure (a rewrite keeps the target's scene headings
 * exactly; a continuation adds headings only at Episode scope). Errors are short and contain no script text.
 */
export function validateWriting(
  raw: unknown,
  expect: WritingExpectation,
): { ok: true; result: WritingResult } | { ok: false; errors: string[] } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ["The answer is not valid JSON."] };
    }
  }
  const parsed = writingResultSchema.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "answer"}: ${i.message}`),
    };
  const r = parsed.data;
  const errors: string[] = [];
  if (!r.message.trim()) errors.push("message must not be empty.");
  if (expect.mode === "brainstorm") {
    if (r.alternatives.length) errors.push("A brainstorm returns ideas only: alternatives must be empty.");
    if (r.ideas.length !== expect.count) errors.push(`Return exactly ${expect.count} ideas.`);
    r.ideas.forEach((d, i) => {
      if (!d.title.trim()) errors.push(`ideas.${i}.title must not be empty.`);
    });
  } else {
    if (r.ideas.length) errors.push("ideas must be empty for a revision.");
    if (r.alternatives.length !== expect.count) errors.push(`Return exactly ${expect.count} alternatives.`);
    const before = headings(expect.targetText);
    r.alternatives.forEach((a, i) => {
      if (!a.text.trim()) errors.push(`alternatives.${i}.text must not be empty.`);
      if (expect.mode === "continue") {
        if (expect.scopeKind !== "episode" && hasHeadingLine(a.text))
          errors.push(`alternatives.${i}: a continuation inside a Scene must not start a new scene heading.`);
      } else if (JSON.stringify(headings(a.text)) !== JSON.stringify(before)) {
        errors.push(
          `alternatives.${i}: keep the target's scene headings exactly (${before.length} heading${before.length === 1 ? "" : "s"}); do not add, remove or rename scenes.`,
        );
      }
    });
    const texts = new Set(r.alternatives.map((a) => a.text.trim()));
    if (texts.size !== r.alternatives.length)
      errors.push("The alternatives must be different from each other.");
  }
  return errors.length ? { ok: false, errors } : { ok: true, result: r };
}

/**
 * The full screenplay an Accept would produce: the target range replaced by the chosen alternative (a continuation is
 * inserted after the range, as its own paragraph(s)). Text outside the range is never changed.
 */
export function applyAlternative(
  base: string,
  scope: Pick<WritingScope, "start" | "end">,
  mode: WritingMode,
  text: string,
): { text: string; changedStart: number; changedEnd: number } {
  if (mode === "continue") {
    const before = base.slice(0, scope.end).replace(/\s+$/, "");
    const after = base.slice(scope.end).replace(/^\s+/, "");
    const insert = text.trim();
    const head = before ? `${before}\n\n` : "";
    const out = `${head}${insert}${after ? `\n\n${after}` : base.endsWith("\n") ? "\n" : ""}`;
    return { text: out, changedStart: head.length, changedEnd: head.length + insert.length };
  }
  const out = base.slice(0, scope.start) + text + base.slice(scope.end);
  return { text: out, changedStart: scope.start, changedEnd: scope.start + text.length };
}

/** Output budget (tokens) for a request: generous enough for N alternatives of the target, never the model maximum. */
export function writingOutputTokens(
  mode: WritingMode,
  count: number,
  targetChars: number,
  modelMax: number,
): number {
  const per =
    mode === "brainstorm"
      ? 400
      : mode === "continue" || mode === "expand"
        ? 2500
        : Math.ceil(targetChars / 1.5) + 600;
  return Math.min(modelMax, 1500 + count * Math.min(per, 12_000));
}

/**
 * Conservative input-token ceiling: ~1 token per 3.5 ASCII characters and ~1.5 per non-ASCII character (Japanese
 * dialogue is dense), plus the fixed instructions. A ceiling for the spend gate, never a quote.
 */
export function estimateWritingInputTokens(...parts: string[]): number {
  let ascii = 0;
  let other = 0;
  for (const p of parts)
    for (const ch of p) {
      if (ch.charCodeAt(0) < 128) ascii++;
      else other++;
    }
  return Math.ceil(ascii / 3.5 + other * 1.5) + 1500;
}

/** Content blocks are delimited with <<< >>>; content can never close a block early. */
export const escapeBlock = (s: string) => s.replace(/<<</g, "‹‹‹").replace(/>>>/g, "›››");

// ───────────────────────── a whole episode or film, written in parts ─────────────────────────

/**
 * A whole Episode (or a whole film) is longer than one answer, so the worker writes it in PARTS: each part continues
 * from the end of the last, and the creator reviews the whole result as one proposal. The plan is frozen on the
 * proposal (its context) and priced up front as a ceiling for every part.
 */
export interface LongFormPlan {
  kind: "episode" | "film" | "short";
  parts: number;
  /** Output budget of each part (never above the model's maximum). */
  partTokens: number;
  /** The creator's target length in minutes, when set: the parts are sized to it. */
  minutes?: number;
  /**
   * With a target length: parts the worker may add before the ending when what is written runs short of it (priced
   * in the ceiling, used only when needed). Absent = none.
   */
  extraParts?: number;
}

/** About how many minutes of screen time a part with a target length is asked for. */
export const MINUTES_PER_PART = 5;
/** The most parts added to reach a target length. */
export const MAX_EXTRA_PARTS = 2;

/** How much of the text written so far each later part is shown (its tail), in characters. */
export const LONG_FORM_TAIL_CHARS = 24_000;

/**
 * Output tokens a minute of screenplay may take: about a page a minute, in the densest script (Japanese dialogue),
 * with room for the model's own thinking. A ceiling, never a quote.
 */
export const TOKENS_PER_MINUTE = 600;
/** The most parts one whole Episode or film is written in (a 600-minute ceiling stays within the lease). */
export const MAX_LONG_FORM_PARTS = 12;

/**
 * How a whole Episode or film is written: in parts, each continuing from the last. With a target length (minutes) the
 * number of parts is sized to it; without one, the defaults (a series episode 2 × 8 000 tokens, a short 2 × 6 000, a
 * film 4 × 10 000).
 */
export function longFormPlan(
  projectType: string,
  modelMaxOutputTokens: number,
  minutes?: number | null,
): LongFormPlan {
  const cap = (n: number) => Math.min(n, modelMaxOutputTokens || n);
  const kind: LongFormPlan["kind"] =
    projectType === "film" ? "film" : projectType === "short" ? "short" : "episode";
  const partTokens = cap(kind === "film" ? 10_000 : kind === "short" ? 6_000 : 8_000);
  if (minutes && minutes > 0) {
    const need = minutes * TOKENS_PER_MINUTE;
    // about MINUTES_PER_PART minutes a part (a model writes a short stretch fully; asked for a long one it summarises),
    // and never fewer parts than the output budget needs; at most MAX_LONG_FORM_PARTS
    const parts = Math.min(
      MAX_LONG_FORM_PARTS,
      Math.max(1, Math.ceil(minutes / MINUTES_PER_PART), Math.ceil(need / partTokens)),
    );
    // each part's budget: twice its share (room for a model's thinking), at least half the default, within the model
    const size = Math.min(
      modelMaxOutputTokens || Infinity,
      Math.max(Math.ceil(partTokens / 2), Math.ceil((2 * need) / parts)),
    );
    const extraParts = Math.min(MAX_EXTRA_PARTS, MAX_LONG_FORM_PARTS - parts);
    return { kind, parts, partTokens: size, minutes, ...(extraParts > 0 ? { extraParts } : {}) };
  }
  return { kind, parts: kind === "film" ? 4 : 2, partTokens };
}

/**
 * The ceiling for a request written in parts: every part sends the same frozen request plus (after the first) at most
 * the tail of what was written so far, priced as the densest script (1.5 tokens a character); every part may use its
 * whole output budget.
 */
export function longFormTokens(baseInputTokens: number, plan: LongFormPlan) {
  const tail = Math.ceil(LONG_FORM_TAIL_CHARS * 1.5);
  // the parts that may be added to reach the length are priced too (the ceiling the creator confirms)
  const parts = plan.parts + (plan.extraParts ?? 0);
  return {
    inputTokens: parts * baseInputTokens + (parts - 1) * tail,
    maxOutputTokens: parts * plan.partTokens,
  };
}

/**
 * About how long a screenplay runs on screen, in minutes: the standard page a minute, a page being about 170 English
 * words or about 400 Japanese/Chinese characters of dialogue (spoken more densely), plus a little for each scene
 * heading. An estimate, shown as "about".
 */
export function estimateScreenMinutes(text: string): number {
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/g) ?? []).length;
  const words = (
    text.replace(/[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/g, " ").match(/[A-Za-z0-9'’-]+/g) ?? []
  ).length;
  const scenes = (text.match(/^\s*(INT\.|EXT\.|INT\/EXT\.|I\/E\.)/gim) ?? []).length;
  return Math.round((words / 170 + cjk / 400 + scenes * 0.1) * 10) / 10;
}

/**
 * A season plan longer than this many Episodes is planned in batches of this size: one answer stays well inside the
 * model's output budget (a reasoning model spends part of it thinking), and each batch sees the ideas before it.
 */
export const PLAN_BATCH = 40;

/** The batches of a plan of `total` ideas: [start, end) per batch. */
export function planBatches(total: number, size = PLAN_BATCH): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let s = 0; s < total; s += size) out.push([s, Math.min(total, s + size)]);
  return out;
}

/**
 * A later batch is shown the last PLANNED_FULL ideas in full and the earlier ones by title (cut to
 * PLANNED_TITLE_CHARS), so a 500-episode plan still fits the model. The ceilings a priced batch allows per idea, in
 * tokens: a full idea is bounded by what one batch can write (its output budget per idea), a title by its length in
 * the densest script.
 */
export const PLANNED_FULL = 60;
export const PLANNED_TITLE_CHARS = 80;
export const PLANNED_IDEA_TOKENS = 450;
export const PLANNED_TITLE_TOKENS = Math.ceil(PLANNED_TITLE_CHARS * 1.5) + 10;

/** The input-token ceiling for showing `before` earlier ideas to a batch. */
export const plannedSoFarTokens = (before: number) =>
  Math.min(before, PLANNED_FULL) * PLANNED_IDEA_TOKENS +
  Math.max(0, before - PLANNED_FULL) * PLANNED_TITLE_TOKENS;

/** What a later batch is shown of the ideas planned before it. */
export function plannedSoFar(
  ideas: ReadonlyArray<{ title: string; detail: string }>,
): Array<{ episode: number; title: string; detail: string }> {
  const full = Math.max(0, ideas.length - PLANNED_FULL);
  return ideas.map((d, i) => ({
    episode: i + 1,
    title: i < full ? d.title.slice(0, PLANNED_TITLE_CHARS) : d.title,
    detail: i < full ? "" : d.detail,
  }));
}

/**
 * How much of each Episode's synopsis a request is sent with the season plan: all 400 characters for a season of up
 * to 60, less for longer ones (every title still goes), so the whole plan stays a bounded part of the request.
 */
export const planSynopsisChars = (episodes: number) =>
  episodes <= 60 ? 400 : Math.max(60, Math.floor(24_000 / episodes));

/** What one batch of a long plan is asked, on top of the creator's instruction. */
export function planBatchInstruction(instruction: string, start: number, end: number, total: number): string {
  return [
    `This call plans only episodes ${start + 1} to ${end} of ${total}: give exactly ${end - start} ideas, one per episode, in order, starting with episode ${start + 1}.`,
    start === 0
      ? "Plan them as the opening of the whole season, setting up the arc the later episodes will continue."
      : "The episodes already planned are in the context (plannedSoFar): continue the same story from where they end, without repeating them.",
    end === total
      ? "These are the last episodes: bring the season to its ending."
      : "Do not end the season yet.",
    "Ignore any other number of ideas in the instruction below; it describes the whole season.",
    "",
    instruction,
  ]
    .join("\n")
    .slice(0, LIMITS.instruction);
}

/** What each part is asked, on top of the creator's instruction. */
export function longFormPartInstruction(
  instruction: string,
  plan: LongFormPlan,
  part: number,
  /**
   * With a target length, what the worker knows as it goes: how many parts in all now (extra parts included), whether
   * this one ends it, about how long the text written so far runs, and how many minutes this part should add.
   */
  progress?: { total: number; last: boolean; writtenMinutes: number; askMinutes: number },
): string {
  const whole = plan.kind === "film" ? "film" : plan.kind === "short" ? "short film" : "episode";
  const total = progress?.total ?? plan.parts;
  const last = progress?.last ?? part === plan.parts - 1;
  const ask =
    progress?.askMinutes ?? (plan.minutes ? Math.max(1, Math.round(plan.minutes / plan.parts)) : null);
  const share = ask
    ? `at least ${ask} full screenplay pages, about ${ask} minutes on screen (a page a minute)`
    : `about ${Math.round(100 / plan.parts)}% of it`;
  const lines = [
    `This is part ${part + 1} of ${total} of the whole ${whole}. Write ${share} and stop at the end of a scene.`,
    ...(plan.minutes
      ? [
          `The whole ${whole} must run about ${plan.minutes} minutes${progress ? `; what is written so far runs about ${progress.writtenMinutes}` : ""}. Reach the length by dramatising every scene in full: action, behaviour and real back-and-forth dialogue. Never summarise, skip ahead or compress a scene into a line.`,
        ]
      : []),
    part === 0
      ? "Start at the very beginning."
      : "The TARGET is the end of what is written so far: continue exactly where it ends. Do not repeat or rewrite any of it.",
    last ? `This is the last part: bring the ${whole} to its ending.` : `Do not end the ${whole} yet.`,
    "",
    instruction,
  ];
  return lines.join("\n").slice(0, LIMITS.instruction);
}
