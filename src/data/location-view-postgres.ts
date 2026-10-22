import type { Pool, PoolClient } from "pg";
import {
  locationViewSchema,
  locationViewSelectionSchema,
  type LocationView,
  type LocationViewSelection,
} from "@/domain/location-view";
import { COLLECTIONS, flatToRow } from "./postgres-mapping";
import { upsertRow } from "./postgres-repository";
import {
  LocationViewError,
  SELECTION_CONFLICT_MESSAGE,
  WRONG_LOCATION_MESSAGE,
  type ClearLocationViewInput,
  type CreateLocationViewResult,
  type LocationViewRepository,
  type NewLocationView,
  type SelectLocationViewInput,
} from "./location-view-repository";

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

const mapView = (r: Row): LocationView =>
  locationViewSchema.parse({
    id: String(r.id),
    projectId: String(r.project_id),
    locationId: String(r.location_id),
    schemaVersion: r.schema_version,
    name: String(r.name),
    kind: r.kind,
    assetId: String(r.asset_id),
    assetChecksum: String(r.asset_checksum),
    width: Number(r.width),
    height: Number(r.height),
    source: r.source,
    sourceProductionFrameId: str(r.source_production_frame_id),
    sourceStoryboardFrameId: str(r.source_storyboard_frame_id),
    sourceMasterFrameId: str(r.source_master_frame_id),
    viewSpec: r.view_spec,
    viewFingerprint: String(r.view_fingerprint),
    createdBy: str(r.created_by),
    createdAt: iso(r.created_at),
  });

const mapSelection = (r: Row): LocationViewSelection =>
  locationViewSelectionSchema.parse({
    projectId: String(r.project_id),
    shotId: String(r.shot_id),
    locationViewId: String(r.location_view_id),
    locationId: String(r.location_id),
    selectedBy: str(r.selected_by),
    selectedAt: iso(r.selected_at),
  });

/** A database refusal (trigger / foreign key / check) as a domain error: the checks in code are never the only barrier. */
function translate(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e.code === "P0001") {
    if (e.message?.includes("Shot set in that Location"))
      throw new LocationViewError("wrong_location", WRONG_LOCATION_MESSAGE);
    throw new LocationViewError("invalid", e.message ?? "The Location View was refused.");
  }
  if (e.code === "23503")
    throw new LocationViewError("wrong_project", "A referenced row is not in this project.");
  if (e.code === "23505") throw new LocationViewError("conflict", "That Location View already exists.");
  if (e.code === "23514") throw new LocationViewError("invalid", "The Location View violates a constraint.");
  throw err;
}

/**
 * Postgres Location View persistence. `preamble` is the RLS preamble of the signed-in user: Postgres enforces
 * ownership; the worker roles have no grant on these tables. A create locks the Location row (concurrent identical
 * creates never duplicate a view); a selection change locks the Shot row (the compare-and-set sees a stable pointer,
 * and the Shot's Location cannot change underneath it). The same-Location rule is ALSO a database trigger.
 */
export class PostgresLocationViewData implements LocationViewRepository {
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
      if (err instanceof LocationViewError) throw err;
      return translate(err);
    }
  }

  async listForProject(projectId: string) {
    return this.tx(async (c) => {
      const views = await c.query(
        "select * from location_views where project_id = $1 order by location_id, created_at desc",
        [projectId],
      );
      const selections = await c.query("select * from shot_location_view_selections where project_id = $1", [
        projectId,
      ]);
      return { views: views.rows.map(mapView), selections: selections.rows.map(mapSelection) };
    });
  }

  async listForLocation(projectId: string, locationId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from location_views where project_id = $1 and location_id = $2 order by created_at desc",
        [projectId, locationId],
      );
      return r.rows.map(mapView);
    });
  }

  async get(projectId: string, viewId: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from location_views where id = $1 and project_id = $2", [
        viewId,
        projectId,
      ]);
      return r.rows[0] ? mapView(r.rows[0]) : null;
    });
  }

  async create(input: NewLocationView): Promise<CreateLocationViewResult> {
    const { draft } = input;
    return this.guarded(async (c) => {
      const loc = await c.query("select id from locations where id = $1 and project_id = $2 for update", [
        draft.locationId,
        draft.projectId,
      ]);
      if (!loc.rows[0])
        throw new LocationViewError("not_found", "That Location no longer exists in this project.");

      const dup = await c.query(
        "select * from location_views where location_id = $1 and view_fingerprint = $2",
        [draft.locationId, draft.viewFingerprint],
      );
      if (dup.rows[0]) return { view: mapView(dup.rows[0]), created: false };

      // an upload's Asset is stored in the SAME transaction as its view: both or neither
      if (input.newAsset) {
        if (input.newAsset.projectId !== draft.projectId)
          throw new LocationViewError("wrong_project", "The image belongs to a different project.");
        await upsertRow(c, COLLECTIONS.assets.table, flatToRow(input.newAsset, COLLECTIONS.assets));
      }

      const inserted = await c.query(
        `insert into location_views
           (id, project_id, location_id, schema_version, name, kind, asset_id, asset_checksum, width, height, source,
            source_production_frame_id, source_storyboard_frame_id, source_master_frame_id, view_spec,
            view_fingerprint, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18)
         returning *`,
        [
          draft.id,
          draft.projectId,
          draft.locationId,
          draft.schemaVersion,
          draft.name,
          draft.kind,
          draft.assetId,
          draft.assetChecksum,
          draft.width,
          draft.height,
          draft.source,
          draft.sourceProductionFrameId,
          draft.sourceStoryboardFrameId,
          draft.sourceMasterFrameId,
          JSON.stringify(draft.viewSpec),
          draft.viewFingerprint,
          draft.createdBy,
          draft.createdAt,
        ],
      );
      return { view: mapView(inserted.rows[0]), created: true };
    });
  }

  /** Locks the Shot row and returns its current Location. */
  private async lockShot(c: PoolClient, projectId: string, shotId: string): Promise<string | null> {
    const r = await c.query("select location_id from shots where id = $1 and project_id = $2 for update", [
      shotId,
      projectId,
    ]);
    if (!r.rows[0]) throw new LocationViewError("not_found", "That Shot no longer exists.");
    return str(r.rows[0].location_id);
  }

  private async currentSelection(c: PoolClient, shotId: string): Promise<LocationViewSelection | null> {
    const r = await c.query("select * from shot_location_view_selections where shot_id = $1", [shotId]);
    return r.rows[0] ? mapSelection(r.rows[0]) : null;
  }

  private async checkExpected(c: PoolClient, shotId: string, expected: string | null | undefined) {
    if (expected === undefined) return;
    const current = (await this.currentSelection(c, shotId))?.locationViewId ?? null;
    if (current !== expected) throw new LocationViewError("conflict", SELECTION_CONFLICT_MESSAGE);
  }

  async selectForShot(input: SelectLocationViewInput): Promise<LocationViewSelection> {
    return this.guarded(async (c) => {
      const shotLocation = await this.lockShot(c, input.projectId, input.shotId);
      const found = await c.query("select * from location_views where id = $1", [input.locationViewId]);
      if (!found.rows[0]) throw new LocationViewError("not_found", "That Location View no longer exists.");
      const view = mapView(found.rows[0]);
      if (view.projectId !== input.projectId)
        throw new LocationViewError("wrong_project", "That Location View belongs to a different project.");
      if (view.locationId !== shotLocation)
        throw new LocationViewError("wrong_location", WRONG_LOCATION_MESSAGE);
      await this.checkExpected(c, input.shotId, input.expectedSelectedViewId);
      const r = await c.query(
        `insert into shot_location_view_selections (shot_id, project_id, location_view_id, location_id, selected_by, selected_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (shot_id) do update
           set location_view_id = excluded.location_view_id,
               location_id = excluded.location_id,
               selected_by = excluded.selected_by,
               selected_at = excluded.selected_at
         where shot_location_view_selections.location_view_id <> excluded.location_view_id
         returning *`,
        [input.shotId, input.projectId, view.id, view.locationId, input.userId, input.now],
      );
      // re-selecting the view that is already selected writes nothing
      return r.rows[0] ? mapSelection(r.rows[0]) : (await this.currentSelection(c, input.shotId))!;
    });
  }

  async clearForShot(input: ClearLocationViewInput): Promise<void> {
    await this.guarded(async (c) => {
      await this.lockShot(c, input.projectId, input.shotId);
      await this.checkExpected(c, input.shotId, input.expectedSelectedViewId);
      await c.query("delete from shot_location_view_selections where shot_id = $1 and project_id = $2", [
        input.shotId,
        input.projectId,
      ]);
    });
  }

  async selectionForShot(projectId: string, shotId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from shot_location_view_selections where shot_id = $1 and project_id = $2",
        [shotId, projectId],
      );
      return r.rows[0] ? mapSelection(r.rows[0]) : null;
    });
  }

  async usesAsset(assetId: string): Promise<boolean> {
    return this.tx(async (c) => {
      const r = await c.query("select 1 from location_views where asset_id = $1 limit 1", [assetId]);
      return r.rows.length > 0;
    });
  }
}
