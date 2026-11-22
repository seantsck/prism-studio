import type { RestorePointer } from "./archive";
import type { Asset } from "./schemas";

/**
 * The Trash. Deleting a picture, a take or an asset file moves it here instead of removing it: it disappears from every
 * view (the project loaders set trashed assets apart), keeps its bytes, and can be restored (its plain pointers, such
 * as a photo slot or a location reference, are put back) for TRASH_DAYS days. After that it is removed for good, the
 * next time its project or the Trash is opened; "Delete now" and "Empty trash" do it at once. A picture can go to the
 * Trash only when it could be deleted (nothing in the project or any generation's record depends on it), so removing
 * it later never orphans anything.
 */

export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Kept on a trashed asset as `metadata.trashed`. */
export interface TrashRecord {
  at: string;
  /** "character:<id>" / "location:<id>" when it was trashed from a subject's pictures; null from the Assets library. */
  subject: string | null;
  /** The plain pointers lifted out with it, put back on Restore. */
  restore: RestorePointer[];
}

export function trashOf(asset: Pick<Asset, "metadata">): TrashRecord | null {
  const t = (asset.metadata as { trashed?: unknown }).trashed;
  return t && typeof t === "object" && typeof (t as TrashRecord).at === "string" ? (t as TrashRecord) : null;
}

export const isTrashed = (asset: Pick<Asset, "metadata">) => trashOf(asset) !== null;

/** When something trashed at `at` is removed for good. */
export const trashExpiry = (at: string) => new Date(Date.parse(at) + TRASH_DAYS * DAY_MS).toISOString();

/** Whole days left before removal (0 = today or overdue). */
export function trashDaysLeft(at: string, now: string): number {
  return Math.max(0, Math.ceil((Date.parse(trashExpiry(at)) - Date.parse(now)) / DAY_MS));
}

export const trashExpired = (at: string, now: string) => Date.parse(now) >= Date.parse(trashExpiry(at));

/** Splits a project's assets into the live ones (what every view sees) and the trashed ones (the Trash). */
export function splitTrashed(assets: readonly Asset[]): { live: Asset[]; trashed: Asset[] } {
  const live: Asset[] = [];
  const trashed: Asset[] = [];
  for (const a of assets) (isTrashed(a) ? trashed : live).push(a);
  return { live, trashed };
}

/** The project's trashed assets, whether or not the loader has set them apart yet. */
export const trashedAssetsOf = (data: { assets: readonly Asset[]; trashedAssets?: Asset[] }): Asset[] => [
  ...(data.trashedAssets ?? []),
  ...data.assets.filter(isTrashed),
];
