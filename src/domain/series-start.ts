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

/** Quick choices for a new series' Episode count; any whole number from 1 to MAX_EPISODES can be typed. */
export const EPISODE_COUNTS = [6, 8, 10, 12] as const;
export const DEFAULT_EPISODE_COUNT = 8;
/**
 * The most Episodes one season can have. A plan longer than PLAN_BATCH Episodes is written in batches (each sees the
 * Episodes planned before it), so the ceiling is the per-request spend limit, not one answer's length.
 */
export const MAX_EPISODES = 500;
/** The longest an Episode (or film) can be set to run, in minutes. */
export const MAX_MINUTES = 600;
/** The longest note a creator gives Prism to refine a plan. */
export const REFINE_NOTE_MAX = 600;

/** A typed Episode count (above MAX_EPISODES: MAX_EPISODES), or the default when it is not a whole number from 1. */
export function episodeCountOf(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_EPISODE_COUNT;
  return Math.min(n, MAX_EPISODES);
}

const kindOf = (data: ProjectData) =>
  data.project.projectType === "film"
    ? "film"
    : data.project.projectType === "short"
      ? "short film"
      : "series";

/** A writing request that plans (or revises the plan of) a season. */
export const isSeasonPlanRequest = (instruction: string) =>
  instruction.startsWith("Plan season 1") || instruction.startsWith("Revise the season plan");

/** The most Episodes Prism adds in one go. */
export const MAX_ADD_EPISODES = 20;
/** The longest note for adding Episodes. */
export const ADD_EPISODES_NOTE_MAX = 1000;
export const isAddEpisodesRequest = (instruction: string) => instruction.startsWith("Plan the next");

/**
 * Adding Episodes with Prism: the next `count` Episodes of the series, continuing the plan the project has (sent as
 * seasonPlan). A brainstorm: one idea per new Episode; nothing is added until the creator uses them.
 */
export function addEpisodesInstruction(
  data: ProjectData,
  from: number,
  count: number,
  minutes: number | null,
  note: string,
): string {
  const to = from + count - 1;
  return [
    `Plan the next ${count} episode${count === 1 ? "" : "s"} of this series (episode${count === 1 ? ` ${from}` : `s ${from} to ${to}`}): give exactly ${count} idea${count === 1 ? "" : "s"}, one per new episode, in order.`,
    "The episodes so far are in the context (seasonPlan): continue the story from where the last one ends, without repeating them. Keep the characters, their relationships and the Bible consistent.",
    "Each idea's title is that episode's title (no number). Its detail is 2 to 4 sentences: what happens in the episode, how it ends, and the hook into the next one.",
    ...(minutes ? [`Each new episode runs about ${minutes} minutes: pace what happens to fit.`] : []),
    ...(note.trim() ? [`The creator's note: ${note.trim().slice(0, ADD_EPISODES_NOTE_MAX)}`] : []),
    "",
    `Premise: ${data.bible.premise.trim().slice(0, PREMISE_MAX)}`,
  ]
    .join("\n")
    .slice(0, LIMITS.instruction);
}

/** What Prism is asked to plan a season from: one idea per Episode, in order (a brainstorm: nothing is written). */
export function seasonPlanInstruction(data: ProjectData, episodes: number): string {
  return [
    `Plan season 1 of this series from its premise: give exactly ${episodes} ideas, one per episode, in order.`,
    "Each idea's title is that episode's title (no number). Its detail is 2 to 4 sentences: what happens in the",
    "episode, how it ends, and the hook into the next one. Together they tell one story with a clear arc and a",
    "satisfying season ending.",
    runtimesLine(data.episodes),
    "",
    `Premise: ${data.bible.premise.trim().slice(0, PREMISE_MAX)}`,
  ]
    .join("\n")
    .slice(0, LIMITS.instruction);
}

/**
 * What Prism is asked to revise a season plan with: the current plan (titles and synopses, sent in the context as
 * seasonPlan) and the creator's note. It returns the whole revised plan, one idea per Episode, to review before use.
 */
export function seasonRefineInstruction(data: ProjectData, episodes: number, note: string): string {
  return [
    `Revise the season plan in the context (seasonPlan) following the creator's note. Give exactly ${episodes} ideas, one per episode, in order: the whole revised plan, not only what changed.`,
    "Keep what the note does not ask to change. Each idea's title is that episode's title (no number); its detail is 2 to 4 sentences: what happens, how it ends, and the hook into the next one.",
    "",
    `Creator's note: ${note.trim().slice(0, REFINE_NOTE_MAX)}`,
    runtimesLine(data.episodes),
    "",
    `Premise: ${data.bible.premise.trim().slice(0, PREMISE_MAX)}`,
  ]
    .join("\n")
    .slice(0, LIMITS.instruction);
}

/** How long a script should run: about a page a minute, in scenes sized to it. */
export function lengthLine(minutes: number): string {
  const scenes = Math.max(2, Math.round(minutes / 2.5));
  return `It runs about ${minutes} minutes on screen: about ${minutes} screenplay pages (a page a minute), in roughly ${Math.max(2, scenes - 2)} to ${scenes + 2} scenes. Pace the story to fill that length, no shorter and no longer.`;
}

/** The runtimes of a season, compressed: "episodes 1–10: 24 minutes; episode 11: 45 minutes". Empty when none is set. */
export function runtimesLine(
  episodes: ReadonlyArray<{ number: number; targetMinutes?: number | null }>,
): string {
  const runs: Array<{ from: number; to: number; minutes: number }> = [];
  for (const e of [...episodes].sort((a, b) => a.number - b.number)) {
    if (!e.targetMinutes) continue;
    const last = runs.at(-1);
    if (last && last.minutes === e.targetMinutes && last.to === e.number - 1) last.to = e.number;
    else runs.push({ from: e.number, to: e.number, minutes: e.targetMinutes });
  }
  if (!runs.length) return "";
  const parts = runs.map((r) =>
    r.from === r.to ? `episode ${r.from}: ${r.minutes} min` : `episodes ${r.from}–${r.to}: ${r.minutes} min`,
  );
  const line = `Runtimes (pace what happens in each episode to fit): ${parts.join("; ")}.`;
  return line.length > 1200 ? `${line.slice(0, 1190)}…` : line;
}

/** What Prism is asked to write for a whole Episode (from its planned synopsis) or a whole film. */
export function wholeScriptInstruction(data: ProjectData, episode: Episode): string {
  const language = data.project.defaultLanguage;
  const kind = kindOf(data);
  const head =
    kind === "series"
      ? [
          `Write the complete screenplay of episode ${episode.number}, "${episode.title}", of this series.`,
          episode.synopsis.trim()
            ? `What happens in this episode: ${episode.synopsis.trim()}`
            : "Follow the premise; this episode sets up the series.",
          "Keep it consistent with the season plan in the context (who knows what, where each story stands).",
        ]
      : [`Write the complete screenplay of this ${kind}, from its opening to its ending.`];
  return [
    ...head,
    ...(episode.targetMinutes ? [lengthLine(episode.targetMinutes)] : []),
    "Standard screenplay format: scene headings (INT./EXT. PLACE - TIME), short action lines, CHARACTER NAMES in capitals above their dialogue.",
    "Introduce each main character with a short visual description the first time they appear.",
    "When the context has the project Bible (bible), follow it: its canon facts, continuity rules, tone and dialogue language strategy.",
    `Dialogue in the project's language (${language}); everything else in English.`,
    "",
    `Premise: ${data.bible.premise.trim().slice(0, PREMISE_MAX)}`,
  ]
    .join("\n")
    .slice(0, LIMITS.instruction);
}

/** The longest current screenplay a redraft sends (the context keeps the story; a longer one is clipped at its end). */
export const REDRAFT_SOURCE_MAX = 60_000;
/** The longest note the creator can add to a redraft. */
export const REDRAFT_NOTE_MAX = 1000;

/**
 * Redrafting an Episode that already has a screenplay: a NEW complete screenplay at the Episode's length, written in
 * parts, keeping the story of the current one (sent as `previousDraft`). It replaces the screenplay only when accepted.
 */
export function redraftInstruction(data: ProjectData, episode: Episode, note: string): string {
  const lines = [
    "REDRAFT: the episode's current screenplay is in the context (previousDraft). Write a NEW complete screenplay of the episode from its first scene to its last, replacing it.",
    "Keep its story, characters, relationships and the moments that work; fix what is thin. Reach the full length with fuller scenes, more behaviour and real dialogue exchanges, and new scenes where the story needs them, never filler or repetition.",
    ...(note.trim()
      ? [`The creator's note for this redraft: ${note.trim().slice(0, REDRAFT_NOTE_MAX)}`]
      : []),
    "",
  ];
  return [...lines, wholeScriptInstruction(data, episode)].join("\n").slice(0, LIMITS.instruction);
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
  /** A series started from a premise gets this many (empty) Episodes; anything else one. */
  episodeCount?: number;
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
  episodes: Episode[];
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
  const count = project.projectType === "series" ? episodeCountOf(input.episodeCount) : 1;
  const episodes = premise
    ? Array.from({ length: count }, (_, i) =>
        emptyEpisode(input.id, input.now, i + 1, project.projectType === "series" ? undefined : "Screenplay"),
      )
    : [];
  return { project, bible, episodes };
}

/** An empty Episode, waiting for its script. */
export function emptyEpisode(projectId: string, now: string, number = 1, title?: string): Episode {
  return episodeSchema.parse({
    id: crypto.randomUUID(),
    projectId,
    number,
    slug: `ep-${number}`,
    title: title ?? `Episode ${number}`,
    synopsis: "",
    scriptText: "",
    order: number - 1,
    createdAt: now,
    updatedAt: now,
  });
}

/** An empty Episode 1 (an existing project started from a premise). */
export const emptyEpisodeOne = (projectId: string, now: string) => emptyEpisode(projectId, now, 1);

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
    episodes: records.episodes,
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
