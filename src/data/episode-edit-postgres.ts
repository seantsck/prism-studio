import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AttemptMediaFacts } from "@/domain/edit/eligibility";
import type { AudioPlacement, EditItem, EpisodeEdit, VisualSource } from "@/domain/edit/model";
import type { Asset, GenerationAttempt } from "@/domain/schemas";
import {
  addsOf,
  applyEditOps,
  assertEditValid,
  editRefs,
  emptyEdit,
  type EditRefs,
  type EditSourceFacts,
} from "./episode-edit-ops";
import {
  EDIT_EXISTS_MESSAGE,
  EDIT_REVISION_CONFLICT_MESSAGE,
  EpisodeEditError,
  SHOT_ALREADY_IN_EDIT_MESSAGE,
  type ApplyEpisodeEditInput,
  type CreateEpisodeEditInput,
  type DeleteEpisodeEditInput,
  type EpisodeEditRepository,
} from "./episode-edit-repository";
import { COLLECTIONS, flatFromRow } from "./postgres-mapping";

type Row = Record<string, unknown>;

const num = (v: unknown): number => Number(v);
const str = (v: unknown): string | null => (v == null ? null : String(v));

const mapVisual = (r: Row): VisualSource => {
  switch (r.visual_kind) {
    case "video":
      return {
        kind: "video",
        attemptId: String(r.attempt_id),
        assetId: String(r.asset_id),
        sourceInMs: num(r.source_in_ms),
        sourceOutMs: num(r.source_out_ms),
      };
    case "production_frame":
      return {
        kind: "production_frame",
        productionFrameId: String(r.production_frame_id),
        durationMs: num(r.duration_ms),
      };
    case "storyboard_frame":
      return {
        kind: "storyboard_frame",
        storyboardFrameId: String(r.storyboard_frame_id),
        durationMs: num(r.duration_ms),
      };
    default:
      return { kind: "none", durationMs: num(r.duration_ms) };
  }
};

const mapPlacement = (r: Row): AudioPlacement => ({
  dialogueLineId: String(r.dialogue_line_id),
  takeId: String(r.take_id),
  startMs: num(r.start_ms),
  takeInMs: num(r.take_in_ms),
  takeOutMs: num(r.take_out_ms),
});

const mapItem = (r: Row, placements: Row[]): EditItem => {
  const basis = r.performance_basis as { performance: string; timing: string } | null;
  return {
    id: String(r.id),
    shotId: String(r.shot_id),
    visual: mapVisual(r),
    sourceAudio: r.source_audio === "included" ? "included" : "muted",
    performance: placements.filter((p) => String(p.item_id) === String(r.id)).map(mapPlacement),
    performanceBasis: basis ? { performance: basis.performance, timing: basis.timing } : null,
  };
};

/** The picture columns of an item (exactly the columns of its kind; the others null). */
const visualColumns = (v: VisualSource) => ({
  visual_kind: v.kind,
  attempt_id: v.kind === "video" ? v.attemptId : null,
  asset_id: v.kind === "video" ? v.assetId : null,
  source_in_ms: v.kind === "video" ? v.sourceInMs : null,
  source_out_ms: v.kind === "video" ? v.sourceOutMs : null,
  production_frame_id: v.kind === "production_frame" ? v.productionFrameId : null,
  storyboard_frame_id: v.kind === "storyboard_frame" ? v.storyboardFrameId : null,
  duration_ms: v.kind === "video" ? null : v.durationMs,
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A database refusal (trigger / key / check) as a domain error: the checks in code are never the only barrier. */
function translate(err: unknown): never {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e.code === "P0001") {
    const m = e.message ?? "";
    if (m.includes("another Shot")) throw new EpisodeEditError("wrong_shot", m);
    if (
      /Production Frame candidate|not a video|not an output|no known duration|outside the clip|completed generation/.test(
        m,
      )
    )
      throw new EpisodeEditError("invalid_source", m);
    throw new EpisodeEditError("invalid", m || "The edit change was refused.");
  }
  if (e.code === "23505") {
    if (e.constraint === "episode_edits_one_per_episode")
      throw new EpisodeEditError("conflict", EDIT_EXISTS_MESSAGE);
    if (e.constraint === "episode_edit_items_one_per_shot")
      throw new EpisodeEditError("conflict", SHOT_ALREADY_IN_EDIT_MESSAGE);
    throw new EpisodeEditError("conflict", "The edit changed in the meantime. Reload and try again.");
  }
  if (e.code === "23503")
    throw new EpisodeEditError("wrong_project", "A referenced row is not in this project or this Episode.");
  if (e.code === "23514") throw new EpisodeEditError("invalid", "The edit change violates a constraint.");
  throw err;
}

/**
 * Postgres Episode edit persistence (migration 0043). `preamble` is the RLS preamble of the signed-in user: Postgres
 * enforces ownership; the worker roles have no grant on these tables.
 *
 * A mutation is one transaction: `select … from episode_edits … for update` (the edit row is the concurrency
 * authority), compare `revision`, load exactly the referenced rows, plan and validate with the shared rules
 * (episode-edit-ops.ts, the domain checks), write the difference (removed items first, so a Shot can leave and re-enter
 * in one change; positions are deferred-unique, so any reorder is valid at commit), bump `revision` by exactly one,
 * commit. A stale revision or any refusal rolls back everything. The database triggers re-check every written row.
 */
export class PostgresEpisodeEditData implements EpisodeEditRepository {
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
      if (err instanceof EpisodeEditError) throw err;
      return translate(err);
    }
  }

  private async editsWhere(c: PoolClient, where: string, params: unknown[]): Promise<EpisodeEdit[]> {
    const edits = await c.query(`select * from episode_edits where ${where} order by episode_id, id`, params);
    if (edits.rows.length === 0) return [];
    const ids = edits.rows.map((r) => r.id);
    const items = await c.query(
      "select * from episode_edit_items where edit_id = any($1::uuid[]) order by position",
      [ids],
    );
    const placements = await c.query(
      `select p.* from episode_edit_audio_placements p join episode_edit_items i on i.id = p.item_id
        where i.edit_id = any($1::uuid[]) order by p.start_ms, p.dialogue_line_id`,
      [ids],
    );
    return edits.rows.map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      episodeId: String(r.episode_id),
      editRate: { num: num(r.edit_rate_num), den: num(r.edit_rate_den) },
      revision: num(r.revision),
      items: items.rows
        .filter((i) => String(i.edit_id) === String(r.id))
        .map((i) => mapItem(i, placements.rows)),
    }));
  }

  async get(projectId: string, editId: string) {
    return this.tx(
      async (c) => (await this.editsWhere(c, "id = $1 and project_id = $2", [editId, projectId]))[0] ?? null,
    );
  }

  async getForEpisode(projectId: string, episodeId: string) {
    return this.tx(
      async (c) =>
        (await this.editsWhere(c, "episode_id = $1 and project_id = $2", [episodeId, projectId]))[0] ?? null,
    );
  }

  async listForProject(projectId: string) {
    return this.tx((c) => this.editsWhere(c, "project_id = $1", [projectId]));
  }

  /** Exactly the rows the ops reference (in the caller's RLS scope); the approved attempt of a replacement is locked. */
  private async loadFacts(c: PoolClient, refs: EditRefs): Promise<EditSourceFacts> {
    const rows = async (sql: string, ids: string[]) => (ids.length ? (await c.query(sql, [ids])).rows : []);
    const attemptRows = [
      ...(await rows("select * from generation_attempts where id = any($1::uuid[])", refs.attemptIds)),
      ...(await rows(
        "select * from generation_attempts where shot_id = any($1::uuid[]) and approved for share",
        refs.replacementShotIds,
      )),
    ];
    const attempts = new Map<string, GenerationAttempt>();
    for (const r of attemptRows)
      attempts.set(
        String(r.id),
        COLLECTIONS.attempts.schema.parse(flatFromRow(r, COLLECTIONS.attempts)) as GenerationAttempt,
      );
    const attemptIds = [...attempts.keys()];
    const outputs = await rows(
      "select attempt_id, asset_id, role from generation_outputs where attempt_id = any($1::uuid[])",
      attemptIds,
    );
    const versions = await rows(
      `select attempt_id, child_asset_id, parent_asset_id, version from asset_derivations
        where attempt_id = any($1::uuid[]) and slot = 'delivery'`,
      attemptIds,
    );
    const deliveries = await rows(
      "select attempt_id, asset_id from attempt_deliveries where attempt_id = any($1::uuid[])",
      attemptIds,
    );
    const assetIds = [
      ...new Set([
        ...refs.assetIds,
        ...outputs.map((o) => String(o.asset_id)),
        ...versions.map((v) => String(v.child_asset_id)),
      ]),
    ];
    const assets = (await rows("select * from assets where id = any($1::uuid[])", assetIds)).map(
      (r) => COLLECTIONS.assets.schema.parse(flatFromRow(r, COLLECTIONS.assets)) as Asset,
    );
    const media = new Map<string, AttemptMediaFacts>();
    for (const id of attemptIds)
      media.set(id, {
        attemptId: id,
        outputs: outputs
          .filter((o) => String(o.attempt_id) === id)
          .map((o) => ({
            assetId: String(o.asset_id),
            role: o.role as AttemptMediaFacts["outputs"][number]["role"],
          })),
        deliveryVersions: versions
          .filter((v) => String(v.attempt_id) === id)
          .map((v) => ({
            assetId: String(v.child_asset_id),
            parentAssetId: String(v.parent_asset_id),
            version: num(v.version),
          })),
        deliveryAssetId: str(deliveries.find((d) => String(d.attempt_id) === id)?.asset_id),
      });
    const frame = (r: Row) => ({
      id: String(r.id),
      shotId: String(r.shot_id),
      projectId: String(r.project_id),
    });
    return {
      shots: (
        await rows("select id, project_id, episode_id from shots where id = any($1::uuid[])", refs.shotIds)
      ).map((r) => ({ id: String(r.id), projectId: String(r.project_id), episodeId: String(r.episode_id) })),
      clip: { attempts: [...attempts.values()], assets },
      media: { attempts: media, bestPointers: [] },
      storyboardFrames: (
        await rows(
          "select id, shot_id, project_id from storyboard_frames where id = any($1::uuid[])",
          refs.storyboardFrameIds,
        )
      ).map(frame),
      productionFrames: (
        await rows(
          "select id, shot_id, project_id from shot_production_frames where id = any($1::uuid[])",
          refs.productionFrameIds,
        )
      ).map(frame),
      takes: (
        await rows(
          "select id, dialogue_line_id, duration_ms, archived, project_id from performance_takes where id = any($1::uuid[])",
          refs.takeIds,
        )
      ).map((r) => ({
        id: String(r.id),
        dialogueLineId: String(r.dialogue_line_id),
        durationMs: num(r.duration_ms),
        archived: Boolean(r.archived),
        projectId: String(r.project_id),
      })),
    };
  }

  private async insertPlacements(c: PoolClient, projectId: string, item: EditItem) {
    for (const p of item.performance)
      await c.query(
        `insert into episode_edit_audio_placements
           (project_id, item_id, dialogue_line_id, take_id, start_ms, take_in_ms, take_out_ms)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [projectId, item.id, p.dialogueLineId, p.takeId, p.startMs, p.takeInMs, p.takeOutMs],
      );
  }

  private async insertItem(
    c: PoolClient,
    edit: EpisodeEdit,
    item: EditItem,
    position: number,
    userId: string | null,
    now: string,
  ) {
    const v = visualColumns(item.visual);
    await c.query(
      `insert into episode_edit_items
         (id, project_id, edit_id, episode_id, shot_id, position, visual_kind, attempt_id, asset_id, source_in_ms,
          source_out_ms, production_frame_id, storyboard_frame_id, duration_ms, performance_basis, source_audio,
          placed_by, placed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18)`,
      [
        item.id,
        edit.projectId,
        edit.id,
        edit.episodeId,
        item.shotId,
        position,
        v.visual_kind,
        v.attempt_id,
        v.asset_id,
        v.source_in_ms,
        v.source_out_ms,
        v.production_frame_id,
        v.storyboard_frame_id,
        v.duration_ms,
        item.performanceBasis ? JSON.stringify(item.performanceBasis) : null,
        item.sourceAudio,
        userId,
        now,
      ],
    );
    await this.insertPlacements(c, edit.projectId, item);
  }

  /** Writes next − current: removals first, then changed items (placements cleared before a picture change), then adds. */
  private async writeDifference(
    c: PoolClient,
    current: EpisodeEdit,
    next: EpisodeEdit,
    userId: string | null,
    now: string,
  ) {
    const nextIds = new Set(next.items.map((i) => i.id));
    const removed = current.items.filter((i) => !nextIds.has(i.id)).map((i) => i.id);
    if (removed.length) await c.query("delete from episode_edit_items where id = any($1::uuid[])", [removed]);
    const before = new Map(current.items.map((i, position) => [i.id, { item: i, position }]));
    for (const [position, item] of next.items.entries()) {
      const prev = before.get(item.id);
      if (!prev) {
        await this.insertItem(c, next, item, position, userId, now);
        continue;
      }
      const performanceChanged = !same(prev.item.performance, item.performance);
      if (performanceChanged)
        await c.query("delete from episode_edit_audio_placements where item_id = $1", [item.id]);
      if (!same(prev.item.visual, item.visual)) {
        const v = visualColumns(item.visual);
        await c.query(
          `update episode_edit_items set visual_kind = $2, attempt_id = $3, asset_id = $4, source_in_ms = $5,
             source_out_ms = $6, production_frame_id = $7, storyboard_frame_id = $8, duration_ms = $9,
             placed_by = $10, placed_at = $11
           where id = $1`,
          [
            item.id,
            v.visual_kind,
            v.attempt_id,
            v.asset_id,
            v.source_in_ms,
            v.source_out_ms,
            v.production_frame_id,
            v.storyboard_frame_id,
            v.duration_ms,
            userId,
            now,
          ],
        );
      }
      if (
        prev.position !== position ||
        prev.item.sourceAudio !== item.sourceAudio ||
        !same(prev.item.performanceBasis, item.performanceBasis)
      )
        await c.query(
          "update episode_edit_items set position = $2, source_audio = $3, performance_basis = $4::jsonb where id = $1",
          [
            item.id,
            position,
            item.sourceAudio,
            item.performanceBasis ? JSON.stringify(item.performanceBasis) : null,
          ],
        );
      if (performanceChanged) await this.insertPlacements(c, next.projectId, item);
    }
  }

  async create(input: CreateEpisodeEditInput): Promise<EpisodeEdit> {
    return this.guarded(async (c) => {
      const ep = await c.query("select id, project_id from episodes where id = $1", [input.episodeId]);
      if (!ep.rows[0]) throw new EpisodeEditError("not_found", "That Episode no longer exists.");
      if (String(ep.rows[0].project_id) !== input.projectId)
        throw new EpisodeEditError("wrong_project", "That Episode belongs to another project.");
      const exists = await c.query("select 1 from episode_edits where episode_id = $1", [input.episodeId]);
      if (exists.rows[0]) throw new EpisodeEditError("conflict", EDIT_EXISTS_MESSAGE);

      const base = emptyEdit({
        id: randomUUID(),
        projectId: input.projectId,
        episodeId: input.episodeId,
        editRate: input.editRate,
      });
      const ops = addsOf(input.items);
      const facts = await this.loadFacts(c, editRefs(base, ops));
      const plan = applyEditOps(base, ops, facts, randomUUID);
      assertEditValid(plan, facts, base);
      await c.query(
        `insert into episode_edits (id, project_id, episode_id, edit_rate_num, edit_rate_den, created_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [
          base.id,
          base.projectId,
          base.episodeId,
          base.editRate.num,
          base.editRate.den,
          input.userId,
          input.now,
        ],
      );
      for (const [position, item] of plan.next.items.entries())
        await this.insertItem(c, base, item, position, input.userId, input.now);
      // deferred keys are checked at commit; the stored record is read back as the source of truth
      return (await this.editsWhere(c, "id = $1", [base.id]))[0]!;
    });
  }

  /** Locks the edit row and compares the revision (the edit row is the concurrency authority). */
  private async lockEdit(c: PoolClient, projectId: string, editId: string, expectedRevision: number) {
    const r = await c.query("select project_id, revision from episode_edits where id = $1 for update", [
      editId,
    ]);
    if (!r.rows[0]) throw new EpisodeEditError("not_found", "That edit no longer exists.");
    if (String(r.rows[0].project_id) !== projectId)
      throw new EpisodeEditError("wrong_project", "That edit belongs to another project.");
    if (num(r.rows[0].revision) !== expectedRevision)
      throw new EpisodeEditError("conflict", EDIT_REVISION_CONFLICT_MESSAGE);
  }

  async apply(input: ApplyEpisodeEditInput): Promise<EpisodeEdit> {
    return this.guarded(async (c) => {
      await this.lockEdit(c, input.projectId, input.editId, input.expectedRevision);
      const current = (await this.editsWhere(c, "id = $1", [input.editId]))[0]!;
      const facts = await this.loadFacts(c, editRefs(current, input.ops));
      const plan = applyEditOps(current, input.ops, facts, randomUUID);
      assertEditValid(plan, facts, current);
      await this.writeDifference(c, current, plan.next, input.userId, input.now);
      await c.query("update episode_edits set revision = revision + 1 where id = $1", [input.editId]);
      return (await this.editsWhere(c, "id = $1", [input.editId]))[0]!;
    });
  }

  async delete(input: DeleteEpisodeEditInput): Promise<void> {
    await this.guarded(async (c) => {
      await this.lockEdit(c, input.projectId, input.editId, input.expectedRevision);
      await c.query("delete from episode_edits where id = $1", [input.editId]);
    });
  }

  async usesAsset(assetId: string): Promise<boolean> {
    return this.tx(async (c) => {
      const r = await c.query("select 1 from episode_edit_items where asset_id = $1 limit 1", [assetId]);
      return r.rows.length > 0;
    });
  }
}
