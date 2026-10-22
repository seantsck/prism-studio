import { randomUUID } from "node:crypto";
import type { CreateLocationViewResult, LocationViewRepository } from "@/data/location-view-repository";
import { draftLocationView, type LocationViewSpecInput } from "@/domain/location-view";
import type { Asset, Location } from "@/domain/schemas";
import { UserFacingError } from "./action-result";

/**
 * Persists a Location View for an image that was JUST stored (an upload), leaving no durable broken state:
 *
 *   refused (not an image / bad spec)   → the stored object is removed; nothing was written
 *   the database write fails            → the stored object is removed; the transaction rolled back (no Asset, no view)
 *   an identical view already existed   → that view is returned; the redundant object is removed
 *   success                             → the new private `location_ref` Asset and the view were stored together
 *
 * Cleanup is best effort and idempotent (`discard` never throws). No public URL and no signed URL is created or kept.
 */
export interface LocationViewUploadDeps {
  repo: LocationViewRepository;
  /** removes the stored object (never throws) */
  discard: (asset: Asset) => Promise<void>;
  now?: () => string;
  newId?: () => string;
}

export async function persistUploadedLocationView(
  deps: LocationViewUploadDeps,
  location: Pick<Location, "id" | "projectId" | "zones" | "entrances">,
  asset: Asset,
  spec: LocationViewSpecInput,
  userId: string | null,
): Promise<CreateLocationViewResult> {
  const drafted = draftLocationView({
    id: (deps.newId ?? randomUUID)(),
    now: (deps.now ?? (() => new Date().toISOString()))(),
    userId,
    projectId: location.projectId,
    location,
    asset,
    source: "upload",
    spec,
  });
  if (!drafted.ok) {
    await deps.discard(asset);
    throw new UserFacingError(drafted.message);
  }
  try {
    const result = await deps.repo.create({ draft: drafted.draft, newAsset: asset });
    // an identical view already existed: the new object was never referenced
    if (!result.created) await deps.discard(asset);
    return result;
  } catch (err) {
    await deps.discard(asset);
    throw err;
  }
}
