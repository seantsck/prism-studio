// Integration tests for Phase 2F M2D.1 Location spatial reconstructions against the REAL dedicated Prism Studio
// database (migration 0035: location_spatial_reconstructions + the 'spatial_reconstruction' asset purpose).
//   npm run db:reconstructions
//
// Exercises (with real rows, cleaned up afterwards): record/reload by value, content fingerprint, immutability,
// check constraints, project-safe composite foreign keys, result-asset pinning, owner-only RLS (owner / stranger /
// anon), that NEITHER worker role has any access, the truthful asset taxonomy, the private bucket's splat MIME
// types, the splat environment frozen into the Shot's spatial reference, all-or-nothing import persistence with a
// real database failure, and cascade cleanup.
// Requires `npm run db:seed` first (uses the demo project). No provider call. Splat BYTES are not stored here (the
// Storage upload path is covered by the Supabase e2e); this suite proves the relational contract.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { PostgresPrevisData } from "../src/data/previs-postgres";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { assetTokenFor, buildPrevisDocument } from "../src/domain/previs/document";
import { buildHotelCanopyEngineScene } from "../src/domain/previs/hotel-canopy";
import {
  manualCalibration,
  reconstructionFingerprintOf,
  SPLAT_MIMES,
  SPLAT_USER_DATA,
  UNKNOWN_CALIBRATION,
} from "../src/domain/previs/splat";
import { assetSchema } from "../src/domain/schemas";
import { persistPassBundle, removePassAssets, type PassStoreDeps } from "../src/server/spatial-pass-store";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "spatial reconstruction integration tests (rows created, then removed)",
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
const asStranger = (sql: string, p: unknown[] = []) => raw(rlsPreamble({ sub: stranger }), sql, p);
const asAnon = (sql: string, p: unknown[] = []) => raw(rlsPreamble(null, "anon"), sql, p);
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
  const shot = data.shots.find((s) => s.shotCode === "2A")!;

  // ── 1. structure, taxonomy and security ──
  const rls = await pool.query(
    "select relrowsecurity from pg_class where relname = 'location_spatial_reconstructions' and relkind = 'r'",
  );
  check(
    "location_spatial_reconstructions exists with row-level security enabled",
    rls.rows[0]?.relrowsecurity === true,
  );
  const pol = await pool.query(
    "select 1 from pg_policies where schemaname = 'public' and tablename = 'location_spatial_reconstructions' and 'authenticated' = any(roles)",
  );
  check("an owner policy exists for authenticated users", (pol.rowCount ?? 0) >= 1);
  for (const role of ["prism_generation_worker", "prism_continuity_worker"]) {
    const exists = await pool.query("select 1 from pg_roles where rolname = $1", [role]);
    if (exists.rowCount === 0) {
      check(`${role}: role not present (skipped)`, true);
      continue;
    }
    const p = await pool.query(
      `select has_table_privilege($1, 'public.location_spatial_reconstructions', 'select') as s,
              has_table_privilege($1, 'public.location_spatial_reconstructions', 'insert') as i,
              has_table_privilege($1, 'public.location_spatial_reconstructions', 'update') as u,
              has_table_privilege($1, 'public.location_spatial_reconstructions', 'delete') as d`,
      [role],
    );
    const r = p.rows[0];
    check(`${role} has NO privilege on location_spatial_reconstructions`, !r.s && !r.i && !r.u && !r.d);
  }
  const bucket = await pool.query(
    "select public, allowed_mime_types from storage.buckets where id = 'prism-assets'",
  );
  const mimes: string[] = bucket.rows[0]?.allowed_mime_types ?? [];
  check("the asset bucket is still private", bucket.rows[0]?.public === false);
  check(
    "the private bucket accepts the three Gaussian-splat MIME types",
    SPLAT_MIMES.every((m) => mimes.includes(m)),
  );
  check(
    "the bucket still accepts images and the M2C machine types",
    mimes.includes("image/png") && mimes.includes("application/x-prism-depth-f32"),
  );

  const mkAsset = async (
    name: string,
    opts: { type?: string; purpose?: string; mime?: string; project?: string; checksum?: string | null } = {},
  ) => {
    const id = randomUUID();
    await pool.query(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, mime, checksum, metadata)
       values ($1,$2,$3,$4,$5,'import','none',$6,$7,'{}'::jsonb)`,
      [
        id,
        opts.project ?? projectId,
        name,
        opts.type ?? "3d",
        opts.purpose ?? "spatial_reconstruction",
        opts.mime ?? "application/x-gaussian-splat",
        opts.checksum ?? `sum-${id.slice(0, 8)}`,
      ],
    );
    created.assetIds.push(id);
    return id;
  };
  const splatAsset = await mkAsset("db:recon splat");
  check("a splat is a '3d' Asset with purpose 'spatial_reconstruction' (not an image or data)", !!splatAsset);
  check(
    "an unknown asset purpose is still rejected",
    (await sqlErr(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, metadata)
       values (gen_random_uuid(), $1, 'db:recon bad purpose', '3d', 'whatever', 'upload', 'none', '{}'::jsonb)`,
      [projectId],
    )) !== null,
  );

  // a private location + a reference image + a stranger-owned project for this suite
  const tmpLocation = randomUUID();
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
    [tmpLocation, projectId, "db:recon-set location"],
  );
  created.locationIds.push(tmpLocation);
  const ref1 = await mkAsset("db:recon ref 1", {
    type: "image",
    purpose: "location_ref",
    mime: "image/png",
    checksum: "ref-sum-1",
  });
  const ref2 = await mkAsset("db:recon ref 2", {
    type: "image",
    purpose: "location_ref",
    mime: "image/png",
    checksum: "ref-sum-2",
  });

  const newRecon = (over: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    projectId,
    locationId: tmpLocation,
    method: "imported" as const,
    resultKind: "gaussian_splat" as const,
    resultAssetId: splatAsset,
    resultChecksum: "splat-sum",
    resultFormat: "splat" as const,
    gaussianCount: 576,
    sources: [
      { assetId: ref2, checksum: "ref-sum-2" },
      { assetId: ref1, checksum: "ref-sum-1" },
    ],
    calibration: { ...UNKNOWN_CALIBRATION },
    userId: dev.id,
    now: now(),
    ...over,
  });

  // ── 2. record, reload by value, fingerprint ──
  const inA = newRecon();
  const a = await owner.recordReconstruction(inA);
  check(
    "a reconstruction is recorded as an imported Gaussian splat",
    a.method === "imported" && a.resultKind === "gaussian_splat",
  );
  const back = (await owner.getReconstruction(a.id))!;
  check(
    "reload returns the sources (canonical order) and calibration exactly",
    isDeepStrictEqual(
      back.sources.map((s) => s.assetId),
      [ref1, ref2].sort(),
    ) && isDeepStrictEqual(back.calibration, UNKNOWN_CALIBRATION),
  );
  check(
    "the stored fingerprint equals the domain fingerprint of its identity",
    back.fingerprint ===
      reconstructionFingerprintOf({
        locationId: tmpLocation,
        method: "imported",
        resultKind: "gaussian_splat",
        resultAssetId: splatAsset,
        resultChecksum: "splat-sum",
        sources: back.sources,
        calibration: back.calibration,
      }),
  );
  check(
    "the splat's Gaussian count and format are stored",
    back.gaussianCount === 576 && back.resultFormat === "splat",
  );
  check(
    "the list returns it for its location only",
    (await owner.listReconstructions(tmpLocation)).map((r) => r.id).includes(a.id) &&
      (await owner.listReconstructions(randomUUID())).length === 0,
  );
  check("the record contains no URLs", !/https?:|blob:|token=|signature/i.test(JSON.stringify(back)));
  const dup = await err(() => owner.recordReconstruction(newRecon({ id: randomUUID() })));
  check(
    "the identical reconstruction cannot be recorded twice for a location",
    dup !== null && /already recorded/i.test(dup),
    String(dup),
  );
  const noSources = await owner.recordReconstruction(
    newRecon({ sources: [], resultAssetId: await mkAsset("db:recon splat 2") }),
  );
  check("an externally imported splat needs no source images", noSources.sources.length === 0);
  const manual = await owner.recordReconstruction(
    newRecon({
      sources: [],
      resultAssetId: await mkAsset("db:recon splat 3"),
      calibration: manualCalibration(0.5),
    }),
  );
  check(
    "a record can carry the manual scale the source claimed, with its method",
    manual.calibration.scaleMethod === "manual" && manual.calibration.metresPerSourceUnit === 0.5,
  );
  check(
    "calibration is part of the fingerprint",
    manual.fingerprint !==
      reconstructionFingerprintOf({
        ...manual,
        resultAssetId: manual.resultAssetId,
        calibration: { ...UNKNOWN_CALIBRATION },
        sources: [],
      }),
  );

  // ── 3. pinning ──
  check("the result Asset is pinned by its reconstruction", await owner.reconstructionUsesAsset(splatAsset));
  check("a source image is pinned by its reconstruction", await owner.reconstructionUsesAsset(ref1));
  check("an unrelated Asset is not pinned", !(await owner.reconstructionUsesAsset(randomUUID())));
  check(
    "deleting the result Asset is refused by the foreign key",
    (await sqlErr("delete from assets where id = $1", [splatAsset])) !== null,
  );

  // ── 4. immutability ──
  for (const [label, sql] of [
    [
      "calibration",
      "update location_spatial_reconstructions set calibration_json = '{}'::jsonb where id = $1",
    ],
    [
      "the result asset",
      `update location_spatial_reconstructions set result_asset_id = '${randomUUID()}' where id = $1`,
    ],
    [
      "the fingerprint",
      `update location_spatial_reconstructions set reconstruction_fingerprint = '${"0".repeat(64)}' where id = $1`,
    ],
    [
      "the source list",
      "update location_spatial_reconstructions set source_assets_json = '[]'::jsonb where id = $1",
    ],
  ] as const) {
    const e = await sqlErr(sql, [a.id]);
    check(
      `an update of ${label} is refused (immutable provenance)`,
      e !== null && /immutable/i.test(e),
      String(e),
    );
  }

  // ── 5. check constraints ──
  const base = [randomUUID(), projectId, tmpLocation, splatAsset];
  const ins = (cols: string, vals: string) =>
    sqlErr(
      `insert into location_spatial_reconstructions
         (id, project_id, location_id, schema_version, method, result_kind, result_asset_id, result_format,
          source_assets_json, calibration_json, reconstruction_fingerprint ${cols})
       values ($1,$2,$3,'prism.spatial-reconstruction.v1','imported','gaussian_splat',$4,'splat',
          '[]'::jsonb,'{}'::jsonb,'${"a".repeat(64)}' ${vals})`,
      base,
    );
  const insBad = (field: string, value: string) =>
    sqlErr(
      `insert into location_spatial_reconstructions
         (id, project_id, location_id, schema_version, method, result_kind, result_asset_id, result_format,
          source_assets_json, calibration_json, reconstruction_fingerprint)
       values ($1,$2,$3,${field === "schema" ? `'${value}'` : "'prism.spatial-reconstruction.v1'"},
          ${field === "method" ? `'${value}'` : "'imported'"}, ${field === "kind" ? `'${value}'` : "'gaussian_splat'"}, $4,
          ${field === "format" ? `'${value}'` : "'splat'"},
          ${field === "sources" ? `'${value}'::jsonb` : "'[]'::jsonb"}, '{}'::jsonb,
          ${field === "fp" ? `'${value}'` : `'${"b".repeat(64)}'`})`,
      base,
    );
  void ins;
  check("an unknown schema version is rejected", (await insBad("schema", "prism.other.v9")) !== null);
  check("an unknown method is rejected", (await insBad("method", "magic")) !== null);
  check("an unknown result kind is rejected", (await insBad("kind", "mesh")) !== null);
  check("an unknown result format is rejected", (await insBad("format", "ksplat")) !== null);
  check("sources must be a JSON array", (await insBad("sources", "{}")) !== null);
  check("a fingerprint must be 64 characters", (await insBad("fp", "short")) !== null);

  // ── 6. project-safe composite foreign keys ──
  const otherProject = randomUUID();
  await pool.query("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
    otherProject,
    dev.id,
    `db-recon-${otherProject.slice(0, 8)}`,
    "db:recon other project",
  ]);
  created.projectIds.push(otherProject);
  const foreignAsset = await mkAsset("db:recon foreign splat", { project: otherProject });
  const crossAsset = await err(() => owner.recordReconstruction(newRecon({ resultAssetId: foreignAsset })));
  check(
    "a result Asset of ANOTHER project is rejected",
    crossAsset !== null && /foreign key|violates/i.test(crossAsset),
    String(crossAsset),
  );
  const crossLocation = await err(() => owner.recordReconstruction(newRecon({ projectId: otherProject })));
  check("a Location of another project is rejected", crossLocation !== null, String(crossLocation));

  // ── 7. RLS: owner / stranger / anon ──
  check(
    "stranger cannot list reconstructions",
    (await strangerRepo.listReconstructions(tmpLocation)).length === 0,
  );
  check("stranger cannot read a reconstruction by id", (await strangerRepo.getReconstruction(a.id)) === null);
  check(
    "stranger sees no reconstruction pins",
    (await strangerRepo.reconstructionUsesAsset(splatAsset)) === false,
  );
  const strangerIns = await asStranger(
    `insert into location_spatial_reconstructions
       (id, project_id, location_id, schema_version, method, result_kind, result_asset_id, result_format,
        source_assets_json, calibration_json, reconstruction_fingerprint)
     values (gen_random_uuid(), $1, $2, 'prism.spatial-reconstruction.v1', 'imported', 'gaussian_splat', $3, 'splat',
        '[]'::jsonb, '{}'::jsonb, $4)`,
    [projectId, tmpLocation, splatAsset, "c".repeat(64)],
  );
  check("stranger insert is blocked by row-level security", strangerIns.error !== null);
  check(
    "stranger delete touches no row",
    (await asStranger("delete from location_spatial_reconstructions where id = $1", [a.id])).rowCount === 0,
  );
  check(
    "anonymous cannot read reconstructions",
    (await asAnon("select 1 from location_spatial_reconstructions")).rowCount === 0 ||
      (await asAnon("select 1 from location_spatial_reconstructions")).error !== null,
  );
  check(
    "anonymous cannot read the splat Asset row",
    (await asAnon("select 1 from assets where id = $1", [splatAsset])).rowCount === 0,
  );
  check(
    "stranger cannot read the splat Asset row",
    (await asStranger("select 1 from assets where id = $1", [splatAsset])).rowCount === 0,
  );
  check("the owner still reads it", (await owner.getReconstruction(a.id)) !== null);

  // ── 8. the splat environment frozen into a Shot's spatial reference ──
  const doc = (position: number, ids: { recon: string; asset: string }) => {
    const s = buildHotelCanopyEngineScene();
    s.scene.push({
      ...JSON.parse(JSON.stringify(s.scene[1])),
      object_uuid: randomUUID(),
      object_name: "db:recon environment",
      media_file_token: assetTokenFor(ids.asset),
      position: { x: position, y: 0, z: 0 },
      user_data: {
        [SPLAT_USER_DATA.reconstructionId]: ids.recon,
        [SPLAT_USER_DATA.calibration]: { ...UNKNOWN_CALIBRATION },
      },
    });
    return buildPrevisDocument({ engineScene: s, assetChecksums: { [ids.asset]: "splat-sum" } });
  };
  const sceneId = randomUUID();
  const scene1 = await owner.saveScene({
    id: sceneId,
    projectId,
    locationId: tmpLocation,
    document: doc(0, { recon: a.id, asset: splatAsset }),
    expectedRevision: null,
    engineVersion: "test",
    userId: dev.id,
    now: now(),
  });
  await owner.setBookmark({
    id: randomUUID(),
    projectId,
    shotId: shot.id,
    locationId: tmpLocation,
    sceneDocumentId: sceneId,
    userId: dev.id,
    now: now(),
  });
  const refs1 = await owner.listSpatialReferences(projectId);
  const env1 = refs1[shot.id]?.spatialEnvironment;
  check(
    "the Shot's spatial reference freezes the splat environment (reconstruction, asset, checksum, transform)",
    !!env1 &&
      env1.reconstructionId === a.id &&
      env1.reconstructionFingerprint === a.fingerprint &&
      env1.assetId === splatAsset &&
      env1.assetChecksum === "splat-sum" &&
      env1.transform.position.x === 0,
  );
  check(
    "…with the reference images as provenance by value, and no URL anywhere",
    !!env1 &&
      isDeepStrictEqual(env1.sourceReferenceAssetIds, [ref1, ref2].sort()) &&
      !/https?:|blob:|token=|signature/i.test(JSON.stringify(env1)),
  );
  const scene2 = await owner.saveScene({
    id: sceneId,
    projectId,
    locationId: tmpLocation,
    document: doc(3, { recon: a.id, asset: splatAsset }),
    expectedRevision: scene1.revision,
    engineVersion: "test",
    userId: dev.id,
    now: now(),
  });
  const env2 = (await owner.listSpatialReferences(projectId))[shot.id]?.spatialEnvironment;
  check(
    "moving the splat changes the placement and the Set fingerprint but NOT the reconstruction",
    !!env2 &&
      env2.transform.position.x === 3 &&
      scene2.sceneFingerprint !== scene1.sceneFingerprint &&
      env2.reconstructionFingerprint === env1!.reconstructionFingerprint,
  );

  // ── 9. all-or-nothing import persistence with a REAL database failure ──
  const countImport = async () =>
    (
      await pool.query(
        `select (select count(*)::int from assets where name like 'db:recon import%') as assets,
                (select count(*)::int from location_spatial_reconstructions where location_id = $1) as recons`,
        [tmpLocation],
      )
    ).rows[0] as { assets: number; recons: number };
  const importAsset = (tag: string) => {
    const id = randomUUID();
    const asset = assetSchema.parse({
      id,
      projectId,
      createdBy: null,
      type: "3d",
      purpose: "spatial_reconstruction",
      source: "import",
      name: `db:recon import ${tag}`,
      originalFilename: `${tag}.splat`,
      storageProvider: "local",
      bucket: null,
      objectPath: `${projectId}/${id}/${tag}.splat`,
      mime: "application/x-gaussian-splat",
      byteSize: 32,
      checksum: `imp-${tag}`,
      width: null,
      height: null,
      durationMs: null,
      frameRate: null,
      sampleRate: null,
      channels: null,
      tags: ["gaussian_splat"],
      notes: "",
      metadata: {},
      createdAt: now(),
      updatedAt: now(),
    });
    return { asset, bytes: new Uint8Array(32), objectPath: asset.objectPath!, mime: asset.mime! };
  };
  const objects = new Set<string>();
  const deps: PassStoreDeps = {
    async putObject(path) {
      objects.add(path);
    },
    upsertAsset: (asset) => admin.upsert(projectId, "assets", asset),
    removeAsset: (id) => admin.remove(projectId, "assets", id),
    async removeObject(asset) {
      if (!objects.delete(asset.objectPath ?? "")) throw new Error("no such object");
    },
  };
  const pre = await countImport();
  const w = importAsset("fail");
  const importFailure = await err(() =>
    persistPassBundle(deps, [w], async () => {
      // the Asset row exists now; the reconstruction insert then fails inside Postgres (no such location)
      await owner.recordReconstruction(
        newRecon({ id: randomUUID(), locationId: randomUUID(), resultAssetId: w.asset.id }),
      );
      return { existing: false };
    }),
  );
  const post = await countImport();
  check(
    "a database failure after the upload is surfaced",
    importFailure !== null && /foreign key|violates|not in/i.test(importFailure),
    String(importFailure),
  );
  check("…and the stored object was removed", objects.size === 0);
  check("…and the Asset row was removed", post.assets === pre.assets);
  check("…and no reconstruction row was written", post.recons === pre.recons);
  await removePassAssets(deps, [w.asset]);
  await removePassAssets(deps, [w.asset]);
  const again = await countImport();
  check("repeating the cleanup damages nothing", again.assets === pre.assets && again.recons === pre.recons);

  // ── 10. cascade ──
  await pool.query("delete from locations where id = $1", [tmpLocation]);
  created.locationIds.splice(created.locationIds.indexOf(tmpLocation), 1);
  check(
    "deleting the location removes its reconstructions (the result Asset is then deletable)",
    (
      await pool.query(
        "select count(*)::int n from location_spatial_reconstructions where location_id = $1",
        [tmpLocation],
      )
    ).rows[0].n === 0 && (await sqlErr("delete from assets where id = $1", [splatAsset])) === null,
  );
} finally {
  for (const id of created.locationIds)
    await pool.query("delete from locations where id = $1", [id]).catch(() => undefined);
  for (const id of created.projectIds)
    await pool.query("delete from projects where id = $1", [id]).catch(() => undefined);
  for (const id of created.assetIds)
    await pool.query("delete from assets where id = $1", [id]).catch(() => undefined);
}

const leftover = await pool.query(
  `select (select count(*)::int from location_spatial_reconstructions where location_id = any($1::uuid[])) as recons,
          (select count(*)::int from assets where name like 'db:recon%') as assets,
          (select count(*)::int from locations where name like 'db:recon%') as locations,
          (select count(*)::int from projects where title like 'db:recon%') as projects`,
  [created.locationIds],
);
const l = leftover.rows[0];
check(
  "cleanup left no test rows",
  l.recons === 0 && l.assets === 0 && l.locations === 0 && l.projects === 0,
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
