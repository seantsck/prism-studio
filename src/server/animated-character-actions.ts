"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { MAX_ART_STYLE_CHARS } from "@/domain/generation/subject-image";
import { characterSchema, type Character } from "@/domain/schemas";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { keepInLibrary } from "./character-library";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * Animated Characters made from real ones (migration 0070). "Create animated character" copies a Character into a new
 * one drawn in the art style the creator writes, taking its likeness from the real Character's photos; the real
 * Character and its pictures are never changed. Nothing is generated here (free): the new Character's views are made
 * from its page, priced and confirmed as always.
 */
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const NEEDS_0070 =
  "Animated actors need a one-time database update (migration 0070) that has not been applied yet.";
const UNDEFINED_COLUMN = "42703";

async function save(projectId: string, character: Character) {
  try {
    await (await getRepo()).upsert(projectId, "characters", character);
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_COLUMN) throw new UserFacingError(NEEDS_0070);
    throw err;
  }
}

async function createAnimatedCharacter_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const source = data.characters.find((c) => c.id === str(form, "characterId") && !c.trashedAt);
  if (!source) throw new UserFacingError("That actor is not in this project.");
  const style = str(form, "style").slice(0, MAX_ART_STYLE_CHARS);
  if (!style) throw new UserFacingError("Say what style to draw them in, for example anime.");
  const at = new Date().toISOString();
  const character = characterSchema.parse({
    id: randomUUID(),
    projectId: data.project.id,
    name: `${source.name} (${style.length > 40 ? `${style.slice(0, 39)}…` : style})`,
    role: source.role,
    description: source.description,
    personality: source.personality,
    behaviorNotes: source.behaviorNotes,
    physicalDescription: source.physicalDescription,
    continuityRules: source.continuityRules,
    signatureBehavior: source.signatureBehavior,
    relationshipNotes: source.relationshipNotes,
    ...(source.partSize !== undefined ? { partSize: source.partSize } : {}),
    artStyle: style,
    // the real person: an animated copy of an animated Character still takes its likeness from the real one
    likenessFromId: source.likenessFromId ?? source.id,
    createdAt: at,
    updatedAt: at,
  });
  await save(data.project.id, character);
  await keepInLibrary(data.project.id, [character.id]);
  revalidatePath(`/projects/${slug}`, "layout");
  redirect(`/projects/${slug}/characters/${character.id}`);
}

/** Change the style an animated Character is drawn in (empty: drawn as photographs). New pictures only. */
async function setArtStyle_impl(form: FormData) {
  const slug = str(form, "projectSlug");
  await requireUser();
  const data = await requireProjectFresh(slug);
  const character = data.characters.find((c) => c.id === str(form, "characterId"));
  if (!character) throw new UserFacingError("That actor is not in this project.");
  const style = str(form, "style").slice(0, MAX_ART_STYLE_CHARS);
  await save(data.project.id, { ...character, artStyle: style || null, updatedAt: new Date().toISOString() });
  revalidatePath(`/projects/${slug}`, "layout");
  return {
    ok: true as const,
    message: style
      ? `New pictures of ${character.name} are drawn as ${style}.`
      : `New pictures of ${character.name} are photographs again.`,
  };
}

export async function createAnimatedCharacter(form: FormData): Promise<ActionResult> {
  return runAction(() => createAnimatedCharacter_impl(form), { name: "createAnimatedCharacter" });
}

export async function setArtStyle(form: FormData): Promise<ActionResult> {
  return runAction(() => setArtStyle_impl(form), { name: "setArtStyle" });
}
