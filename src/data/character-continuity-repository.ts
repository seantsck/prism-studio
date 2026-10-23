import type { CharacterContinuityLock, CharacterContinuitySelection } from "@/domain/character-continuity";

/**
 * Persistence contract for Phase 2G.4 Character Continuity Locks: the IMMUTABLE Locks of each Character (with their
 * frozen reference images) and the ONE mutable selection pointer per Shot Character assignment. The application path
 * only (acts as the signed-in user; RLS applies in Postgres). Neither worker role has any access: a worker consumes the
 * frozen request/package, never these tables.
 *
 * Implementations: src/data/character-continuity-memory.ts and src/data/character-continuity-postgres.ts (same
 * semantics as migration 0041). Reads reach the domain through ProjectData (the server loaders attach
 * `characterContinuityLocks` and `shotCharacterContinuitySelections`).
 */
export class CharacterContinuityError extends Error {
  constructor(
    readonly code: "not_found" | "wrong_project" | "wrong_character" | "wrong_look" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "CharacterContinuityError";
  }
}

export interface CreateCharacterContinuityLockResult {
  lock: CharacterContinuityLock;
  /** false: an identical Lock (same Character, Look, facts and image bytes) already existed and was returned. */
  created: boolean;
}

export interface SelectCharacterContinuityLockInput {
  projectId: string;
  shotId: string;
  characterId: string;
  continuityLockId: string;
  userId: string | null;
  now: string;
  /**
   * Compare-and-set on what the caller saw: a Lock id, `null` (expected none), or `undefined` (unconditional). A
   * mismatch is a `conflict`, so two browser tabs never silently overwrite each other's choice.
   */
  expectedSelectedLockId?: string | null;
}

export interface ClearCharacterContinuityLockInput {
  projectId: string;
  shotId: string;
  characterId: string;
  expectedSelectedLockId?: string | null;
}

export interface CharacterContinuityRepository {
  /** Every Lock and every assignment selection of a project, for the loaders. */
  listForProject(
    projectId: string,
  ): Promise<{ locks: CharacterContinuityLock[]; selections: CharacterContinuitySelection[] }>;
  /** The Locks of one Character, newest first. */
  listForCharacter(projectId: string, characterId: string): Promise<CharacterContinuityLock[]>;
  get(projectId: string, lockId: string): Promise<CharacterContinuityLock | null>;
  /**
   * Stores the Lock and its frozen reference images together (all-or-nothing). An identical Lock (same Character and
   * fingerprint) is returned instead of duplicated, also under concurrent identical creates.
   */
  create(draft: CharacterContinuityLock): Promise<CreateCharacterContinuityLockResult>;
  /**
   * Moves the assignment's pointer to a Lock of the SAME Character whose Look IS the assignment's current Look (null =
   * null). Touches no Shot, Character, Look or Lock row. Refusals: `wrong_project`, `wrong_character`, `wrong_look`,
   * `not_found` (the Character is not assigned to the Shot), `conflict` (compare-and-set).
   */
  selectForAssignment(input: SelectCharacterContinuityLockInput): Promise<CharacterContinuitySelection>;
  /** Removes the assignment's pointer (no-op when none). Compare-and-set like `selectForAssignment`. */
  clearForAssignment(input: ClearCharacterContinuityLockInput): Promise<void>;
  selectionsForShot(projectId: string, shotId: string): Promise<CharacterContinuitySelection[]>;
  /** Whether any Character Continuity Lock (of any project the caller owns) froze this Asset. */
  usesAsset(assetId: string): Promise<boolean>;
}

export const CONTINUITY_SELECTION_CONFLICT_MESSAGE =
  "The selected Character Continuity Lock changed in the meantime. Reload and choose again.";
export const WRONG_CHARACTER_MESSAGE =
  "That Continuity Lock belongs to a different Character than this assignment's.";
export const WRONG_LOOK_MESSAGE =
  "That Continuity Lock was made for a different Look than this Shot assigns. Choose a Lock made for the assigned Look, or create one from the current appearance.";
export const NOT_ASSIGNED_MESSAGE = "That Character is not assigned to this Shot.";
