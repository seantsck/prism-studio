// Integration tests for Phase 3A.4F (migration 0047: the Sequence policy and the cut settling clocks) against a database
// where 0047 is APPLIED. Before the hosted gate this runs ONLY on a disposable local database (scripts/db-disposable.mjs;
// docs/local-supabase.md).
//   node --env-file=<disposable env> --import tsx scripts/db-sequence-automation.mts
//
// Everything runs in ONE THROWAWAY project (purpose 'test') owned by the dev user, deleted at the end. Exercises: the
// policy columns, defaults, range and automatic constraint, independently of the Shot mode; stale revisions; owner / other
// owner / anon / both worker roles; every settling trigger, direct and through its FK cascade; that a trigger moves ONLY
// the clock; the real repository clock; a transition run's automation key. No provider call; no media.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresCharacterContinuityData } from "../src/data/character-continuity-postgres";
import { PostgresEpisodeEditData } from "../src/data/episode-edit-postgres";
import { PostgresLocationViewData } from "../src/data/location-view-postgres";
import { PostgresMediaQaData } from "../src/data/media-qa-postgres";
import { rlsPreamble } from "../src/data/postgres-repository";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "sequence automation (0047) integration tests (throwaway project, removed afterwards)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 10 });
await assertDevUserExists(pool, dev);
const applied = (
  await pool.query(
    "select 1 from information_schema.columns where table_name = 'project_qa_policies' and column_name = 'sequence_semantic_mode'",
  )
).rowCount;
if (!applied) {
  console.error("Migration 0047 is not applied to this database. Nothing was written.");
  await pool.end();
  process.exit(1);
}

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const id = () => randomUUID();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
const NOW = () => new Date().toISOString();
const stranger = id();

/** One statement in one transaction, committed; the error message, or null. */
async function run(preamble: string, sql: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query(preamble);
    const r = await c.query(sql, params);
    await c.query("commit");
    return { rows: r.rows, rowCount: r.rowCount ?? 0, error: null as string | null };
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    return { rows: [], rowCount: 0, error: (e as Error).message };
  } finally {
    c.release();
  }
}
const owner = rlsPreamble({ sub: dev.id });
const other = rlsPreamble({ sub: stranger });
const anon = rlsPreamble(null, "anon");

const P = id();
const slug = `db-sa-${P.slice(0, 8)}`;
const E = id(),
  S = id(),
  SA = id(),
  SB = id(),
  SC = id(),
  CH = id(),
  CH2 = id(),
  LK = id(),
  LOC = id(),
  LOC2 = id(),
  PR = id(),
  VIEW = id(),
  LOCK = id(),
  IMG = id(),
  IMG2 = id();

/** Puts rows' clocks in the past, bypassing every trigger: only a later write can move them. */
async function age(table: string, ids: string[]) {
  const c = await pool.connect();
  try {
    await c.query("begin; set local session_replication_role = replica");
    await c.query(`update ${table} set updated_at = '2001-01-01' where id = any($1::uuid[])`, [ids]);
    await c.query("commit");
  } finally {
    c.release();
  }
}
const clockOf = async (table: string, rowId: string) =>
  new Date((await q(`select updated_at from ${table} where id = $1`, [rowId])).rows[0].updated_at).getTime();
const OLD = Date.parse("2020-01-01");
const moved = async (table: string, rowId: string) => (await clockOf(table, rowId)) > OLD;
const snapshot = async (table: string, rowId: string) => {
  const r = (await q(`select * from ${table} where id = $1`, [rowId])).rows[0] as Record<string, unknown>;
  return JSON.stringify({ ...r, updated_at: null });
};

const policyInsert = (cols: string, vals: string) =>
  `insert into project_qa_policies (project_id${cols}) values ('${P}'${vals}) on conflict (project_id) do nothing`;
/** A constraint probe: rolled back whatever happens. */
async function probe(preamble: string, sql: string) {
  const c = await pool.connect();
  try {
    await c.query(preamble);
    await c.query("savepoint p");
    await c.query(sql);
    return null as string | null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}
const FULL =
  ", analyzer, external_media_allowed, direct_video_allowed, max_cost_per_run_usd, max_cost_per_day_usd";
const FULL_VALS = ", 'gemini', true, true, 1, 5";

let cleanup = true;
try {
  // ── fixtures ──
  await q("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
    P,
    dev.id,
    slug,
    `db:sa ${slug}`,
  ]);
  await q("insert into project_bibles (project_id) values ($1)", [P]);
  await q("insert into episodes (id, project_id, number, slug, title) values ($1,$2,1,'ep-1','E')", [E, P]);
  await q(
    "insert into scenes (id, project_id, episode_id, scene_number, slugline, int_ext) values ($1,$2,$3,'1','INT. X','INT')",
    [S, P, E],
  );
  await q("insert into characters (id, project_id, name) values ($1,$2,'C'), ($3,$2,'C2')", [CH, P, CH2]);
  await q("insert into character_looks (id, project_id, character_id, name) values ($1,$2,$3,'L')", [
    LK,
    P,
    CH,
  ]);
  await q("insert into locations (id, project_id, name) values ($1,$2,'Loc'), ($3,$2,'Loc2')", [
    LOC,
    P,
    LOC2,
  ]);
  await q("insert into props (id, project_id, name) values ($1,$2,'Prop')", [PR, P]);
  for (const a of [IMG, IMG2])
    await q(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, object_path, mime, checksum, width,
         height, metadata)
       values ($1,$2,'db:sa','image','other','upload','local',$3,'image/png',$4,1024,768,'{}'::jsonb)`,
      [a, P, `${P}/${a}/db-sa.png`, sha(a)],
    );
  for (const [shotId, code, order] of [
    [SA, "1A", 0],
    [SB, "1B", 1],
    [SC, "1C", 2],
  ] as const)
    await q(
      `insert into shots (id, project_id, episode_id, scene_id, shot_code, title, "order", location_id)
       values ($1,$2,$3,$4,$5,'S',$6,$7)`,
      [shotId, P, E, S, code, order, LOC],
    );
  await q("insert into shot_characters (shot_id, character_id, look_id) values ($1,$2,$3)", [SA, CH, LK]);
  await q("insert into shot_props (shot_id, prop_id) values ($1,$2)", [SA, PR]);

  const viewInsert = (viewId: string) =>
    q(
      `insert into location_views (id, project_id, location_id, schema_version, name, kind, asset_id, asset_checksum, width,
         height, source, view_spec, view_fingerprint)
       values ($1,$2,$3,'prism.location-view.v1','V','detail',$4,$5,1024,768,'upload',
         jsonb_build_object('schema','prism.location-view-spec.v1','name','V','kind','detail'),$6)`,
      [viewId, P, LOC, IMG, sha(IMG), sha(viewId)],
    );
  await viewInsert(VIEW);
  const selectView = (shotId: string, viewId: string) =>
    q(
      `insert into shot_location_view_selections (shot_id, project_id, location_view_id, location_id) values ($1,$2,$3,$4)
       on conflict (shot_id) do update set location_view_id = excluded.location_view_id`,
      [shotId, P, viewId, LOC],
    );
  // a Lock needs its member rows at commit; only this selection's delete is under test, so its checks are bypassed once
  const c = await pool.connect();
  try {
    await c.query("begin; set local session_replication_role = replica");
    await c.query(
      `insert into character_continuity_locks (id, project_id, character_id, source_look_id, schema_version, name,
         facts_snapshot, reference_count, lock_fingerprint)
       values ($1,$2,$3,$4,'prism.character-continuity-lock.v1','Lock',
         jsonb_build_object('schema','prism.character-continuity-facts.v1','characterId',$6::text,'sourceLookId',$7::text,
           'look', '{}'::jsonb), 0, $5)`,
      [LOCK, P, CH, LK, sha(LOCK), CH, LK],
    );
    await c.query("commit");
  } finally {
    c.release();
  }
  const selectLock = () =>
    q(
      `insert into shot_character_continuity_selections (shot_id, character_id, project_id, continuity_lock_id)
       values ($1,$2,$3,$4) on conflict (shot_id, character_id) do nothing`,
      [SA, CH, P, LOCK],
    );

  // ───────────────────────── the policy columns ─────────────────────────
  await q(policyInsert("", ""));
  const row = (await q("select * from project_qa_policies where project_id = $1", [P])).rows[0];
  check("policy: an existing row reads sequence mode off", row.sequence_semantic_mode === "off");
  check("policy: the batch cap defaults to 20", row.max_transitions_per_batch === 20);
  check("policy: Shot mode stays off", row.semantic_mode === "off");
  await q("delete from project_qa_policies where project_id = $1", [P]);

  const refused = (r: string | null, re: RegExp) => r !== null && re.test(r);
  for (const [name, sql, re] of [
    [
      "mode only accepts off / suggest / automatic",
      policyInsert(", sequence_semantic_mode", ", 'always'"),
      /sequence_semantic_mode/,
    ],
    [
      "batch cap 0 is rejected",
      policyInsert(", max_transitions_per_batch", ", 0"),
      /max_transitions_per_batch/,
    ],
    [
      "batch cap 21 is rejected",
      policyInsert(", max_transitions_per_batch", ", 21"),
      /max_transitions_per_batch/,
    ],
    [
      "automatic without an analyzer is rejected",
      policyInsert(
        ", sequence_semantic_mode, external_media_allowed, direct_video_allowed, max_cost_per_run_usd, max_cost_per_day_usd",
        ", 'automatic', true, true, 1, 5",
      ),
      /sequence_automatic_is_explicit/,
    ],
    [
      "automatic without external-media permission is rejected",
      policyInsert(
        ", sequence_semantic_mode, analyzer, direct_video_allowed, max_cost_per_run_usd, max_cost_per_day_usd",
        ", 'automatic', 'gemini', true, 1, 5",
      ),
      /sequence_automatic_is_explicit/,
    ],
    [
      "automatic without direct-video permission is rejected",
      policyInsert(
        ", sequence_semantic_mode, analyzer, external_media_allowed, max_cost_per_run_usd, max_cost_per_day_usd",
        ", 'automatic', 'gemini', true, 1, 5",
      ),
      /sequence_automatic_is_explicit/,
    ],
    [
      "automatic without a per-run ceiling is rejected",
      policyInsert(
        ", sequence_semantic_mode, analyzer, external_media_allowed, direct_video_allowed, max_cost_per_day_usd",
        ", 'automatic', 'gemini', true, true, 5",
      ),
      /sequence_automatic_is_explicit/,
    ],
    [
      "automatic without a daily ceiling is rejected",
      policyInsert(
        ", sequence_semantic_mode, analyzer, external_media_allowed, direct_video_allowed, max_cost_per_run_usd",
        ", 'automatic', 'gemini', true, true, 1",
      ),
      /sequence_automatic_is_explicit/,
    ],
    [
      "automatic with a NaN ceiling is rejected",
      policyInsert(`, sequence_semantic_mode${FULL}`, ", 'automatic', 'gemini', true, true, 'NaN', 'NaN'"),
      /sequence_automatic_is_explicit/,
    ],
  ] as const)
    check(`policy: ${name}`, refused(await probe("begin", sql), re));

  check(
    "policy: Sequence automatic is allowed while Shot automatic is off",
    (await probe("begin", policyInsert(`, sequence_semantic_mode${FULL}`, `, 'automatic'${FULL_VALS}`))) ===
      null,
  );
  const shotOnly = await run(
    "begin",
    `insert into project_qa_policies (project_id, semantic_mode, analyzer, external_media_allowed, max_cost_per_run_usd,
       max_cost_per_day_usd) values ($1,'automatic','gemini',true,1,5) returning sequence_semantic_mode`,
    [P],
  );
  check(
    "policy: Shot automatic does not enable Sequence automatic, and needs no video permission",
    shotOnly.rows[0]?.sequence_semantic_mode === "off",
    shotOnly.error ?? "",
  );
  await q("delete from project_qa_policies where project_id = $1", [P]);

  // the real repository: owner save, stale revision, the mapping
  const qa = new PostgresMediaQaData(pool, owner);
  check("repository: sequenceAutomationReady is true after 0047", await qa.sequenceAutomationReady());
  const policy = {
    semanticMode: "off" as const,
    analyzer: "gemini",
    externalMediaAllowed: true,
    maxCostPerRunUsd: 1,
    maxCostPerDayUsd: 5,
    directVideoAllowed: true,
    sequenceSemanticMode: "automatic" as const,
    maxTransitionsPerBatch: 7,
  };
  const saved = await qa.saveQaPolicy({
    projectId: P,
    policy,
    expectedRevision: 0,
    by: dev.id,
    now: NOW(),
  });
  check(
    "repository: the owner saves and reads the Sequence policy",
    saved.sequenceSemanticMode === "automatic" &&
      saved.maxTransitionsPerBatch === 7 &&
      saved.semanticMode === "off",
  );
  const stale = await qa
    .saveQaPolicy({
      projectId: P,
      policy: { ...policy, maxTransitionsPerBatch: 3 },
      expectedRevision: 0,
      by: dev.id,
      now: NOW(),
    })
    .then(
      () => "saved",
      (e: { code?: string }) => e.code,
    );
  const after = await qa.getQaPolicy(P);
  check(
    "repository: a stale revision writes nothing",
    stale === "conflict" && after.maxTransitionsPerBatch === 7 && after.revision === 1,
    String(stale),
  );

  // ───────────────────────── security ─────────────────────────
  const read = "select sequence_semantic_mode from project_qa_policies";
  const write = "update project_qa_policies set max_transitions_per_batch = 2";
  check("security: the owner reads", (await run(owner, read)).rowCount === 1);
  check("security: the owner writes", (await run(owner, `${write} returning 1`)).rowCount === 1);
  await q("update project_qa_policies set max_transitions_per_batch = 7 where project_id = $1", [P]);
  check("security: another owner reads nothing", (await run(other, read)).rowCount === 0);
  check("security: another owner writes nothing", (await run(other, `${write} returning 1`)).rowCount === 0);
  const denied = (r: { error: string | null }) => /permission denied/.test(r.error ?? "");
  check("security: anon cannot read", denied(await run(anon, read)));
  check("security: anon cannot write", denied(await run(anon, write)));
  for (const role of ["prism_generation_worker", "prism_continuity_worker"]) {
    check(`security: ${role} cannot read`, denied(await run(`begin; set local role ${role}`, read)));
    check(`security: ${role} cannot write`, denied(await run(`begin; set local role ${role}`, write)));
  }
  for (const [key, label] of [
    ["PRISM_STUDIO_WORKER_DB_URL", "generation"],
    ["PRISM_STUDIO_CONTINUITY_DB_URL", "continuity"],
  ] as const) {
    if (!process.env[key]) continue;
    const w = new pg.Pool({ connectionString: process.env[key], ssl: { rejectUnauthorized: false }, max: 1 });
    const err = await w.query(read).then(
      () => "allowed",
      (e: Error) => e.message,
    );
    await w.end();
    check(
      `security: the real ${label} worker login cannot read the policy`,
      /permission denied/.test(err),
      err,
    );
  }

  // ───────────────────────── settling clocks ─────────────────────────
  const views = new PostgresLocationViewData(pool, owner);
  const locks = new PostgresCharacterContinuityData(pool, owner);

  await selectView(SA, VIEW);
  await age("shots", [SA, SB]);
  await views.clearForShot({ projectId: P, shotId: SA });
  check("clock: clearing a View selection (direct) moves the Shot's clock", await moved("shots", SA));
  check("clock: …and no other Shot's", !(await moved("shots", SB)));

  const VIEW2 = id();
  await viewInsert(VIEW2);
  await selectView(SA, VIEW2);
  await age("shots", [SA]);
  await q("delete from location_views where id = $1", [VIEW2]);
  check(
    "clock: deleting a selected Location View (cascade) moves the Shot's clock",
    await moved("shots", SA),
  );

  await selectView(SA, VIEW);
  await age("shots", [SA]);
  const nested = await run("begin", "update shots set location_id = $2 where id = $1", [SA, LOC2]);
  check(
    "clock: a Shot moved to another Location clears the selection through 0040's trigger, without a trigger conflict",
    nested.error === null &&
      (await q("select 1 from shot_location_view_selections where shot_id = $1", [SA])).rowCount === 0,
    nested.error ?? "",
  );
  await q("update shots set location_id = $2 where id = $1", [SA, LOC]);

  await selectLock();
  await age("shots", [SA]);
  await locks.clearForAssignment({ projectId: P, shotId: SA, characterId: CH });
  check("clock: clearing a Lock selection (direct) moves the Shot's clock", await moved("shots", SA));

  await selectLock();
  await age("shots", [SA]);
  const before = await snapshot("shots", SA);
  await q("delete from character_continuity_locks where id = $1", [LOCK]);
  check("clock: deleting a selected Lock (cascade) moves the Shot's clock", await moved("shots", SA));
  check(
    "trigger: moves only the clock; the Shot's every other column is unchanged",
    (await snapshot("shots", SA)) === before,
  );

  await age("shots", [SA]);
  await q("delete from shot_props where shot_id = $1 and prop_id = $2", [SA, PR]);
  check("clock: removing a Prop from a Shot (direct) moves the Shot's clock", await moved("shots", SA));

  await q("insert into shot_props (shot_id, prop_id) values ($1,$2)", [SA, PR]);
  await age("shots", [SA, SB]);
  const ownerDelete = await run(owner, "delete from props where id = $1", [PR]);
  check(
    "clock: deleting a Prop as the owner (cascade) moves the Shot's clock",
    ownerDelete.error === null && (await moved("shots", SA)) && !(await moved("shots", SB)),
    ownerDelete.error ?? "",
  );

  const REF = id();
  await age("characters", [CH, CH2]);
  const insertRef = await run(
    owner,
    "insert into character_identity_refs (id, project_id, character_id, slot, asset_id) values ($1,$2,$3,'front',$4)",
    [REF, P, CH, IMG2],
  );
  check(
    "clock: inserting an identity reference as the owner moves the Character's clock",
    insertRef.error === null && (await moved("characters", CH)) && !(await moved("characters", CH2)),
    insertRef.error ?? "",
  );
  await age("characters", [CH]);
  const beforeChar = await snapshot("characters", CH);
  await run(owner, "update character_identity_refs set label = 'x' where id = $1", [REF]);
  check("clock: updating an identity reference moves the Character's clock", await moved("characters", CH));
  check(
    "trigger: moves only the clock; the Character's every other column is unchanged",
    (await snapshot("characters", CH)) === beforeChar,
  );
  await age("characters", [CH, CH2]);
  await q("update character_identity_refs set character_id = $2 where id = $1", [REF, CH2]);
  check(
    "clock: moving an identity reference moves both Characters' clocks",
    (await moved("characters", CH)) && (await moved("characters", CH2)),
  );
  await q("update character_identity_refs set character_id = $2 where id = $1", [REF, CH]);
  await age("characters", [CH]);
  await q("delete from assets where id = $1", [IMG2]);
  check(
    "clock: deleting an identity reference's Asset (set null) moves the Character's clock",
    (await moved("characters", CH)) &&
      (await q("select asset_id from character_identity_refs where id = $1", [REF])).rows[0].asset_id ===
        null,
  );
  await age("characters", [CH]);
  await q("delete from character_identity_refs where id = $1", [REF]);
  check("clock: deleting an identity reference moves the Character's clock", await moved("characters", CH));

  const denyWorker = await run(
    "begin; set local role prism_continuity_worker",
    "delete from shot_props where shot_id = $1",
    [SA],
  );
  check(
    "security: a worker role cannot fire these triggers (no write grant)",
    denied(denyWorker),
    denyWorker.error ?? "",
  );

  // ───────────────────────── the repository clock ─────────────────────────
  const edits = new PostgresEpisodeEditData(pool, owner);
  const edit = await edits.create({
    projectId: P,
    episodeId: E,
    editRate: { num: 24, den: 1 },
    items: [SA, SB, SC].map((shotId) => ({
      shotId,
      visual: { kind: "none" as const, durationMs: 2000 },
      performance: [],
      performanceBasis: null,
    })),
    userId: dev.id,
    now: NOW(),
  });
  const [IA, IB, IC] = edit.items.map((i) => i.id) as [string, string, string];
  await age("episode_edit_items", [IA, IB, IC]);
  const clock1 = await edits.getCutSettlementClock(P, edit.id);
  check(
    "repository clock: names the edit's items and the Project's rows",
    Boolean(
      clock1.items[IA] && clock1.items[IC] && clock1.shots[SA] && clock1.characters[CH] && clock1.looks[LK],
    ) && Boolean(clock1.locations[LOC] && clock1.assets[IMG]),
  );
  const edit1 = await edits.apply({
    projectId: P,
    editId: edit.id,
    expectedRevision: edit.revision,
    ops: [{ op: "set_hold", itemId: IA, durationMs: 3000 }],
    userId: dev.id,
    now: NOW(),
  });
  const clock2 = await edits.getCutSettlementClock(P, edit.id);
  check(
    "repository clock: editing one item moves only that item, though the edit's revision moved",
    edit1.revision === edit.revision + 1 &&
      clock2.items[IA] !== clock1.items[IA] &&
      clock2.items[IB] === clock1.items[IB] &&
      clock2.items[IC] === clock1.items[IC],
    JSON.stringify([clock1.items, clock2.items]),
  );
  await age("episode_edit_items", [IA, IB, IC]);
  const clock3 = await edits.getCutSettlementClock(P, edit.id);
  await edits.apply({
    projectId: P,
    editId: edit.id,
    expectedRevision: edit1.revision,
    ops: [{ op: "reorder", itemIds: [IB, IA, IC] }],
    userId: dev.id,
    now: NOW(),
  });
  const clock4 = await edits.getCutSettlementClock(P, edit.id);
  check(
    "repository clock: a reorder moves exactly the shifted items",
    clock4.items[IA] !== clock3.items[IA] &&
      clock4.items[IB] !== clock3.items[IB] &&
      clock4.items[IC] === clock3.items[IC],
  );

  // ───────────────────────── automatic run identity ─────────────────────────
  const transitionRun = (runId: string, n: number, key: string | null) =>
    `insert into continuity_runs (id, project_id, subject_kind, run_number, analyzer, analyzer_version, analyzer_kind,
       rules_version, analysis_status, package_fingerprint, subject_fingerprint, criteria_fingerprint,
       reference_fingerprint, automation_key)
     values ('${runId}', '${P}', 'transition', ${n}, 'mock', 'mock-sequence-1', 'mock', '3a.4', 'queued', 'pk', 'sf', 'cf',
       'rf', ${key ? `'${key}'` : "null"})`;
  const subject = (runId: string, n: number) =>
    `insert into continuity_transition_subjects (run_id, project_id, edit_id, episode_id, edit_revision, transition_key,
       run_number, left_item_id, right_item_id, left_shot_id, right_shot_id, left_side, right_side, crosses_scene)
     values ('${runId}', '${P}', '${edit.id}', '${E}', 0, '${sha("k")}', ${n}, '${IA}', '${IB}', '${SA}', '${SB}',
       '{"version":"cut-side-snapshot-v1","side":"left"}', '{"version":"cut-side-snapshot-v1","side":"right"}', false)`;
  const both = async (n: number, key: string | null) => {
    const runId = id();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(transitionRun(runId, n, key));
      await client.query(subject(runId, n));
      await client.query("commit");
      return null;
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      return (e as Error).message;
    } finally {
      client.release();
    }
  };
  const KEY = sha("auto-sequence-key");
  check("identity: a manual transition run has no automation key", (await both(1, null)) === null);
  check("identity: an automatic transition run stores its key", (await both(2, KEY)) === null);
  check(
    "identity: the existing unique index gives ONE automatic run per key, without a new column",
    /continuity_runs_automation_key/.test((await both(3, KEY)) ?? ""),
  );
  const attemptKeyed = await q(
    "select count(*)::int as n from continuity_runs where project_id = $1 and subject_kind = 'attempt' and automation_key = $2",
    [P, KEY],
  );
  check("identity: a transition automation key is never an attempt run", attemptKeyed.rows[0].n === 0);
} finally {
  if (cleanup) {
    await q("delete from projects where id = $1", [P]).catch((e: Error) =>
      check("cleanup", false, e.message),
    );
    const left = (await q("select count(*)::int as n from projects where id = $1", [P])).rows[0].n;
    check(
      "cleanup: deleting the Project cascades through the triggers, leaving nothing",
      left === 0,
      String(left),
    );
    cleanup = false;
  }
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await pool.end();
process.exit(failed ? 1 : 0);
