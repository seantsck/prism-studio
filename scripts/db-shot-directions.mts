// Phase 5B-S5: verifies migration 0057 (Storyboard Direction Proposals) on a DISPOSABLE local database only.
//   node --env-file=<disposable env> scripts/db-disposable.mjs reset && db-migrate.mjs && db-seed.mts
//   npx tsx --env-file=<disposable env> scripts/db-shot-directions.mts
// Refuses anything but the opt-in loopback disposable target. Rows it creates are removed at the end.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import {
  PostgresShotDirectionData,
  PostgresShotDirectionWorkerStore,
} from "../src/data/shot-direction-postgres";
import { ShotDirectionError, type NewShotDirectionProposal } from "../src/data/shot-direction-repository";
import {
  defaultDirectionReview,
  SHOT_DIRECTION_SCHEMA_VERSION,
  shotSnapshot,
} from "../src/domain/story/shot-direction";
import { fakeDirection } from "../src/story/providers/fake-director";
import { SHOT_DIRECTOR_PROMPT_VERSION } from "../src/story/shot-director-prompt";

const url = process.env.SUPABASE_DB_URL ?? "";
if (process.env.PRISM_STUDIO_DISPOSABLE_DB !== "1" || !/@127\.0\.0\.1:\d+\/prism_disposable/.test(url)) {
  console.error(
    "db-shot-directions refuses: PRISM_STUDIO_DISPOSABLE_DB=1 and a loopback prism_disposable* URL are required.",
  );
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 6 });
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const refused = async (fn: () => Promise<unknown>, pattern: RegExp) => {
  try {
    await fn();
    return "accepted";
  } catch (e) {
    const m = (e as Error).message;
    return pattern.test(m) ? null : m;
  }
};
async function as<T>(setup: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(setup);
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
const asWorker = <T,>(fn: (c: pg.PoolClient) => Promise<T>) =>
  as("begin; set local role prism_story_worker", fn);

const created: string[] = [];
try {
  const projectRow = (await pool.query("select id, user_id from projects where slug = 'ojousama'"))
    .rows[0] as { id: string; user_id: string };
  const data = (await new AdminRepository(pool, projectRow.user_id).loadProject("ojousama"))!;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  const snap = shotSnapshot(data, shot.id)!;
  const owner = new PostgresShotDirectionData(pool, rlsPreamble({ sub: projectRow.user_id }));
  const stranger = new PostgresShotDirectionData(pool, rlsPreamble({ sub: randomUUID() }));
  const stamp = () => new Date().toISOString();
  const input = (over: Partial<NewShotDirectionProposal> = {}): NewShotDirectionProposal => ({
    id: randomUUID(),
    projectId: projectRow.id,
    episodeId: shot.episodeId,
    sceneId: shot.sceneId,
    shotId: shot.id,
    parentId: null,
    instruction: "",
    sceneFingerprint: snap.sceneFingerprint,
    shotFingerprint: snap.shotFingerprint,
    context: snap.context,
    provider: "prism-test",
    model: "screenplay-parser-v1",
    schemaVersion: SHOT_DIRECTION_SCHEMA_VERSION,
    promptVersion: SHOT_DIRECTOR_PROMPT_VERSION,
    estimate: { inputTokens: 1000, maxOutputTokens: 2500, usd: 0 },
    confirmedUsd: null,
    spendAuthorization: "free",
    createdBy: projectRow.user_id,
    createdAt: stamp(),
    ...over,
  });

  const v1 = await owner.create(input());
  created.push(v1.id);
  check("the owner queues a direction (version 1 for the Shot)", v1.status === "queued" && v1.version === 1);
  const v2 = await owner.create(input({ parentId: v1.id, instruction: "more intimate" }));
  created.push(v2.id);
  check(
    "versions increase per Shot (a variant keeps its note)",
    v2.version === 2 && v2.instruction === "more intimate",
  );
  check("a stranger sees nothing", (await stranger.listForShot(projectRow.id, shot.id)).length === 0);
  const strangerInsert = await refused(
    () => stranger.create(input()),
    /row-level security|violates|not of this Scene|not in one of your projects/,
  );
  check(
    "a stranger cannot queue a direction in another's project",
    strangerInsert === null,
    strangerInsert ?? "",
  );
  const otherScene = data.scenes.find((s) => s.id !== shot.sceneId && s.episodeId === shot.episodeId)!;
  const mismatch = await refused(
    () => owner.create(input({ sceneId: otherScene.id })),
    /not of this Scene|referenced row/,
  );
  check("a Shot paired with another Scene is refused", mismatch === null, mismatch ?? "");
  const userResult = await refused(
    () =>
      as(rlsPreamble({ sub: projectRow.user_id }), (c) =>
        c.query("update shot_direction_proposals set direction = '{}' where id = $1", [v1.id]),
      ),
    /only the Story worker/,
  );
  check("the owner cannot write a result", userResult === null, userResult ?? "");

  const w = (c: pg.PoolClient) => new PostgresShotDirectionWorkerStore(c as unknown as pg.Pool);
  const claimed = await asWorker((c) => w(c).claim("verify-director", 3_000, stamp()));
  check(
    "the worker claims the oldest queued direction",
    claimed?.id === v1.id && claimed?.status === "running",
  );
  const direction = fakeDirection(snap.context, "");
  await asWorker((c) =>
    w(c).complete(v1.id, "verify-director", {
      direction,
      usage: { inputTokens: 0, outputTokens: 0 },
      actualUsd: 0,
      providerCalls: 1,
      now: stamp(),
    }),
  );
  check(
    "the worker writes the direction once (ready)",
    (await owner.get(projectRow.id, v1.id))!.status === "ready",
  );
  const workerReview = await refused(
    () =>
      asWorker((c) => c.query("update shot_direction_proposals set review = '{}' where id = $1", [v1.id])),
    /permission denied|does not review/,
  );
  check("the worker cannot review", workerReview === null, workerReview ?? "");
  for (const t of ["shots", "character_looks", "location_views", "characters", "scenes"]) {
    const r = await asWorker((c) => c.query(`select 1 from ${t} limit 1`)).then(
      () => "read",
      (e: Error) => e.message,
    );
    check(`the worker cannot read ${t}`, /permission denied/.test(r), r);
  }
  const rewrite = await refused(
    () => pool.query("update shot_direction_proposals set direction = '{}' where id = $1", [v1.id]),
    /immutable once written|only the Story worker/,
  );
  check("a written direction cannot be rewritten", rewrite === null, rewrite ?? "");
  const inputChange = await refused(
    () =>
      pool.query("update shot_direction_proposals set shot_fingerprint = $2 where id = $1", [
        v1.id,
        "0".repeat(64),
      ]),
    /input is immutable/,
  );
  check("the frozen Shot fingerprint cannot change", inputChange === null, inputChange ?? "");

  await owner.saveReview(projectRow.id, v1.id, {
    ...defaultDirectionReview(),
    edits: { "lighting.key": "Warm chandelier" },
  });
  check(
    "the owner reviews a ready direction",
    (await owner.get(projectRow.id, v1.id))!.review?.edits["lighting.key"] === "Warm chandelier",
  );
  const queuedReview = await refused(
    () => owner.saveReview(projectRow.id, v2.id, defaultDirectionReview()),
    /not ready/,
  );
  check("a queued direction cannot be reviewed", queuedReview === null, queuedReview ?? "");
  await owner.markApplied(projectRow.id, v1.id, { shotId: shot.id, sections: ["camera"] }, stamp());
  const twice = await refused(() => owner.markApplied(projectRow.id, v1.id, {}, stamp()), /already applied/);
  check("applied once", twice === null, twice ?? "");
  const frozen = await refused(
    () => owner.saveReview(projectRow.id, v1.id, defaultDirectionReview()),
    /already applied/,
  );
  check("an applied direction's review is frozen", frozen === null, frozen ?? "");
  const noDelete = await as(rlsPreamble({ sub: projectRow.user_id }), (c) =>
    c.query("delete from shot_direction_proposals where id = $1", [v2.id]).then((r) => r.rowCount),
  ).catch(() => -1);
  check("directions are history (no delete policy)", noDelete === 0 || noDelete === -1, String(noDelete));
  check(
    "ShotDirectionError is the repository's refusal type",
    new ShotDirectionError("applied", "x").code === "applied",
  );
} finally {
  if (created.length)
    await pool
      .query(
        "delete from shot_direction_proposals where shot_id in (select shot_id from shot_direction_proposals where id = any($1::uuid[]))",
        [created],
      )
      .catch(() => undefined);
  await pool.end();
}
const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, detail] of results)
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
