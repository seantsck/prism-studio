"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ArchiveSubject } from "@/domain/archive";
import { hasStoredImage } from "@/domain/generation/subject-image";
import type { Asset, ProjectData } from "@/domain/schemas";
import { isTrashed, trashedAssetsOf, trashOf } from "@/domain/trash";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { restorePointers } from "./picture-pointers";
import { getRepo, requireProjectFresh } from "./repo";
import {
  deleteSubjectForGood,
  moveAssetToTrash,
  needsMigration0064,
  purgeTrashed,
  setSubjectTrashed,
  type TrashSubjectKind,
} from "./trash";
import { characterUsage, inUseRefusal, locationUsage } from "@/domain/subject-trash";

/**
 * The Trash (src/domain/trash.ts): Delete moves a picture, a take or an asset file here; Restore puts it back where it
 * was; Delete now and Empty trash remove for good (after a confirmation). Anything left 30 days is removed on its own.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const now = () => new Date().toISOString();
const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");

async function load(form: FormData) {
  await requireUser();
  const data = await requireProjectFresh(str(form, "projectSlug"));
  return { data, repo: await getRepo(), slug: data.project.slug };
}

function subjectOf(data: ProjectData, form: FormData): ArchiveSubject | null {
  const kind = str(form, "subjectKind");
  const id = str(form, "subjectId");
  if (!kind) return null;
  if (kind === "character" && data.characters.some((c) => c.id === id)) return { kind, id };
  if (kind === "location" && data.locations.some((l) => l.id === id)) return { kind, id };
  throw new UserFacingError("Choose who or where this picture belongs to.");
}

/** Move to the Trash: a picture of a Character or Location (its photo slot goes with it), a take, or an asset file. */
async function trash_impl(form: FormData) {
  const { data, slug } = await load(form);
  const asset = data.assets.find((a) => a.id === str(form, "assetId") && !isTrashed(a));
  if (!asset) throw new UserFacingError("That picture no longer exists, or is already in the Trash.");
  const subject = subjectOf(data, form);
  if (subject && !hasStoredImage(asset))
    throw new UserFacingError("Only a stored picture can be deleted here.");
  await moveAssetToTrash(data, asset, subject);
  refresh(slug);
}

const trashedOf = (data: ProjectData, id: string): Asset => {
  const asset = trashedAssetsOf(data).find((a) => a.id === id);
  if (!asset) throw new UserFacingError("That item is not in the Trash.");
  return asset;
};

async function restore_impl(form: FormData) {
  const { data, repo, slug } = await load(form);
  const asset = trashedOf(data, str(form, "assetId"));
  await restorePointers(repo, data, asset.id, trashOf(asset)!.restore);
  const { trashed: _t, ...metadata } = asset.metadata as Asset["metadata"] & { trashed?: unknown };
  void _t;
  await repo.upsert(data.project.id, "assets", { ...asset, metadata, updatedAt: now() });
  refresh(slug);
}

async function deleteNow_impl(form: FormData) {
  const { data, slug } = await load(form);
  if (str(form, "confirm") !== "1") throw new UserFacingError("Confirm that you want to delete it for good.");
  const asset = trashedOf(data, str(form, "assetId"));
  const { kept } = await purgeTrashed(data, [asset]);
  if (kept.length) throw new UserFacingError(kept[0]!.reason);
  refresh(slug);
}

async function empty_impl(form: FormData) {
  const { data, slug } = await load(form);
  if (str(form, "confirm") !== "1") throw new UserFacingError("Confirm that you want to empty the Trash.");
  // Characters and Locations first (their pictures may be in the Trash too), then pictures and files
  let gone = 0;
  const held: string[] = [];
  for (const [kind, list] of [
    ["character", data.trashedCharacters ?? []],
    ["location", data.trashedLocations ?? []],
  ] as const)
    for (const x of list) {
      const refusal = await deleteSubjectForGood(slug, kind, x.id);
      if (refusal) held.push(refusal);
      else gone++;
    }
  const fresh = gone ? await requireProjectFresh(slug) : data;
  const result = await purgeTrashed(fresh, trashedAssetsOf(fresh));
  const removed = result.removed + gone;
  const kept = [...result.kept, ...held];
  refresh(slug);
  return {
    ok: true as const,
    message: kept.length
      ? `${removed} deleted; ${kept.length} kept (something depends on ${kept.length === 1 ? "it" : "them"}).`
      : `${removed} deleted.`,
  };
}

// ───────── Characters and Locations ─────────

const kindOf = (form: FormData): TrashSubjectKind => {
  const k = str(form, "kind");
  if (k !== "character" && k !== "location") throw new UserFacingError("Choose a character or a location.");
  return k;
};

async function withMigration<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (needsMigration0064(err)) throw new UserFacingError((err as Error).message);
    throw err;
  }
}

/** Delete a Character or Location: to the Trash, refused while the story still uses it (with where). */
async function trashSubject_impl(form: FormData) {
  const { data, slug } = await load(form);
  const kind = kindOf(form);
  const id = str(form, "id");
  const subject =
    kind === "character" ? data.characters.find((c) => c.id === id) : data.locations.find((l) => l.id === id);
  if (!subject) throw new UserFacingError("That is not in this project, or it is already in the Trash.");
  if (kind === "location" && (subject as { locked: boolean }).locked)
    throw new UserFacingError(`"${subject.name}" is locked. Unlock it before deleting it.`);
  const usage = kind === "character" ? characterUsage(data, id) : locationUsage(data, id);
  if (usage.length) throw new UserFacingError(inUseRefusal(subject.name, usage));
  await withMigration(() => setSubjectTrashed(data, kind, id, now()));
  refresh(slug);
  redirect(`/projects/${slug}/${kind === "character" ? "characters" : "locations"}`);
}

async function restoreSubject_impl(form: FormData) {
  const { data, slug } = await load(form);
  const kind = kindOf(form);
  const id = str(form, "id");
  const list = kind === "character" ? (data.trashedCharacters ?? []) : (data.trashedLocations ?? []);
  if (!list.some((x) => x.id === id)) throw new UserFacingError("That is not in the Trash.");
  await withMigration(() => setSubjectTrashed(data, kind, id, null));
  refresh(slug);
}

async function deleteSubjectNow_impl(form: FormData) {
  const { data, slug } = await load(form);
  if (str(form, "confirm") !== "1") throw new UserFacingError("Confirm that you want to delete it for good.");
  const kind = kindOf(form);
  const id = str(form, "id");
  const list = kind === "character" ? (data.trashedCharacters ?? []) : (data.trashedLocations ?? []);
  if (!list.some((x) => x.id === id)) throw new UserFacingError("That is not in the Trash.");
  const refusal = await deleteSubjectForGood(slug, kind, id);
  if (refusal) throw new UserFacingError(refusal);
  refresh(slug);
}

export async function trashSubject(form: FormData): Promise<ActionResult> {
  return runAction(() => trashSubject_impl(form), { name: "trashSubject" });
}

export async function restoreSubject(form: FormData): Promise<ActionResult> {
  return runAction(() => restoreSubject_impl(form), { name: "restoreSubject" });
}

export async function deleteSubjectNow(form: FormData): Promise<ActionResult> {
  return runAction(() => deleteSubjectNow_impl(form), { name: "deleteSubjectNow" });
}

export async function moveToTrash(form: FormData): Promise<ActionResult> {
  return runAction(() => trash_impl(form), { name: "moveToTrash" });
}

export async function restoreFromTrash(form: FormData): Promise<ActionResult> {
  return runAction(() => restore_impl(form), { name: "restoreFromTrash" });
}

export async function deleteFromTrash(form: FormData): Promise<ActionResult> {
  return runAction(() => deleteNow_impl(form), { name: "deleteFromTrash" });
}

export async function emptyTrash(form: FormData): Promise<ActionResult> {
  return runAction(() => empty_impl(form), { name: "emptyTrash" });
}
