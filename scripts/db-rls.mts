// Integration tests for REAL application RLS behaviour against the dedicated Prism Studio database.
//   npm run db:rls
//
// Two layers are exercised:
//   1. the application repositories (UserRepository = what every request uses; AdminRepository = scripts)
//   2. raw SQL under the exact transaction preamble the app uses (rlsPreamble) — so ownership is proven to be
//      enforced by Postgres policies themselves, not merely by the repository's own checks
// and Storage object policies (bucket prism-assets). Requires `npm run db:seed` first.
// Everything that mutates runs in a transaction that is rolled back; app-level writes clean up after themselves.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { AdminRepository, UserRepository, rlsPreamble } from "../src/data/postgres-repository";
import { buildSeedProject } from "../src/data/seed";
import { assertDevUserExists, readDevUserEnv } from "./lib/dev-user.mjs";
import { startScript } from "./lib/safety.mjs";

const dev = readDevUserEnv();
startScript({ mode: "rls integration tests (reads; writes rolled back/cleaned up)", devOwner: dev.id });
const pool = new pg.Pool({ connectionString: dev.url, ssl: { rejectUnauthorized: false }, max: 4 });
await assertDevUserExists(pool, dev);

/** Order-insensitive structural form (unordered selects may return rows in different order). */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) {
    const items = v.map(canon);
    return items.every((x) => x && typeof x === "object" && "id" in (x as object))
      ? items.sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)))
      : items;
  }
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, canon(x)]),
    );
  return v;
}

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);

const stranger = { sub: randomUUID() }; // authenticated, but owns nothing
const owner = { sub: dev.id };
const slug = buildSeedProject().project.slug;

const admin = new AdminRepository(pool, dev.id);
const asOwner = new UserRepository(pool, owner);
const asStranger = new UserRepository(pool, stranger);

/** Runs one raw statement under an identity, then rolls back. Returns rows or the error message. */
async function raw(
  identity: { sub: string } | null,
  role: "authenticated" | "anon",
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: Record<string, unknown>[]; rowCount: number; error?: string }> {
  const c = await pool.connect();
  try {
    await c.query(rlsPreamble(identity, role));
    await c.query("savepoint t");
    try {
      const r = await c.query(sql, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    } catch (err) {
      return { rows: [], rowCount: 0, error: (err as Error).message };
    }
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

try {
  const project = await admin.loadProject(slug);
  if (!project) throw new Error(`Demo project "${slug}" is not seeded. Run: npm run db:seed`);
  const P = project.project.id;

  // ───── 1. application repositories ─────
  const own = await asOwner.loadProject(slug);
  check("owner: UserRepository loads the project through RLS", own?.project.id === P);
  check(
    "owner: RLS-bound load equals the admin load (same data, all collections)",
    JSON.stringify(canon(own)) === JSON.stringify(canon(project)),
  );
  check(
    "owner: listProjects includes the demo project",
    (await asOwner.listProjects()).some((p) => p.id === P),
  );

  check("stranger: listProjects is empty", (await asStranger.listProjects()).length === 0);
  check(
    "stranger: loadProject(slug) is null (URL guessing exposes nothing)",
    (await asStranger.loadProject(slug)) === null,
  );
  const someAsset = project.assets[0].id;
  check("stranger: findAsset(known id) is null", (await asStranger.findAsset(someAsset)) === null);
  check("owner: findAsset(id) resolves", (await asOwner.findAsset(someAsset))?.id === someAsset);

  const shot = project.shots[0];
  const denied = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return "no error";
    } catch (err) {
      return (err as Error).message;
    }
  };
  const u1 = await denied(() => asStranger.upsert(P, "shots", { ...shot, title: "HACKED" }));
  check(
    "stranger: upsert into another user's project is rejected",
    /not found for the current user/.test(u1),
    u1,
  );
  const u2 = await denied(() => asStranger.remove(P, "shots", shot.id));
  check(
    "stranger: remove from another user's project is rejected",
    /not found for the current user/.test(u2),
    u2,
  );
  const u3 = await denied(() => asStranger.upsertMany(P, "takes", project.takes));
  check("stranger: bulk write is rejected", /not found for the current user/.test(u3), u3);
  const u4 = await denied(() => asStranger.saveBible({ ...project.bible, premise: "HACKED" }));
  check("stranger: bible write is rejected", /not found for the current user/.test(u4), u4);
  const u5 = await denied(() =>
    asStranger.createProject({ ...project.project, userId: dev.id }, project.bible),
  );
  check(
    "stranger: cannot create a project owned by someone else",
    /must belong to the current user/.test(u5),
    u5,
  );
  const after = await admin.loadProject(slug);
  check(
    "data untouched by the rejected writes",
    after?.shots[0].title === shot.title && after?.bible.premise === project.bible.premise,
  );

  // owner write path (and cleanup): create + remove a throw-away asset through the RLS-bound repository
  const probe = {
    ...project.assets[0],
    id: randomUUID(),
    name: "rls-probe.png",
    tags: ["rls-probe"],
  };
  await asOwner.upsert(P, "assets", probe);
  const seen = (await asOwner.loadProject(slug))?.assets.some((a) => a.id === probe.id);
  const strangerSees = await asStranger.findAsset(probe.id);
  await asOwner.remove(P, "assets", probe.id);
  const gone = !(await asOwner.loadProject(slug))?.assets.some((a) => a.id === probe.id);
  check("owner: can create and delete own entities through the repository", Boolean(seen) && gone);
  check("stranger: cannot see an entity the owner just created", strangerSees === null);

  // ───── 2. raw RLS on every project-scoped table ─────
  const scoped = [
    "project_bibles",
    "assets",
    "characters",
    "character_identity_refs",
    "character_looks",
    "voice_profiles",
    "locations",
    "props",
    "episodes",
    "scenes",
    "dialogue_lines",
    "action_blocks",
    "performance_directions",
    "performance_takes",
    "shots",
    "storyboard_frames",
    "generation_attempts",
    "continuity_checks",
  ];
  for (const table of scoped) {
    const mine = await raw(
      owner,
      "authenticated",
      `select count(*)::int n from ${table} where project_id = $1`,
      [P],
    );
    const theirs = await raw(
      stranger,
      "authenticated",
      `select count(*)::int n from ${table} where project_id = $1`,
      [P],
    );
    const anon = await raw(null, "anon", `select count(*)::int n from ${table} where project_id = $1`, [P]);
    const n = (mine.rows[0]?.n as number) ?? -1;
    const seesNothing = (theirs.rows[0]?.n === 0 || theirs.error) && (anon.rows[0]?.n === 0 || anon.error);
    // directions have no project_id column in some deployments; every table here has one (0002).
    check(
      `${table}: owner sees ${n} row(s); stranger and anon see none`,
      n >= 0 && Boolean(seesNothing),
      `${theirs.error ?? ""}${anon.error ?? ""}`,
    );
  }
  const joins: Array<[string, string, string]> = [
    ["shot_characters", "shots", "shot_id"],
    ["shot_props", "shots", "shot_id"],
    ["shot_dialogue_lines", "shots", "shot_id"],
    ["shot_reference_assets", "shots", "shot_id"],
    ["shot_script_sources", "shots", "shot_id"],
    ["scene_characters", "scenes", "scene_id"],
    ["scene_props", "scenes", "scene_id"],
  ];
  for (const [join, parent, key] of joins) {
    const sql = `select count(*)::int n from ${join} j join ${parent} p on p.id = j.${key} where p.project_id = $1`;
    const mine = await raw(owner, "authenticated", sql, [P]);
    const theirs = await raw(stranger, "authenticated", sql, [P]);
    check(
      `${join}: owner sees ${mine.rows[0]?.n} row(s); stranger sees none`,
      (mine.rows[0]?.n as number) >= 0 && theirs.rows[0]?.n === 0,
    );
  }

  // raw writes by a stranger
  const w1 = await raw(
    stranger,
    "authenticated",
    "insert into characters (id, project_id, name) values ($1,$2,'evil')",
    [randomUUID(), P],
  );
  check(
    "stranger: INSERT into another project is denied by RLS",
    /row-level security/.test(w1.error ?? ""),
    w1.error ?? "no error",
  );
  const w2 = await raw(stranger, "authenticated", "update shots set title = 'HACKED' where project_id = $1", [
    P,
  ]);
  check("stranger: UPDATE touches 0 rows", !w2.error && w2.rowCount === 0, w2.error ?? `rows=${w2.rowCount}`);
  const w3 = await raw(stranger, "authenticated", "delete from assets where project_id = $1", [P]);
  check("stranger: DELETE touches 0 rows", !w3.error && w3.rowCount === 0, w3.error ?? `rows=${w3.rowCount}`);
  const w4 = await raw(
    stranger,
    "authenticated",
    "insert into shot_script_sources (shot_id, action_block_id) select $1, id from action_blocks limit 1",
    [shot.id],
  );
  check(
    "stranger: cannot link script sources on another user's shot",
    w4.rowCount === 0 || /row-level security/.test(w4.error ?? ""),
    w4.error ?? "",
  );
  const w5 = await raw(null, "anon", "update projects set title = 'HACKED'");
  check("anon: UPDATE touches 0 rows", w5.rowCount === 0, w5.error ?? "");
  const w6 = await raw(stranger, "authenticated", "update projects set user_id = $1 where id = $2", [
    stranger.sub,
    P,
  ]);
  check(
    "stranger: cannot take over a project by reassigning user_id",
    w6.rowCount === 0,
    w6.error ?? `rows=${w6.rowCount}`,
  );
  const w7 = await raw(owner, "authenticated", "update projects set user_id = $1 where id = $2", [
    stranger.sub,
    P,
  ]);
  check(
    "owner: cannot hand a project to a user id that fails the policy check",
    Boolean(w7.error) || w7.rowCount === 0,
    w7.error ?? `rows=${w7.rowCount}`,
  );

  // ───── 3. Storage object policies (bucket prism-assets) ─────
  const objPath = `${P}/${randomUUID()}/probe.png`;
  const otherProjectPath = `${randomUUID()}/${randomUUID()}/probe.png`;
  const ins = (name: string, bucket = "prism-assets") =>
    [
      "insert into storage.objects (bucket_id, name, owner_id, metadata) values ($1, $2, $3, '{}'::jsonb)",
      [bucket, name, owner.sub],
    ] as const;

  const s1 = await raw(owner, "authenticated", ...ins(objPath));
  check("storage: owner may write inside own project prefix", !s1.error && s1.rowCount === 1, s1.error ?? "");
  const s2 = await raw(stranger, "authenticated", ...ins(objPath));
  check(
    "storage: stranger may NOT write into another project's prefix",
    /row-level security/.test(s2.error ?? ""),
    s2.error ?? "no error",
  );
  const s3 = await raw(owner, "authenticated", ...ins(otherProjectPath));
  check(
    "storage: owner may NOT write under an unowned project prefix",
    /row-level security/.test(s3.error ?? ""),
    s3.error ?? "no error",
  );
  const s4 = await raw(owner, "authenticated", ...ins("../escape/probe.png"));
  check(
    "storage: path-traversal / non-uuid prefix is denied",
    /row-level security/.test(s4.error ?? ""),
    s4.error ?? "no error",
  );
  const s5 = await raw(owner, "authenticated", ...ins(objPath, "some-other-bucket"));
  check(
    "storage: other buckets are not writable through this policy set",
    Boolean(s5.error),
    s5.error ?? "no error",
  );
  const s6 = await raw(null, "anon", ...ins(objPath));
  check("storage: anon may NOT write", Boolean(s6.error), s6.error ?? "no error");

  // read isolation needs a committed object visible to both identities: use one inside a single tx
  {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(...ins(objPath)); // as the privileged connection (bypasses RLS)
      await c.query("savepoint a");
      await c.query(rlsPreamble(owner, "authenticated").replace(/^begin; /, ""));
      const mine = (
        await c.query(
          "select count(*)::int n from storage.objects where bucket_id='prism-assets' and name = $1",
          [objPath],
        )
      ).rows[0].n;
      await c.query("reset role");
      await c.query(rlsPreamble(stranger, "authenticated").replace(/^begin; /, ""));
      const theirs = (
        await c.query(
          "select count(*)::int n from storage.objects where bucket_id='prism-assets' and name = $1",
          [objPath],
        )
      ).rows[0].n;
      await c.query("reset role");
      await c.query(rlsPreamble(null, "anon").replace(/^begin; /, ""));
      const anon = (
        await c.query(
          "select count(*)::int n from storage.objects where bucket_id='prism-assets' and name = $1",
          [objPath],
        )
      ).rows[0].n;
      check(
        "storage: owner reads own object; stranger and anon read nothing",
        mine === 1 && theirs === 0 && anon === 0,
        `owner=${mine} stranger=${theirs} anon=${anon}`,
      );
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  }
} finally {
  await pool.end();
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
