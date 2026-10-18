// Integration tests for Phase 2F M2C spatial control-pass bundles against the REAL dedicated Prism Studio
// database (migration 0034: shot_spatial_pass_bundles + the 'data' asset type / 'spatial_control' purpose).
//   npm run db:spatial-passes
//
// Exercises (with real rows, cleaned up afterwards): record/reload by value, exact-frame dedupe, immutability,
// check constraints, project-safe composite foreign keys, asset pinning, owner-only RLS (owner / stranger / anon),
// that NEITHER worker role has any access, the truthful asset taxonomy, the private bucket's machine MIME types,
// the GenerationPackage reference (current / stale / audio-independent), and cascade cleanup.
// Requires `npm run db:seed` first (uses the demo project). No provider call. Raster BYTES are not stored here
// (the Storage upload path is covered by the Supabase e2e); this suite proves the relational contract.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { PostgresPrevisData } from "../src/data/previs-postgres";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import type { NewSpatialPassBundle } from "../src/data/previs-repository";
import { newBlockingEntry, renderedBlockingProvenance } from "../src/domain/previs/blocking";
import { buildPrevisDocument } from "../src/domain/previs/document";
import { assetSchema } from "../src/domain/schemas";
import { persistPassBundle, type PassStoreDeps } from "../src/server/spatial-pass-store";
import { buildHotelCanopyCameraPath, buildHotelCanopyEngineScene } from "../src/domain/previs/hotel-canopy";
import {
  CHARACTER_MASKS_SCHEMA,
  CHARACTER_MASK_FORMAT,
  DEPTH_FORMAT,
  OBJECT_ID_FORMAT,
  SPATIAL_MIME,
  cameraSourceFromBookmark,
  cameraSourceFromPath,
  depthMetadata,
  expectedManifest,
  spatialBundleFingerprint,
  type CharacterMasksJson,
  type ControlCameraSource,
} from "../src/domain/previs/spatial-passes";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "spatial control-pass integration tests (rows created, then removed)",
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

  // ── 1. structure, taxonomy and security ──
  const rls = await pool.query(
    "select relrowsecurity from pg_class where relname = 'shot_spatial_pass_bundles' and relkind = 'r'",
  );
  check(
    "shot_spatial_pass_bundles exists with row-level security enabled",
    rls.rows[0]?.relrowsecurity === true,
  );
  const pol = await pool.query(
    "select 1 from pg_policies where schemaname = 'public' and tablename = 'shot_spatial_pass_bundles' and 'authenticated' = any(roles)",
  );
  check("an owner policy exists for authenticated users", (pol.rowCount ?? 0) >= 1);
  for (const role of ["prism_generation_worker", "prism_continuity_worker"]) {
    const exists = await pool.query("select 1 from pg_roles where rolname = $1", [role]);
    if (exists.rowCount === 0) {
      check(`${role}: role not present (skipped)`, true);
      continue;
    }
    const p = await pool.query(
      `select has_table_privilege($1, 'public.shot_spatial_pass_bundles', 'select') as s,
              has_table_privilege($1, 'public.shot_spatial_pass_bundles', 'insert') as i,
              has_table_privilege($1, 'public.shot_spatial_pass_bundles', 'update') as u,
              has_table_privilege($1, 'public.shot_spatial_pass_bundles', 'delete') as d`,
      [role],
    );
    const r = p.rows[0];
    check(`${role} has NO privilege on shot_spatial_pass_bundles`, !r.s && !r.i && !r.u && !r.d);
  }
  const bucket = await pool.query(
    "select public, allowed_mime_types from storage.buckets where id = 'prism-assets'",
  );
  const mimes: string[] = bucket.rows[0]?.allowed_mime_types ?? [];
  check("the asset bucket is still private", bucket.rows[0]?.public === false);
  check(
    "the private bucket accepts the three machine-data MIME types",
    Object.values(SPATIAL_MIME).every((m) => mimes.includes(m)),
  );
  check("the bucket still accepts images (nothing was removed)", mimes.includes("image/png"));

  const mkAsset = async (
    name: string,
    type = "data",
    purpose = "spatial_control",
    mime: string = SPATIAL_MIME.depth,
    project = projectId,
  ) => {
    const id = randomUUID();
    await pool.query(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, mime, metadata)
       values ($1,$2,$3,$4,$5,'3d_render','none',$6,'{}'::jsonb)`,
      [id, project, name, type, purpose, mime],
    );
    created.assetIds.push(id);
    return id;
  };
  const rawAsset = await mkAsset("db:spatial raw asset");
  check("a machine raster is an Asset of type 'data' / purpose 'spatial_control' (not an image)", !!rawAsset);
  check(
    "an unknown asset type is still rejected",
    (await sqlErr(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, metadata)
       values (gen_random_uuid(), $1, 'db:spatial bad type', 'blob', 'other', 'upload', 'none', '{}'::jsonb)`,
      [projectId],
    )) !== null,
  );
  check(
    "an unknown asset purpose is still rejected",
    (await sqlErr(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, metadata)
       values (gen_random_uuid(), $1, 'db:spatial bad purpose', 'data', 'whatever', 'upload', 'none', '{}'::jsonb)`,
      [projectId],
    )) !== null,
  );

  // a private location + saved set + camera path + bookmark + blocking for this suite
  const tmpLocation = randomUUID();
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
    [tmpLocation, projectId, "db:spatial-passes set location"],
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
  const base = {
    projectId,
    shotId: shotA.id,
    locationId: tmpLocation,
    sceneDocumentId: sceneId,
    sceneRevision: scene1.revision,
    sceneFingerprint: scene1.sceneFingerprint,
    userId: dev.id,
    now: now(),
  };
  const bookmark = await owner.setBookmark({ id: randomUUID(), ...base });
  const path = await owner.saveCameraPath({
    id: randomUUID(),
    ...base,
    path: buildHotelCanopyCameraPath(),
    expectedRevision: null,
  });
  const blocking = await owner.saveShotBlocking({
    id: randomUUID(),
    projectId,
    shotId: shotA.id,
    characterId: yumeko.id,
    locationId: tmpLocation,
    sceneDocumentId: sceneId,
    sceneRevision: scene1.revision,
    sceneFingerprint: scene1.sceneFingerprint,
    entry: newBlockingEntry(yumeko.id, { x: 0.5, y: 0, z: -2 }),
    expectedRevision: null,
    userId: dev.id,
    now: now(),
  });

  // a bundle built exactly the way the server action does, from SAVED state
  const pathSource = (timeMs: number) =>
    cameraSourceFromPath(
      path.path,
      { id: path.id, revision: path.revision, pathFingerprint: path.pathFingerprint },
      timeMs,
    );
  const bookmarkSource = cameraSourceFromBookmark({ id: bookmark.id }, bookmark.value);
  async function makeBundle(camera: ControlCameraSource, tag: string): Promise<NewSpatialPassBundle> {
    const scn = (await owner.getScene(sceneId))!;
    const records = await owner.listShotBlocking(shotA.id);
    const manifest = expectedManifest(scn.document, records, { [yumeko.id]: "Yumeko" });
    const prov = renderedBlockingProvenance(records, { locationId: tmpLocation });
    const depthAsset = await mkAsset(`db:spatial depth ${tag}`);
    const idAsset = await mkAsset(`db:spatial ids ${tag}`, "data", "spatial_control", SPATIAL_MIME.objectIds);
    const maskAssets: Record<string, string> = {};
    for (const r of records.filter((x) => x.entry.visibility))
      maskAssets[r.characterId] = await mkAsset(
        `db:spatial mask ${tag}`,
        "data",
        "spatial_control",
        SPATIAL_MIME.characterMask,
      );
    const characterMasks: CharacterMasksJson = {
      schema: CHARACTER_MASKS_SCHEMA,
      masks: Object.fromEntries(
        records
          .filter((r) => r.entry.visibility)
          .map((r) => [
            r.characterId,
            {
              blockingId: r.id,
              blockingRevision: r.revision,
              blockingFingerprint: r.blockingFingerprint,
              objectIndex: manifest.objects.find((o) => o.characterId === r.characterId)!.index,
              assetId: maskAssets[r.characterId],
              encoding: CHARACTER_MASK_FORMAT,
              visiblePixelCount: 4321,
            },
          ]),
      ),
    };
    return {
      id: randomUUID(),
      projectId,
      shotId: shotA.id,
      locationId: tmpLocation,
      sceneDocumentId: scn.id,
      sceneRevision: scn.revision,
      sceneFingerprint: scn.sceneFingerprint,
      blockingFingerprint: prov?.fingerprint ?? null,
      camera,
      bundleFingerprint: spatialBundleFingerprint({
        shotId: shotA.id,
        sceneFingerprint: scn.sceneFingerprint,
        blockingFingerprint: prov?.fingerprint ?? null,
        camera,
        width: 1912,
        height: 800,
        manifest,
      }),
      width: 1912,
      height: 800,
      depth: {
        assetId: depthAsset,
        encoding: DEPTH_FORMAT,
        metadata: depthMetadata({ validPixelCount: 123456, minDepth: 1.5, maxDepth: 22.25 }),
      },
      objectIds: { assetId: idAsset, encoding: OBJECT_ID_FORMAT, manifest },
      characterMasks,
      createdAt: now(),
      userId: dev.id,
    };
  }

  // ── 2. record, reload by value, dedupe ──
  const b1In = await makeBundle(pathSource(2000), "b1");
  const b1 = await owner.recordSpatialPassBundle(b1In);
  check("a bundle is recorded (not an existing one)", b1.existing === false);
  const back = (await owner.getSpatialPassBundle(b1.record.id))!;
  check(
    "reload returns the camera BY VALUE exactly (jsonb orders keys; values are identical)",
    isDeepStrictEqual(back.camera, b1In.camera),
  );
  check(
    "reload returns manifest, depth metadata and per-Character masks exactly",
    isDeepStrictEqual(back.objectIds.manifest, b1In.objectIds.manifest) &&
      isDeepStrictEqual(back.depth.metadata, b1In.depth.metadata) &&
      isDeepStrictEqual(back.characterMasks, b1In.characterMasks),
  );
  check(
    "a camera-path capture records path id, revision, fingerprint and time",
    back.camera.kind === "camera_path" &&
      (
        await pool.query(
          "select camera_path_id, camera_path_revision, camera_path_fingerprint, time_ms, camera_source from shot_spatial_pass_bundles where id = $1",
          [back.id],
        )
      ).rows.every(
        (r) =>
          r.camera_path_id === path.id &&
          r.camera_path_revision === path.revision &&
          r.camera_path_fingerprint === path.pathFingerprint &&
          r.time_ms === 2000 &&
          r.camera_source === "camera_path",
      ),
  );
  check(
    "masks are keyed by Character id (not list position) and carry blocking identity",
    Object.keys(back.characterMasks.masks).join() === yumeko.id &&
      back.characterMasks.masks[yumeko.id].blockingId === blocking.id &&
      back.characterMasks.masks[yumeko.id].blockingFingerprint === blocking.blockingFingerprint,
  );
  const json = await pool.query(
    `select (camera_json::text || depth_metadata_json::text || object_manifest_json::text || character_masks_json::text) as t
       from shot_spatial_pass_bundles where id = $1`,
    [back.id],
  );
  check(
    "no signed URL, blob URL or http reference is stored",
    !/https?:\/\/|blob:|X-Amz|signature=/i.test(String(json.rows[0].t)),
  );
  const again = await owner.recordSpatialPassBundle({
    ...(await makeBundle(pathSource(2000), "dup")),
    id: randomUUID(),
  });
  check(
    "the same exact control frame is captured once (existing bundle returned)",
    again.existing === true && again.record.id === b1.record.id,
  );
  check(
    "a different playhead time is a different bundle",
    (await owner.recordSpatialPassBundle(await makeBundle(pathSource(3000), "t3000"))).existing === false,
  );
  const bmIn = await makeBundle(bookmarkSource, "bm");
  const bm = await owner.recordSpatialPassBundle(bmIn);
  check(
    "a Production Camera bookmark capture records no path columns",
    bm.existing === false &&
      (
        await pool.query(
          "select camera_path_id, camera_path_revision, camera_path_fingerprint, time_ms from shot_spatial_pass_bundles where id = $1",
          [bm.record.id],
        )
      ).rows.every(
        (r) => r.camera_path_id === null && r.time_ms === null && r.camera_path_fingerprint === null,
      ),
  );
  check(
    "three bundles are stored for the Shot, newest first",
    (await owner.getSpatialPassBundle(bm.record.id))?.id === bm.record.id &&
      (await owner.listSpatialPassBundles(shotA.id)).length === 3,
  );
  check("another Shot has none", (await owner.listSpatialPassBundles(shotB.id)).length === 0);

  // ── 3. immutability ──
  check(
    "a bundle cannot be updated in place (width)",
    /immutable/.test(
      (await sqlErr("update shot_spatial_pass_bundles set width = 100 where id = $1", [back.id])) ?? "",
    ),
  );
  check(
    "a bundle's masks cannot be rewritten",
    /immutable/.test(
      (await sqlErr(
        "update shot_spatial_pass_bundles set character_masks_json = character_masks_json || '{\"x\":1}'::jsonb where id = $1",
        [back.id],
      )) ?? "",
    ),
  );
  check(
    "a bundle cannot be re-pointed at another Shot",
    (await sqlErr("update shot_spatial_pass_bundles set shot_id = $2 where id = $1", [back.id, shotB.id])) !==
      null,
  );

  // ── 4. check constraints ──
  const base2 = (over: Record<string, unknown>) => {
    const cols = {
      project_id: projectId,
      shot_id: shotA.id,
      location_id: tmpLocation,
      scene_document_id: sceneId,
      scene_revision: 1,
      scene_fingerprint: scene1.sceneFingerprint,
      blocking_fingerprint: null,
      camera_source: "bookmark",
      camera_json: JSON.stringify({ kind: "bookmark" }),
      camera_path_id: null,
      camera_path_revision: null,
      camera_path_fingerprint: null,
      time_ms: null,
      schema_version: "prism.spatial-pass-bundle.v1",
      bundle_fingerprint: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      width: 1912,
      height: 800,
      depth_asset_id: rawAsset,
      depth_encoding: "prism.depth-f32.v1",
      depth_metadata_json: JSON.stringify({ schema: "prism.depth-f32.v1" }),
      object_id_asset_id: rawAsset,
      object_id_encoding: "prism.object-id-u32.v1",
      object_manifest_json: JSON.stringify({ schema: "prism.object-id-manifest.v1", objects: [] }),
      character_masks_json: JSON.stringify({ schema: "prism.character-masks.v1", masks: {} }),
      ...over,
    };
    const keys = Object.keys(cols);
    return {
      sql: `insert into shot_spatial_pass_bundles (${keys.join(",")}) values (${keys.map((k, i) => (k.endsWith("_json") ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(",")})`,
      params: Object.values(cols),
    };
  };
  const tryInsert = async (over: Record<string, unknown>) => {
    const q = base2(over);
    return sqlErr(q.sql, q.params);
  };
  check("the minimal valid row inserts (control for the checks below)", (await tryInsert({})) === null);
  check(
    "an unknown bundle schema_version is rejected",
    (await tryInsert({ schema_version: "other.v9" })) !== null,
  );
  check(
    "a malformed bundle fingerprint is rejected",
    (await tryInsert({ bundle_fingerprint: "short" })) !== null,
  );
  check(
    "a malformed scene fingerprint is rejected",
    (await tryInsert({ scene_fingerprint: "short" })) !== null,
  );
  check(
    "a malformed blocking fingerprint is rejected",
    (await tryInsert({ blocking_fingerprint: "short" })) !== null,
  );
  check("an unknown camera source is rejected", (await tryInsert({ camera_source: "navigation" })) !== null);
  check(
    "the navigation/editor camera is not a camera source",
    (await tryInsert({ camera_source: "editor_camera" })) !== null,
  );
  check("a non-positive size is rejected", (await tryInsert({ width: 0 })) !== null);
  check("an unknown depth encoding is rejected", (await tryInsert({ depth_encoding: "raw" })) !== null);
  check(
    "an unknown object-id encoding is rejected",
    (await tryInsert({ object_id_encoding: "png" })) !== null,
  );
  check(
    "depth metadata must declare the same schema as the encoding",
    (await tryInsert({ depth_metadata_json: JSON.stringify({ schema: "other" }) })) !== null,
  );
  check(
    "the manifest must be a prism.object-id-manifest.v1",
    (await tryInsert({ object_manifest_json: JSON.stringify({ schema: "x" }) })) !== null,
  );
  check(
    "character masks must be a prism.character-masks.v1",
    (await tryInsert({ character_masks_json: JSON.stringify({ schema: "x" }) })) !== null,
  );
  check(
    "a camera-path source without its path identity is rejected",
    (await tryInsert({ camera_source: "camera_path" })) !== null,
  );
  check("a bookmark source with a playhead time is rejected", (await tryInsert({ time_ms: 5 })) !== null);
  check(
    "the same Shot + bundle fingerprint cannot be stored twice",
    (await tryInsert({ bundle_fingerprint: b1In.bundleFingerprint })) !== null,
  );

  // ── 5. project-safe composite foreign keys ──
  const otherProject = randomUUID();
  await pool.query("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
    otherProject,
    dev.id,
    `db-spatial-${otherProject.slice(0, 8)}`,
    "db:spatial-passes other project",
  ]);
  created.projectIds.push(otherProject);
  const otherAsset = await mkAsset(
    "db:spatial foreign asset",
    "data",
    "spatial_control",
    SPATIAL_MIME.depth,
    otherProject,
  );
  const otherLoc = randomUUID();
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
    [otherLoc, otherProject, "db:spatial-passes other location"],
  );
  check(
    "a bundle cannot point at another project's depth asset",
    (await tryInsert({ depth_asset_id: otherAsset })) !== null,
  );
  check(
    "a bundle cannot point at another project's object-id asset",
    (await tryInsert({ object_id_asset_id: otherAsset })) !== null,
  );
  check(
    "a bundle cannot reference a Shot of another project",
    (await tryInsert({ project_id: otherProject })) !== null,
  );
  check(
    "a bundle cannot reference a Location of another project",
    (await tryInsert({ location_id: otherLoc })) !== null,
  );
  check(
    "a bundle cannot reference a scene document that does not exist",
    (await tryInsert({ scene_document_id: randomUUID() })) !== null,
  );
  check(
    "a bundle cannot be moved between projects",
    (await sqlErr("update shot_spatial_pass_bundles set project_id = $2 where id = $1", [
      back.id,
      otherProject,
    ])) !== null,
  );

  // ── 6. asset pinning ──
  check(
    "an asset used by a bundle cannot be deleted (history is protected)",
    (await sqlErr("delete from assets where id = $1", [b1In.depth.assetId])) !== null,
  );
  const maskAsset = Object.values(b1In.characterMasks.masks)[0].assetId;
  check("spatialPassUsesAsset: depth", (await owner.spatialPassUsesAsset(b1In.depth.assetId)) === true);
  check(
    "spatialPassUsesAsset: object ids",
    (await owner.spatialPassUsesAsset(b1In.objectIds.assetId)) === true,
  );
  check(
    "spatialPassUsesAsset: a Character mask (stored in json)",
    (await owner.spatialPassUsesAsset(maskAsset)) === true,
  );
  check(
    "spatialPassUsesAsset: an unrelated asset",
    (await owner.spatialPassUsesAsset(await mkAsset("db:spatial unrelated"))) === false,
  );

  // ── 7. RLS: owner / stranger / anon ──
  check("stranger cannot read bundles", (await strangerRepo.listSpatialPassBundles(shotA.id)).length === 0);
  check("stranger cannot read a bundle by id", (await strangerRepo.getSpatialPassBundle(back.id)) === null);
  const strangerIn = base2({});
  check(
    "stranger insert is blocked by row-level security",
    (await asStranger(strangerIn.sql, strangerIn.params)).error !== null,
  );
  check(
    "stranger update touches no row",
    (
      await asStranger("update shot_spatial_pass_bundles set width = width where id = $1 returning id", [
        back.id,
      ])
    ).rows.length === 0,
  );
  check(
    "stranger delete touches no row",
    (await asStranger("delete from shot_spatial_pass_bundles where id = $1 returning id", [back.id])).rows
      .length === 0,
  );
  check(
    "anon has no access",
    (await err(() => anonRepo.listSpatialPassBundles(shotA.id))) !== null ||
      (await anonRepo.listSpatialPassBundles(shotA.id)).length === 0,
  );
  check(
    "stranger sees no spatial-pass asset pins",
    (await strangerRepo.spatialPassUsesAsset(b1In.depth.assetId)) === false,
  );

  // ── 8. GenerationPackage reference: current / stale / audio-independent ──
  const storedBefore = (await owner.listSpatialPassBundles(shotA.id)).length;
  const refs0 = (await owner.listSpatialReferences(projectId))[shotA.id];
  check(
    "the package reference carries the CURRENT bundle by value",
    !!refs0.controlPasses &&
      refs0.controlPasses.bundleId === bm.record.id && // the latest bundle that is exactly current
      refs0.controlPasses.depth.assetId === bmIn.depth.assetId &&
      refs0.controlPasses.objectIds.assetId === bmIn.objectIds.assetId &&
      refs0.controlPasses.characterMasks[0]?.characterId === yumeko.id,
  );
  const withAudio = (await owner.listSpatialReferences(projectId, () => "f".repeat(64)))[shotA.id];
  check(
    "an audio mix change does not stale the passes",
    withAudio.controlPasses?.bundleFingerprint === refs0.controlPasses!.bundleFingerprint,
  );

  // STALE BLOCKING: change the pose → the rendered blocking layer differs
  const cur = (await owner.listShotBlocking(shotA.id))[0];
  await owner.saveShotBlocking({
    id: randomUUID(),
    projectId,
    shotId: shotA.id,
    characterId: yumeko.id,
    locationId: tmpLocation,
    sceneDocumentId: sceneId,
    sceneRevision: scene1.revision,
    sceneFingerprint: scene1.sceneFingerprint,
    entry: newBlockingEntry(yumeko.id, { x: 2, y: 0, z: -3 }),
    expectedRevision: cur.revision,
    userId: dev.id,
    now: now(),
  });
  check(
    "after a blocking change no old bundle is referenced (STALE BLOCKING)",
    (await owner.listSpatialReferences(projectId))[shotA.id].controlPasses === undefined,
  );
  check(
    "…and historical bundles are retained",
    (await owner.listSpatialPassBundles(shotA.id)).length === storedBefore,
  );
  const b2 = await owner.recordSpatialPassBundle(await makeBundle(pathSource(2000), "after-blocking"));
  check(
    "capturing again stores a NEW bundle with a different fingerprint",
    !b2.existing && b2.record.bundleFingerprint !== b1In.bundleFingerprint,
  );
  check(
    "the new bundle is now the one in the package",
    (await owner.listSpatialReferences(projectId))[shotA.id].controlPasses?.bundleId === b2.record.id,
  );

  // STALE CAMERA: change the saved path
  const movedPath = buildHotelCanopyCameraPath();
  movedPath.keyframes[1] = { ...movedPath.keyframes[1], position: { x: 8, y: 2, z: 8 } };
  await owner.saveCameraPath({
    id: randomUUID(),
    ...base,
    path: movedPath,
    expectedRevision: path.revision,
  });
  check(
    "a camera-path capture is not referenced once the saved path changes (STALE CAMERA)",
    (await owner.listSpatialReferences(projectId))[shotA.id].controlPasses === undefined,
  );

  // STALE SCENE: change the Set
  const moved2 = buildHotelCanopyEngineScene();
  moved2.scene[3].position = { x: 1, y: 1.2, z: -5.75 };
  await owner.saveScene({
    id: randomUUID(),
    projectId,
    locationId: tmpLocation,
    document: buildPrevisDocument({ engineScene: moved2 }),
    expectedRevision: 1,
    engineVersion: "test",
    userId: dev.id,
    now: now(),
  });
  check(
    "after a Set change no bundle is referenced (STALE SCENE) and nothing was deleted",
    (await owner.listSpatialReferences(projectId))[shotA.id].controlPasses === undefined &&
      (await owner.listSpatialPassBundles(shotA.id)).length === storedBefore + 1,
  );

  // ── 9. a deleted camera path only nulls its id on the historical bundle ──
  await pool.query("delete from shot_camera_paths where shot_id = $1", [shotA.id]);
  const afterPathDelete = await pool.query(
    "select camera_path_id, camera_path_fingerprint, time_ms from shot_spatial_pass_bundles where id = $1",
    [back.id],
  );
  check(
    "deleting the live camera path keeps the bundle's own path provenance (id nulled by the FK action only)",
    afterPathDelete.rows[0].camera_path_id === null &&
      afterPathDelete.rows[0].camera_path_fingerprint === path.pathFingerprint &&
      afterPathDelete.rows[0].time_ms === 2000,
  );

  // ── 10. ATOMICITY on the real database: injected mid-capture failures leave nothing behind ──
  // (real Asset rows and the real bundle table; the object store is an in-memory fake so a failure can be injected)
  const countAtomic = async () => ({
    assets: Number(
      (await pool.query("select count(*)::int n from assets where name like 'db:spatial atomic%'")).rows[0].n,
    ),
    bundles: (await owner.listSpatialPassBundles(shotA.id)).length,
  });
  const atomicAssets = (tag: string, n: number) =>
    Array.from({ length: n }, (_, i) => {
      const id = randomUUID();
      const asset = assetSchema.parse({
        id,
        projectId,
        createdBy: null,
        type: "data",
        purpose: "spatial_control",
        source: "3d_render",
        name: `db:spatial atomic ${tag} ${i}`,
        originalFilename: `${tag}-${i}.bin`,
        storageProvider: "local",
        bucket: null,
        objectPath: `${projectId}/${id}/${tag}-${i}.bin`,
        mime: SPATIAL_MIME.depth,
        byteSize: 4,
        checksum: null,
        width: 1912,
        height: 800,
        durationMs: null,
        frameRate: null,
        sampleRate: null,
        channels: null,
        tags: ["spatial_pass"],
        notes: "",
        metadata: {},
        createdAt: now(),
        updatedAt: now(),
      });
      created.assetIds.push(id);
      return {
        asset,
        bytes: new Uint8Array([i]),
        objectPath: `${projectId}/${id}/${tag}-${i}.bin`,
        mime: SPATIAL_MIME.depth,
      };
    });
  const fakeStore = (failPutAt?: number) => {
    const objects = new Set<string>();
    let puts = 0;
    const deps: PassStoreDeps = {
      async putObject(path) {
        puts++;
        if (failPutAt === puts) throw new Error("injected: upload failed");
        objects.add(path);
      },
      upsertAsset: (asset) => admin.upsert(projectId, "assets", asset),
      removeAsset: (id) => admin.remove(projectId, "assets", id),
      async removeObject(asset) {
        if (!objects.delete(asset.objectPath ?? "")) throw new Error("no such object"); // already gone: tolerated
      },
    };
    return { objects, deps, puts: () => puts };
  };
  const pre = await countAtomic();
  const historicalAssets = (
    await pool.query("select count(*)::int n from assets where id = any($1::uuid[])", [
      [b1In.depth.assetId, b1In.objectIds.assetId],
    ])
  ).rows[0].n;

  // (a) the third upload (the first Character mask) fails after depth + object ids were stored
  const sa = fakeStore(3);
  const wa = atomicAssets("mid", 4);
  const failure = await err(() => persistPassBundle(sa.deps, wa, () => owner.recordSpatialPassBundle(bmIn)));
  const mid = await countAtomic();
  check(
    "injected mid-capture upload failure is surfaced to the caller",
    failure === "injected: upload failed",
    String(failure),
  );
  check("depth and object ids really were uploaded before the failure", sa.puts() === 3);
  check("no Asset row from the failed capture remains", mid.assets === pre.assets);
  check("no storage object from the failed capture remains", sa.objects.size === 0);
  check("no bundle row was written and history is unchanged", mid.bundles === pre.bundles);
  check(
    "historical bundles' assets are untouched",
    (
      await pool.query("select count(*)::int n from assets where id = any($1::uuid[])", [
        [b1In.depth.assetId, b1In.objectIds.assetId],
      ])
    ).rows[0].n === historicalAssets,
  );
  check(
    "the failed capture left no Character mask metadata",
    !(await owner.spatialPassUsesAsset(wa[2]!.asset.id)),
  );

  // (b) the database write FAILS after every upload and every Asset row succeeded (a real foreign-key violation)
  const sb = fakeStore();
  const wb = atomicAssets("dbfail", 4);
  const badBundle: NewSpatialPassBundle = {
    ...bmIn,
    id: randomUUID(),
    sceneDocumentId: randomUUID(), // no such scene document: the bundle insert fails inside Postgres
    bundleFingerprint: "e".repeat(64),
    depth: { ...bmIn.depth, assetId: wb[0]!.asset.id },
    objectIds: { ...bmIn.objectIds, assetId: wb[1]!.asset.id },
  };
  const dbFailure = await err(() =>
    persistPassBundle(sb.deps, wb, () => owner.recordSpatialPassBundle(badBundle)),
  );
  const after = await countAtomic();
  check(
    "a real database failure after all uploads is surfaced",
    dbFailure !== null && /foreign key|violates/i.test(dbFailure),
    String(dbFailure),
  );
  check("…and every uploaded object was removed", sb.puts() === 4 && sb.objects.size === 0);
  check("…and every temporary Asset row was removed", after.assets === pre.assets);
  check("…and no bundle row exists for it", after.bundles === pre.bundles);

  // (c) cleanup is idempotent and narrow: removing the same failed attempt again changes nothing else
  const { removePassAssets } = await import("../src/server/spatial-pass-store");
  await removePassAssets(
    sb.deps,
    wb.map((w) => w.asset),
  );
  await removePassAssets(
    sb.deps,
    wb.map((w) => w.asset),
  );
  const repeated = await countAtomic();
  check(
    "repeating cleanup of an already-cleaned capture damages nothing",
    repeated.assets === pre.assets && repeated.bundles === pre.bundles,
  );
} finally {
  // cleanup: bundles first (they pin assets), then assets, then the temporary location/projects (cascade)
  for (const id of created.locationIds)
    await pool.query("delete from locations where id = $1", [id]).catch(() => undefined);
  for (const id of created.projectIds)
    await pool.query("delete from projects where id = $1", [id]).catch(() => undefined);
  for (const id of created.assetIds)
    await pool.query("delete from assets where id = $1", [id]).catch(() => undefined);
}

const leftover = await pool.query(
  `select (select count(*)::int from shot_spatial_pass_bundles where location_id = any($1::uuid[])) as bundles,
          (select count(*)::int from assets where name like 'db:spatial%') as assets,
          (select count(*)::int from locations where name like 'db:spatial-passes%') as locations,
          (select count(*)::int from projects where title like 'db:spatial-passes%') as projects`,
  [created.locationIds],
);
const l = leftover.rows[0];
check(
  "cleanup left no test rows (cascade removed bundles, scenes, paths, bookmarks, blocking)",
  l.bundles === 0 && l.assets === 0 && l.locations === 0 && l.projects === 0,
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
