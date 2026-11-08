// Phase 5B-I4: verifies migration 0052 (Character Visual Bible invariants) on a DISPOSABLE local database only.
//   node --env-file=<disposable env> scripts/db-disposable.mjs reset && db-migrate.mjs && db-seed.mts
//   npx tsx --env-file=<disposable env> scripts/db-visual-bible.mts
// Refuses anything but the opt-in loopback disposable target (scripts/lib/safety.mjs). Every write is rolled back.
import { randomUUID } from "node:crypto";
import pg from "pg";

const url = process.env.SUPABASE_DB_URL ?? "";
if (process.env.PRISM_STUDIO_DISPOSABLE_DB !== "1" || !/@127\.0\.0\.1:\d+\/prism_disposable/.test(url)) {
  console.error(
    "db-visual-bible refuses: PRISM_STUDIO_DISPOSABLE_DB=1 and a loopback prism_disposable* URL are required.",
  );
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);

async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    return await fn(c);
  } finally {
    await c.query("rollback").catch(() => undefined);
    c.release();
  }
}

try {
  const applied = (
    await pool.query(
      "select 1 from pg_indexes where indexname in ('identity_refs_one_canonical','identity_refs_one_cutout')",
    )
  ).rowCount;
  check("0052 indexes exist", applied === 2);
  const ch = (await pool.query("select id, project_id from characters order by name limit 1")).rows[0] as {
    id: string;
    project_id: string;
  };
  const insert = (c: pg.PoolClient, role: string | null, slot = "additional") =>
    c.query(
      "insert into character_identity_refs (id, project_id, character_id, slot, asset_id, label, metadata, locked) values ($1,$2,$3,$4,null,'t',$5,false)",
      [randomUUID(), ch.project_id, ch.id, slot, JSON.stringify(role ? { visualRole: role } : {})],
    );
  const fails = async (fn: (c: pg.PoolClient) => Promise<unknown>) =>
    inTx(async (c) => {
      try {
        await fn(c);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });
  check(
    "one canonical identity per Character is accepted",
    (await fails(async (c) => insert(c, "canonical"))) === null,
  );
  const twoCanonical = await fails(async (c) => {
    await insert(c, "canonical");
    await insert(c, "canonical");
  });
  check(
    "a second canonical identity is refused",
    /identity_refs_one_canonical/.test(twoCanonical ?? ""),
    twoCanonical ?? "",
  );
  const twoCutouts = await fails(async (c) => {
    await insert(c, "cutout");
    await insert(c, "cutout");
  });
  check("a second cutout is refused", /identity_refs_one_cutout/.test(twoCutouts ?? ""), twoCutouts ?? "");
  check(
    "expressions may repeat",
    (await fails(async (c) => {
      await insert(c, "expression");
      await insert(c, "expression");
    })) === null,
  );
  check(
    "ordinary additional references are unaffected",
    (await fails(async (c) => {
      await insert(c, null);
      await insert(c, null);
      await insert(c, "canonical");
      await insert(c, "cutout");
    })) === null,
  );
} finally {
  await pool.end();
}
const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, detail] of results)
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
