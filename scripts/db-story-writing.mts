// Phase 5B-S2: verifies migration 0055 (the AI writing assistant) on a DISPOSABLE local database only.
//   node --env-file=<disposable env> scripts/db-disposable.mjs reset && db-migrate.mjs && db-seed.mts
//   npx tsx --env-file=<disposable env> scripts/db-story-writing.mts
// Refuses anything but the opt-in loopback disposable target. Rows it creates are removed at the end.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { rlsPreamble } from "../src/data/postgres-repository";
import { PostgresWritingData, PostgresWritingWorkerStore } from "../src/data/writing-postgres";
import { WritingError, type NewWritingProposal } from "../src/data/writing-repository";
import { sourceFingerprint } from "../src/domain/story/source";
import { canonical, lineRangeOffsets, scopeOf, WRITING_SCHEMA_VERSION } from "../src/domain/story/writing";
import { WRITING_PROMPT_VERSION } from "../src/story/writing-prompt";

const url = process.env.SUPABASE_DB_URL ?? "";
if (process.env.PRISM_STUDIO_DISPOSABLE_DB !== "1" || !/@127\.0\.0\.1:\d+\/prism_disposable/.test(url)) {
  console.error(
    "db-story-writing refuses: PRISM_STUDIO_DISPOSABLE_DB=1 and a loopback prism_disposable* URL are required.",
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

const cleanup = { proposals: [] as string[], sessions: [] as string[] };
try {
  const project = (await pool.query("select id, user_id from projects where slug = 'ojousama'")).rows[0] as {
    id: string;
    user_id: string;
  };
  const episode = (
    await pool.query("select id, script_text from episodes where project_id = $1 order by number limit 1", [
      project.id,
    ])
  ).rows[0] as { id: string; script_text: string };
  const scene6 = (
    await pool.query("select id from scenes where episode_id = $1 and scene_number = '6'", [episode.id])
  ).rows[0] as { id: string };
  const owner = new PostgresWritingData(pool, rlsPreamble({ sub: project.user_id }));
  const stranger = new PostgresWritingData(pool, rlsPreamble({ sub: randomUUID() }));
  const text = canonical(episode.script_text);
  const range = lineRangeOffsets(text, 48, 51);
  const stamp = () => new Date().toISOString();

  // ── sessions + RLS ──
  const session = await owner.createSession({
    id: randomUUID(),
    projectId: project.id,
    episodeId: episode.id,
    title: "",
    createdBy: project.user_id,
    createdAt: stamp(),
  });
  cleanup.sessions.push(session.id);
  check("the owner opens a writing session", session.budgetUsd === 0 && session.reservedUsd === 0);
  check("a stranger sees no session", (await stranger.listSessions(project.id, episode.id)).length === 0);
  const strangerSession = await refused(
    () =>
      stranger.createSession({
        id: randomUUID(),
        projectId: project.id,
        episodeId: episode.id,
        title: "",
        createdBy: null,
        createdAt: stamp(),
      }),
    /row-level security|violates|not in one of your projects|not in this project/,
  );
  check(
    "a stranger cannot open a session in another's project",
    strangerSession === null,
    strangerSession ?? "",
  );

  const proposal = (over: Partial<NewWritingProposal> = {}): NewWritingProposal => ({
    id: randomUUID(),
    projectId: project.id,
    sessionId: session.id,
    episodeId: episode.id,
    parentId: null,
    parentAlternative: null,
    mode: "custom",
    scope: scopeOf(text, "selection", range, scene6.id),
    instruction: "Make Yumeko more guarded.",
    alternativesRequested: 1,
    baseFingerprint: sourceFingerprint(text),
    baseRevisionId: null,
    targetText: text.slice(range.start, range.end),
    draftText: null,
    context: {
      project: "Ojou-sama",
      episode: "Episode 1",
      synopsis: "",
      tone: "",
      scene: null,
      characters: [],
      sceneText: null,
      before: "",
      after: "",
      conversation: [],
    },
    provider: "prism-test",
    model: "screenplay-parser-v1",
    schemaVersion: WRITING_SCHEMA_VERSION,
    promptVersion: WRITING_PROMPT_VERSION,
    estimate: { inputTokens: 1000, maxOutputTokens: 2000, usd: 0.0012 },
    confirmedUsd: null,
    spendAuthorization: "free",
    createdBy: project.user_id,
    createdAt: stamp(),
    ...over,
  });

  // ── capped session budget: atomic reservation, never decreasing ──
  const noBudget = await refused(
    () =>
      owner.createProposal(proposal({ confirmedUsd: 0.0012, spendAuthorization: "session" }), {
        reserveUsd: 0.0012,
        now: stamp(),
      }),
    /allowance/,
  );
  check(
    "without an allowance a session-paid request is refused (nothing stored)",
    noBudget === null,
    noBudget ?? "",
  );
  await owner.authorizeBudget(project.id, session.id, 0.002, new Date(Date.now() + 3_600_000).toISOString());
  const paid = await owner.createProposal(proposal({ confirmedUsd: 0.0012, spendAuthorization: "session" }), {
    reserveUsd: 0.0012,
    now: stamp(),
  });
  cleanup.proposals.push(paid.id);
  const over = await refused(
    () =>
      owner.createProposal(proposal({ confirmedUsd: 0.0012, spendAuthorization: "session" }), {
        reserveUsd: 0.0012,
        now: stamp(),
      }),
    /allowance/,
  );
  const s1 = (await owner.getSession(project.id, session.id))!;
  check(
    "the allowance is reserved per request and never exceeded",
    over === null && Math.abs(s1.reservedUsd - 0.0012) < 1e-9,
    over ?? "",
  );
  const lower = await refused(
    () =>
      as(rlsPreamble({ sub: project.user_id }), (c) =>
        c.query("update writing_sessions set reserved_usd = 0 where id = $1", [session.id]),
      ),
    /never decreases/,
  );
  check("reserved spend can never be reset", lower === null, lower ?? "");

  // ── proposals: users never write results; the worker claims, writes once, cannot decide ──
  const p1 = await owner.createProposal(proposal(), { reserveUsd: null, now: stamp() });
  cleanup.proposals.push(p1.id);
  check("turns increase per session", p1.turn === paid.turn + 1);
  const userResult = await refused(
    () =>
      as(rlsPreamble({ sub: project.user_id }), (c) =>
        c.query("update writing_proposals set result = '{}' where id = $1", [p1.id]),
      ),
    /only the Story worker/,
  );
  check("the owner cannot write a result", userResult === null, userResult ?? "");
  const badInsert = await refused(
    () =>
      owner.createProposal(
        { ...proposal(), spendAuthorization: "free", confirmedUsd: 1 },
        { reserveUsd: null, now: stamp() },
      ),
    /check constraint|violates/,
  );
  check("a free request cannot carry a spend confirmation", badInsert === null, badInsert ?? "");
  // the worker: claim the oldest queued (the paid one first) → fail it, then the free one → complete
  const w = (c: pg.PoolClient) => new PostgresWritingWorkerStore(c as unknown as pg.Pool);
  const firstClaim = await asWorker((c) => w(c).claim("verify-writer", 3_000, stamp()));
  await asWorker((c) =>
    w(c).fail(firstClaim!.id, "verify-writer", {
      error: { code: "not_configured", message: "x" },
      usage: null,
      actualUsd: null,
      providerCalls: 0,
      now: stamp(),
    }),
  );
  const claimed = await asWorker((c) => w(c).claim("verify-writer", 3_000, stamp()));
  check(
    "the worker claims queued writing proposals in order",
    firstClaim?.id === paid.id && claimed?.id === p1.id && claimed?.status === "running",
  );
  const alt = {
    label: "A",
    text: `${p1.targetText}\n\nYumeko holds his gaze, giving nothing away.`,
    explanation: "",
    newCharacterFacts: [],
  };
  await asWorker((c) =>
    w(c).complete(p1.id, "verify-writer", {
      result: { message: "ok", alternatives: [alt], ideas: [] },
      usage: { inputTokens: 0, outputTokens: 0 },
      actualUsd: 0,
      providerCalls: 1,
      now: stamp(),
    }),
  );
  check(
    "the worker writes the result once (ready)",
    (await owner.getProposal(project.id, p1.id))!.status === "ready",
  );
  const workerDecide = await refused(
    () => asWorker((c) => c.query("update writing_proposals set status = 'accepted' where id = $1", [p1.id])),
    /permission denied|does not decide|row-level|0 rows/,
  );
  check("the worker cannot decide a proposal", workerDecide === null, workerDecide ?? "");
  for (const t of ["episodes", "script_revisions", "writing_sessions", "scene_story_changes", "characters"]) {
    const r = await asWorker((c) => c.query(`select count(*) from ${t}`)).then(
      () => "read",
      (e: Error) => e.message,
    );
    check(`the worker cannot read ${t}`, /permission denied/.test(r), r);
  }
  const rewrite = await refused(
    () => pool.query("update writing_proposals set result = '{}' where id = $1", [p1.id]),
    /immutable once written|only the Story worker/,
  );
  check("a written result cannot be rewritten", rewrite === null, rewrite ?? "");
  const input = await refused(
    () => pool.query("update writing_proposals set instruction = 'x' where id = $1", [p1.id]),
    /input is immutable/,
  );
  check("the frozen input cannot change", input === null, input ?? "");

  // ── Accept: baseline + AI revision + scene marker + accepted, in ONE transaction ──
  const next = text.slice(0, range.start) + alt.text + text.slice(range.end);
  const rev = await owner.acceptProposal(project.id, p1.id, 0, {
    id: randomUUID(),
    projectId: project.id,
    episodeId: episode.id,
    origin: "ai_revision",
    text: next,
    fingerprint: sourceFingerprint(next),
    previousText: episode.script_text,
    changedRange: { startLine: 48, endLine: 53 },
    changedSceneIds: [scene6.id],
    flagSceneIds: [scene6.id],
    createdBy: project.user_id,
    createdAt: stamp(),
  });
  const revs = await owner.listRevisions(project.id, episode.id);
  check(
    "Accept records the baseline and the AI revision; the old text is recoverable",
    revs.length === 2 &&
      revs[0]!.id === rev.id &&
      revs[0]!.number === 2 &&
      revs[1]!.origin === "baseline" &&
      revs[1]!.text === episode.script_text,
  );
  check(
    "the proposal is accepted with its revision",
    (await owner.getProposal(project.id, p1.id))!.acceptedRevisionId === rev.id,
  );
  check(
    "the touched Scene is marked story-changed",
    (await owner.openSceneChanges(project.id)).some(
      (c) => c.sceneId === scene6.id && c.revisionId === rev.id,
    ),
  );
  const again = await refused(() => owner.rejectProposal(project.id, p1.id, stamp()), /already accepted/);
  check("a decided proposal is final", again === null, again ?? "");
  const revUpdate = await refused(
    () => pool.query("update script_revisions set text = 'x' where id = $1", [rev.id]),
    /immutable/,
  );
  check("a script revision is immutable (even for the table owner)", revUpdate === null, revUpdate ?? "");
  const userDelete = await as(rlsPreamble({ sub: project.user_id }), (c) =>
    c.query("delete from script_revisions where id = $1", [rev.id]).then((r) => r.rowCount),
  ).catch(() => -1);
  check("revisions cannot be deleted by users", userDelete === 0 || userDelete === -1, String(userDelete));
  await owner.markSceneReviewed(project.id, scene6.id, stamp());
  check(
    "Mark breakdown reviewed closes the marker",
    !(await owner.openSceneChanges(project.id)).some((c) => c.sceneId === scene6.id),
  );
  const reopen = await refused(
    () => pool.query("update scene_story_changes set reviewed_at = null where revision_id = $1", [rev.id]),
    /only marked reviewed, once/,
  );
  check("a reviewed marker stays reviewed", reopen === null, reopen ?? "");

  // ── a brainstorm can never be accepted; a foreign Episode is refused ──
  const brainstorm = await owner.createProposal(proposal({ mode: "brainstorm" }), {
    reserveUsd: null,
    now: stamp(),
  });
  cleanup.proposals.push(brainstorm.id);
  const foreign = await refused(
    () => owner.createProposal(proposal({ episodeId: randomUUID() }), { reserveUsd: null, now: stamp() }),
    /session is not of this Episode|foreign key|not in this project/,
  );
  check("a proposal for another Episode is refused", foreign === null, foreign ?? "");
  check("WritingError is the repository's refusal type", new WritingError("budget", "x").code === "budget");
} finally {
  // cleanup (disposable database, superuser): revisions ↔ proposals reference each other, so the rows this run
  // created are removed in one transaction with triggers (and FK checks) suspended
  const c = await pool.connect();
  try {
    await c.query("begin; set local session_replication_role = replica");
    await c.query(
      "delete from scene_story_changes where revision_id in (select id from script_revisions where episode_id in (select episode_id from writing_sessions where id = any($1::uuid[])))",
      [cleanup.sessions],
    );
    await c.query(
      "delete from script_revisions where episode_id in (select episode_id from writing_sessions where id = any($1::uuid[]))",
      [cleanup.sessions],
    );
    await c.query("delete from writing_proposals where session_id = any($1::uuid[])", [cleanup.sessions]);
    await c.query("delete from writing_sessions where id = any($1::uuid[])", [cleanup.sessions]);
    await c.query("commit");
  } catch {
    await c.query("rollback").catch(() => undefined);
  } finally {
    c.release();
  }
  await pool.end();
}
const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, detail] of results)
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
