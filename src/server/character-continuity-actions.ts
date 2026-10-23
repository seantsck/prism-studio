"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { CharacterContinuityError } from "@/data/character-continuity-repository";
import { draftCharacterContinuityLock, lockMatchesAssignment } from "@/domain/character-continuity";
import type { ProjectData } from "@/domain/schemas";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { getCharacterContinuityRepo } from "./character-continuity";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * Phase 2G.4 Character Continuity Lock actions. A Lock is an IMMUTABLE approved snapshot of one Character's appearance
 * in one exact Look (or intentionally without one): facts copied by value + the exact stored reference images (reused,
 * never copied). A Shot Character assignment chooses the exact Lock it relies on through ONE selection pointer. None of
 * these actions generates an image or calls a provider, a 3D tool or a GPU.
 *
 *   createCharacterContinuityLock       from the Character page: the Character + a chosen Look (or "no Look")
 *   createLockFromShotAssignment        from Shot Prep: the assignment's current appearance, then selected for it
 *   selectShotCharacterContinuityLock   the assignment relies on a Lock of the same Character and Look (compare-and-set)
 *   clearShotCharacterContinuityLock    the assignment relies on the live library again (compare-and-set)
 *
 * The server re-reads everything: the browser only names ids, never facts, paths or checksums.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

function refresh(slug: string) {
  revalidatePath(`/projects/${slug}`, "layout");
}

/** A repository refusal is a user-correctable message; anything else is a real error. */
function asUserError(err: unknown): never {
  if (err instanceof CharacterContinuityError) throw new UserFacingError(err.message);
  throw err;
}

const createdMessage = (name: string, created: boolean, skipped: number) =>
  (created
    ? `Continuity Lock "${name}" saved.`
    : `That exact appearance is already locked as "${name}"; nothing was duplicated.`) +
  (skipped > 0
    ? ` ${skipped} placeholder or unusable reference${skipped === 1 ? " was" : "s were"} not frozen.`
    : "");

/** Drafts a Lock of `characterId` in `lookId` (null = intentionally no Look) from the CURRENT source library. */
async function draftFrom(data: ProjectData, characterId: string, lookId: string | null, name: string) {
  const character = data.characters.find((c) => c.id === characterId);
  if (!character) throw new UserFacingError("Character not found.");
  const look = lookId ? (data.looks.find((l) => l.id === lookId) ?? null) : null;
  if (lookId && !look) throw new UserFacingError("Look not found.");
  if (look && look.characterId !== character.id)
    throw new UserFacingError("That Look is not one of this Character's Looks.");
  const repo = await getRepo();
  const drafted = draftCharacterContinuityLock({
    id: randomUUID(),
    now: new Date().toISOString(),
    userId: repo.currentUserId(),
    projectId: data.project.id,
    name,
    character,
    look,
    identityRefs: data.identityRefs.filter((r) => r.characterId === character.id),
    assets: data.assets,
  });
  if (!drafted.ok) throw new UserFacingError(drafted.message);
  return drafted;
}

async function createLock_impl(form: FormData): Promise<ActionResult> {
  const data = await requireProjectFresh(str(form, "projectSlug"));
  // "" = the filmmaker chose "No Look" explicitly (recorded intentionally, never inferred)
  const lookChoice = str(form, "lookId");
  if (!form.has("lookId")) throw new UserFacingError("Choose a Look, or choose No Look.");
  const drafted = await draftFrom(data, str(form, "characterId"), lookChoice || null, str(form, "name"));
  try {
    const result = await (await getCharacterContinuityRepo()).create(drafted.draft);
    refresh(data.project.slug);
    return { ok: true, message: createdMessage(result.lock.name, result.created, drafted.skipped.length) };
  } catch (err) {
    return asUserError(err);
  }
}

const expectedOf = (form: FormData) =>
  form.has("expectedSelectedId") ? str(form, "expectedSelectedId") || null : undefined;

async function loadAssignment(form: FormData) {
  const data = await requireProjectFresh(str(form, "projectSlug"));
  const shot = data.shots.find((s) => s.id === str(form, "shotId"));
  if (!shot) throw new UserFacingError("Shot not found.");
  const assignment = shot.characters.find((c) => c.characterId === str(form, "characterId"));
  if (!assignment) throw new UserFacingError("That Character is not assigned to this Shot.");
  return { data, shot, assignment };
}

async function createFromAssignment_impl(form: FormData): Promise<ActionResult> {
  const { data, shot, assignment } = await loadAssignment(form);
  // exactly the assignment's current appearance: its Character and its CURRENT Look (or none)
  const drafted = await draftFrom(data, assignment.characterId, assignment.lookId ?? null, str(form, "name"));
  const repo = await getCharacterContinuityRepo();
  try {
    const result = await repo.create(drafted.draft);
    await repo.selectForAssignment({
      projectId: data.project.id,
      shotId: shot.id,
      characterId: assignment.characterId,
      continuityLockId: result.lock.id,
      userId: (await getRepo()).currentUserId(),
      now: new Date().toISOString(),
      expectedSelectedLockId: expectedOf(form),
    });
    refresh(data.project.slug);
    return {
      ok: true,
      message: `${createdMessage(result.lock.name, result.created, drafted.skipped.length)} Shot ${shot.shotCode} now relies on it.`,
    };
  } catch (err) {
    return asUserError(err);
  }
}

async function select_impl(form: FormData): Promise<ActionResult> {
  const { data, shot, assignment } = await loadAssignment(form);
  const lock = data.characterContinuityLocks?.find((l) => l.id === str(form, "continuityLockId"));
  // the same rule the repository and the database enforce, checked first for a clear message
  if (lock && !lockMatchesAssignment(lock, assignment))
    throw new UserFacingError(
      lock.characterId !== assignment.characterId
        ? "That Continuity Lock belongs to a different Character than this assignment's."
        : "That Continuity Lock was made for a different Look than this Shot assigns.",
    );
  try {
    await (
      await getCharacterContinuityRepo()
    ).selectForAssignment({
      projectId: data.project.id,
      shotId: shot.id,
      characterId: assignment.characterId,
      continuityLockId: str(form, "continuityLockId"),
      userId: (await getRepo()).currentUserId(),
      now: new Date().toISOString(),
      expectedSelectedLockId: expectedOf(form),
    });
    refresh(data.project.slug);
    return { ok: true, message: lock ? `Shot ${shot.shotCode} now relies on "${lock.name}".` : undefined };
  } catch (err) {
    return asUserError(err);
  }
}

async function clear_impl(form: FormData): Promise<ActionResult> {
  const data = await requireProjectFresh(str(form, "projectSlug"));
  const shot = data.shots.find((s) => s.id === str(form, "shotId"));
  if (!shot) throw new UserFacingError("Shot not found.");
  try {
    await (
      await getCharacterContinuityRepo()
    ).clearForAssignment({
      projectId: data.project.id,
      shotId: shot.id,
      characterId: str(form, "characterId"),
      expectedSelectedLockId: expectedOf(form),
    });
    refresh(data.project.slug);
    return {
      ok: true,
      message: "No Continuity Lock: this Character uses its current IdentityRefs and Look.",
    };
  } catch (err) {
    return asUserError(err);
  }
}

export async function createCharacterContinuityLock(form: FormData): Promise<ActionResult> {
  return runAction(() => createLock_impl(form), { name: "createCharacterContinuityLock" });
}
export async function createLockFromShotAssignment(form: FormData): Promise<ActionResult> {
  return runAction(() => createFromAssignment_impl(form), { name: "createLockFromShotAssignment" });
}
export async function selectShotCharacterContinuityLock(form: FormData): Promise<ActionResult> {
  return runAction(() => select_impl(form), { name: "selectShotCharacterContinuityLock" });
}
export async function clearShotCharacterContinuityLock(form: FormData): Promise<ActionResult> {
  return runAction(() => clear_impl(form), { name: "clearShotCharacterContinuityLock" });
}
