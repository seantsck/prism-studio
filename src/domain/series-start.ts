import {
  bibleSchema,
  episodeSchema,
  projectSchema,
  PROJECT_TYPES,
  type Episode,
  type Project,
  type ProjectBible,
  type ProjectData,
} from "@/domain/schemas";
import { LIMITS } from "@/domain/story/writing";

/**
 * Starting a series from a prompt. The pure parts: how long a premise may be, and what the writing assistant is asked
 * to write for Episode 1 (its "Continue" on the empty Episode, so it reaches the creator as a proposal to review).
 */

/** The longest premise kept (the rest of the writing instruction must still fit the assistant's limit). */
export const PREMISE_MAX = 3000;

/** What the writing assistant is asked to write for Episode 1. */
export function episodeOneInstruction(data: ProjectData, premise: string): string {
  const language = data.project.defaultLanguage;
  return [
    `Write the complete screenplay of Episode 1 of this ${data.project.projectType} from the premise below.`,
    "Standard screenplay format: scene headings (INT./EXT. PLACE - TIME), short action lines, CHARACTER NAMES in capitals above their dialogue.",
    "Introduce the main characters with a short visual description the first time each appears.",
    `Dialogue in the project's language (${language}); everything else in English.`,
    "Keep it compact: about five short scenes (around five pages), ending on a hook for the next episode.",
    "",
    `Premise: ${premise.trim().slice(0, PREMISE_MAX)}`,
  ]
    .join("\n")
    .slice(0, LIMITS.instruction);
}

/** The longest project title kept. */
export const TITLE_MAX = 120;
/** What a new project keeps of its other fields (enough for the writing context, which clips them further). */
export const NEW_PROJECT_LIMITS = { description: 1500, genre: 150, tone: 150, language: 16 } as const;

/**
 * A working title from the premise, when the creator gives none: its first sentence when that is short, else its first
 * six words. Deterministic (no AI, nothing spent); the creator renames it any time in the project's settings.
 */
export function titleFromPremise(premise: string): string {
  const text = premise.trim().replace(/\s+/g, " ");
  if (!text) return "";
  const first = text
    .split(/(?<=[.!?。！？])\s*|\n/)[0]!
    .replace(/[.!?。！？]+$/, "")
    .trim();
  if (first.length <= 60) return first;
  // a language written without spaces (Japanese, Chinese): the first 24 characters
  if (!/\s/.test(first)) return `${first.slice(0, 24)}…`;
  return `${first.split(" ").slice(0, 6).join(" ")}…`;
}

export interface NewProjectInput {
  id: string;
  userId: string;
  title: string;
  slug: string;
  projectType?: string;
  description?: string;
  genre?: string;
  tone?: string;
  defaultLanguage?: string;
  premise?: string;
  now: string;
}

/**
 * Every record a new project starts with: the project, its Bible (the premise, the house guardrails) and, when it starts
 * from a premise, an empty Episode 1 for the writing assistant. One builder for the real project and for pricing the
 * first AI step before the project exists, so the two can never disagree.
 */
export function newProjectRecords(input: NewProjectInput): {
  project: Project;
  bible: ProjectBible;
  episodeOne: Episode | null;
} {
  const projectType = (PROJECT_TYPES as readonly string[]).includes(input.projectType ?? "")
    ? input.projectType
    : "series";
  const project = projectSchema.parse({
    id: input.id,
    userId: input.userId,
    title: input.title.slice(0, TITLE_MAX),
    slug: input.slug,
    projectType,
    description: (input.description ?? "").slice(0, NEW_PROJECT_LIMITS.description),
    genre: (input.genre ?? "").slice(0, NEW_PROJECT_LIMITS.genre),
    tone: (input.tone ?? "").slice(0, NEW_PROJECT_LIMITS.tone),
    defaultLanguage: (input.defaultLanguage || "en").slice(0, NEW_PROJECT_LIMITS.language),
    productionStatus: "development",
    createdAt: input.now,
    updatedAt: input.now,
  });
  const premise = (input.premise ?? "").trim().slice(0, PREMISE_MAX);
  const bible = bibleSchema.parse({
    projectId: input.id,
    premise,
    genre: project.genre,
    tone: project.tone,
    visualStyle: "",
    cinematographyRules: [],
    colorLanguage: "",
    aspectRatio: "16:9",
    defaultFrameRate: 24,
    dialogueLanguageStrategy: "",
    subtitleStrategy: "",
    audioPhilosophy: "",
    canonFacts: [],
    continuityRules: [],
    guardrails: [
      "Never silently rewrite approved dialogue.",
      "Never change a locked character Look.",
      "Never add characters not assigned to a shot.",
      "Never change a locked location/set.",
    ],
    updatedAt: input.now,
  });
  const episodeOne = premise ? emptyEpisodeOne(input.id, input.now) : null;
  return { project, bible, episodeOne };
}

/** An empty Episode 1, waiting for the writing assistant. */
export function emptyEpisodeOne(projectId: string, now: string, id: string = crypto.randomUUID()): Episode {
  return episodeSchema.parse({
    id,
    projectId,
    number: 1,
    slug: "ep-1",
    title: "Episode 1",
    synopsis: "",
    scriptText: "",
    order: 0,
    createdAt: now,
    updatedAt: now,
  });
}

/** The project as the app loads it, straight after creation (for pricing its first AI step). */
export function freshProjectData(records: ReturnType<typeof newProjectRecords>): ProjectData {
  return {
    project: records.project,
    bible: records.bible,
    assets: [],
    characters: [],
    identityRefs: [],
    looks: [],
    voiceProfiles: [],
    locations: [],
    props: [],
    episodes: records.episodeOne ? [records.episodeOne] : [],
    scenes: [],
    shots: [],
    dialogueLines: [],
    actionBlocks: [],
    directions: [],
    takes: [],
    frames: [],
    attempts: [],
    continuityChecks: [],
  };
}
