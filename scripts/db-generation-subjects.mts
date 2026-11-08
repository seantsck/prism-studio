// Phase 5B-I1 verifier for migration 0051 (generation subjects): Character / Location image attempts on the existing
// generation tables, through the REAL Postgres repository under RLS. Run against a DISPOSABLE LOCAL database (or a
// rehearsal project) only: it creates rows and removes them. Never against a database the deployed owner-review build
// still reads (that build assumes every attempt has a Shot).
//   node --env-file=.env.disposable node_modules/tsx/dist/cli.mjs scripts/db-generation-subjects.mts
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresGenerationData } from "../src/data/generation-postgres";
import { AdminRepository, rlsPreamble } from "../src/data/postgres-repository";
import { readGenerationConfig } from "../src/generation/config";
import { createRegistry } from "../src/generation/registry";
import { prepareSubjectImage } from "../src/generation/subject-submission";
import { WORKER_ROLE } from "./lib/worker-role-spec.mjs";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({ mode: "generation subjects (0051) verifier — rows created, then removed", devOwner: dev.id });
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 4 });
await assertDevUserExists(pool, dev);

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);
const env = {
  NODE_ENV: "test",
  PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
  PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
};
const config = readGenerationConfig(env);
const registry = createRegistry(env, config);
const admin = new AdminRepository(pool, dev.id);
const owner = new PostgresGenerationData(pool, rlsPreamble({ sub: dev.id }));
const stranger = new PostgresGenerationData(pool, rlsPreamble({ sub: randomUUID() }));
const created: string[] = [];

async function sqlFails(sql: string, params: unknown[]): Promise<string | null> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(sql, params);
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

try {
  const data = (await admin.loadProject("ojousama"))!;
  const pid = data.project.id;
  const character = data.characters[0]!;
  const location = data.locations[0]!;
  const shotHistoryBefore = data.attempts.length;
  const prepare = (
    subject: Parameters<typeof prepareSubjectImage>[0]["input"]["subject"],
    key = `subj-${randomUUID()}`,
  ) => {
    const p = prepareSubjectImage({
      data,
      input: { subject, direction: "" },
      registry,
      provider: "mock",
      modelId: "mock-image-1",
      aspectRatio: "1:1",
      userId: dev.id,
      idempotencyKey: key,
      config,
    });
    if (!p.ok) throw new Error(p.reasons.join(" · "));
    return p.input;
  };

  // ── owner path through the real repository (RLS) ──
  const inputA = prepare({ kind: "character", characterId: character.id, intent: "portrait" });
  const a = await owner.createSubjectImageAttempt(inputA);
  created.push(a.attempt.id);
  check(
    "owner creates a Character image attempt (number 1, no shot)",
    a.attempt.attemptNumber === 1 && a.attempt.shotId === null && a.attempt.characterId === character.id,
  );
  const replay = await owner.createSubjectImageAttempt(inputA);
  check("idempotent replay returns the same attempt", replay.duplicate && replay.attempt.id === a.attempt.id);
  const b = await owner.createSubjectImageAttempt(
    prepare({ kind: "character", characterId: character.id, intent: "look_sheet" }),
  );
  created.push(b.attempt.id);
  check("numbered per subject (second Character image is 2)", b.attempt.attemptNumber === 2);
  const l = await owner.createSubjectImageAttempt(
    prepare({ kind: "location", locationId: location.id, intent: "background" }),
  );
  created.push(l.attempt.id);
  check(
    "a Location image attempt starts at 1 for that Location",
    l.attempt.attemptNumber === 1 && l.attempt.locationId === location.id,
  );
  const listed = await owner.listSubjectImageAttempts({ kind: "character", characterId: character.id });
  check(
    "listing returns only that Character's attempts, newest first",
    listed.map((v) => v.attempt.attemptNumber).join(",") === "2,1",
  );
  const job = (
    await pool.query("select status, estimated_cost from generation_jobs where attempt_id = $1", [
      a.attempt.id,
    ])
  ).rows[0];
  check("the job is queued on the existing generation_jobs table", job?.status === "queued");

  // ── Shot history unaffected ──
  const reloaded = (await admin.loadProject("ojousama"))!;
  check(
    "project load (Shot history) never includes subject attempts",
    reloaded.attempts.length === shotHistoryBefore && !reloaded.attempts.some((x) => created.includes(x.id)),
  );
  const rows = await owner.listProjectGenerations(pid, {});
  check("the project generations listing stays Shot-only", !rows.some((r) => created.includes(r.attempt.id)));

  // ── 0051 migration-compatibility gate: Shot readers given a subject id ──
  check(
    "the Shot attempt view says 'not found' for a subject id",
    (await owner.getAttemptView(a.attempt.id)) === null,
  );
  check(
    "review (a Shot act) says 'not found' for a subject id",
    (await owner.reviewAttempt(a.attempt.id, {
      status: "approved",
      categories: [],
      reason: "",
      notes: "",
      now: new Date().toISOString(),
    })) === null,
  );
  let crossKind = "";
  try {
    const shot = data.shots[0]!;
    await owner.createAttemptWithJob({
      attempt: { ...(reloaded.attempts[0] ?? ({} as never)), id: randomUUID(), shotId: shot.id },
      job: {
        id: randomUUID(),
        idempotencyKey: inputA.job.idempotencyKey,
        maxAttempts: 1,
        queuePriority: 0,
        currency: "USD",
      },
      estimate: inputA.estimate,
      expectedShotUpdatedAt: shot.updatedAt,
      expectedProjectRevision: null,
      limits: inputA.limits,
      now: new Date().toISOString(),
    } as never);
  } catch (e) {
    crossKind = (e as Error).message;
  }
  check(
    "a Shot submission reusing a subject's key is refused cleanly",
    /belongs to another generation/.test(crossKind),
    crossKind.slice(0, 80),
  );

  // ── RLS: strangers and anon see nothing; strangers cannot create in someone else's project ──
  check(
    "a stranger lists nothing",
    (await stranger.listSubjectImageAttempts({ kind: "character", characterId: character.id })).length === 0,
  );
  check("a stranger cannot read the attempt", (await stranger.getSubjectImageAttempt(a.attempt.id)) === null);
  let strangerErr = "";
  try {
    await stranger.createSubjectImageAttempt(
      prepare({ kind: "character", characterId: character.id, intent: "portrait" }),
    );
  } catch (e) {
    strangerErr = (e as Error).message;
  }
  check("a stranger cannot create in the owner's project", strangerErr.length > 0, strangerErr.slice(0, 80));

  // ── constraints ──
  const base = (await pool.query("select * from generation_attempts where id = $1", [a.attempt.id])).rows[0];
  const cols = Object.keys(base).filter(
    (k) => !["id", "attempt_number", "shot_id", "character_id", "location_id"].includes(k),
  );
  const insertWith = (over: Record<string, unknown>) => {
    const row = {
      ...Object.fromEntries(cols.map((k) => [k, base[k]])),
      id: randomUUID(),
      attempt_number: 99,
      shot_id: null,
      character_id: null,
      location_id: null,
      ...over,
    };
    const keys = Object.keys(row);
    return sqlFails(
      `insert into generation_attempts (${keys.map((k) => `"${k}"`).join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
      keys.map((k) =>
        typeof row[k] === "object" && row[k] !== null && !Array.isArray(row[k])
          ? JSON.stringify(row[k])
          : row[k],
      ),
    );
  };
  check("no subject is refused", /one_subject/.test((await insertWith({})) ?? ""));
  check(
    "two subjects are refused",
    /one_subject/.test((await insertWith({ character_id: character.id, location_id: location.id })) ?? ""),
  );
  check(
    "a subject attempt must be an image",
    /subject_is_image/.test((await insertWith({ character_id: character.id, modality: "video" })) ?? ""),
  );
  check(
    "a subject attempt can never be approved",
    /subject_never_approved|approved/.test(
      (await insertWith({ character_id: character.id, approved: true, review_status: "approved" })) ?? "",
    ),
  );
  const otherProject = randomUUID();
  check(
    "a Character of another project is refused (composite foreign key)",
    /character_fk|violates foreign key/.test(
      (await insertWith({ project_id: otherProject, character_id: character.id })) ?? "",
    ),
  );
  check(
    "the per-Character attempt number is unique",
    /attempts_character_number|duplicate key/.test(
      (await insertWith({ character_id: character.id, attempt_number: 1 })) ?? "",
    ),
  );
  check(
    "the subject is immutable (append-only guard)",
    /append-only/.test(
      (await sqlFails("update generation_attempts set character_id = null, location_id = $2 where id = $1", [
        a.attempt.id,
        location.id,
      ])) ?? "",
    ),
  );
  check(
    "execution fields still change (status)",
    (await sqlFails("update generation_attempts set status = 'running' where id = $1", [a.attempt.id])) ===
      null,
  );

  // ── the worker role reads subject attempts (it claims them like any job) ──
  const wc = await pool.connect();
  try {
    await wc.query(`begin; set local role ${WORKER_ROLE}`);
    const seen = (
      await wc.query("select id, character_id from generation_attempts where id = $1", [a.attempt.id])
    ).rows;
    check(
      "the worker role can read a subject attempt",
      seen.length === 1 && seen[0].character_id === character.id,
    );
  } finally {
    await wc.query("rollback").catch(() => undefined);
    wc.release();
  }

  // ── deleting the subject cascades its attempts, inside a rolled-back transaction ──
  const cc = await pool.connect();
  try {
    await cc.query("begin");
    await cc.query("delete from characters where id = $1", [character.id]);
    const left = (
      await cc.query("select count(*)::int n from generation_attempts where character_id = $1", [
        character.id,
      ])
    ).rows[0].n;
    check("deleting a Character removes its image attempts (cascade)", left === 0);
  } finally {
    await cc.query("rollback").catch(() => undefined);
    cc.release();
  }
} finally {
  if (created.length)
    await pool.query("delete from generation_attempts where id = any($1::uuid[])", [created]);
  const left = (
    await pool.query("select count(*)::int n from generation_attempts where id = any($1::uuid[])", [created])
  ).rows[0].n;
  check("cleanup removed every row this run created", left === 0);
  await pool.end();
}
const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, detail] of results)
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
