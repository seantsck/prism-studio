import type { Pool, PoolClient } from "pg";
import {
  characterContinuityLockSchema,
  characterContinuitySelectionSchema,
  type CharacterContinuityLock,
  type CharacterContinuitySelection,
} from "@/domain/character-continuity";
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

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

const mapLock = (r: Row, members: Row[]): CharacterContinuityLock =>
  characterContinuityLockSchema.parse({
    id: String(r.id),
    projectId: String(r.project_id),
    characterId: String(r.character_id),
    sourceLookId: str(r.source_look_id),
    schemaVersion: r.schema_version,
    name: String(r.name),
    facts: r.facts_snapshot,
    references: members
      .filter((m) => String(m.lock_id) === String(r.id))
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((m) => ({
        position: Number(m.position),
        assetId: String(m.asset_id),
        role: m.role,
        identitySlot: str(m.identity_slot),
        label: String(m.label),
        assetChecksum: String(m.asset_checksum),
        width: Number(m.width),
        height: Number(m.height),
      })),
    lockFingerprint: String(r.lock_fingerprint),
    createdBy: str(r.created_by),
    createdAt: iso(r.created_at),
  });

const mapSelection = (r: Row): CharacterContinuitySelection =>
  characterContinuitySelectionSchema.parse({
    projectId: String(r.project_id),
    shotId: String(r.shot_id),
    characterId: String(r.character_id),
    continuityLockId: String(r.continuity_lock_id),
    selectedBy: str(r.selected_by),
    selectedAt: iso(r.selected_at),
  });

/** A database refusal (trigger / foreign key / check) as a domain error: the checks in code are never the only barrier. */
function translate(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e.code === "P0001") {
    if (e.message?.includes("same Character and Look"))
      throw new CharacterContinuityError("wrong_look", WRONG_LOOK_MESSAGE);
    if (e.message?.includes("Look is not a Look of this Character"))
      throw new CharacterContinuityError("wrong_look", "That Look is not one of this Character's Looks.");
    throw new CharacterContinuityError("invalid", e.message ?? "The Continuity Lock was refused.");
  }
  if (e.code === "23503")
    throw new CharacterContinuityError("wrong_project", "A referenced row is not in this project.");
  if (e.code === "23505")
    throw new CharacterContinuityError("conflict", "That Continuity Lock already exists.");
  if (e.code === "23514")
    throw new CharacterContinuityError("invalid", "The Continuity Lock violates a constraint.");
  throw err;
}

/**
 * Postgres Character Continuity persistence. `preamble` is the RLS preamble of the signed-in user: Postgres enforces
 * ownership; the worker roles have no grant on these tables. A create locks the Character row (concurrent identical
 * creates never duplicate a Lock) and writes the Lock and its images in ONE transaction (the database refuses an
 * incomplete membership at commit). A selection change locks the Shot row (the compare-and-set sees a stable pointer,
 * and the assignment's Look cannot change underneath it). The same-Character / same-Look rule is ALSO enforced by the
 * database (composite foreign key + trigger).
 */
export class PostgresCharacterContinuityData implements CharacterContinuityRepository {
  constructor(
    private readonly pool: Pool,
    private readonly preamble: string,
  ) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(this.preamble);
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async guarded<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.tx(fn);
    } catch (err) {
      if (err instanceof CharacterContinuityError) throw err;
      return translate(err);
    }
  }

  private async locksWhere(
    c: PoolClient,
    where: string,
    params: unknown[],
  ): Promise<CharacterContinuityLock[]> {
    const locks = await c.query(
      `select * from character_continuity_locks where ${where} order by character_id, created_at desc, id`,
      params,
    );
    if (locks.rows.length === 0) return [];
    const members = await c.query(
      "select * from character_continuity_lock_assets where lock_id = any($1::uuid[]) order by lock_id, position",
      [locks.rows.map((r) => r.id)],
    );
    return locks.rows.map((r) => mapLock(r, members.rows));
  }

  async listForProject(projectId: string) {
    return this.tx(async (c) => {
      const locks = await this.locksWhere(c, "project_id = $1", [projectId]);
      const selections = await c.query(
        "select * from shot_character_continuity_selections where project_id = $1",
        [projectId],
      );
      return { locks, selections: selections.rows.map(mapSelection) };
    });
  }

  async listForCharacter(projectId: string, characterId: string) {
    return this.tx((c) =>
      this.locksWhere(c, "project_id = $1 and character_id = $2", [projectId, characterId]),
    );
  }

  async get(projectId: string, lockId: string) {
    return this.tx(
      async (c) => (await this.locksWhere(c, "id = $1 and project_id = $2", [lockId, projectId]))[0] ?? null,
    );
  }

  async create(draft: CharacterContinuityLock): Promise<CreateCharacterContinuityLockResult> {
    return this.guarded(async (c) => {
      const ch = await c.query("select id from characters where id = $1 and project_id = $2 for update", [
        draft.characterId,
        draft.projectId,
      ]);
      if (!ch.rows[0])
        throw new CharacterContinuityError("not_found", "That Character no longer exists in this project.");

      const dup = await this.locksWhere(c, "character_id = $1 and lock_fingerprint = $2", [
        draft.characterId,
        draft.lockFingerprint,
      ]);
      if (dup[0]) return { lock: dup[0], created: false };

      await c.query(
        `insert into character_continuity_locks
           (id, project_id, character_id, source_look_id, schema_version, name, facts_snapshot, reference_count,
            lock_fingerprint, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
        [
          draft.id,
          draft.projectId,
          draft.characterId,
          draft.sourceLookId,
          draft.schemaVersion,
          draft.name,
          JSON.stringify(draft.facts),
          draft.references.length,
          draft.lockFingerprint,
          draft.createdBy,
          draft.createdAt,
        ],
      );
      for (const r of draft.references)
        await c.query(
          `insert into character_continuity_lock_assets
             (lock_id, project_id, position, asset_id, role, identity_slot, label, asset_checksum, width, height)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            draft.id,
            draft.projectId,
            r.position,
            r.assetId,
            r.role,
            r.identitySlot,
            r.label,
            r.assetChecksum,
            r.width,
            r.height,
          ],
        );
      // the deferred membership check runs at commit; the stored record is read back as the source of truth
      const stored = await this.locksWhere(c, "id = $1", [draft.id]);
      return { lock: stored[0]!, created: true };
    });
  }

  /** Locks the Shot row and returns the assignment of the Character (refused when not assigned). */
  private async lockAssignment(
    c: PoolClient,
    projectId: string,
    shotId: string,
    characterId: string,
  ): Promise<{ lookId: string | null }> {
    const shot = await c.query("select id from shots where id = $1 and project_id = $2 for update", [
      shotId,
      projectId,
    ]);
    if (!shot.rows[0]) throw new CharacterContinuityError("not_found", "That Shot no longer exists.");
    const a = await c.query("select look_id from shot_characters where shot_id = $1 and character_id = $2", [
      shotId,
      characterId,
    ]);
    if (!a.rows[0]) throw new CharacterContinuityError("not_found", NOT_ASSIGNED_MESSAGE);
    return { lookId: str(a.rows[0].look_id) };
  }

  private async currentSelection(
    c: PoolClient,
    shotId: string,
    characterId: string,
  ): Promise<CharacterContinuitySelection | null> {
    const r = await c.query(
      "select * from shot_character_continuity_selections where shot_id = $1 and character_id = $2",
      [shotId, characterId],
    );
    return r.rows[0] ? mapSelection(r.rows[0]) : null;
  }

  private async checkExpected(
    c: PoolClient,
    shotId: string,
    characterId: string,
    expected: string | null | undefined,
  ) {
    if (expected === undefined) return;
    const current = (await this.currentSelection(c, shotId, characterId))?.continuityLockId ?? null;
    if (current !== expected)
      throw new CharacterContinuityError("conflict", CONTINUITY_SELECTION_CONFLICT_MESSAGE);
  }

  async selectForAssignment(
    input: SelectCharacterContinuityLockInput,
  ): Promise<CharacterContinuitySelection> {
    return this.guarded(async (c) => {
      const assignment = await this.lockAssignment(c, input.projectId, input.shotId, input.characterId);
      const found = await c.query(
        "select id, project_id, character_id, source_look_id from character_continuity_locks where id = $1",
        [input.continuityLockId],
      );
      const lock = found.rows[0];
      if (!lock) throw new CharacterContinuityError("not_found", "That Continuity Lock no longer exists.");
      if (String(lock.project_id) !== input.projectId)
        throw new CharacterContinuityError(
          "wrong_project",
          "That Continuity Lock belongs to a different project.",
        );
      if (String(lock.character_id) !== input.characterId)
        throw new CharacterContinuityError("wrong_character", WRONG_CHARACTER_MESSAGE);
      if (str(lock.source_look_id) !== assignment.lookId)
        throw new CharacterContinuityError("wrong_look", WRONG_LOOK_MESSAGE);
      await this.checkExpected(c, input.shotId, input.characterId, input.expectedSelectedLockId);
      const r = await c.query(
        `insert into shot_character_continuity_selections
           (shot_id, character_id, project_id, continuity_lock_id, selected_by, selected_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (shot_id, character_id) do update
           set continuity_lock_id = excluded.continuity_lock_id,
               selected_by = excluded.selected_by,
               selected_at = excluded.selected_at
         where shot_character_continuity_selections.continuity_lock_id <> excluded.continuity_lock_id
         returning *`,
        [input.shotId, input.characterId, input.projectId, input.continuityLockId, input.userId, input.now],
      );
      // re-selecting the Lock that is already selected writes nothing
      return r.rows[0]
        ? mapSelection(r.rows[0])
        : (await this.currentSelection(c, input.shotId, input.characterId))!;
    });
  }

  async clearForAssignment(input: ClearCharacterContinuityLockInput): Promise<void> {
    await this.guarded(async (c) => {
      const shot = await c.query("select id from shots where id = $1 and project_id = $2 for update", [
        input.shotId,
        input.projectId,
      ]);
      if (!shot.rows[0]) throw new CharacterContinuityError("not_found", "That Shot no longer exists.");
      await this.checkExpected(c, input.shotId, input.characterId, input.expectedSelectedLockId);
      await c.query(
        "delete from shot_character_continuity_selections where shot_id = $1 and character_id = $2 and project_id = $3",
        [input.shotId, input.characterId, input.projectId],
      );
    });
  }

  async selectionsForShot(projectId: string, shotId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from shot_character_continuity_selections where shot_id = $1 and project_id = $2 order by character_id",
        [shotId, projectId],
      );
      return r.rows.map(mapSelection);
    });
  }

  async usesAsset(assetId: string): Promise<boolean> {
    return this.tx(async (c) => {
      const r = await c.query("select 1 from character_continuity_lock_assets where asset_id = $1 limit 1", [
        assetId,
      ]);
      return r.rows.length > 0;
    });
  }
}
