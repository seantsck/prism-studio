"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { planActorFrom } from "@/domain/character-library";
import type { Character, ProjectData } from "@/domain/schemas";
import { CharacterLibraryUnavailableError } from "@/data/repository";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { copyActorReferences, copyPlanIntoProject } from "./character-library";
import { characterStudio } from "./library-project";
import { getRepo, requireProjectFresh } from "./repo";
import { actorId as signedInUser } from "./script-sync";

/**
 * Actors and the Characters they play (migration 0071). An Actor lives in the account's library project: who someone is
 * and how they look (photos and views). A Character of a story can be "played by" an Actor: the Actor's reference
 * pictures are copied into the Character's project (a generation only reads its own project's pictures), and new
 * pictures of the Character are made from them. Nothing here generates anything (free); nothing is deleted.
 */
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const UNDEFINED_COLUMN = "42703";
const NEEDS_0071 = "Actors need a one-time database update (migration 0071) that has not been applied yet.";

/** Saves the Character's link to an Actor (or none); before migration 0071 it says so, having changed nothing. */
async function saveLink(projectId: string, character: Character, actorId: string | null) {
  try {
    await (
      await getRepo()
    ).upsert(projectId, "characters", {
      ...character,
      actorId,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_COLUMN) throw new UserFacingError(NEEDS_0071);
    throw err;
  }
}

async function storyCharacter(
  form: FormData,
): Promise<{ data: ProjectData; character: Character; slug: string }> {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  if (data.project.purpose === "library")
    throw new UserFacingError("This is an Actor already: Characters of your projects are played by Actors.");
  const character = data.characters.find((c) => c.id === str(form, "characterId") && !c.trashedAt);
  if (!character) throw new UserFacingError("That character is not in this project.");
  return { data, character, slug };
}

/** The library project and one of its Actors. */
async function libraryActor(id: string): Promise<{ library: ProjectData; actor: Character }> {
  const project = await characterStudio();
  const library = await (await getRepo()).loadProject(project.slug);
  const actor = library?.characters.find((c) => c.id === id && !c.trashedAt);
  if (!library || !actor) throw new UserFacingError("That actor is no longer in your library.");
  return { library, actor };
}

/**
 * "Make an actor from Yumeko": a new Actor in the library with this Character's reference pictures (photos and views,
 * copied), linked as the Actor that plays it. The Character keeps everything it has.
 */
async function makeActorFrom_impl(form: FormData) {
  const { data, character, slug } = await storyCharacter(form);
  if (character.actorId) throw new UserFacingError(`${character.name} is played by an actor already.`);
  // the link is saved first (as it is), so a database without migration 0071 refuses before anything is made
  await saveLink(data.project.id, character, null);
  const project = await characterStudio();
  const repo = await getRepo();
  const library = await repo.loadProject(project.slug);
  if (!library) throw new UserFacingError("Your library could not be opened.");
  const plan = planActorFrom(data, character.id, library, randomUUID, new Date().toISOString());
  await copyPlanIntoProject(library, plan, await signedInUser());
  try {
    await repo.setInLibrary(library.project.id, plan.character.id, true);
  } catch (err) {
    if (!(err instanceof CharacterLibraryUnavailableError)) throw err;
  }
  await saveLink(data.project.id, character, plan.character.id);
  revalidatePath("/", "layout");
  revalidatePath(`/projects/${slug}`, "layout");
  const pictures = plan.assets.filter((a) => a.from.objectPath).length;
  return {
    ok: true as const,
    message: `${plan.character.name} is now an actor in your library${pictures ? `, with ${pictures} picture${pictures === 1 ? "" : "s"}` : ""}, and plays ${character.name} here.`,
  };
}

/**
 * "Played by": link a Character to an Actor of the library. The Actor's reference pictures it does not have yet are
 * copied in as its references; linking again brings in pictures the Actor has gained since.
 */
async function linkActor_impl(form: FormData) {
  const { data, character, slug } = await storyCharacter(form);
  const { library, actor } = await libraryActor(str(form, "actorId"));
  await saveLink(data.project.id, character, actor.id);
  const added = await copyActorReferences(data, character.id, library, actor.id, await signedInUser());
  revalidatePath(`/projects/${slug}`, "layout");
  revalidatePath("/", "layout");
  return {
    ok: true as const,
    message: `${actor.name} plays ${character.name}.${added ? ` ${added} of ${actor.name}'s picture${added === 1 ? " was" : "s were"} added as references.` : ` ${character.name} has ${actor.name}'s pictures already.`}`,
  };
}

/** No Actor plays this Character any more; the pictures already copied stay. */
async function unlinkActor_impl(form: FormData) {
  const { data, character, slug } = await storyCharacter(form);
  await saveLink(data.project.id, character, null);
  revalidatePath(`/projects/${slug}`, "layout");
  revalidatePath("/", "layout");
  return { ok: true as const, message: `${character.name} is played by no actor now. Its pictures stay.` };
}

export async function makeActorFrom(form: FormData): Promise<ActionResult> {
  return runAction(() => makeActorFrom_impl(form), { name: "makeActorFrom" });
}

export async function linkActor(form: FormData): Promise<ActionResult> {
  return runAction(() => linkActor_impl(form), { name: "linkActor" });
}

export async function unlinkActor(form: FormData): Promise<ActionResult> {
  return runAction(() => unlinkActor_impl(form), { name: "unlinkActor" });
}
