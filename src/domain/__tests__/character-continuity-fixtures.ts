import { randomUUID } from "node:crypto";
import { draftCharacterContinuityLock, type CharacterContinuityLock } from "@/domain/character-continuity";
import type { Asset, CharacterLook, IdentityRef, ProjectData } from "@/domain/schemas";
import { shotByCode } from "./helpers";
import { newUploadAsset, T } from "./production-frame-fixtures";

/**
 * Fixtures for Character Continuity Lock tests (Phase 2G.4). Fictional and in memory: no provider, 3D set, GPU or
 * network. The seed's identity references are placeholders (no stored file), so a test that locks real evidence first
 * uploads images with `uploadIdentity` / `uploadLookRef`.
 */

export const characterByName = (data: ProjectData, name: string) => {
  const c = data.characters.find((x) => x.name === name);
  if (!c) throw new Error(`no character ${name}`);
  return c;
};

export const lookOf = (data: ProjectData, characterName: string, lookName?: string): CharacterLook => {
  const c = characterByName(data, characterName);
  const l = data.looks.find((x) => x.characterId === c.id && (!lookName || x.name === lookName));
  if (!l) throw new Error(`no look ${lookName ?? "(any)"} for ${characterName}`);
  return l;
};

/** A stored image Asset (what an identity / Look upload creates), added to the project. */
export function addImage(
  data: ProjectData,
  label: string,
  o: { width?: number; height?: number } = {},
): Asset {
  const a = newUploadAsset(data.project.id, { label, width: o.width ?? 768, height: o.height ?? 1024 });
  a.purpose = "identity_ref";
  data.assets.push(a);
  return a;
}

/** Replaces (or adds) the Character's identity reference in `slot` with a freshly uploaded image. */
export function uploadIdentity(
  data: ProjectData,
  characterName: string,
  slot: IdentityRef["slot"],
  label = `${characterName}-${slot}`,
): Asset {
  const c = characterByName(data, characterName);
  const asset = addImage(data, label);
  const existing = data.identityRefs.find(
    (r) => r.characterId === c.id && r.slot === slot && slot !== "additional",
  );
  if (existing) existing.assetId = asset.id;
  else
    data.identityRefs.push({
      id: randomUUID(),
      characterId: c.id,
      slot,
      assetId: asset.id,
      label: slot.replace("_", " "),
      metadata: {},
      locked: false,
    });
  return asset;
}

/** Adds a new Look to a Character (unlocked, editable). */
export function addLook(
  data: ProjectData,
  characterName: string,
  name: string,
  facts: Partial<CharacterLook> = {},
): CharacterLook {
  const c = characterByName(data, characterName);
  const look: CharacterLook = {
    id: randomUUID(),
    projectId: data.project.id,
    characterId: c.id,
    episodeId: null,
    name,
    wardrobe: "",
    shoes: "",
    jewelry: "",
    hair: "",
    makeup: "",
    grooming: "",
    bodyNotes: "",
    accessories: "",
    referenceAssetIds: [],
    locked: false,
    ...facts,
  };
  data.looks.push(look);
  return look;
}

export function uploadLookRef(data: ProjectData, look: CharacterLook, label: string): Asset {
  const a = addImage(data, label);
  a.purpose = "look_ref";
  look.referenceAssetIds = [...look.referenceAssetIds, a.id];
  return a;
}

/** Assigns `look` to the Character on Shot `code` (adds the assignment if missing). */
export function assignLook(
  data: ProjectData,
  code: string,
  characterName: string,
  look: CharacterLook | null,
) {
  const shot = shotByCode(data, code);
  const c = characterByName(data, characterName);
  const a = shot.characters.find((x) => x.characterId === c.id);
  if (a) a.lookId = look?.id ?? null;
  else
    shot.characters.push({
      characterId: c.id,
      lookId: look?.id ?? null,
      performanceNotes: "",
      expression: "",
      posture: "",
      gestures: "",
      physicalInteractions: "",
    });
}

/** Drafts a Lock from the CURRENT source library, failing the test loudly when refused. */
export function lockFor(
  data: ProjectData,
  characterName: string,
  look: CharacterLook | null,
  o: { name?: string; id?: string; now?: string } = {},
): CharacterContinuityLock {
  const c = characterByName(data, characterName);
  const r = draftCharacterContinuityLock({
    id: o.id ?? randomUUID(),
    now: o.now ?? T,
    userId: null,
    projectId: data.project.id,
    name: o.name ?? `${characterName} — ${look?.name ?? "No Look"}`,
    character: c,
    look,
    identityRefs: data.identityRefs.filter((r) => r.characterId === c.id),
    assets: data.assets,
  });
  if (!r.ok) throw new Error(`lock refused: ${r.message}`);
  return r.draft;
}

/** Attaches Locks and assignment selections to the project data the way the server loaders do. */
export function attachLocks(
  data: ProjectData,
  locks: CharacterContinuityLock[],
  selections: Array<{ code: string; lock: CharacterContinuityLock }> = [],
): ProjectData {
  data.characterContinuityLocks = locks;
  data.shotCharacterContinuitySelections = selections.map(({ code, lock }) => ({
    projectId: data.project.id,
    shotId: shotByCode(data, code).id,
    characterId: lock.characterId,
    continuityLockId: lock.id,
    selectedBy: null,
    selectedAt: T,
  }));
  return data;
}

/**
 * The milestone's reference setup: Yumeko with real front + profile identity images (three-quarter and full body stay
 * placeholders), an "Ivory Suit" Look with one Look image, assigned on Shot `code`.
 */
export function yumekoIvory(data: ProjectData, code = "3A") {
  const front = uploadIdentity(data, "Yumeko", "front");
  const profile = uploadIdentity(data, "Yumeko", "profile");
  // the seed's three-quarter / full-body references stay placeholders: never frozen as evidence
  const ivory = addLook(data, "Yumeko", "Ivory Suit", {
    wardrobe: "ivory tailored suit, wide lapels",
    hair: "low chignon",
    makeup: "soft matte, muted rose lip",
    jewelry: "pearl earrings",
    shoes: "ivory pumps",
  });
  const ivoryRef = uploadLookRef(data, ivory, "ivory-suit-ref");
  assignLook(data, code, "Yumeko", ivory);
  return { front, profile, ivory, ivoryRef };
}
