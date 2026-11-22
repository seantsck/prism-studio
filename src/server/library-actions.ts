"use server";

import { revalidatePath } from "next/cache";
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

export async function setCharacterInLibrary(form: FormData): Promise<ActionResult> {
  return runAction(() => setInLibrary_impl(form), { name: "setCharacterInLibrary" });
}

export async function addFromLibrary(form: FormData): Promise<ActionResult> {
  return runAction(() => addFromLibrary_impl(form), { name: "addFromLibrary" });
}
