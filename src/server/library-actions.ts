"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { characterSchema, locationSchema } from "@/domain/schemas";
import {
  CHARACTER_NAME_MAX,
  CHARACTER_PROMPT_MAX,
  LOCATION_NAME_MAX,
  LOCATION_PROMPT_MAX,
  locationNameFromPrompt,
  nameFromPrompt,
} from "@/domain/standalone-character";
import { CharacterLibraryUnavailableError, LocationLibraryUnavailableError } from "@/data/repository";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { copyIntoProject, copyLocationIntoProject } from "./character-library";
import { fillCharacter } from "./character-ai-actions";
import { fillLocation } from "./location-ai-actions";
import { getRepo, requireProjectFresh } from "./repo";
import { characterStudio } from "./library-project";
import { actorId } from "./script-sync";

/**
 * The account's library: save a Character or Location to it from its project, take it out, and add a saved one to
 * another project (a copy: see src/domain/character-library.ts and src/domain/location-library.ts).
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
  // from the library's own page ("Add to a project"): open the copy in that project
  if (str(form, "open") === "1") redirect(`/projects/${slug}/characters/${plan.character.id}`);
  // placeholders (a slot with no stored picture yet) are copied too, but are not pictures
  const pictures = plan.assets.filter((a) => a.from.objectPath).length;
  return {
    ok: true as const,
    message: `${plan.character.name} added${pictures ? ` with ${pictures} picture${pictures === 1 ? "" : "s"}` : ""}.`,
  };
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
  const filling = await fillAfterCreate(form, studio.slug, "character", character.id);
  revalidatePath("/", "layout");
  return {
    filling,
    slug: studio.slug,
    id: character.id,
    href: `/projects/${studio.slug}/characters/${character.id}?new=1#character-ai`,
  };
}

async function setLocationInLibrary_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const data = await requireProjectFresh(slug);
  const location = data.locations.find((l) => l.id === str(form, "locationId"));
  if (!location) throw new UserFacingError("That location is not in this project.");
  const saved = str(form, "saved") !== "0";
  try {
    await (await getRepo()).setLocationInLibrary(data.project.id, location.id, saved);
  } catch (err) {
    if (err instanceof LocationLibraryUnavailableError) throw new UserFacingError(err.message);
    throw err;
  }
  revalidatePath("/", "layout");
  return {
    ok: true as const,
    message: saved ? `${location.name} is in your library.` : `${location.name} is out of your library.`,
  };
}

async function addLocationFromLibrary_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  const target = await requireProjectFresh(slug);
  const repo = await getRepo();
  const locationId = str(form, "locationId");
  const { entries, available } = await repo.locationLibraryEntries();
  if (!available) throw new UserFacingError(new LocationLibraryUnavailableError().message);
  const entry = entries.find((e) => e.locationId === locationId);
  if (!entry) throw new UserFacingError("That location is not in your library.");
  if (entry.projectId === target.project.id)
    throw new UserFacingError("That location already lives in this project.");
  const sourceSlug = (await repo.listProjects()).find((p) => p.id === entry.projectId)?.slug;
  const source = sourceSlug ? await repo.loadProject(sourceSlug) : null;
  if (!source) throw new UserFacingError("The project that location lives in is not available.");
  const plan = await copyLocationIntoProject(target, source, locationId, await actorId());
  revalidatePath(`/projects/${slug}`, "layout");
  if (str(form, "open") === "1") redirect(`/projects/${slug}/locations?open=${plan.location.id}`);
  const pictures = plan.assets.filter((a) => a.from.objectPath).length;
  return {
    ok: true as const,
    message: `${plan.location.name} added${pictures ? ` with ${pictures} picture${pictures === 1 ? "" : "s"}` : ""}.`,
  };
}

/** Create a location from a description, outside any story: made in the account's library project, saved, opened. */
async function createStandaloneLocation_impl(form: FormData) {
  const prompt = str(form, "prompt").slice(0, LOCATION_PROMPT_MAX);
  if (!prompt) throw new UserFacingError("Describe your location first.");
  const name = (str(form, "name") || locationNameFromPrompt(prompt)).slice(0, LOCATION_NAME_MAX);
  const studio = await characterStudio();
  const repo = await getRepo();
  const location = locationSchema.parse({
    id: randomUUID(),
    projectId: studio.id,
    name,
    description: prompt,
    geography: "",
    zones: [],
    entrances: [],
    lighting: "",
    recurringProps: [],
    referenceAssetIds: [],
    locked: false,
    set3d: null,
  });
  await repo.upsert(studio.id, "locations", location);
  try {
    await repo.setLocationInLibrary(studio.id, location.id, true);
  } catch (err) {
    if (!(err instanceof LocationLibraryUnavailableError)) throw err;
  }
  const filling = await fillAfterCreate(form, studio.slug, "location", location.id);
  revalidatePath("/", "layout");
  return {
    filling,
    slug: studio.slug,
    id: location.id,
    href: `/projects/${studio.slug}/locations?open=${location.id}&new=1#location-${location.id}`,
  };
}

export async function createStandaloneLocation(
  form: FormData,
): Promise<ActionResult & { created?: Created }> {
  let created: Created | undefined;
  const result = await runAction(
    async () => {
      created = await createStandaloneLocation_impl(form);
    },
    { name: "createStandaloneLocation" },
  );
  return result.ok ? { ...result, created } : result;
}

export async function setLocationInLibrary(form: FormData): Promise<ActionResult> {
  return runAction(() => setLocationInLibrary_impl(form), { name: "setLocationInLibrary" });
}

export async function addLocationFromLibrary(form: FormData): Promise<ActionResult> {
  return runAction(() => addLocationFromLibrary_impl(form), { name: "addLocationFromLibrary" });
}

/** What was made: the browser then uploads the chosen photos to it (one request each) and opens `href`. */
/** `filling`: Prism is filling in the details (asked for, at the price shown, on the create box); else why not. */
export type Created = { slug: string; id: string; href: string; filling: true | string | null };

/**
 * "Have Prism fill in the details" from the create box: the same request as the page's own Fill in button, confirmed
 * at the price the box showed (the box prices the longest one it can make, so it covers this one). Creating never
 * fails because of it: if the request is refused, the page still opens and says why on its Fill in panel.
 */
async function fillAfterCreate(
  form: FormData,
  slug: string,
  kind: "character" | "location",
  id: string,
): Promise<true | string | null> {
  if (str(form, "fill") !== "1") return null;
  const f = new FormData();
  f.set("projectSlug", slug);
  f.set(kind === "character" ? "characterId" : "locationId", id);
  f.set("model", str(form, "fillModel"));
  if (str(form, "fillConfirmedUsd")) f.set("confirmedTotalUsd", str(form, "fillConfirmedUsd"));
  const r = await (kind === "character" ? fillCharacter(f) : fillLocation(f));
  return r.ok ? true : r.error;
}

export async function createStandaloneCharacter(
  form: FormData,
): Promise<ActionResult & { created?: Created }> {
  let created: Created | undefined;
  const result = await runAction(
    async () => {
      created = await createStandaloneCharacter_impl(form);
    },
    { name: "createStandaloneCharacter" },
  );
  return result.ok ? { ...result, created } : result;
}

export async function setCharacterInLibrary(form: FormData): Promise<ActionResult> {
  return runAction(() => setInLibrary_impl(form), { name: "setCharacterInLibrary" });
}

export async function addFromLibrary(form: FormData): Promise<ActionResult> {
  return runAction(() => addFromLibrary_impl(form), { name: "addFromLibrary" });
}
