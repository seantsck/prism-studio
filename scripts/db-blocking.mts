// Integration tests for Phase 2F M2B shot-specific character blocking against the REAL dedicated Prism Studio
// database (migration 0033: shot_character_blocking + render blocking provenance).
//   npm run db:blocking
//
// Exercises (with real rows, cleaned up afterwards): save/reload, compare-and-set revisions, one row per
// (shot, character), CROSS-SHOT isolation (same Character and Location, different Shots), the explicit
// re-anchor, owner-only RLS (owner / stranger / anon), cross-project isolation through composite foreign keys,
// check constraints, the guarantee that NEITHER worker role has any access, render provenance on master frames
// and previs clips, the package reference, no ephemeral URL in stored JSON, and cascade cleanup.
// Requires `npm run db:seed` first (uses the demo project). No provider call.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { PostgresPrevisData } from "../src/data/previs-postgres";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import {
  blockingFingerprint,
  newBlockingEntry,
  renderedBlockingProvenance,
} from "../src/domain/previs/blocking";
import { buildPrevisDocument } from "../src/domain/previs/document";
import { buildHotelCanopyCameraPath, buildHotelCanopyEngineScene } from "../src/domain/previs/hotel-canopy";
import { poseFingerprint, presetById, withHeadDirection } from "../src/domain/previs/pose";
import { isShotBlockingStale } from "../src/domain/previs/spatial";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "shot character blocking integration tests (rows created, then removed)",
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
const anonRepo = new PostgresPrevisData(pool, rlsPreamble(null, "anon"));
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
const err = (fn: () => Promise<unknown>) =>
  fn().then(
    () => null as string | null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
const sqlErr = (sql: string, params: unknown[] = []) =>
  pool.query(sql, params).then(
    () => null as string | null,
    (e: Error) => e.message,
  );

const created = { projectIds: [] as string[], assetIds: [] as string[], locationIds: [] as string[] };

try {
  const data = (await admin.loadProject("ojousama"))!;
  const projectId = data.project.id;
  const shotA = data.shots.find((s) => s.shotCode === "2A")!;
  const shotB = data.shots.find((s) => s.shotCode === "2B")!;
  const yumeko = data.characters.find((c) => c.name === "Yumeko")!;
  const sean = data.characters.find((c) => c.name === "Sean")!;

  // ── 1. structure and security ──
  const rls = await pool.query(
    "select relrowsecurity from pg_class where relname = 'shot_character_blocking' and relkind = 'r'",
  );
  check(
    "shot_character_blocking exists with row-level security enabled",
    rls.rows[0]?.relrowsecurity === true,
  );
  const pol = await pool.query(
    "select 1 from pg_policies where schemaname = 'public' and tablename = 'shot_character_blocking' and 'authenticated' = any(roles)",
  );
  check("an owner policy exists for authenticated users", (pol.rowCount ?? 0) >= 1);
  const comp = await pool.query(
    "select 1 from pg_constraint where conrelid = 'characters'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (id, project_id)'",
  );
  check(
    "characters has the composite (id, project_id) key the project-safe FKs need",
    (comp.rowCount ?? 0) === 1,
  );
  for (const role of ["prism_generation_worker", "prism_continuity_worker"]) {
    const exists = await pool.query("select 1 from pg_roles where rolname = $1", [role]);
    if (exists.rowCount === 0) {
      check(`${role}: role not present (skipped)`, true);
      continue;
    }
    const p = await pool.query(
      `select has_table_privilege($1, 'public.shot_character_blocking', 'select') as s,
              has_table_privilege($1, 'public.shot_character_blocking', 'insert') as i,
              has_table_privilege($1, 'public.shot_character_blocking', 'update') as u,
              has_table_privilege($1, 'public.shot_character_blocking', 'delete') as d`,
      [role],
    );
    const r = p.rows[0];
    check(`${role} has NO privilege on shot_character_blocking`, !r.s && !r.i && !r.u && !r.d);
  }

  // a private location + saved set for this suite
  const tmpLocation = randomUUID();
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
    [tmpLocation, projectId, "db:blocking set location"],
  );
  created.locationIds.push(tmpLocation);
  const sceneId = randomUUID();
  const scene1 = await owner.saveScene({
    id: sceneId,
    projectId,
    locationId: tmpLocation,
    document: buildPrevisDocument({ engineScene: buildHotelCanopyEngineScene() }),
    expectedRevision: null,
    engineVersion: "test",
    userId: dev.id,
    now: now(),
  });
  const save = (
    shotId: string,
    characterId: string,
    entry: ReturnType<typeof newBlockingEntry>,
    expected: number | null,
  ) =>
    owner.saveShotBlocking({
      id: randomUUID(),
      projectId,
      shotId,
      characterId,
      locationId: tmpLocation,
      sceneDocumentId: sceneId,
      sceneRevision: scene1.revision,
      sceneFingerprint: scene1.sceneFingerprint,
      entry,
      expectedRevision: expected,
      userId: dev.id,
      now: now(),
    });
  const anchor = { locationId: tmpLocation };

  // ── 2. save, reload, fingerprints ──
  const aEntry = {
    ...newBlockingEntry(yumeko.id, { x: -0.8, y: 0, z: -4.6 }),
    pose: withHeadDirection(presetById("hands_on_hips").pose, 20, 0),
  };
  const a1 = await save(shotA.id, yumeko.id, aEntry, null);
  check(
    "first save creates revision 1 with the rig + schema versions",
    a1.revision === 1 &&
      a1.rigVersion === "prism.humanoid-rig.v1" &&
      a1.schemaVersion === "prism.shot-blocking.v1",
  );
  check(
    "the stored set revision + fingerprint are the live ones",
    a1.sceneRevision === scene1.revision && a1.sceneFingerprint === scene1.sceneFingerprint,
  );
  check(
    "stored fingerprints equal the domain fingerprints",
    a1.blockingFingerprint === blockingFingerprint(aEntry, anchor) &&
      a1.poseFingerprint === poseFingerprint(aEntry.pose),
  );
  const reload = (await owner.listShotBlocking(shotA.id))[0];
  check(
    "reload returns the identical root + pose (quaternions authoritative)",
    !!reload && JSON.stringify(reload.entry) === JSON.stringify(aEntry),
  );
  const stored = await pool.query(
    "select (root_position::text || root_orientation::text || pose_json::text) as t, root_scale from shot_character_blocking where id = $1",
    [a1.id],
  );
  check(
    "no signed URL, blob URL or http reference is stored",
    !/https?:\/\/|blob:|X-Amz|signature=/i.test(String(stored.rows[0].t)),
  );
  check(
    "only joints that differ from neutral are stored",
    Object.keys(reload.entry.pose.joints).length < 20 && !("root" in reload.entry.pose.joints),
  );

  // ── 3. compare-and-set ──
  const moved = { ...aEntry, root: { ...aEntry.root, position: { x: 1, y: 0, z: -4.6 } } };
  const a2 = await save(shotA.id, yumeko.id, moved, 1);
  check(
    "a compare-and-set save advances to revision 2 on the same row",
    a2.revision === 2 && a2.id === a1.id,
  );
  check(
    "the blocking fingerprint changed with the moved root",
    a2.blockingFingerprint !== a1.blockingFingerprint && a2.poseFingerprint === a1.poseFingerprint,
  );
  check(
    "a stale revision is rejected as a conflict",
    /changed elsewhere/.test((await err(() => save(shotA.id, yumeko.id, aEntry, 1))) ?? ""),
  );
  check(
    "a second 'first save' for the same (shot, character) is a conflict",
    (await err(() => save(shotA.id, yumeko.id, aEntry, null))) !== null,
  );

  // ── 4. CROSS-SHOT isolation: same Character, same Location, different Shots ──
  const bEntry = { ...newBlockingEntry(yumeko.id, { x: 3, y: 0, z: 1 }), pose: presetById("seated").pose };
  const b1 = await save(shotB.id, yumeko.id, bEntry, null);
  const beforeB = (await pool.query("select * from shot_character_blocking where id = $1", [b1.id])).rows[0];
  await save(shotA.id, yumeko.id, { ...moved, pose: presetById("walk_a").pose }, 2);
  const afterB = (await pool.query("select * from shot_character_blocking where id = $1", [b1.id])).rows[0];
  check("Shot A and Shot B hold separate rows for the same Character", a1.id !== b1.id);
  check("editing Shot A never modifies Shot B's row", JSON.stringify(beforeB) === JSON.stringify(afterB));
  check(
    "Shot B reads back its own pose and root",
    JSON.stringify((await owner.listShotBlocking(shotB.id))[0].entry) === JSON.stringify(bEntry),
  );
  const seanRow = await save(shotA.id, sean.id, newBlockingEntry(sean.id, { x: 3, y: 0, z: -1.4 }), null);
  check(
    "one Shot can hold several Characters",
    (await owner.listShotBlocking(shotA.id)).length === 2 && !!seanRow,
  );
  const dup = await sqlErr(
    `insert into shot_character_blocking (project_id, shot_id, character_id, location_id, scene_document_id, scene_revision, scene_fingerprint,
       schema_version, rig_version, root_position, root_orientation, root_scale, pose_json, pose_fingerprint, blocking_fingerprint)
     select project_id, shot_id, character_id, location_id, scene_document_id, scene_revision, scene_fingerprint, schema_version, rig_version,
       root_position, root_orientation, root_scale, pose_json, pose_fingerprint, blocking_fingerprint from shot_character_blocking where id = $1`,
    [a1.id],
  );
  check("the database allows only one row per (shot, character)", dup !== null);

  // ── 5. staleness + explicit re-anchor ──
  const moved2 = buildHotelCanopyEngineScene();
  moved2.scene[3].position = { x: 1, y: 1.2, z: -5.75 };
  const scene2 = await owner.saveScene({
    id: randomUUID(),
    projectId,
    locationId: tmpLocation,
    document: buildPrevisDocument({ engineScene: moved2 }),
    expectedRevision: 1,
    engineVersion: "test",
    userId: dev.id,
    now: now(),
  });
  const refsStale = await owner.listSpatialReferences(projectId);
  check(
    "a package reference exists for a shot that only has blocking",
    !!refsStale[shotA.id]?.shotBlocking && refsStale[shotA.id].shotBlocking!.figures.length === 2,
  );
  check(
    "after a Set change the blocking is STALE (not deleted)",
    isShotBlockingStale(refsStale[shotA.id]) && (await owner.listShotBlocking(shotA.id)).length === 2,
  );
  const beforeAnchor = (await owner.listShotBlocking(shotA.id)).find((r) => r.characterId === yumeko.id)!;
  const re = await owner.reanchorShotBlocking({
    projectId,
    shotId: shotA.id,
    sceneDocumentId: sceneId,
    userId: dev.id,
    now: now(),
  });
  const reY = re.find((r) => r.characterId === yumeko.id)!;
  check(
    "re-anchoring records the live set revision + fingerprint",
    re.length === 2 &&
      reY.sceneRevision === scene2.revision &&
      reY.sceneFingerprint === scene2.sceneFingerprint,
  );
  check(
    "re-anchoring changes neither the root nor the pose nor the blocking identity",
    JSON.stringify(reY.entry) === JSON.stringify(beforeAnchor.entry) &&
      reY.blockingFingerprint === beforeAnchor.blockingFingerprint &&
      reY.revision === beforeAnchor.revision + 1,
  );
  check(
    "Shot B was not re-anchored by re-anchoring Shot A",
    (await owner.listShotBlocking(shotB.id))[0].sceneRevision === scene1.revision,
  );
  check(
    "after re-anchoring the package reference is no longer stale",
    !isShotBlockingStale((await owner.listSpatialReferences(projectId))[shotA.id]),
  );

  // ── 6. RLS: owner / stranger / anon ──
  check("stranger cannot read blocking", (await strangerRepo.listShotBlocking(shotA.id)).length === 0);
  check(
    "stranger cannot mutate blocking",
    (await err(() =>
      strangerRepo.saveShotBlocking({
        id: randomUUID(),
        projectId,
        shotId: shotA.id,
        characterId: yumeko.id,
        locationId: tmpLocation,
        sceneDocumentId: sceneId,
        sceneRevision: 1,
        sceneFingerprint: scene1.sceneFingerprint,
        entry: aEntry,
        expectedRevision: 3,
        userId: stranger,
        now: now(),
      }),
    )) !== null,
  );
  const sIns = await asStranger(
    `insert into shot_character_blocking (project_id, shot_id, character_id, location_id, scene_document_id, scene_revision, scene_fingerprint,
       schema_version, rig_version, root_position, root_orientation, root_scale, pose_json, pose_fingerprint, blocking_fingerprint)
     values ($1,$2,$3,$4,$5,1,$6,'prism.shot-blocking.v1','prism.humanoid-rig.v1','{}','{}',1,'{"schema":"prism.pose.v1","rig":"prism.humanoid-rig.v1"}',$6,$6)`,
    [projectId, shotB.id, sean.id, tmpLocation, sceneId, "0".repeat(64)],
  );
  check("stranger insert is blocked by row-level security", sIns.error !== null);
  check(
    "stranger update touches no row",
    (
      await asStranger(
        "update shot_character_blocking set revision = revision + 1 where id = $1 returning id",
        [a1.id],
      )
    ).rows.length === 0,
  );
  check(
    "stranger delete touches no row",
    (await asStranger("delete from shot_character_blocking where id = $1 returning id", [a1.id])).rows
      .length === 0,
  );
  check(
    "anon has no access",
    (await err(() => anonRepo.listShotBlocking(shotA.id))) !== null ||
      (await anonRepo.listShotBlocking(shotA.id)).length === 0,
  );

  // ── 7. cross-project isolation + guards ──
  const otherProject = randomUUID();
  await pool.query("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
    otherProject,
    dev.id,
    `db-blocking-${otherProject.slice(0, 8)}`,
    "db:blocking other project",
  ]);
  created.projectIds.push(otherProject);
  const otherChar = randomUUID();
  await pool.query("insert into characters (id, project_id, name) values ($1,$2,$3)", [
    otherChar,
    otherProject,
    "db:blocking foreign character",
  ]);
  const otherLoc = randomUUID();
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
    [otherLoc, otherProject, "db:blocking other location"],
  );
  const ins = (cols: { project: string; shot: string; character: string; location: string; scene: string }) =>
    asOwner(
      `insert into shot_character_blocking (project_id, shot_id, character_id, location_id, scene_document_id, scene_revision, scene_fingerprint,
         schema_version, rig_version, root_position, root_orientation, root_scale, pose_json, pose_fingerprint, blocking_fingerprint)
       values ($1,$2,$3,$4,$5,1,$6,'prism.shot-blocking.v1','prism.humanoid-rig.v1','{}','{}',1,'{"schema":"prism.pose.v1","rig":"prism.humanoid-rig.v1"}',$6,$6)`,
      [cols.project, cols.shot, cols.character, cols.location, cols.scene, "0".repeat(64)],
    );
  check(
    "blocking cannot reference a Character from another project",
    (
      await ins({
        project: projectId,
        shot: shotB.id,
        character: otherChar,
        location: tmpLocation,
        scene: sceneId,
      })
    ).error !== null,
  );
  check(
    "blocking cannot reference a Shot from another project",
    (
      await ins({
        project: otherProject,
        shot: shotB.id,
        character: otherChar,
        location: otherLoc,
        scene: sceneId,
      })
    ).error !== null,
  );
  check(
    "blocking cannot reference a Location from another project",
    (
      await ins({
        project: projectId,
        shot: shotB.id,
        character: sean.id,
        location: otherLoc,
        scene: sceneId,
      })
    ).error !== null,
  );
  check(
    "blocking cannot be moved between projects",
    (await sqlErr("update shot_character_blocking set project_id = $2 where id = $1", [
      a1.id,
      otherProject,
    ])) !== null,
  );
  check(
    "blocking cannot be moved to another Shot",
    (await sqlErr("update shot_character_blocking set shot_id = $2 where id = $1", [a1.id, shotB.id])) !==
      null,
  );
  check(
    "blocking cannot be re-pointed at another Character",
    (await sqlErr("update shot_character_blocking set character_id = $2 where id = $1", [a1.id, sean.id])) !==
      null,
  );
  check(
    "the revision cannot decrease",
    /cannot decrease/.test(
      (await sqlErr("update shot_character_blocking set revision = 1 where id = $1", [a1.id])) ?? "",
    ),
  );

  // ── 8. check constraints ──
  const bad = (set: string) => sqlErr(`update shot_character_blocking set ${set} where id = $1`, [b1.id]);
  check(
    "an unknown blocking schema_version is rejected",
    (await bad("schema_version = 'other.v9'")) !== null,
  );
  check("an unknown rig_version is rejected", (await bad("rig_version = 'other.rig'")) !== null);
  check("a non-positive scale is rejected", (await bad("root_scale = 0")) !== null);
  check("a malformed fingerprint is rejected", (await bad("blocking_fingerprint = 'short'")) !== null);
  check(
    "a pose that is not prism.pose.v1 is rejected",
    (await bad(`pose_json = '{"schema":"x","rig":"prism.humanoid-rig.v1"}'::jsonb`)) !== null,
  );
  check(
    "a pose authored on a different rig than rig_version is rejected",
    (await bad(`pose_json = '{"schema":"prism.pose.v1","rig":"other"}'::jsonb`)) !== null,
  );

  // ── 9. render provenance ──
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
  const recs = await owner.listShotBlocking(shotA.id);
  const prov = renderedBlockingProvenance(
    recs.map((r) => ({
      id: r.id,
      characterId: r.characterId,
      revision: r.revision,
      entry: r.entry,
      sceneRevision: r.sceneRevision,
      sceneFingerprint: r.sceneFingerprint,
    })),
    anchor,
  )!;
  const frameAsset = await mkAsset("db:blocking master frame", "image", "image/png", "3d_render");
  const frame = await owner.recordMasterFrame({
    id: randomUUID(),
    projectId,
    shotId: shotA.id,
    locationId: tmpLocation,
    sceneDocumentId: sceneId,
    sceneRevision: scene2.revision,
    sceneFingerprint: scene2.sceneFingerprint,
    cameraBookmarkId: null,
    assetId: frameAsset,
    renderWidth: 1912,
    renderHeight: 800,
    productionAspectRatio: "2.39:1",
    capturedAt: now(),
    blockingFingerprint: prov.fingerprint,
    blocking: prov.figures,
    userId: dev.id,
  });
  const frameBack = (await owner.listMasterFrames(shotA.id))[0];
  check(
    "a master frame records which blocking it showed (fingerprint + per-figure revision)",
    frame.blockingFingerprint === prov.fingerprint && isDeepStrictEqual(frameBack.blocking, prov.figures),
  );
  const plainAsset = await mkAsset("db:blocking master frame none", "image", "image/png", "3d_render");
  const plain = await owner.recordMasterFrame({
    id: randomUUID(),
    projectId,
    shotId: shotB.id,
    locationId: tmpLocation,
    sceneDocumentId: sceneId,
    sceneRevision: 1,
    sceneFingerprint: scene1.sceneFingerprint,
    cameraBookmarkId: null,
    assetId: plainAsset,
    renderWidth: 1912,
    renderHeight: 800,
    productionAspectRatio: "2.39:1",
    capturedAt: now(),
    userId: dev.id,
  });
  check(
    "a render without proxies stores NULL blocking provenance (the pre-M2B shape)",
    plain.blockingFingerprint === null && plain.blocking === null,
  );
  check(
    "a fingerprint without its provenance json is rejected",
    (await sqlErr("update scene_master_frames set blocking_json = null where id = $1", [frame.id])) !== null,
  );

  const path = await owner.saveCameraPath({
    id: randomUUID(),
    projectId,
    shotId: shotA.id,
    locationId: tmpLocation,
    sceneDocumentId: sceneId,
    sceneRevision: scene2.revision,
    sceneFingerprint: scene2.sceneFingerprint,
    path: buildHotelCanopyCameraPath(),
    expectedRevision: null,
    userId: dev.id,
    now: now(),
  });
  const clipAsset = await mkAsset("db:blocking previs", "video", "video/mp4", "local_previs");
  const clip = await owner.recordPrevisClip({
    id: randomUUID(),
    projectId,
    shotId: shotA.id,
    locationId: tmpLocation,
    cameraPathId: path.id,
    pathRevision: path.revision,
    pathFingerprint: path.pathFingerprint,
    sceneDocumentId: sceneId,
    sceneRevision: scene2.revision,
    sceneFingerprint: scene2.sceneFingerprint,
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
    blockingFingerprint: prov.fingerprint,
    blocking: prov.figures,
    renderedAt: now(),
    userId: dev.id,
  });
  check(
    "a previs clip records the blocking it showed",
    clip.blockingFingerprint === prov.fingerprint && clip.blocking?.length === 2,
  );
  const ref1 = (await owner.listSpatialReferences(projectId))[shotA.id];
  check(
    "the package references the previs that showed the CURRENT blocking",
    ref1.cameraMotion?.previsAssetId === clipAsset,
  );
  // change Yumeko's pose: the previs no longer shows the current blocking
  const cur = (await owner.listShotBlocking(shotA.id)).find((r) => r.characterId === yumeko.id)!;
  await owner.saveShotBlocking({
    id: randomUUID(),
    projectId,
    shotId: shotA.id,
    characterId: yumeko.id,
    locationId: tmpLocation,
    sceneDocumentId: sceneId,
    sceneRevision: scene2.revision,
    sceneFingerprint: scene2.sceneFingerprint,
    entry: { ...cur.entry, pose: presetById("seated").pose },
    expectedRevision: cur.revision,
    userId: dev.id,
    now: now(),
  });
  const ref2 = (await owner.listSpatialReferences(projectId))[shotA.id];
  check(
    "after a pose change the old previs is no longer referenced as current",
    ref2.cameraMotion?.previsAssetId === null,
  );
  check(
    "history is retained: the clip row is unchanged",
    (await owner.listPrevisClips(shotA.id)).some(
      (c) => c.id === clip.id && c.blockingFingerprint === prov.fingerprint,
    ),
  );
  check(
    "a previs fingerprint without its provenance json is rejected",
    (await sqlErr("update shot_previs_clips set blocking_json = null where id = $1", [clip.id])) !== null,
  );
  const stored2 = await pool.query("select (blocking_json::text) as t from shot_previs_clips where id = $1", [
    clip.id,
  ]);
  check(
    "render provenance holds ids + fingerprints only, never a URL or pose data",
    !/https?:|blob:|joints|quaternion/i.test(String(stored2.rows[0].t)),
  );

  // ── 10. removal ──
  const seanNow = (await owner.listShotBlocking(shotA.id)).find((r) => r.characterId === sean.id)!;
  await owner.removeShotBlocking({
    projectId,
    shotId: shotA.id,
    characterId: sean.id,
    expectedRevision: seanNow.revision,
  });
  check(
    "removing a figure from one Shot leaves the others",
    (await owner.listShotBlocking(shotA.id)).length === 1 &&
      (await owner.listShotBlocking(shotB.id)).length === 1,
  );
  check(
    "a stale removal is a conflict",
    /changed elsewhere/.test(
      (await err(() =>
        owner.removeShotBlocking({
          projectId,
          shotId: shotB.id,
          characterId: yumeko.id,
          expectedRevision: 9,
        }),
      )) ?? "",
    ),
  );
} finally {
  // cleanup: the temporary location cascades its scene → blocking rows, master frames, paths and clips
  for (const id of created.projectIds)
    await pool.query("delete from projects where id = $1", [id]).catch(() => undefined);
  for (const id of created.locationIds)
    await pool.query("delete from locations where id = $1", [id]).catch(() => undefined);
  for (const id of created.assetIds)
    await pool.query("delete from assets where id = $1", [id]).catch(() => undefined);
}

const leftover = await pool.query(
  `select (select count(*)::int from shot_character_blocking where location_id = any($1::uuid[])) as blocking,
          (select count(*)::int from assets where name like 'db:blocking%') as assets,
          (select count(*)::int from locations where name like 'db:blocking%') as locations,
          (select count(*)::int from projects where title like 'db:blocking%') as projects,
          (select count(*)::int from characters where name like 'db:blocking%') as characters`,
  [created.locationIds],
);
const l = leftover.rows[0];
check(
  "cleanup left no test rows (cascade removed blocking, frames, paths and clips)",
  l.blocking === 0 && l.assets === 0 && l.locations === 0 && l.projects === 0 && l.characters === 0,
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
