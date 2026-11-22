import type { Asset, Location, ProjectData } from "./schemas";

/**
 * The account's location library (the twin of the character library): a Location saved from one of the creator's
 * projects (or made on its own) is copied into another of theirs as an independent copy: new ids, and a copy of every
 * picture it uses (its reference photos and its Visual Bible: canonical picture, establishing views, plates, variants)
 * in the target project's own storage. Archived or trashed pictures stay behind; the 3D set, views and locks belong to
 * the source project's Shots and stay there.
 */

export interface LocationCopyPlan {
  location: Location;
  /** Each picture to copy: the source asset and the new one (its object path set by the caller). */
  assets: Array<{ from: Asset; to: Asset }>;
}

const gone = (a: Asset) => {
  const m = a.metadata as { archived?: unknown; trashed?: unknown };
  return !!m.archived || !!m.trashed;
};

/** A name the target project does not use yet: the same name, else "Name (2)", "Name (3)" … */
export function freeLocationName(name: string, taken: ReadonlyArray<{ name: string }>): string {
  const used = new Set(taken.map((l) => l.name.trim().toLowerCase()));
  if (!used.has(name.trim().toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const next = `${name} (${n})`;
    if (!used.has(next.toLowerCase())) return next;
  }
}

/** Everything to write to copy `locationId` from `source` into `target`. Pure. */
export function planLocationCopy(
  source: ProjectData,
  locationId: string,
  target: ProjectData,
  newId: () => string,
  now: string,
): LocationCopyPlan {
  const original = source.locations.find((l) => l.id === locationId);
  if (!original) throw new Error(`Location ${locationId} is not in ${source.project.title}`);
  const byId = new Map(source.assets.map((a) => [a.id, a]));
  const copied = new Map<string, Asset>();
  const assets: LocationCopyPlan["assets"] = [];
  const asset = (id: string | null | undefined): string | null => {
    if (!id) return null;
    const done = copied.get(id);
    if (done) return done.id;
    const from = byId.get(id);
    if (!from || gone(from)) return null;
    const metadata = { ...from.metadata, copiedFrom: { projectId: source.project.id, assetId: from.id } };
    const to: Asset = {
      ...from,
      id: newId(),
      projectId: target.project.id,
      objectPath: null,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
    copied.set(id, to);
    assets.push({ from, to });
    return to.id;
  };
  const bible = original.visualBible ?? {};
  const location: Location = {
    ...original,
    id: newId(),
    projectId: target.project.id,
    name: freeLocationName(original.name, target.locations),
    referenceAssetIds: original.referenceAssetIds.map(asset).filter((x): x is string => !!x),
    visualBible: {
      canonicalAssetId: asset(bible.canonicalAssetId ?? null),
      entries: (bible.entries ?? []).flatMap((e) => {
        const id = asset(e.assetId);
        return id ? [{ ...e, assetId: id }] : [];
      }),
    },
    // the 3D set lives with the source project's Shots; the copy starts without one, unlocked
    set3d: null,
    locked: false,
    trashedAt: undefined,
  };
  return { location, assets };
}
