"use server";

import { revalidatePath } from "next/cache";
import {
  archiveOf,
  archiveRefusal,
  planArchive,
  subjectKey,
  type ArchiveRecord,
  type ArchiveSubject,
} from "@/domain/archive";
import { hasStoredImage } from "@/domain/generation/subject-image";
import type { Asset, ProjectData } from "@/domain/schemas";
import { runAction, UserFacingError, type ActionResult } from "./action-result";
import { assetDeletionRefusal } from "./asset-deletion";
import { requireUser } from "./auth";
import { discardUpload } from "./ingest-upload";
import { getRepo, requireProjectFresh } from "./repo";

/**
 * The Reference Studio's archive. Archive hides a picture from the Studio and stops it being sent (its plain pointers
 * are lifted out and remembered); Restore puts every pointer back; Delete permanently is offered only from the archive,
 * and only when nothing in the project or in any generation's record depends on the picture.
 */

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const now = () => new Date().toISOString();

async function load(form: FormData) {
  await requireUser();
  const data = await requireProjectFresh(str(form, "projectSlug"));
  const asset = data.assets.find((a) => a.id === str(form, "assetId"));
  if (!asset) throw new UserFacingError("That picture no longer exists.");
  return { data, asset, repo: await getRepo(), slug: data.project.slug };
}

function subjectOf(data: ProjectData, form: FormData): ArchiveSubject {
  const kind = str(form, "subjectKind");
  const id = str(form, "subjectId");
  if (kind === "character" && data.characters.some((c) => c.id === id)) return { kind, id };
  if (kind === "location" && data.locations.some((l) => l.id === id)) return { kind, id };
  throw new UserFacingError("Choose who or where this picture belongs to.");
}

const refresh = (slug: string) => revalidatePath(`/projects/${slug}`, "layout");

async function archive_impl(form: FormData) {
  const { data, asset, repo, slug } = await load(form);
  if (archiveOf(asset)) throw new UserFacingError("That picture is already archived.");
  if (!hasStoredImage(asset)) throw new UserFacingError("Only a stored picture can be archived.");
  const subject = subjectOf(data, form);
  const plan = planArchive(data, subject, asset.id);
  if (!plan.ok) throw new UserFacingError(archiveRefusal(plan.blockers));
  // the record first: if lifting a pointer fails, the picture is still findable in the archive and can be restored
  const record: ArchiveRecord = { at: now(), subject: subjectKey(subject), restore: plan.lift };
  await repo.upsert(data.project.id, "assets", {
    ...asset,
    metadata: { ...asset.metadata, archived: record },
    updatedAt: record.at,
  });
  for (const p of plan.lift) {
    if (p.kind === "identity_ref") await repo.remove(data.project.id, "identityRefs", p.refId);
    else {
      const location = data.locations.find((l) => l.id === p.locationId)!;
      await repo.upsert(data.project.id, "locations", {
        ...location,
        referenceAssetIds: location.referenceAssetIds.filter((id) => id !== asset.id),
      });
    }
  }
  refresh(slug);
}

async function restore_impl(form: FormData) {
  const { data, asset, repo, slug } = await load(form);
  const record = archiveOf(asset);
  if (!record) throw new UserFacingError("That picture is not archived.");
  for (const p of record.restore) {
    if (p.kind === "identity_ref") {
      if (!data.characters.some((c) => c.id === p.characterId)) continue; // the character is gone: nothing to restore to
      if (data.identityRefs.some((r) => r.id === p.refId)) continue;
      await repo.upsert(data.project.id, "identityRefs", {
        id: p.refId,
        characterId: p.characterId,
        slot: p.slot,
        assetId: asset.id,
        label: p.label,
        metadata: p.metadata,
        locked: false,
      });
    } else {
      const location = data.locations.find((l) => l.id === p.locationId);
      if (!location || location.referenceAssetIds.includes(asset.id)) continue;
      if (location.locked)
        throw new UserFacingError(`"${location.name}" is locked. Unlock it before restoring its reference.`);
      await repo.upsert(data.project.id, "locations", {
        ...location,
        referenceAssetIds: [...location.referenceAssetIds, asset.id],
      });
    }
  }
  const { archived: _archived, ...metadata } = asset.metadata as Asset["metadata"] & { archived?: unknown };
  void _archived;
  await repo.upsert(data.project.id, "assets", { ...asset, metadata, updatedAt: now() });
  refresh(slug);
}

async function deleteArchived_impl(form: FormData) {
  const { data, asset, repo, slug } = await load(form);
  if (!archiveOf(asset))
    throw new UserFacingError("Archive the picture first; a picture is deleted only from the archive.");
  if (str(form, "confirm") !== "1") throw new UserFacingError("Confirm that you want to delete it for good.");
  const refusal = await assetDeletionRefusal(data, asset);
  if (refusal) throw new UserFacingError(refusal);
  await repo.remove(data.project.id, "assets", asset.id);
  await discardUpload(asset);
  refresh(slug);
}

export async function archiveStudioImage(form: FormData): Promise<ActionResult> {
  return runAction(() => archive_impl(form), { name: "archiveStudioImage" });
}

export async function restoreStudioImage(form: FormData): Promise<ActionResult> {
  return runAction(() => restore_impl(form), { name: "restoreStudioImage" });
}

export async function deleteArchivedImage(form: FormData): Promise<ActionResult> {
  return runAction(() => deleteArchived_impl(form), { name: "deleteArchivedImage" });
}
