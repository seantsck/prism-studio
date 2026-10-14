// Integration tests for Phase 2E candidate sets and human generation reviews against the REAL dedicated
// Prism Studio database (migration 0026).
//   npm run db:candidates
//
// Exercises (with real rows, cleaned up afterwards): the mock-provider candidate set through the real queue and
// worker store, failure isolation, append-only human reviews and supersession, winner/promotion rules and the
// DB triggers behind them, owner-only RLS (owner / stranger / anon), the guarantee that NEITHER worker role has
// any access to these tables, outcome records for statistics, and cascade cleanup.
// Requires `npm run db:seed` first (uses the demo project's shot 3A). No provider is called: MockProvider only.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { PostgresCandidateData } from "../src/data/candidates-postgres";
import { PostgresGenerationData } from "../src/data/generation-postgres";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { rollupSet } from "../src/domain/generation/candidates";
import { aggregateByModel } from "../src/domain/generation/performance";
import { latestReviews, normalizeReview } from "../src/domain/generation/reviews";
import { submitCandidateSet, type CandidateSelection } from "../src/generation/candidate-set";
import { readGenerationConfig } from "../src/generation/config";
import { silentLogger } from "../src/generation/log";
import { createRegistry } from "../src/generation/registry";
import { LocalDiskSink } from "../src/generation/sink";
import { GenerationWorker } from "../src/generation/worker";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({
  mode: "candidate-set + human-review integration tests (rows created, then removed)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 6 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const stranger = randomUUID();

const env = {
  NODE_ENV: "test",
  PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
  PRISM_STUDIO_GENERATION_MAX_ACTIVE_PER_PROJECT: "10",
  PRISM_STUDIO_MAX_CANDIDATES_PER_SET: "6",
};
const config = readGenerationConfig(env);
const registry = createRegistry(env, config);
const admin = new AdminRepository(pool, dev.id);
const ownerGen = new PostgresGenerationData(pool, rlsPreamble({ sub: dev.id }));
const adminGen = new PostgresGenerationData(pool, "begin");
const ownerCand = new PostgresCandidateData(pool, rlsPreamble({ sub: dev.id }));
const strangerCand = new PostgresCandidateData(pool, rlsPreamble({ sub: stranger }));
const anonCand = new PostgresCandidateData(pool, rlsPreamble(null, "anon"));

const sinkRoot = mkdtempSync(path.join(tmpdir(), "prism-dbcand-"));
const sink = new LocalDiskSink(sinkRoot);
const createdAttemptIds: string[] = [];
const createdSetIds: string[] = [];
const createdAssetIds: string[] = [];

/** One statement in its own transaction as a given security context; always rolled back. */
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
const asAnon = (sql: string, p: unknown[] = []) => raw(rlsPreamble(null, "anon"), sql, p);
const mock = (modelId: string): CandidateSelection => ({ provider: "mock", modelId });

try {
  const data = (await admin.loadProject("ojousama"))!;
  const projectId = data.project.id;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  const revision = (await ownerGen.projectRevision("ojousama"))!;

  // ── 1. structure and security ──
  const TABLES = [
    "generation_candidate_sets",
    "generation_candidate_members",
    "generation_reviews",
    "generation_candidate_events",
  ];
  const rls = await pool.query(
    "select relname, relrowsecurity from pg_class where relname = any($1::text[]) and relkind = 'r'",
    [TABLES],
  );
  check(
    "the four Phase 2E tables exist with row-level security enabled",
    rls.rowCount === 4 && rls.rows.every((r) => r.relrowsecurity === true),
  );
  const pol = await pool.query(
    "select tablename from pg_policies where schemaname = 'public' and tablename = any($1::text[]) and 'authenticated' = any(roles)",
    [TABLES],
  );
  check(
    "each table has an owner policy for authenticated users",
    new Set(pol.rows.map((r) => r.tablename)).size === 4,
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
      `${role} has NO privilege on any candidate/review table`,
      privs.rows.every((r) => !r.s && !r.i && !r.u && !r.d),
      JSON.stringify(privs.rows.filter((r) => r.s || r.i || r.u || r.d)),
    );
  }

  // ── 2. a three-model candidate set through the real queue ──
  const sel = [mock("mock-video-1"), mock("mock-video-lite"), mock("mock-video-169")];
  const out = await submitCandidateSet({
    data,
    shotId: shot.id,
    registry,
    config,
    generation: ownerGen,
    candidates: ownerCand,
    selections: sel,
    acknowledgeAll: true,
    confirmedTotalUsd: null,
    title: "db:candidates 3A",
    purpose: "integration test",
    userId: dev.id,
    projectRevision: revision.revision,
  });
  createdSetIds.push(out.view.set.id);
  for (const m of out.view.members) if (m.attemptId) createdAttemptIds.push(m.attemptId);
  check(
    "three candidates were submitted, none failed",
    out.submitted === 3 && out.failed.length === 0,
    JSON.stringify(out.failed),
  );
  check(
    "each candidate is its own attempt and job (no giant job)",
    new Set(out.view.members.map((m) => m.attemptId)).size === 3,
  );
  const jobs = await pool.query(
    "select attempt_id, status from generation_jobs where attempt_id = any($1::uuid[])",
    [out.view.members.map((m) => m.attemptId)],
  );
  check("one job per candidate attempt", jobs.rowCount === 3);
  check(
    "the set freezes ONE package fingerprint shared by every attempt",
    (
      await pool.query(
        "select count(distinct package_fingerprint)::int n from generation_attempts where id = any($1::uuid[])",
        [out.view.members.map((m) => m.attemptId)],
      )
    ).rows[0].n === 1 &&
      (
        await pool.query("select package_fingerprint f from generation_attempts where id = $1", [
          out.view.members[0]!.attemptId,
        ])
      ).rows[0].f === out.view.set.packageFingerprint,
  );

  // run the real worker (MockProvider) until the three jobs settle
  const offset = { ms: 0 };
  const worker = new GenerationWorker({
    store: adminGen,
    registry,
    sink,
    config,
    logger: silentLogger,
    clock: () => new Date(Date.now() + offset.ms),
    workerId: "db-candidates-test",
    retryPolicy: { baseDelayMs: 50, maxDelayMs: 200, jitter: 0 },
    heartbeatMs: 0,
  });
  for (let i = 0; i < 20; i++) {
    const st = await pool.query(
      "select count(*)::int n from generation_jobs where attempt_id = any($1::uuid[]) and status not in ('succeeded','failed','cancelled')",
      [createdAttemptIds],
    );
    if (st.rows[0].n === 0) break;
    await worker.tick(10);
    offset.ms += 1500;
  }
  const attempts = await pool.query("select id, status from generation_attempts where id = any($1::uuid[])", [
    createdAttemptIds,
  ]);
  check(
    "all three candidates completed independently",
    attempts.rows.every((r) => r.status === "succeeded"),
  );
  for (const id of createdAttemptIds) {
    const v = await ownerGen.getAttemptView(id);
    for (const o of v?.outputs ?? []) createdAssetIds.push(o.asset.id);
  }
  const roll = rollupSet(
    attempts.rows.map((r) => ({ submitState: "submitted" as const, attemptStatus: String(r.status) })),
  );
  check("rollup reads 3/3 completed", roll.label === "3/3 completed");

  // ── 3. failure isolation: one rejecting provider model never fails the set ──
  const out2 = await submitCandidateSet({
    data,
    shotId: shot.id,
    registry,
    config,
    generation: ownerGen,
    candidates: ownerCand,
    selections: [mock("mock-video-1"), mock("mock-video-rejects")],
    acknowledgeAll: true,
    confirmedTotalUsd: null,
    title: "db:candidates isolation",
    purpose: "",
    userId: dev.id,
    projectRevision: revision.revision,
  });
  createdSetIds.push(out2.view.set.id);
  const ids2 = out2.view.members.map((m) => m.attemptId!).filter(Boolean);
  createdAttemptIds.push(...ids2);
  for (let i = 0; i < 20; i++) {
    const st = await pool.query(
      "select count(*)::int n from generation_jobs where attempt_id = any($1::uuid[]) and status not in ('succeeded','failed','cancelled')",
      [ids2],
    );
    if (st.rows[0].n === 0) break;
    await worker.tick(10);
    offset.ms += 1500;
  }
  const st2 = await pool.query(
    "select id, status from generation_attempts where id = any($1::uuid[]) order by attempt_number",
    [ids2],
  );
  check(
    "one candidate failed, the other succeeded: the set is still usable",
    st2.rows
      .map((r) => r.status)
      .sort()
      .join(",") === "failed,succeeded",
    st2.rows.map((r) => r.status).join(","),
  );
  for (const id of ids2) {
    const v = await ownerGen.getAttemptView(id);
    for (const o of v?.outputs ?? []) createdAssetIds.push(o.asset.id);
  }

  // ── 4. human reviews: append-only, supersession, validation ──
  const [a, b, c] = out.view.members.map((m) => m.attemptId!) as [string, string, string];
  const now = () => new Date().toISOString();
  const review = (attemptId: string, decision: "approve" | "shortlist" | "reject", tags: string[] = []) =>
    ownerCand.recordReview({
      projectId,
      attemptId,
      candidateSetId: out.view.set.id,
      ...normalizeReview({
        decision,
        negativeTags: decision === "reject" ? tags : [],
        positiveTags: [],
        notes: "",
      }),
      reviewer: dev.id,
      now: now(),
    });
  const r1 = await review(a, "reject", ["character_identity"]);
  await new Promise((r) => setTimeout(r, 15));
  const r2 = await review(a, "approve");
  await review(b, "reject", ["body_motion"]);
  await review(c, "shortlist");
  check("a second review supersedes the first (history kept)", r2.supersedesId === r1.id);
  const hist = await ownerCand.listReviews(projectId, { attemptIds: [a] });
  check("both reviews of the attempt remain", hist.length === 2);
  check("the latest review is the current one", latestReviews(hist).get(a)!.id === r2.id);
  check(
    "a review row cannot be updated (append-only trigger)",
    /append-only/.test(
      (
        await raw(rlsPreamble({ sub: dev.id }), "update generation_reviews set notes = 'x' where id = $1", [
          r1.id,
        ])
      ).error ?? "",
    ),
  );
  check(
    "a rejection without a reason is refused by the database",
    /check constraint/i.test(
      (
        await asOwner(
          "insert into generation_reviews (project_id, attempt_id, decision) values ($1, $2, 'reject')",
          [projectId, a],
        )
      ).error ?? "",
    ),
  );
  check(
    "an unknown reason tag is refused by the database",
    /check constraint/i.test(
      (
        await asOwner(
          "insert into generation_reviews (project_id, attempt_id, decision, negative_tags) values ($1, $2, 'reject', array['bogus'])",
          [projectId, a],
        )
      ).error ?? "",
    ),
  );

  // ── 5. winner / promotion rules ──
  const strangerAttempt = (
    await pool.query(
      "select id from generation_attempts where id <> all($1::uuid[]) and project_id = $2 limit 1",
      [createdAttemptIds, projectId],
    )
  ).rows[0]?.id;
  let notMember = "";
  try {
    await ownerCand.setPreferred(out.view.set.id, strangerAttempt ?? randomUUID(), dev.id, now());
  } catch (e) {
    notMember = (e as { code?: string }).code ?? String(e);
  }
  check("a non-member cannot be marked preferred", notMember === "not_member", notMember);
  const marked = await ownerCand.setPreferred(out.view.set.id, c, dev.id, now());
  check(
    "a member can be marked preferred (without promoting)",
    marked.preferredAttemptId === c && marked.promotedAttemptId === null,
  );
  check(
    "the database trigger rejects a non-member winner even with raw SQL",
    /not a member/.test(
      (
        await asOwner("update generation_candidate_sets set preferred_attempt_id = $2 where id = $1", [
          out.view.set.id,
          strangerAttempt ?? randomUUID(),
        ])
      ).error ?? "",
    ),
  );
  const failedAttempt = st2.rows.find((r) => r.status === "failed")!.id as string;
  check(
    "a failed generation cannot be promoted (trigger)",
    /only a succeeded|not a member/.test(
      (
        await asOwner(
          "update generation_candidate_sets set promoted_attempt_id = $2, promoted_at = now() where id = $1",
          [out2.view.set.id, failedAttempt],
        )
      ).error ?? "",
    ),
  );
  await ownerGen.reviewAttempt(c, { status: "approved", categories: [], reason: "", notes: "", now: now() });
  const promoted = await ownerCand.recordPromotion(out.view.set.id, c, dev.id, now());
  check(
    "promotion records the winner and decides the set",
    promoted.promotedAttemptId === c && promoted.status === "decided",
  );
  const losersKept = await pool.query(
    "select count(*)::int n from generation_attempts where id = any($1::uuid[])",
    [[a, b]],
  );
  check("losing candidates are preserved", losersKept.rows[0].n === 2);
  const kinds = (await ownerCand.getSet(out.view.set.id))!.events.map((e) => e.kind).join(",");
  check(
    "the set's audit trail records created → preferred → promoted",
    kinds === "created,preferred_set,promoted",
    kinds,
  );
  check(
    "set identity is frozen (shot cannot change)",
    /immutable/.test(
      (
        await asOwner("update generation_candidate_sets set shot_id = $2 where id = $1", [
          out.view.set.id,
          randomUUID(),
        ])
      ).error ?? "",
    ),
  );
  check(
    "a member's frozen plan cannot be edited",
    /frozen plan/.test(
      (
        await asOwner("update generation_candidate_members set model = 'x' where id = $1", [
          out.view.members[0]!.id,
        ])
      ).error ?? "",
    ),
  );
  check(
    "a member's attempt link is set once",
    /already has an attempt/.test(
      (
        await asOwner("update generation_candidate_members set attempt_id = $2 where id = $1", [
          out.view.members[0]!.id,
          b,
        ])
      ).error ?? "",
    ),
  );

  // ── 6. RLS: owner / stranger / anon ──
  check("owner can read the set", (await ownerCand.getSet(out.view.set.id)) !== null);
  check("a stranger cannot read the set", (await strangerCand.getSet(out.view.set.id)) === null);
  check("a stranger sees no reviews", (await strangerCand.listReviews(projectId)).length === 0);
  check(
    "a stranger cannot write a review for the owner's attempt",
    (
      await asStranger(
        "insert into generation_reviews (project_id, attempt_id, decision) values ($1, $2, 'approve')",
        [projectId, a],
      )
    ).error !== null,
  );
  check("anon sees nothing", ((await anonCand.getSet(out.view.set.id).catch(() => null)) ?? null) === null);
  check(
    "a stranger cannot mark a winner",
    (
      await asStranger(
        "update generation_candidate_sets set status = 'archived' where id = $1 returning id",
        [out.view.set.id],
      )
    ).rows.length === 0,
  );
  {
    const anon = await asAnon("select 1 from generation_reviews limit 1");
    check("anon cannot read reviews", anon.error !== null || anon.rows.length === 0);
  }

  // ── 7. worker roles really cannot touch these tables (SET ROLE as each worker) ──
  for (const role of ["prism_generation_worker", "prism_continuity_worker"]) {
    try {
      await pool
        .query(`grant ${role} to current_user with set true`)
        .catch(() => pool.query(`grant ${role} to current_user`));
    } catch {
      /* already granted */
    }
    const c1 = await pool.connect();
    try {
      await c1.query(`begin; set local role ${role}`);
      let denied = false;
      try {
        await c1.query("select count(*) from generation_reviews");
      } catch (e) {
        denied = /permission denied/i.test((e as Error).message);
      }
      await c1.query("rollback");
      check(`${role}: reading reviews is permission denied`, denied);
      await c1.query(`begin; set local role ${role}`);
      let deniedWrite = false;
      try {
        await c1.query(
          "insert into generation_reviews (project_id, attempt_id, decision) values ($1, $2, 'approve')",
          [projectId, a],
        );
      } catch (e) {
        deniedWrite = /permission denied/i.test((e as Error).message);
      }
      await c1.query("rollback");
      check(`${role}: writing a review is permission denied`, deniedWrite);
    } catch (e) {
      check(`${role}: privilege probe could not run (${(e as Error).message})`, false);
    } finally {
      await c1.query("rollback").catch(() => undefined);
      c1.release();
    }
  }

  // ── 7b. migration 0028: benchmark classification + "a review needs a clip" ──
  {
    const col = await pool.query(
      "select column_default, is_nullable from information_schema.columns where table_name = 'projects' and column_name = 'is_benchmark'",
    );
    check(
      "projects.is_benchmark exists, not null, default false",
      col.rowCount === 1 &&
        col.rows[0].is_nullable === "NO" &&
        String(col.rows[0].column_default) === "false",
    );
    const flag = await pool.query("select is_benchmark from projects where id = $1", [projectId]);
    check(
      "the demo project is a production project (never reclassified by migration)",
      flag.rows[0]?.is_benchmark === false,
    );

    // a review on an attempt that did not succeed is refused by the database itself
    const c = await pool.connect();
    let refused = "";
    try {
      await c.query("begin");
      await c.query("alter table generation_attempts disable trigger user");
      await c.query("update generation_attempts set status = 'failed' where id = $1", [createdAttemptIds[0]]);
      await c.query("alter table generation_attempts enable trigger user");
      await c.query(
        "insert into generation_reviews (project_id, attempt_id, decision, positive_tags, negative_tags, notes) values ($1, $2, 'approve', '{}', '{}', '')",
        [projectId, createdAttemptIds[0]],
      );
    } catch (e) {
      refused = (e as Error).message;
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
    check(
      "DB refuses a human review for a non-succeeded attempt",
      /needs a completed generation/.test(refused),
      refused.slice(0, 120),
    );

    // outcomes carry the project's explicit classification (toggled inside the test, always restored)
    const before = await ownerCand.listOutcomeRecords(projectId);
    check(
      "production project outcomes are not flagged benchmark",
      before.every((o) => o.benchmark === false),
    );
    try {
      await pool.query("update projects set is_benchmark = true where id = $1", [projectId]);
      const flagged = await ownerCand.listOutcomeRecords(projectId);
      check(
        "benchmark project outcomes are flagged and excluded from production aggregates",
        flagged.length > 0 &&
          flagged.every((o) => o.benchmark === true) &&
          aggregateByModel(flagged).every((p) => p.reviewed === 0 && p.generated === 0),
      );
    } finally {
      await pool.query("update projects set is_benchmark = false where id = $1", [projectId]);
    }
  }

  // ── 8. statistics derive from human outcomes ──
  const outcomes = await ownerCand.listOutcomeRecords(projectId);
  const mine = outcomes.filter((o) => createdAttemptIds.includes(o.attemptId));
  check("outcome records exist for every candidate attempt", mine.length === createdAttemptIds.length);
  check(
    "outcomes carry a shot feature profile from the frozen package",
    mine.every((o) => o.profile !== null),
  );
  check(
    "standalone seeded attempts remain standalone and unreviewed",
    outcomes.filter((o) => !createdAttemptIds.includes(o.attemptId)).every((o) => !o.inCandidateSet),
  );
  const perf = aggregateByModel(mine);
  const m169 = perf.find((p) => p.model === "mock-video-169");
  check(
    "preferred win and good review are counted for the winner",
    m169?.preferredWins === 1 && m169.shortlisted === 1,
  );
  const m1 = perf.find((p) => p.model === "mock-video-1");
  check(
    "the superseded rejection no longer counts (latest review wins)",
    m1?.approved === 1 && m1.rejected === 0,
  );
  check(
    "rejection reasons are aggregated",
    perf.find((p) => p.model === "mock-video-lite")?.topRejectionReasons[0]?.tag === "body_motion",
  );
  check(
    "latency is derived from job timestamps",
    mine.some((o) => o.totalMs != null),
  );
} finally {
  // cascade cleanup: sets → members/events/reviews, attempts → jobs/outputs/costs, then assets
  if (createdSetIds.length) {
    await pool.query("delete from generation_candidate_sets where id = any($1::uuid[])", [createdSetIds]);
  }
  if (createdAttemptIds.length) {
    await pool.query("delete from generation_attempts where id = any($1::uuid[])", [createdAttemptIds]);
  }
  if (createdAssetIds.length) {
    await pool.query("delete from assets where id = any($1::uuid[])", [createdAssetIds]);
  }
  rmSync(sinkRoot, { recursive: true, force: true });
}

// cleanup is part of the contract
const left = await pool.query(
  "select (select count(*) from generation_candidate_sets where title like 'db:candidates%')::int as sets, (select count(*) from generation_reviews where attempt_id = any($1::uuid[]))::int as reviews",
  [createdAttemptIds],
);
check(
  "cleanup: no test sets or reviews remain",
  left.rows[0].sets === 0 && left.rows[0].reviews === 0,
  JSON.stringify(left.rows[0]),
);

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
await pool.end();
process.exit(failed ? 1 : 0);
