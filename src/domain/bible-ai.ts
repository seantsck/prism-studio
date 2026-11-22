import type { ProjectBible, ProjectData } from "./schemas";
import { PREMISE_MAX, REFINE_NOTE_MAX } from "./series-start";
import { LIMITS } from "./story/writing";

/**
 * The Bible, drafted and refined with Prism. A draft is an ordinary writing request (a brainstorm) whose ideas are the
 * Bible's fields: each idea's title names a field, its detail is that field's content (a list field: one item per
 * line). It is reviewed field by field beside the current Bible and applied only where the creator ticks it; the Bible
 * stays editable by hand. The technical fields (aspect ratio, frame rate, delivery) and the house guardrails are never
 * proposed.
 */

export interface BibleAiField {
  key: BibleAiKey;
  label: string;
  /** One item per line (the Bible stores a list). */
  list: boolean;
  /** What Prism is asked to put there. */
  ask: string;
}

export type BibleAiKey =
  | "premise"
  | "genre"
  | "tone"
  | "visualStyle"
  | "colorLanguage"
  | "cinematographyRules"
  | "dialogueLanguageStrategy"
  | "subtitleStrategy"
  | "audioPhilosophy"
  | "canonFacts"
  | "continuityRules";

export const BIBLE_AI_FIELDS: readonly BibleAiField[] = [
  { key: "premise", label: "Premise", list: false, ask: "the premise in 2 to 4 sentences" },
  { key: "genre", label: "Genre", list: false, ask: "the genre, a few words" },
  { key: "tone", label: "Tone", list: false, ask: "the tone, a few words or one sentence" },
  { key: "visualStyle", label: "Visual style", list: false, ask: "how it looks: light, texture, references" },
  {
    key: "colorLanguage",
    label: "Color language",
    list: false,
    ask: "what the colors mean and when they change",
  },
  {
    key: "cinematographyRules",
    label: "Cinematography rules",
    list: true,
    ask: "3 to 6 rules for camera and framing, one per line",
  },
  {
    key: "dialogueLanguageStrategy",
    label: "Dialogue language strategy",
    list: false,
    ask: "which languages are spoken, by whom, and when",
  },
  { key: "subtitleStrategy", label: "Subtitle strategy", list: false, ask: "how subtitles are handled" },
  { key: "audioPhilosophy", label: "Audio philosophy", list: false, ask: "music, sound and silence" },
  {
    key: "canonFacts",
    label: "Canon facts",
    list: true,
    ask: "4 to 8 facts that must stay true across the series, one per line",
  },
  {
    key: "continuityRules",
    label: "Continuity rules",
    list: true,
    ask: "3 to 6 rules that keep the story consistent, one per line",
  },
];

const fieldList = () => BIBLE_AI_FIELDS.map((f) => `- ${f.key}: ${f.ask}`).join("\n");
const kindOf = (data: ProjectData) =>
  data.project.projectType === "film"
    ? "film"
    : data.project.projectType === "short"
      ? "short film"
      : "series";

/** Draft the Bible from the premise and the plan (sent in the context). */
export function bibleDraftInstruction(data: ProjectData): string {
  return [
    `Draft the project Bible for this ${kindOf(data)}. Give exactly ${BIBLE_AI_FIELDS.length} ideas, one per field, in this order.`,
    "Each idea's title is exactly the field's name (as written below); its detail is that field's content. For a list field, put one item per line.",
    fieldList(),
    "Base it on the premise and on the season plan in the context (seasonPlan), when there is one. Keep it specific to this story.",
    "",
    `Premise: ${data.bible.premise.trim().slice(0, PREMISE_MAX)}`,
  ]
    .join("\n")
    .slice(0, LIMITS.instruction);
}

/** Refine the current Bible (sent in the context) following the creator's note. */
export function bibleRefineInstruction(data: ProjectData, note: string): string {
  return [
    `Revise the project Bible in the context (bible) following the creator's note. Give exactly ${BIBLE_AI_FIELDS.length} ideas, one per field, in this order: the whole revised Bible, not only what changed.`,
    "Each idea's title is exactly the field's name (as written below); its detail is that field's content. For a list field, put one item per line. Keep what the note does not ask to change.",
    fieldList(),
    "",
    `Creator's note: ${note.trim().slice(0, REFINE_NOTE_MAX)}`,
  ]
    .join("\n")
    .slice(0, LIMITS.instruction);
}

/** A writing request that drafts or refines the Bible. */
export const isBibleRequest = (instruction: string) =>
  instruction.startsWith("Draft the project Bible") || instruction.startsWith("Revise the project Bible");

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/** The Bible a draft proposes: each field it names (by its exact name, or the label), as the Bible stores it. */
export function parseBibleIdeas(
  ideas: ReadonlyArray<{ title: string; detail: string }>,
): Partial<Record<BibleAiKey, string | string[]>> {
  const out: Partial<Record<BibleAiKey, string | string[]>> = {};
  for (const idea of ideas) {
    const f = BIBLE_AI_FIELDS.find(
      (x) => norm(x.key) === norm(idea.title) || norm(x.label) === norm(idea.title),
    );
    if (!f || out[f.key] !== undefined) continue;
    out[f.key] = bibleFieldValue(f.key, idea.detail);
  }
  return out;
}

/** A field's text (Prism's, or the creator's edit of it) as the Bible stores it: a list field is one item per line. */
export function bibleFieldValue(key: BibleAiKey, text: string): string | string[] {
  const f = BIBLE_AI_FIELDS.find((x) => x.key === key)!;
  const t = text.trim().slice(0, LIMITS.ideaDetail);
  return f.list
    ? t
        .split("\n")
        .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
        .filter(Boolean)
    : t;
}

/** The current Bible as text, field by field (what a refine is sent, and what the review compares with). */
export function bibleAsText(bible: ProjectBible): Record<BibleAiKey, string> {
  const out = {} as Record<BibleAiKey, string>;
  for (const f of BIBLE_AI_FIELDS) {
    const v = bible[f.key];
    out[f.key] = (Array.isArray(v) ? v.join("\n") : String(v ?? "")).slice(0, LIMITS.ideaDetail);
  }
  return out;
}
