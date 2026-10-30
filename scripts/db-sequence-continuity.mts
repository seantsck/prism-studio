// Integration tests for Phase 3A.4C (migration 0046: transition subjects, subject kinds, persisted cut intent) against
// a database where 0046 is APPLIED. Before the hosted gate this runs ONLY on a disposable local database
// (scripts/db-disposable.mjs; docs/local-supabase.md): 0046 is not applied to hosted until a separate gate.
//   npm run db:sequence-continuity
//
// Everything runs in ONE THROWAWAY project (purpose 'test') owned by the dev user, deleted at the end. Exercises:
// structure, explicit grants and owner-only RLS on continuity_transition_subjects (owner / stranger / anon / both
// worker roles); the run / job subject-kind invariants (shape checks, the kind-aware keys, the deferred exactly-one
// subject rule, run-number agreement, cascade, immutability); EVERY field the run and job guards froze before 0046
// still frozen, plus subject_kind; the Postgres transition repository (numbering per transition, history, refusals,
// concurrency, historical ids surviving edit changes and edit deletion); Shot-query isolation (attempt history,
// latest runs, numbering, jobs, automatic coverage, the worker's claim, asset pins); persisted cut intent (database
// validation, the deferred predecessor rule, the repository clearing an obsolete intent, revision behaviour).
// No provider call; no media.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresAnalysisWorkerStore } from "../src/data/continuity-analysis-postgres";
import { PostgresEpisodeEditData } from "../src/data/episode-edit-postgres";
import { EpisodeEditError, type EditOp } from "../src/data/episode-edit-repository";
import { PostgresMediaQaData } from "../src/data/media-qa-postgres";
import { MediaQaError, type NewRun } from "../src/data/media-qa-repository";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { newTransitionRun, recordTransitionRun } from "../src/continuity/sequence-runs";
import { buildEpisodeCuts } from "../src/domain/continuity/sequence";
import type { EpisodeEdit } from "../src/domain/edit/model";
import { buildEpisodeEditView } from "../src/domain/edit/view";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "sequence continuity (0046) integration tests (throwaway project, removed afterwards)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 10 });
await assertDevUserExists(pool, dev);
const applied = (await pool.query("select to_regclass('public.continuity_transition_subjects') as t")).rows[0]
  .t;
if (!applied) {
  console.error(
    "Migration 0046 is not applied to this database; db:sequence-continuity needs it. Nothing was written.",
  );
  await pool.end();
  process.exit(1);
}

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const stranger = randomUUID();
const NOW = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const id = () => randomUUID();
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
const media = { attempts: new Map(), bestPointers: [] };

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
const asRole = (role: string, sql: string, p: unknown[] = []) => raw(`begin; set local role ${role}`, sql, p);
/** Statements in ONE transaction, COMMITTED (deferred rules run at commit); null = success. */
async function commit(preamble: string, statements: Array<[string, unknown[]]>): Promise<string | null> {
  const c = await pool.connect();
  try {
    await c.query(preamble);
    for (const [sql, params] of statements) await c.query(sql, params);
    await c.query("commit");
    return null;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    return (e as Error).message;
  } finally {
    c.release();
  }
}
const ownerCommit = (s: Array<[string, unknown[]]>) => commit(rlsPreamble({ sub: dev.id }), s);
const adminCommit = (s: Array<[string, unknown[]]>) => commit("begin", s);
const refused = (r: string | null, pattern?: RegExp) => r !== null && (!pattern || pattern.test(r));

const P = id();
const slug = `db-sc-${P.slice(0, 8)}`;
const E1 = id(),
  S1 = id(),
  SA = id(),
  SB = id(),
  SC = id(),
  ATT = id(),
  ASSET = id(),
  ASSET2 = id();

const qa = new PostgresMediaQaData(pool, rlsPreamble({ sub: dev.id }));
const strangerQa = new PostgresMediaQaData(pool, rlsPreamble({ sub: stranger }));
const edits = new PostgresEpisodeEditData(pool, rlsPreamble({ sub: dev.id }));
const admin = new AdminRepository(pool, dev.id);

/** Raw run columns for an attempt run (as the owner would insert them). */
const attemptRunSql = (runId: string, n: number, extra = "") =>
  `insert into continuity_runs (id, project_id, attempt_id, run_number, subject_asset_id, analyzer, analyzer_version,
     analyzer_kind, rules_version, package_fingerprint, subject_fingerprint, criteria_fingerprint, reference_fingerprint
     ${extra ? `, ${extra.split("=")[0]}` : ""})
   values ('${runId}', '${P}', '${ATT}', ${n}, '${ASSET}', 'mock', '1', 'mock', '3a.1', 'pf', 'sf', 'cf', 'rf'
     ${extra ? `, ${extra.split("=")[1]}` : ""})`;
const transitionRunSql = (runId: string, n: number, status = "complete") =>
  `insert into continuity_runs (id, project_id, subject_kind, run_number, analyzer, analyzer_version, analyzer_kind,
     rules_version, analysis_status, package_fingerprint, subject_fingerprint, criteria_fingerprint, reference_fingerprint)
   values ('${runId}', '${P}', 'transition', ${n}, 'deterministic', '3a.4', 'deterministic', '3a.4', '${status}', 'pk',
     'sf', 'cf', 'rf')`;
const subjectSql = (runId: string, n: number, key = sha(`key-${runId}`)) =>
  `insert into continuity_transition_subjects (run_id, project_id, edit_id, episode_id, edit_revision, transition_key,
     run_number, left_item_id, right_item_id, left_shot_id, right_shot_id, left_side, right_side, crosses_scene)
   values ('${runId}', '${P}', '${id()}', '${E1}', 0, '${key}', ${n}, '${id()}', '${id()}', '${SA}', '${SB}',
     '{"version":"cut-side-snapshot-v1","side":"left"}', '{"version":"cut-side-snapshot-v1","side":"right"}', false)`;

const attemptNewRun = (): NewRun => ({
  projectId: P,
  attemptId: ATT,
  subjectAssetId: ASSET,
  originalAssetId: null,
  analyzer: "deterministic",
  analyzerVersion: "1",
  analyzerKind: "deterministic",
  rulesVersion: "3a.1",
  analysisStatus: "complete",
  packageFingerprint: "pf",
  subjectFingerprint: "sf",
  criteriaFingerprint: "cf",
  referenceFingerprint: "rf",
  referenceSet: {},
  createdBy: dev.id,
  now: NOW(),
});

let cleanup = true;
try {
  // ── fixtures ──
  await q("insert into projects (id, user_id, slug, title, purpose) values ($1,$2,$3,$4,'test')", [
    P,
    dev.id,
    slug,
    `db:sc ${slug}`,
  ]);
  await q("insert into project_bibles (project_id) values ($1)", [P]);
  await q("insert into episodes (id, project_id, number, slug, title) values ($1,$2,1,'ep-1','E')", [E1, P]);
  await q(
    "insert into scenes (id, project_id, episode_id, scene_number, slugline, int_ext) values ($1,$2,$3,'1','INT. X','INT')",
    [S1, P, E1],
  );
  for (const [shotId, code, order] of [
    [SA, "1A", 0],
    [SB, "1B", 1],
    [SC, "1C", 2],
  ] as const)
    await q(
      `insert into shots (id, project_id, episode_id, scene_id, shot_code, title, "order") values ($1,$2,$3,$4,$5,'S',$6)`,
      [shotId, P, E1, S1, code, order],
    );
  for (const assetId of [ASSET, ASSET2])
    await q(
      `insert into assets (id, project_id, name, type, purpose, source, storage_provider, object_path, mime, checksum,
         width, height, duration_ms, metadata)
       values ($1,$2,'db:sc','video','generation_output','provider_output','local',$3,'video/mp4',$4,1024,576,4000,'{}'::jsonb)`,
      [assetId, P, `${P}/${assetId}/db-sc.mp4`, sha(assetId)],
    );
  await q(
    `insert into generation_attempts (id, project_id, shot_id, attempt_number, provider, model, modality, package_snapshot,
       status, request)
     values ($1,$2,$3,1,'mock','mock-video-1','video','{}'::jsonb,'succeeded','{"purpose":"shot_output"}'::jsonb)`,
    [ATT, P, SA],
  );
  const edit0 = await edits.create({
    projectId: P,
    episodeId: E1,
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
  const [IA, IB, IC] = edit0.items.map((i) => i.id) as [string, string, string];

  // ───────────────────────── structure, grants, RLS ─────────────────────────
  const priv = async (role: string, p: string) =>
    (await q("select has_table_privilege($1, 'public.continuity_transition_subjects', $2) as ok", [role, p]))
      .rows[0].ok as boolean;
  check(
    "transition subjects: authenticated may SELECT and INSERT only (explicit grants)",
    (await priv("authenticated", "select")) &&
      (await priv("authenticated", "insert")) &&
      !(await priv("authenticated", "update")) &&
      !(await priv("authenticated", "delete")),
  );
  const noAccess = async (role: string) =>
    !(await priv(role, "select")) &&
    !(await priv(role, "insert")) &&
    !(await priv(role, "update")) &&
    !(await priv(role, "delete"));
  check("transition subjects: anon has no privilege", await noAccess("anon"));
  check(
    "transition subjects: prism_generation_worker has no privilege",
    await noAccess("prism_generation_worker"),
  );
  check(
    "transition subjects: prism_continuity_worker has no privilege",
    await noAccess("prism_continuity_worker"),
  );
  const rls = (
    await q(
      "select relrowsecurity from pg_class where oid = 'public.continuity_transition_subjects'::regclass",
    )
  ).rows[0].relrowsecurity;
  const policies = (
    await q(
      "select policyname, cmd from pg_policies where tablename = 'continuity_transition_subjects' order by policyname",
    )
  ).rows.map((r) => `${r.policyname}:${r.cmd}`);
  check(
    "transition subjects: RLS on, exactly the owner SELECT and INSERT policies",
    rls === true &&
      JSON.stringify(policies) ===
        JSON.stringify([
          "continuity_transition_subjects_owner_insert:INSERT",
          "continuity_transition_subjects_owner_select:SELECT",
        ]),
    JSON.stringify(policies),
  );
  const ownerPolicies = (
    await q(
      `select tablename, count(*)::int as n from pg_policies
        where tablename in ('continuity_runs','continuity_findings','continuity_overrides','continuity_analysis_jobs')
          and roles::text like '%authenticated%' group by tablename order by tablename`,
    )
  ).rows.map((r) => `${r.tablename}:${r.n}`);
  check(
    "existing owner RLS on runs / findings / overrides / jobs unchanged (one owner policy each)",
    JSON.stringify(ownerPolicies) ===
      JSON.stringify([
        "continuity_analysis_jobs:1",
        "continuity_findings:1",
        "continuity_overrides:1",
        "continuity_runs:1",
      ]),
    JSON.stringify(ownerPolicies),
  );
  const workerRunCols = (
    await q(
      `select column_name from information_schema.column_privileges
        where grantee = 'prism_continuity_worker' and table_name = 'continuity_runs' and privilege_type = 'SELECT'
        order by column_name`,
    )
  ).rows.map((r) => r.column_name);
  check(
    "the continuity worker's column grants on runs are unchanged (no subject_kind, nothing new)",
    JSON.stringify(workerRunCols) ===
      JSON.stringify([
        "analysis_status",
        "attempt_id",
        "id",
        "original_asset_id",
        "project_id",
        "subject_asset_id",
      ]),
    JSON.stringify(workerRunCols),
  );

  // ───────────────────────── run / job subject invariants ─────────────────────────
  const R1 = id();
  check(
    "attempt run with attempt + subject Asset commits",
    (await ownerCommit([[attemptRunSql(R1, 1), []]])) === null,
  );
  check(
    "attempt run without attempt is refused",
    refused(
      await ownerCommit([[attemptRunSql(id(), 2).replace(`'${ATT}'`, "null"), []]]),
      /subject_shape|null/,
    ),
  );
  check(
    "attempt run without subject Asset is refused",
    refused(
      await ownerCommit([[attemptRunSql(id(), 2).replace(`'${ASSET}'`, "null"), []]]),
      /subject_shape|null/,
    ),
  );
  check(
    "a transition subject on an ATTEMPT run is refused (kind-aware key)",
    refused(await ownerCommit([[subjectSql(R1, 1), []]]), /foreign key|violates/),
  );
  const TX = id();
  check(
    "transition run carrying a Shot attempt is refused",
    refused(
      await ownerCommit([
        [
          transitionRunSql(TX, 1)
            .replace("subject_kind, run_number", "subject_kind, attempt_id, run_number")
            .replace("'transition', 1", `'transition', '${ATT}', 1`),
          [],
        ],
        [subjectSql(TX, 1), []],
      ]),
      /subject_shape/,
    ),
  );
  check(
    "transition run carrying a Shot subject Asset is refused",
    refused(
      await ownerCommit([
        [
          transitionRunSql(TX, 1)
            .replace("subject_kind, run_number", "subject_kind, subject_asset_id, run_number")
            .replace("'transition', 1", `'transition', '${ASSET}', 1`),
          [],
        ],
        [subjectSql(TX, 1), []],
      ]),
      /subject_shape/,
    ),
  );
  check(
    "a transition run without its subject cannot commit",
    refused(await ownerCommit([[transitionRunSql(id(), 1), []]]), /exactly one transition subject/),
  );
  const TM = id();
  check(
    "a transition subject whose run number differs from its run cannot commit",
    refused(
      await ownerCommit([
        [transitionRunSql(TM, 1), []],
        [subjectSql(TM, 2), []],
      ]),
      /exactly one transition subject/,
    ),
  );
  const T1 = id();
  check(
    "a transition run with exactly one subject commits",
    (await ownerCommit([
      [transitionRunSql(T1, 1), []],
      [subjectSql(T1, 1), []],
    ])) === null,
  );
  check(
    "a second subject for the same run is refused",
    refused(await adminCommit([[subjectSql(T1, 1, sha("other")), []]]), /duplicate|unique/),
  );
  const job = (runId: string, kind: "attempt" | "transition", attempt: string | null) =>
    `insert into continuity_analysis_jobs (project_id, run_id, subject_kind, attempt_id, analyzer, model, input_snapshot,
       input_asset_ids, idempotency_key)
     values ('${P}', '${runId}', '${kind}', ${attempt ? `'${attempt}'` : "null"}, 'mock', 'mock-1', '{}', array['${ASSET2}']::uuid[],
       '${sha(id())}')`;
  check(
    "attempt job on an attempt run commits",
    (await ownerCommit([[job(R1, "attempt", ATT), []]])) === null,
  );
  check(
    "a transition job on a transition run is structurally accepted",
    (await ownerCommit([[job(T1, "transition", null), []]])) === null,
  );
  check(
    "an attempt job pointing at a transition run is refused",
    refused(await ownerCommit([[job(T1, "attempt", ATT), []]]), /foreign key|violates/),
  );
  check(
    "a transition job pointing at an attempt run is refused",
    refused(await ownerCommit([[job(R1, "transition", null), []]]), /foreign key|violates/),
  );
  check(
    "a transition job carrying an attempt is refused",
    refused(await ownerCommit([[job(T1, "transition", ATT), []]]), /subject_shape/),
  );

  // every field the 0021 / 0022 / 0044 run guard froze is still frozen, and subject_kind too
  const frozenRun: Array<[string, string]> = [
    ["subject_kind", "'transition'"],
    ["attempt_id", "null"],
    ["run_number", "99"],
    ["subject_asset_id", `'${ASSET2}'`],
    ["original_asset_id", `'${ASSET2}'`],
    ["analyzer", "'x'"],
    ["analyzer_version", "'x'"],
    ["analyzer_kind", "'manual'"],
    ["rules_version", "'x'"],
    ["package_fingerprint", "'x'"],
    ["subject_fingerprint", "'x'"],
    ["criteria_fingerprint", "'x'"],
    ["reference_fingerprint", "'x'"],
    ["reference_set", `'{"x":1}'`],
    ["analysis_plan", `'{"x":1}'`],
    ["external_manifest", `'{"x":1}'`],
    ["prompt_version", "'x'"],
    ["rubric_version", "'x'"],
    ["model", "'x'"],
    ["automation_key", `'${"k".repeat(20)}'`],
  ];
  const stillFrozen: string[] = [];
  for (const [col, v] of frozenRun) {
    const r = await asOwner(`update continuity_runs set ${col} = ${v} where id = $1`, [R1]);
    if (!r.error?.includes("frozen snapshot")) stillFrozen.push(`${col}: ${r.error ?? "updated"}`);
  }
  check(
    "run guard: all 20 frozen fields refused (incl. subject_kind)",
    stillFrozen.length === 0,
    stillFrozen.join("; "),
  );
  const jobId = (await q("select id from continuity_analysis_jobs where run_id = $1", [R1])).rows[0].id;
  const frozenJob: Array<[string, string]> = [
    ["subject_kind", "'transition'"],
    ["attempt_id", "null"],
    ["run_id", `'${T1}'`],
    ["analyzer", "'x'"],
    ["model", "'x'"],
    ["input_snapshot", `'{"x":1}'`],
    ["input_asset_ids", `array['${ASSET}']::uuid[]`],
    ["idempotency_key", "'xxxxxxxxxx'"],
    ["created_by", `'${id()}'`],
  ];
  const jobFrozen: string[] = [];
  for (const [col, v] of frozenJob) {
    const r = await raw("begin", `update continuity_analysis_jobs set ${col} = ${v} where id = $1`, [jobId]);
    if (!r.error?.includes("are frozen")) jobFrozen.push(`${col}: ${r.error ?? "updated"}`);
  }
  check(
    "job guard: all 9 frozen fields refused (incl. subject_kind)",
    jobFrozen.length === 0,
    jobFrozen.join("; "),
  );

  // immutability and deletion of subjects
  const immut: string[] = [];
  for (const [col, v] of [
    ["transition_key", `'${sha("x")}'`],
    ["left_side", `'{"version":"cut-side-snapshot-v1","side":"left","x":1}'`],
    ["left_item_id", `'${id()}'`],
    ["run_number", "7"],
  ] as const) {
    const r = await raw(
      "begin",
      `update continuity_transition_subjects set ${col} = ${v} where run_id = $1`,
      [T1],
    );
    if (!r.error?.includes("frozen history")) immut.push(`${col}: ${r.error ?? "updated"}`);
  }
  check(
    "transition subject is immutable (key, side snapshot, item id, run number)",
    immut.length === 0,
    immut.join("; "),
  );
  const ownerUpdate = await asOwner(
    "update continuity_transition_subjects set crosses_scene = true where run_id = $1",
    [T1],
  );
  check(
    "…and the owner has no UPDATE privilege at all",
    /permission denied/.test(ownerUpdate.error ?? ""),
    ownerUpdate.error ?? "",
  );
  const ownerDelete = await asOwner("delete from continuity_transition_subjects where run_id = $1", [T1]);
  check(
    "the owner cannot DELETE a subject directly",
    /permission denied/.test(ownerDelete.error ?? ""),
    ownerDelete.error ?? "",
  );
  check(
    "even a privileged delete of a subject whose run remains cannot commit",
    refused(
      await adminCommit([["delete from continuity_transition_subjects where run_id = $1", [T1]]]),
      /exactly one/,
    ),
  );
  check(
    "deleting the transition run cascades its subject (and its job)",
    (await ownerCommit([["delete from continuity_runs where id = $1", [T1]]])) === null &&
      Number(
        (await q("select count(*) from continuity_transition_subjects where run_id = $1", [T1])).rows[0]
          .count,
      ) === 0,
  );

  // RLS on subjects
  const T2 = id();
  await ownerCommit([
    [transitionRunSql(T2, 1), []],
    [subjectSql(T2, 1), []],
  ]);
  const ownerSees = await asOwner(
    "select count(*)::int as n from continuity_transition_subjects where run_id = $1",
    [T2],
  );
  const strangerSees = await asStranger(
    "select count(*)::int as n from continuity_transition_subjects where run_id = $1",
    [T2],
  );
  const anonSees = await asAnon("select count(*)::int as n from continuity_transition_subjects");
  check("the owner reads its transition subject", ownerSees.rows[0]?.n === 1);
  check("a different owner reads nothing", strangerSees.rows[0]?.n === 0, strangerSees.error ?? "");
  check(
    "anon cannot read transition subjects",
    /permission denied/.test(anonSees.error ?? ""),
    anonSees.error ?? "",
  );
  const strangerInsert = await commit(rlsPreamble({ sub: stranger }), [[subjectSql(id(), 1), []]]);
  check("a different owner cannot insert into this project", refused(strangerInsert), strangerInsert ?? "");
  for (const role of ["prism_continuity_worker", "prism_generation_worker"]) {
    const r = await asRole(role, "select count(*) from continuity_transition_subjects");
    check(`${role} cannot read transition subjects`, /permission denied/.test(r.error ?? ""), r.error ?? "");
  }

  // ───────────────────────── the Postgres transition repository ─────────────────────────
  const data = (await admin.loadProject(slug))!;
  const cutsOf = (e: EpisodeEdit) => buildEpisodeCuts({ data, view: buildEpisodeEditView(data, e, media) });
  const record = (e: EpisodeEdit, truth = cutsOf(e)[0]!.truth) =>
    recordTransitionRun({
      qa,
      data,
      view: buildEpisodeEditView(data, e, media),
      reviewed: truth,
      userId: dev.id,
      now: NOW(),
    });
  const [ab, bc] = cutsOf(edit0);
  const r1 = await record(edit0, ab!.truth);
  const r2 = await record(edit0, ab!.truth);
  const o1 = await record(edit0, bc!.truth);
  check(
    "repository: same cut #1 then #2, another cut its own #1",
    r1.run.runNumber === 1 && r2.run.runNumber === 2 && o1.run.runNumber === 1,
    `${r1.run.runNumber},${r2.run.runNumber},${o1.run.runNumber}`,
  );
  check(
    "repository: a transition run (no attempt, no subject Asset) with its frozen address and sides",
    r1.run.subjectKind === "transition" &&
      r1.run.attemptId === null &&
      r1.run.subjectAssetId === null &&
      r1.subject.leftItemId === IA &&
      r1.subject.rightItemId === IB &&
      r1.subject.transitionKey === ab!.transitionKey &&
      r1.subject.leftSide.subjectFingerprint === ab!.truth.leftSubjectFingerprint &&
      r1.run.subjectFingerprint === ab!.truth.subjectFingerprint &&
      r1.findings.length === ab!.criteria.length,
  );
  const history = await qa.listTransitionRuns(P, ab!.transitionKey);
  check(
    "repository: one cut's history, newest first",
    history.map((h) => h.run.runNumber).join(",") === "2,1",
  );
  const latest = await qa.listLatestEditTransitionRuns(P, edit0.id);
  check("repository: the newest run of every cut of the edit", latest.length === 2);
  check(
    "repository: a different owner reads none of it",
    (await strangerQa.listTransitionRuns(P, ab!.transitionKey)).length === 0 &&
      (await strangerQa.getTransitionRun(r1.run.id)) === null,
  );

  // concurrency: two creations for the same cut at once get distinct sequential numbers, no unique-violation escapes
  const both = await Promise.allSettled([record(edit0, ab!.truth), record(edit0, ab!.truth)]);
  const nums = both.map((b) => (b.status === "fulfilled" ? b.value.run.runNumber : -1)).sort();
  check(
    "concurrent creations for one cut: #3 and #4, both committed",
    nums.join(",") === "3,4",
    both
      .map((b) => (b.status === "rejected" ? String((b.reason as Error).message) : b.value.run.runNumber))
      .join(" | "),
  );

  // ── 3A.4D: run + subject + findings + queued sequence job + estimate + event, atomically ──
  const plan = {
    version: 1 as const,
    analyzer: "mock-continuity",
    model: "mock",
    items: [],
    batches: [],
    manifest: {
      version: 1 as const,
      analyzer: "mock-continuity",
      model: "mock",
      entries: [],
      criteriaSent: 0,
    },
    budget: {
      maxReferencesPerBatch: 6,
      maxOutputImagesPerBatch: 5,
      maxCriteriaPerBatch: 8,
      maxImageBytes: 1,
      maxImageDimension: 1,
    },
    fingerprint: "db-sc",
  };
  const KEY = sha(`db-sc-seq-${id()}`);
  const withJob = (e: EpisodeEdit, maxActive = 50, key = KEY) => {
    const view = buildEpisodeEditView(data, e, media);
    const cut = buildEpisodeCuts({ data, view })[0]!;
    return qa.createTransitionRunWithJob({
      run: {
        ...newTransitionRun({ cut, view, userId: dev.id, now: NOW() }),
        analyzer: "mock-continuity",
        analyzerVersion: "mock-sequence-1",
        analyzerKind: "mock",
        analysisStatus: "queued",
        analysisPlan: plan,
        externalManifest: plan.manifest,
        promptVersion: "continuity-gemini-transition-v1",
        rubricVersion: "sequence-rubric-1",
        model: "mock",
      },
      job: {
        idempotencyKey: key,
        analyzer: "mock-continuity",
        model: "mock",
        snapshot: { version: 1, subjectKind: "transition", runKey: "db-sc", plan } as never,
        inputAssetIds: [ASSET2],
        maxAttempts: 3,
        estimate: { maxUsd: 0, expectedUsd: 0, usage: {}, pricingVersion: "free" },
      },
      limits: { maxActivePerProject: maxActive },
    });
  };
  const seq = await withJob(edit0);
  const seqRows = (
    await q(
      `select (select count(*)::int from continuity_analysis_costs where job_id = $1 and kind = 'estimated') as costs,
              (select count(*)::int from continuity_analysis_events where job_id = $1 and to_status = 'queued') as events,
              (select subject_kind from continuity_analysis_jobs where id = $1) as kind,
              (select attempt_id from continuity_analysis_jobs where id = $1) as attempt,
              (select prompt_version from continuity_runs where id = $2) as prompt`,
      [seq.job.id, seq.run.run.id],
    )
  ).rows[0];
  check(
    "3A.4D createTransitionRunWithJob: transition run #5 + subject + queued transition job + estimate + event, atomically",
    !seq.duplicate &&
      seq.run.run.runNumber === 5 &&
      seq.run.run.analysisStatus === "queued" &&
      seq.job.subjectKind === "transition" &&
      seq.job.attemptId === null &&
      seqRows.kind === "transition" &&
      seqRows.attempt === null &&
      seqRows.costs === 1 &&
      seqRows.events === 1 &&
      seqRows.prompt === "continuity-gemini-transition-v1",
    JSON.stringify({ n: seq.run.run.runNumber, ...seqRows }),
  );
  const replayed = await withJob(edit0);
  check(
    "3A.4D createTransitionRunWithJob: the same idempotency key replays (no second run or job)",
    replayed.duplicate &&
      replayed.job.id === seq.job.id &&
      (await qa.listTransitionRuns(P, ab!.transitionKey)).length === 5,
  );
  // the REAL worker login executes a transition job with the grants 0022-0046 already gave it (no new grant): it reads
  // the job and the Assets its inputs name, and moves the run; it still cannot read the transition subject table
  if (process.env.PRISM_STUDIO_CONTINUITY_DB_URL) {
    const wpool = new pg.Pool({
      connectionString: process.env.PRISM_STUDIO_CONTINUITY_DB_URL,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
    try {
      const wstore = new PostgresAnalysisWorkerStore(wpool);
      const who = (await wpool.query("select current_user as u")).rows[0].u;
      const job = (
        await wpool.query("select subject_kind, input_snapshot from continuity_analysis_jobs where id = $1", [
          seq.job.id,
        ])
      ).rows[0];
      const ref = await wstore.findInputAsset(seq.job.id, ASSET2);
      await wstore.startRun(seq.run.run.id);
      const status = (await q("select analysis_status from continuity_runs where id = $1", [seq.run.run.id]))
        .rows[0];
      const denied = await wpool.query("select count(*) from continuity_transition_subjects").then(
        () => "allowed",
        (e: Error) => e.message,
      );
      check(
        "3A.4D: the real continuity-worker login reads a transition job + its input Asset and starts its run (no new grant), never the subject table",
        who === "prism_continuity_worker" &&
          job?.subject_kind === "transition" &&
          ref?.assetId === ASSET2 &&
          status.analysis_status === "running" &&
          /permission denied/.test(denied),
        JSON.stringify({
          who,
          kind: job?.subject_kind,
          ref: ref?.assetId ?? null,
          status: status.analysis_status,
          denied,
        }),
      );
    } finally {
      await wpool.end();
    }
  }
  const activeNow = (await qa.listActiveProjectAnalysisJobs(P)).length;
  const limited = await withJob(edit0, activeNow, sha(`db-sc-limit-${id()}`)).then(
    () => "ok",
    (e: unknown) => (e instanceof MediaQaError ? e.code : String(e)),
  );
  check(
    "3A.4D createTransitionRunWithJob: the shared Project active limit applies (Shot + sequence jobs counted)",
    limited === "invalid",
    limited,
  );

  // refusal when adjacency changed; history survives edit changes and edit deletion
  const reordered = await edits.apply({
    editId: edit0.id,
    projectId: P,
    expectedRevision: 0,
    ops: [{ op: "reorder", itemIds: [IA, IC, IB] }],
    userId: dev.id,
    now: NOW(),
  });
  const stale = await record(edit0, ab!.truth).then(
    () => "ok",
    (e: unknown) => (e instanceof MediaQaError ? e.code : String(e)),
  );
  check(
    "repository: a cut that is no longer adjacent is refused (conflict), nothing written",
    stale === "conflict",
    stale,
  );
  const after = await qa.getTransitionRun(r1.run.id);
  check(
    "a reorder rewrites no recorded subject",
    JSON.stringify(after?.subject) === JSON.stringify(r1.subject),
  );
  await edits.delete({ editId: edit0.id, projectId: P, expectedRevision: reordered.revision });
  const kept = await qa.getTransitionRun(r1.run.id);
  const keptSubjects = Number(
    (await q("select count(*) from continuity_transition_subjects where project_id = $1", [P])).rows[0].count,
  );
  check(
    "deleting the live edit keeps every transition run WITH its subject (historical ids, no cascade)",
    JSON.stringify(kept?.subject) === JSON.stringify(r1.subject) && keptSubjects === 7,
    String(keptSubjects),
  );
  const fks = (
    await q(
      `select confrelid::regclass::text as t from pg_constraint
        where conrelid = 'public.continuity_transition_subjects'::regclass and contype = 'f' order by 1`,
    )
  ).rows.map((r) => r.t);
  check(
    "transition subjects have keys only to the project and their run (never the live edit / items / Shots)",
    JSON.stringify(fks) === JSON.stringify(["continuity_runs", "projects"]),
    JSON.stringify(fks),
  );

  // ───────────────────────── Shot-query isolation ─────────────────────────
  const shotRuns0 = await qa.listAttemptRuns(ATT);
  const latest0 = await qa.listLatestProjectRuns(P);
  const jobs0 = await qa.listAttemptAnalysisJobs(ATT);
  check(
    "listAttemptRuns returns attempt runs only",
    shotRuns0.length === 1 &&
      shotRuns0.every((v) => v.run.attemptId === ATT && v.run.subjectAssetId === ASSET),
    String(shotRuns0.length),
  );
  check(
    "latest Shot runs (distinct on attempt) never include a transition run",
    latest0.length === 1 && latest0[0]!.run.id === R1,
    latest0.map((v) => v.run.id).join(","),
  );
  check("getRun never returns a transition run", (await qa.getRun(r1.run.id)) === null);
  check("getTransitionRun never returns an attempt run", (await qa.getTransitionRun(R1)) === null);
  const next = await qa.createRun(attemptNewRun(), []);
  check(
    "the next Shot run number counts attempt runs only",
    next.run.runNumber === 2,
    String(next.run.runNumber),
  );
  check(
    "a Shot's analysis jobs never include a transition job",
    jobs0.length === 1 && jobs0.every((j) => j.subjectKind === "attempt" && j.attemptId === ATT),
    String(jobs0.length),
  );
  const T3 = id();
  await ownerCommit([
    [transitionRunSql(T3, 1, "queued"), []],
    [subjectSql(T3, 1), []],
    [job(T3, "transition", null), []],
  ]);
  const transitionJob = (await q("select id from continuity_analysis_jobs where run_id = $1", [T3])).rows[0]
    .id;
  const active0 = await qa.listActiveProjectAnalysisJobs(P);
  check(
    "the Project's active analysis jobs include BOTH kinds (Shot and sequence QA share maxActivePerProject)",
    active0.some((j) => j.subjectKind === "attempt" && j.attemptId === ATT) &&
      active0.some((j) => j.subjectKind === "transition" && j.attemptId === null),
    active0.map((j) => j.subjectKind).join(","),
  );
  const tj = await qa.getAnalysisJob(transitionJob);
  check(
    "getAnalysisJob returns a transition job as such (attemptId null, never the string 'null')",
    tj?.subjectKind === "transition" && tj.attemptId === null,
    JSON.stringify({ subjectKind: tj?.subjectKind, attemptId: tj?.attemptId }),
  );
  const aj = await qa.getAnalysisJob(jobs0[0]!.id);
  check(
    "getAnalysisJob still returns an attempt job as such",
    aj?.subjectKind === "attempt" && aj.attemptId === ATT,
  );
  const auto = await qa.ensureAutomaticRun(attemptNewRun(), [], `auto-${sha(id()).slice(0, 24)}`);
  check(
    "automatic Shot coverage is never satisfied by a transition run (creates an attempt run)",
    auto.created === true,
  );
  const workerStore = new PostgresAnalysisWorkerStore(pool);
  const claimed = await workerStore.claim({ workerId: "db-sc", now: NOW(), leaseMs: 1000, limit: 50 });
  check(
    "3A.4D: the mode-aware worker claims a queued transition job from the SAME queue, as a transition job",
    claimed.some((c) => c.job.runId === T3 && c.job.subjectKind === "transition" && c.job.attemptId === null),
    claimed.map((c) => `${c.job.subjectKind}:${c.job.runId}`).join(","),
  );
  for (const c of claimed)
    await q(
      "update continuity_analysis_jobs set status = 'queued', lease_owner = null, lease_token = null, lease_expires_at = null where id = $1",
      [c.job.id],
    );
  const cancelled = await qa.requestAnalysisCancel(transitionJob, NOW());
  const t3Run = (await q("select analysis_status, analysis_error from continuity_runs where id = $1", [T3]))
    .rows[0];
  const t3Events = (
    await q("select from_status, to_status from continuity_analysis_events where job_id = $1", [
      transitionJob,
    ])
  ).rows;
  check(
    "cancelling a queued transition job: job cancelled, its run failed, the normal event recorded",
    cancelled?.status === "cancelled" &&
      cancelled.subjectKind === "transition" &&
      t3Run.analysis_status === "failed" &&
      /cancelled before it started/i.test(t3Run.analysis_error) &&
      t3Events.length === 1 &&
      t3Events[0].from_status === "queued" &&
      t3Events[0].to_status === "cancelled",
    JSON.stringify({ status: cancelled?.status, run: t3Run.analysis_status, events: t3Events }),
  );
  const reclaimed = await workerStore.claim({ workerId: "db-sc", now: NOW(), leaseMs: 1000, limit: 50 });
  check("a cancelled transition job is never claimed again", !reclaimed.some((c) => c.job.runId === T3));
  for (const c of reclaimed)
    await q(
      "update continuity_analysis_jobs set status = 'queued', lease_owner = null, lease_token = null, lease_expires_at = null where id = $1",
      [c.job.id],
    );
  const pins = await qa.assetPins(ASSET2);
  check(
    "an Asset named by a transition job's inputs is pinned (in use)",
    pins.some((p) => /sequence continuity analysis/.test(p)),
    JSON.stringify(pins),
  );

  // ───────────────────────── persisted cut intent ─────────────────────────
  const edit1 = await edits.create({
    projectId: P,
    episodeId: E1,
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
  const [JA, JB, JC] = edit1.items.map((i) => i.id) as [string, string, string];
  const intent = (from: string, o: Record<string, unknown> = {}) =>
    JSON.stringify({
      fromItemId: from,
      kinds: ["time_jump"],
      scope: ["time_of_day"],
      note: "Hours later.",
      declaredBy: dev.id,
      declaredAt: "2026-10-29T12:00:00.000Z",
      ...o,
    });
  const setRaw = (item: string, value: string) =>
    ownerCommit([
      ["update episode_edit_items set incoming_cut_intent = $2::jsonb where id = $1", [item, value]],
    ]);
  const malformed: string[] = [];
  for (const [label, value] of [
    ["unknown kind", intent(JA, { kinds: ["teleport"] })],
    ["empty kinds", intent(JA, { kinds: [] })],
    ["duplicate kinds", intent(JA, { kinds: ["montage", "montage"] })],
    ["unknown scope", intent(JA, { scope: ["smell"] })],
    ["blank note", intent(JA, { note: "  " })],
    [
      "missing declaredBy (a CHECK passes on NULL: must be false)",
      JSON.stringify({ ...JSON.parse(intent(JA)), declaredBy: undefined }),
    ],
    ["extra field", intent(JA, { approved: true })],
    ["not an item id", intent(JA, { fromItemId: "item-a" })],
    ["bad timestamp", intent(JA, { declaredAt: "yesterday" })],
    ["an array", "[]"],
  ] as const) {
    const r = await setRaw(JB, value);
    if (!r || !/cut_intent_valid/.test(r)) malformed.push(`${label}: ${r ?? "accepted"}`);
  }
  check(
    "the database refuses every malformed intent (CHECK episode_cut_intent_valid)",
    malformed.length === 0,
    malformed.join("; "),
  );
  check("a valid intent bound to the actual predecessor commits", (await setRaw(JB, intent(JA))) === null);
  check(
    "an intent bound to another item cannot commit",
    refused(await setRaw(JC, intent(JA)), /immediately before it/),
  );
  check(
    "an intent on the first item cannot commit",
    refused(await setRaw(JA, intent(JC)), /immediately before it/),
  );
  check(
    "a raw reorder that leaves the intent stale cannot commit (final-state rule)",
    refused(
      await ownerCommit([
        ["update episode_edit_items set position = 5 where id = $1", [JB]],
        ["update episode_edit_items set position = 1 where id = $1", [JC]],
        ["update episode_edit_items set position = 2 where id = $1", [JB]],
      ]),
      /immediately before it/,
    ),
  );
  check(
    "a raw position swap that keeps every predecessor commits (renumbered inside the unit)",
    (await ownerCommit([
      ["update episode_edit_items set position = position + 10 where edit_id = $1", [edit1.id]],
      ["update episode_edit_items set position = position - 10 where edit_id = $1", [edit1.id]],
    ])) === null,
  );
  const fresh = (await edits.get(P, edit1.id))!;
  check(
    "the repository reads the persisted intent (canonical shape)",
    fresh.items[1]!.incomingCutIntent?.fromItemId === JA &&
      fresh.items[1]!.incomingCutIntent?.note === "Hours later.",
  );
  const apply = (rev: number, ops: EditOp[]) =>
    edits.apply({ editId: edit1.id, projectId: P, expectedRevision: rev, ops, userId: dev.id, now: NOW() });
  const held = await apply(fresh.revision, [{ op: "set_hold", itemId: JB, durationMs: 3000 }]);
  check(
    "a hold change keeps the intent (one revision)",
    held.items[1]!.incomingCutIntent?.fromItemId === JA && held.revision === fresh.revision + 1,
  );
  const staleCode = await apply(fresh.revision, [{ op: "clear_cut_intent", itemId: JB }]).then(
    () => "ok",
    (e: unknown) => (e instanceof EpisodeEditError ? e.code : String(e)),
  );
  const unchanged = (await edits.get(P, edit1.id))!;
  check(
    "a stale revision writes nothing",
    staleCode === "conflict" &&
      unchanged.revision === held.revision &&
      unchanged.items[1]!.incomingCutIntent !== null,
    staleCode,
  );
  const moved = await apply(held.revision, [{ op: "reorder", itemIds: [JA, JC, JB] }]);
  const persisted = (
    await q(
      "select count(*)::int as n from episode_edit_items where edit_id = $1 and incoming_cut_intent is not null",
      [edit1.id],
    )
  ).rows[0].n;
  check(
    "a repository reorder clears the obsolete intent in the same unit and commits (one revision)",
    moved.revision === held.revision + 1 && moved.items.every((i) => !i.incomingCutIntent) && persisted === 0,
    `${moved.revision} ${persisted}`,
  );
  const declared = await apply(moved.revision, [
    {
      op: "set_cut_intent",
      itemId: JC,
      expectedPredecessorId: JA,
      kinds: ["match_cut"],
      scope: [],
      note: "Match on the door.",
    },
  ]);
  check(
    "set_cut_intent: the server's user and time, one revision",
    declared.revision === moved.revision + 1 &&
      declared.items[1]!.incomingCutIntent?.declaredBy === dev.id &&
      declared.items[1]!.incomingCutIntent?.fromItemId === JA,
  );
  const wrongPred = await apply(declared.revision, [
    { op: "set_cut_intent", itemId: JB, expectedPredecessorId: JA, kinds: ["other"], scope: [], note: "x" },
  ]).then(
    () => "ok",
    (e: unknown) => (e instanceof EpisodeEditError ? e.code : String(e)),
  );
  check(
    "set_cut_intent against a predecessor that is no longer there is a conflict",
    wrongPred === "conflict",
    wrongPred,
  );
  const removedPred = await apply(declared.revision, [{ op: "remove", itemId: JA }]);
  check(
    "removing the predecessor clears the intent (never retargeted)",
    removedPred.items.every((i) => !i.incomingCutIntent),
  );
} catch (err) {
  check("suite ran to completion", false, (err as Error).stack ?? String(err));
} finally {
  if (cleanup) {
    await q("delete from projects where id = $1", [P]).catch(() => undefined);
    const left = (
      await q(
        `select (select count(*) from projects where id = $1) + (select count(*) from continuity_runs where project_id = $1)
          + (select count(*) from continuity_transition_subjects where project_id = $1)
          + (select count(*) from episode_edits where project_id = $1) as n`,
        [P],
      )
    ).rows[0].n;
    check("cleanup: no row of the throwaway project remains", Number(left) === 0, String(left));
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
