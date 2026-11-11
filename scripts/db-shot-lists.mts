// Phase 5B-S4: verifies migration 0056 (Shot List Proposals) on a DISPOSABLE local database only.
//   node --env-file=<disposable env> scripts/db-disposable.mjs reset && db-migrate.mjs && db-seed.mts
//   npx tsx --env-file=<disposable env> scripts/db-shot-lists.mts
// Refuses anything but the opt-in loopback disposable target. Rows it creates are removed at the end.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { rlsPreamble } from "../src/data/postgres-repository";
import { PostgresShotListData, PostgresShotListWorkerStore } from "../src/data/shot-list-postgres";
import { ShotListError, type NewShotListProposal } from "../src/data/shot-list-repository";
import { sceneSnapshot, SHOT_LIST_SCHEMA_VERSION } from "../src/domain/story/shot-list";
import { defaultShotReview } from "../src/domain/story/shot-list-review";
import { AdminRepository } from "../src/data/postgres-repository";
import { FAKE_STORY_MODEL } from "../src/story/providers/fake";
import { fakeShotPlan } from "../src/story/providers/fake-planner";
import { SHOT_PLANNER_PROMPT_VERSION } from "../src/story/shot-planner-prompt";

const url = process.env.SUPABASE_DB_URL ?? "";
if (process.env.PRISM_STUDIO_DISPOSABLE_DB !== "1" || !/@127\.0\.0\.1:\d+\/prism_disposable/.test(url)) {
  console.error(
    "db-shot-lists refuses: PRISM_STUDIO_DISPOSABLE_DB=1 and a loopback prism_disposable* URL are required.",
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
  const episode = data.episodes[0]!;
  const scene = data.scenes.find((s) => s.episodeId === episode.id && s.sceneNumber === "3")!;
  const snap = sceneSnapshot(data, episode, scene)!;
  const owner = new PostgresShotListData(pool, rlsPreamble({ sub: projectRow.user_id }));
  const stranger = new PostgresShotListData(pool, rlsPreamble({ sub: randomUUID() }));
  const stamp = () => new Date().toISOString();
  const input = (over: Partial<NewShotListProposal> = {}): NewShotListProposal => ({
    id: randomUUID(),
    projectId: projectRow.id,
    episodeId: episode.id,
    sceneId: scene.id,
    parentId: null,
    scope: { kind: "full" },
    basePlan: null,
    episodeFingerprint: snap.episodeFingerprint,
    sceneFingerprint: snap.sceneFingerprint,
    baseRevisionId: null,
    sceneText: snap.sceneText,
    context: snap.context,
    provider: "prism-test",
    model: "screenplay-parser-v1",
    schemaVersion: SHOT_LIST_SCHEMA_VERSION,
    promptVersion: SHOT_PLANNER_PROMPT_VERSION,
    estimate: { inputTokens: 1000, maxOutputTokens: 2000, usd: 0 },
    confirmedUsd: null,
    spendAuthorization: "free",
    createdBy: projectRow.user_id,
    createdAt: stamp(),
    ...over,
  });

  const v1 = await owner.create(input());
  created.push(v1.id);
  check("the owner queues a shot list (version 1 for the Scene)", v1.status === "queued" && v1.version === 1);
  const v1b = await owner.create(input());
  created.push(v1b.id);
  check("versions increase per Scene", v1b.version === 2);
  check("a stranger sees nothing", (await stranger.listForScene(projectRow.id, scene.id)).length === 0);
  const strangerInsert = await refused(
    () => stranger.create(input()),
    /row-level security|violates|not of this Episode|not in one of your projects/,
  );
  check(
    "a stranger cannot queue a shot list in another's project",
    strangerInsert === null,
    strangerInsert ?? "",
  );
  const foreignScene = await refused(
    () =>
      owner.create(
        input({
          sceneId: data.scenes.find((s) => s.episodeId === episode.id && s.sceneNumber === "4")!.id,
          episodeId: randomUUID(),
        }),
      ),
    /not of this Episode|foreign key|referenced row/,
  );
  check("a Scene of another Episode is refused", foreignScene === null, foreignScene ?? "");
  const userResult = await refused(
    () =>
      as(rlsPreamble({ sub: projectRow.user_id }), (c) =>
        c.query("update shot_list_proposals set plan = '{}' where id = $1", [v1.id]),
      ),
    /only the Story worker/,
  );
  check("the owner cannot write a result", userResult === null, userResult ?? "");

  // the worker
  const w = (c: pg.PoolClient) => new PostgresShotListWorkerStore(c as unknown as pg.Pool);
  const claimed = await asWorker((c) => w(c).claim("verify-planner", 3_000, stamp()));
  check(
    "the worker claims the oldest queued shot list",
    claimed?.id === v1.id && claimed?.status === "running",
  );
  const plan = fakeShotPlan({
    model: FAKE_STORY_MODEL,
    context: snap.context,
    sceneText: snap.sceneText,
    scope: { kind: "full" },
    basePlan: null,
    maxOutputTokens: 1,
    validate: () => ({ ok: false, errors: [] }),
  });
  await asWorker((c) =>
    w(c).complete(v1.id, "verify-planner", {
      plan,
      usage: { inputTokens: 0, outputTokens: 0 },
      actualUsd: 0,
      providerCalls: 1,
      now: stamp(),
    }),
  );
  check(
    "the worker writes the plan once (ready)",
    (await owner.get(projectRow.id, v1.id))!.status === "ready",
  );
  const workerReview = await refused(
    () => asWorker((c) => c.query("update shot_list_proposals set review = '{}' where id = $1", [v1.id])),
    /permission denied|does not review/,
  );
  check("the worker cannot review", workerReview === null, workerReview ?? "");
  for (const t of ["shots", "scenes", "characters", "episodes"]) {
    const r = await asWorker((c) => c.query(`select 1 from ${t} limit 1`)).then(
      () => "read",
      (e: Error) => e.message,
    );
    check(`the worker cannot read ${t}`, /permission denied/.test(r), r);
  }
  const rewrite = await refused(
    () => pool.query("update shot_list_proposals set plan = '{}' where id = $1", [v1.id]),
    /immutable once written|only the Story worker/,
  );
  check("a written plan cannot be rewritten", rewrite === null, rewrite ?? "");
  const inputChange = await refused(
    () => pool.query("update shot_list_proposals set scene_text = 'x' where id = $1", [v1.id]),
    /input is immutable/,
  );
  check("the frozen Scene text cannot change", inputChange === null, inputChange ?? "");

  // review → applied once → frozen
  await owner.saveReview(projectRow.id, v1.id, defaultShotReview(plan));
  check(
    "the owner reviews a ready shot list",
    (await owner.get(projectRow.id, v1.id))!.review?.items.length === plan.shots.length,
  );
  await owner.markApplied(projectRow.id, v1.id, { created: 2, replaced: 0 }, stamp());
  const twice = await refused(() => owner.markApplied(projectRow.id, v1.id, {}, stamp()), /already applied/);
  check("applied once", twice === null, twice ?? "");
  const frozen = await refused(
    () => owner.saveReview(projectRow.id, v1.id, defaultShotReview(plan)),
    /already applied/,
  );
  check("an applied shot list's review is frozen", frozen === null, frozen ?? "");
  const queuedReview = await refused(
    () => owner.saveReview(projectRow.id, v1b.id, defaultShotReview(plan)),
    /not ready/,
  );
  check("a queued shot list cannot be reviewed", queuedReview === null, queuedReview ?? "");
  // a one-Shot regeneration needs its parent and base plan
  const noBase = await refused(
    () => owner.create(input({ scope: { kind: "shot", key: "sh1", note: "" } })),
    /check constraint|violates/,
  );
  check("a one-Shot regeneration without its base plan is refused", noBase === null, noBase ?? "");
  const regen = await owner.create(
    input({ parentId: v1.id, scope: { kind: "shot", key: "sh1", note: "" }, basePlan: plan }),
  );
  created.push(regen.id);
  check(
    "a one-Shot regeneration is a new version of the Scene",
    regen.version === 3 && regen.parentId === v1.id,
  );
  const noDelete = await as(rlsPreamble({ sub: projectRow.user_id }), (c) =>
    c.query("delete from shot_list_proposals where id = $1", [v1b.id]).then((r) => r.rowCount),
  ).catch(() => -1);
  check("shot lists are history (no delete policy)", noDelete === 0 || noDelete === -1, String(noDelete));
  check(
    "ShotListError is the repository's refusal type",
    new ShotListError("applied", "x").code === "applied",
  );
} finally {
  if (created.length)
    await pool
      .query(
        "delete from shot_list_proposals where scene_id in (select scene_id from shot_list_proposals where id = any($1::uuid[]))",
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
