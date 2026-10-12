// Seeds the demo project into the dedicated Prism Studio database, owned by the real dev Auth user.
//   npx tsx --env-file=.env.local scripts/db-seed.mts            # skip if already seeded
//   npx tsx --env-file=.env.local scripts/db-seed.mts --reset    # delete the demo project (cascades) and re-seed
import pg from "pg";
import { AdminRepository } from "../src/data/postgres-repository";
import { buildSeedProject } from "../src/data/seed";

import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv(); // validates ref + UUID before any query
const url = startScript({
  mode: process.argv.includes("--reset") ? "seed --reset (replaces the demo project)" : "seed",
  devOwner: dev.id,
});
const owner = dev.id;

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
try {
  await assertDevUserExists(pool, dev);
  const seed = buildSeedProject();
  const repo = new AdminRepository(pool, owner);
  const reset = process.argv.includes("--reset");

  const existing = await repo.loadProject(seed.project.slug);
  if (existing && !reset) {
    console.log(
      `"${seed.project.slug}" already seeded (${existing.shots.length} shots). Use --reset to rebuild.`,
    );
  } else {
    if (existing) {
      // Only ever the demo project, scoped by owner and id.
      await pool.query("delete from projects where id = $1 and user_id = $2", [existing.project.id, owner]);
      console.log("removed existing demo project");
    }
    const pid = seed.project.id;
    await repo.createProject({ ...seed.project, userId: owner }, seed.bible);
    // Dependency order: looks → episodes, takes → voice profiles/assets, shots → everything above.
    await repo.upsertMany(pid, "assets", seed.assets);
    await repo.upsertMany(pid, "characters", seed.characters);
    await repo.upsertMany(pid, "episodes", seed.episodes);
    await repo.upsertMany(pid, "looks", seed.looks);
    await repo.upsertMany(pid, "identityRefs", seed.identityRefs);
    await repo.upsertMany(pid, "voiceProfiles", seed.voiceProfiles);
    await repo.upsertMany(pid, "locations", seed.locations);
    await repo.upsertMany(pid, "props", seed.props);
    await repo.upsertMany(pid, "scenes", seed.scenes);
    await repo.upsertMany(pid, "dialogueLines", seed.dialogueLines);
    await repo.upsertMany(pid, "actionBlocks", seed.actionBlocks);
    await repo.upsertMany(pid, "shots", seed.shots);
    await repo.upsertMany(pid, "directions", seed.directions);
    await repo.upsertMany(pid, "takes", seed.takes);
    await repo.upsertMany(pid, "frames", seed.frames);
    await repo.upsertMany(pid, "attempts", seed.attempts);
    await repo.upsertMany(pid, "continuityChecks", seed.continuityChecks);
    const check = await repo.loadProject(seed.project.slug);
    console.log("seeded:", {
      shots: check?.shots.length,
      lines: check?.dialogueLines.length,
      takes: check?.takes.length,
      frames: check?.frames.length,
      attempts: check?.attempts.length,
    });
  }
} finally {
  await pool.end();
}
