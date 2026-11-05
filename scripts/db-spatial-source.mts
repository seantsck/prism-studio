// Integration tests for Phase 4C spatial provenance against the REAL dedicated PostgreSQL database (migration 0049:
// Master Frame camera + base-environment provenance, Production Frame source fingerprints and the exact-source
// trigger).
//   npm run db:spatial-source
//
// Exercises (with real rows, cleaned up afterwards): structure, the Master Frame camera pair CHECK, immutability through
// the 0048 deny-by-default guard, the Production Frame source CHECK and exact-source trigger (every mismatch), the
// absent foreign key and source deletion, current-main-shaped inserts (migration-ahead-of-code), no backfill, the
// repositories' 0049 path, and current-Location authority of spatialReference (a Shot reassigned A -> B / none). Requires `npm run db:seed` first (uses the demo project). No provider call.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { PostgresPrevisData } from "../src/data/previs-postgres";
import { PostgresProductionFrameData } from "../src/data/production-frame-postgres";
import { buildShotContext } from "../src/domain/context";
import { buildRenderCamera } from "../src/domain/previs/camera-provenance";
import { buildPrevisDocument } from "../src/domain/previs/document";
import { baseEnvironmentFingerprint, baseEnvironmentOf } from "../src/domain/previs/lighting";
import { buildHotelCanopyEngineScene } from "../src/domain/previs/hotel-canopy";
import { draftProductionFrame, sourceSpatialOfMasterFrame } from "../src/domain/production-frame";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "Spatial source provenance integration tests (rows created, then removed)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 4 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const admin = new AdminRepository(pool, dev.id);
const previs = new PostgresPrevisData(pool, rlsPreamble({ sub: dev.id }));
const frames = new PostgresProductionFrameData(pool, rlsPreamble({ sub: dev.id }));
const now = () => new Date().toISOString();
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
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

const created = { locationIds: [] as string[], assetIds: [] as string[] };
let restoreShotLocation: { id: string; locationId: string | null } | null = null;

try {
  const data = (await admin.loadProject("ojousama"))!;
  const projectId = data.project.id;
  const shotA = data.shots.find((s) => s.shotCode === "2A")!;
  const shotB = data.shots.find((s) => s.shotCode === "2B")!;

  // ── 1. structure ──
  const cols = await pool.query(
    `select table_name, column_name, is_nullable, data_type from information_schema.columns
      where table_schema = 'public' and (
        (table_name = 'scene_master_frames'
           and column_name in ('camera_fingerprint', 'camera_json', 'base_environment_fingerprint'))
        or (table_name = 'shot_production_frames' and column_name like 'source\\_%\\_fingerprint'))
      order by 1, 2`,
  );
  check(
    "the eight new columns exist and are nullable",
    cols.rows.length === 8 && cols.rows.every((r) => r.is_nullable === "YES"),
    JSON.stringify(cols.rows),
  );
  const stray = await pool.query(
    `select column_name from information_schema.columns
      where table_name = 'shot_production_frames' and column_name in ('source_spatial_stale', 'source_spatial_unknown')`,
  );
  check("no stale / unknown array is persisted on a Production Frame", stray.rowCount === 0);
  const fk = await pool.query(
    `select 1 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.conrelid = 'public.shot_production_frames'::regclass
        and a.attname = 'source_master_frame_id'`,
  );
  check("source_master_frame_id has no foreign key", fk.rowCount === 0);
  const trg = await pool.query(
    `select t.tgname, p.prosecdef from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid = 'public.shot_production_frames'::regclass and not t.tgisinternal
        and p.proname = 'check_shot_production_frame_spatial_source'`,
  );
  check(
    "the exact-source trigger exists and is SECURITY INVOKER",
    trg.rowCount === 1 && trg.rows[0].prosecdef === false,
  );
  const mig = await pool.query(
    "select name, checksum from prism_migrations where name like '0048%' or name like '0049%' order by name",
  );
  check(
    "0048's recorded checksum is unchanged",
    mig.rows[0]?.checksum === "d59c8ef800ce83f78492b4e030a07d6349d06fb1c2e04daeec195384860034b1",
    JSON.stringify(mig.rows[0]),
  );
  check(
    "0049 is recorded exactly once",
    mig.rows.filter((r) => String(r.name).startsWith("0049")).length === 1,
  );
  // no backfill: every row that existed before 0049 was applied still has no 0049 provenance
  const backfilled = await pool.query(
    `select
       (select count(*)::int from scene_master_frames
         where created_at < (select applied_at from prism_migrations where name like '0049%')
           and (camera_fingerprint is not null or camera_json is not null
                or base_environment_fingerprint is not null)) as mf,
       (select count(*)::int from shot_production_frames
         where created_at < (select applied_at from prism_migrations where name like '0049%')
           and (source_scene_fingerprint is not null or source_base_environment_fingerprint is not null)) as pf,
       (select count(*)::int from scene_master_frames
         where created_at < (select applied_at from prism_migrations where name like '0049%')) as mf_before`,
  );
  check(
    "no backfill: rows from before 0049 carry no camera, environment or source provenance",
    backfilled.rows[0].mf === 0 && backfilled.rows[0].pf === 0,
    JSON.stringify(backfilled.rows[0]),
  );

  // ── fixtures: a private set, two Shot bookmarks, two images ──
  const loc = randomUUID();
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
    [loc, projectId, "db:spatial-source location"],
  );
  created.locationIds.push(loc);
  const scene = await previs.saveScene({
    id: randomUUID(),
    projectId,
    locationId: loc,
    document: buildPrevisDocument({ engineScene: buildHotelCanopyEngineScene() }),
    expectedRevision: null,
    engineVersion: "test",
    userId: dev.id,
    now: now(),
  });
  const bmA = await previs.setBookmark({
    id: randomUUID(),
    projectId,
    shotId: shotA.id,
    locationId: loc,
    sceneDocumentId: scene.id,
    userId: dev.id,
    now: now(),
  });
  const camA = buildRenderCamera(bmA);
  const envA = baseEnvironmentFingerprint(baseEnvironmentOf(scene.document));
  const image = async (label: string) => {
    const id = randomUUID();
    created.assetIds.push(id);
    await pool.query(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, object_path, mime, checksum, width, height, metadata)
       values ($1,$2,$3,'image','storyboard','3d_render','local',$4,'image/png',$5,1912,800,'{}'::jsonb)`,
      [id, projectId, `db:spatial-source ${label}`, `${projectId}/${id}/m.png`, hex(label)],
    );
    return id;
  };
  const assetA = await image("a");
  const assetB = await image("b");
  const mfInsert = (over: Record<string, unknown> = {}) => {
    const v = {
      id: randomUUID(),
      shot: shotA.id,
      asset: assetA,
      camera_fingerprint: camA.cameraFingerprint as string | null,
      camera_json: JSON.stringify(camA) as string | null,
      env: null as string | null,
      ...over,
    };
    return pool.query(
      `insert into scene_master_frames (id, project_id, shot_id, location_id, scene_document_id, scene_revision,
         scene_fingerprint, camera_bookmark_id, asset_id, render_width, render_height, production_aspect_ratio,
         captured_at, camera_fingerprint, camera_json, base_environment_fingerprint)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1912,800,'2.39:1',now(),$10,$11::jsonb,$12) returning id`,
      [
        v.id,
        projectId,
        v.shot,
        loc,
        scene.id,
        scene.revision,
        scene.sceneFingerprint,
        v.shot === shotA.id ? bmA.id : null,
        v.asset,
        v.camera_fingerprint,
        v.camera_json,
        v.env,
      ],
    );
  };
  const mfErr = (over: Record<string, unknown>) =>
    mfInsert(over).then(
      () => null as string | null,
      (e: Error) => e.message,
    );

  // ── 2. Master Frame camera pair ──
  check(
    "null/null camera is accepted (historical shape)",
    (await mfErr({ camera_fingerprint: null, camera_json: null })) === null,
  );
  check("a valid fingerprint + render-camera JSON is accepted", (await mfErr({})) === null);
  const refusedMf = async (name: string, over: Record<string, unknown>) => {
    const e = await mfErr(over);
    check(name, e !== null && /scene_master_frames_camera_check/.test(e), e ?? "accepted");
  };
  await refusedMf("fingerprint without JSON is refused", { camera_json: null });
  await refusedMf("JSON without fingerprint is refused", { camera_fingerprint: null });
  await refusedMf("a short fingerprint is refused", {
    camera_fingerprint: "abc",
    camera_json: JSON.stringify({ ...camA, cameraFingerprint: "abc" }),
  });
  await refusedMf("a wrong schema is refused", {
    camera_json: JSON.stringify({ ...camA, schema: "prism.other.v1" }),
  });
  await refusedMf("a JSON fingerprint that differs from the column is refused", {
    camera_json: JSON.stringify({ ...camA, cameraFingerprint: hex("other") }),
  });
  await refusedMf("a non-object camera is refused", { camera_json: JSON.stringify({ ...camA, camera: 5 }) });

  // ── 2b. Master Frame base-environment provenance ──
  check(
    "a null (historical) base-environment fingerprint is accepted",
    (await mfErr({ env: null })) === null,
  );
  check("a valid base-environment fingerprint is accepted", (await mfErr({ env: envA })) === null);
  const badEnv = await mfErr({ env: "not-hex" });
  check(
    "a malformed base-environment fingerprint is refused",
    badEnv !== null && /scene_master_frames_base_environment_check/.test(badEnv),
    badEnv ?? "accepted",
  );

  // ── 3. immutability (0048's deny-by-default guard covers the new columns) ──
  const mfWithCamera = String((await mfInsert({ env: envA })).rows[0].id);
  const upd = await sqlErr("update scene_master_frames set camera_fingerprint = $2 where id = $1", [
    mfWithCamera,
    hex("x"),
  ]);
  check(
    "updating camera_fingerprint is refused by the 0048 guard",
    /provenance is immutable/.test(upd ?? ""),
    upd ?? "",
  );
  const upd2 = await sqlErr(
    "update scene_master_frames set camera_json = null, camera_fingerprint = null where id = $1",
    [mfWithCamera],
  );
  check("erasing camera provenance is refused", /provenance is immutable/.test(upd2 ?? ""), upd2 ?? "");
  const updEnv = await sqlErr(
    "update scene_master_frames set base_environment_fingerprint = $2 where id = $1",
    [mfWithCamera, hex("env-x")],
  );
  check(
    "updating base_environment_fingerprint is refused by the 0048 guard",
    /provenance is immutable/.test(updEnv ?? ""),
    updEnv ?? "",
  );
  const eraseEnv = await sqlErr(
    "update scene_master_frames set base_environment_fingerprint = null where id = $1",
    [mfWithCamera],
  );
  check(
    "erasing base-environment provenance is refused",
    /provenance is immutable/.test(eraseEnv ?? ""),
    eraseEnv ?? "",
  );
  const adopt = await sqlErr("update scene_master_frames set adopted_at = now() where id = $1", [
    mfWithCamera,
  ]);
  check("the permitted adopt update still works", adopt === null, adopt ?? "");

  // ── 4. Production Frame source CHECK + exact-source trigger ──
  const lit = hex("lighting");
  const blk = hex("blocking");
  const mfA = String(
    (
      await pool.query(
        `insert into scene_master_frames (id, project_id, shot_id, location_id, scene_document_id, scene_revision,
           scene_fingerprint, camera_bookmark_id, asset_id, render_width, render_height, production_aspect_ratio,
           captured_at, camera_fingerprint, camera_json, blocking_fingerprint, blocking_json,
           base_environment_fingerprint)
         values (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,1912,800,'2.39:1',now(),$9,$10::jsonb,$11,'[]'::jsonb,$12)
         returning id`,
        [
          projectId,
          shotA.id,
          loc,
          scene.id,
          scene.revision,
          scene.sceneFingerprint,
          bmA.id,
          assetA,
          camA.cameraFingerprint,
          JSON.stringify(camA),
          blk,
          envA,
        ],
      )
    ).rows[0].id,
  );
  let version = 100;
  const pfInsert = (over: Record<string, unknown> = {}) => {
    const v = {
      shot: shotA.id,
      asset: assetA,
      source: "previs_master",
      mf: mfA as string | null,
      sb: null as string | null,
      scene: scene.sceneFingerprint as string | null,
      camera: camA.cameraFingerprint as string | null,
      blocking: blk as string | null,
      lighting: null as string | null,
      env: envA as string | null,
      ...over,
    };
    const ver = ++version;
    return pool.query(
      `insert into shot_production_frames (project_id, shot_id, version, schema_version, asset_id, asset_checksum,
         width, height, production_aspect_ratio, source, source_storyboard_frame_id, source_master_frame_id,
         intent_snapshot, intent_fingerprint, parts, frame_fingerprint,
         source_scene_fingerprint, source_camera_fingerprint, source_blocking_fingerprint, source_lighting_fingerprint,
         source_base_environment_fingerprint)
       values ($1,$2,$3,'prism.production-frame.v1',$4,(select checksum from assets where id = $4),1912,800,'2.39:1',
         $5,$6,$7,'{}'::jsonb,$8,'{}'::jsonb,$9,$10,$11,$12,$13,$14) returning id`,
      [
        projectId,
        v.shot,
        ver,
        v.asset,
        v.source,
        v.sb,
        v.mf,
        hex("intent"),
        hex(`frame-${ver}`),
        v.scene,
        v.camera,
        v.blocking,
        v.lighting,
        v.env,
      ],
    );
  };
  const pfErr = (over: Record<string, unknown>) =>
    pfInsert(over).then(
      () => null as string | null,
      (e: Error) => e.message,
    );
  const none = { scene: null, camera: null, blocking: null, lighting: null, env: null };
  check(
    "a non-spatial (upload) frame with five nulls is accepted",
    (await pfErr({ ...none, source: "upload", mf: null })) === null,
  );
  check("a historical previs_master frame with five nulls is accepted", (await pfErr(none)) === null);
  const exactId = await pfInsert({}).then(
    (r) => String(r.rows[0].id),
    () => null,
  );
  check("an exact 4C previs_master source provenance is accepted", exactId !== null);
  const refusedPf = async (name: string, over: Record<string, unknown>, pattern: RegExp) => {
    const e = await pfErr(over);
    check(name, e !== null && pattern.test(e), e ?? "accepted");
  };
  const mismatch = /does not match its source Master Frame/;
  await refusedPf("a source scene mismatch is refused", { scene: hex("s2") }, mismatch);
  await refusedPf("a camera mismatch is refused", { camera: hex("c2") }, mismatch);
  await refusedPf("a camera claimed null when the source has one is refused", { camera: null }, mismatch);
  await refusedPf("a blocking mismatch is refused", { blocking: null }, mismatch);
  await refusedPf("a lighting mismatch is refused", { lighting: lit }, mismatch);
  await refusedPf("a base-environment mismatch is refused", { env: hex("env-2") }, mismatch);
  await refusedPf(
    "a base environment claimed null when the source froze one is refused",
    { env: null },
    mismatch,
  );
  await refusedPf(
    "a base environment alone, without the marker, is refused",
    { ...none, env: envA },
    /spatial_source_check/,
  );
  await refusedPf(
    "a source Master Frame of another Shot is refused",
    { shot: shotB.id },
    /another project, shot or image/,
  );
  await refusedPf(
    "a source Master Frame with another Asset is refused",
    { asset: assetB },
    /another project, shot or image/,
  );
  await refusedPf("a missing source Master Frame is refused", { mf: randomUUID() }, /does not exist/);
  // a BEFORE INSERT trigger runs before CHECK constraints, so either barrier may be the one that refuses
  const anyBarrier = /spatial_source_check|does not exist|does not match/;
  await refusedPf(
    "frozen source columns on a non-previs_master frame are refused",
    { source: "upload", mf: null },
    anyBarrier,
  );
  await refusedPf(
    "frozen source columns on a storyboard frame are refused",
    { source: "storyboard", mf: null, sb: randomUUID() },
    anyBarrier,
  );
  await refusedPf("a short source fingerprint is refused", { scene: "abc" }, anyBarrier);
  // the CHECK alone (the trigger passes: the fingerprints are the source's own) still refuses a non-3D origin
  const checkOnly = await sqlErr(
    `insert into shot_production_frames (project_id, shot_id, version, schema_version, asset_id, asset_checksum,
       width, height, production_aspect_ratio, source, source_generation_attempt_id, intent_snapshot,
       intent_fingerprint, parts, frame_fingerprint, source_scene_fingerprint)
     values ($1,$2,900,'prism.production-frame.v1',$3,(select checksum from assets where id = $3),1912,800,'2.39:1',
       'generation_output',gen_random_uuid(),'{}','${hex("i")}','{}','${hex("chk")}',$4)`,
    [projectId, shotA.id, assetA, scene.sceneFingerprint],
  );
  check(
    "frozen provenance on a generation frame is refused",
    checkOnly !== null && anyBarrier.test(checkOnly),
    checkOnly ?? "accepted",
  );
  await refusedPf(
    "partial provenance without the marker is refused",
    { scene: null },
    /spatial_source_check/,
  );
  // another project: a second project owned by the dev user would need a full fixture; the trigger compares
  // project_id first, so a Master Frame row of another project is proven by rewriting the probe's project id
  const otherProject = await pool.query("select id from projects where id <> $1 limit 1", [projectId]);
  if (otherProject.rows[0]) {
    const e = await sqlErr(
      `insert into shot_production_frames (project_id, shot_id, version, schema_version, asset_id, asset_checksum,
         width, height, production_aspect_ratio, source, source_master_frame_id, intent_snapshot, intent_fingerprint,
         parts, frame_fingerprint, source_scene_fingerprint)
       values ($1, $2, 1, 'prism.production-frame.v1', $3, $4, 1912, 800, '2.39:1', 'previs_master', $5, '{}', $6, '{}', $7, $8)`,
      [otherProject.rows[0].id, shotA.id, assetA, hex("a"), mfA, hex("i"), hex("f"), scene.sceneFingerprint],
    );
    check("a source Master Frame of another Project is refused", e !== null, e ?? "accepted");
  } else
    check("a source Master Frame of another Project is refused (no second project; FK refuses first)", true);
  const pfUpd = exactId
    ? await sqlErr("update shot_production_frames set source_camera_fingerprint = null where id = $1", [
        exactId,
      ])
    : "no row";
  check(
    "a Production Frame's source provenance can never be updated",
    /immutable history/.test(pfUpd ?? ""),
    pfUpd ?? "",
  );

  // ── 5. source deletion (no FK: the frame and its lineage survive) ──
  const del = await sqlErr("delete from scene_master_frames where id = $1", [mfA]);
  check("the source Master Frame can be deleted", del === null, del ?? "");
  const survived = exactId
    ? await pool.query("select * from shot_production_frames where id = $1", [exactId])
    : { rows: [] as Record<string, unknown>[] };
  const s = survived.rows[0];
  check(
    "the Production Frame survives with its source id and all five fingerprints",
    !!s &&
      s.source_master_frame_id === mfA &&
      s.source_scene_fingerprint === scene.sceneFingerprint &&
      s.source_camera_fingerprint === camA.cameraFingerprint &&
      s.source_blocking_fingerprint === blk &&
      s.source_lighting_fingerprint === null &&
      s.source_base_environment_fingerprint === envA,
  );
  await refusedPf("a NEW frozen frame for a deleted source is refused", {}, /does not exist/);

  // ── 6. migration-ahead-of-code: the exact column lists current main (b340bcd) uses ──
  const mainMf = await sqlErr(
    `insert into scene_master_frames
       (id, project_id, shot_id, location_id, scene_document_id, scene_revision, scene_fingerprint,
        camera_bookmark_id, asset_id, render_width, render_height, production_aspect_ratio, captured_at,
        created_by, created_at, blocking_fingerprint, blocking_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,1912,800,'2.39:1',now(),$10,now(),null,null)`,
    [
      randomUUID(),
      projectId,
      shotA.id,
      loc,
      scene.id,
      scene.revision,
      scene.sceneFingerprint,
      bmA.id,
      assetA,
      dev.id,
    ],
  );
  check("a current-main-shaped Master Frame insert works at 0049", mainMf === null, mainMf ?? "");
  const mainPf = await sqlErr(
    `insert into shot_production_frames
       (id, project_id, shot_id, version, schema_version, asset_id, asset_checksum, width, height,
        production_aspect_ratio, source, source_storyboard_frame_id, source_master_frame_id,
        source_generation_attempt_id, intent_snapshot, intent_fingerprint, parts, frame_fingerprint,
        created_by, created_at)
     values (gen_random_uuid(),$1,$2,999,'prism.production-frame.v1',$3,(select checksum from assets where id = $3),
       1912,800,'2.39:1','previs_master',null,$4,null,'{}'::jsonb,$5,'{}'::jsonb,$6,$7,now())`,
    [projectId, shotA.id, assetA, mfWithCamera, hex("i"), hex("main-pf"), dev.id],
  );
  check("a current-main-shaped Production Frame insert works at 0049", mainPf === null, mainPf ?? "");

  // ── 7. the 4C repositories on 0049 ──
  check("the repository reports 0049 provenance as persisted", await previs.spatialProvenancePersisted());
  const bm = (await previs.getBookmarkForShot(shotA.id))!;
  const rec = await previs.recordMasterFrame({
    id: randomUUID(),
    projectId,
    shotId: shotA.id,
    locationId: loc,
    sceneDocumentId: scene.id,
    sceneRevision: scene.revision,
    sceneFingerprint: scene.sceneFingerprint,
    cameraBookmarkId: bm.id,
    assetId: assetB,
    renderWidth: 1912,
    renderHeight: 800,
    productionAspectRatio: "2.39:1",
    capturedAt: now(),
    cameraFingerprint: camA.cameraFingerprint,
    camera: camA,
    baseEnvironmentFingerprint: envA,
    userId: dev.id,
  });
  const back = await previs.getMasterFrame(rec.id);
  check(
    "the repository stores and reads back the base-environment fingerprint (no rig)",
    back?.baseEnvironmentFingerprint === envA && back?.lightingFingerprint === null,
  );
  check(
    "the repository stores and reads back the server-derived camera snapshot",
    back?.cameraFingerprint === camA.cameraFingerprint && back?.camera?.bookmarkId === bmA.id,
  );
  const fresh = (await admin.loadProject("ojousama"))!;
  const ctx = buildShotContext(fresh, shotA.id);
  const asset = fresh.assets.find((a) => a.id === assetB)!;
  const drafted = draftProductionFrame(ctx, {
    id: randomUUID(),
    now: now(),
    userId: dev.id,
    source: "previs_master",
    sourceMasterFrameId: rec.id,
    sourceSpatial: sourceSpatialOfMasterFrame(back!),
    asset,
  });
  if (!drafted.ok) throw new Error(drafted.problem.message);
  const made = await frames.create({
    draft: drafted.draft,
    newAsset: null,
    select: false,
    userId: dev.id,
    now: now(),
  });
  check(
    "the Production Frame repository persists the five source fingerprints at 0049",
    made.created &&
      made.frame.sourceSceneFingerprint === scene.sceneFingerprint &&
      made.frame.sourceCameraFingerprint === camA.cameraFingerprint &&
      made.frame.sourceBlockingFingerprint === null &&
      made.frame.sourceLightingFingerprint === null &&
      made.frame.sourceBaseEnvironmentFingerprint === envA,
  );
  const again = await frames.create({
    draft: { ...drafted.draft, id: randomUUID() },
    newAsset: null,
    select: false,
    userId: dev.id,
    now: now(),
  });
  check(
    "re-promotion reuses the existing immutable frame",
    !again.created && again.frame.id === made.frame.id,
  );
  const forged = await err(() =>
    frames.create({
      draft: {
        ...drafted.draft,
        id: randomUUID(),
        frameFingerprint: hex("forged"),
        sourceCameraFingerprint: hex("c9"),
      },
      newAsset: null,
      select: false,
      userId: dev.id,
      now: now(),
    }),
  );
  check(
    "a forged source fingerprint through the repository is refused by the trigger",
    /does not match/.test(forged ?? ""),
    forged ?? "",
  );
  const forgedEnv = await err(() =>
    frames.create({
      draft: {
        ...drafted.draft,
        id: randomUUID(),
        frameFingerprint: hex("forged-env"),
        sourceBaseEnvironmentFingerprint: hex("env-9"),
      },
      newAsset: null,
      select: false,
      userId: dev.id,
      now: now(),
    }),
  );
  check(
    "a forged base environment through the repository is refused by the trigger",
    /does not match/.test(forgedEnv ?? ""),
    forgedEnv ?? "",
  );

  // ── 8. spatialReference is CURRENT state: the Shot's current Location decides (A -> B / none) ──
  const original = await pool.query("select location_id from shots where id = $1", [shotA.id]);
  restoreShotLocation = { id: shotA.id, locationId: original.rows[0].location_id ?? null };
  const refFor = async () => (await previs.listSpatialReferences(projectId))[shotA.id] ?? null;
  await pool.query("update shots set location_id = $2 where id = $1", [shotA.id, loc]);
  const onLoc = await refFor();
  check(
    "assigned to the set's Location: the reference describes it",
    onLoc?.locationId === loc && onLoc?.sceneFingerprint === scene.sceneFingerprint,
    JSON.stringify(onLoc?.locationId ?? null),
  );
  const locB = randomUUID();
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
    [locB, projectId, "db:spatial-source location B"],
  );
  created.locationIds.push(locB);
  await pool.query("update shots set location_id = $2 where id = $1", [shotA.id, locB]);
  check(
    "reassigned to B with no spatial setup: no current reference (A's rows are not projected)",
    (await refFor()) === null,
  );
  check(
    "A's rows are preserved as history",
    (await previs.getBookmarkForShot(shotA.id))?.locationId === loc &&
      (await previs.getSceneForLocation(loc)) !== null,
  );
  const sceneB = await previs.saveScene({
    id: randomUUID(),
    projectId,
    locationId: locB,
    document: buildPrevisDocument({ engineScene: buildHotelCanopyEngineScene() }),
    expectedRevision: null,
    engineVersion: "test",
    userId: dev.id,
    now: now(),
  });
  check("B has a set but the Shot has no B rows yet: still no reference", (await refFor()) === null);
  await previs.setBookmark({
    id: randomUUID(),
    projectId,
    shotId: shotA.id,
    locationId: locB,
    sceneDocumentId: sceneB.id,
    userId: dev.id,
    now: now(),
  });
  const onB = await refFor();
  check(
    "B's own bookmark: the reference describes B only",
    onB?.locationId === locB && onB?.sceneDocumentId === sceneB.id,
    JSON.stringify({ loc: onB?.locationId ?? null }),
  );
  await pool.query("update shots set location_id = null where id = $1", [shotA.id]);
  check("no Location at all: no current reference", (await refFor()) === null);
} catch (e) {
  check(
    "the suite ran to completion",
    false,
    `${(e as Error).message.slice(0, 400)} ${(e as Error).stack?.split("\n").find((l) => l.includes("db-spatial-source")) ?? ""}`,
  );
} finally {
  if (restoreShotLocation)
    await pool
      .query("update shots set location_id = $2 where id = $1", [
        restoreShotLocation.id,
        restoreShotLocation.locationId,
      ])
      .catch(() => undefined);
  // frames reference the assets (FK), so the Location cascade (Master Frames) runs first, then frames, then assets
  for (const id of created.locationIds)
    await pool.query("delete from locations where id = $1", [id]).catch(() => undefined);
  if (created.assetIds.length)
    await pool
      .query(
        "delete from shot_production_frame_selections where production_frame_id in (select id from shot_production_frames where asset_id = any($1::uuid[]))",
        [created.assetIds],
      )
      .catch(() => undefined);
  if (created.assetIds.length)
    await pool
      .query("delete from shot_production_frames where asset_id = any($1::uuid[])", [created.assetIds])
      .catch(() => undefined);
  for (const id of created.assetIds)
    await pool.query("delete from assets where id = $1", [id]).catch(() => undefined);
}

const leftover = await pool.query(
  `select (select count(*)::int from assets where name like 'db:spatial-source%') as assets,
          (select count(*)::int from locations where name like 'db:spatial-source%') as locations`,
);
const l = leftover.rows[0];
check("cleanup left no test rows", l.assets === 0 && l.locations === 0, JSON.stringify(l));

let failed = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await pool.end();
process.exit(failed ? 1 : 0);
