// Integration tests for Phase 4B Shot Lighting Rigs against the REAL dedicated PostgreSQL database (migration 0048:
// shot_light_rigs, render lighting provenance and the render-history provenance guards).
//   npm run db:lighting
//
// Exercises (with real rows, cleaned up afterwards): structure and constraints, one rig per Shot, compare-and-set,
// project-safe foreign keys, owner-only RLS, anon and both worker roles denied, the render provenance pair, every
// permitted and refused mutation of both guards, FK SET NULL, DELETE and cascades, and the package reference.
// Requires `npm run db:seed` first (uses the demo project). No provider call.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { PostgresPrevisData } from "../src/data/previs-postgres";
import { buildPrevisDocument } from "../src/domain/previs/document";
import { buildHotelCanopyCameraPath, buildHotelCanopyEngineScene } from "../src/domain/previs/hotel-canopy";
import {
  SHOT_LIGHTING_SCHEMA,
  authoredLightingIntent,
  buildRenderLighting,
  lightingFingerprint,
  newShotLight,
  parseShotLightingRig,
} from "../src/domain/previs/lighting";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "Shot Lighting integration tests (rows created, then removed)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 4 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const stranger = randomUUID();

const admin = new AdminRepository(pool, dev.id);
const owner = new PostgresPrevisData(pool, rlsPreamble({ sub: dev.id }));
const strangerRepo = new PostgresPrevisData(pool, rlsPreamble({ sub: stranger }));
const now = () => new Date().toISOString();

async function raw(preamble: string, sql: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query(preamble);
    const r = await c.query(sql, params);
    return { rows: r.rows, rowCount: r.rowCount ?? 0, error: null as string | null };
  } catch (e) {
    return { rows: [], rowCount: 0, error: (e as Error).message };
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}
const sqlErr = (sql: string, params: unknown[] = []) =>
  pool.query(sql, params).then(
    () => null as string | null,
    (e: Error) => e.message,
  );
const err = (fn: () => Promise<unknown>) =>
  fn().then(
    () => null as string | null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );

const created = { projectIds: [] as string[], assetIds: [] as string[], locationIds: [] as string[] };
// the suite's Shots' original Locations, restored on cleanup (see the tmpLocation assignment below)
let restoreShotLocations: Array<{ id: string; location_id: string | null }> = [];

try {
  const data = (await admin.loadProject("ojousama"))!;
  const projectId = data.project.id;
  const shotA = data.shots.find((s) => s.shotCode === "2A")!;
  const shotB = data.shots.find((s) => s.shotCode === "2B")!;

  // ── 1. structure ──
  const rls = await pool.query("select relrowsecurity from pg_class where relname = 'shot_light_rigs'");
  check("shot_light_rigs exists with row-level security", rls.rows[0]?.relrowsecurity === true);
  const pol = await pool.query(
    "select 1 from pg_policies where tablename = 'shot_light_rigs' and 'authenticated' = any(roles)",
  );
  check("an owner policy exists for authenticated users", pol.rowCount === 1);
  const defs = await pool.query(
    `select proname from pg_proc where prosecdef and proname in
       ('guard_shot_light_rig', 'guard_scene_master_frame_provenance', 'guard_shot_previs_clip_provenance')`,
  );
  check("no guard is SECURITY DEFINER", defs.rowCount === 0);
  for (const col of ["lighting_fingerprint", "lighting_json"])
    for (const table of ["scene_master_frames", "shot_previs_clips"]) {
      const c = await pool.query(
        "select is_nullable from information_schema.columns where table_name = $1 and column_name = $2",
        [table, col],
      );
      check(`${table}.${col} is nullable`, c.rows[0]?.is_nullable === "YES");
    }

  // ── 2. privileges ──
  const privs = async (role: string) => {
    const p = await pool.query(
      `select has_table_privilege($1, 'public.shot_light_rigs', 'select') as s,
              has_table_privilege($1, 'public.shot_light_rigs', 'insert') as i,
              has_table_privilege($1, 'public.shot_light_rigs', 'update') as u,
              has_table_privilege($1, 'public.shot_light_rigs', 'delete') as d`,
      [role],
    );
    return p.rows[0] as { s: boolean; i: boolean; u: boolean; d: boolean };
  };
  const auth = await privs("authenticated");
  check("authenticated holds the four table privileges", auth.s && auth.i && auth.u && auth.d);
  const anonP = await privs("anon");
  check("anon holds no privilege", !anonP.s && !anonP.i && !anonP.u && !anonP.d);
  // real statements, not only catalogue lookups: each must fail on privilege before any constraint or RLS runs
  const writes: Array<[string, string]> = [
    [
      "insert",
      `insert into shot_light_rigs (id, project_id, shot_id, location_id, scene_document_id, scene_revision,
         scene_fingerprint, schema_version, revision, rig_json, lighting_fingerprint)
       values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1,
         repeat('a', 64), 'prism.shot-lighting.v1', 1, '{}'::jsonb, repeat('a', 64))`,
    ],
    ["update", "update shot_light_rigs set revision = revision"],
    ["delete", "delete from shot_light_rigs"],
  ];
  const deniedWrites = async (label: string, preamble: string) => {
    for (const [verb, sql] of writes) {
      const r = await raw(preamble, sql);
      check(`${label} is denied a real ${verb}`, /permission denied/.test(r.error ?? ""), r.error ?? "");
    }
  };
  for (const role of ["prism_generation_worker", "prism_continuity_worker"]) {
    const p = await privs(role);
    check(`${role} holds no privilege`, !p.s && !p.i && !p.u && !p.d);
    const denied = await raw(`begin; set local role ${role}`, "select * from shot_light_rigs");
    check(`${role} is denied a real read`, /permission denied/.test(denied.error ?? ""), denied.error ?? "");
    await deniedWrites(role, `begin; set local role ${role}`);
  }
  const anonRead = await raw(rlsPreamble(null, "anon"), "select * from shot_light_rigs");
  check("anon is denied a real read", /permission denied/.test(anonRead.error ?? ""), anonRead.error ?? "");
  await deniedWrites("anon", rlsPreamble(null, "anon"));

  // ── fixtures: a private set ──
  const tmpLocation = randomUUID();
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
    [tmpLocation, projectId, "db:lighting set location"],
  );
  created.locationIds.push(tmpLocation);
  // Phase 4C: a spatialReference describes a Shot's CURRENT Location only (old-Location rows are history, never
  // projected), so the suite's Shot(s) are assigned to its private set for the run and restored afterwards
  restoreShotLocations = (
    await pool.query("select id, location_id from shots where id = any($1::uuid[])", [[shotA.id, shotB.id]])
  ).rows as typeof restoreShotLocations;
  await pool.query("update shots set location_id = $2 where id = any($1::uuid[])", [
    [shotA.id, shotB.id],
    tmpLocation,
  ]);
  const sceneId = randomUUID();
  const scene = await owner.saveScene({
    id: sceneId,
    projectId,
    locationId: tmpLocation,
    document: buildPrevisDocument({ engineScene: buildHotelCanopyEngineScene() }),
    expectedRevision: null,
    engineVersion: "test",
    userId: dev.id,
    now: now(),
  });
  const rigOf = (intensity: number) =>
    parseShotLightingRig({
      schema: SHOT_LIGHTING_SCHEMA,
      base: { mode: "replace" },
      lights: [{ ...newShotLight("point", "key"), intensity }],
      authoredIntent: authoredLightingIntent(shotA),
    });
  const save = (
    repo: PostgresPrevisData,
    shotId: string,
    intensity: number,
    expectedRevision: number | null,
    over: Record<string, unknown> = {},
  ) =>
    repo.saveLightingRig({
      id: randomUUID(),
      projectId,
      shotId,
      locationId: tmpLocation,
      sceneDocumentId: sceneId,
      sceneRevision: scene.revision,
      sceneFingerprint: scene.sceneFingerprint,
      rig: rigOf(intensity),
      expectedRevision,
      userId: dev.id,
      now: now(),
      ...over,
    });

  // ── 3. save / CAS / one per Shot ──
  const one = await save(owner, shotA.id, 10, null);
  check(
    "first save is revision 1 and the fingerprint is derived",
    one.revision === 1 && one.lightingFingerprint === lightingFingerprint(rigOf(10)),
  );
  const two = await save(owner, shotA.id, 20, 1);
  check("a save increments by exactly one, keeping the id", two.revision === 2 && two.id === one.id);
  check(
    "a stale revision is refused",
    /changed elsewhere/.test((await err(() => save(owner, shotA.id, 30, 1))) ?? ""),
  );
  check(
    "a second first save is refused (one rig per Shot)",
    /changed elsewhere/.test((await err(() => save(owner, shotA.id, 30, null))) ?? ""),
  );
  const back = await owner.getLightingRigForShot(shotA.id);
  check("the rig reads back by value", back?.rig.lights[0]?.type === "point" && back.revision === 2);
  check(
    "a stored rig reads back with its server-frozen authored intent",
    back?.rig.authoredIntent.lighting.mood === shotA.lighting.mood,
  );
  check(
    "list for project includes it",
    (await owner.listLightingRigsForProject(projectId)).some((r) => r.id === one.id),
  );
  const sceneAfter = await pool.query(
    "select revision, scene_fingerprint from location_scene_documents where id = $1",
    [sceneId],
  );
  check(
    "saving a rig changes nothing on the scene document",
    sceneAfter.rows[0].revision === scene.revision &&
      sceneAfter.rows[0].scene_fingerprint === scene.sceneFingerprint,
  );

  // ── 4. constraints ──
  const insert = (over: Record<string, unknown>) => {
    const v = {
      project_id: projectId,
      shot_id: shotB.id,
      location_id: tmpLocation,
      scene_document_id: sceneId,
      scene_fingerprint: "0".repeat(64),
      schema_version: SHOT_LIGHTING_SCHEMA,
      rig_json: JSON.stringify(rigOf(1)),
      lighting_fingerprint: "0".repeat(64),
      ...over,
    };
    return sqlErr(
      `insert into shot_light_rigs (project_id, shot_id, location_id, scene_document_id, scene_revision,
         scene_fingerprint, schema_version, rig_json, lighting_fingerprint)
       values ($1,$2,$3,$4,1,$5,$6,$7::jsonb,$8)`,
      [
        v.project_id,
        v.shot_id,
        v.location_id,
        v.scene_document_id,
        v.scene_fingerprint,
        v.schema_version,
        v.rig_json,
        v.lighting_fingerprint,
      ],
    );
  };
  const refused = async (name: string, over: Record<string, unknown>, pattern: RegExp) => {
    const e = await insert(over);
    check(name, e !== null && pattern.test(e), e ?? "accepted");
  };
  await refused(
    "a short lighting fingerprint is refused",
    { lighting_fingerprint: "abc" },
    /lighting_fingerprint/,
  );
  await refused("a short scene fingerprint is refused", { scene_fingerprint: "abc" }, /scene_fingerprint/);
  await refused("another schema version is refused", { schema_version: "other.v2" }, /schema_version/);
  await refused("non-object rig JSON is refused", { rig_json: "[]" }, /shot_light_rigs_shape/);
  await refused(
    "rig JSON whose schema disagrees is refused",
    { rig_json: JSON.stringify({ ...rigOf(1), schema: "other" }) },
    /shot_light_rigs_shape/,
  );
  await refused(
    "an unknown base mode is refused",
    { rig_json: JSON.stringify({ ...rigOf(1), base: { mode: "hdri" } }) },
    /shot_light_rigs_shape/,
  );
  await refused(
    "more than 16 lights are refused",
    { rig_json: JSON.stringify({ ...rigOf(1), lights: Array.from({ length: 17 }, () => ({})) }) },
    /shot_light_rigs_shape/,
  );
  await refused(
    "rig JSON with no authored intent is refused",
    { rig_json: JSON.stringify({ schema: SHOT_LIGHTING_SCHEMA, base: { mode: "replace" }, lights: [] }) },
    /shot_light_rigs_shape/,
  );

  // project-safe foreign keys
  const otherProject = randomUUID();
  await pool.query("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
    otherProject,
    dev.id,
    `db-lighting-${otherProject.slice(0, 8)}`,
    "db:lighting other project",
  ]);
  created.projectIds.push(otherProject);
  await refused("a Shot of another project is refused", { project_id: otherProject }, /foreign key/);
  const otherLocation = randomUUID();
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
    [otherLocation, projectId, "db:lighting second location"],
  );
  created.locationIds.push(otherLocation);
  await refused(
    "a scene document of a different Location is refused",
    { location_id: otherLocation },
    /foreign key/,
  );

  // update guard
  const updateErr = (set: string, params: unknown[] = []) =>
    sqlErr(`update shot_light_rigs set ${set}, revision = revision + 1 where id = '${one.id}'`, params);
  check(
    "a rig cannot move to another Shot",
    /cannot move/.test((await updateErr("shot_id = $1", [shotB.id])) ?? ""),
  );
  check(
    "a rig cannot move to another Location",
    /cannot move/.test((await updateErr("location_id = $1", [otherLocation])) ?? ""),
  );
  check(
    "a rig cannot be pointed at another set",
    /cannot move/.test((await updateErr("scene_document_id = $1", [randomUUID()])) ?? ""),
  );
  check(
    "a revision cannot jump or repeat",
    /exactly one/.test(
      (await sqlErr("update shot_light_rigs set revision = revision + 5 where id = $1", [one.id])) ?? "",
    ) &&
      /exactly one/.test(
        (await sqlErr("update shot_light_rigs set scene_revision = 1 where id = $1", [one.id])) ?? "",
      ),
  );
  const upd = await pool.query("select updated_at from shot_light_rigs where id = $1", [one.id]);
  await new Promise((r) => setTimeout(r, 20));
  await pool.query("update shot_light_rigs set revision = revision + 1 where id = $1", [one.id]);
  const upd2 = await pool.query("select updated_at, revision from shot_light_rigs where id = $1", [one.id]);
  check("updated_at moves on update", upd2.rows[0].updated_at > upd.rows[0].updated_at);
  const liveRevision = Number(upd2.rows[0].revision);

  // ── 5. RLS ──
  check(
    "a stranger cannot read a rig",
    (await strangerRepo.getLightingRigForShot(shotA.id)) === null &&
      (await strangerRepo.listLightingRigsForProject(projectId)).length === 0,
  );
  check("a stranger cannot save one", (await err(() => save(strangerRepo, shotB.id, 1, null))) !== null);
  const strangerUpdate = await raw(
    rlsPreamble({ sub: stranger }),
    "update shot_light_rigs set revision = revision + 1 where id = $1",
    [one.id],
  );
  check("a stranger's update reaches no row", strangerUpdate.rowCount === 0);
  const strangerDelete = await raw(
    rlsPreamble({ sub: stranger }),
    "delete from shot_light_rigs where id = $1",
    [one.id],
  );
  check("a stranger's delete reaches no row", strangerDelete.rowCount === 0);
  const ownerRead = await raw(rlsPreamble({ sub: dev.id }), "select id from shot_light_rigs where id = $1", [
    one.id,
  ]);
  check("the owner reads it through RLS", ownerRead.rowCount === 1);

  // ── 6. render provenance ──
  const mkAsset = async (name: string, type: string, mime: string, source: string) => {
    const id = randomUUID();
    await pool.query(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, mime, metadata)
       values ($1,$2,$3,$4,'storyboard',$5,'none',$6,'{}'::jsonb)`,
      [id, projectId, name, type, source, mime],
    );
    created.assetIds.push(id);
    return id;
  };
  const current = (await owner.getLightingRigForShot(shotA.id))!;
  const lighting = buildRenderLighting({ rig: current, scene: scene.document });
  const bookmark = await owner.setBookmark({
    id: randomUUID(),
    projectId,
    shotId: shotA.id,
    locationId: tmpLocation,
    sceneDocumentId: sceneId,
    userId: dev.id,
    now: now(),
  });
  const frameAsset = await mkAsset("db:lighting frame", "image", "image/png", "3d_render");
  const frameInput = (over: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    projectId,
    shotId: shotA.id,
    locationId: tmpLocation,
    sceneDocumentId: sceneId,
    sceneRevision: scene.revision,
    sceneFingerprint: scene.sceneFingerprint,
    cameraBookmarkId: bookmark.id,
    assetId: frameAsset,
    renderWidth: 1912,
    renderHeight: 800,
    productionAspectRatio: "2.39:1",
    capturedAt: now(),
    userId: dev.id,
    ...over,
  });
  const frame = await owner.recordMasterFrame({
    ...frameInput(),
    lightingFingerprint: current.lightingFingerprint,
    lighting,
  });
  check(
    "a lit Master Frame stores and reads back its provenance",
    frame.lightingFingerprint === current.lightingFingerprint && frame.lighting?.rigId === current.id,
  );
  const unlit = await owner.recordMasterFrame(frameInput());
  check(
    "an unlit Master Frame stores null/null",
    unlit.lightingFingerprint === null && unlit.lighting === null,
  );

  const insertFrameLighting = (fp: string | null, json: string | null) =>
    sqlErr(
      `insert into scene_master_frames (project_id, shot_id, location_id, scene_document_id, scene_revision,
         scene_fingerprint, asset_id, render_width, render_height, production_aspect_ratio, captured_at,
         lighting_fingerprint, lighting_json)
       select project_id, shot_id, location_id, scene_document_id, scene_revision, scene_fingerprint, asset_id,
              render_width, render_height, production_aspect_ratio, captured_at, $2, $3::jsonb
         from scene_master_frames where id = $1`,
      [unlit.id, fp, json],
    );
  const LIT_JSON = JSON.stringify(lighting);
  const LIT_FP = lighting.rigFingerprint;
  check(
    "Master Frame: a fingerprint without JSON is refused",
    /lighting_check/.test((await insertFrameLighting(LIT_FP, null)) ?? ""),
  );
  check(
    "Master Frame: JSON without a fingerprint is refused",
    /lighting_check/.test((await insertFrameLighting(null, LIT_JSON)) ?? ""),
  );
  check(
    "Master Frame: a short fingerprint is refused",
    /lighting_check/.test((await insertFrameLighting("abc", LIT_JSON)) ?? ""),
  );
  check(
    "Master Frame: another JSON schema is refused",
    /lighting_check/.test(
      (await insertFrameLighting(LIT_FP, JSON.stringify({ ...lighting, schema: "other" }))) ?? "",
    ),
  );
  check(
    "Master Frame: JSON naming a different rig fingerprint is refused",
    /lighting_check/.test((await insertFrameLighting("e".repeat(64), LIT_JSON)) ?? ""),
  );

  // ── 7. Master Frame guard ──
  const frameUpdate = (set: string, params: unknown[] = []) =>
    sqlErr(`update scene_master_frames set ${set} where id = '${frame.id}'`, params);
  const immutableFrame = /provenance is immutable/;
  for (const [what, set, params] of [
    ["project", "project_id = $1", [otherProject]],
    ["Shot", "shot_id = $1", [shotB.id]],
    ["Location", "location_id = $1", [otherLocation]],
    ["scene document", "scene_document_id = $1", [randomUUID()]],
    ["scene revision", "scene_revision = scene_revision + 1", []],
    ["scene fingerprint", "scene_fingerprint = $1", ["1".repeat(64)]],
    ["Asset", "asset_id = $1", [randomUUID()]],
    ["render width", "render_width = 10", []],
    ["render height", "render_height = 10", []],
    ["aspect", "production_aspect_ratio = '1:1'", []],
    ["capture time", "captured_at = now() - interval '1 day'", []],
    ["creator", "created_by = null", []],
    ["created_at", "created_at = now() - interval '1 day'", []],
    ["blocking fingerprint", "blocking_fingerprint = $1, blocking_json = '[]'::jsonb", ["1".repeat(64)]],
    ["lighting fingerprint + json", "lighting_fingerprint = null, lighting_json = null", []],
  ] as Array<[string, string, unknown[]]>) {
    const e = await frameUpdate(set, params);
    check(
      `Master Frame guard refuses changing ${what}`,
      e !== null && immutableFrame.test(e),
      e ?? "accepted",
    );
  }
  const adopted = await owner.adoptMasterFrame(frame.id, randomUUID(), now());
  check(
    "adoption still works through the guard",
    adopted.adoptedAt !== null && adopted.adoptedFrameId !== null,
  );
  check(
    "adoption did not disturb the lighting provenance",
    adopted.lightingFingerprint === current.lightingFingerprint,
  );
  const otherBookmarkErr = await frameUpdate("camera_bookmark_id = $1", [randomUUID()]);
  check(
    "a Master Frame cannot be pointed at a different bookmark",
    /different camera bookmark/.test(otherBookmarkErr ?? ""),
    otherBookmarkErr ?? "accepted",
  );
  await pool.query("delete from shot_camera_bookmarks where id = $1", [bookmark.id]);
  const afterBookmark = (await owner.getMasterFrame(frame.id))!;
  check(
    "deleting the bookmark still nulls the pointer (FK SET NULL)",
    afterBookmark.cameraBookmarkId === null,
  );
  check(
    "bookmark cleanup left the provenance intact",
    afterBookmark.lightingFingerprint === current.lightingFingerprint && afterBookmark.adoptedAt !== null,
  );
  const deleted = await owner.recordMasterFrame(frameInput({ cameraBookmarkId: null }));
  check(
    "an owner may DELETE a Master Frame",
    (await sqlErr("delete from scene_master_frames where id = $1", [deleted.id])) === null,
  );

  // ── 8. previs guard ──
  const pathDoc = buildHotelCanopyCameraPath();
  const savePath = () =>
    owner.saveCameraPath({
      id: randomUUID(),
      projectId,
      shotId: shotA.id,
      locationId: tmpLocation,
      sceneDocumentId: sceneId,
      sceneRevision: scene.revision,
      sceneFingerprint: scene.sceneFingerprint,
      path: pathDoc,
      expectedRevision: null,
      userId: dev.id,
      now: now(),
    });
  const path = await savePath();
  const clipAsset = await mkAsset("db:lighting previs", "video", "video/mp4", "local_previs");
  const clipInput = () => ({
    id: randomUUID(),
    projectId,
    shotId: shotA.id,
    locationId: tmpLocation,
    cameraPathId: path.id,
    pathRevision: path.revision,
    pathFingerprint: path.pathFingerprint,
    sceneDocumentId: sceneId,
    sceneRevision: scene.revision,
    sceneFingerprint: scene.sceneFingerprint,
    assetId: clipAsset,
    frameRate: 24,
    durationMs: 4000,
    renderWidth: 956,
    renderHeight: 400,
    container: "mp4",
    codec: "avc",
    hasAudio: false,
    audioAssetId: null,
    audioMix: null,
    audioMixFingerprint: null,
    renderedAt: now(),
    userId: dev.id,
  });
  const clip = await owner.recordPrevisClip({
    ...clipInput(),
    lightingFingerprint: current.lightingFingerprint,
    lighting,
  });
  check(
    "a lit previs stores and reads back its provenance",
    clip.lightingFingerprint === current.lightingFingerprint && clip.lighting?.rigId === current.id,
  );
  const unlitClip = await owner.recordPrevisClip(clipInput());
  check(
    "an unlit previs stores null/null",
    unlitClip.lightingFingerprint === null && unlitClip.lighting === null,
  );
  const insertClipLighting = (fp: string | null, json: string | null) =>
    sqlErr(
      `insert into shot_previs_clips (project_id, shot_id, location_id, path_revision, path_fingerprint,
         scene_document_id, scene_revision, scene_fingerprint, asset_id, frame_rate, duration_ms, render_width,
         render_height, container, codec, rendered_at, lighting_fingerprint, lighting_json)
       select project_id, shot_id, location_id, path_revision, path_fingerprint, scene_document_id, scene_revision,
              scene_fingerprint, asset_id, frame_rate, duration_ms, render_width, render_height, container, codec,
              rendered_at, $2, $3::jsonb
         from shot_previs_clips where id = $1`,
      [unlitClip.id, fp, json],
    );
  check(
    "previs: a fingerprint without JSON is refused",
    /lighting_check/.test((await insertClipLighting(LIT_FP, null)) ?? ""),
  );
  check(
    "previs: JSON without a fingerprint is refused",
    /lighting_check/.test((await insertClipLighting(null, LIT_JSON)) ?? ""),
  );
  check(
    "previs: another JSON schema is refused",
    /lighting_check/.test(
      (await insertClipLighting(LIT_FP, JSON.stringify({ ...lighting, schema: "other" }))) ?? "",
    ),
  );

  const clipUpdate = (set: string, params: unknown[] = []) =>
    sqlErr(`update shot_previs_clips set ${set} where id = '${clip.id}'`, params);
  for (const [what, set, params] of [
    ["project", "project_id = $1", [otherProject]],
    ["Shot", "shot_id = $1", [shotB.id]],
    ["Location", "location_id = $1", [otherLocation]],
    ["path revision", "path_revision = path_revision + 1", []],
    ["path fingerprint", "path_fingerprint = $1", ["1".repeat(64)]],
    ["scene revision", "scene_revision = scene_revision + 1", []],
    ["scene fingerprint", "scene_fingerprint = $1", ["1".repeat(64)]],
    ["rendered Asset", "asset_id = $1", [randomUUID()]],
    ["frame rate", "frame_rate = 30", []],
    ["duration", "duration_ms = 1", []],
    ["width", "render_width = 10", []],
    ["height", "render_height = 10", []],
    ["container", "container = 'webm'", []],
    ["codec", "codec = 'vp9'", []],
    ["audio provenance", "audio_mix_fingerprint = $1", ["1".repeat(64)]],
    ["blocking provenance", "blocking_fingerprint = $1, blocking_json = '[]'::jsonb", ["1".repeat(64)]],
    ["lighting provenance", "lighting_fingerprint = null, lighting_json = null", []],
    ["render time", "rendered_at = now() - interval '1 day'", []],
    ["creator", "created_by = null", []],
  ] as Array<[string, string, unknown[]]>) {
    const e = await clipUpdate(set, params);
    check(
      `previs guard refuses changing ${what}`,
      e !== null && /provenance is immutable/.test(e),
      e ?? "accepted",
    );
  }
  const otherPathErr = await clipUpdate("camera_path_id = $1", [randomUUID()]);
  check(
    "a previs cannot be pointed at a different path",
    /different camera path/.test(otherPathErr ?? ""),
    otherPathErr ?? "accepted",
  );

  // package: the rig reference, frozen, with the exact selected Production Frame chain
  const ref = (await owner.listSpatialReferences(projectId))[shotA.id];
  check(
    "the package carries the rig by value",
    ref.shotLighting?.lightingFingerprint === current.lightingFingerprint &&
      ref.shotLighting.rigRevision === liveRevision,
  );
  check(
    "with no selected frame the production-frame fingerprint is null",
    ref.shotLighting?.productionFrameLightingFingerprint === null,
  );
  check(
    "a previs lit by the current rig is the current previs",
    ref.cameraMotion?.previsAssetId === clipAsset && ref.cameraMotion.previs !== undefined,
  );

  // a Shot with ONLY a rig gets a reference
  await save(owner, shotB.id, 5, null);
  const refB = (await owner.listSpatialReferences(projectId))[shotB.id];
  check(
    "a Shot with only a rig is not dropped from the spatial references",
    refB?.sceneDocumentId === sceneId && refB.cameraBookmark === null && !!refB.shotLighting,
  );

  // selected Production Frame: the exact Master Frame, not the newest and not the adopted one
  const pfAsset = await mkAsset("db:lighting pf", "image", "image/png", "3d_render");
  const newer = await owner.recordMasterFrame({
    ...frameInput({ cameraBookmarkId: null, capturedAt: new Date(Date.now() + 60_000).toISOString() }),
    lightingFingerprint: "c".repeat(64),
    lighting: { ...lighting, rigFingerprint: "c".repeat(64) },
  });
  // the frozen image facts must be the Asset's own (0039)
  await pool.query(
    "update assets set object_path = $2, checksum = $3, width = 1912, height = 800 where id = $1",
    [pfAsset, `db-lighting/${pfAsset}.png`, "a".repeat(64)],
  );
  const pfId = randomUUID();
  await pool.query(
    `insert into shot_production_frames
       (id, project_id, shot_id, version, schema_version, asset_id, asset_checksum, width, height,
        production_aspect_ratio, source, source_master_frame_id, intent_snapshot, intent_fingerprint, parts,
        frame_fingerprint)
     values ($1,$2,$3,1,'prism.production-frame.v1',$4,$5,1912,800,'2.39:1','previs_master',$6,'{}'::jsonb,$5,'{}'::jsonb,$5)`,
    [pfId, projectId, shotA.id, pfAsset, "a".repeat(64), frame.id],
  );
  await pool.query(
    "insert into shot_production_frame_selections (shot_id, project_id, production_frame_id) values ($1,$2,$3)",
    [shotA.id, projectId, pfId],
  );
  const refSel = (await owner.listSpatialReferences(projectId))[shotA.id];
  check(
    "the fingerprint names the SELECTED frame's source Master Frame, not the newest",
    refSel.shotLighting?.productionFrameLightingFingerprint === frame.lightingFingerprint &&
      frame.lightingFingerprint !== newer.lightingFingerprint,
  );
  await pool.query("delete from shot_production_frame_selections where shot_id = $1", [shotA.id]);
  await pool.query("delete from shot_production_frames where id = $1", [pfId]);

  // path deletion nulls the pointer
  await pool.query("delete from shot_camera_paths where id = $1", [path.id]);
  const afterPath = (await owner.getPrevisClip(clip.id))!;
  check("deleting the path still nulls the pointer (FK SET NULL)", afterPath.cameraPathId === null);
  check(
    "path cleanup left the provenance intact",
    afterPath.lightingFingerprint === current.lightingFingerprint && afterPath.pathRevision === path.revision,
  );
  check(
    "an owner may DELETE a previs clip",
    (await sqlErr("delete from shot_previs_clips where id = $1", [unlitClip.id])) === null,
  );

  // clear
  check(
    "clear with a stale revision is refused",
    /changed elsewhere/.test(
      (await err(() =>
        owner.clearLightingRig({ projectId, shotId: shotA.id, expectedRevision: liveRevision + 5 }),
      )) ?? "",
    ),
  );
  await owner.clearLightingRig({ projectId, shotId: shotA.id, expectedRevision: liveRevision });
  check("clear removes the current rig", (await owner.getLightingRigForShot(shotA.id)) === null);
  check(
    "clear leaves rendered history alone",
    (await owner.getMasterFrame(frame.id))?.lightingFingerprint === current.lightingFingerprint,
  );
  const refNoRig = (await owner.listSpatialReferences(projectId))[shotA.id];
  check("without a rig the package key is omitted, not null", !refNoRig || !("shotLighting" in refNoRig));

  // ── 9. cascades ──
  const before = await pool.query(
    `select (select count(*)::int from scene_master_frames where location_id = $1) as frames,
            (select count(*)::int from shot_previs_clips where location_id = $1) as clips,
            (select count(*)::int from shot_light_rigs where location_id = $1) as rigs`,
    [tmpLocation],
  );
  check(
    "fixtures exist before the cascade",
    before.rows[0].frames > 0 && before.rows[0].clips > 0 && before.rows[0].rigs > 0,
  );
  await pool.query("delete from locations where id = $1", [tmpLocation]);
  const after = await pool.query(
    `select (select count(*)::int from scene_master_frames where location_id = $1) as frames,
            (select count(*)::int from shot_previs_clips where location_id = $1) as clips,
            (select count(*)::int from shot_light_rigs where location_id = $1) as rigs`,
    [tmpLocation],
  );
  check(
    "deleting the Location cascades through the guards",
    after.rows[0].frames === 0 && after.rows[0].clips === 0 && after.rows[0].rigs === 0,
    JSON.stringify(after.rows[0]),
  );
} catch (e) {
  check(
    "the suite ran to completion",
    false,
    `${(e as Error).message.slice(0, 400)} ${(e as Error).stack?.split("\n").find((l) => l.includes("db-lighting")) ?? ""}`,
  );
} finally {
  for (const s of restoreShotLocations)
    await pool
      .query("update shots set location_id = $2 where id = $1", [s.id, s.location_id])
      .catch(() => undefined);
  for (const id of created.projectIds)
    await pool.query("delete from projects where id = $1", [id]).catch(() => undefined);
  for (const id of created.locationIds)
    await pool.query("delete from locations where id = $1", [id]).catch(() => undefined);
  for (const id of created.assetIds)
    await pool.query("delete from assets where id = $1", [id]).catch(() => undefined);
}

const leftover = await pool.query(
  `select (select count(*)::int from assets where name like 'db:lighting%') as assets,
          (select count(*)::int from locations where name like 'db:lighting%') as locations,
          (select count(*)::int from projects where title like 'db:lighting%') as projects`,
);
const l = leftover.rows[0];
check(
  "cleanup left no test rows",
  l.assets === 0 && l.locations === 0 && l.projects === 0,
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
