import "server-only";
import { archiveOf, type ArchiveSubject } from "@/domain/archive";
import { characterUsage, inUseRefusal, locationUsage } from "@/domain/subject-trash";
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
  const subjects = await purgeExpiredSubjects(data, now);
  const expired = trashedAssetsOf(data).filter((a) => trashExpired(trashOf(a)!.at, now));
  if (!expired.length) return subjects;
  try {
    return subjects + (await purgeTrashed(data, expired)).removed;
  } catch {
    return subjects;
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

// ───────── Characters and Locations (migration 0064) ─────────

export type TrashSubjectKind = "character" | "location";

const UNDEFINED_COLUMN = "42703";
const NEEDS_0064 =
  "Deleting characters and locations (to the Trash) needs a one-time database update (migration 0064) that has not been applied yet.";

/**
 * Stamps (or clears) a Character's or Location's place in the Trash; nothing else about it changes, except the merge
 * link: a merge sends the merged Character here with `mergedIntoId` (the Character kept), and a restore clears it (the
 * Character is its own again). Before migration 0068 the link is not stored: the Character still goes to the Trash.
 */
export async function setSubjectTrashed(
  data: ProjectData,
  kind: TrashSubjectKind,
  id: string,
  trashedAt: string | null,
  opts: { mergedIntoId?: string } = {},
): Promise<void> {
  const repo = await getRepo();
  try {
    if (kind === "character") {
      const c = [...data.characters, ...(data.trashedCharacters ?? [])].find((x) => x.id === id)!;
      const mergedIntoId =
        trashedAt === null ? (c.mergedIntoId ? null : c.mergedIntoId) : (opts.mergedIntoId ?? c.mergedIntoId);
      try {
        await repo.upsert(data.project.id, "characters", { ...c, trashedAt, mergedIntoId });
      } catch (err) {
        if ((err as { code?: string }).code !== UNDEFINED_COLUMN || mergedIntoId === undefined) throw err;
        await repo.upsert(data.project.id, "characters", { ...c, trashedAt, mergedIntoId: undefined });
      }
    } else {
      const l = [...data.locations, ...(data.trashedLocations ?? [])].find((x) => x.id === id)!;
      await repo.upsert(data.project.id, "locations", { ...l, trashedAt });
    }
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_COLUMN) throw new Error(NEEDS_0064, { cause: err });
    throw err;
  }
}

export const needsMigration0064 = (err: unknown) => err instanceof Error && err.message === NEEDS_0064;

/**
 * Deletes a trashed Character or Location for good (what hangs off a Character first: its references, Looks and
 * voices; the database's own keys take the rest). Refused, and kept in the Trash, while the story uses it again.
 */
export async function deleteSubjectForGood(
  slug: string,
  kind: TrashSubjectKind,
  id: string,
): Promise<string | null> {
  const repo = await getRepo();
  const all = await repo.loadProject(slug); // everything, trashed or not
  if (!all) return "That project no longer exists.";
  const usage = kind === "character" ? characterUsage(all, id) : locationUsage(all, id);
  const name = (kind === "character" ? all.characters : all.locations).find((x) => x.id === id)?.name ?? "It";
  if (usage.length) return inUseRefusal(name, usage);
  if (kind === "character") {
    for (const v of all.voiceProfiles.filter((x) => x.characterId === id))
      await repo.remove(all.project.id, "voiceProfiles", v.id);
    for (const l of all.looks.filter((x) => x.characterId === id))
      await repo.remove(all.project.id, "looks", l.id);
    for (const r of all.identityRefs.filter((x) => x.characterId === id))
      await repo.remove(all.project.id, "identityRefs", r.id);
    await repo.remove(all.project.id, "characters", id);
  } else await repo.remove(all.project.id, "locations", id);
  return null;
}

/** Deletes for good the project's Characters and Locations 30 days in the Trash (best effort, in the owner's request). */
export async function purgeExpiredSubjects(
  data: ProjectData,
  now = new Date().toISOString(),
): Promise<number> {
  let n = 0;
  const due = [
    ...(data.trashedCharacters ?? []).map((c) => ["character", c] as const),
    ...(data.trashedLocations ?? []).map((l) => ["location", l] as const),
  ].filter(([, x]) => x.trashedAt && trashExpired(x.trashedAt, now));
  for (const [kind, x] of due) {
    try {
      if (!(await deleteSubjectForGood(data.project.slug, kind, x.id))) n++;
    } catch {
      // best effort: the page never fails for it
    }
  }
  return n;
}
