// Integration tests for Phase 4D "Copy setup from…" against a REAL PostgreSQL database (no migration: the copy writes
// the existing Shot-owned tables shot_camera_bookmarks, shot_light_rigs and shot_character_blocking).
//   npm run db:setup-copy
//
// Exercises with real rows (removed afterwards): copy by value into the destination's OWN rows, identical content
// fingerprints, independence in both directions, deletion of the source Shot, a stale review refused, ATOMICITY under
// an injected mid-transaction fault, owner-only RLS (a stranger can neither copy from nor into the owner's Shots), and
// cross-Project refusal. Requires `npm run db:seed` first (uses the demo project). No provider call.
// Phase 4D ran it on a DISPOSABLE local database only (docs/local-supabase.md); hosted acceptance is a later slice.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { PostgresPrevisData } from "../src/data/previs-postgres";
import type { PrevisRepository } from "../src/data/previs-repository";
import { newBlockingEntry } from "../src/domain/previs/blocking";
import { buildPrevisDocument } from "../src/domain/previs/document";
import { buildHotelCanopyEngineScene } from "../src/domain/previs/hotel-canopy";
import {
  SHOT_LIGHTING_SCHEMA,
  authoredLightingIntent,
  newShotLight,
  parseShotLightingRig,
} from "../src/domain/previs/lighting";
import { planSetupCopy, SETUP_COMPONENTS, type SetupComponent } from "../src/domain/previs/setup-copy";
import { bookmarkCameraFingerprint } from "../src/domain/previs/spatial-passes";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({ mode: "Setup copy integration tests (rows created, then removed)", devOwner: dev.id });
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 4 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const err = (fn: () => Promise<unknown>) =>
  fn().then(
    () => null as string | null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
const now = () => new Date().toISOString();

const admin = new AdminRepository(pool, dev.id);
const owner = new PostgresPrevisData(pool, rlsPreamble({ sub: dev.id }));
const stranger = new PostgresPrevisData(pool, rlsPreamble({ sub: randomUUID() }));

/** A pool whose clients fail the first blocking write: proves the whole copy rolls back. */
const faultyPool = {
  connect: async () => {
    const c = await pool.connect();
    const query = c.query.bind(c);
    const release = c.release.bind(c);
    (c as unknown as { query: unknown }).query = (sql: unknown, params?: unknown[]) =>
      typeof sql === "string" && /^\s*(insert into|update) shot_character_blocking/i.test(sql)
        ? Promise.reject(new Error("injected fault"))
        : query(sql as string, params);
    c.release = ((e?: Error | boolean) => {
      (c as unknown as { query: unknown }).query = query;
      c.release = release;
      return release(e);
    }) as typeof c.release;
    return c;
  },
} as unknown as pg.Pool;
const faulty = new PostgresPrevisData(faultyPool, rlsPreamble({ sub: dev.id }));

const created = { locationIds: [] as string[], shotIds: [] as string[], projectIds: [] as string[] };
let restoreShotLocations: Array<{ id: string; location_id: string | null }> = [];

/** Every Shot-owned setup row of a Shot, exactly as stored (any change at all shows). */
const rowsJson = async (shotId: string) =>
  JSON.stringify(
    (
      await pool.query(
        `select 'camera' k, to_jsonb(b) r from shot_camera_bookmarks b where shot_id = $1
         union all select 'lighting', to_jsonb(l) from shot_light_rigs l where shot_id = $1
         union all select 'blocking:' || character_id, to_jsonb(f) from shot_character_blocking f where shot_id = $1
         order by 1`,
        [shotId],
      )
    ).rows,
  );

try {
  const data = (await admin.loadProject("ojousama"))!;
  const projectId = data.project.id;
  const [src0, dst0] = [
    data.shots.find((s) => s.shotCode === "2A")!,
    data.shots.find((s) => s.shotCode === "2B")!,
  ];
  const [c1, c2] = data.characters;

  // the copy overwrites a destination's rows: refuse to run over any pre-existing setup of the two demo Shots
  const pre = await pool.query(
    `select (select count(*) from shot_camera_bookmarks where shot_id = any($1::uuid[])) +
            (select count(*) from shot_light_rigs where shot_id = any($1::uuid[])) +
            (select count(*) from shot_character_blocking where shot_id = any($1::uuid[])) n`,
    [[src0.id, dst0.id]],
  );
  if (Number(pre.rows[0].n) !== 0)
    throw new Error(
      "Shots 2A / 2B already hold spatial setup rows; this suite only runs on Shots without any.",
    );

  // ── 0. no schema change ──
  const ledger = await pool.query("select max(name) m from prism_migrations");
  check(
    "no migration added: the head is 0049",
    ledger.rows[0].m === "0049_spatial_camera_and_frame_source.sql",
  );
  const tables = await pool.query(
    "select count(*)::int n from pg_tables where schemaname = 'public' and tablename ~ '(template|preset|setup)'",
  );
  check(
    "no setup / template / preset table exists (copies live in the Shot's own rows)",
    tables.rows[0].n === 0,
  );

  // ── fixtures: a private set, both Shots on it, and a temporary third Shot (deleted by the deletion check) ──
  const loc = randomUUID();
  await pool.query(
    "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
    [loc, projectId, "db:setup-copy set location"],
  );
  created.locationIds.push(loc);
  const tmpShot = randomUUID();
  await pool.query(
    `insert into shots select (jsonb_populate_record(null::shots,
       to_jsonb(s) || jsonb_build_object('id', $2::uuid, 'shot_code', 'ZZ-setup-copy'))).* from shots s where id = $1`,
    [src0.id, tmpShot],
  );
  created.shotIds.push(tmpShot);
  restoreShotLocations = (
    await pool.query("select id, location_id from shots where id = any($1::uuid[])", [[src0.id, dst0.id]])
  ).rows as typeof restoreShotLocations;
  await pool.query("update shots set location_id = $2 where id = any($1::uuid[])", [
    [src0.id, dst0.id, tmpShot],
    loc,
  ]);
  const fresh = (await admin.loadProject("ojousama"))!;
  const SRC = fresh.shots.find((s) => s.id === src0.id)!;
  const DST = fresh.shots.find((s) => s.id === dst0.id)!;
  const TMP = fresh.shots.find((s) => s.id === tmpShot)!;

  const scene = await owner.saveScene({
    id: randomUUID(),
    projectId,
    locationId: loc,
    document: buildPrevisDocument({ engineScene: buildHotelCanopyEngineScene() }),
    expectedRevision: null,
    engineVersion: "test",
    userId: dev.id,
    now: now(),
  });
  const set = { locationId: loc, sceneDocumentId: scene.id };
  const rigFor = (shot: typeof SRC, intensity: number) =>
    parseShotLightingRig({
      schema: SHOT_LIGHTING_SCHEMA,
      base: { mode: "replace" },
      lights: [{ ...newShotLight("point", "key"), id: "key", intensity }],
      authoredIntent: authoredLightingIntent(shot),
    });
  const anchor = {
    locationId: loc,
    sceneDocumentId: scene.id,
    sceneRevision: scene.revision,
    sceneFingerprint: scene.sceneFingerprint,
  };
  const give = async (shot: typeof SRC, x: number) => {
    await owner.setBookmark({
      id: randomUUID(),
      projectId,
      shotId: shot.id,
      locationId: loc,
      sceneDocumentId: scene.id,
      userId: dev.id,
      now: now(),
    });
    const rig = await owner.getLightingRigForShot(shot.id);
    await owner.saveLightingRig({
      id: randomUUID(),
      projectId,
      shotId: shot.id,
      ...anchor,
      rig: rigFor(shot, 10 * x),
      expectedRevision: rig?.revision ?? null,
      userId: dev.id,
      now: now(),
    });
    for (const [i, ch] of [c1!, c2!].entries()) {
      const cur = (await owner.listShotBlocking(shot.id)).find((r) => r.characterId === ch.id);
      await owner.saveShotBlocking({
        id: randomUUID(),
        projectId,
        shotId: shot.id,
        characterId: ch.id,
        ...anchor,
        entry: newBlockingEntry(ch.id, { x: x + i, y: 0, z: 0 }),
        expectedRevision: cur?.revision ?? null,
        userId: dev.id,
        now: now(),
      });
    }
  };
  const rowsOf = async (repo: PrevisRepository, shotId: string) => ({
    camera: await repo.getBookmarkForShot(shotId),
    lighting: await repo.getLightingRigForShot(shotId),
    blocking: await repo.listShotBlocking(shotId),
  });
  const review = async (
    from: typeof SRC,
    into: typeof SRC,
    components: SetupComponent[] = [...SETUP_COMPONENTS],
  ) =>
    planSetupCopy({
      sourceShotId: from.id,
      destinationShotId: into.id,
      set,
      source: await rowsOf(owner, from.id),
      destination: await rowsOf(owner, into.id),
      components,
    });
  const copy = (
    repo: PrevisRepository,
    from: typeof SRC,
    into: typeof SRC,
    token: string,
    over: Record<string, unknown> = {},
  ) =>
    repo.copyShotSetup({
      projectId,
      sourceShotId: from.id,
      destinationShotId: into.id,
      ...set,
      components: [...SETUP_COMPONENTS],
      expectedToken: token,
      destinationIntent: authoredLightingIntent(into),
      userId: dev.id,
      now: now(),
      ...over,
    });

  await give(SRC, 1);

  // ── 1. RLS: a stranger can neither read the source nor copy from / into the owner's Shots ──
  const strangerRows = await rowsOf(stranger, SRC.id);
  check(
    "a stranger sees none of the owner's setup rows",
    !strangerRows.camera && !strangerRows.lighting && strangerRows.blocking.length === 0,
  );
  const plan0 = await review(SRC, DST);
  const dstBefore0 = await rowsJson(DST.id);
  const strangerCopy = await err(() => copy(stranger, SRC, DST, plan0.token));
  check(
    "a stranger's copy is refused as an unknown Shot",
    strangerCopy === "That shot is not in this project.",
    strangerCopy ?? "",
  );
  check("a stranger's refused copy wrote nothing", (await rowsJson(DST.id)) === dstBefore0);

  // ── 2. cross-Project: a Shot of another Project of the same owner is refused ──
  const otherProject = randomUUID();
  await pool.query(
    `insert into projects select (jsonb_populate_record(null::projects, to_jsonb(p) ||
       jsonb_build_object('id', $2::uuid, 'slug', 'db-setup-copy-' || left($2::text, 8), 'title', 'db:setup-copy other'))).*
     from projects p where id = $1`,
    [projectId, otherProject],
  );
  created.projectIds.push(otherProject);
  const cross = await err(() => copy(owner, SRC, DST, plan0.token, { projectId: otherProject }));
  check(
    "a copy naming another Project is refused",
    cross === "That shot is not in this project.",
    cross ?? "",
  );
  check("the refused cross-Project copy wrote nothing", (await rowsJson(DST.id)) === dstBefore0);

  // ── 3. a stale review is refused and writes nothing ──
  const stale = await err(() => copy(owner, SRC, DST, "0".repeat(64)));
  check(
    "a token other than the reviewed one is refused",
    /changed after you reviewed/.test(stale ?? ""),
    stale ?? "",
  );
  check("the stale copy wrote nothing", (await rowsJson(DST.id)) === dstBefore0);

  // ── 3b. both Shots' Location is rechecked under lock: a destination moved after review is refused ──
  await pool.query("update shots set location_id = null where id = $1", [DST.id]);
  const moved = await err(() => copy(owner, SRC, DST, plan0.token));
  await pool.query("update shots set location_id = $2 where id = $1", [DST.id, loc]);
  check(
    "a destination moved off the Location after review is refused",
    /changed after you reviewed/.test(moved ?? ""),
    moved ?? "",
  );
  check("the refused moved-Shot copy wrote nothing", (await rowsJson(DST.id)) === dstBefore0);

  // ── 4. ATOMICITY: a fault on the last part rolls back camera and lighting too ──
  const fault = await err(() => copy(faulty, SRC, DST, plan0.token));
  check("the injected fault surfaces", fault === "injected fault", fault ?? "");
  check(
    "after the fault the destination is exactly as before (no camera-without-lighting)",
    (await rowsJson(DST.id)) === dstBefore0,
  );

  // ── 5. the copy ──
  const srcBefore = await rowsJson(SRC.id);
  const out = await copy(owner, SRC, DST, plan0.token);
  const a = await rowsOf(owner, SRC.id);
  const b = await rowsOf(owner, DST.id);
  check("the copy wrote all three parts", !!out.camera && !!out.lighting && out.blocking?.length === 2);
  check(
    "the destination's rows are its OWN (its Shot, new ids)",
    b.camera!.shotId === DST.id &&
      b.camera!.id !== a.camera!.id &&
      b.lighting!.shotId === DST.id &&
      b.lighting!.id !== a.lighting!.id &&
      b.blocking.every((r) => r.shotId === DST.id && !a.blocking.some((x) => x.id === r.id)),
  );
  check(
    "identical content gives identical fingerprints",
    bookmarkCameraFingerprint(b.camera!.value) === bookmarkCameraFingerprint(a.camera!.value) &&
      b.lighting!.lightingFingerprint === a.lighting!.lightingFingerprint &&
      JSON.stringify(b.blocking.map((r) => r.blockingFingerprint)) ===
        JSON.stringify(a.blocking.map((r) => r.blockingFingerprint)),
  );
  check(
    "lighting keeps the destination's own authored notes",
    JSON.stringify(b.lighting!.rig.authoredIntent) === JSON.stringify(authoredLightingIntent(DST)),
  );
  check("the copy changed nothing on the source", (await rowsJson(SRC.id)) === srcBefore);
  const cols = await pool.query(
    `select count(*)::int n from information_schema.columns where table_schema = 'public'
       and table_name in ('shot_camera_bookmarks', 'shot_light_rigs', 'shot_character_blocking')
       and (column_name like '%source%' or column_name like '%copied%' or column_name like '%template%')`,
  );
  check("no column on the destination's rows can point at a source", cols.rows[0].n === 0);

  // ── 6. independence, both ways ──
  const dstAfter = await rowsJson(DST.id);
  await give(SRC, 5); // new lighting + blocking on the source
  check("editing the source changes nothing on the destination", (await rowsJson(DST.id)) === dstAfter);
  const srcNow = await rowsJson(SRC.id);
  await give(DST, 9);
  check("editing the destination changes nothing on the source", (await rowsJson(SRC.id)) === srcNow);

  // ── 7. a second copy over existing rows: compare-and-set revisions advance by one ──
  const p2 = await review(SRC, DST);
  const before2 = await rowsOf(owner, DST.id);
  await copy(owner, SRC, DST, p2.token);
  const after2 = await rowsOf(owner, DST.id);
  check(
    "copying over existing rows advances their revisions by exactly one and keeps their ids",
    after2.lighting!.revision === before2.lighting!.revision + 1 &&
      after2.lighting!.id === before2.lighting!.id &&
      after2.blocking.every(
        (r) => r.revision === before2.blocking.find((x) => x.characterId === r.characterId)!.revision + 1,
      ) &&
      after2.camera!.id === before2.camera!.id,
  );

  // ── 8. source deletion: the destination keeps everything ──
  await give(TMP, 3);
  const p3 = await review(TMP, DST);
  await copy(owner, TMP, DST, p3.token);
  const fromTmp = await rowsJson(DST.id);
  await pool.query("delete from shots where id = $1", [TMP.id]);
  created.shotIds = [];
  const tmpLeft = await pool.query(
    `select (select count(*) from shot_camera_bookmarks where shot_id = $1) + (select count(*) from shot_light_rigs where
       shot_id = $1) + (select count(*) from shot_character_blocking where shot_id = $1) n`,
    [TMP.id],
  );
  check("deleting the source Shot removes its own rows (cascade)", Number(tmpLeft.rows[0].n) === 0);
  check(
    "deleting the source Shot leaves the destination's copy byte-for-byte intact",
    (await rowsJson(DST.id)) === fromTmp,
  );
  const bAfter = await rowsOf(owner, DST.id);
  check(
    "the destination is still complete and readable after the source is gone",
    !!bAfter.camera && !!bAfter.lighting && bAfter.blocking.length === 2,
  );
} catch (e) {
  check(
    "the suite ran to completion",
    false,
    `${(e as Error).message.slice(0, 400)} ${(e as Error).stack?.split("\n").find((l) => l.includes("db-setup-copy")) ?? ""}`,
  );
} finally {
  for (const id of created.shotIds)
    await pool.query("delete from shots where id = $1", [id]).catch(() => undefined);
  // every setup row the suite made is on its private Location: deleting it cascades to them (nothing else is touched)
  for (const s of restoreShotLocations)
    await pool
      .query("update shots set location_id = $2 where id = $1", [s.id, s.location_id])
      .catch(() => undefined);
  for (const id of created.projectIds)
    await pool.query("delete from projects where id = $1", [id]).catch(() => undefined);
  for (const id of created.locationIds)
    await pool.query("delete from locations where id = $1", [id]).catch(() => undefined);
}

const leftover = await pool.query(
  `select (select count(*)::int from locations where name like 'db:setup-copy%') as locations,
          (select count(*)::int from projects where title like 'db:setup-copy%') as projects,
          (select count(*)::int from shots where shot_code = 'ZZ-setup-copy') as shots`,
);
const l = leftover.rows[0];
check("cleanup left no test rows", l.locations === 0 && l.projects === 0 && l.shots === 0, JSON.stringify(l));

let failed = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await pool.end();
process.exit(failed ? 1 : 0);
