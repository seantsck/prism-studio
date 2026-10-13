// Structural validation of the applied schema (read-only, catalog queries only).
import pg from "pg";

import { startScript } from "./lib/safety.mjs";

const url = startScript({ mode: "validate (read-only)" });
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
  "action_blocks",
  "performance_directions",
  "performance_takes",
  "shots",
  "shot_characters",
  "shot_props",
  "shot_dialogue_lines",
  "shot_reference_assets",
  "shot_script_sources",
  "storyboard_frames",
  "generation_attempts",
  "generation_jobs",
  "generation_job_events",
  "generation_outputs",
  "generation_costs",
  "continuity_checks",
  // Phase 2C
  "asset_derivations",
  "attempt_deliveries",
  "continuity_runs",
  "continuity_findings",
  "continuity_overrides",
  // Phase 2D
  "continuity_analysis_jobs",
  "continuity_analysis_costs",
  "continuity_analysis_events",
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
    "shot_reference_assets_order_uq",
    "assets_object_uq",
    "shot_script_sources_action_uq",
    "shot_script_sources_dialogue_uq",
    "generation_jobs_one_active_per_attempt",
    "generation_jobs_claim_idx",
    "generation_outputs_one_primary",
    "generation_costs_one_estimate",
    "generation_costs_one_final",
    "attempts_project_review_idx",
    "asset_derivations_attempt_slot_version",
    "continuity_runs_attempt_idx",
    "continuity_findings_run_idx",
    "continuity_analysis_jobs_one_active_per_run",
    "continuity_analysis_jobs_claim_idx",
    "continuity_analysis_costs_one_estimate",
    "continuity_analysis_costs_one_final",
  ],
  triggers: [
    "dialogue_locked_guard",
    "attempts_history_guard",
    "shots_updated",
    "projects_updated",
    "assets_updated",
    "action_blocks_updated",
    "generation_jobs_guard",
    "generation_jobs_updated",
    "generation_costs_guard",
    "asset_derivations_guard",
    "continuity_runs_guard",
    "continuity_findings_guard",
    "continuity_overrides_guard",
    "continuity_analysis_jobs_guard",
    "continuity_analysis_costs_guard",
    "continuity_analysis_events_guard",
  ],
};
const missingIdx = must.indexes.filter((i) => !idx.some((x) => x.indexname === i));
const missingTrig = must.triggers.filter((t) => !trig.some((x) => x.tgname === t));
const fn = await rows(
  "select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('is_project_owner','set_updated_at','guard_locked_dialogue','guard_attempt_history','storage_object_project_id','guard_generation_job','guard_generation_cost')",
);

// ── column-level + storage + migration-ledger checks ──
const columns = await rows(
  "select table_name, column_name from information_schema.columns where table_schema='public' and table_name in ('assets','shots','performance_takes','storyboard_frames','generation_attempts','dialogue_lines','shot_reference_assets','generation_jobs','generation_outputs','generation_costs','project_bibles','continuity_runs','continuity_analysis_jobs')",
);
const hasCol = (t, c) => columns.some((x) => x.table_name === t && x.column_name === c);
const columnProblems = [
  ...[
    ["assets", "object_path"],
    ["assets", "bucket"],
    ["assets", "storage_provider"],
    ["assets", "purpose"],
    ["assets", "byte_size"],
    ["assets", "created_by"],
    ["assets", "sample_rate"],
    ["performance_takes", "archived"],
    ["performance_takes", "duration_source"],
    ["storyboard_frames", "approved_snapshot"],
    ["generation_attempts", "package_fingerprint"],
    ["generation_attempts", "review_status"],
    ["generation_attempts", "rejection_categories"],
    ["generation_attempts", "prompt_plan"],
    ["generation_attempts", "request"],
    ["generation_attempts", "compatibility"],
    ["generation_attempts", "acknowledged_ignored"],
    ["generation_attempts", "adaptation_plan"],
    ["project_bibles", "delivery_width"],
    ["continuity_runs", "criteria_fingerprint"],
    ["continuity_runs", "external_manifest"],
    ["continuity_analysis_jobs", "lease_token"],
    ["continuity_analysis_jobs", "provider_state"],
    ["generation_jobs", "lease_token"],
    ["generation_jobs", "idempotency_key"],
    ["generation_jobs", "cancel_outcome"],
    ["generation_outputs", "position"],
    ["generation_costs", "kind"],
    ["dialogue_lines", "source_start_line"],
    ["shot_reference_assets", "position"],
  ]
    .filter(([t, c]) => !hasCol(t, c))
    .map(([t, c]) => `missing ${t}.${c}`),
  ...[
    ["shots", "prep_score"],
    ["shots", "ready_to_generate"],
    ["assets", "storage_path"],
    ["assets", "uploaded_at"],
  ]
    .filter(([t, c]) => hasCol(t, c))
    .map(([t, c]) => `stale column still present: ${t}.${c}`),
];

const bucket = (
  await rows(
    "select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'prism-assets'",
  )
)[0];
const storagePolicies = await rows(
  "select policyname, cmd, roles from pg_policies where schemaname='storage' and tablename='objects' and policyname like 'prism_assets_%'",
);
const storageProblems = [];
if (!bucket) storageProblems.push("bucket prism-assets missing");
else {
  if (bucket.public !== false) storageProblems.push("bucket prism-assets is PUBLIC");
  if (!bucket.file_size_limit) storageProblems.push("bucket has no file size limit");
  if (!bucket.allowed_mime_types?.length) storageProblems.push("bucket has no MIME allow-list");
}
for (const cmd of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
  const p = storagePolicies.find((x) => x.cmd === cmd);
  if (!p) storageProblems.push(`storage policy for ${cmd} missing`);
  else if (!String(p.roles).includes("authenticated") || String(p.roles).includes("anon"))
    storageProblems.push(`storage ${cmd} policy has unexpected roles ${p.roles}`);
}
const anyPublicWrite = await rows(
  "select policyname from pg_policies where schemaname='storage' and tablename='objects' and (roles @> '{anon}' or roles @> '{public}') and (qual ilike '%prism-assets%' or with_check ilike '%prism-assets%')",
);
for (const p of anyPublicWrite)
  storageProblems.push(`anon/public policy touches prism-assets: ${p.policyname}`);

const ledger = await rows(
  "select name, checksum, checksum_baseline from public.prism_migrations order by name",
);
const ledgerProblems = ledger.filter((m) => !m.checksum).map((m) => `no checksum for ${m.name}`);

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
  columnProblems,
  storage: bucket
    ? {
        public: bucket.public,
        fileSizeLimit: bucket.file_size_limit,
        mimeTypes: bucket.allowed_mime_types?.length,
      }
    : null,
  storagePolicies: storagePolicies.map((p) => p.cmd).sort(),
  storageProblems,
  migrations: ledger.length,
  ledgerProblems,
});
const ok =
  !missing.length &&
  !unexpected.length &&
  !noRls.length &&
  !noPolicy.length &&
  !missingIdx.length &&
  !missingTrig.length &&
  !columnProblems.length &&
  !storageProblems.length &&
  !ledgerProblems.length &&
  fn.length === 7;
console.log(ok ? "STRUCTURE OK" : "STRUCTURE PROBLEMS");
await client.end();
process.exitCode = ok ? 0 : 1;
