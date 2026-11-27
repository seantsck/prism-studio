import type { Asset, Character, CharacterLook, IdentityRef, ProjectData, VoiceProfile } from "./schemas";

/**
 * The account's character library: a Character saved from one of the creator's projects is copied into another of
 * theirs. The copy is independent (new ids throughout, pictures copied into the target project's own storage), so
 * editing either never changes the other. The library keeps the actor generic: their part in a story (role,
 * relationships) is set per project, so a copy starts without it. What travels with a Character: the Character itself, its identity
 * references (canonical identity, angles, expressions, cutout), its Looks (an episode-specific Look becomes a
 * project-wide one, since the source's Episodes are not the target's) and its voice profiles, plus every picture or
 * sample those use. Archived pictures stay behind; nothing else of the source project (Shots, takes, checks) travels.
 */

export interface CharacterCopyPlan {
  character: Character;
  identityRefs: IdentityRef[];
  looks: CharacterLook[];
  voiceProfiles: VoiceProfile[];
  /** Each picture or sample to copy: the source asset and the new one (its object path set by the caller). */
  assets: Array<{ from: Asset; to: Asset }>;
}

const isArchivedAsset = (a: Asset) =>
  !!(a.metadata as { archived?: unknown; trashed?: unknown }).archived ||
  !!(a.metadata as { trashed?: unknown }).trashed;

/** A name the target project does not use yet: the same name, else "Name (2)", "Name (3)" … */
export function freeCharacterName(name: string, taken: ReadonlyArray<{ name: string }>): string {
  const used = new Set(taken.map((c) => c.name.trim().toLowerCase()));
  if (!used.has(name.trim().toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const next = `${name} (${n})`;
    if (!used.has(next.toLowerCase())) return next;
  }
}

/**
 * Everything to write to copy `characterId` from `source` into `target`. Pure: ids come from `newId`, the time from
 * `now`; an asset's object path is left for the caller (it depends on the storage it is copied to).
 */
export function planCharacterCopy(
  source: ProjectData,
  characterId: string,
  target: ProjectData,
  newId: () => string,
  now: string,
): CharacterCopyPlan {
  const original = source.characters.find((c) => c.id === characterId);
  if (!original) throw new Error(`Character ${characterId} is not in ${source.project.title}`);
  const assetById = new Map(source.assets.map((a) => [a.id, a]));
  const copied = new Map<string, Asset>();
  const assets: CharacterCopyPlan["assets"] = [];
  /** The new id of a source asset (copied once), or null when it is missing or archived. */
  const asset = (id: string | null): string | null => {
    if (!id) return null;
    const done = copied.get(id);
    if (done) return done.id;
    const from = assetById.get(id);
    if (!from || isArchivedAsset(from)) return null;
    const metadata = { ...from.metadata, copiedFrom: { projectId: source.project.id, assetId: from.id } };
    delete (metadata as { archived?: unknown }).archived;
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

  const character: Character = {
    ...original,
    id: newId(),
    projectId: target.project.id,
    name: freeCharacterName(original.name, target.characters),
    // who they are in a story ("Lead — heiress") and to whom belongs to each project: the copy starts without it
    role: "",
    relationshipNotes: "",
    trashedAt: undefined,
    partSize: undefined,
    mergedIntoId: undefined,
    // the real Character an animated one takes its likeness from belongs to the source project: the copy keeps its
    // style and its own pictures, not the link
    likenessFromId: undefined,
    // the Actor stays linked when a Character is brought into another project (it lives in the library)
    createdAt: now,
    updatedAt: now,
  };
  const identityRefs: IdentityRef[] = source.identityRefs
    .filter((r) => r.characterId === characterId)
    .flatMap((r) => {
      const assetId = asset(r.assetId);
      // a reference whose picture stayed behind (archived) is not copied as an empty slot
      if (r.assetId && !assetId) return [];
      return [{ ...r, id: newId(), characterId: character.id, assetId, metadata: { ...r.metadata } }];
    });
  const looks: CharacterLook[] = source.looks
    .filter((l) => l.characterId === characterId)
    .map((l) => ({
      ...l,
      id: newId(),
      projectId: target.project.id,
      characterId: character.id,
      episodeId: null,
      referenceAssetIds: l.referenceAssetIds.map(asset).filter((x): x is string => !!x),
    }));
  const voiceProfiles: VoiceProfile[] = source.voiceProfiles
    .filter((v) => v.characterId === characterId)
    .map((v) => ({
      ...v,
      id: newId(),
      projectId: target.project.id,
      characterId: character.id,
      sampleAssetIds: v.sampleAssetIds.map(asset).filter((x): x is string => !!x),
    }));
  return { character, identityRefs, looks, voiceProfiles, assets };
}

// ───────────────────────── Actors ─────────────────────────

/** The most reference pictures an Actor lends a Character (the best photos first, then its front view). */
export const ACTOR_REFERENCES_MAX = 6;

/** A reference picture of a Character that came from the Actor playing it (`metadata.fromActor`). */
export function isFromActor(ref: Pick<IdentityRef, "metadata">): boolean {
  return (ref.metadata as { fromActor?: unknown }).fromActor != null;
}

/**
 * Making an Actor from a Character of a story: who they are and how they look, without the story. A copy of the
 * Character into the library with its reference pictures only (photos and views); its Looks, voices, role and
 * relationships stay with the story.
 */
export function planActorFrom(
  source: ProjectData,
  characterId: string,
  library: ProjectData,
  newId: () => string,
  now: string,
): CharacterCopyPlan {
  const plan = planCharacterCopy(source, characterId, library, newId, now);
  const kept = new Set(plan.identityRefs.map((r) => r.assetId).filter(Boolean));
  return {
    character: {
      ...plan.character,
      role: "",
      relationshipNotes: "",
      artStyle: undefined,
      likenessFromId: undefined,
      actorId: undefined,
    },
    // the pictures an Actor lent this Character are the Actor's own already: not copied back
    identityRefs: plan.identityRefs.filter((r) => !isFromActor(r)),
    looks: [],
    voiceProfiles: [],
    assets: plan.assets.filter((p) => kept.has(p.to.id)),
  };
}

/**
 * What an Actor lends a Character it plays, in the Character's own project (a generation only reads pictures of its own
 * project): copies of the Actor's reference pictures (its photos first, then its front view and the rest), each a
 * reference of the Character marked `fromActor`. A picture the Character already has (the same bytes, or a copy made
 * before) is not copied again, so linking twice, or linking a Character to the Actor made from it, adds nothing new.
 * Pure: ids from `newId`; object paths are left for the caller.
 */
export function planActorReferences(
  actorData: ProjectData,
  actorId: string,
  target: ProjectData,
  characterId: string,
  newId: () => string,
  now: string,
): { identityRefs: IdentityRef[]; assets: Array<{ from: Asset; to: Asset }> } {
  const actor = actorData.characters.find((c) => c.id === actorId);
  if (!actor) throw new Error(`Actor ${actorId} is not in ${actorData.project.title}`);
  const assetById = new Map(actorData.assets.map((a) => [a.id, a]));
  const have = new Set<string>();
  for (const r of target.identityRefs.filter((x) => x.characterId === characterId && x.assetId)) {
    const a = target.assets.find((x) => x.id === r.assetId);
    if (a?.checksum) have.add(`sum:${a.checksum}`);
    const from = (a?.metadata as { copiedFrom?: { assetId?: unknown } } | undefined)?.copiedFrom?.assetId;
    if (typeof from === "string") have.add(`id:${from}`);
  }
  const usable = actorData.identityRefs
    .filter((r) => r.characterId === actorId && r.assetId)
    .map((r) => ({ r, a: assetById.get(r.assetId!) }))
    .filter((x): x is { r: IdentityRef; a: Asset } => !!x.a && !!x.a.objectPath && !isArchivedAsset(x.a))
    // photos first (the likeness), then the front view, then the rest
    .sort(
      (x, y) =>
        Number(y.a.source === "upload") - Number(x.a.source === "upload") ||
        Number(y.r.slot === "front") - Number(x.r.slot === "front"),
    );
  const identityRefs: IdentityRef[] = [];
  const assets: Array<{ from: Asset; to: Asset }> = [];
  const seen = new Set<string>();
  for (const { r, a } of usable) {
    if (identityRefs.length >= ACTOR_REFERENCES_MAX) break;
    if (seen.has(a.id) || have.has(`id:${a.id}`) || (a.checksum && have.has(`sum:${a.checksum}`))) continue;
    seen.add(a.id);
    const metadata = { ...a.metadata, copiedFrom: { projectId: actorData.project.id, assetId: a.id } };
    delete (metadata as { archived?: unknown }).archived;
    const to: Asset = {
      ...a,
      id: newId(),
      projectId: target.project.id,
      objectPath: null,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
    assets.push({ from: a, to });
    identityRefs.push({
      id: newId(),
      characterId,
      slot: "additional",
      assetId: to.id,
      label: `${actor.name} (actor): ${a.source === "upload" ? "photo" : r.slot.replace("_", " ")}`,
      metadata: { fromActor: { actorId, assetId: a.id, slot: r.slot } },
      locked: false,
    });
  }
  return { identityRefs, assets };
}
