// Phase 5B-I5: verifies migration 0053 (Location Visual Bible) on a DISPOSABLE local database only.
//   node --env-file=<disposable env> scripts/db-disposable.mjs reset && db-migrate.mjs && db-seed.mts
//   npx tsx --env-file=<disposable env> scripts/db-location-visual-bible.mts
// Refuses anything but the opt-in loopback disposable target. Every write is rolled back.
import pg from "pg";
import { locationFromRow, locationToRow } from "../src/data/postgres-mapping";
import { AdminRepository } from "../src/data/postgres-repository";
import { locationSchema } from "../src/domain/schemas";

const url = process.env.SUPABASE_DB_URL ?? "";
if (process.env.PRISM_STUDIO_DISPOSABLE_DB !== "1" || !/@127\.0\.0\.1:\d+\/prism_disposable/.test(url)) {
  console.error(
    "db-location-visual-bible refuses: PRISM_STUDIO_DISPOSABLE_DB=1 and a loopback prism_disposable* URL are required.",
  );
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);

async function attempt(sql: string, params: unknown[]): Promise<string | null> {
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
  const col = (
    await pool.query(
      "select data_type, is_nullable, column_default from information_schema.columns where table_name = 'locations' and column_name = 'visual_bible'",
    )
  ).rows[0] as { data_type: string; is_nullable: string; column_default: string } | undefined;
  check(
    "0053 column exists: jsonb, not null, default {}",
    col?.data_type === "jsonb" && col.is_nullable === "NO" && /'\{\}'::jsonb/.test(col.column_default),
    JSON.stringify(col),
  );
  const loc = (await pool.query("select * from locations order by name limit 1")).rows[0] as Record<
    string,
    unknown
  >;
  check("existing Locations read back an empty Visual Bible", JSON.stringify(loc.visual_bible) === "{}");
  const set = (v: unknown) =>
    attempt("update locations set visual_bible = $1::jsonb where id = $2", [JSON.stringify(v), loc.id]);
  const asset = "00000000-0000-4000-8000-000000000001";
  check(
    "a canonical appearance with designations is accepted",
    (await set({
      canonicalAssetId: asset,
      entries: [
        { assetId: asset, role: "establishing", label: "lobby wide" },
        { assetId: asset, role: "variant", label: "night" },
      ],
    })) === null,
  );
  const bad: Array<[string, unknown]> = [
    ["a non-object Visual Bible", []],
    ["a list of canonical images (only ONE canonical key)", { canonicalAssetId: [asset, asset] }],
    ["non-array entries", { entries: { assetId: asset } }],
  ];
  for (const [what, v] of bad) {
    const err = await set(v);
    check(`${what} is refused`, /locations_visual_bible_shape/.test(err ?? ""), err ?? "accepted");
  }
  // the application mapping round-trips through a real row
  const parsed = locationSchema.parse(locationFromRow(loc));
  const row = locationToRow({
    ...parsed,
    visualBible: { canonicalAssetId: asset, entries: [{ assetId: asset, role: "plate", label: "" }] },
  });
  check("the row mapping writes visual_bible as jsonb text", typeof row.visual_bible === "string");
  const absent = locationToRow({ ...parsed, visualBible: undefined });
  check("an absent Visual Bible is never written (the stored value stands)", !("visual_bible" in absent));
  // the application repository round-trips a designation, and a save WITHOUT the field keeps it
  const owner = (
    await pool.query("select p.user_id, p.slug from projects p where p.id = $1", [loc.project_id])
  ).rows[0] as { user_id: string; slug: string };
  const repo = new AdminRepository(pool, owner.user_id);
  try {
    const bible = {
      canonicalAssetId: asset,
      entries: [{ assetId: asset, role: "variant" as const, label: "night" }],
    };
    await repo.upsert(loc.project_id as string, "locations", { ...parsed, visualBible: bible });
    const reloaded = (await repo.loadProject(owner.slug))!.locations.find((l) => l.id === loc.id)!;
    check(
      "the repository stores and reloads the Visual Bible",
      JSON.stringify(reloaded.visualBible) === JSON.stringify(bible),
    );
    const { visualBible: _drop, ...withoutBible } = reloaded;
    void _drop;
    await repo.upsert(loc.project_id as string, "locations", { ...withoutBible, description: "edited" });
    const after = (await repo.loadProject(owner.slug))!.locations.find((l) => l.id === loc.id)!;
    check(
      "editing the Location without the field keeps its Visual Bible",
      after.description === "edited" && JSON.stringify(after.visualBible) === JSON.stringify(bible),
    );
  } finally {
    await pool.query("update locations set visual_bible = '{}'::jsonb, description = $2 where id = $1", [
      loc.id,
      loc.description,
    ]);
  }
} finally {
  await pool.end();
}
const failed = results.filter(([, ok]) => !ok);
for (const [name, ok, detail] of results)
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
