// Structural validation of the applied schema (read-only, catalog queries only).
import pg from "pg";

const REF = "lyqdxiyjperhniwhzsvg";
const url = process.env.SUPABASE_DB_URL;
if (!url?.includes(REF))
  throw new Error("SUPABASE_DB_URL does not point at the Prism Studio project; refusing.");
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
const rows = async (sql, p = []) => (await client.query(sql, p)).rows;

const expectedTables = [
  "projects",
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
  "scene_characters",
  "scene_props",
  "dialogue_lines",
  "performance_directions",
  "performance_takes",
  "shots",
  "shot_characters",
  "shot_props",
  "shot_dialogue_lines",
  "shot_reference_assets",
  "storyboard_frames",
  "generation_attempts",
  "continuity_checks",
];
const tables = (await rows("select tablename, rowsecurity from pg_tables where schemaname='public'")).filter(
  (t) => t.tablename !== "prism_migrations",
);
const names = tables.map((t) => t.tablename);
const missing = expectedTables.filter((t) => !names.includes(t));
const unexpected = names.filter((t) => !expectedTables.includes(t));
const noRls = tables.filter((t) => !t.rowsecurity).map((t) => t.tablename);
const policies = await rows("select tablename, policyname from pg_policies where schemaname='public'");
const noPolicy = names.filter((t) => !policies.some((p) => p.tablename === t));
const fks = await rows(
  "select count(*)::int c from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' and contype='f'",
);
const idx = await rows("select indexname from pg_indexes where schemaname='public'");
const trig = await rows(
  "select tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not tgisinternal",
);
const must = {
  indexes: [
    "takes_one_selected_per_line",
    "frames_one_approved_per_shot",
    "attempts_one_approved_per_shot",
    "identity_refs_slot_uniq",
  ],
  triggers: ["dialogue_locked_guard", "attempts_history_guard", "shots_updated", "projects_updated"],
};
const missingIdx = must.indexes.filter((i) => !idx.some((x) => x.indexname === i));
const missingTrig = must.triggers.filter((t) => !trig.some((x) => x.tgname === t));
const fn = await rows(
  "select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('is_project_owner','set_updated_at','guard_locked_dialogue','guard_attempt_history')",
);

console.log({
  tables: names.length,
  missing,
  unexpected,
  withoutRls: noRls,
  withoutPolicy: noPolicy,
  policies: policies.length,
  foreignKeys: fks[0].c,
  indexes: idx.length,
  triggers: trig.length,
  missingIdx,
  missingTrig,
  functions: fn.map((f) => f.proname).sort(),
});
const ok =
  !missing.length &&
  !unexpected.length &&
  !noRls.length &&
  !noPolicy.length &&
  !missingIdx.length &&
  !missingTrig.length &&
  fn.length === 4;
console.log(ok ? "STRUCTURE OK" : "STRUCTURE PROBLEMS");
await client.end();
process.exitCode = ok ? 0 : 1;
