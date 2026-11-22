"use server";

import { revalidatePath } from "next/cache";
import type { ArchiveSubject } from "@/domain/archive";
import { hasStoredImage } from "@/domain/generation/subject-image";
import type { Asset, ProjectData } from "@/domain/schemas";
import { isTrashed, trashedAssetsOf, trashOf } from "@/domain/trash";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { requireUser } from "./auth";
import { restorePointers } from "./picture-pointers";
import { getRepo, requireProjectFresh } from "./repo";
import { moveAssetToTrash, purgeTrashed } from "./trash";

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
  const { removed, kept } = await purgeTrashed(data, trashedAssetsOf(data));
  refresh(slug);
  return {
    ok: true as const,
    message: kept.length
      ? `${removed} deleted; ${kept.length} kept (something depends on ${kept.length === 1 ? "it" : "them"}).`
      : `${removed} deleted.`,
  };
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
