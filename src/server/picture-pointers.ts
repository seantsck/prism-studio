import "server-only";
import { archiveRefusal, planArchive, type ArchiveSubject, type RestorePointer } from "@/domain/archive";
import type { Asset, ProjectData } from "@/domain/schemas";
import type { Repository } from "@/data/repository";
import { UserFacingError } from "./action-result";
import { assetDeletionRefusal } from "./asset-deletion";

/**
 * The plain pointers a picture is taken out of when it is archived or trashed (a Character's photo slot, a Location's
 * reference), lifted and put back. Shared by the archive and the Trash.
 */

/** Takes the pointers out (they are recorded by the caller first, so a failure here can be undone by Restore). */
export async function liftPointers(
  repo: Repository,
  data: ProjectData,
  assetId: string,
  lift: RestorePointer[],
) {
  for (const p of lift) {
    if (p.kind === "identity_ref") await repo.remove(data.project.id, "identityRefs", p.refId);
    else {
      const location = data.locations.find((l) => l.id === p.locationId)!;
      await repo.upsert(data.project.id, "locations", {
        ...location,
        referenceAssetIds: location.referenceAssetIds.filter((id) => id !== assetId),
      });
    }
  }
}

/** Puts the pointers back, where the Character or Location still exists (a locked Location refuses). */
export async function restorePointers(
  repo: Repository,
  data: ProjectData,
  assetId: string,
  restore: RestorePointer[],
) {
  for (const p of restore) {
    if (p.kind === "identity_ref") {
      if (!data.characters.some((c) => c.id === p.characterId)) continue; // the character is gone: nothing to restore to
      if (data.identityRefs.some((r) => r.id === p.refId)) continue;
      await repo.upsert(data.project.id, "identityRefs", {
        id: p.refId,
        characterId: p.characterId,
        slot: p.slot,
        assetId,
        label: p.label,
        metadata: p.metadata,
        locked: false,
      });
    } else {
      const location = data.locations.find((l) => l.id === p.locationId);
      if (!location || location.referenceAssetIds.includes(assetId)) continue;
      if (location.locked)
        throw new UserFacingError(`"${location.name}" is locked. Unlock it before restoring its reference.`);
      await repo.upsert(data.project.id, "locations", {
        ...location,
        referenceAssetIds: [...location.referenceAssetIds, assetId],
      });
    }
  }
}

/**
 * Whether this picture may leave the project (be deleted, or go to the Trash on its way to being deleted): what it
 * would lift from `subject` (nothing when it is already archived, or has no subject), or the refusal saying what to
 * change first. It is checked as the project will be once those pointers are lifted.
 */
export async function removalPlan(
  data: ProjectData,
  asset: Asset,
  subject: ArchiveSubject | null,
  alreadyLifted: boolean,
  verb: "deleted" | "moved to the Trash",
): Promise<RestorePointer[]> {
  let lift: RestorePointer[] = [];
  if (subject && !alreadyLifted) {
    const plan = planArchive(data, subject, asset.id);
    if (!plan.ok)
      throw new UserFacingError(archiveRefusal(plan.blockers, "deleted").replace("deleted", verb));
    lift = plan.lift;
  }
  const refs = new Set(lift.flatMap((p) => (p.kind === "identity_ref" ? [p.refId] : [])));
  const locs = new Set(lift.flatMap((p) => (p.kind === "location_ref" ? [p.locationId] : [])));
  const after: ProjectData = {
    ...data,
    identityRefs: data.identityRefs.filter((r) => !refs.has(r.id)),
    locations: data.locations.map((l) =>
      locs.has(l.id) ? { ...l, referenceAssetIds: l.referenceAssetIds.filter((id) => id !== asset.id) } : l,
    ),
  };
  const refusal = await assetDeletionRefusal(after, asset);
  if (refusal)
    throw new UserFacingError(
      refusal
        .replace("This asset", subject ? "This picture" : "This asset")
        .replace("can't be deleted", `can't be ${verb}`),
    );
  return lift;
}
