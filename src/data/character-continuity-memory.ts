import {
  characterContinuityLockSchema,
  characterContinuitySelectionSchema,
  type CharacterContinuityLock,
  type CharacterContinuitySelection,
} from "@/domain/character-continuity";
import type { ProjectData, Shot } from "@/domain/schemas";
import {
  CharacterContinuityError,
  CONTINUITY_SELECTION_CONFLICT_MESSAGE,
  NOT_ASSIGNED_MESSAGE,
  WRONG_CHARACTER_MESSAGE,
  WRONG_LOOK_MESSAGE,
  type CharacterContinuityRepository,
  type ClearCharacterContinuityLockInput,
  type CreateCharacterContinuityLockResult,
  type SelectCharacterContinuityLockInput,
} from "./character-continuity-repository";
import type { MemoryProjectsAccess } from "./generation-memory";

const clone = <T>(v: T): T => structuredClone(v);
const key = (shotId: string, characterId: string) => `${shotId}:${characterId}`;

/**
 * In-process Character Continuity persistence for memory/demo mode and fast tests. Semantics mirror the Postgres
 * implementation and migration 0041: a unique fingerprint per Character, Locks and their images frozen after creation,
 * the images checked against their Assets, one selection per Shot Character assignment that can only name a Lock of
 * the SAME Character whose Look IS the assignment's (null = null), and (like the database's cascade and trigger) a
 * selection that disappears when its Character leaves the Shot or the assignment's Look changes (`onShotSaved`, called
 * by the memory repository whenever a Shot is written).
 */
export class MemoryCharacterContinuityService implements CharacterContinuityRepository {
  private locks: CharacterContinuityLock[] = [];
  private selections = new Map<string, CharacterContinuitySelection>(); // by shot:character

  constructor(private readonly access: MemoryProjectsAccess) {}

  private projectOf(projectId: string): ProjectData | undefined {
    return this.access.all().find((p) => p.project.id === projectId);
  }

  /** The database cascades: a removed Character takes its Locks; a removed Shot / assignment / Lock its selection. */
  private live(projectId: string) {
    const p = this.projectOf(projectId);
    const characters = new Set(p?.characters.map((c) => c.id) ?? []);
    const shots = new Map((p?.shots ?? []).map((s) => [s.id, s]));
    const locks = this.locks.filter((l) => l.projectId === projectId && characters.has(l.characterId));
    const lockIds = new Set(locks.map((l) => l.id));
    const selections = [...this.selections.values()].filter(
      (s) =>
        s.projectId === projectId &&
        lockIds.has(s.continuityLockId) &&
        (shots.get(s.shotId)?.characters.some((c) => c.characterId === s.characterId) ?? false),
    );
    return { locks, selections };
  }

  async listForProject(projectId: string) {
    const { locks, selections } = this.live(projectId);
    return {
      locks: [...locks]
        .sort((a, b) => a.characterId.localeCompare(b.characterId) || b.createdAt.localeCompare(a.createdAt))
        .map(clone),
      selections: selections.map(clone),
    };
  }

  async listForCharacter(projectId: string, characterId: string) {
    return this.live(projectId)
      .locks.filter((l) => l.characterId === characterId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async get(projectId: string, lockId: string) {
    const l = this.live(projectId).locks.find((x) => x.id === lockId);
    return l ? clone(l) : null;
  }

  async create(draft: CharacterContinuityLock): Promise<CreateCharacterContinuityLockResult> {
    const project = this.projectOf(draft.projectId);
    if (!project) throw new CharacterContinuityError("not_found", "That project no longer exists.");
    if (!project.characters.some((c) => c.id === draft.characterId))
      throw new CharacterContinuityError("not_found", "That Character no longer exists in this project.");

    // an identical Lock already exists: return it instead of a duplicate row
    const existing = this.locks.find(
      (l) => l.characterId === draft.characterId && l.lockFingerprint === draft.lockFingerprint,
    );
    if (existing) return { lock: clone(existing), created: false };

    // what the database triggers check: the Look is this Character's, every image a real stored image of THIS
    // project whose facts are the frozen facts
    if (
      draft.sourceLookId &&
      !project.looks.some((l) => l.id === draft.sourceLookId && l.characterId === draft.characterId)
    )
      throw new CharacterContinuityError("wrong_look", "That Look is not one of this Character's Looks.");
    for (const r of draft.references) {
      const asset = project.assets.find((a) => a.id === r.assetId);
      if (!asset || asset.projectId !== draft.projectId)
        throw new CharacterContinuityError("wrong_project", "A Lock image is not in this project.");
      if (
        asset.type !== "image" ||
        !asset.objectPath ||
        asset.checksum !== r.assetChecksum ||
        asset.width !== r.width ||
        asset.height !== r.height
      )
        throw new CharacterContinuityError("invalid", "The Lock image facts do not match its image.");
    }
    const lock = characterContinuityLockSchema.parse(draft);
    this.locks.push(clone(lock));
    return { lock: clone(lock), created: true };
  }

  private assignmentOf(projectId: string, shotId: string, characterId: string) {
    const project = this.projectOf(projectId);
    if (!project) throw new CharacterContinuityError("not_found", "That project no longer exists.");
    const shot = project.shots.find((s) => s.id === shotId);
    if (!shot) throw new CharacterContinuityError("not_found", "That Shot no longer exists.");
    const assignment = shot.characters.find((c) => c.characterId === characterId);
    if (!assignment) throw new CharacterContinuityError("not_found", NOT_ASSIGNED_MESSAGE);
    return assignment;
  }

  private checkExpected(k: string, expected: string | null | undefined) {
    if (expected === undefined) return;
    const current = this.selections.get(k)?.continuityLockId ?? null;
    if (current !== expected)
      throw new CharacterContinuityError("conflict", CONTINUITY_SELECTION_CONFLICT_MESSAGE);
  }

  async selectForAssignment(
    input: SelectCharacterContinuityLockInput,
  ): Promise<CharacterContinuitySelection> {
    const assignment = this.assignmentOf(input.projectId, input.shotId, input.characterId);
    const lock = this.locks.find((l) => l.id === input.continuityLockId);
    if (!lock) throw new CharacterContinuityError("not_found", "That Continuity Lock no longer exists.");
    if (lock.projectId !== input.projectId)
      throw new CharacterContinuityError(
        "wrong_project",
        "That Continuity Lock belongs to a different project.",
      );
    if (lock.characterId !== assignment.characterId)
      throw new CharacterContinuityError("wrong_character", WRONG_CHARACTER_MESSAGE);
    if (lock.sourceLookId !== (assignment.lookId ?? null))
      throw new CharacterContinuityError("wrong_look", WRONG_LOOK_MESSAGE);
    const k = key(input.shotId, input.characterId);
    this.checkExpected(k, input.expectedSelectedLockId);
    const current = this.selections.get(k);
    // re-selecting the Lock that is already selected changes nothing (no spurious write)
    if (current?.continuityLockId === lock.id) return clone(current);
    const selection = characterContinuitySelectionSchema.parse({
      projectId: lock.projectId,
      shotId: input.shotId,
      characterId: input.characterId,
      continuityLockId: lock.id,
      selectedBy: input.userId,
      selectedAt: input.now,
    });
    this.selections.set(k, selection);
    return clone(selection);
  }

  async clearForAssignment(input: ClearCharacterContinuityLockInput): Promise<void> {
    const project = this.projectOf(input.projectId);
    if (!project?.shots.some((s) => s.id === input.shotId))
      throw new CharacterContinuityError("not_found", "That Shot no longer exists.");
    const k = key(input.shotId, input.characterId);
    this.checkExpected(k, input.expectedSelectedLockId);
    if (this.selections.delete(k)) this.access.touchShot?.(input.projectId, input.shotId);
  }

  async selectionsForShot(projectId: string, shotId: string) {
    return this.live(projectId)
      .selections.filter((s) => s.shotId === shotId)
      .map(clone);
  }

  async usesAsset(assetId: string): Promise<boolean> {
    return this.locks.some((l) => l.references.some((r) => r.assetId === assetId));
  }

  /**
   * The memory twin of migration 0041's cascade (assignment removed) and `shot_characters_continuity_selection_clear`
   * trigger (assignment Look changed): a selection whose Character left the Shot, or whose Lock was made for another
   * Look than the assignment now has, is removed at once. Other Characters' selections are untouched.
   */
  onShotSaved(shot: Pick<Shot, "id" | "characters">): void {
    for (const [k, sel] of this.selections) {
      if (sel.shotId !== shot.id) continue;
      const assignment = shot.characters.find((c) => c.characterId === sel.characterId);
      const lock = this.locks.find((l) => l.id === sel.continuityLockId);
      if (!assignment || !lock || lock.sourceLookId !== (assignment.lookId ?? null))
        this.selections.delete(k);
    }
  }
}
