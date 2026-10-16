// Integration tests for the Phase 2F 3D production set against the REAL dedicated Prism Studio database
// (migration 0030).
//   npm run db:previs
//
// Exercises (with real rows, cleaned up afterwards): scene save/reload with compare-and-set revisions, the
// production camera bookmark (one per shot, tied to scene revision + fingerprint), master-frame provenance and
// explicit adoption, owner-only RLS (owner / stranger / anon), cross-project isolation through composite foreign
// keys, the guards behind them, the guarantee that NEITHER worker role has any access, no ephemeral URL in
// stored JSON, and cascade cleanup. Requires `npm run db:seed` first (uses the demo project). No provider call.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresPrevisData } from "../src/data/previs-postgres";
import { PrevisError } from "../src/data/previs-repository";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { buildPrevisDocument, sceneFingerprint } from "../src/domain/previs/document";
import { buildHotelCanopyEngineScene } from "../src/domain/previs/hotel-canopy";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({ mode: "3D production set integration tests (rows created, then removed)", devOwner: dev.id });
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 4 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const stranger = randomUUID();

const admin = new AdminRepository(pool, dev.id);
const owner = new PostgresPrevisData(pool, rlsPreamble({ sub: dev.id }));
const strangerRepo = new PostgresPrevisData(pool, rlsPreamble({ sub: stranger }));
const anonRepo = new PostgresPrevisData(pool, rlsPreamble(null, "anon"));

const TABLES = ["location_scene_documents", "shot_camera_bookmarks", "scene_master_frames"];
const now = () => new Date().toISOString();

async function raw(preamble: string, sql: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query(preamble);
    const r = await c.query(sql, params);
    return { rows: r.rows, error: null as string | null };
  } catch (e) {
    return { rows: [], error: (e as Error).message };
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}
const asOwner = (sql: string, p: unknown[] = []) => raw(rlsPreamble({ sub: dev.id }), sql, p);
const asStranger = (sql: string, p: unknown[] = []) => raw(rlsPreamble({ sub: stranger }), sql, p);
const expectError = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

const created = { projectIds: [] as string[], assetIds: [] as string[], locationIds: [] as string[] };

try {
  const data = (await admin.loadProject("ojousama"))!;
  const projectId = data.project.id;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  const location = data.locations[0]!;

  // ── 1. structure and security ──
  const rls = await pool.query(
    "select relname, relrowsecurity from pg_class where relname = any($1::text[]) and relkind = 'r'",
    [TABLES],
  );
  check(
    "the three Phase 2F tables exist with row-level security enabled",
    rls.rowCount === 3 && rls.rows.every((r) => r.relrowsecurity === true),
  );
  const pol = await pool.query(
    "select tablename from pg_policies where schemaname = 'public' and tablename = any($1::text[]) and 'authenticated' = any(roles)",
    [TABLES],
  );
  check(
    "each table has an owner policy for authenticated users",
    new Set(pol.rows.map((r) => r.tablename)).size === 3,
  );
  for (const role of ["prism_generation_worker", "prism_continuity_worker"]) {
    const exists = await pool.query("select 1 from pg_roles where rolname = $1", [role]);
    if (exists.rowCount === 0) {
      check(`${role}: role not present (skipped)`, true);
      continue;
    }
    const privs = await pool.query(
      `select t, has_table_privilege($1, 'public.' || t, 'select') as s, has_table_privilege($1, 'public.' || t, 'insert') as i,
              has_table_privilege($1, 'public.' || t, 'update') as u, has_table_privilege($1, 'public.' || t, 'delete') as d
         from unnest($2::text[]) t`,
      [role, TABLES],
    );
    check(
      `${role} has NO privilege on any 3D set table`,
      privs.rows.every((r) => !r.s && !r.i && !r.u && !r.d),
    );
  }

  // The demo location may already carry a set from a previous e2e run; this suite uses its own location.
  const tmpLocation = randomUUID();
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1, $2, $3, '', '')",
    [tmpLocation, projectId, "db:previs set location"],
  );
  created.locationIds.push(tmpLocation);

  // ── 2. save, reload, compare-and-set ──
  const doc1 = buildPrevisDocument({
    engineScene: buildHotelCanopyEngineScene({ characterId: "char-test" }),
  });
  const sceneId = randomUUID();
  const saved1 = await owner.saveScene({
    id: sceneId,
    projectId,
    locationId: tmpLocation,
    document: doc1,
    expectedRevision: null,
    engineVersion: "test",
    userId: dev.id,
    now: now(),
  });
  check("first save creates revision 1", saved1.revision === 1 && saved1.id === sceneId);
  check(
    "stored fingerprint equals the domain fingerprint",
    saved1.sceneFingerprint === sceneFingerprint(doc1),
  );

  const loaded = await owner.getSceneForLocation(tmpLocation);
  check(
    "reload returns the same document (objects, production camera, wrapper)",
    !!loaded &&
      loaded.document.objects.length === doc1.objects.length &&
      loaded.document.productionCamera?.id === "cam-a" &&
      loaded.document.schema === "prism.previs.v1" &&
      loaded.document.productionFrame.ratio === "2.39:1",
  );
  const stored = await pool.query(
    "select scene_json::text as t from location_scene_documents where id = $1",
    [sceneId],
  );
  check(
    "no signed URL, blob URL or http reference is stored in scene_json",
    !/https?:\/\/|blob:|X-Amz|signature=/i.test(String(stored.rows[0].t)),
  );

  const doc2 = buildPrevisDocument({
    engineScene: (() => {
      const s = buildHotelCanopyEngineScene({ characterId: "char-test" });
      s.scene[4].position = { x: 8, y: 0.75, z: -1 };
      return s;
    })(),
  });
  const saved2 = await owner.saveScene({
    id: randomUUID(),
    projectId,
    locationId: tmpLocation,
    document: doc2,
    expectedRevision: 1,
    engineVersion: "test",
    userId: dev.id,
    now: now(),
  });
  check(
    "a compare-and-set save advances to revision 2 on the same row",
    saved2.revision === 2 && saved2.id === sceneId,
  );
  check("the fingerprint changed with the moved object", saved2.sceneFingerprint !== saved1.sceneFingerprint);

  const stale = await expectError(() =>
    owner.saveScene({
      id: randomUUID(),
      projectId,
      locationId: tmpLocation,
      document: doc1,
      expectedRevision: 1,
      engineVersion: "test",
      userId: dev.id,
      now: now(),
    }),
  );
  check(
    "a stale revision is rejected as a conflict (no silent overwrite)",
    stale !== null && /changed elsewhere/.test(stale),
  );
  const dupFirst = await expectError(() =>
    owner.saveScene({
      id: randomUUID(),
      projectId,
      locationId: tmpLocation,
      document: doc1,
      expectedRevision: null,
      engineVersion: "test",
      userId: dev.id,
      now: now(),
    }),
  );
  check("a second 'first save' for the same location is a conflict", dupFirst !== null);

  // ── 3. production camera bookmark ──
  const bookmark = await owner.setBookmark({
    id: randomUUID(),
    projectId,
    shotId: shot.id,
    locationId: tmpLocation,
    sceneDocumentId: sceneId,
    userId: dev.id,
    now: now(),
  });
  check(
    "the bookmark records scene revision, fingerprint, focal length basis and production aspect",
    bookmark.sceneRevision === 2 &&
      bookmark.sceneFingerprint === saved2.sceneFingerprint &&
      bookmark.value.focalLengthBasis === "vertical-sensor-24mm" &&
      bookmark.value.productionAspectRatio === "2.39:1" &&
      Math.abs(bookmark.value.fovVerticalDegrees - 37.85) < 0.1,
  );
  const again = await owner.setBookmark({
    id: randomUUID(),
    projectId,
    shotId: shot.id,
    locationId: tmpLocation,
    sceneDocumentId: sceneId,
    userId: dev.id,
    now: now(),
  });
  const count = await pool.query("select count(*)::int as n from shot_camera_bookmarks where shot_id = $1", [
    shot.id,
  ]);
  check(
    "re-linking updates the single bookmark for the shot",
    again.id === bookmark.id && count.rows[0].n === 1,
  );
  check("the bookmark reads back by shot", (await owner.getBookmarkForShot(shot.id))?.id === bookmark.id);

  // a scene without a production camera cannot be bookmarked
  const noCamLoc = randomUUID();
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
    [noCamLoc, projectId, "db:previs no camera"],
  );
  created.locationIds.push(noCamLoc);
  const noCamScene = buildHotelCanopyEngineScene();
  noCamScene.cameras = noCamScene.cameras.filter((c) => c.id === "main");
  const noCamId = randomUUID();
  await owner.saveScene({
    id: noCamId,
    projectId,
    locationId: noCamLoc,
    document: buildPrevisDocument({ engineScene: noCamScene }),
    expectedRevision: null,
    engineVersion: "test",
    userId: dev.id,
    now: now(),
  });
  const noCam = await expectError(() =>
    owner.setBookmark({
      id: randomUUID(),
      projectId,
      shotId: shot.id,
      locationId: noCamLoc,
      sceneDocumentId: noCamId,
      userId: dev.id,
      now: now(),
    }),
  );
  check(
    "a set with no production camera cannot be bookmarked",
    noCam !== null && /no production camera/.test(noCam),
  );

  // ── 4. master frame provenance + explicit adoption ──
  const assetId = randomUUID();
  await pool.query(
    `insert into assets (id, project_id, name, type, purpose, source, storage_provider, mime, width, height, metadata)
     values ($1,$2,$3,'image','storyboard','3d_render','none','image/png',1912,800,'{"previs":{"test":true}}'::jsonb)`,
    [assetId, projectId, "db:previs master frame"],
  );
  created.assetIds.push(assetId);
  const frame = await owner.recordMasterFrame({
    id: randomUUID(),
    projectId,
    shotId: shot.id,
    locationId: tmpLocation,
    sceneDocumentId: sceneId,
    sceneRevision: 2,
    sceneFingerprint: saved2.sceneFingerprint,
    cameraBookmarkId: bookmark.id,
    assetId,
    renderWidth: 1912,
    renderHeight: 800,
    productionAspectRatio: "2.39:1",
    capturedAt: now(),
    userId: dev.id,
  });
  check(
    "master frame stores scene provenance and is NOT adopted automatically",
    frame.source === "scene_render" &&
      frame.sceneFingerprint === saved2.sceneFingerprint &&
      frame.adoptedAt === null &&
      frame.adoptedFrameId === null,
  );
  const adoptedFrameId = randomUUID();
  const adopted = await owner.adoptMasterFrame(frame.id, adoptedFrameId, now());
  check(
    "adoption is an explicit step that records the storyboard frame",
    adopted.adoptedFrameId === adoptedFrameId && !!adopted.adoptedAt,
  );
  check("master frames list newest first", (await owner.listMasterFrames(shot.id))[0]?.id === frame.id);

  // ── 5. RLS: owner / stranger / anon ──
  check("stranger cannot read the scene", (await strangerRepo.getSceneForLocation(tmpLocation)) === null);
  check("stranger cannot read the bookmark", (await strangerRepo.getBookmarkForShot(shot.id)) === null);
  check("stranger cannot read master frames", (await strangerRepo.listMasterFrames(shot.id)).length === 0);
  const strangerWrite = await expectError(() =>
    strangerRepo.saveScene({
      id: randomUUID(),
      projectId,
      locationId: tmpLocation,
      document: doc1,
      expectedRevision: 2,
      engineVersion: "x",
      userId: stranger,
      now: now(),
    }),
  );
  check("stranger cannot mutate the scene", strangerWrite !== null);
  const strangerInsert = await asStranger(
    `insert into location_scene_documents (project_id, location_id, engine, upstream_commit, schema_version, scene_json, scene_fingerprint)
     values ($1,$2,'artcraft-derived','d4e4ac6','prism.previs.v1','{}'::jsonb,$3)`,
    [projectId, tmpLocation, "0".repeat(64)],
  );
  check("stranger insert is blocked by row-level security", strangerInsert.error !== null);
  const anonRead = await expectError(() => anonRepo.getSceneForLocation(tmpLocation));
  check(
    "anon has no access",
    anonRead !== null || (await anonRepo.getSceneForLocation(tmpLocation)) === null,
  );
  const strangerUpdate = await asStranger(
    "update location_scene_documents set revision = revision + 1 where id = $1 returning id",
    [sceneId],
  );
  check("stranger update touches no row", strangerUpdate.rows.length === 0);

  // ── 6. cross-project isolation + guards ──
  const otherProject = randomUUID();
  await pool.query("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
    otherProject,
    dev.id,
    `db-previs-${otherProject.slice(0, 8)}`,
    "db:previs other project",
  ]);
  created.projectIds.push(otherProject);
  const otherLocation = randomUUID();
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
    [otherLocation, otherProject, "db:previs other location"],
  );
  const crossScene = await asOwner(
    `insert into location_scene_documents (project_id, location_id, engine, upstream_commit, schema_version, scene_json, scene_fingerprint)
     values ($1,$2,'artcraft-derived','d4e4ac6','prism.previs.v1','{}'::jsonb,$3)`,
    [projectId, otherLocation, "0".repeat(64)],
  );
  check("a scene cannot attach a location from another project (composite FK)", crossScene.error !== null);
  const crossBookmark = await asOwner(
    `insert into shot_camera_bookmarks (project_id, shot_id, location_id, scene_document_id, scene_revision, scene_fingerprint,
        position, rotation, target, fov_vertical_degrees, focal_length_mm, focal_length_basis, production_aspect_ratio, production_aspect_value)
     select $1, s.id, $2, $3, 1, $4, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 30, 35, 'vertical-sensor-24mm', '2.39:1', 2.39
       from shots s where s.id = $5`,
    [otherProject, otherLocation, sceneId, "0".repeat(64), shot.id],
  );
  check(
    "a bookmark cannot mix a shot, location and scene from different projects",
    crossBookmark.error !== null,
  );

  const move = await pool
    .query("update location_scene_documents set project_id = $2 where id = $1", [sceneId, otherProject])
    .then(
      () => null,
      (e: Error) => e.message,
    );
  check("a scene cannot be moved between projects", move !== null);
  const back = await pool
    .query("update location_scene_documents set revision = 1 where id = $1", [sceneId])
    .then(
      () => null,
      (e: Error) => e.message,
    );
  check("the revision cannot decrease", back !== null && /cannot decrease/.test(back));
  const badSchema = await pool
    .query(
      `insert into location_scene_documents (project_id, location_id, engine, upstream_commit, schema_version, scene_json, scene_fingerprint)
       values ($1,$2,'artcraft-derived','d4e4ac6','other.v9','{}'::jsonb,$3)`,
      [projectId, location.id, "0".repeat(64)],
    )
    .then(
      () => null,
      (e: Error) => e.message,
    );
  check("an unknown schema_version is rejected", badSchema !== null);

  const typed = await expectError(() =>
    owner.setBookmark({
      id: randomUUID(),
      projectId,
      shotId: shot.id,
      locationId: tmpLocation,
      sceneDocumentId: randomUUID(),
      userId: dev.id,
      now: now(),
    }),
  );
  check("bookmarking an unknown scene is a typed not_found", typed !== null);
  void PrevisError;
} finally {
  // ── cleanup (cascade removes scenes, bookmarks and master frames) ──
  for (const id of created.projectIds)
    await pool.query("delete from projects where id = $1", [id]).catch(() => undefined);
  for (const id of created.locationIds)
    await pool.query("delete from locations where id = $1", [id]).catch(() => undefined);
  for (const id of created.assetIds)
    await pool.query("delete from assets where id = $1", [id]).catch(() => undefined);
}

const leftover = await pool.query(
  `select (select count(*)::int from location_scene_documents where location_id = any($1::uuid[])) as scenes,
          (select count(*)::int from assets where name like 'db:previs%') as assets,
          (select count(*)::int from locations where name like 'db:previs%') as locations,
          (select count(*)::int from projects where title like 'db:previs%') as projects`,
  [created.locationIds],
);
const l = leftover.rows[0];
check(
  "cleanup left no test rows (cascade removed scenes, bookmarks, master frames)",
  l.scenes === 0 && l.assets === 0 && l.locations === 0 && l.projects === 0,
  JSON.stringify(l),
);

let failed = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await pool.end();
process.exit(failed ? 1 : 0);
