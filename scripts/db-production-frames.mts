// Integration tests for Phase 2G.1 Production Frames against the REAL dedicated Prism Studio database
// (migration 0039: shot_production_frames, shot_production_frame_selections, the 'production_frame' asset purpose).
//   npm run db:production-frames
//
// Exercises (with real rows, cleaned up afterwards): the immutable per-Shot history and its monotonic versions under
// real concurrency, duplicate promotion, the one-per-Shot selection pointer and its compare-and-set, the composite
// keys that keep a selection (and a frame's Asset) inside its own Shot and Project, the immutability trigger, the
// Asset-facts trigger, owner-only RLS (owner / stranger / anon) including "no update, no delete for anyone", that NEITHER
// worker role has any privilege, cascade cleanup, and that the loaded state resolves into a GenerationPackage v3 with
// no 3D data at all.
// Requires `npm run db:seed` first (uses the demo project). No provider call, no 3D set, no GPU. Image BYTES are not
// stored here (the Storage upload path is covered by the Supabase e2e); this suite proves the relational contract.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresProductionFrameData } from "../src/data/production-frame-postgres";
import { ProductionFrameError } from "../src/data/production-frame-repository";
import { AdminRepository, UserRepository, rlsPreamble } from "../src/data/postgres-repository";
import { buildShotContext } from "../src/domain/context";
import { assembleGenerationPackage, PACKAGE_SCHEMA_VERSION } from "../src/domain/generation-package";
import { draftProductionFrame, selectedProductionFrameFreshness } from "../src/domain/production-frame";
import { assetSchema, type Asset, type ProjectData } from "../src/domain/schemas";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({ mode: "production frame integration tests (rows created, then removed)", devOwner: dev.id });
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 12 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const stranger = randomUUID();
const now = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const admin = new AdminRepository(pool, dev.id);
const owner = new PostgresProductionFrameData(pool, rlsPreamble({ sub: dev.id }));
const strangerSvc = new PostgresProductionFrameData(pool, rlsPreamble({ sub: stranger }));

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
const asOwner = (sql: string, p: unknown[] = []) => raw(rlsPreamble({ sub: dev.id }), sql, p);
const asStranger = (sql: string, p: unknown[] = []) => raw(rlsPreamble({ sub: stranger }), sql, p);
const asAnon = (sql: string, p: unknown[] = []) => raw(rlsPreamble(null, "anon"), sql, p);
const sqlErr = (sql: string, params: unknown[] = []) =>
  pool.query(sql, params).then(
    () => null as string | null,
    (e: Error) => e.message,
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => "no error",
    (e: unknown) => (e instanceof ProductionFrameError ? e.code : `other: ${(e as Error).message}`),
  );

const created = {
  assetIds: [] as string[],
  shotIds: [] as string[],
  projectIds: [] as string[],
  frameShots: [] as string[],
};

try {
  const data: ProjectData = (await admin.loadProject("ojousama"))!;
  const projectId = data.project.id;
  const shotA = data.shots.find((s) => s.shotCode === "2A")!;
  const shotB = data.shots.find((s) => s.shotCode === "3A")!;
  created.frameShots.push(shotA.id, shotB.id);
  check(
    "the demo project has no 3D data in this test (no spatial references loaded)",
    !data.spatialReferences,
  );

  // ── 1. structure, security, taxonomy ──
  for (const t of ["shot_production_frames", "shot_production_frame_selections"]) {
    const rls = await pool.query("select relrowsecurity from pg_class where relname = $1 and relkind = 'r'", [
      t,
    ]);
    check(`${t} exists with row-level security enabled`, rls.rows[0]?.relrowsecurity === true);
  }
  const pols = await pool.query(
    "select tablename, cmd from pg_policies where schemaname = 'public' and tablename in ('shot_production_frames','shot_production_frame_selections')",
  );
  const cmds = (t: string) =>
    pols.rows
      .filter((p) => p.tablename === t)
      .map((p) => p.cmd)
      .sort();
  check(
    "frames: SELECT and INSERT policies only (no UPDATE or DELETE policy: history is append-only for users)",
    JSON.stringify(cmds("shot_production_frames")) === JSON.stringify(["INSERT", "SELECT"]),
    JSON.stringify(cmds("shot_production_frames")),
  );
  check("selections: one owner policy", cmds("shot_production_frame_selections").length === 1);
  for (const role of ["prism_generation_worker", "prism_continuity_worker"]) {
    const exists = await pool.query("select 1 from pg_roles where rolname = $1", [role]);
    if (exists.rowCount === 0) {
      check(`${role}: role not present (skipped)`, true);
      continue;
    }
    for (const t of ["shot_production_frames", "shot_production_frame_selections"]) {
      const p = await pool.query(
        `select has_table_privilege($1, $2, 'select') as s, has_table_privilege($1, $2, 'insert') as i,
                has_table_privilege($1, $2, 'update') as u, has_table_privilege($1, $2, 'delete') as d`,
        [role, `public.${t}`],
      );
      const r = p.rows[0];
      check(`${role} has NO privilege on ${t}`, !r.s && !r.i && !r.u && !r.d);
    }
  }

  const mkAsset = async (
    name: string,
    o: {
      project?: string;
      type?: string;
      purpose?: string;
      path?: string | null;
      checksum?: string;
      w?: number;
      h?: number;
    } = {},
  ) => {
    const id = randomUUID();
    const project = o.project ?? projectId;
    await pool.query(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, object_path, mime, checksum, width, height, metadata)
       values ($1,$2,$3,$4,$5,'upload','local',$6,'image/png',$7,$8,$9,'{}'::jsonb)`,
      [
        id,
        project,
        name,
        o.type ?? "image",
        o.purpose ?? "production_frame",
        o.path === undefined ? `${project}/${id}/db-pf.png` : o.path,
        o.checksum ?? sha(name),
        o.w ?? 1912,
        o.h ?? 800,
      ],
    );
    created.assetIds.push(id);
    return id;
  };
  const domainAsset = async (id: string): Promise<Asset> => (await admin.findAsset(id))!;
  const withAssets = (d: ProjectData, ...assets: Asset[]) => {
    for (const a of assets) if (!d.assets.some((x) => x.id === a.id)) d.assets.push(a);
    return d;
  };
  /** an Asset exactly as an upload would create it (not yet in the database): the frame's own `newAsset` */
  const uploadAsset = (name: string): Asset => {
    const id = randomUUID();
    return assetSchema.parse({
      id,
      projectId,
      createdBy: dev.id,
      type: "image",
      purpose: "production_frame",
      source: "upload",
      name,
      originalFilename: `${name}.png`,
      storageProvider: "local",
      bucket: null,
      objectPath: `${projectId}/${id}/${name}.png`,
      mime: "image/png",
      byteSize: 1234,
      checksum: sha(name),
      width: 1912,
      height: 800,
      durationMs: null,
      frameRate: null,
      sampleRate: null,
      channels: null,
      tags: [],
      notes: "",
      metadata: {},
      createdAt: now(),
      updatedAt: now(),
    });
  };
  const draftOf = (
    d: ProjectData,
    shotId: string,
    asset: Asset,
    source: "upload" | "storyboard" | "previs_master" | "generation_output" = "upload",
  ) => {
    const r = draftProductionFrame(buildShotContext(d, shotId), {
      id: randomUUID(),
      now: now(),
      userId: dev.id,
      source,
      sourceStoryboardFrameId: source === "storyboard" ? randomUUID() : null,
      sourceMasterFrameId: source === "previs_master" ? randomUUID() : null,
      sourceGenerationAttemptId: source === "generation_output" ? randomUUID() : null,
      asset,
    });
    if (!r.ok) throw new Error(`draft refused: ${r.problem.message}`);
    return r.draft;
  };
  const assetCount = async () =>
    (await pool.query("select count(*)::int n from assets where project_id = $1", [projectId])).rows[0]
      .n as number;

  check(
    "the 'production_frame' asset purpose is accepted",
    (await sqlErr(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, metadata)
       values ($1, $2, 'db:pf purpose probe', 'image', 'production_frame', 'upload', 'none', '{}'::jsonb)`,
      [randomUUID(), projectId],
    )) === null,
  );
  await pool.query("delete from assets where name = 'db:pf purpose probe'");
  check(
    "an unknown asset purpose is still rejected",
    (await sqlErr(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, metadata)
       values (gen_random_uuid(), $1, 'db:pf bad purpose', 'image', 'whatever', 'upload', 'none', '{}'::jsonb)`,
      [projectId],
    )) !== null,
  );

  // ── 2. create: an upload stores its Asset and frame together; version 1; selected ──
  const up1 = uploadAsset("db:pf upload 1");
  created.assetIds.push(up1.id);
  const a0 = await assetCount();
  const r1 = await owner.create({
    draft: draftOf(data, shotA.id, up1),
    newAsset: up1,
    select: true,
    userId: dev.id,
    now: now(),
  });
  check(
    "an upload creates Production Frame v1",
    r1.created && r1.frame.version === 1 && r1.frame.source === "upload",
  );
  check(
    "…the NEW private Asset was stored with the frame (purpose production_frame)",
    (await assetCount()) === a0 + 1 && (await domainAsset(up1.id)).purpose === "production_frame",
  );
  check(
    "…and it is the canonical frame of its Shot",
    r1.selection?.productionFrameId === r1.frame.id && r1.selection?.selectedBy === dev.id,
  );
  check(
    "…the frozen facts equal the Asset's (checksum, size, aspect)",
    r1.frame.assetChecksum === up1.checksum &&
      r1.frame.width === 1912 &&
      r1.frame.height === 800 &&
      r1.frame.productionAspectRatio === "2.39:1",
  );
  check(
    "…the intent snapshot, fingerprint and parts were stored by value",
    r1.frame.intentSnapshot.schema === "prism.production-frame-intent.v1" &&
      /^[0-9a-f]{64}$/.test(r1.frame.intentFingerprint) &&
      "looks" in r1.frame.parts,
  );

  // ── 3. promotion reuses the existing Asset (no copy); 3D / storyboard sources need no 3D data ──
  const sbAssetId = await mkAsset("db:pf storyboard image", { purpose: "storyboard" });
  const sbAsset = await domainAsset(sbAssetId);
  const a1 = await assetCount();
  const promo = await owner.create({
    draft: draftOf(withAssets(data, sbAsset), shotA.id, sbAsset, "storyboard"),
    newAsset: null,
    select: true,
    userId: dev.id,
    now: now(),
  });
  check(
    "a promotion creates v2 referencing the EXISTING Asset",
    promo.created && promo.frame.version === 2 && promo.frame.assetId === sbAssetId,
  );
  check("…and duplicates NO Asset", (await assetCount()) === a1);
  const mfAssetId = await mkAsset("db:pf master image", { purpose: "other" });
  const mfAsset = await domainAsset(mfAssetId);
  const a2 = await assetCount();
  const master = await owner.create({
    draft: draftOf(withAssets(data, mfAsset), shotA.id, mfAsset, "previs_master"),
    newAsset: null,
    select: false,
    userId: dev.id,
    now: now(),
  });
  check(
    "a 3D Master Frame promotion is source previs_master, reuses its Asset, and (select:false) leaves the selection alone",
    master.created &&
      master.frame.source === "previs_master" &&
      (await assetCount()) === a2 &&
      master.selection?.productionFrameId === promo.frame.id,
  );
  // 'generation_output' is accepted now so Phase 2G.2 needs no redesign (2G.1 has no action that creates one)
  const genAssetId = await mkAsset("db:pf generated image", { purpose: "generation_output" });
  const genAsset = await domainAsset(genAssetId);
  const gen = await owner.create({
    draft: draftOf(withAssets(data, genAsset), shotB.id, genAsset, "generation_output"),
    newAsset: null,
    select: false,
    userId: dev.id,
    now: now(),
  });
  check(
    "a generation_output frame is accepted by the schema (Phase 2G.2) with its own source id",
    gen.created && gen.frame.source === "generation_output" && gen.frame.sourceGenerationAttemptId !== null,
  );

  // ── 4. duplicates, versions and real concurrency ──
  const dupAsset = uploadAsset("db:pf upload 1"); // same bytes (same checksum) as v1, a different Asset row
  created.assetIds.push(dupAsset.id);
  const a3 = await assetCount();
  const dup = await owner.create({
    draft: draftOf(data, shotA.id, dupAsset),
    newAsset: dupAsset,
    select: true,
    userId: dev.id,
    now: now(),
  });
  check(
    "an identical frame (same Shot, source, checksum, intent) returns the EXISTING one, re-selected",
    !dup.created && dup.frame.id === r1.frame.id && dup.selection?.productionFrameId === r1.frame.id,
  );
  check("…and the new Asset was NOT stored", (await assetCount()) === a3);
  const batch = Array.from({ length: 6 }, (_, i) => {
    const a = uploadAsset(`db:pf concurrent ${i}`);
    created.assetIds.push(a.id);
    return { a, draft: draftOf(data, shotA.id, a) };
  });
  const concurrent = await Promise.all(
    batch.map(({ a, draft }) =>
      owner.create({ draft, newAsset: a, select: false, userId: dev.id, now: now() }),
    ),
  );
  const versions = concurrent.map((r) => r.frame.version).sort((x, y) => x - y);
  check(
    "6 truly concurrent creates get 6 DISTINCT consecutive versions",
    new Set(versions).size === 6 && versions[5]! - versions[0]! === 5,
    versions.join(","),
  );
  const twin = uploadAsset("db:pf twin");
  created.assetIds.push(twin.id);
  const twinDraft = draftOf(data, shotB.id, twin);
  const twins = await Promise.all(
    Array.from({ length: 5 }, () =>
      owner.create({
        draft: { ...twinDraft, id: randomUUID() },
        newAsset: twin,
        select: true,
        userId: dev.id,
        now: now(),
      }),
    ),
  );
  check(
    "5 concurrent IDENTICAL creates make exactly one frame",
    twins.filter((t) => t.created).length === 1 && new Set(twins.map((t) => t.frame.id)).size === 1,
  );
  const vs = (
    await pool.query("select version from shot_production_frames where shot_id = $1 order by version", [
      shotA.id,
    ])
  ).rows.map((r) => Number(r.version));
  check(
    "versions of a Shot are exactly 1..N with no gap or duplicate",
    vs.every((v, i) => v === i + 1),
    vs.join(","),
  );
  const intentChanged = JSON.parse(JSON.stringify(data)) as ProjectData;
  intentChanged.shots.find((s) => s.id === shotA.id)!.lighting.mood = "db:pf a different mood";
  const sameImageNewIntent = await owner.create({
    draft: draftOf(withAssets(intentChanged, sbAsset), shotA.id, sbAsset, "storyboard"),
    newAsset: null,
    select: false,
    userId: dev.id,
    now: now(),
  });
  check(
    "the same image with a CHANGED intent is a legitimately new frame (its meaning differs)",
    sameImageNewIntent.created && sameImageNewIntent.frame.assetId === sbAssetId,
  );

  // ── 5. selection: pointer only; one row per Shot; compare-and-set ──
  const before = (await owner.listForProject(projectId)).frames;
  const sel = (id: string, expected?: string | null) =>
    owner.select({
      projectId,
      shotId: shotA.id,
      productionFrameId: id,
      userId: dev.id,
      now: now(),
      expectedSelectedFrameId: expected,
    });
  await sel(r1.frame.id);
  await sel(promo.frame.id);
  await sel(r1.frame.id);
  const afterList = await owner.listForProject(projectId);
  check(
    "select v1 → v2 → v1 leaves every historical frame row byte-for-byte unchanged",
    JSON.stringify(afterList.frames) === JSON.stringify(before),
  );
  check(
    "…with ONE selection row per Shot",
    afterList.selections.filter((s) => s.shotId === shotA.id).length === 1 &&
      afterList.selections.find((s) => s.shotId === shotA.id)!.productionFrameId === r1.frame.id,
  );
  check(
    "compare-and-set: a stale view conflicts",
    (await code(sel(promo.frame.id, promo.frame.id))) === "conflict" &&
      (await code(sel(promo.frame.id, null))) === "conflict",
  );
  check(
    "compare-and-set: the right expectation succeeds",
    (await code(sel(promo.frame.id, r1.frame.id))) === "no error",
  );
  const race = await Promise.allSettled(
    [master.frame, concurrent[0]!.frame].map((f) => sel(f.id, promo.frame.id)),
  );
  check(
    "two tabs choosing from the same view: exactly one wins",
    race.filter((r) => r.status === "fulfilled").length === 1 &&
      race.filter((r) => r.status === "rejected").length === 1,
  );
  check(
    "re-selecting the canonical frame is a harmless no-op",
    (await code(
      sel(
        (await owner.listForProject(projectId)).selections.find((s) => s.shotId === shotA.id)!
          .productionFrameId,
      ),
    )) === "no error",
  );

  // ── 6. same-Shot / same-Project constraints, in the service AND in the database ──
  const otherShotFrame = twins[0]!.frame; // a frame of shot B
  check("the service refuses a frame of ANOTHER Shot", (await code(sel(otherShotFrame.id))) === "wrong_shot");
  const otherProject = randomUUID();
  await pool.query("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
    otherProject,
    dev.id,
    `db-pf-${otherProject.slice(0, 8)}`,
    "db:pf other project",
  ]);
  created.projectIds.push(otherProject);
  const foreignAsset = await mkAsset("db:pf foreign image", { project: otherProject });
  const rawFrame = (
    shot: string,
    project: string,
    asset: string,
    extra: string[] = ["upload", "null"],
    v = 99,
    fp = sha(`raw-${Math.random()}`),
  ) =>
    sqlErr(
      `insert into shot_production_frames (project_id, shot_id, version, schema_version, asset_id, asset_checksum, width, height,
         production_aspect_ratio, source, source_master_frame_id, intent_snapshot, intent_fingerprint, parts, frame_fingerprint)
       values ($1,$2,$3,'prism.production-frame.v1',$4,$5,1912,800,'2.39:1',$6,${extra[1] === "null" ? "null" : "gen_random_uuid()"},'{}'::jsonb,$7,'{}'::jsonb,$8)`,
      [project, shot, v, asset, sha("db:pf foreign image"), extra[0], sha("i"), fp],
    );
  check(
    "the database refuses a frame whose Asset belongs to another project",
    (await rawFrame(shotA.id, projectId, foreignAsset)) !== null,
  );
  check(
    "the database refuses a frame naming another project's id for this Shot",
    (await rawFrame(shotA.id, otherProject, foreignAsset)) !== null,
  );
  check(
    "the database refuses a selection pointing at another Shot's frame",
    (await sqlErr("update shot_production_frame_selections set production_frame_id = $2 where shot_id = $1", [
      shotA.id,
      otherShotFrame.id,
    ])) !== null,
  );
  check(
    "the database refuses a selection row with another project's id",
    (await sqlErr("update shot_production_frame_selections set project_id = $2 where shot_id = $1", [
      shotA.id,
      otherProject,
    ])) !== null,
  );
  check(
    "the database allows exactly one selection row per Shot (primary key)",
    (await sqlErr(
      "insert into shot_production_frame_selections (shot_id, project_id, production_frame_id) values ($1,$2,$3)",
      [shotA.id, projectId, r1.frame.id],
    )) !== null,
  );
  check(
    "an origin must carry exactly its own source id (an upload with a master id is refused)",
    (await rawFrame(shotA.id, projectId, up1.id, ["upload", "gen"])) !== null,
  );
  check(
    "the Asset facts trigger refuses a frame whose checksum differs from its image",
    (
      await sqlErr(
        `insert into shot_production_frames (project_id, shot_id, version, schema_version, asset_id, asset_checksum, width, height, production_aspect_ratio, source, intent_snapshot, intent_fingerprint, parts, frame_fingerprint)
     values ($1,$2,98,'prism.production-frame.v1',$3,$4,1912,800,'2.39:1','upload','{}'::jsonb,$5,'{}'::jsonb,$6)`,
        [projectId, shotA.id, up1.id, sha("not the image"), sha("i"), sha("trigger-1")],
      )
    )?.includes("do not match") === true,
  );
  const noFile = await mkAsset("db:pf no file", { path: null });
  check(
    "…and one whose image has no stored file",
    (
      await sqlErr(
        `insert into shot_production_frames (project_id, shot_id, version, schema_version, asset_id, asset_checksum, width, height, production_aspect_ratio, source, intent_snapshot, intent_fingerprint, parts, frame_fingerprint)
     values ($1,$2,97,'prism.production-frame.v1',$3,$4,1912,800,'2.39:1','upload','{}'::jsonb,$5,'{}'::jsonb,$6)`,
        [projectId, shotA.id, noFile, sha("db:pf no file"), sha("i"), sha("trigger-2")],
      )
    )?.includes("no stored file") === true,
  );
  check(
    "a frame's Asset cannot be deleted from under it (project-safe foreign key)",
    (await sqlErr("delete from assets where id = $1", [up1.id])) !== null,
  );

  // a forced persistence failure AFTER the upload's Asset was written inside the same transaction: all or nothing
  const failedUpload = uploadAsset("db:pf failed upload");
  const framesBeforeFailure = (await owner.listForProject(projectId)).frames.length;
  const failedDraft = {
    ...draftOf(data, shotA.id, failedUpload),
    assetChecksum: sha("a checksum that is not the image's"),
  };
  check(
    "a frame write that fails after the Asset write is refused by the database",
    (await code(
      owner.create({ draft: failedDraft, newAsset: failedUpload, select: true, userId: dev.id, now: now() }),
    )) === "invalid",
  );
  const failedRows = await pool.query(
    "select (select count(*)::int from assets where id = $1) a, (select count(*)::int from shot_production_frames where asset_id = $1) f",
    [failedUpload.id],
  );
  check(
    "…and rolled back with it: no Asset row, no frame, no selection change",
    failedRows.rows[0].a === 0 &&
      failedRows.rows[0].f === 0 &&
      (await owner.listForProject(projectId)).frames.length === framesBeforeFailure,
  );

  // ── 7. immutability ──
  for (const [label, sql] of [
    ["asset", "update shot_production_frames set asset_id = asset_id where id = $1"],
    ["origin", "update shot_production_frames set source = 'upload' where id = $1"],
    ["snapshot", "update shot_production_frames set intent_snapshot = '{}'::jsonb where id = $1"],
    ["fingerprint", "update shot_production_frames set frame_fingerprint = frame_fingerprint where id = $1"],
    ["dimensions", "update shot_production_frames set width = 1 where id = $1"],
    ["version", "update shot_production_frames set version = version + 100 where id = $1"],
  ] as const)
    check(
      `a frame's ${label} cannot be updated (even by the database owner)`,
      (await sqlErr(sql, [r1.frame.id]))?.includes("immutable history") === true,
    );
  check(
    "RLS: the owner cannot UPDATE a frame (no policy)",
    (await asOwner("update shot_production_frames set width = 1 where id = $1", [r1.frame.id])).rowCount ===
      0,
  );
  check(
    "RLS: the owner cannot DELETE history (no policy)",
    (await asOwner("delete from shot_production_frames where id = $1", [r1.frame.id])).rowCount === 0,
  );

  // ── 8. RLS ──
  const ownerSees = (
    await asOwner("select count(*)::int n from shot_production_frames where project_id = $1", [projectId])
  ).rows[0].n;
  check("RLS: the owner reads the project's frames", ownerSees >= 10, String(ownerSees));
  check(
    "RLS: a stranger reads 0 frames",
    (await asStranger("select count(*)::int n from shot_production_frames")).rows[0].n === 0,
  );
  check(
    "RLS: a stranger reads 0 selections",
    (await asStranger("select count(*)::int n from shot_production_frame_selections")).rows[0].n === 0,
  );
  check(
    "RLS: anon reads 0 frames and 0 selections",
    (
      await asAnon(
        "select (select count(*) from shot_production_frames)::int + (select count(*) from shot_production_frame_selections)::int n",
      )
    ).rows[0]?.n === 0,
  );
  const selectionBeforeRefusals = (await owner.listForProject(projectId)).selections.find(
    (s) => s.shotId === shotA.id,
  )?.productionFrameId;
  check(
    "preview: the owner's asset read finds the Production Frame's image; a stranger's does not",
    (await new UserRepository(pool, { sub: dev.id }).findAsset(up1.id)) !== null &&
      (await new UserRepository(pool, { sub: stranger }).findAsset(up1.id)) === null,
  );
  check(
    "a stranger's service sees an empty project",
    (await strangerSvc.listForProject(projectId)).frames.length === 0,
  );
  check(
    "a stranger cannot create a frame in the owner's project",
    (await code(
      strangerSvc.create({
        draft: draftOf(data, shotA.id, up1),
        newAsset: null,
        select: true,
        userId: stranger,
        now: now(),
      }),
    )) !== "no error",
  );
  check(
    "a stranger cannot select in the owner's project",
    (await code(
      strangerSvc.select({
        projectId,
        shotId: shotA.id,
        productionFrameId: r1.frame.id,
        userId: stranger,
        now: now(),
      }),
    )) !== "no error",
  );
  check(
    "…and the owner's selection is untouched by every refusal",
    selectionBeforeRefusals !== undefined &&
      (await owner.listForProject(projectId)).selections.find((s) => s.shotId === shotA.id)
        ?.productionFrameId === selectionBeforeRefusals,
  );
  check(
    "RLS: a stranger-owned project cannot hold a frame of the owner's Shot",
    (
      await asStranger(
        `insert into shot_production_frames (project_id, shot_id, version, schema_version, asset_id, asset_checksum, width, height, production_aspect_ratio, source, intent_snapshot, intent_fingerprint, parts, frame_fingerprint)
     values ($1,$2,50,'prism.production-frame.v1',$3,$4,1912,800,'2.39:1','upload','{}'::jsonb,$5,'{}'::jsonb,$6)`,
        [projectId, shotA.id, up1.id, up1.checksum, sha("i"), sha("rls-1")],
      )
    ).error !== null,
  );

  // ── 9. the loaded state is a GenerationPackage v3 with NO 3D data ──
  const loaded = (await admin.loadProject("ojousama"))!;
  const lists = await owner.listForProject(projectId);
  loaded.productionFrames = lists.frames;
  loaded.productionFrameSelections = lists.selections;
  const ctx = buildShotContext(loaded, shotA.id);
  const selectedId = lists.selections.find((s) => s.shotId === shotA.id)!.productionFrameId;
  check(
    "ShotContext resolves the Postgres selection and a newest-first history",
    ctx.selectedProductionFrame?.id === selectedId &&
      ctx.productionFrames[0]!.version >= ctx.productionFrames.at(-1)!.version,
  );
  const pkg = assembleGenerationPackage(ctx, new Date("2026-10-21T00:00:00Z"));
  check(
    "a package built from the database state is the current version and names the selected frame by value",
    pkg.version === PACKAGE_SCHEMA_VERSION && pkg.references.productionFrame?.frameId === selectedId,
  );
  check("…without any spatial reference", !("spatialReference" in pkg) && ctx.spatial === undefined);
  check(
    "…and its Asset is described in package.assets",
    Boolean(pkg.assets[pkg.references.productionFrame!.assetId]),
  );
  check(
    "…start frame: the Production Frame's image (no explicit override on this Shot)",
    shotA.generation.startFrameAssetId !== null ||
      pkg.references.startFrameAssetId === pkg.references.productionFrame!.assetId,
  );
  check(
    "freshness resolves from the stored parts",
    ["fresh", "stale"].includes(selectedProductionFrameFreshness(ctx).status),
  );
  const unselected = lists.frames.find((f) => f.shotId === shotA.id && f.id !== selectedId)!;
  const withExtra = JSON.parse(JSON.stringify(loaded)) as ProjectData;
  withExtra.productionFrames = [...lists.frames.filter((f) => f.id !== unselected.id)];
  const pkgWithout = assembleGenerationPackage(
    buildShotContext(withExtra, shotA.id),
    new Date("2026-10-21T00:00:00Z"),
  );
  check(
    "an unselected historical frame does not change the package fingerprint",
    pkgWithout.provenance.fingerprint === pkg.provenance.fingerprint,
  );

  // ── 10. cascade ──
  const tmpShot = randomUUID();
  await pool.query(
    `insert into shots (id, project_id, episode_id, scene_id, shot_code, title)
     select $1, project_id, episode_id, scene_id, 'DBPF', 'db:pf cascade shot' from shots where id = $2`,
    [tmpShot, shotA.id],
  );
  created.shotIds.push(tmpShot);
  const casAsset = uploadAsset("db:pf cascade");
  created.assetIds.push(casAsset.id);
  const cascadeData = JSON.parse(JSON.stringify(loaded)) as ProjectData;
  cascadeData.shots.push({ ...shotA, id: tmpShot, shotCode: "DBPF" });
  const casFrame = await owner.create({
    draft: draftOf(cascadeData, tmpShot, casAsset),
    newAsset: casAsset,
    select: true,
    userId: dev.id,
    now: now(),
  });
  await pool.query("delete from shots where id = $1", [tmpShot]);
  created.shotIds.splice(created.shotIds.indexOf(tmpShot), 1);
  const left = (
    await pool.query(
      "select (select count(*)::int from shot_production_frames where shot_id = $1) f, (select count(*)::int from shot_production_frame_selections where shot_id = $1) s",
      [tmpShot],
    )
  ).rows[0];
  check(
    "deleting a Shot removes its frames and its selection (the Asset is then deletable)",
    left.f === 0 &&
      left.s === 0 &&
      (await sqlErr("delete from assets where id = $1", [casFrame.frame.assetId])) === null,
  );
  created.assetIds.splice(created.assetIds.indexOf(casAsset.id), 1);
} finally {
  // frames are append-only for users: this cleanup runs as the database owner
  await pool
    .query("delete from shot_production_frame_selections where shot_id = any($1::uuid[])", [
      created.frameShots,
    ])
    .catch(() => undefined);
  await pool
    .query(
      "delete from shot_production_frames where shot_id = any($1::uuid[]) and asset_id = any($2::uuid[])",
      [created.frameShots, created.assetIds],
    )
    .catch(() => undefined);
  for (const id of created.shotIds)
    await pool.query("delete from shots where id = $1", [id]).catch(() => undefined);
  for (const id of created.projectIds)
    await pool.query("delete from projects where id = $1", [id]).catch(() => undefined);
  for (const id of created.assetIds)
    await pool.query("delete from assets where id = $1", [id]).catch(() => undefined);
}

const leftover = await pool.query(
  `select (select count(*)::int from shot_production_frames f join assets a on a.id = f.asset_id where a.name like 'db:pf%') as frames,
          (select count(*)::int from assets where name like 'db:pf%') as assets,
          (select count(*)::int from shots where title like 'db:pf%') as shots,
          (select count(*)::int from projects where title like 'db:pf%') as projects`,
);
const l = leftover.rows[0];
check(
  "cleanup left no test rows",
  l.frames === 0 && l.assets === 0 && l.shots === 0 && l.projects === 0,
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
