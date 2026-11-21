import { findAssetUsage } from "./asset-usage";
import { locationBibleOf } from "./location-visual-bible";
import type { Asset, IdentityRef, ProjectData } from "./schemas";
import { visualRoleOf } from "./visual-bible";

/**
 * Archiving a picture in the Reference Studio: it leaves the Studio's lists and is no longer sent with anything, and
 * Restore puts it back exactly as it was. Nothing is deleted. The record lives in the Asset's own `metadata.archived`
 * (no schema change): who it was archived from, and every plain pointer that was taken away so Restore can put it back.
 *
 * Plain pointers (an extra reference photo of a Character, a Location's reference photo) are lifted out with the
 * picture. Anything that gives the picture a JOB is never undone silently: a view of the reference set, the canonical
 * identity, a Look's picture, a Location's designation, or a use in a Shot. Those block archiving and are named, so
 * the creator changes that first.
 */

export type ArchiveSubject = { kind: "character" | "location"; id: string };

export type RestorePointer =
  | {
      kind: "identity_ref";
      refId: string;
      characterId: string;
      slot: IdentityRef["slot"];
      label: string;
      metadata: Record<string, unknown>;
    }
  | { kind: "location_ref"; locationId: string };

export interface ArchiveRecord {
  at: string;
  /** "character:<id>" | "location:<id>": whose archive it shows in. */
  subject: string;
  restore: RestorePointer[];
}

export const subjectKey = (s: ArchiveSubject) => `${s.kind}:${s.id}`;

export function archiveOf(asset: Asset | undefined | null): ArchiveRecord | null {
  const r = (asset?.metadata as { archived?: unknown } | undefined)?.archived;
  if (!r || typeof r !== "object") return null;
  const rec = r as Partial<ArchiveRecord>;
  return typeof rec.subject === "string" && typeof rec.at === "string"
    ? { at: rec.at, subject: rec.subject, restore: Array.isArray(rec.restore) ? rec.restore : [] }
    : null;
}

export const isArchived = (asset: Asset | undefined | null) => archiveOf(asset) !== null;

/** A Character reference that only says "this is a photo of them": no view, no canonical role, no designation. */
export function isPlainPhotoRef(ref: IdentityRef): boolean {
  const view = (ref.metadata as { view?: unknown }).view;
  return ref.slot === "additional" && visualRoleOf(ref) === null && view === undefined;
}

export interface ArchivePlan {
  ok: boolean;
  /** Why it can't be archived yet (each a job the picture does), when !ok. */
  blockers: string[];
  /** The plain pointers lifted out with it (and put back on Restore). */
  lift: RestorePointer[];
}

/** What archiving this picture from this subject would do, or why it can't yet. Pure. */
export function planArchive(data: ProjectData, subject: ArchiveSubject, assetId: string): ArchivePlan {
  const blockers: string[] = [];
  const lift: RestorePointer[] = [];
  if (subject.kind === "character") {
    const character = data.characters.find((c) => c.id === subject.id);
    const name = character?.name ?? "This character";
    for (const ref of data.identityRefs) {
      if (ref.assetId !== assetId) continue;
      const theirs = ref.characterId === subject.id;
      if (theirs && isPlainPhotoRef(ref)) {
        if (ref.locked) blockers.push(`it is one of ${name}'s locked references (unlock them first)`);
        else
          lift.push({
            kind: "identity_ref",
            refId: ref.id,
            characterId: ref.characterId,
            slot: ref.slot,
            label: ref.label,
            metadata: ref.metadata,
          });
      } else {
        const who = theirs
          ? name
          : (data.characters.find((c) => c.id === ref.characterId)?.name ?? "another character");
        const role =
          visualRoleOf(ref) === "canonical"
            ? "canonical identity"
            : `${ref.label || ref.slot.replace("_", " ")}`;
        blockers.push(`it is ${who}'s ${role.toLowerCase()} (take it out of the reference set first)`);
      }
    }
  } else {
    const location = data.locations.find((l) => l.id === subject.id);
    for (const l of data.locations) {
      const bible = locationBibleOf(l);
      if (bible.canonicalAssetId === assetId || bible.entries.some((e) => e.assetId === assetId))
        blockers.push(`it is a designated view of "${l.name}" (clear that first)`);
      if (l.referenceAssetIds.includes(assetId)) {
        if (l.id !== subject.id) blockers.push(`it is a reference of "${l.name}"`);
        else if (l.locked) blockers.push(`"${l.name}" is locked (unlock it first)`);
        else lift.push({ kind: "location_ref", locationId: l.id });
      }
    }
    if (!location) blockers.push("that location no longer exists");
  }
  for (const look of data.looks)
    if (look.referenceAssetIds.includes(assetId)) {
      const who = data.characters.find((c) => c.id === look.characterId)?.name ?? "a character";
      blockers.push(`it is the picture of ${who}'s Look "${look.name}" (change the Look's picture first)`);
    }
  // every other job in the project (Shots, frames, continuity locks…); a generation's own record is not a job
  const handled = new Set([
    "identity_ref",
    "look_ref",
    "location_ref",
    "location_visual_bible",
    "attempt_input",
    "attempt_output",
  ]);
  for (const u of findAssetUsage(data, assetId).direct)
    if (!handled.has(u.kind)) blockers.push(`it is used by ${u.label}`);
  return { ok: blockers.length === 0, blockers: [...new Set(blockers)], lift };
}

/** One sentence for a refused archive. */
export const archiveRefusal = (blockers: string[]) =>
  `This picture can't be archived yet: ${blockers.slice(0, 3).join("; ")}${blockers.length > 3 ? ` and ${blockers.length - 3} more` : ""}.`;
