// Removes generation attempts made with the MOCK provider (and their output assets + stored files) from the
// dev user's projects. Development/test tidy-up only: real-provider attempts are never touched.
//   npm run db:generation:cleanup -- --yes
import pg from "pg";
import { createOutputSink } from "../src/generation/sink";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({ mode: "generation cleanup (deletes MOCK-provider attempts)", devOwner: dev.id });
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 2 });
await assertDevUserExists(pool, dev);

const attempts = (
  await pool.query(
    `select a.id from generation_attempts a join projects p on p.id = a.project_id
     where p.user_id = $1 and a.provider = 'mock'`,
    [dev.id],
  )
).rows.map((r) => String(r.id));

const assets = attempts.length
  ? (
      await pool.query(
        `select distinct a.id, a.object_path
           from assets a
          where a.purpose = 'generation_output' and a.source = 'provider_output'
            and (a.metadata->'generation'->>'attemptId') = any($1::text[])`,
        [attempts],
      )
    ).rows
  : [];

console.log(`mock attempts: ${attempts.length}, generated assets: ${assets.length}`);
if (!process.argv.includes("--yes")) {
  console.log("dry run; pass --yes to delete");
  await pool.end();
  process.exit(0);
}

if (attempts.length)
  await pool.query("delete from generation_attempts where id = any($1::uuid[])", [attempts]);
if (assets.length) {
  await pool.query("delete from assets where id = any($1::uuid[])", [assets.map((a) => a.id)]);
  try {
    const sinkEnv = { ...process.env };
    sinkEnv.PRISM_STUDIO_TEST_EMAIL ??= process.env.PRISM_STUDIO_DEV_USER_EMAIL;
    sinkEnv.PRISM_STUDIO_WORKER_DEV_STORAGE ??= "1"; // maintenance tool, development only
    const sink = await createOutputSink(sinkEnv, "supabase");
    for (const a of assets)
      if (a.object_path) await sink.remove(String(a.object_path)).catch(() => undefined);
  } catch (err) {
    console.log(`storage objects not removed (${(err as Error).name}); they are unreferenced and harmless`);
  }
}
console.log("done");
await pool.end();
