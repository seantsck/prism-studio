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
