import "server-only";
import { archiveOf, type ArchiveSubject } from "@/domain/archive";
import type { Asset, Project, ProjectData } from "@/domain/schemas";
import { trashedAssetsOf, trashExpired, trashOf, type TrashRecord } from "@/domain/trash";
import { assetDeletionRefusal } from "./asset-deletion";
import { discardUpload } from "./ingest-upload";
import { liftPointers, removalPlan } from "./picture-pointers";
import { getRepo } from "./repo";

/**
 * Moves one asset to the Trash: refused (with what to change first) unless it could be deleted; its plain pointers on
 * `subject` (a photo slot, a location reference) are lifted and remembered for Restore.
 */
export async function moveAssetToTrash(data: ProjectData, asset: Asset, subject: ArchiveSubject | null) {
  const repo = await getRepo();
  const lift = await removalPlan(data, asset, subject, !!archiveOf(asset), "moved to the Trash");
  // the record first: if lifting a pointer fails, the asset is still in the Trash and Restore puts back what moved
  const record: TrashRecord = {
    at: new Date().toISOString(),
    subject: subject ? `${subject.kind}:${subject.id}` : null,
    restore: lift,
  };
  await repo.upsert(data.project.id, "assets", {
    ...asset,
    metadata: { ...asset.metadata, trashed: record },
    updatedAt: record.at,
  });
  await liftPointers(repo, data, asset.id, lift);
}

/**
 * Removes trashed assets for good: the row, then the stored bytes. Each is checked again first (nothing may depend on
 * it); one that is still needed stays in the Trash with the reason.
 */
export async function purgeTrashed(
  data: ProjectData,
  assets: readonly Asset[],
): Promise<{ removed: number; kept: Array<{ assetId: string; reason: string }> }> {
  const repo = await getRepo();
  let removed = 0;
  const kept: Array<{ assetId: string; reason: string }> = [];
  for (const asset of assets) {
    const refusal = await assetDeletionRefusal(data, asset);
    if (refusal) {
      kept.push({ assetId: asset.id, reason: refusal.replace("This asset", "This item") });
      continue;
    }
    await repo.remove(data.project.id, "assets", asset.id);
    await discardUpload(asset);
    removed++;
  }
  return { removed, kept };
}

/**
 * Removes what has been in the project's Trash for 30 days: called when the project (or its Trash) is opened, in the
 * owner's own request, so it needs no privileged worker. Best-effort: a failure never stops the page.
 */
export async function purgeExpiredTrash(data: ProjectData, now = new Date().toISOString()): Promise<number> {
  const expired = trashedAssetsOf(data).filter((a) => trashExpired(trashOf(a)!.at, now));
  if (!expired.length) return 0;
  try {
    return (await purgeTrashed(data, expired)).removed;
  } catch {
    return 0;
  }
}

/**
 * Deletes a project (in the Trash) for good: refused while anything for it is still queued or running (a paid
 * generation must never finish into a project that is gone). Its stored files go after the rows, best effort (an
 * orphaned file is harmless). Returns why it was refused, or null.
 */
export async function deleteProjectForGood(project: Project): Promise<string | null> {
  const repo = await getRepo();
  const active = await repo.activeProjectWork(project.id);
  if (active.length > 0)
    return `"${project.title}" still has work in progress (${active.join(", ")}). Wait for it to finish or cancel it, then delete.`;
  const data = await repo.loadProject(project.slug, { includeTrashed: true });
  const files = [...(data?.assets ?? [])].filter((a) => a.objectPath);
  await repo.deleteProject(project.id);
  for (let i = 0; i < files.length; i += 10) await Promise.all(files.slice(i, i + 10).map(discardUpload));
  return null;
}

/** Deletes for good every project 30 days in the Trash (when the Projects page is opened, in the owner's request). */
export async function purgeExpiredProjects(now = new Date().toISOString()): Promise<number> {
  const repo = await getRepo();
  let n = 0;
  try {
    for (const t of (await repo.trashedProjects()).projects)
      if (trashExpired(t.trashedAt, now) && !(await deleteProjectForGood(t.project))) n++;
  } catch {
    // best effort: the page never fails for it
  }
  return n;
}
