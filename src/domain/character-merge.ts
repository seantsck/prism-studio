import { hasStoredImage } from "./generation/subject-image";
import type { Character, IdentityRef, ProjectData } from "./schemas";
import { characterUsage } from "./subject-trash";
import { visualRoleOf } from "./visual-bible";

/**
 * Merging two Characters of one project that are the same person (one written from the script, one made on its own):
 * the one the story uses is KEPT (its Shots, Scenes, lines and Locks keep working); the other is merged into it and
 * then moved to the Trash, where it can be restored.
 *
 * Nothing is copied and nothing is deleted. Pictures move by moving their reference pointers:
 *   - a view slot, the canonical identity and the cutout hold one picture each. Where only one side has a picture, it
 *     ends up on the kept Character; where both have one, `prefer` decides, and the other picture's pointer moves to
 *     the merged Character, so it goes to the Trash with it (restorable), never lost;
 *   - every other reference (the creator's photos, expressions, extra pictures) moves to the kept Character;
 *   - Looks and voice profiles move.
 * The sheet: the name chosen; each written field from the preferred side, the other side's where it is empty.
 *
 * Refused (with the reason) when the merged Character is still used by the story (merge the other way), has
 * Continuity Locks, or a reference that would move is locked.
 */

export type MergePrefer = "merged" | "kept";

export interface MergePlan {
  /** the kept Character as it is after the merge */
  character: Character;
  /** reference pointers that change hands: the ref's id and the Character it then belongs to */
  refMoves: Array<{ refId: string; toCharacterId: string }>;
  /**
   * Two references of the same place (one each) that trade what they point at (picture, label, notes): a slot holds
   * one reference per Character, so a picture changes hands there by trading contents, not owners.
   */
  refSwaps: Array<{ keptRefId: string; mergedRefId: string }>;
  lookIds: string[];
  voiceIds: string[];
  /** what moves, in words, for the confirmation and the result */
  summary: string[];
}

const TEXT_FIELDS = [
  "role",
  "description",
  "personality",
  "behaviorNotes",
  "physicalDescription",
  "signatureBehavior",
  "relationshipNotes",
] as const;

/** The one-picture places: each view slot, the canonical identity and the cutout. Null for any other reference. */
function placeOf(r: IdentityRef): string | null {
  const role = visualRoleOf(r);
  if (role === "canonical" || role === "cutout") return role;
  if (role === "expression") return null;
  if (r.slot !== "additional") return `slot:${r.slot}`;
  const view = (r.metadata as { view?: unknown }).view;
  return typeof view === "string" ? `view:${view}` : null;
}

export function planCharacterMerge(
  data: ProjectData,
  mergedId: string,
  keptId: string,
  opts: { name: string; prefer: MergePrefer },
): { ok: true; plan: MergePlan } | { ok: false; reason: string } {
  const merged = data.characters.find((c) => c.id === mergedId);
  const kept = data.characters.find((c) => c.id === keptId);
  if (!merged || !kept) return { ok: false, reason: "Both characters must be in this project." };
  if (merged.id === kept.id) return { ok: false, reason: "Choose another character to merge into." };
  const usage = characterUsage(data, merged.id);
  if (usage.length)
    return {
      ok: false,
      reason: `${merged.name} is used by the story (${usage.join("; ")}). Merge the other way: open ${kept.name} and merge it into ${merged.name}, or take ${merged.name} out of those first.`,
    };
  if ((data.characterContinuityLocks ?? []).some((l) => l.characterId === merged.id))
    return {
      ok: false,
      reason: `${merged.name} has Continuity Locks. A Lock belongs to its Character for good, so it cannot be merged.`,
    };
  const name = opts.name.trim();
  if (name !== merged.name && name !== kept.name)
    return { ok: false, reason: "Choose one of the two names." };

  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const holds = (r: IdentityRef | undefined) => !!r?.assetId && hasStoredImage(assets.get(r.assetId));
  const refsOf = (id: string) => data.identityRefs.filter((r) => r.characterId === id);
  const mergedRefs = refsOf(merged.id);
  const keptRefs = refsOf(kept.id);
  const refMoves: MergePlan["refMoves"] = [];
  const refSwaps: MergePlan["refSwaps"] = [];
  const moved = new Set<string>();
  const move = (r: IdentityRef, to: string) => {
    refMoves.push({ refId: r.id, toCharacterId: to });
    moved.add(r.id);
  };
  const swap = (k: IdentityRef, m: IdentityRef) => {
    refSwaps.push({ keptRefId: k.id, mergedRefId: m.id });
    moved.add(k.id);
    moved.add(m.id);
  };
  let pictures = 0;
  let setAside = 0;

  for (const r of mergedRefs) {
    if (!holds(r)) continue;
    const place = placeOf(r);
    const other = place ? keptRefs.find((k) => placeOf(k) === place) : undefined;
    if (!place || !other) {
      // a place only the merged Character has (or no one-picture place at all): the reference moves
      move(r, kept.id);
      pictures++;
    } else if (!holds(other)) {
      // the kept Character's place is an empty placeholder: it takes the picture
      swap(other, r);
      pictures++;
    } else if (opts.prefer === "merged") {
      swap(other, r);
      pictures++;
      setAside++;
    } else {
      setAside++;
    }
  }
  const locked = data.identityRefs.find((r) => moved.has(r.id) && r.locked);
  if (locked)
    return {
      ok: false,
      reason: `${locked.label || "A reference"} of ${locked.characterId === kept.id ? kept.name : merged.name} is locked. Unlock the identity references first.`,
    };

  const preferred = opts.prefer === "merged" ? merged : kept;
  const other = opts.prefer === "merged" ? kept : merged;
  const text = Object.fromEntries(
    TEXT_FIELDS.map((k) => [k, preferred[k].trim() ? preferred[k] : other[k]]),
  ) as Pick<Character, (typeof TEXT_FIELDS)[number]>;
  const character: Character = {
    ...kept,
    ...text,
    name,
    continuityRules: preferred.continuityRules.length ? preferred.continuityRules : other.continuityRules,
    ...(kept.partSize !== undefined || merged.partSize !== undefined
      ? { partSize: preferred.partSize ?? other.partSize ?? null }
      : {}),
  };

  const lookIds = data.looks.filter((l) => l.characterId === merged.id).map((l) => l.id);
  const voiceIds = data.voiceProfiles.filter((v) => v.characterId === merged.id).map((v) => v.id);
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const summary = [
    `${n(pictures, "picture")} of ${merged.name} ${pictures === 1 ? "moves" : "move"} to ${kept.name}`,
    ...(setAside
      ? [
          `${n(setAside, "picture")} where both had one ${setAside === 1 ? "goes" : "go"} to the Trash with ${merged.name} (restorable)`,
        ]
      : []),
    ...(lookIds.length ? [`${n(lookIds.length, "Look")} move`] : []),
    ...(voiceIds.length ? [`${n(voiceIds.length, "voice profile")} move`] : []),
    `the sheet: ${preferred.name === other.name ? "the" : `${preferred === merged ? merged.name : kept.name}'s`} wording first, the other's where it is empty`,
  ];
  return { ok: true, plan: { character, refMoves, refSwaps, lookIds, voiceIds, summary } };
}

/**
 * The Characters whose pictures belong on this one: itself, and every Character merged into it (directly, or into one
 * that was then merged into it). A generation record never changes hands, so a merged Character's takes are found here
 * rather than moved. A merged Character restored from the Trash is its own again (its link is cleared).
 */
export function pictureOwnersOf(
  data: Pick<ProjectData, "characters"> & { trashedCharacters?: Character[] },
  characterId: string,
): Set<string> {
  const owners = new Set([characterId]);
  const merged = (data.trashedCharacters ?? []).filter((c) => c.mergedIntoId && c.trashedAt);
  for (let grew = true; grew;) {
    grew = false;
    for (const c of merged)
      if (!owners.has(c.id) && owners.has(c.mergedIntoId!)) {
        owners.add(c.id);
        grew = true;
      }
  }
  return owners;
}
