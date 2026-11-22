"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { characterSchema, projectSchema, type Project } from "@/domain/schemas";
import { newProjectRecords } from "@/domain/series-start";
import {
  CHARACTER_NAME_MAX,
  CHARACTER_PROMPT_MAX,
  CHARACTER_STUDIO_TITLE,
  nameFromPrompt,
} from "@/domain/standalone-character";
import { CharacterLibraryUnavailableError } from "@/data/repository";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { copyIntoProject } from "./character-library";
import { getRepo, requireProjectFresh } from "./repo";
import { actorId } from "./script-sync";

/**
 * The account's character library: save a Character to it from its project, take it out, and add a saved Character
 * to another project (a copy: see src/domain/character-library.ts).
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

async function setInLibrary_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const character = data.characters.find((c) => c.id === str(form, "characterId"));
  if (!character) throw new UserFacingError("That character is not in this project.");
  const saved = str(form, "saved") !== "0";
  try {
    await (await getRepo()).setInLibrary(data.project.id, character.id, saved);
  } catch (err) {
    if (err instanceof CharacterLibraryUnavailableError) throw new UserFacingError(err.message);
    throw err;
  }
  revalidatePath("/", "layout");
  return {
    ok: true as const,
    message: saved ? `${character.name} is in your library.` : `${character.name} is out of your library.`,
  };
}

async function addFromLibrary_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const target = await requireProjectFresh(slug);
  const repo = await getRepo();
  const characterId = str(form, "characterId");
  const { entries, available } = await repo.libraryEntries();
  if (!available) throw new UserFacingError(new CharacterLibraryUnavailableError().message);
  const entry = entries.find((e) => e.characterId === characterId);
  if (!entry) throw new UserFacingError("That character is not in your library.");
  if (entry.projectId === target.project.id)
    throw new UserFacingError("That character already lives in this project.");
  const sourceSlug = (await repo.listProjects()).find((p) => p.id === entry.projectId)?.slug;
  const source = sourceSlug ? await repo.loadProject(sourceSlug) : null;
  if (!source) throw new UserFacingError("The project that character lives in is not available.");
  const plan = await copyIntoProject(target, source, characterId, await actorId());
  revalidatePath(`/projects/${slug}`, "layout");
  // placeholders (a slot with no stored picture yet) are copied too, but are not pictures
  const pictures = plan.assets.filter((a) => a.from.objectPath).length;
  return {
    ok: true as const,
    message: `${plan.character.name} added${pictures ? ` with ${pictures} picture${pictures === 1 ? "" : "s"}` : ""}.`,
  };
}

/** The account's own project for Characters made outside any story (purpose `library`), made the first time. */
async function characterStudio(): Promise<Project> {
  const repo = await getRepo();
  const all = await repo.listProjects();
  const found = all.find((p) => p.purpose === "library");
  if (found) return found;
  const taken = new Set([
    ...all.map((p) => p.slug),
    ...(await repo.trashedProjects()).projects.map((t) => t.project.slug),
  ]);
  let slug = "your-characters";
  while (taken.has(slug)) slug = `your-characters-${randomUUID().slice(0, 4)}`;
  const records = newProjectRecords({
    id: randomUUID(),
    userId: repo.currentUserId(),
    title: CHARACTER_STUDIO_TITLE,
    slug,
    projectType: "film",
    description: "Characters made on their own, ready to add to any project.",
    now: new Date().toISOString(),
  });
  const project = projectSchema.parse({ ...records.project, purpose: "library" });
  try {
    await repo.createProject(project, records.bible);
  } catch (err) {
    // 23514: the purpose check does not allow `library` yet
    if ((err as { code?: string }).code === "23514")
      throw new UserFacingError(
        "Creating characters on their own needs a one-time database update (migration 0065) that has not been applied yet.",
      );
    throw err;
  }
  return project;
}

/**
 * Create a character from a description, outside any story: it is made in the account's own characters project, put
 * in the library (so any project can add it), and opened, ready for pictures in the Reference Studio.
 */
async function createStandaloneCharacter_impl(form: FormData) {
  const prompt = str(form, "prompt").slice(0, CHARACTER_PROMPT_MAX);
  if (!prompt) throw new UserFacingError("Describe your character first.");
  const name = (str(form, "name") || nameFromPrompt(prompt)).slice(0, CHARACTER_NAME_MAX);
  const studio = await characterStudio();
  const repo = await getRepo();
  const now = new Date().toISOString();
  const character = characterSchema.parse({
    id: randomUUID(),
    projectId: studio.id,
    name,
    role: "",
    description: prompt,
    personality: "",
    behaviorNotes: "",
    // what the Reference Studio makes pictures from
    physicalDescription: prompt,
    continuityRules: [],
    signatureBehavior: "",
    relationshipNotes: "",
    createdAt: now,
    updatedAt: now,
  });
  await repo.upsert(studio.id, "characters", character);
  try {
    await repo.setInLibrary(studio.id, character.id, true);
  } catch (err) {
    if (!(err instanceof CharacterLibraryUnavailableError)) throw err;
  }
  revalidatePath("/", "layout");
  redirect(`/projects/${studio.slug}/characters/${character.id}`);
}

export async function createStandaloneCharacter(form: FormData): Promise<ActionResult> {
  return runAction(() => createStandaloneCharacter_impl(form), { name: "createStandaloneCharacter" });
}

export async function setCharacterInLibrary(form: FormData): Promise<ActionResult> {
  return runAction(() => setInLibrary_impl(form), { name: "setCharacterInLibrary" });
}

export async function addFromLibrary(form: FormData): Promise<ActionResult> {
  return runAction(() => addFromLibrary_impl(form), { name: "addFromLibrary" });
}
