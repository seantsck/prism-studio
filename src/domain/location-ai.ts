import type { Location, ProjectData } from "./schemas";
import { PREMISE_MAX, REFINE_NOTE_MAX } from "./series-start";
import { LIMITS } from "./story/writing";

/**
 * A Location's sheet, filled in with Prism: the same shape as a Character's (src/domain/character-ai.ts). An ordinary
 * writing request (a brainstorm) whose ideas are the sheet's fields, reviewed field by field and applied only where the
 * creator ticks it. Zones and entrances are what Shots use to place people, so each is "name: description", one per
 * line, exactly as the Locations form takes them.
 */

export type LocationAiKey =
  "description" | "geography" | "zones" | "entrances" | "lighting" | "recurringProps";

export interface LocationAiField {
  key: LocationAiKey;
  label: string;
  /** one per line */
  list: boolean;
  /** each line is "name: description" */
  named: boolean;
  ask: string;
}

export const LOCATION_AI_FIELDS: readonly LocationAiField[] = [
  {
    key: "description",
    label: "Description",
    list: false,
    named: false,
    ask: "a precise visual description used to make its pictures: the space, materials, colours, era, atmosphere. Only what a camera sees; no story events",
  },
  {
    key: "geography",
    label: "Geography",
    list: false,
    named: false,
    ask: "the layout: size, shape, what is where, how a person moves through it (2 to 4 sentences)",
  },
  {
    key: "zones",
    label: "Zones",
    list: true,
    named: true,
    ask: '3 to 6 named areas where action happens, one per line as "Name: what it is and what is there"',
  },
  {
    key: "entrances",
    label: "Entrances / exits",
    list: true,
    named: true,
    ask: '1 to 4 ways in and out, one per line as "Name: where it is and where it leads"',
  },
  {
    key: "lighting",
    label: "Lighting",
    list: false,
    named: false,
    ask: "the light at its usual time of day, its sources and colour, and how it changes (day, night)",
  },
  {
    key: "recurringProps",
    label: "Recurring props",
    list: true,
    named: false,
    ask: "3 to 8 objects that are always there, one per line",
  },
];

const MARK = (id: string) => `[location ${id}]`;

const named = (xs: Array<{ name: string; description: string }>) =>
  xs.map((x) => (x.description ? `${x.name}: ${x.description}` : x.name)).join("\n");

/** The sheet as it stands, field by field (as the Locations form shows it). */
export function locationAsText(l: Location): Record<LocationAiKey, string> {
  return {
    description: l.description,
    geography: l.geography,
    zones: named(l.zones),
    entrances: named(l.entrances),
    lighting: l.lighting,
    recurringProps: l.recurringProps.join("\n"),
  };
}

/** Fill in the Location's sheet, or revise Prism's draft of it with a note. */
export function locationFillInstruction(
  data: ProjectData,
  l: Location,
  sheet: Record<LocationAiKey, string> = locationAsText(l),
  opts: { note?: string; revise?: boolean } = {},
): string {
  const inStory = data.project.purpose !== "library";
  const note = opts.note?.trim() || undefined;
  const written = LOCATION_AI_FIELDS.filter((f) => sheet[f.key].trim());
  return [
    `${opts.revise ? "Revise" : "Fill in"} the location sheet for ${l.name} ${MARK(l.id)}. Give exactly ${LOCATION_AI_FIELDS.length} ideas, one per field, in this order.`,
    "Each idea's title is exactly the field's name (as written below); its detail is that field's content. For a list field, put one item per line.",
    ...LOCATION_AI_FIELDS.map((f) => `- ${f.key}: ${f.ask}`),
    inStory
      ? "Keep it true to this story: the Bible and the characters are in the context."
      : "This location belongs to no story yet: keep it usable in any story, and invent no plot events.",
    opts.revise
      ? "This is a draft: keep everything the creator's note does not ask to change."
      : "Keep everything already written below (improve the wording only where it is unclear); fill in what is empty, following the creator's note when there is one.",
    "",
    `Name: ${l.name}`,
    ...written.map((f) => `${f.label}: ${sheet[f.key].replace(/\s+/g, " ").slice(0, 1200)}`),
    inStory && data.bible.premise.trim()
      ? `Story premise: ${data.bible.premise.trim().slice(0, PREMISE_MAX)}`
      : "",
    note ? `Creator's note: ${note.slice(0, REFINE_NOTE_MAX)}` : "",
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n")
    .slice(0, LIMITS.instruction);
}

/** A writing request that fills in a Location's sheet: for this Location, when `locationId` is given. */
export const isLocationRequest = (instruction: string, locationId?: string) =>
  /^(?:Fill in|Revise) the location sheet for /.test(instruction) &&
  (locationId == null || instruction.includes(MARK(locationId)));

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/** A field's text, cleaned: list fields one item per line without bullets. */
export function locationFieldText(key: LocationAiKey, text: string): string {
  const f = LOCATION_AI_FIELDS.find((x) => x.key === key)!;
  const t = text.trim().slice(0, LIMITS.ideaDetail);
  return f.list
    ? t
        .split("\n")
        .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
        .filter(Boolean)
        .join("\n")
    : t;
}

/** The sheet a request proposes, as text per field (the form's own format). */
export function parseLocationIdeas(
  ideas: ReadonlyArray<{ title: string; detail: string }>,
): Partial<Record<LocationAiKey, string>> {
  const out: Partial<Record<LocationAiKey, string>> = {};
  for (const idea of ideas) {
    const f = LOCATION_AI_FIELDS.find(
      (x) => norm(x.key) === norm(idea.title) || norm(x.label) === norm(idea.title),
    );
    if (!f || out[f.key] !== undefined) continue;
    out[f.key] = locationFieldText(f.key, idea.detail);
  }
  return out;
}

/** "Name: description" lines as the Location stores them (ids are made by the caller). */
export function namedLines(text: string): Array<{ name: string; description: string }> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, ...rest] = l.split(":");
      return { name: name!.trim(), description: rest.join(":").trim() };
    })
    .filter((x) => x.name);
}

/** Whether a sheet is thin enough that filling it in is the obvious next step. */
export const locationSheetThin = (l: Location) =>
  !l.geography.trim() || l.zones.length === 0 || !l.lighting.trim();
