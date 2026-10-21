import type { Pool, PoolClient } from "pg";
import {
  productionFrameSchema,
  productionFrameSelectionSchema,
  type ProductionFrame,
  type ProductionFrameSelection,
} from "@/domain/production-frame";
import { COLLECTIONS, flatToRow } from "./postgres-mapping";
import { upsertRow } from "./postgres-repository";
import {
  ProductionFrameError,
  type CreateProductionFrameResult,
  type NewProductionFrame,
  type ProductionFrameRepository,
  type SelectProductionFrameInput,
} from "./production-frame-repository";

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

const mapFrame = (r: Row): ProductionFrame =>
  productionFrameSchema.parse({
    id: String(r.id),
    projectId: String(r.project_id),
    shotId: String(r.shot_id),
    version: Number(r.version),
    schemaVersion: r.schema_version,
    assetId: String(r.asset_id),
    assetChecksum: String(r.asset_checksum),
    width: Number(r.width),
    height: Number(r.height),
    productionAspectRatio: String(r.production_aspect_ratio),
    source: r.source,
    sourceStoryboardFrameId: str(r.source_storyboard_frame_id),
    sourceMasterFrameId: str(r.source_master_frame_id),
    sourceGenerationAttemptId: str(r.source_generation_attempt_id),
    intentSnapshot: (r.intent_snapshot as Record<string, unknown>) ?? {},
    intentFingerprint: String(r.intent_fingerprint),
    parts: (r.parts as Record<string, string>) ?? {},
    frameFingerprint: String(r.frame_fingerprint),
    createdBy: str(r.created_by),
    createdAt: iso(r.created_at),
  });

const mapSelection = (r: Row): ProductionFrameSelection =>
  productionFrameSelectionSchema.parse({
    projectId: String(r.project_id),
    shotId: String(r.shot_id),
    productionFrameId: String(r.production_frame_id),
    selectedBy: str(r.selected_by),
    selectedAt: iso(r.selected_at),
  });

/** A database refusal (trigger / foreign key / check) as a domain error: the checks in code are never the only barrier. */
function translate(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e.code === "P0001")
    throw new ProductionFrameError("invalid", e.message ?? "The Production Frame was refused.");
  if (e.code === "23503")
    throw new ProductionFrameError("wrong_project", "A referenced row is not in this project.");
  if (e.code === "23505") throw new ProductionFrameError("conflict", "That Production Frame already exists.");
  if (e.code === "23514")
    throw new ProductionFrameError("invalid", "The Production Frame violates a constraint.");
  throw err;
}

/**
 * Postgres Production Frame persistence. `preamble` is the RLS preamble of the signed-in user: Postgres enforces
 * ownership; the worker roles have no grant on these tables at all. Every mutation first locks the Shot row, which
 * serialises concurrent creates (so a per-Shot version is never duplicated) and selection changes (so the
 * compare-and-set sees a stable pointer).
 */
export class PostgresProductionFrameData implements ProductionFrameRepository {
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

  async listForProject(projectId: string) {
    return this.tx(async (c) => {
      const frames = await c.query(
        "select * from shot_production_frames where project_id = $1 order by shot_id, version desc",
        [projectId],
      );
      const selections = await c.query(
        "select * from shot_production_frame_selections where project_id = $1",
        [projectId],
      );
      return { frames: frames.rows.map(mapFrame), selections: selections.rows.map(mapSelection) };
    });
  }

  private async lockShot(c: PoolClient, projectId: string, shotId: string): Promise<void> {
    const r = await c.query("select id from shots where id = $1 and project_id = $2 for update", [
      shotId,
      projectId,
    ]);
    if (!r.rows[0]) throw new ProductionFrameError("not_found", "That Shot no longer exists.");
  }

  private async currentSelection(c: PoolClient, shotId: string): Promise<ProductionFrameSelection | null> {
    const r = await c.query("select * from shot_production_frame_selections where shot_id = $1", [shotId]);
    return r.rows[0] ? mapSelection(r.rows[0]) : null;
  }

  /** Moves the pointer; re-selecting the frame that is already canonical writes nothing. */
  private async writeSelection(
    c: PoolClient,
    frame: ProductionFrame,
    userId: string | null,
    now: string,
  ): Promise<ProductionFrameSelection> {
    const r = await c.query(
      `insert into shot_production_frame_selections (shot_id, project_id, production_frame_id, selected_by, selected_at)
       values ($1, $2, $3, $4, $5)
       on conflict (shot_id) do update
         set production_frame_id = excluded.production_frame_id,
             selected_by = excluded.selected_by,
             selected_at = excluded.selected_at
       where shot_production_frame_selections.production_frame_id <> excluded.production_frame_id
       returning *`,
      [frame.shotId, frame.projectId, frame.id, userId, now],
    );
    if (r.rows[0]) return mapSelection(r.rows[0]);
    return (await this.currentSelection(c, frame.shotId))!;
  }

  async create(input: NewProductionFrame): Promise<CreateProductionFrameResult> {
    const { draft } = input;
    try {
      return await this.tx(async (c) => {
        await this.lockShot(c, draft.projectId, draft.shotId);

        // an identical frame already exists: return it (and select it when asked) instead of a new version
        const dup = await c.query(
          "select * from shot_production_frames where shot_id = $1 and frame_fingerprint = $2",
          [draft.shotId, draft.frameFingerprint],
        );
        if (dup.rows[0]) {
          const frame = mapFrame(dup.rows[0]);
          const selection = input.select
            ? await this.writeSelection(c, frame, input.userId, input.now)
            : await this.currentSelection(c, frame.shotId);
          return { frame, created: false, selection };
        }

        // an upload's Asset is stored in the SAME transaction as its frame: both or neither
        if (input.newAsset) {
          if (input.newAsset.projectId !== draft.projectId)
            throw new ProductionFrameError("wrong_project", "The image belongs to a different project.");
          await upsertRow(c, COLLECTIONS.assets.table, flatToRow(input.newAsset, COLLECTIONS.assets));
        }

        const next = await c.query(
          "select coalesce(max(version), 0) + 1 as n from shot_production_frames where shot_id = $1",
          [draft.shotId],
        );
        const version = Number(next.rows[0].n);
        const inserted = await c.query(
          `insert into shot_production_frames
             (id, project_id, shot_id, version, schema_version, asset_id, asset_checksum, width, height,
              production_aspect_ratio, source, source_storyboard_frame_id, source_master_frame_id,
              source_generation_attempt_id, intent_snapshot, intent_fingerprint, parts, frame_fingerprint,
              created_by, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17::jsonb, $18, $19, $20)
           returning *`,
          [
            draft.id,
            draft.projectId,
            draft.shotId,
            version,
            draft.schemaVersion,
            draft.assetId,
            draft.assetChecksum,
            draft.width,
            draft.height,
            draft.productionAspectRatio,
            draft.source,
            draft.sourceStoryboardFrameId,
            draft.sourceMasterFrameId,
            draft.sourceGenerationAttemptId,
            JSON.stringify(draft.intentSnapshot),
            draft.intentFingerprint,
            JSON.stringify(draft.parts),
            draft.frameFingerprint,
            draft.createdBy,
            draft.createdAt,
          ],
        );
        const frame = mapFrame(inserted.rows[0]);
        const selection = input.select
          ? await this.writeSelection(c, frame, input.userId, input.now)
          : await this.currentSelection(c, frame.shotId);
        return { frame, created: true, selection };
      });
    } catch (err) {
      if (err instanceof ProductionFrameError) throw err;
      return translate(err);
    }
  }

  async select(input: SelectProductionFrameInput): Promise<ProductionFrameSelection> {
    try {
      return await this.tx(async (c) => {
        await this.lockShot(c, input.projectId, input.shotId);
        const found = await c.query("select * from shot_production_frames where id = $1", [
          input.productionFrameId,
        ]);
        if (!found.rows[0])
          throw new ProductionFrameError("not_found", "That Production Frame no longer exists.");
        const frame = mapFrame(found.rows[0]);
        if (frame.projectId !== input.projectId)
          throw new ProductionFrameError(
            "wrong_project",
            "That Production Frame belongs to a different project.",
          );
        if (frame.shotId !== input.shotId)
          throw new ProductionFrameError("wrong_shot", "That Production Frame belongs to a different Shot.");
        if (input.expectedSelectedFrameId !== undefined) {
          const current = (await this.currentSelection(c, input.shotId))?.productionFrameId ?? null;
          if (current !== input.expectedSelectedFrameId)
            throw new ProductionFrameError(
              "conflict",
              "The selected Production Frame changed in the meantime. Reload and choose again.",
            );
        }
        return this.writeSelection(c, frame, input.userId, input.now);
      });
    } catch (err) {
      if (err instanceof ProductionFrameError) throw err;
      return translate(err);
    }
  }

  async usesAsset(assetId: string): Promise<boolean> {
    return this.tx(async (c) => {
      const r = await c.query("select 1 from shot_production_frames where asset_id = $1 limit 1", [assetId]);
      return r.rows.length > 0;
    });
  }
}
