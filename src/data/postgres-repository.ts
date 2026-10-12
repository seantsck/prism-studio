import type { Pool, PoolClient } from "pg";
import {
  assetSchema,
  bibleSchema,
  projectSchema,
  shotSchema,
  type Asset,
  type CollectionName,
  type Collections,
  type Project,
  type ProjectBible,
  type ProjectData,
  type Shot,
} from "@/domain/schemas";
import type { Repository } from "./repository";
import {
  COLLECTIONS,
  flatFromRow,
  flatToRow,
  locationFromRow,
  locationToRow,
  sceneFromRow,
  sceneToRows,
  shotFromRows,
  shotToRows,
  type CollectionSpec,
  type Row,
} from "./postgres-mapping";
import type { ZodType } from "zod";

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

const PROJECT_SPEC: CollectionSpec = {
  table: "projects",
  schema: projectSchema,
  json: [],
  numeric: [],
  projectScoped: false,
  virtual: [],
};
const BIBLE_SPEC: CollectionSpec = {
  table: "project_bibles",
  schema: bibleSchema,
  json: [],
  numeric: ["defaultFrameRate"],
  projectScoped: true, // project_id is the PK but the schema also carries projectId
  virtual: [],
};

/** Boolean flags guarded by partial unique indexes. */
const FLAG_KEYS: Partial<Record<CollectionName, string>> = {
  takes: "selected",
  frames: "approved",
  attempts: "approved",
};

async function upsertRow(
  db: Pool | PoolClient,
  table: string,
  row: Row,
  conflict: string[] = ["id"],
): Promise<void> {
  const cols = Object.keys(row);
  const params = cols.map((c) => row[c]);
  const updates = cols.filter((c) => !conflict.includes(c));
  const sql =
    `insert into ${q(table)} (${cols.map(q).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ` +
    `on conflict (${conflict.map(q).join(", ")}) ` +
    (updates.length
      ? `do update set ${updates.map((c) => `${q(c)} = excluded.${q(c)}`).join(", ")}`
      : "do nothing");
  await db.query(sql, params);
}

async function insertRows(db: PoolClient, table: string, rows: Row[]): Promise<void> {
  for (const row of rows) {
    const cols = Object.keys(row);
    await db.query(
      `insert into ${q(table)} (${cols.map(q).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) on conflict do nothing`,
      cols.map((c) => row[c]),
    );
  }
}

/**
 * Repository backed by PostgreSQL (Supabase). Connects with a server-side connection string, so it
 * bypasses RLS and MUST scope every query to `ownerUserId` itself. Ownership checks live here.
 */
export class PostgresRepository implements Repository {
  constructor(
    private readonly pool: Pool,
    private readonly ownerUserId: string,
  ) {}

  currentUserId(): string {
    return this.ownerUserId;
  }

  private async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.pool.query(sql, params)).rows as Row[];
  }

  private parse<T>(schema: ZodType<T>, value: unknown): T {
    return schema.parse(value);
  }

  async listProjects(): Promise<Project[]> {
    const rows = await this.rows("select * from projects where user_id = $1 order by created_at", [
      this.ownerUserId,
    ]);
    return rows.map((r) => this.parse(projectSchema, flatFromRow(r, PROJECT_SPEC)));
  }

  async loadProject(slug: string): Promise<ProjectData | null> {
    const projectRow = (
      await this.rows("select * from projects where user_id = $1 and slug = $2", [this.ownerUserId, slug])
    )[0];
    if (!projectRow) return null;
    const projectId = String(projectRow.id);
    const byProject = (table: string) =>
      this.rows(`select * from ${q(table)} where project_id = $1`, [projectId]);
    const viaParent = (join: string, parent: string) =>
      this.rows(
        `select j.* from ${q(join)} j join ${q(parent)} p on p.id = j.${join.startsWith("scene") ? "scene_id" : "shot_id"} where p.project_id = $1`,
        [projectId],
      );

    const [
      bible,
      assets,
      characters,
      identityRefs,
      looks,
      voiceProfiles,
      locations,
      props,
      episodes,
      scenes,
      shots,
      dialogueLines,
      directions,
      takes,
      frames,
      attempts,
      continuityChecks,
      sceneChars,
      sceneProps,
      shotChars,
      shotProps,
      shotLines,
      shotAssets,
    ] = await Promise.all([
      this.rows("select * from project_bibles where project_id = $1", [projectId]),
      byProject("assets"),
      byProject("characters"),
      byProject("character_identity_refs"),
      byProject("character_looks"),
      byProject("voice_profiles"),
      byProject("locations"),
      byProject("props"),
      this.rows('select * from episodes where project_id = $1 order by "order"', [projectId]),
      this.rows('select * from scenes where project_id = $1 order by "order"', [projectId]),
      this.rows('select * from shots where project_id = $1 order by "order"', [projectId]),
      this.rows('select * from dialogue_lines where project_id = $1 order by "order"', [projectId]),
      byProject("performance_directions"),
      byProject("performance_takes"),
      byProject("storyboard_frames"),
      byProject("generation_attempts"),
      byProject("continuity_checks"),
      viaParent("scene_characters", "scenes"),
      viaParent("scene_props", "scenes"),
      viaParent("shot_characters", "shots"),
      viaParent("shot_props", "shots"),
      viaParent("shot_dialogue_lines", "shots"),
      viaParent("shot_reference_assets", "shots"),
    ]);
    if (!bible[0]) throw new Error(`Project ${slug} has no bible row`);

    const C = COLLECTIONS;
    const flat = <K extends CollectionName>(name: K, rows: Row[]): Collections[K] =>
      rows.map((r) => this.parse(C[name].schema, flatFromRow(r, C[name]))) as unknown as Collections[K];
    const forId = (rows: Row[], key: string, id: unknown) => rows.filter((r) => r[key] === id);

    return {
      project: this.parse(projectSchema, flatFromRow(projectRow, PROJECT_SPEC)),
      bible: this.parse(bibleSchema, flatFromRow(bible[0], BIBLE_SPEC)),
      assets: flat("assets", assets),
      characters: flat("characters", characters),
      identityRefs: flat("identityRefs", identityRefs),
      looks: flat("looks", looks),
      voiceProfiles: flat("voiceProfiles", voiceProfiles),
      locations: locations.map((r) =>
        this.parse(C.locations.schema, locationFromRow(r)),
      ) as Collections["locations"],
      props: flat("props", props),
      episodes: flat("episodes", episodes),
      scenes: scenes.map((r) =>
        this.parse(
          C.scenes.schema,
          sceneFromRow(
            r,
            forId(sceneChars, "scene_id", r.id).map((x) => String(x.character_id)),
            forId(sceneProps, "scene_id", r.id).map((x) => String(x.prop_id)),
          ),
        ),
      ) as Collections["scenes"],
      shots: shots.map((r) =>
        this.parse(
          shotSchema,
          shotFromRows(r, {
            characters: forId(shotChars, "shot_id", r.id),
            props: forId(shotProps, "shot_id", r.id),
            lines: forId(shotLines, "shot_id", r.id),
            assets: forId(shotAssets, "shot_id", r.id),
          }),
        ),
      ),
      dialogueLines: flat("dialogueLines", dialogueLines),
      directions: flat("directions", directions),
      takes: flat("takes", takes),
      frames: flat("frames", frames),
      attempts: flat("attempts", attempts),
      continuityChecks: flat("continuityChecks", continuityChecks),
    };
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
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

  private async assertOwns(db: Pool | PoolClient, projectId: string): Promise<void> {
    const r = await db.query("select 1 from projects where id = $1 and user_id = $2", [
      projectId,
      this.ownerUserId,
    ]);
    if (r.rowCount === 0) throw new Error(`Project ${projectId} not found for the current user`);
  }

  async createProject(project: Project, bible: ProjectBible): Promise<void> {
    if (project.userId !== this.ownerUserId) throw new Error("Project must belong to the current user");
    await this.tx(async (c) => {
      await upsertRow(c, "projects", flatToRow(project, PROJECT_SPEC));
      await upsertRow(c, "project_bibles", flatToRow(bible, BIBLE_SPEC), ["project_id"]);
    });
  }

  async updateProject(project: Project): Promise<void> {
    await this.assertOwns(this.pool, project.id);
    await upsertRow(this.pool, "projects", flatToRow({ ...project, userId: this.ownerUserId }, PROJECT_SPEC));
  }

  async saveBible(bible: ProjectBible): Promise<void> {
    await this.assertOwns(this.pool, bible.projectId);
    await upsertRow(this.pool, "project_bibles", flatToRow(bible, BIBLE_SPEC), ["project_id"]);
  }

  async upsert<K extends CollectionName>(
    projectId: string,
    name: K,
    item: Collections[K][number],
  ): Promise<void> {
    await this.assertOwns(this.pool, projectId);
    await this.tx((c) => this.write(c, projectId, name, item));
  }

  async upsertMany<K extends CollectionName>(
    projectId: string,
    name: K,
    items: Collections[K],
  ): Promise<void> {
    await this.assertOwns(this.pool, projectId);
    await this.tx(async (c) => {
      let list = items as unknown as Array<Collections[K][number]>;
      if (name === "shots") {
        list = (await this.orderShotsByDependency(
          c,
          projectId,
          list as unknown as Shot[],
        )) as unknown as typeof list;
      }
      // Partial unique indexes (one selected take / approved frame / approved attempt) are checked per
      // statement, so rows that are being switched OFF must be written before rows switched ON.
      const flag = FLAG_KEYS[name];
      if (flag) {
        list = [...list].sort(
          (a, b) =>
            Number((a as Record<string, unknown>)[flag]) - Number((b as Record<string, unknown>)[flag]),
        );
      }
      for (const item of list) await this.write(c, projectId, name, item);
    });
  }

  /** previous_shot_id is a self-FK: insert shots after the shot they follow. */
  private async orderShotsByDependency(c: PoolClient, projectId: string, shots: Shot[]): Promise<Shot[]> {
    const existing = new Set(
      (await c.query("select id from shots where project_id = $1", [projectId])).rows.map((r) =>
        String(r.id),
      ),
    );
    const pending = [...shots];
    const out: Shot[] = [];
    while (pending.length) {
      const i = pending.findIndex((s) => {
        const prev = s.continuity.previousShotId;
        return !prev || existing.has(prev) || !pending.some((p) => p.id === prev);
      });
      const [next] = pending.splice(i === -1 ? 0 : i, 1);
      out.push(next);
      existing.add(next.id);
    }
    return out;
  }

  private async write(c: PoolClient, projectId: string, name: CollectionName, item: unknown): Promise<void> {
    const s = COLLECTIONS[name];
    s.schema.parse(item);

    if (name === "shots") {
      const rows = shotToRows(item as Shot);
      await upsertRow(c, "shots", { ...rows.shot, project_id: projectId });
      const id = (item as Shot).id;
      for (const t of ["shot_characters", "shot_props", "shot_dialogue_lines", "shot_reference_assets"]) {
        await c.query(`delete from ${q(t)} where shot_id = $1`, [id]);
      }
      await insertRows(c, "shot_characters", rows.characters);
      await insertRows(c, "shot_props", rows.props);
      await insertRows(c, "shot_dialogue_lines", rows.lines);
      await insertRows(c, "shot_reference_assets", rows.assets);
      return;
    }

    if (name === "scenes") {
      const rows = sceneToRows(item as Collections["scenes"][number]);
      await upsertRow(c, "scenes", { ...rows.scene, project_id: projectId });
      const id = (item as { id: string }).id;
      await c.query("delete from scene_characters where scene_id = $1", [id]);
      await c.query("delete from scene_props where scene_id = $1", [id]);
      await insertRows(c, "scene_characters", rows.characters);
      await insertRows(c, "scene_props", rows.props);
      return;
    }

    const row =
      name === "locations"
        ? locationToRow(item as Collections["locations"][number])
        : flatToRow(item as object, s);
    if (s.projectScoped) row.project_id = projectId;
    await upsertRow(c, s.table, row);
  }

  async remove(projectId: string, name: CollectionName, id: string): Promise<void> {
    await this.assertOwns(this.pool, projectId);
    await this.pool.query(`delete from ${q(COLLECTIONS[name].table)} where id = $1 and project_id = $2`, [
      id,
      projectId,
    ]);
  }

  async findAsset(assetId: string): Promise<Asset | null> {
    const rows = await this.rows(
      "select a.* from assets a join projects p on p.id = a.project_id where a.id = $1 and p.user_id = $2",
      [assetId, this.ownerUserId],
    );
    return rows[0] ? this.parse(assetSchema, flatFromRow(rows[0], COLLECTIONS.assets)) : null;
  }
}
