// Integration tests for the Phase 2F 3D production set against the REAL dedicated Prism Studio database
// (migrations 0030 + 0031: sets, bookmarks, master frames, camera paths, previs clips).
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
import {
  cameraPathFingerprint,
  emptyCameraPath,
  keyframeFromCamera,
  upsertKeyframe,
} from "../src/domain/previs/camera-path";
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

const TABLES = [
  "location_scene_documents",
  "shot_camera_bookmarks",
  "scene_master_frames",
  "shot_camera_paths",
  "shot_previs_clips",
];
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
    "the five Phase 2F tables exist with row-level security enabled",
    rls.rowCount === 5 && rls.rows.every((r) => r.relrowsecurity === true),
  );
  const pol = await pool.query(
    "select tablename from pg_policies where schemaname = 'public' and tablename = any($1::text[]) and 'authenticated' = any(roles)",
    [TABLES],
  );
  check(
    "each table has an owner policy for authenticated users",
    new Set(pol.rows.map((r) => r.tablename)).size === 5,
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

  // ── 7. camera paths (0031) ──
  const mkPath = (extra = 0) => {
    let p = emptyCameraPath(4000, 24);
    p = upsertKeyframe(
      p,
      keyframeFromCamera(
        "kf-a",
        0,
        { position: { x: 0, y: 1.6, z: 8 }, rotation: { x: 0, y: 0, z: 0 }, focalLengthMm: 35 },
        "ease_in_out",
      ),
    );
    p = upsertKeyframe(
      p,
      keyframeFromCamera(
        "kf-b",
        2000,
        { position: { x: 1 + extra, y: 1.6, z: 4 }, rotation: { x: 0, y: 0.3, z: 0 }, focalLengthMm: 50 },
        "ease_in_out",
      ),
    );
    p = upsertKeyframe(
      p,
      keyframeFromCamera(
        "kf-c",
        4000,
        { position: { x: 1, y: 1.6, z: 1 }, rotation: { x: 0, y: 0.6, z: 0 }, focalLengthMm: 70 },
        "linear",
      ),
    );
    return p;
  };
  const pathBase = {
    projectId,
    shotId: shot.id,
    locationId: tmpLocation,
    sceneDocumentId: sceneId,
    sceneRevision: 2,
    sceneFingerprint: saved2.sceneFingerprint,
    userId: dev.id,
  };
  const path1 = mkPath();
  const savedPath = await owner.saveCameraPath({
    ...pathBase,
    id: randomUUID(),
    path: path1,
    expectedRevision: null,
    now: now(),
  });
  check(
    "first camera-path save creates revision 1 with the domain fingerprint",
    savedPath.revision === 1 && savedPath.pathFingerprint === cameraPathFingerprint(path1),
  );
  const readBack = await owner.getCameraPathForShot(shot.id);
  check(
    "the path reads back keyframe-for-keyframe (quaternion + focal length persisted)",
    !!readBack &&
      readBack.path.keyframes.length === 3 &&
      readBack.path.keyframes[1].focalLengthMm === 50 &&
      cameraPathFingerprint(readBack.path) === savedPath.pathFingerprint &&
      readBack.sceneRevision === 2,
  );
  const pathJson = await pool.query("select path_json::text as t from shot_camera_paths where id = $1", [
    savedPath.id,
  ]);
  check(
    "no URL or credential-shaped value is stored in path_json",
    !/https?:\/\/|blob:|X-Amz|signature=/i.test(String(pathJson.rows[0].t)),
  );
  const path2 = mkPath(0.5);
  const savedPath2 = await owner.saveCameraPath({
    ...pathBase,
    id: randomUUID(),
    path: path2,
    expectedRevision: 1,
    now: now(),
  });
  check(
    "a compare-and-set save advances to revision 2 on the same row with a new fingerprint",
    savedPath2.revision === 2 &&
      savedPath2.id === savedPath.id &&
      savedPath2.pathFingerprint !== savedPath.pathFingerprint,
  );
  const stalePath = await expectError(() =>
    owner.saveCameraPath({ ...pathBase, id: randomUUID(), path: path1, expectedRevision: 1, now: now() }),
  );
  check(
    "a stale camera-path revision is a conflict",
    stalePath !== null && /changed elsewhere/.test(stalePath),
  );
  const dupPath = await expectError(() =>
    owner.saveCameraPath({ ...pathBase, id: randomUUID(), path: path1, expectedRevision: null, now: now() }),
  );
  check("a second first-save for the same shot is a conflict", dupPath !== null);
  const badPath = await expectError(() =>
    owner.saveCameraPath({
      ...pathBase,
      id: randomUUID(),
      path: { ...path2, durationMs: 1000 },
      expectedRevision: 2,
      now: now(),
    }),
  );
  check(
    "a keyframe after the end is rejected before the database",
    badPath !== null && /after the end/.test(badPath),
  );

  // staleness is computed, never destructive: changing the set leaves the path intact
  const doc3 = buildPrevisDocument({
    engineScene: (() => {
      const sc = buildHotelCanopyEngineScene({ characterId: "char-test" });
      sc.scene[4].position = { x: 9, y: 0.75, z: -2 };
      return sc;
    })(),
  });
  const saved3 = await owner.saveScene({
    id: randomUUID(),
    projectId,
    locationId: tmpLocation,
    document: doc3,
    expectedRevision: 2,
    engineVersion: "test",
    userId: dev.id,
    now: now(),
  });
  const afterSceneChange = await owner.getCameraPathForShot(shot.id);
  check(
    "after the set changes the path still exists and records the older scene fingerprint (stale, not deleted)",
    !!afterSceneChange &&
      afterSceneChange.sceneFingerprint === saved2.sceneFingerprint &&
      afterSceneChange.sceneFingerprint !== saved3.sceneFingerprint,
  );

  // previs clip provenance + private asset
  const clipAsset = randomUUID();
  await pool.query(
    `insert into assets (id, project_id, name, type, purpose, source, storage_provider, mime, width, height, metadata)
     values ($1,$2,$3,'video','video_reference','local_previs','none','video/mp4',956,400,'{"previs":{"test":true}}'::jsonb)`,
    [clipAsset, projectId, "db:previs clip"],
  );
  created.assetIds.push(clipAsset);
  const clipBase = {
    projectId,
    shotId: shot.id,
    locationId: tmpLocation,
    cameraPathId: savedPath2.id,
    pathRevision: 2,
    pathFingerprint: savedPath2.pathFingerprint,
    sceneDocumentId: sceneId,
    sceneRevision: 2,
    sceneFingerprint: saved2.sceneFingerprint,
    frameRate: 24,
    durationMs: 4000,
    renderWidth: 956,
    renderHeight: 400,
    container: "mp4" as const,
    codec: "avc1.42E01F",
    hasAudio: false,
    audioAssetId: null,
    userId: dev.id,
  };
  const clip = await owner.recordPrevisClip({
    ...clipBase,
    id: randomUUID(),
    assetId: clipAsset,
    renderedAt: now(),
  });
  check(
    "a previs clip records path + scene provenance, codec and dimensions",
    clip.source === "local_previs" &&
      clip.pathFingerprint === savedPath2.pathFingerprint &&
      clip.sceneFingerprint === saved2.sceneFingerprint &&
      clip.container === "mp4" &&
      clip.renderWidth === 956,
  );
  check(
    "clips list newest first and read back by id",
    (await owner.listPrevisClips(shot.id))[0]?.id === clip.id &&
      (await owner.getPrevisClip(clip.id))?.assetId === clipAsset,
  );
  const refs = await owner.listSpatialReferences(projectId);
  const motion = refs[shot.id]?.cameraMotion;
  check(
    "the spatial reference freezes cameraMotion by value with the matching previs asset",
    !!motion &&
      motion.cameraPathFingerprint === savedPath2.pathFingerprint &&
      motion.keyframes.length === 3 &&
      motion.previsAssetId === clipAsset &&
      motion.sceneFingerprint === saved2.sceneFingerprint &&
      refs[shot.id].sceneFingerprint === saved3.sceneFingerprint,
  );
  const clip2 = await expectError(() =>
    owner.recordPrevisClip({
      ...clipBase,
      id: randomUUID(),
      assetId: clipAsset,
      hasAudio: true,
      audioAssetId: null,
      renderedAt: now(),
    }),
  );
  check("has_audio without an audio asset is rejected", clip2 !== null);

  // RLS and isolation
  check("stranger cannot read the camera path", (await strangerRepo.getCameraPathForShot(shot.id)) === null);
  check("stranger cannot read previs clips", (await strangerRepo.listPrevisClips(shot.id)).length === 0);
  const strangerPathWrite = await expectError(() =>
    strangerRepo.saveCameraPath({
      ...pathBase,
      id: randomUUID(),
      path: path1,
      expectedRevision: 2,
      userId: stranger,
      now: now(),
    }),
  );
  check("stranger cannot mutate the camera path", strangerPathWrite !== null);
  const strangerClip = await expectError(() =>
    strangerRepo.recordPrevisClip({
      ...clipBase,
      id: randomUUID(),
      assetId: clipAsset,
      userId: stranger,
      renderedAt: now(),
    }),
  );
  check("stranger cannot record a previs clip", strangerClip !== null);
  const crossPath = await asOwner(
    `insert into shot_camera_paths (project_id, shot_id, location_id, scene_document_id, scene_revision, scene_fingerprint,
        schema_version, duration_ms, frame_rate, path_json, path_fingerprint)
     values ($1,$2,$3,$4,1,$5,'prism.camera-path.v1',1000,24,'{}'::jsonb,$5)`,
    [otherProject, shot.id, otherLocation, sceneId, "0".repeat(64)],
  );
  check(
    "a camera path cannot mix a shot, location and scene from different projects",
    crossPath.error !== null,
  );
  const movePath = await pool
    .query("update shot_camera_paths set shot_id = gen_random_uuid() where id = $1", [savedPath.id])
    .then(
      () => null,
      (e: Error) => e.message,
    );
  check("a camera path cannot move to another shot", movePath !== null);
  const pathBack = await pool
    .query("update shot_camera_paths set revision = 1 where id = $1", [savedPath.id])
    .then(
      () => null,
      (e: Error) => e.message,
    );
  check("the camera-path revision cannot decrease", pathBack !== null && /cannot decrease/.test(pathBack));
  const badPathSchema = await pool
    .query(
      `insert into shot_camera_paths (project_id, shot_id, location_id, scene_document_id, scene_revision, scene_fingerprint,
          schema_version, duration_ms, frame_rate, path_json, path_fingerprint)
       values ($1,$2,$3,$4,1,$5,'other.v2',1000,24,'{}'::jsonb,$5)`,
      [projectId, noCamLoc, tmpLocation, sceneId, "0".repeat(64)],
    )
    .then(
      () => null,
      (e: Error) => e.message,
    );
  check("an unknown camera-path schema_version is rejected", badPathSchema !== null);
  const badContainer = await pool
    .query("update shot_previs_clips set container = 'avi' where id = $1", [clip.id])
    .then(
      () => null,
      (e: Error) => e.message,
    );
  check("an unknown previs container is rejected", badContainer !== null);
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
  "cleanup left no test rows (cascade removed scenes, bookmarks, master frames, paths, clips)",
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
