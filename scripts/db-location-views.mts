// Integration tests for Phase 2G.3 Location Views against the REAL dedicated Prism Studio database
// (migration 0040: location_views, shot_location_view_selections).
//   npm run db:location-views
//
// Exercises (with real rows, cleaned up afterwards): create (upload Asset + view together; promotion reuses the Asset),
// dedupe under real concurrency, immutability, the Asset-facts trigger, same-Project / same-Location composite keys, the
// one-per-Shot selection and its compare-and-set, cross-Location refusal in the service AND the database, the
// Location-change trigger, owner-only RLS (owner / stranger / anon), that NEITHER worker role has any privilege,
// cascades (Location, Shot, Project), and that the loaded state resolves into a GenerationPackage v4.
// Requires `npm run db:seed` first (uses the demo project). No provider call, no 3D set, no GPU. Image BYTES are not
// stored here (the Storage upload path is covered by the Supabase e2e); this suite proves the relational contract.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresLocationViewData } from "../src/data/location-view-postgres";
import { LocationViewError } from "../src/data/location-view-repository";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { buildShotContext } from "../src/domain/context";
import { assembleGenerationPackage, PACKAGE_SCHEMA_VERSION } from "../src/domain/generation-package";
import { deriveProductionFrameReferenceCandidates } from "../src/domain/generation/compatibility";
import { draftLocationView, type LocationViewSpecInput } from "../src/domain/location-view";
import { assetSchema, type Asset, type Location, type ProjectData } from "../src/domain/schemas";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({ mode: "location view integration tests (rows created, then removed)", devOwner: dev.id });
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 12 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const stranger = randomUUID();
const now = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const admin = new AdminRepository(pool, dev.id);
const owner = new PostgresLocationViewData(pool, rlsPreamble({ sub: dev.id }));
const strangerSvc = new PostgresLocationViewData(pool, rlsPreamble({ sub: stranger }));

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
    (e: unknown) => (e instanceof LocationViewError ? e.code : `other: ${(e as Error).message}`),
  );

const created = {
  assetIds: [] as string[],
  shotIds: [] as string[],
  projectIds: [] as string[],
  locationIds: [] as string[],
};
// the demo Shots this suite selects for, and what they held before (restored afterwards)
const restore: {
  shots: Array<{ id: string; location_id: string | null }>;
  selections: Array<Record<string, unknown>>;
} = { shots: [], selections: [] };

try {
  const data: ProjectData = (await admin.loadProject("ojousama"))!;
  const projectId = data.project.id;
  const shotA = data.shots.find((s) => s.shotCode === "2A")!; // Grand Celeste Hotel Canopy
  const shotB = data.shots.find((s) => s.shotCode === "2B")!; // the same Location
  const shotL = data.shots.find((s) => s.shotCode === "3A")!; // Grand Celeste Lobby
  const canopy = data.locations.find((l) => l.id === shotA.spatial.locationId)!;
  const lobby = data.locations.find((l) => l.id === shotL.spatial.locationId)!;
  check(
    "the demo Shots are where this suite expects (2A, 2B at one Location; 3A at another)",
    Boolean(canopy && lobby) && shotB.spatial.locationId === canopy.id && canopy.id !== lobby.id,
  );
  const ids = [shotA.id, shotB.id, shotL.id];
  restore.shots = (
    await pool.query("select id, location_id from shots where id = any($1::uuid[])", [ids])
  ).rows;
  restore.selections = (
    await pool.query("select * from shot_location_view_selections where shot_id = any($1::uuid[])", [ids])
  ).rows;
  await pool.query("delete from shot_location_view_selections where shot_id = any($1::uuid[])", [ids]);

  // ── 1. structure, security ──
  for (const t of ["location_views", "shot_location_view_selections"]) {
    const rls = await pool.query("select relrowsecurity from pg_class where relname = $1 and relkind = 'r'", [
      t,
    ]);
    check(`${t} exists with row-level security enabled`, rls.rows[0]?.relrowsecurity === true);
  }
  const pols = await pool.query(
    "select tablename, cmd from pg_policies where schemaname = 'public' and tablename in ('location_views','shot_location_view_selections')",
  );
  const cmds = (t: string) =>
    pols.rows
      .filter((p) => p.tablename === t)
      .map((p) => p.cmd)
      .sort();
  check(
    "views: SELECT and INSERT policies only (no UPDATE or DELETE policy: canonical artifacts are append-only)",
    JSON.stringify(cmds("location_views")) === JSON.stringify(["INSERT", "SELECT"]),
    JSON.stringify(cmds("location_views")),
  );
  check("selections: one owner policy", cmds("shot_location_view_selections").length === 1);
  for (const role of ["prism_generation_worker", "prism_continuity_worker"]) {
    const exists = await pool.query("select 1 from pg_roles where rolname = $1", [role]);
    if (exists.rowCount === 0) {
      check(`${role}: role not present (skipped)`, true);
      continue;
    }
    for (const t of ["location_views", "shot_location_view_selections"]) {
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
      purpose?: string;
      path?: string | null;
      w?: number;
      h?: number;
      type?: string;
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
        o.purpose ?? "location_ref",
        o.path === undefined ? `${project}/${id}/db-lv.png` : o.path,
        sha(name),
        o.w ?? 1024,
        o.h ?? 768,
      ],
    );
    created.assetIds.push(id);
    return id;
  };
  const domainAsset = async (id: string): Promise<Asset> => (await admin.findAsset(id))!;
  const uploadAsset = (name: string): Asset => {
    const id = randomUUID();
    return assetSchema.parse({
      id,
      projectId,
      createdBy: dev.id,
      type: "image",
      purpose: "location_ref",
      source: "upload",
      name,
      originalFilename: `${name}.png`,
      storageProvider: "local",
      bucket: null,
      objectPath: `${projectId}/${id}/${name}.png`,
      mime: "image/png",
      byteSize: 1234,
      checksum: sha(name),
      width: 1024,
      height: 768,
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
    location: Location,
    asset: Asset,
    spec: Partial<LocationViewSpecInput> = {},
    source: "upload" | "production_frame" | "location_reference" = "upload",
  ) => {
    const r = draftLocationView({
      id: randomUUID(),
      now: now(),
      userId: dev.id,
      projectId: location.projectId,
      location,
      asset,
      source,
      sourceProductionFrameId: source === "production_frame" ? randomUUID() : null,
      spec: { name: "db:lv Doorway", kind: "entrance", ...spec },
    });
    if (!r.ok) throw new Error(`draft refused: ${r.message}`);
    return r.draft;
  };
  const assetCount = async () =>
    (await pool.query("select count(*)::int n from assets where project_id = $1", [projectId])).rows[0]
      .n as number;

  // ── 2. create: an upload stores its Asset and view together; a promotion reuses its Asset ──
  const up1 = uploadAsset("db:lv upload doorway");
  created.assetIds.push(up1.id);
  const a0 = await assetCount();
  const r1 = await owner.create({
    draft: draftOf(canopy, up1, {
      entranceId: canopy.entrances[0]?.id,
      viewpointDescription: "from the doors",
    }),
    newAsset: up1,
  });
  check("an upload creates a Location View", r1.created && r1.view.source === "upload");
  check(
    "…with its NEW private Asset (purpose location_ref), stored together",
    (await assetCount()) === a0 + 1 && (await domainAsset(up1.id)).purpose === "location_ref",
  );
  check(
    "…frozen facts equal the Asset's (checksum, size); any shape (4:3 here, not the 2.39:1 production frame)",
    r1.view.assetChecksum === up1.checksum && r1.view.width === 1024 && r1.view.height === 768,
  );
  check(
    "…the view spec was stored by value (entrance copied from the Location)",
    r1.view.viewSpec.schema === "prism.location-view-spec.v1" &&
      r1.view.viewSpec.entrance?.id === canopy.entrances[0]?.id,
  );
  const pfAssetId = await mkAsset("db:lv production frame image", {
    purpose: "production_frame",
    w: 1912,
    h: 800,
  });
  const a1 = await assetCount();
  const fromPf = await owner.create({
    draft: draftOf(
      canopy,
      await domainAsset(pfAssetId),
      { name: "db:lv Canopy establishing", kind: "establishing" },
      "production_frame",
    ),
    newAsset: null,
  });
  check(
    "a Production Frame promotion REUSES the frame's Asset: source production_frame, no new Asset",
    fromPf.created &&
      fromPf.view.assetId === pfAssetId &&
      fromPf.view.source === "production_frame" &&
      fromPf.view.sourceProductionFrameId !== null &&
      (await assetCount()) === a1,
  );

  // ── 3. dedupe, concurrency ──
  const dupAsset = uploadAsset("db:lv upload doorway"); // same bytes as up1, a different Asset row
  created.assetIds.push(dupAsset.id);
  const a2 = await assetCount();
  const dup = await owner.create({
    draft: draftOf(canopy, dupAsset, {
      entranceId: canopy.entrances[0]?.id,
      viewpointDescription: "from the doors",
    }),
    newAsset: dupAsset,
  });
  check(
    "an identical view (same Location, checksum, spec) returns the EXISTING one",
    !dup.created && dup.view.id === r1.view.id,
  );
  check("…and the new Asset was NOT stored", (await assetCount()) === a2);
  const twin = uploadAsset("db:lv twin");
  created.assetIds.push(twin.id);
  const twinDraft = draftOf(canopy, twin, { name: "db:lv Twin" });
  const twins = await Promise.all(
    Array.from({ length: 5 }, () =>
      owner.create({ draft: { ...twinDraft, id: randomUUID() }, newAsset: twin }),
    ),
  );
  check(
    "5 concurrent IDENTICAL creates make exactly one view",
    twins.filter((t) => t.created).length === 1 && new Set(twins.map((t) => t.view.id)).size === 1,
  );
  const tighter = await owner.create({
    draft: draftOf(canopy, up1, { name: "db:lv Doorway — tighter", viewpointDescription: "from the doors" }),
    newAsset: null,
  });
  check(
    "the same image with a CHANGED spec is a legitimately new view",
    tighter.created && tighter.view.assetId === up1.id && tighter.view.id !== r1.view.id,
  );

  // ── 4. immutability ──
  for (const [label, sql] of [
    ["location", "update location_views set location_id = location_id where id = $1"],
    ["asset", "update location_views set asset_id = asset_id where id = $1"],
    ["source", "update location_views set source = 'upload' where id = $1"],
    ["spec", "update location_views set view_spec = view_spec where id = $1"],
    ["checksum", "update location_views set asset_checksum = asset_checksum where id = $1"],
    ["fingerprint", "update location_views set view_fingerprint = view_fingerprint where id = $1"],
    ["name", "update location_views set name = 'renamed' where id = $1"],
  ] as const)
    check(
      `a view's ${label} cannot be updated (even by the database owner)`,
      (await sqlErr(sql, [r1.view.id]))?.includes("immutable") === true,
    );
  check(
    "RLS: the owner cannot UPDATE a view (no policy)",
    (await asOwner("update location_views set width = 1 where id = $1", [r1.view.id])).rowCount === 0,
  );
  check(
    "RLS: the owner cannot DELETE a view (no policy)",
    (await asOwner("delete from location_views where id = $1", [r1.view.id])).rowCount === 0,
  );

  // ── 5. database barriers on create ──
  const otherProject = randomUUID();
  await pool.query("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
    otherProject,
    dev.id,
    `db-lv-${otherProject.slice(0, 8)}`,
    "db:lv other project",
  ]);
  created.projectIds.push(otherProject);
  const foreignAsset = await mkAsset("db:lv foreign image", { project: otherProject });
  const rawView = (o: {
    project?: string;
    location?: string;
    asset?: string;
    checksum?: string;
    source?: string;
    pf?: boolean;
    name?: string;
    specName?: string;
  }) =>
    sqlErr(
      `insert into location_views (project_id, location_id, schema_version, name, kind, asset_id, asset_checksum, width, height,
         source, source_production_frame_id, view_spec, view_fingerprint)
       values ($1,$2,'prism.location-view.v1',$3,'detail',$4,$5,1024,768,$6,${o.pf ? "gen_random_uuid()" : "null"},
         jsonb_build_object('schema','prism.location-view-spec.v1','name',$7::text,'kind','detail'),$8)`,
      [
        o.project ?? projectId,
        o.location ?? canopy.id,
        o.name ?? "db:lv raw",
        o.asset ?? up1.id,
        o.checksum ?? up1.checksum,
        o.source ?? "upload",
        o.specName ?? o.name ?? "db:lv raw",
        sha(`raw-${Math.random()}`),
      ],
    );
  check(
    "the database refuses a view whose Asset belongs to another project",
    (await rawView({ asset: foreignAsset, checksum: sha("db:lv foreign image") })) !== null,
  );
  check(
    "the database refuses a view of ANOTHER project's Location id",
    (await rawView({ project: otherProject, asset: foreignAsset, checksum: sha("db:lv foreign image") })) !==
      null,
  );
  check(
    "the Asset-facts trigger refuses a checksum that is not the image's",
    (await rawView({ checksum: sha("not the image") }))?.includes("do not match") === true,
  );
  const noFile = await mkAsset("db:lv no file", { path: null });
  check(
    "…and an image with no stored file",
    (await rawView({ asset: noFile, checksum: sha("db:lv no file") }))?.includes("no stored file") === true,
  );
  check(
    "an origin must carry exactly its own source id (an upload with a Production Frame id is refused)",
    (await rawView({ pf: true })) !== null,
  );
  check(
    "the row's name must be its spec's name",
    (await rawView({ name: "db:lv a", specName: "db:lv b" })) !== null,
  );
  check(
    "a view's Asset cannot be deleted from under it (project-safe foreign key)",
    (await sqlErr("delete from assets where id = $1", [up1.id])) !== null,
  );
  // all or nothing: a view write that fails after the upload's Asset write leaves neither
  const failedUpload = uploadAsset("db:lv failed upload");
  const failed = await code(
    owner.create({
      draft: { ...draftOf(canopy, failedUpload, { name: "db:lv failed" }), assetChecksum: sha("wrong") },
      newAsset: failedUpload,
    }),
  );
  const failedRows = (
    await pool.query(
      "select (select count(*)::int from assets where id = $1) a, (select count(*)::int from location_views where asset_id = $1) v",
      [failedUpload.id],
    )
  ).rows[0];
  check(
    "a view write refused by the database rolls back its new Asset too",
    failed === "invalid" && failedRows.a === 0 && failedRows.v === 0,
    failed,
  );

  // ── 6. selection: same Location only, one per Shot, compare-and-set, clear ──
  const lobbyAssetId = await mkAsset("db:lv lobby image");
  const lobbyView = (
    await owner.create({
      draft: draftOf(lobby, await domainAsset(lobbyAssetId), { name: "db:lv Concierge desk", kind: "zone" }),
      newAsset: null,
    })
  ).view;
  const sel = (shotId: string, viewId: string, expected?: string | null) =>
    owner.selectForShot({
      projectId,
      shotId,
      locationViewId: viewId,
      userId: dev.id,
      now: now(),
      expectedSelectedViewId: expected,
    });
  const shotRowBefore = JSON.stringify(
    (await pool.query("select * from shots where id = $1", [shotA.id])).rows[0],
  );
  const s1 = await sel(shotA.id, r1.view.id, null);
  check(
    "a Shot selects a view of ITS Location (the pointer carries the view's Location)",
    s1.locationViewId === r1.view.id && s1.locationId === canopy.id && s1.selectedBy === dev.id,
  );
  check(
    "…without mutating the Shot row",
    JSON.stringify((await pool.query("select * from shots where id = $1", [shotA.id])).rows[0]) ===
      shotRowBefore,
  );
  check(
    "the service REFUSES a view of another Location",
    (await code(sel(shotL.id, r1.view.id))) === "wrong_location",
  );
  check(
    "the database REFUSES a direct cross-Location selection (trigger)",
    (
      await sqlErr(
        "insert into shot_location_view_selections (shot_id, project_id, location_view_id, location_id) values ($1,$2,$3,$4)",
        [shotL.id, projectId, r1.view.id, canopy.id],
      )
    )?.includes("set in that Location") === true,
  );
  check(
    "…and one that misstates the view's Location (composite key)",
    (await sqlErr(
      "insert into shot_location_view_selections (shot_id, project_id, location_view_id, location_id) values ($1,$2,$3,$4)",
      [shotL.id, projectId, r1.view.id, lobby.id],
    )) !== null,
  );
  check(
    "…and an update that points an existing selection at another Location's view",
    (await sqlErr(
      "update shot_location_view_selections set location_view_id = $2, location_id = $3 where shot_id = $1",
      [shotA.id, lobbyView.id, lobby.id],
    )) !== null,
  );
  check(
    "…and a selection naming another project",
    (await sqlErr("update shot_location_view_selections set project_id = $2 where shot_id = $1", [
      shotA.id,
      otherProject,
    ])) !== null,
  );
  check(
    "the database allows exactly one selection row per Shot (primary key)",
    (await sqlErr(
      "insert into shot_location_view_selections (shot_id, project_id, location_view_id, location_id) values ($1,$2,$3,$4)",
      [shotA.id, projectId, tighter.view.id, canopy.id],
    )) !== null,
  );
  check(
    "compare-and-set: a stale expectation conflicts",
    (await code(sel(shotA.id, tighter.view.id, null))) === "conflict" &&
      (await code(sel(shotA.id, tighter.view.id, tighter.view.id))) === "conflict",
  );
  check(
    "compare-and-set: the right expectation succeeds (A → B)",
    (await code(sel(shotA.id, tighter.view.id, r1.view.id))) === "no error",
  );
  const race = await Promise.allSettled(
    [r1.view.id, fromPf.view.id].map((v) => sel(shotA.id, v, tighter.view.id)),
  );
  check(
    "two tabs choosing from the same state: exactly one wins",
    race.filter((r) => r.status === "fulfilled").length === 1 &&
      race.filter((r) => r.status === "rejected").length === 1,
  );
  const current = (await owner.selectionForShot(projectId, shotA.id))!.locationViewId;
  check(
    "re-selecting the selected view is a harmless no-op",
    (await code(sel(shotA.id, current))) === "no error",
  );
  check(
    "clear: compare-and-set refuses a stale expectation, then clears",
    (await code(owner.clearForShot({ projectId, shotId: shotA.id, expectedSelectedViewId: null }))) ===
      "conflict" &&
      (await code(owner.clearForShot({ projectId, shotId: shotA.id, expectedSelectedViewId: current }))) ===
        "no error" &&
      (await owner.selectionForShot(projectId, shotA.id)) === null,
  );
  check("…and reselect works (none → view)", (await code(sel(shotA.id, r1.view.id, null))) === "no error");
  await sel(shotB.id, r1.view.id); // the SAME view for a second Shot at the Location
  const viewsBefore = JSON.stringify(
    (await owner.listForLocation(projectId, canopy.id)).filter((v) => v.id === r1.view.id),
  );

  // ── 7. a Shot that moves to another Location loses the old Location's view (trigger) ──
  await pool.query("update shots set title = title where id = $1", [shotA.id]);
  check(
    "an unrelated Shot update keeps the selection",
    (await owner.selectionForShot(projectId, shotA.id))?.locationViewId === r1.view.id,
  );
  const moved = await asOwner(
    "update shots set location_id = $2 where id = $1 returning (select count(*)::int from shot_location_view_selections where shot_id = $1) as n",
    [shotA.id, lobby.id],
  );
  check(
    "the owner can change the Shot's Location (RLS-bound, the trigger runs as the owner)",
    moved.error === null,
    moved.error ?? "",
  );
  await pool.query("update shots set location_id = $2 where id = $1", [shotA.id, lobby.id]);
  check(
    "changing the Shot's Location removes the old Location's view selection in the same statement",
    (await owner.selectionForShot(projectId, shotA.id)) === null,
  );
  await pool.query("update shots set location_id = $2 where id = $1", [shotA.id, canopy.id]);
  check(
    "…and moving back does NOT resurrect it",
    (await owner.selectionForShot(projectId, shotA.id)) === null,
  );
  check(
    "…while the other Shot's selection and the view itself are untouched",
    (await owner.selectionForShot(projectId, shotB.id))?.locationViewId === r1.view.id &&
      JSON.stringify(
        (await owner.listForLocation(projectId, canopy.id)).filter((v) => v.id === r1.view.id),
      ) === viewsBefore,
  );

  // ── 8. RLS ──
  const ownerSees = (
    await asOwner("select count(*)::int n from location_views where project_id = $1", [projectId])
  ).rows[0].n;
  check("RLS: the owner reads the project's views", ownerSees >= 5, String(ownerSees));
  check(
    "RLS: a stranger reads 0 views and 0 selections",
    (
      await asStranger(
        "select (select count(*) from location_views)::int + (select count(*) from shot_location_view_selections)::int n",
      )
    ).rows[0].n === 0,
  );
  check(
    "RLS: anon reads 0 views and 0 selections",
    (
      await asAnon(
        "select (select count(*) from location_views)::int + (select count(*) from shot_location_view_selections)::int n",
      )
    ).rows[0]?.n === 0,
  );
  check(
    "a stranger's service sees an empty project",
    (await strangerSvc.listForProject(projectId)).views.length === 0,
  );
  check(
    "a stranger cannot create a view in the owner's project",
    (await code(
      strangerSvc.create({ draft: draftOf(canopy, up1, { name: "db:lv stranger" }), newAsset: null }),
    )) !== "no error",
  );
  check(
    "a stranger cannot select or clear in the owner's project",
    (await code(
      strangerSvc.selectForShot({
        projectId,
        shotId: shotA.id,
        locationViewId: r1.view.id,
        userId: stranger,
        now: now(),
      }),
    )) !== "no error" &&
      (await code(strangerSvc.clearForShot({ projectId, shotId: shotB.id }))) !== "no error" &&
      (await owner.selectionForShot(projectId, shotB.id))?.locationViewId === r1.view.id,
  );
  check(
    "RLS: a stranger cannot insert a selection row directly",
    (
      await asStranger(
        "insert into shot_location_view_selections (shot_id, project_id, location_view_id, location_id) values ($1,$2,$3,$4)",
        [shotA.id, projectId, r1.view.id, canopy.id],
      )
    ).error !== null,
  );

  // ── 9. the loaded state is a GenerationPackage v4 that sends the view ──
  const loaded = (await admin.loadProject("ojousama"))!;
  const lists = await owner.listForProject(projectId);
  loaded.locationViews = lists.views;
  loaded.shotLocationViewSelections = lists.selections;
  const ctx = buildShotContext(loaded, shotB.id);
  check(
    "ShotContext resolves the Postgres selection",
    ctx.selectedLocationView?.id === r1.view.id && !ctx.locationViewIssue,
  );
  check(
    "ShotContext lists only the views of the Shot's Location",
    ctx.locationViews.length > 0 && ctx.locationViews.every((v) => v.locationId === canopy.id),
  );
  const pkg = assembleGenerationPackage(ctx, new Date("2026-10-22T00:00:00Z"));
  check(
    "a package built from the database state is the current version and names the view by value",
    pkg.version === PACKAGE_SCHEMA_VERSION &&
      pkg.references.locationView?.viewId === r1.view.id &&
      Boolean(pkg.assets[up1.id]),
  );
  check(
    "…and a Production Frame candidate would send it as location_view",
    deriveProductionFrameReferenceCandidates(pkg).some(
      (r) => r.assetId === up1.id && r.role === "location_view",
    ),
  );

  // ── 10. cascades: Location, Shot, Project (no over-broad trigger) ──
  const tmpLoc = randomUUID();
  await pool.query("insert into locations (id, project_id, name) values ($1,$2,'db:lv cascade location')", [
    tmpLoc,
    projectId,
  ]);
  created.locationIds.push(tmpLoc);
  const tmpShot = randomUUID();
  await pool.query(
    `insert into shots (id, project_id, episode_id, scene_id, shot_code, title, location_id)
     select $1, project_id, episode_id, scene_id, 'DBLV', 'db:lv cascade shot', $3 from shots where id = $2`,
    [tmpShot, shotA.id, tmpLoc],
  );
  created.shotIds.push(tmpShot);
  const tmpLocation = { ...canopy, id: tmpLoc, zones: [], entrances: [] };
  const casAsset = uploadAsset("db:lv cascade");
  created.assetIds.push(casAsset.id);
  const casView = (
    await owner.create({
      draft: draftOf(tmpLocation, casAsset, { name: "db:lv cascade" }),
      newAsset: casAsset,
    })
  ).view;
  await owner.selectForShot({
    projectId,
    shotId: tmpShot,
    locationViewId: casView.id,
    userId: dev.id,
    now: now(),
  });
  await pool.query("delete from locations where id = $1", [tmpLoc]);
  created.locationIds.splice(created.locationIds.indexOf(tmpLoc), 1);
  const left = (
    await pool.query(
      "select (select count(*)::int from location_views where id = $1) v, (select count(*)::int from shot_location_view_selections where shot_id = $2) s",
      [casView.id, tmpShot],
    )
  ).rows[0];
  check(
    "deleting a Location removes its views and the selections of them (the Asset is then deletable)",
    left.v === 0 &&
      left.s === 0 &&
      (await sqlErr("delete from assets where id = $1", [casAsset.id])) === null,
  );
  created.assetIds.splice(created.assetIds.indexOf(casAsset.id), 1);
  await pool.query("delete from shots where id = $1", [tmpShot]);
  created.shotIds.splice(created.shotIds.indexOf(tmpShot), 1);
  // a whole other project with a Location, a view and a selection can be deleted (cascades are not blocked)
  const opLoc = randomUUID();
  await pool.query("insert into locations (id, project_id, name) values ($1,$2,'db:lv other location')", [
    opLoc,
    otherProject,
  ]);
  const opAsset = await mkAsset("db:lv other project image", { project: otherProject });
  const opView = draftOf(
    { ...canopy, id: opLoc, projectId: otherProject, zones: [], entrances: [] },
    await domainAsset(opAsset),
    { name: "db:lv other" },
  );
  await owner.create({ draft: opView, newAsset: null });
  const projectDelete = await sqlErr("delete from projects where id = $1", [otherProject]);
  check(
    "deleting a Project cascades through its views (no over-broad trigger)",
    projectDelete === null,
    projectDelete ?? "",
  );
  if (projectDelete === null) {
    created.projectIds.splice(created.projectIds.indexOf(otherProject), 1);
    created.assetIds = created.assetIds.filter((id) => id !== opAsset && id !== foreignAsset);
  }
} finally {
  // views are append-only for users: this cleanup runs as the database owner (selections cascade)
  await pool
    .query("delete from location_views where asset_id = any($1::uuid[])", [created.assetIds])
    .catch(() => undefined);
  for (const id of created.shotIds)
    await pool.query("delete from shots where id = $1", [id]).catch(() => undefined);
  for (const id of created.locationIds)
    await pool.query("delete from locations where id = $1", [id]).catch(() => undefined);
  for (const id of created.projectIds)
    await pool.query("delete from projects where id = $1", [id]).catch(() => undefined);
  for (const id of created.assetIds)
    await pool.query("delete from assets where id = $1", [id]).catch(() => undefined);
  // the demo Shots exactly as they were
  for (const s of restore.shots)
    await pool
      .query("update shots set location_id = $2 where id = $1", [s.id, s.location_id])
      .catch(() => undefined);
  for (const s of restore.selections)
    await pool
      .query(
        "insert into shot_location_view_selections (shot_id, project_id, location_view_id, location_id, selected_by, selected_at) values ($1,$2,$3,$4,$5,$6) on conflict (shot_id) do nothing",
        [s.shot_id, s.project_id, s.location_view_id, s.location_id, s.selected_by, s.selected_at],
      )
      .catch(() => undefined);
}

const leftover = (
  await pool.query(
    `select (select count(*)::int from location_views where name like 'db:lv%') as views,
            (select count(*)::int from assets where name like 'db:lv%') as assets,
            (select count(*)::int from shots where title like 'db:lv%') as shots,
            (select count(*)::int from locations where name like 'db:lv%') as locations,
            (select count(*)::int from projects where title like 'db:lv%') as projects`,
  )
).rows[0];
check(
  "cleanup left no test rows",
  leftover.views === 0 &&
    leftover.assets === 0 &&
    leftover.shots === 0 &&
    leftover.locations === 0 &&
    leftover.projects === 0,
  JSON.stringify(leftover),
);
const shotsNow = (
  await pool.query("select id, location_id from shots where id = any($1::uuid[])", [
    restore.shots.map((s) => s.id),
  ])
).rows;
check(
  "the demo Shots' Locations are exactly as before",
  restore.shots.every((s) => shotsNow.find((x) => x.id === s.id)?.location_id === s.location_id),
);

let failed = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await pool.end();
process.exit(failed ? 1 : 0);
