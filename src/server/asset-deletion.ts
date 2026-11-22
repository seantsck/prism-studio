import "server-only";
import { findAssetUsage } from "@/domain/asset-usage";
import type { Asset, ProjectData } from "@/domain/schemas";
import { getMediaQaRepo } from "./media-qa";
import { getPrevisRepo } from "./previs";
import { getStoryRepo } from "./story";

/**
 * Why an Asset can't be deleted permanently, or null when nothing depends on it. One rule for every place that
 * deletes (the Assets library, the Reference Studio's archive, the Trash): nothing is ever silently orphaned. A
 * generation's own result may go (its attempt is kept, with its cost, and no output), and so may a picture a
 * generation was SENT (its record then shows "Picture deleted" for that input).
 */
export async function assetDeletionRefusal(data: ProjectData, asset: Asset): Promise<string | null> {
  const usage = findAssetUsage(data, asset.id);
  if (usage.inUse)
    return `This asset is in use and can't be deleted: ${usage.direct
      .slice(0, 3)
      .map((u) => u.label)
      .join("; ")}${usage.direct.length > 3 ? ` and ${usage.direct.length - 3} more` : ""}.`;
  // A spatial control-pass bundle is immutable historical truth: its machine assets cannot be removed.
  if (await (await getPrevisRepo()).spatialPassUsesAsset(asset.id))
    return "This asset can't be deleted: it belongs to a spatial control-pass bundle.";
  // A Location's spatial reconstruction (a Gaussian splat and the reference images it was built from) is origin truth.
  if (await (await getPrevisRepo()).reconstructionUsesAsset(asset.id))
    return "This asset can't be deleted: it belongs to a spatial reconstruction of a location.";
  // Derived-media lineage and QA history also pin an asset: nothing is orphaned silently. A picture a generation was
  // SENT (a take's input) does not: the creator chose that it may go, and the take's record then shows "Picture
  // deleted" in its place (the attempt keeps the id; there is no key to break).
  const pins = await (await getMediaQaRepo()).assetPins(asset.id);
  if (pins.length > 0) return `This asset can't be deleted: ${pins.join("; ")}.`;
  // Phase 5B-S1: an uploaded screenplay that a Production Proposal was made from is its immutable source
  if (await (await getStoryRepo({ startInlineWorker: false })).usesAsset(asset.id))
    return "This asset can't be deleted: it is the source of a Story proposal.";
  return null;
}
