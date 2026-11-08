// Phase 5B-S1: verifies migration 0054 (Production Proposals) on a DISPOSABLE local database only.
//   node --env-file=<disposable env> scripts/db-disposable.mjs reset && db-migrate.mjs && db-seed.mts
//   npx tsx --env-file=<disposable env> scripts/db-story-proposals.mts
// Refuses anything but the opt-in loopback disposable target. Rows it creates are removed at the end.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { rlsPreamble } from "../src/data/postgres-repository";
import { PostgresStoryData, PostgresStoryWorkerStore } from "../src/data/story-postgres";
import { StoryProposalError, type NewStoryProposal } from "../src/data/story-repository";
import { normalizeSourceText, sourceFingerprint, lineCount } from "../src/domain/story/source";
import { proposalFromScreenplay } from "../src/story/providers/fake";

const url = process.env.SUPABASE_DB_URL ?? "";
if (process.env.PRISM_STUDIO_DISPOSABLE_DB !== "1" || !/@127\.0\.0\.1:\d+\/prism_disposable/.test(url)) {
  console.error(
    "db-story-proposals refuses: PRISM_STUDIO_DISPOSABLE_DB=1 and a loopback prism_disposable* URL are required.",
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

/** Runs `sql` as the Story worker role (as the real worker connection would), in its own transaction. */
async function asWorker<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin; set local role prism_story_worker");
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

/** Runs `fn` as a signed-in user (the app's RLS preamble), in its own transaction. */
async function asUser<T>(sub: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(rlsPreamble({ sub }));
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

const created: string[] = [];
try {
  const project = (await pool.query("select id, user_id from projects where slug = 'ojousama'")).rows[0] as {
    id: string;
    user_id: string;
  };
  const owner = new PostgresStoryData(pool, rlsPreamble({ sub: project.user_id }));
  const stranger = new PostgresStoryData(pool, rlsPreamble({ sub: randomUUID() }));
  const script = normalizeSourceText(
    (
      (
        await pool.query("select script_text from episodes where project_id = $1 order by number limit 1", [
          project.id,
        ])
      ).rows[0] as { script_text: string }
    ).script_text,
  );
  const input = (over: Partial<NewStoryProposal> = {}): NewStoryProposal => ({
    id: randomUUID(),
    projectId: project.id,
    parentId: null,
    scope: { kind: "full" },
    sourceKind: "paste",
    sourceAssetId: null,
    sourceEpisodeId: null,
    sourceFingerprint: sourceFingerprint(script),
    sourceMeta: {
      filename: null,
      mime: null,
      byteSize: null,
      checksum: null,
      fileKind: "paste",
      pages: null,
      lineCount: lineCount(script),
      chars: script.length,
    },
    inputText: script,
    title: "Ojou-sama",
    baseProposal: null,
    provider: "prism-test",
    model: "screenplay-parser-v1",
    schemaVersion: "prism.production-proposal.v1",
    promptVersion: "story-analyst-v1",
    estimate: { inputTokens: 1000, maxOutputTokens: 0, usd: 0 },
    confirmedUsd: null,
    createdBy: project.user_id,
    createdAt: new Date().toISOString(),
    ...over,
  });

  // ── create / RLS ──
  const v1 = await owner.create(input());
  created.push(v1.id);
  check("the owner creates a queued proposal (version 1)", v1.status === "queued" && v1.version >= 1);
  const v1b = await owner.create(input());
  created.push(v1b.id);
  check("versions increase per project", v1b.version === v1.version + 1);
  check(
    "a stranger sees nothing",
    (await stranger.list(project.id)).length === 0 && (await stranger.get(project.id, v1.id)) === null,
  );
  check(
    "a stranger cannot insert into another's project",
    (await refused(() => stranger.create(input()), /row-level security|violates/)) === null,
  );

  // ── users never write results ──
  const userWrite = await refused(
    () =>
      asUser(project.user_id, (c) =>
        c.query("update story_proposals set status = 'ready', proposal = '{}' where id = $1", [v1.id]),
      ),
    /only the Story worker|invalid proposal status/,
  );
  check("the owner cannot write a result (status / proposal)", userWrite === null, userWrite ?? "");
  const badInsert = await refused(
    () =>
      pool.query(
        "insert into story_proposals (id, project_id, version, status, scope, source_kind, source_fingerprint, source_meta, input_text, provider, model, schema_version, prompt_version, estimate) values ($1, $2, 999, 'ready', '{\"kind\":\"full\"}', 'paste', $3, '{}', 'x', 'p', 'm', 's', 'p', '{}')",
        [randomUUID(), project.id, "0".repeat(64)],
      ),
    /starts queued|proposal is not null|check constraint/,
  );
  check("a proposal cannot be inserted with a result", badInsert === null, badInsert ?? "");

  // ── the worker role: claim, complete; nothing else ──
  const workerStore = new PostgresStoryWorkerStore(pool);
  const claimed = await asWorker(async (c) =>
    new PostgresStoryWorkerStore(c as unknown as pg.Pool).claim(
      "verify-worker",
      3_000,
      new Date().toISOString(),
    ),
  );
  check(
    "the worker claims the oldest queued proposal",
    claimed?.id === v1.id && claimed?.status === "running",
  );
  const proposal = proposalFromScreenplay(script, "Ojou-sama");
  await asWorker((c) =>
    new PostgresStoryWorkerStore(c as unknown as pg.Pool).complete(v1.id, "verify-worker", {
      proposal,
      usage: { inputTokens: 0, outputTokens: 0 },
      actualUsd: 0,
      providerCalls: 1,
      now: new Date().toISOString(),
    }),
  );
  const ready = (await owner.get(project.id, v1.id))!;
  check(
    "the worker writes the result once (ready)",
    ready.status === "ready" && ready.proposal?.characters.length === proposal.characters.length,
  );
  const workerReview = await refused(
    () => asWorker((c) => c.query("update story_proposals set review = '{}' where id = $1", [v1b.id])),
    /permission denied|does not review/,
  );
  check("the worker cannot write a review", workerReview === null, workerReview ?? "");
  const workerReads = await asWorker((c) =>
    c.query("select count(*)::int as n from characters").then((r) => r.rows[0].n),
  ).catch((e: Error) => e.message);
  check(
    "the worker cannot read project content (Characters)",
    typeof workerReads === "string" && /permission denied/.test(workerReads),
    String(workerReads),
  );
  // the lease (3 s) expires: a finished proposal leaves the worker's reach
  await new Promise((r) => setTimeout(r, 3_500));
  const workerSeesReady = await asWorker((c) =>
    c.query("select 1 from story_proposals where id = $1", [v1.id]).then((r) => r.rowCount),
  );
  check("the worker no longer sees a finished proposal", workerSeesReady === 0);
  void workerStore;

  // ── immutability ──
  const rewrite = await refused(
    () => pool.query("update story_proposals set proposal = '{}' where id = $1", [v1.id]),
    /immutable once written|only the Story worker/,
  );
  check("a written proposal cannot be rewritten", rewrite === null, rewrite ?? "");
  const input2 = await refused(
    () => pool.query("update story_proposals set input_text = 'other' where id = $1", [v1.id]),
    /input is immutable/,
  );
  check("the frozen input cannot change", input2 === null, input2 ?? "");
  const queuedReview = await refused(
    () =>
      owner.saveReview(project.id, v1b.id, {
        version: 1,
        items: {},
        story: {},
        target: { kind: "new_episode" },
      }),
    /not ready/,
  );
  check("a queued proposal cannot be reviewed", queuedReview === null, queuedReview ?? "");
  await owner.saveReview(project.id, v1.id, {
    version: 1,
    items: {},
    story: { title: "edited" },
    target: { kind: "new_episode" },
  });
  check(
    "the owner reviews a ready proposal",
    (await owner.get(project.id, v1.id))!.review?.story.title === "edited",
  );
  await owner.markApplied(project.id, v1.id, { scenes: 6 }, new Date().toISOString());
  const again = await refused(
    () => owner.markApplied(project.id, v1.id, {}, new Date().toISOString()),
    /already applied/,
  );
  check("applied once", again === null, again ?? "");
  const frozen = await refused(
    () =>
      owner.saveReview(project.id, v1.id, {
        version: 1,
        items: {},
        story: {},
        target: { kind: "new_episode" },
      }),
    /already applied/,
  );
  check("an applied proposal's review is frozen", frozen === null, frozen ?? "");
  check(
    "StoryProposalError is the repository's refusal type",
    new StoryProposalError("applied", "x").code === "applied",
  );

  // ── same-project references and deletion ──
  const foreignAsset = await refused(
    () => owner.create(input({ sourceKind: "upload", sourceAssetId: randomUUID() })),
    /document of this project|not in this project|foreign key/,
  );
  check("a source Asset outside the project is refused", foreignAsset === null, foreignAsset ?? "");
  const noDelete = await asUser(project.user_id, (c) =>
    c.query("delete from story_proposals where id = $1", [v1b.id]).then((r) => r.rowCount),
  ).catch(() => -1);
  check(
    "proposals are history (no delete policy for users)",
    noDelete === 0 || noDelete === -1,
    String(noDelete),
  );
  const usesNone = await owner.usesAsset(randomUUID());
  check("usesAsset is false for an unrelated Asset", usesNone === false);
} finally {
  // cleanup: remove the rows this run created (as the table owner; the guard trigger allows deletes)
  if (created.length)
    await pool
      .query("delete from story_proposals where id = any($1::uuid[])", [created])
      .catch(() => undefined);
  await pool.end();
}
const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, detail] of results)
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
