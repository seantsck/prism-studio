import type { Character, ProjectData } from "./schemas";
import { PREMISE_MAX, REFINE_NOTE_MAX } from "./series-start";
import { LIMITS } from "./story/writing";

/**
 * A Character's sheet, filled in with Prism. Like the Bible (src/domain/bible-ai.ts) it is an ordinary writing request
 * (a brainstorm) whose ideas are the sheet's fields: each idea's title names a field, its detail is the content (a list
 * field: one item per line). It is reviewed field by field beside the sheet and applied only where the creator ticks
 * it. In a story the role and relationships are proposed from the story (the Bible and the cast are in the context); a
 * Character made on its own (the library) has neither, because a role belongs to each project's copy.
 */

export type CharacterAiKey =
  | "description"
  | "role"
  | "personality"
  | "behaviorNotes"
  | "physicalDescription"
  | "signatureBehavior"
  | "relationshipNotes"
  | "continuityRules";

export interface CharacterAiField {
  key: CharacterAiKey;
  label: string;
  list: boolean;
  /** Only in a story (not for a Character made on its own). */
  storyOnly: boolean;
  ask: string;
}

export const CHARACTER_AI_FIELDS: readonly CharacterAiField[] = [
  {
    key: "description",
    label: "Description",
    list: false,
    storyOnly: false,
    ask: "who they are, in one or two sentences",
  },
  {
    key: "role",
    label: "Role",
    list: false,
    storyOnly: true,
    ask: 'their role in this story, a few words, like "Lead — heiress" or "Antagonist — fiancé candidate"',
  },
  {
    key: "personality",
    label: "Personality",
    list: false,
    storyOnly: false,
    ask: "their personality: what drives them, what they hide, how they treat people (2 to 4 sentences)",
  },
  {
    key: "behaviorNotes",
    label: "Behavior notes",
    list: false,
    storyOnly: false,
    ask: "how they move, speak and react, for an actor and a director (2 to 4 sentences)",
  },
  {
    key: "physicalDescription",
    label: "Physical description",
    list: false,
    storyOnly: false,
    ask: "a precise visual description used to make their pictures: age, height and build, face, eyes, hair, skin, usual wardrobe and accessories. Only what a camera sees; no story events",
  },
  {
    key: "signatureBehavior",
    label: "Signature behavior",
    list: false,
    storyOnly: false,
    ask: "one recognisable gesture or habit, one sentence",
  },
  {
    key: "relationshipNotes",
    label: "Relationship notes",
    list: false,
    storyOnly: true,
    ask: "how they relate to the other characters in this story, by name",
  },
  {
    key: "continuityRules",
    label: "Continuity rules",
    list: true,
    storyOnly: false,
    ask: "3 to 6 visual rules that must stay the same in every picture and Shot, one per line",
  },
];

/** The fields asked for this Character: a story's Character gets all of them; one made on its own, no role. */
export const characterAiFields = (inStory: boolean) =>
  CHARACTER_AI_FIELDS.filter((f) => inStory || !f.storyOnly);

const MARK = (id: string) => `[character ${id}]`;

/** The sheet as it stands, field by field (what Prism starts from, and what the review compares with). */
export function characterAsText(c: Character): Record<CharacterAiKey, string> {
  const out = {} as Record<CharacterAiKey, string>;
  for (const f of CHARACTER_AI_FIELDS) {
    const v = (c as unknown as Record<string, unknown>)[f.key];
    out[f.key] = (Array.isArray(v) ? v.join("\n") : String(v ?? "")).slice(0, LIMITS.ideaDetail);
  }
  return out;
}

/**
 * Fill in (or, with a note, revise) the Character's sheet. The instruction carries the Character's id, so the request
 * is found again for this Character; everything the creator already wrote is sent and kept unless the note says
 * otherwise.
 */
export function characterFillInstruction(
  data: ProjectData,
  c: Character,
  opts: { note?: string; revise?: boolean } = {},
): string {
  const note = opts.note?.trim() || undefined;
  const revise = !!opts.revise;
  const inStory = data.project.purpose !== "library";
  const fields = characterAiFields(inStory);
  const sheet = characterAsText(c);
  const written = fields.filter((f) => sheet[f.key].trim());
  return [
    `${revise ? "Revise" : "Fill in"} the character sheet for ${c.name} ${MARK(c.id)}. Give exactly ${fields.length} ideas, one per field, in this order.`,
    "Each idea's title is exactly the field's name (as written below); its detail is that field's content. For a list field, put one item per line.",
    ...fields.map((f) => `- ${f.key}: ${f.ask}`),
    inStory
      ? "Keep them true to this story: the Bible and the other characters are in the context."
      : "This character belongs to no story yet: keep them usable in any story, and invent no plot events.",
    revise
      ? "This is a draft: keep everything the creator's note does not ask to change."
      : "Keep everything already written below (improve the wording only where it is unclear); fill in what is empty, following the creator's note when there is one.",
    "",
    `Name: ${c.name}`,
    ...written.map((f) => `${f.label}: ${sheet[f.key].replace(/\s+/g, " ").slice(0, 1200)}`),
    inStory && data.bible.premise.trim()
      ? `Story premise: ${data.bible.premise.trim().slice(0, PREMISE_MAX)}`
      : "",
    note ? `Creator's note: ${note.trim().slice(0, REFINE_NOTE_MAX)}` : "",
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n")
    .slice(0, LIMITS.instruction);
}

/** A writing request that fills in a Character's sheet: for this Character, when `characterId` is given. */
export const isCharacterRequest = (instruction: string, characterId?: string) =>
  /^(?:Fill in|Revise) the character sheet for /.test(instruction) &&
  (characterId == null || instruction.includes(MARK(characterId)));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/** A field's text as the Character stores it: a list field is one item per line. */
export function characterFieldValue(key: CharacterAiKey, text: string): string | string[] {
  const f = CHARACTER_AI_FIELDS.find((x) => x.key === key)!;
  const t = text.trim().slice(0, LIMITS.ideaDetail);
  return f.list
    ? t
        .split("\n")
        .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
        .filter(Boolean)
    : t;
}

/** The sheet a request proposes: each field it names (by key or label), as the Character stores it. */
export function parseCharacterIdeas(
  ideas: ReadonlyArray<{ title: string; detail: string }>,
  inStory: boolean,
): Partial<Record<CharacterAiKey, string | string[]>> {
  const allowed = characterAiFields(inStory);
  const out: Partial<Record<CharacterAiKey, string | string[]>> = {};
  for (const idea of ideas) {
    const f = allowed.find((x) => norm(x.key) === norm(idea.title) || norm(x.label) === norm(idea.title));
    if (!f || out[f.key] !== undefined) continue;
    out[f.key] = characterFieldValue(f.key, idea.detail);
  }
  return out;
}

/** Whether a sheet is thin enough that filling it in is the obvious next step. */
export const characterSheetThin = (c: Character) =>
  !c.personality.trim() || !c.behaviorNotes.trim() || !c.signatureBehavior.trim();
