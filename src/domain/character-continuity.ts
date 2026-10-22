import { z } from "zod";
import { fingerprint } from "./hash";
import {
  IDENTITY_SLOTS,
  type Asset,
  type Character,
  type CharacterLook,
  type IdentityRef,
  type ProjectData,
  type Shot,
  type ShotCharacter,
} from "./schemas";

/**
 * CHARACTER CONTINUITY LOCK (Phase 2G.4): an IMMUTABLE approved snapshot of one Character's appearance in one exact
 * Look (or in an intentional no-Look state): the appearance facts copied BY VALUE plus the exact reference images it
 * was approved with. A Shot may select one Lock per assigned Character; that Shot's production truth (generation,
 * Production Frame / Storyboard / candidate freshness, continuity QA references) then reasons from the Lock, never
 * from whatever the editable source library says today.
 *
 *   CHARACTER          the person (Yumeko): `characters`
 *   IDENTITY REFS      the editable reference library of that person: `character_identity_refs`
 *   CHARACTER LOOK     an editable appearance configuration ("Ivory Suit"): `character_looks`
 *   CONTINUITY LOCK    this: the exact approved facts + images a Shot relies on, frozen at creation
 *
 * IdentityRefs and Looks stay source libraries: editing them later changes Shots WITHOUT a Lock (exactly as before) and
 * never changes a Shot that selected a Lock. There is deliberately no "current Lock of Yumeko": each Shot names the
 * exact Lock it means, so a later Lock never rewrites an older Shot. A Lock never copies image bytes (it references
 * existing Assets by id and freezes their checksums) and needs no generation, 3D or GPU. Pure domain code.
 */

export const CHARACTER_CONTINUITY_LOCK_SCHEMA = "prism.character-continuity-lock.v1" as const;
export const CHARACTER_CONTINUITY_FACTS_SCHEMA = "prism.character-continuity-facts.v1" as const;

/** Stable slot order of the identity images inside a Lock (and in every package / request built from one). */
export const IDENTITY_SLOT_ORDER = IDENTITY_SLOTS;
export type IdentitySlot = (typeof IDENTITY_SLOTS)[number];

export const IDENTITY_SLOT_LABEL: Record<IdentitySlot, string> = {
  front: "front",
  three_quarter: "three-quarter",
  profile: "profile",
  full_body: "full body",
  additional: "additional",
};

/** The appearance fields a Look carries, in display order. */
export const LOOK_FACT_FIELDS = [
  "wardrobe",
  "shoes",
  "jewelry",
  "hair",
  "makeup",
  "grooming",
  "bodyNotes",
  "accessories",
] as const;
export type LookFactField = (typeof LOOK_FACT_FIELDS)[number];

export const LOOK_FACT_LABEL: Record<LookFactField, string> = {
  wardrobe: "wardrobe",
  shoes: "shoes",
  jewelry: "jewelry",
  hair: "hair",
  makeup: "makeup",
  grooming: "grooming",
  bodyNotes: "body notes",
  accessories: "accessories",
};

/** The most reference images one Lock may freeze (the database CHECK says the same). */
export const MAX_LOCK_REFERENCES = 64;

const id = z.string().min(1);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const text = z.string().max(4000);

/** The appearance facts, frozen BY VALUE. `look: null` records an intentional no-Look state; nothing is invented. */
export const characterContinuityFactsSchema = z.object({
  schema: z.literal(CHARACTER_CONTINUITY_FACTS_SCHEMA),
  characterId: id,
  characterName: z.string(),
  physicalDescription: text,
  continuityRules: z.array(text),
  sourceLookId: id.nullable(),
  look: z
    .object({
      name: z.string(),
      wardrobe: text,
      shoes: text,
      jewelry: text,
      hair: text,
      makeup: text,
      grooming: text,
      bodyNotes: text,
      accessories: text,
    })
    .nullable(),
});
export type CharacterContinuityFacts = z.infer<typeof characterContinuityFactsSchema>;

/** One frozen reference image of a Lock. */
export const characterContinuityLockReferenceSchema = z.object({
  position: z
    .number()
    .int()
    .min(0)
    .max(MAX_LOCK_REFERENCES - 1),
  assetId: id,
  role: z.enum(["identity", "look"]),
  identitySlot: z.enum(IDENTITY_SLOTS).nullable(),
  label: z.string().max(200),
  assetChecksum: hex64,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type CharacterContinuityLockReference = z.infer<typeof characterContinuityLockReferenceSchema>;

/** The immutable record (with its frozen reference images). Nothing in it changes after creation. */
export const characterContinuityLockSchema = z.object({
  id,
  projectId: id,
  characterId: id,
  /** historical id of the Look the facts came from (null = intentionally no Look) */
  sourceLookId: id.nullable(),
  schemaVersion: z.literal(CHARACTER_CONTINUITY_LOCK_SCHEMA),
  name: z.string().trim().min(1).max(120),
  facts: characterContinuityFactsSchema,
  references: z.array(characterContinuityLockReferenceSchema).max(MAX_LOCK_REFERENCES),
  /** deterministic identity (Character, source Look, facts, ordered role/slot + checksum; no timestamps or user) */
  lockFingerprint: hex64,
  createdBy: id.nullable(),
  createdAt: z.string(),
});
export type CharacterContinuityLock = z.infer<typeof characterContinuityLockSchema>;

/** The ONE Lock a Shot Character assignment relies on. Changing it moves only this pointer. */
export const characterContinuitySelectionSchema = z.object({
  projectId: id,
  shotId: id,
  characterId: id,
  continuityLockId: id,
  selectedBy: id.nullable(),
  selectedAt: z.string(),
});
export type CharacterContinuitySelection = z.infer<typeof characterContinuitySelectionSchema>;

// ───────────────────────── the image rules ─────────────────────────

export type LockImageCheck =
  { ok: true; width: number; height: number; checksum: string } | { ok: false; message: string };

/**
 * A Lock reference image: a stored image of the Lock's project with a checksum and readable size. A placeholder (no
 * stored file) is NOT image evidence and never enters a Lock.
 */
export function checkLockImage(
  asset: Pick<Asset, "type" | "objectPath" | "width" | "height" | "checksum"> | null | undefined,
): LockImageCheck {
  if (!asset) return { ok: false, message: "That image is missing." };
  if (asset.type !== "image") return { ok: false, message: "A Lock reference must be an image." };
  if (!asset.objectPath) return { ok: false, message: "That image has no stored file (a placeholder)." };
  if (!asset.width || !asset.height)
    return { ok: false, message: "Prism could not read this image's pixel size." };
  if (!asset.checksum || !/^[0-9a-f]{64}$/.test(asset.checksum))
    return { ok: false, message: "This image has no recorded checksum." };
  return { ok: true, width: asset.width, height: asset.height, checksum: asset.checksum };
}

// ───────────────────────── creating a Lock (pure) ─────────────────────────

export function buildCharacterContinuityFacts(
  character: Pick<Character, "id" | "name" | "physicalDescription" | "continuityRules">,
  look: Pick<CharacterLook, "id" | "name" | LookFactField> | null,
): CharacterContinuityFacts {
  return characterContinuityFactsSchema.parse({
    schema: CHARACTER_CONTINUITY_FACTS_SCHEMA,
    characterId: character.id,
    characterName: character.name,
    physicalDescription: character.physicalDescription,
    continuityRules: [...character.continuityRules],
    sourceLookId: look?.id ?? null,
    look: look
      ? {
          name: look.name,
          wardrobe: look.wardrobe,
          shoes: look.shoes,
          jewelry: look.jewelry,
          hair: look.hair,
          makeup: look.makeup,
          grooming: look.grooming,
          bodyNotes: look.bodyNotes,
          accessories: look.accessories,
        }
      : null,
  });
}

/** Why a source reference did not enter the Lock (shown truthfully; nothing is invented to fill a slot). */
export interface SkippedReference {
  role: "identity" | "look";
  slot: IdentitySlot | null;
  assetId: string | null;
  reason: string;
}

/**
 * The exact reference images a Lock freezes, in their stable order: identity images by slot (front, three-quarter,
 * profile, full body, additional; ties in the library's own order), then the Look's images in the Look's own order.
 * Only REAL stored images of the project: a placeholder IdentityRef (no Asset, or an Asset without a stored file) stays
 * in the editable library but is skipped here. The same Asset is frozen once (identity outranks Look).
 */
export function collectLockReferences(input: {
  projectId: string;
  characterId: string;
  identityRefs: Pick<IdentityRef, "id" | "characterId" | "slot" | "assetId" | "label">[];
  look: Pick<CharacterLook, "referenceAssetIds"> | null;
  assets: ReadonlyMap<string, Asset> | readonly Asset[];
}): { references: CharacterContinuityLockReference[]; skipped: SkippedReference[] } {
  const byId =
    input.assets instanceof Map
      ? (input.assets as ReadonlyMap<string, Asset>)
      : new Map((input.assets as readonly Asset[]).map((a) => [a.id, a]));
  const references: CharacterContinuityLockReference[] = [];
  const skipped: SkippedReference[] = [];
  const seen = new Set<string>();
  const add = (
    role: "identity" | "look",
    slot: IdentitySlot | null,
    assetId: string | null,
    label: string,
  ) => {
    if (!assetId) {
      skipped.push({ role, slot, assetId, reason: "no image uploaded (placeholder)" });
      return;
    }
    if (seen.has(assetId)) return;
    const asset = byId.get(assetId);
    if (asset && asset.projectId !== input.projectId) {
      skipped.push({ role, slot, assetId, reason: "image belongs to a different project" });
      return;
    }
    const image = checkLockImage(asset);
    if (!image.ok) {
      skipped.push({ role, slot, assetId, reason: image.message });
      return;
    }
    seen.add(assetId);
    references.push({
      position: references.length,
      assetId,
      role,
      identitySlot: slot,
      label: label.slice(0, 200),
      assetChecksum: image.checksum,
      width: image.width,
      height: image.height,
    });
  };
  const slotIndex = (s: IdentitySlot) => IDENTITY_SLOT_ORDER.indexOf(s);
  const own = input.identityRefs
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.characterId === input.characterId)
    .sort((a, b) => slotIndex(a.r.slot) - slotIndex(b.r.slot) || a.i - b.i);
  for (const { r } of own) add("identity", r.slot, r.assetId, r.label.trim() || IDENTITY_SLOT_LABEL[r.slot]);
  for (const assetId of input.look?.referenceAssetIds ?? []) add("look", null, assetId, "");
  return { references: references.slice(0, MAX_LOCK_REFERENCES), skipped };
}

/**
 * The duplicate key: the Character, the source Look (or the intentional null), the facts snapshot and the ORDERED
 * references by role / slot / image checksum. No timestamps, user, URL or Lock name: the same image bytes with the same
 * facts IS the same Lock, so creating it twice returns the existing one. A changed wardrobe, hair or identity image is
 * a new Lock.
 */
export function characterContinuityLockFingerprint(
  characterId: string,
  sourceLookId: string | null,
  facts: CharacterContinuityFacts,
  references: Pick<CharacterContinuityLockReference, "role" | "identitySlot" | "assetChecksum">[],
): string {
  return fingerprint({
    schema: CHARACTER_CONTINUITY_LOCK_SCHEMA,
    characterId,
    sourceLookId,
    facts,
    references: references.map((r) => [r.role, r.identitySlot, r.assetChecksum]),
  });
}

export interface CharacterContinuityLockDraftInput {
  id: string;
  now: string;
  userId: string | null;
  projectId: string;
  name: string;
  character: Pick<Character, "id" | "projectId" | "name" | "physicalDescription" | "continuityRules">;
  /** the Look the Lock freezes; null = intentionally no Look */
  look: CharacterLook | null;
  identityRefs: IdentityRef[];
  assets: ReadonlyMap<string, Asset> | readonly Asset[];
}

export type CharacterContinuityLockDraftResult =
  { ok: true; draft: CharacterContinuityLock; skipped: SkippedReference[] } | { ok: false; message: string };

/** Validates the sources (spec: same Project, Look of this Character) and freezes facts + references. */
export function draftCharacterContinuityLock(
  i: CharacterContinuityLockDraftInput,
): CharacterContinuityLockDraftResult {
  const name = (i.name ?? "").trim();
  if (!name) return { ok: false, message: "Name the Continuity Lock." };
  if (name.length > 120) return { ok: false, message: "A Continuity Lock name is at most 120 characters." };
  if (i.character.projectId !== i.projectId)
    return { ok: false, message: "That Character belongs to a different project." };
  if (i.look && (i.look.projectId !== i.projectId || i.look.characterId !== i.character.id))
    return { ok: false, message: "That Look is not one of this Character's Looks." };
  if (i.identityRefs.some((r) => r.characterId !== i.character.id))
    return { ok: false, message: "An identity reference belongs to a different Character." };
  const facts = buildCharacterContinuityFacts(i.character, i.look);
  const { references, skipped } = collectLockReferences({
    projectId: i.projectId,
    characterId: i.character.id,
    identityRefs: i.identityRefs,
    look: i.look,
    assets: i.assets,
  });
  const sourceLookId = i.look?.id ?? null;
  const parsed = characterContinuityLockSchema.safeParse({
    id: i.id,
    projectId: i.projectId,
    characterId: i.character.id,
    sourceLookId,
    schemaVersion: CHARACTER_CONTINUITY_LOCK_SCHEMA,
    name,
    facts,
    references,
    lockFingerprint: characterContinuityLockFingerprint(i.character.id, sourceLookId, facts, references),
    createdBy: i.userId,
    createdAt: i.now,
  });
  if (!parsed.success) return { ok: false, message: "A Continuity Lock field is too long." };
  return { ok: true, draft: parsed.data, skipped };
}

// ───────────────────────── coverage (truthful, never invented) ─────────────────────────

export interface LockCoverage {
  identitySlots: Record<IdentitySlot, number>;
  identityCount: number;
  lookCount: number;
  /** rich: front + another identity angle + (no Look or ≥1 Look image); sparse: some images; none: facts only */
  level: "rich" | "sparse" | "none";
}

export function lockCoverage(
  lock: Pick<CharacterContinuityLock, "references" | "sourceLookId">,
): LockCoverage {
  const identitySlots = Object.fromEntries(IDENTITY_SLOT_ORDER.map((s) => [s, 0])) as Record<
    IdentitySlot,
    number
  >;
  let lookCount = 0;
  for (const r of lock.references) {
    if (r.role === "identity" && r.identitySlot) identitySlots[r.identitySlot] += 1;
    else if (r.role === "look") lookCount += 1;
  }
  const identityCount = Object.values(identitySlots).reduce((a, b) => a + b, 0);
  const angles = IDENTITY_SLOT_ORDER.filter((s) => s !== "additional" && identitySlots[s] > 0).length;
  const level =
    identityCount + lookCount === 0
      ? "none"
      : identitySlots.front > 0 && angles >= 2 && (lock.sourceLookId === null || lookCount > 0)
        ? "rich"
        : "sparse";
  return { identitySlots, identityCount, lookCount, level };
}

/** "front, profile" — the identity slots present, in slot order (empty string when none). */
export function describeIdentityCoverage(c: LockCoverage): string {
  return IDENTITY_SLOT_ORDER.filter((s) => c.identitySlots[s] > 0)
    .map((s) =>
      c.identitySlots[s] > 1 ? `${IDENTITY_SLOT_LABEL[s]} ×${c.identitySlots[s]}` : IDENTITY_SLOT_LABEL[s],
    )
    .join(", ");
}

// ───────────────────────── a Shot's selections (resolved from ProjectData) ─────────────────────────

/** Why a stored selection cannot be used. Only reachable through a data-integrity problem: never a silent fallback. */
export interface ContinuityLockSelectionIssue {
  code: "missing_lock" | "wrong_character" | "wrong_look" | "wrong_project" | "not_assigned";
  message: string;
  continuityLockId: string;
  characterId: string;
}

export const CONTINUITY_LOCK_INTEGRITY_MESSAGE =
  "This Shot's selected Character Continuity Lock no longer matches the Character's assignment (Character, Look or project). Clear it or choose a Lock made for the current Look before generating.";

export interface AssignmentContinuity {
  /** every Lock of the Character, newest first */
  locks: CharacterContinuityLock[];
  /** the selected Lock, ONLY when it is valid for the assignment's Character and current Look */
  selected: CharacterContinuityLock | null;
  issue: ContinuityLockSelectionIssue | null;
}

const newestFirst = (a: CharacterContinuityLock, b: CharacterContinuityLock) =>
  b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** Whether a Lock may be selected for an assignment: same Character, and its Look IS the assignment's (null = null). */
export const lockMatchesAssignment = (
  lock: Pick<CharacterContinuityLock, "characterId" | "sourceLookId">,
  assignment: Pick<ShotCharacter, "characterId" | "lookId">,
): boolean =>
  lock.characterId === assignment.characterId && lock.sourceLookId === (assignment.lookId ?? null);

export function resolveAssignmentContinuity(
  data: Pick<ProjectData, "project" | "characterContinuityLocks" | "shotCharacterContinuitySelections">,
  shot: Pick<Shot, "id">,
  assignment: Pick<ShotCharacter, "characterId" | "lookId">,
): AssignmentContinuity {
  const all = data.characterContinuityLocks ?? [];
  const locks = all.filter((l) => l.characterId === assignment.characterId).sort(newestFirst);
  const sel = data.shotCharacterContinuitySelections?.find(
    (s) => s.shotId === shot.id && s.characterId === assignment.characterId,
  );
  if (!sel) return { locks, selected: null, issue: null };
  const issue = (code: ContinuityLockSelectionIssue["code"]): AssignmentContinuity => ({
    locks,
    selected: null,
    issue: {
      code,
      message: CONTINUITY_LOCK_INTEGRITY_MESSAGE,
      continuityLockId: sel.continuityLockId,
      characterId: assignment.characterId,
    },
  });
  const lock = all.find((l) => l.id === sel.continuityLockId);
  if (!lock) return issue("missing_lock");
  if (lock.projectId !== data.project.id || sel.projectId !== data.project.id) return issue("wrong_project");
  if (lock.characterId !== assignment.characterId) return issue("wrong_character");
  if (lock.sourceLookId !== (assignment.lookId ?? null)) return issue("wrong_look");
  return { locks, selected: lock, issue: null };
}

/** Selections whose Character is no longer assigned to their Shot (a dangling pointer is never silently used). */
export function orphanContinuitySelections(
  data: Pick<ProjectData, "shotCharacterContinuitySelections">,
  shot: Pick<Shot, "id" | "characters">,
): ContinuityLockSelectionIssue[] {
  return (data.shotCharacterContinuitySelections ?? [])
    .filter((s) => s.shotId === shot.id && !shot.characters.some((c) => c.characterId === s.characterId))
    .map((s) => ({
      code: "not_assigned" as const,
      message: CONTINUITY_LOCK_INTEGRITY_MESSAGE,
      continuityLockId: s.continuityLockId,
      characterId: s.characterId,
    }));
}

// ───────────────────────── the authoritative appearance ─────────────────────────

/**
 * The appearance Prism actually uses for one assigned Character, resolved ONCE: from the selected Lock when there is
 * one (`source: "continuity_lock"`), else from the live Character / IdentityRefs / Look exactly as before 2G.4
 * (`source: "live"`). Every consumer (package, prompt plan, Production Frame intent, references, QA) reads this, so a
 * locked Shot never mixes a frozen identity with a live wardrobe. Shot-specific performance (expression, posture,
 * gestures, interactions, notes) is never part of it: it stays live on the assignment.
 */
export interface ResolvedCharacterAppearance {
  source: "continuity_lock" | "live";
  lock: { lockId: string; name: string; lockFingerprint: string } | null;
  name: string;
  physicalDescription: string;
  continuityRules: string[];
  look: {
    id: string;
    name: string;
    locked: boolean;
    wardrobe: string;
    shoes: string;
    jewelry: string;
    hair: string;
    makeup: string;
    grooming: string;
    bodyNotes: string;
    accessories: string;
    referenceAssetIds: string[];
  } | null;
  /** identity image Asset ids in the order they are sent (live: the library's order; locked: frozen slot order) */
  identityReferenceAssetIds: string[];
  /** per identity image: its slot (null when live and unknown) */
  identityReferences: Array<{ assetId: string; slot: IdentitySlot | null; label: string }>;
}

export function liveAppearance(c: {
  character: Character | null;
  look: CharacterLook | null;
  identityRefs: IdentityRef[];
}): ResolvedCharacterAppearance {
  const refs = c.identityRefs.flatMap((r) =>
    r.assetId ? [{ assetId: r.assetId, slot: r.slot, label: r.label }] : [],
  );
  return {
    source: "live",
    lock: null,
    name: c.character?.name ?? "Unknown",
    physicalDescription: c.character?.physicalDescription ?? "",
    continuityRules: c.character?.continuityRules ?? [],
    look: c.look
      ? {
          id: c.look.id,
          name: c.look.name,
          locked: c.look.locked,
          wardrobe: c.look.wardrobe,
          shoes: c.look.shoes,
          jewelry: c.look.jewelry,
          hair: c.look.hair,
          makeup: c.look.makeup,
          grooming: c.look.grooming,
          bodyNotes: c.look.bodyNotes,
          accessories: c.look.accessories,
          referenceAssetIds: c.look.referenceAssetIds,
        }
      : null,
    identityReferenceAssetIds: refs.map((r) => r.assetId),
    identityReferences: refs,
  };
}

export function lockedAppearance(lock: CharacterContinuityLock): ResolvedCharacterAppearance {
  const f = lock.facts;
  const identity = lock.references.filter((r) => r.role === "identity");
  return {
    source: "continuity_lock",
    lock: { lockId: lock.id, name: lock.name, lockFingerprint: lock.lockFingerprint },
    name: f.characterName,
    physicalDescription: f.physicalDescription,
    continuityRules: [...f.continuityRules],
    look:
      f.look && lock.sourceLookId
        ? {
            id: lock.sourceLookId,
            name: f.look.name,
            // a Lock IS a locked appearance: it never changes after approval
            locked: true,
            wardrobe: f.look.wardrobe,
            shoes: f.look.shoes,
            jewelry: f.look.jewelry,
            hair: f.look.hair,
            makeup: f.look.makeup,
            grooming: f.look.grooming,
            bodyNotes: f.look.bodyNotes,
            accessories: f.look.accessories,
            referenceAssetIds: lock.references.filter((r) => r.role === "look").map((r) => r.assetId),
          }
        : null,
    identityReferenceAssetIds: identity.map((r) => r.assetId),
    identityReferences: identity.map((r) => ({ assetId: r.assetId, slot: r.identitySlot, label: r.label })),
  };
}

// ───────────────────────── freshness identity (domain/fingerprint) ─────────────────────────

/** What the CHARACTERS part hashes about a locked assignment: the Lock and its frozen identity basis. */
export function lockIdentityBasis(lock: CharacterContinuityLock): Record<string, unknown> {
  return {
    lockId: lock.id,
    identity: fingerprint({
      characterName: lock.facts.characterName,
      physicalDescription: lock.facts.physicalDescription,
      continuityRules: lock.facts.continuityRules,
      references: lock.references
        .filter((r) => r.role === "identity")
        .map((r) => [r.identitySlot, r.assetId, r.assetChecksum]),
    }),
  };
}

/** What the LOOKS part hashes about a locked assignment: the Lock and its frozen Look basis. */
export function lockLookBasis(lock: CharacterContinuityLock): Record<string, unknown> {
  return {
    lockId: lock.id,
    look: fingerprint({
      sourceLookId: lock.sourceLookId,
      look: lock.facts.look,
      references: lock.references.filter((r) => r.role === "look").map((r) => [r.assetId, r.assetChecksum]),
    }),
  };
}

// ───────────────────────── by-value reference for GenerationPackage v5 ─────────────────────────

/** What a GenerationPackage records about one selected Lock (by value; never a URL or a path). */
export interface CharacterContinuityPackageRef {
  characterId: string;
  characterName: string;
  lockId: string;
  name: string;
  lockFingerprint: string;
  sourceLookId: string | null;
  facts: CharacterContinuityFacts;
  references: Array<{
    position: number;
    role: "identity" | "look";
    identitySlot: IdentitySlot | null;
    label: string;
    assetId: string;
    assetChecksum: string;
    width: number;
    height: number;
  }>;
}

export function characterContinuityPackageRef(lock: CharacterContinuityLock): CharacterContinuityPackageRef {
  return {
    characterId: lock.characterId,
    characterName: lock.facts.characterName,
    lockId: lock.id,
    name: lock.name,
    lockFingerprint: lock.lockFingerprint,
    sourceLookId: lock.sourceLookId,
    facts: structuredClone(lock.facts),
    references: lock.references.map((r) => ({
      position: r.position,
      role: r.role,
      identitySlot: r.identitySlot,
      label: r.label,
      assetId: r.assetId,
      assetChecksum: r.assetChecksum,
      width: r.width,
      height: r.height,
    })),
  };
}

/** How a request labels a locked reference (adapters show it to the model verbatim; the name stays the label's head). */
export function lockedReferenceLabel(
  ref: Pick<CharacterContinuityPackageRef, "characterName" | "name" | "facts">,
  r: Pick<CharacterContinuityPackageRef["references"][number], "role" | "identitySlot">,
): string {
  return r.role === "identity"
    ? `${ref.characterName} identity — ${r.identitySlot ? IDENTITY_SLOT_LABEL[r.identitySlot] : "reference"} (Continuity Lock "${ref.name}")`
    : `${ref.characterName} Look "${ref.facts.look?.name ?? "—"}" (Continuity Lock "${ref.name}")`;
}

/** The Lock's frozen facts as short prompt / brief lines. Words only: the images are the visual evidence. */
export function describeLockFacts(f: CharacterContinuityFacts): string[] {
  const look = f.look;
  return [
    f.physicalDescription && `physical identity: ${f.physicalDescription}`,
    ...(look
      ? LOOK_FACT_FIELDS.map((k) => look[k] && `${LOOK_FACT_LABEL[k]}: ${look[k]}`)
      : ["no Look (appearance without a wardrobe configuration)"]),
    ...f.continuityRules.map((r) => r.trim() && `rule: ${r.trim()}`),
  ].filter((l): l is string => typeof l === "string" && l.trim().length > 0);
}
