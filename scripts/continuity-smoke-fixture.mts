// Disposable SYNTHETIC fixture for live continuity-analysis smoke tests.
//   npm run continuity:fixture                    plan + estimate in memory only (no database writes, no network)
//   npm run continuity:fixture -- --create        create the separate project "continuity-semantic-test":
//                                                 a fictional character (identity ref in a grey top, assigned
//                                                 BLACK formal Look, output wearing a clearly RED jacket)
//   npm run continuity:fixture -- --create --mismatch   same, but the output shows a DIFFERENT character
//   npm run continuity:fixture -- --remove        delete it again
//   add --abstract to any of the above to address the ORIGINAL gradient/grid fixture "continuity-smoke-test"
//                                                 (Run 5 history lives there; it is never touched without the flag)
//
// A SEPARATE project (own slug, own rows): the canonical drama is never touched. One criterion pair (identity +
// wardrobe). It sends nothing to any analyzer and spends nothing.
import pg from "pg";
import { AdminRepository } from "../src/data/postgres-repository";
import { createOutputSink } from "../src/generation/sink";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";
import { buildSyntheticFixture, fixtureSlug } from "./lib/continuity-fixture.mts";

const create = process.argv.includes("--create");
const remove = process.argv.includes("--remove");
const mismatch = process.argv.includes("--mismatch");
const variant = process.argv.includes("--abstract") ? ("abstract" as const) : ("semantic" as const);
const FIXTURE_SLUG = fixtureSlug(variant);

const dev = readDevUserEnv();
startScript({
  mode: remove
    ? "REMOVE continuity smoke fixture"
    : create
      ? "CREATE continuity smoke fixture"
      : "plan continuity smoke fixture (memory only)",
  devOwner: dev.id,
});
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 3 });
await assertDevUserExists(pool, dev);
const admin = new AdminRepository(pool, dev.id);

if (remove) {
  const found = (await admin.listProjects()).find((p) => p.slug === FIXTURE_SLUG);
  if (!found) console.log("fixture project not present");
  else {
    const objects = (
      await pool.query("select object_path from assets where project_id = $1 and object_path is not null", [
        found.id,
      ])
    ).rows.map((r) => String(r.object_path));
    await pool.query("delete from generation_attempts where project_id = $1", [found.id]);
    await pool.query("delete from projects where id = $1 and slug = $2 and user_id = $3", [
      found.id,
      FIXTURE_SLUG,
      dev.id,
    ]);
    try {
      const sink = await createOutputSink(process.env as Record<string, string | undefined>, "supabase");
      for (const p of objects) await sink.remove(p).catch(() => undefined);
    } catch {
      console.log("stored objects not removed (no worker Storage credential); they are unreferenced");
    }
    console.log("fixture project removed");
  }
  await pool.end();
  process.exit(0);
}

const fx = buildSyntheticFixture({ userId: dev.id, mismatch, variant });
console.log(
  `fixture: project=${FIXTURE_SLUG} shot=SMOKE-A assets=${fx.data.assets.length} variant=${variant} output=${mismatch ? "DIFFERENT character" : variant === "semantic" ? "same character, red jacket" : "matching reference"}`,
);
if (!create) {
  console.log(
    "plan only: pass --create to write the fixture project (run `npm run continuity:pre-paid:check` for the estimate)",
  );
  await pool.end();
  process.exit(0);
}

if ((await admin.listProjects()).some((p) => p.slug === FIXTURE_SLUG)) {
  console.error("fixture project already exists; remove it first (--remove)");
  await pool.end();
  process.exit(1);
}
const sink = await createOutputSink(process.env as Record<string, string | undefined>, "supabase");
for (const a of fx.data.assets) await sink.put(a.objectPath!, fx.bytes.get(a.id)!, a.mime ?? "image/png");
await admin.createProject(fx.data.project, fx.data.bible);
const PID = fx.data.project.id;
await admin.upsert(PID, "assets", fx.data.assets[0] as never);
await admin.upsert(PID, "assets", fx.data.assets[1] as never);
await admin.upsert(PID, "assets", fx.data.assets[2] as never);
await admin.upsert(PID, "characters", fx.data.characters[0] as never);
await admin.upsert(PID, "identityRefs", fx.data.identityRefs[0] as never);
await admin.upsert(PID, "looks", fx.data.looks[0] as never);
await admin.upsert(PID, "episodes", fx.data.episodes[0] as never);
await admin.upsert(PID, "scenes", fx.data.scenes[0] as never);
await admin.upsert(PID, "shots", fx.data.shots[0] as never);
const a = fx.view.attempt;
await pool.query(
  `insert into generation_attempts (id, project_id, shot_id, attempt_number, provider, model, modality, prompt,
     package_snapshot, status, output_asset_id, review_status, created_by)
   values ($1, $2, $3, 1, 'mock', 'continuity-smoke-fixture', 'image', '', '{}'::jsonb, 'succeeded', $4, 'unreviewed', $5)`,
  [a.id, PID, a.shotId, a.outputAssetId, dev.id],
);
await pool.query(
  `insert into generation_outputs (project_id, attempt_id, asset_id, role, position, provenance)
   values ($1, $2, $3, 'primary', 0, '{"fixture":"continuity-smoke"}'::jsonb)`,
  [PID, a.id, a.outputAssetId],
);
console.log(`fixture created: /projects/${FIXTURE_SLUG}  (Generations → attempt 1 → Continuity)`);
await pool.end();
