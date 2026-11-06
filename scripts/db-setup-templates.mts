// Integration tests for Phase 4D-I2 named setup templates and copy provenance against a REAL PostgreSQL database at
// migration 0050 (shot_setup_templates, shot_setup_copies).
//   npm run db:setup-templates
//
// Exercises with real rows (removed afterwards): structure, RLS, real-statement grants (owner, stranger, anon, both
// worker roles), the guard trigger, every shape constraint, append-only provenance, deletion semantics (a template or
// source Shot deleted -> provenance pointer nulled, snapshot kept, no Shot row touched), snapshot and apply independence,
// stale reviews, ATOMICITY under an injected fault, the set-compatibility rule and cross-Project refusal.
// Requires `npm run db:seed` first (uses the demo project). No provider call.
// Phase 4D-I2 ran it on a DISPOSABLE local database only (docs/local-supabase.md); 0050 is not applied to hosted DEV.
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
import { templateAsSetupRows } from "../src/domain/previs/setup-template";
import { bookmarkCameraFingerprint } from "../src/domain/previs/spatial-passes";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({ mode: "Setup template integration tests (rows created, then removed)", devOwner: dev.id });
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
const sqlErr = (sql: string, params: unknown[] = []) =>
  pool.query(sql, params).then(
    () => null as string | null,
    (e: Error) => e.message,
  );
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

const admin = new AdminRepository(pool, dev.id);
const ownerPre = rlsPreamble({ sub: dev.id });
const strangerPre = rlsPreamble({ sub: randomUUID() });
const owner = new PostgresPrevisData(pool, ownerPre);
const stranger = new PostgresPrevisData(pool, strangerPre);

/** A pool whose clients fail the first blocking write: proves the whole template copy (and its record) rolls back. */
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
const faulty = new PostgresPrevisData(faultyPool, ownerPre);

const created = { locationIds: [] as string[], shotIds: [] as string[], projectIds: [] as string[] };
let restoreShotLocations: Array<{ id: string; location_id: string | null }> = [];

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
const templateJson = async (id: string) =>
  JSON.stringify(
    (await pool.query("select to_jsonb(t) r from shot_setup_templates t where id = $1", [id])).rows,
  );
const copiesOf = async (shotId: string) =>
  (await pool.query("select * from shot_setup_copies where shot_id = $1 order by copied_at, id", [shotId]))
    .rows;

try {
  const ledger = await pool.query("select max(name) m from prism_migrations");
  if (ledger.rows[0].m !== "0050_shot_setup_templates.sql")
    throw new Error(`this suite needs migration 0050 (head is ${ledger.rows[0].m})`);
  const data = (await admin.loadProject("ojousama"))!;
  const projectId = data.project.id;
  const [src0, dst0] = [
    data.shots.find((s) => s.shotCode === "2A")!,
    data.shots.find((s) => s.shotCode === "2B")!,
  ];
  const [c1, c2] = data.characters;
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

  // ── 1. structure, RLS, grants ──
  const rls = await pool.query(
    "select relname, relrowsecurity from pg_class where relname in ('shot_setup_templates', 'shot_setup_copies') order by 1",
  );
  check(
    "both tables exist with row-level security",
    rls.rowCount === 2 && rls.rows.every((r) => r.relrowsecurity === true),
  );
  const pols = await pool.query(
    "select tablename, cmd from pg_policies where tablename in ('shot_setup_templates', 'shot_setup_copies') order by 1, 2",
  );
  check(
    "policies: templates ALL (owner); copies SELECT + INSERT only (append-only)",
    JSON.stringify(pols.rows.map((p) => `${p.tablename}:${p.cmd}`)) ===
      JSON.stringify(["shot_setup_copies:INSERT", "shot_setup_copies:SELECT", "shot_setup_templates:ALL"]),
    JSON.stringify(pols.rows),
  );
  const definers = await pool.query(
    "select count(*)::int n from pg_proc where prosecdef and proname = 'guard_shot_setup_template'",
  );
  check("the guard is not SECURITY DEFINER", definers.rows[0].n === 0);
  const idx = await pool.query(
    "select indexname from pg_indexes where tablename in ('shot_setup_templates', 'shot_setup_copies') order by 1",
  );
  const idxNames = idx.rows.map((r) => r.indexname as string);
  check(
    "the expected indexes exist",
    [
      "shot_setup_templates_location_idx",
      "shot_setup_templates_scene_idx",
      "shot_setup_templates_source_shot_idx",
      "shot_setup_copies_shot_idx",
      "shot_setup_copies_template_idx",
      "shot_setup_copies_source_shot_idx",
    ].every((n) => idxNames.includes(n)),
    JSON.stringify(idxNames),
  );
  const privs = async (role: string, table: string) =>
    (
      await pool.query(
        `select has_table_privilege($1, $2, 'select') s, has_table_privilege($1, $2, 'insert') i,
                has_table_privilege($1, $2, 'update') u, has_table_privilege($1, $2, 'delete') d`,
        [role, `public.${table}`],
      )
    ).rows[0] as { s: boolean; i: boolean; u: boolean; d: boolean };
  const tAuth = await privs("authenticated", "shot_setup_templates");
  check("authenticated holds the four privileges on templates", tAuth.s && tAuth.i && tAuth.u && tAuth.d);
  const cAuth = await privs("authenticated", "shot_setup_copies");
  check("authenticated holds only select + insert on copies", cAuth.s && cAuth.i && !cAuth.u && !cAuth.d);
  for (const role of ["anon", "prism_generation_worker", "prism_continuity_worker"])
    for (const table of ["shot_setup_templates", "shot_setup_copies"]) {
      const p = await privs(role, table);
      check(`${role} holds no privilege on ${table}`, !p.s && !p.i && !p.u && !p.d);
      const pre = role === "anon" ? rlsPreamble(null, "anon") : `begin; set local role ${role}`;
      const r = await raw(pre, `select * from ${table}`);
      check(
        `${role} is denied a real read of ${table}`,
        /permission denied/.test(r.error ?? ""),
        r.error ?? "",
      );
    }
  const ownerUpd = await raw(ownerPre, "update shot_setup_copies set plan_token = plan_token");
  const ownerDel = await raw(ownerPre, "delete from shot_setup_copies");
  check(
    "even the owner cannot update or delete provenance (append-only by privilege)",
    /permission denied/.test(ownerUpd.error ?? "") && /permission denied/.test(ownerDel.error ?? ""),
    `${ownerUpd.error} / ${ownerDel.error}`,
  );

  // ── fixtures: a private set, both Shots on it, a temporary third Shot, an empty second Location ──
  const loc = randomUUID();
  const loc2 = randomUUID();
  for (const [id, name] of [
    [loc, "db:setup-templates set location"],
    [loc2, "db:setup-templates other location"],
  ] as const) {
    await pool.query(
      "insert into locations (id, project_id, name, description, geography) values ($1,$2,$3,'','')",
      [id, projectId, name],
    );
    created.locationIds.push(id);
  }
  const tmpShot = randomUUID();
  await pool.query(
    `insert into shots select (jsonb_populate_record(null::shots,
       to_jsonb(s) || jsonb_build_object('id', $2::uuid, 'shot_code', 'ZZ-setup-tpl'))).* from shots s where id = $1`,
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
  const anchor = { ...set, sceneRevision: scene.revision, sceneFingerprint: scene.sceneFingerprint };
  const give = async (shot: typeof SRC, x: number) => {
    await owner.setBookmark({
      id: randomUUID(),
      projectId,
      shotId: shot.id,
      ...set,
      userId: dev.id,
      now: now(),
    });
    const rig = await owner.getLightingRigForShot(shot.id);
    await owner.saveLightingRig({
      id: randomUUID(),
      projectId,
      shotId: shot.id,
      ...anchor,
      rig: parseShotLightingRig({
        schema: SHOT_LIGHTING_SCHEMA,
        base: { mode: "replace" },
        lights: [{ ...newShotLight("point", "key"), id: "key", intensity: 10 * x }],
        authoredIntent: authoredLightingIntent(shot),
      }),
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
  const create = (
    repo: PrevisRepository,
    shot: typeof SRC,
    name: string,
    components: SetupComponent[] = [...SETUP_COMPONENTS],
  ) =>
    repo.createSetupTemplate({
      projectId,
      shotId: shot.id,
      ...set,
      name,
      description: "",
      components,
      userId: dev.id,
      now: now(),
    });
  const review = async (
    templateId: string,
    into: typeof SRC,
    components: SetupComponent[] = [...SETUP_COMPONENTS],
  ) => {
    const t = (await owner.getSetupTemplate(templateId))!;
    return planSetupCopy({
      sourceShotId: null,
      template: { id: t.id, revision: t.revision, contentFingerprint: t.contentFingerprint },
      destinationShotId: into.id,
      set,
      source: templateAsSetupRows(t.content, set),
      destination: {
        camera: await owner.getBookmarkForShot(into.id),
        lighting: await owner.getLightingRigForShot(into.id),
        blocking: await owner.listShotBlocking(into.id),
      },
      components,
    });
  };
  const apply = (
    repo: PrevisRepository,
    templateId: string,
    into: typeof SRC,
    token: string,
    over: Record<string, unknown> = {},
  ) =>
    repo.copyTemplateSetup({
      projectId,
      templateId,
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

  // ── 2. constraints and the guard (privileged statements: the shape is enforced by the database itself) ──
  const T = await create(owner, SRC, "db:setup-templates night key");
  const ins = (over: Record<string, string>) => {
    const v: Record<string, string> = {
      name: "'db:setup-templates bad'",
      schema_version: "'prism.setup-template.v1'",
      camera_json: "camera_json",
      lighting_json: "lighting_json",
      blocking_json: "blocking_json",
      revision: "1",
      ...over,
    };
    return sqlErr(
      `insert into shot_setup_templates (project_id, location_id, scene_document_id, schema_version, name, revision,
         camera_json, lighting_json, blocking_json, content_fingerprint)
       select project_id, location_id, scene_document_id, ${v.schema_version}, ${v.name}, ${v.revision},
         ${v.camera_json}, ${v.lighting_json}, ${v.blocking_json}, content_fingerprint
       from shot_setup_templates where id = $1`,
      [T.id],
    );
  };
  check("a well-formed copy of the row inserts", (await ins({ name: "'db:setup-templates ok'" })) === null);
  await pool.query("delete from shot_setup_templates where name = 'db:setup-templates ok'");
  for (const [label, over] of [
    ["an empty name", { name: "''" }],
    ["an untrimmed name", { name: "' db:setup-templates x '" }],
    ["another schema", { schema_version: "'prism.setup-template.v2'" }],
    ["revision 0", { revision: "0" }],
    ["no content at all", { camera_json: "null", lighting_json: "null", blocking_json: "null" }],
    [
      "lighting carrying a Shot's authored text",
      { lighting_json: `jsonb_set(lighting_json, '{rig,authoredIntent}', '{}')` },
    ],
    ["an empty blocking list", { blocking_json: "'[]'::jsonb" }],
    ["a camera without a value", { camera_json: `camera_json - 'value'` }],
    ["a duplicate name on the same set", { name: "'db:setup-templates night key'" }],
  ] as const)
    check(`the database refuses ${label}`, (await ins(over as Record<string, string>)) !== null);
  const moveLoc = await sqlErr(
    "update shot_setup_templates set location_id = $2, revision = revision + 1 where id = $1",
    [T.id, loc2],
  );
  check(
    "the guard refuses moving a template to another Location",
    /cannot move/.test(moveLoc ?? ""),
    moveLoc ?? "",
  );
  const jump = await sqlErr("update shot_setup_templates set revision = revision + 2 where id = $1", [T.id]);
  check("the guard refuses a revision jump", /exactly one/.test(jump ?? ""), jump ?? "");
  const badCopy = await sqlErr(
    `insert into shot_setup_copies (project_id, shot_id, location_id, scene_document_id, source_kind, template_name,
       template_revision, template_content_fingerprint, source_shot_code, components, plan_token)
     values ($1, $2, $3, $4, 'template', 'x', 1, repeat('a', 64), '2A', array['camera'], repeat('a', 64))`,
    [projectId, DST.id, loc, scene.id],
  );
  check("a provenance record naming both a template and a Shot is refused", badCopy !== null);
  const badParts = await sqlErr(
    `insert into shot_setup_copies (project_id, shot_id, location_id, scene_document_id, source_kind, source_shot_code,
       components, plan_token) values ($1, $2, $3, $4, 'shot', '2A', array['sound'], repeat('a', 64))`,
    [projectId, DST.id, loc, scene.id],
  );
  check("a provenance record naming an unknown part is refused", badParts !== null);

  // ── 3. snapshot independence ──
  check("the template is revision 1 with its source code", T.revision === 1 && T.sourceShotCode === "2A");
  const tBefore = await templateJson(T.id);
  await give(SRC, 4);
  check(
    "editing the source Shot leaves the template byte-for-byte unchanged",
    (await templateJson(T.id)) === tBefore,
  );

  // ── 4. RLS: a stranger sees nothing and changes nothing ──
  check("a stranger lists 0 templates", (await stranger.listSetupTemplates(projectId, loc)).length === 0);
  check("a stranger reads no template", (await stranger.getSetupTemplate(T.id)) === null);
  const sCreate = await err(() => create(stranger, SRC, "db:setup-templates stranger"));
  check("a stranger cannot create a template", sCreate !== null, sCreate ?? "");
  const sRename = await err(() =>
    stranger.updateSetupTemplate({
      projectId,
      templateId: T.id,
      expectedRevision: 1,
      name: "hijack",
      now: now(),
    }),
  );
  check(
    "a stranger's rename gets the same answer as a missing template",
    sRename === "That template no longer exists.",
    sRename ?? "",
  );
  const sDelete = await err(() =>
    stranger.deleteSetupTemplate({ projectId, templateId: T.id, expectedRevision: 1 }),
  );
  check(
    "a stranger's delete gets the same answer",
    sDelete === "That template no longer exists.",
    sDelete ?? "",
  );
  const sRaw = await raw(
    strangerPre,
    "update shot_setup_templates set name = 'x', revision = revision + 1 where id = $1",
    [T.id],
  );
  check("a stranger's raw update touches 0 rows", sRaw.rowCount === 0 && !sRaw.error, sRaw.error ?? "");
  const sIns = await raw(
    strangerPre,
    `insert into shot_setup_copies (project_id, shot_id, location_id, scene_document_id, source_kind, source_shot_code,
       components, plan_token) values ($1, $2, $3, $4, 'shot', '2A', array['camera'], repeat('a', 64))`,
    [projectId, DST.id, loc, scene.id],
  );
  check(
    "a stranger cannot write provenance into the owner's Project",
    /row-level security/.test(sIns.error ?? ""),
    sIns.error ?? "",
  );
  check("the template is unchanged after the stranger", (await templateJson(T.id)) === tBefore);
  const plan0 = await review(T.id, DST);
  const dst0Json = await rowsJson(DST.id);
  const sApply = await err(() => apply(stranger, T.id, DST, plan0.token));
  check("a stranger cannot apply the owner's template", sApply !== null, sApply ?? "");
  const otherProject = randomUUID();
  await pool.query(
    `insert into projects select (jsonb_populate_record(null::projects, to_jsonb(p) ||
       jsonb_build_object('id', $2::uuid, 'slug', 'db-setup-tpl-' || left($2::text, 8), 'title', 'db:setup-templates other'))).*
     from projects p where id = $1`,
    [projectId, otherProject],
  );
  created.projectIds.push(otherProject);
  const cross = await err(() => apply(owner, T.id, DST, plan0.token, { projectId: otherProject }));
  check("a copy naming another Project is refused", cross !== null, cross ?? "");
  const crossGet = await err(() =>
    owner.updateSetupTemplate({
      projectId: otherProject,
      templateId: T.id,
      expectedRevision: 1,
      name: "x",
      now: now(),
    }),
  );
  check(
    "another Project cannot address the template (same answer as missing)",
    crossGet === "That template no longer exists.",
    crossGet ?? "",
  );
  check(
    "nothing was written by the refused copies",
    (await rowsJson(DST.id)) === dst0Json && (await copiesOf(DST.id)).length === 0,
  );

  // ── 5. atomicity, stale review, set compatibility ──
  const fault = await err(() => apply(faulty, T.id, DST, plan0.token));
  check("the injected fault surfaces", fault === "injected fault", fault ?? "");
  check(
    "after the fault: no camera, no lighting, no provenance record",
    (await rowsJson(DST.id)) === dst0Json && (await copiesOf(DST.id)).length === 0,
  );
  const stale = await err(() => apply(owner, T.id, DST, "0".repeat(64)));
  check(
    "a token other than the reviewed one is refused",
    /changed after you reviewed/.test(stale ?? ""),
    stale ?? "",
  );
  await pool.query("update shots set location_id = $2 where id = $1", [DST.id, loc2]);
  const elsewhere = await err(() => apply(owner, T.id, DST, plan0.token, { locationId: loc2 }));
  await pool.query("update shots set location_id = $2 where id = $1", [DST.id, loc]);
  check(
    "a template is refused on another Location",
    /another 3D set|3D set was not found/.test(elsewhere ?? ""),
    elsewhere ?? "",
  );
  check("the refused copies wrote nothing", (await rowsJson(DST.id)) === dst0Json);

  // ── 6. the copy: own rows, native fingerprints, a provenance record ──
  const out = await apply(owner, T.id, DST, plan0.token);
  const a = await owner.getSetupTemplate(T.id);
  const b = {
    camera: await owner.getBookmarkForShot(DST.id),
    lighting: await owner.getLightingRigForShot(DST.id),
    blocking: await owner.listShotBlocking(DST.id),
  };
  check("the copy wrote all three parts", !!out.camera && !!out.lighting && out.blocking?.length === 2);
  check(
    "the destination's rows are its own, with the template's values",
    b.camera!.shotId === DST.id &&
      bookmarkCameraFingerprint(b.camera!.value) === bookmarkCameraFingerprint(a!.content.camera!.value) &&
      b.lighting!.lightingFingerprint === templateAsSetupRows(a!.content, set).lighting!.lightingFingerprint,
  );
  check(
    "lighting keeps the destination's own authored notes",
    JSON.stringify(b.lighting!.rig.authoredIntent) === JSON.stringify(authoredLightingIntent(DST)),
  );
  const [rec] = await copiesOf(DST.id);
  check(
    "one provenance record: template, name, revision, content fingerprint, parts, reviewed token",
    rec?.source_kind === "template" &&
      rec.template_id === T.id &&
      rec.template_name === T.name &&
      rec.template_revision === 1 &&
      rec.template_content_fingerprint === T.contentFingerprint &&
      JSON.stringify(rec.components) === JSON.stringify(["camera", "lighting", "blocking"]) &&
      rec.plan_token === plan0.token,
    JSON.stringify(rec),
  );

  // ── 7. independence both ways ──
  const dstAfter = await rowsJson(DST.id);
  const r1 = await owner.updateSetupTemplate({
    projectId,
    templateId: T.id,
    expectedRevision: 1,
    name: "db:setup-templates renamed",
    now: now(),
  });
  const r2 = await owner.updateSetupTemplate({
    projectId,
    templateId: T.id,
    expectedRevision: r1.revision,
    contentFrom: { shotId: SRC.id, components: ["lighting"] },
    now: now(),
  });
  check(
    "rename keeps the content fingerprint; replace changes it",
    r1.contentFingerprint === T.contentFingerprint && r2.contentFingerprint !== T.contentFingerprint,
  );
  check(
    "editing the template (rename, new values) never changes the destination",
    (await rowsJson(DST.id)) === dstAfter,
  );
  const tNow = await templateJson(T.id);
  await give(DST, 9);
  check("editing the destination never changes the template", (await templateJson(T.id)) === tNow);
  const staleEdit = await err(() =>
    owner.updateSetupTemplate({ projectId, templateId: T.id, expectedRevision: 1, name: "late", now: now() }),
  );
  check(
    "a stale template edit is refused (compare-and-set)",
    /changed after you reviewed/.test(staleEdit ?? ""),
    staleEdit ?? "",
  );

  // ── 7b. an unreadable template row never blocks anything (hand-edited past the CHECKs, or a later stricter schema) ──
  const bad = await create(owner, SRC, "db:setup-templates unreadable", ["camera"]);
  await pool.query(
    `update shot_setup_templates set camera_json = jsonb_set(camera_json, '{value}', '{}'::jsonb),
       revision = revision + 1 where id = $1`,
    [bad.id],
  );
  const listed = await owner.listSetupTemplates(projectId, loc);
  check(
    "a listing skips the unreadable template and keeps the others",
    !listed.some((t) => t.id === bad.id) && listed.some((t) => t.id === T.id),
  );
  const badGet = await err(() => owner.getSetupTemplate(bad.id));
  check(
    "addressing the unreadable template is refused with a clear message",
    /can no longer be read/.test(badGet ?? ""),
    badGet ?? "",
  );
  const dstBeforeBad = await rowsJson(DST.id);
  const badApply = await err(() => apply(owner, bad.id, DST, plan0.token, { components: ["camera"] }));
  check(
    "applying the unreadable template is refused and writes nothing",
    /can no longer be read/.test(badApply ?? "") && (await rowsJson(DST.id)) === dstBeforeBad,
    badApply ?? "",
  );
  await pool.query("delete from shot_setup_templates where id = $1", [bad.id]);
  const svc = await privs("service_role", "shot_setup_copies");
  check(
    "service_role cannot update or delete provenance either",
    svc.s && svc.i && !svc.u && !svc.d,
    JSON.stringify(svc),
  );

  // ── 8. deletion semantics ──
  await give(TMP, 3);
  const T2 = await create(owner, TMP, "db:setup-templates from tmp", ["camera"]);
  await pool.query("delete from shots where id = $1", [TMP.id]);
  created.shotIds = [];
  const t2 = (await owner.getSetupTemplate(T2.id))!;
  check(
    "deleting the source Shot only nulls the template's pointer (code and values kept, revision unchanged)",
    t2.sourceShotId === null &&
      t2.sourceShotCode === "ZZ-setup-tpl" &&
      t2.revision === 1 &&
      t2.contentFingerprint === T2.contentFingerprint,
  );
  const dstBeforeDelete = await rowsJson(DST.id);
  const cur = (await owner.getSetupTemplate(T.id))!;
  await owner.deleteSetupTemplate({ projectId, templateId: T.id, expectedRevision: cur.revision });
  check("the template is gone", (await owner.getSetupTemplate(T.id)) === null);
  check(
    "deleting the template leaves the destination's rows byte-for-byte intact",
    (await rowsJson(DST.id)) === dstBeforeDelete,
  );
  const [after] = await copiesOf(DST.id);
  check(
    "provenance survives: pointer nulled, name / revision / fingerprint kept",
    after?.template_id === null && after.template_name === T.name && after.template_revision === 1,
    JSON.stringify(after),
  );
} catch (e) {
  check(
    "the suite ran to completion",
    false,
    `${(e as Error).message.slice(0, 400)} ${(e as Error).stack?.split("\n").find((l) => l.includes("db-setup-templates")) ?? ""}`,
  );
} finally {
  for (const id of created.shotIds)
    await pool.query("delete from shots where id = $1", [id]).catch(() => undefined);
  for (const id of created.locationIds)
    await pool.query("delete from shot_setup_copies where location_id = $1", [id]).catch(() => undefined);
  for (const s of restoreShotLocations)
    await pool
      .query("update shots set location_id = $2 where id = $1", [s.id, s.location_id])
      .catch(() => undefined);
  for (const id of created.projectIds)
    await pool.query("delete from projects where id = $1", [id]).catch(() => undefined);
  // templates, rigs, bookmarks and blocking on the private Locations go with them (ON DELETE CASCADE)
  for (const id of created.locationIds)
    await pool.query("delete from locations where id = $1", [id]).catch(() => undefined);
}

const leftover = await pool.query(
  `select (select count(*)::int from locations where name like 'db:setup-templates%') as locations,
          (select count(*)::int from projects where title like 'db:setup-templates%') as projects,
          (select count(*)::int from shots where shot_code = 'ZZ-setup-tpl') as shots,
          (select count(*)::int from shot_setup_templates where name like 'db:setup-templates%') as templates,
          (select count(*)::int from shot_setup_copies c where not exists
             (select 1 from locations l where l.id = c.location_id)) as copies`,
);
const l = leftover.rows[0];
check(
  "cleanup left no test rows",
  l.locations === 0 && l.projects === 0 && l.shots === 0 && l.templates === 0 && l.copies === 0,
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
