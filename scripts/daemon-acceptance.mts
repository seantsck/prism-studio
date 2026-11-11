// Phase 5A.2 daemon acceptance: proves a HOSTED generation worker (e.g. the Vercel daemon on prism-studio-workers-staging)
// completes a job with nobody running a worker locally.
//   npm run daemon:acceptance -- [--timeout-s 600] [--model mock-video-1]
//
// 1. Enqueues ONE generation through the application's own submission path (prepareSubmission + createAttemptWithJob,
//    as the dev owner under RLS) for the demo project's Shot 3A, on the free MOCK provider only.
// 2. Runs NO worker. It only polls the job until it reaches a terminal state (or times out).
// 3. Reports the outcome (status, which worker claimed it, output assets, the stored object) and then removes exactly
//    what it created: that attempt (job, outputs and costs cascade), its output assets and their Storage objects.
// Refuses the production environment (startScript); never touches another attempt.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresGenerationData } from "../src/data/generation-postgres";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { readGenerationConfig } from "../src/generation/config";
import { createRegistry } from "../src/generation/registry";
import { createOutputSink } from "../src/generation/sink";
import { prepareSubmission } from "../src/generation/submission";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const timeoutMs = Number(arg("--timeout-s", "600")) * 1000;
const modelId = arg("--model", "mock-video-1");

const dev = readDevUserEnv();
startScript({
  mode: "daemon acceptance (one MOCK job; no local worker; removed afterwards)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 3 });
await assertDevUserExists(pool, dev);

// Enqueue-side config only (the worker that executes the job is the hosted one, with its own config).
const env = {
  NODE_ENV: "test",
  PRISM_STUDIO_GENERATION_PROVIDERS: "mock",
  PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
};
const config = readGenerationConfig(env);
const registry = createRegistry(env, config);
const admin = new AdminRepository(pool, dev.id);
const ownerGen = new PostgresGenerationData(pool, rlsPreamble({ sub: dev.id }));

let attemptId: string | null = null;
const out: Record<string, unknown> = { model: modelId };
try {
  const data = (await admin.loadProject("ojousama"))!;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  const rev = await ownerGen.projectRevision("ojousama");
  const key = `daemon-acceptance-${randomUUID()}`;
  const prep = (acknowledged: string[]) =>
    prepareSubmission({
      data,
      shotId: shot.id,
      registry,
      provider: "mock",
      modelId,
      acknowledged,
      userId: dev.id,
      idempotencyKey: key,
      config,
      projectRevision: rev!.revision,
    });
  const first = prep([]);
  const p = prep(first.evaluation.compatibility?.ignoredFeatures.map((f) => f.id) ?? []);
  if (!p.input)
    throw new Error(`the gate refused the mock submission: ${JSON.stringify(p.evaluation.gate.blockers)}`);
  const created = await ownerGen.createAttemptWithJob(p.input);
  attemptId = created.attempt.id;
  const enqueuedAt = Date.now();
  console.log(
    `enqueued: attempt ${attemptId.slice(0, 8)}…, job ${created.job.id.slice(0, 8)}… (${modelId}); waiting for a hosted worker`,
  );

  let job: Record<string, unknown> | undefined;
  const claimedBy = new Set<string>();
  for (;;) {
    job = (
      await pool.query(
        `select status, lease_owner, attempt_count, last_error_code, last_error_category,
                extract(epoch from (coalesce(completed_at, failed_at, cancelled_at, now()) - created_at))::float as seconds
           from generation_jobs where attempt_id = $1`,
        [attemptId],
      )
    ).rows[0];
    if (job?.lease_owner) claimedBy.add(String(job.lease_owner));
    if (job && ["succeeded", "failed", "cancelled"].includes(String(job.status))) break;
    if (Date.now() - enqueuedAt > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const outputs = (
    await pool.query(
      `select a.object_path, a.checksum is not null as has_checksum,
              exists (select 1 from storage.objects o where o.bucket_id = 'prism-assets' and o.name = a.object_path) as stored
         from assets a
        where a.purpose = 'generation_output' and (a.metadata->'generation'->>'attemptId') = $1`,
      [attemptId],
    )
  ).rows;
  const timeline = (
    await pool.query(
      `select to_status, round(extract(epoch from (at - (select created_at from generation_jobs where attempt_id = $1)))::numeric, 1)::float as t
         from generation_job_events where attempt_id = $1 order by at`,
      [attemptId],
    )
  ).rows.map((e) => `${e.t}s ${e.to_status}`);
  Object.assign(out, {
    timeline,
    status: job?.status ?? "missing",
    claimedBy: [...claimedBy],
    attempts: job?.attempt_count ?? null,
    error: job?.last_error_code ? `${job.last_error_category}/${job.last_error_code}` : null,
    secondsToTerminal: job ? Math.round(Number(job.seconds)) : null,
    outputs: outputs.length,
    outputsWithChecksum: outputs.filter((o) => o.has_checksum).length,
    outputsInPrivateStorage: outputs.filter((o) => o.stored).length,
  });
} finally {
  if (attemptId) {
    const assets = (
      await pool.query(
        `select distinct a.id, a.object_path from assets a
          where a.purpose = 'generation_output' and a.source = 'provider_output'
            and (a.metadata->'generation'->>'attemptId') = $1`,
        [attemptId],
      )
    ).rows;
    await pool.query("delete from generation_attempts where id = $1", [attemptId]);
    if (assets.length) {
      await pool.query("delete from assets where id = any($1::uuid[])", [assets.map((a) => a.id)]);
      try {
        const sink = await createOutputSink({ ...process.env }, "supabase");
        for (const a of assets)
          if (a.object_path) await sink.remove(String(a.object_path)).catch(() => undefined);
      } catch (err) {
        console.log(`storage objects not removed (${(err as Error).name})`);
      }
    }
    const left = (
      await pool.query(
        `select (select count(*)::int from generation_attempts where id = $1) +
                (select count(*)::int from generation_jobs where attempt_id = $1) n`,
        [attemptId],
      )
    ).rows[0].n;
    out.cleanedUp = left === 0;
  }
  console.log(JSON.stringify(out));
  await pool.end();
}
