import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0046 (Phase 3A.4C). NOT applied to hosted in 3A.4C: its behaviour is proven on a disposable
 * local database by db:validate / db:behavior / db:sequence-continuity / db:media-qa / db:continuity-analysis /
 * db:episode-edits / db:worker-role (docs/local-supabase.md).
 */

const DIR = "supabase/migrations";
const sql = readFileSync(`${DIR}/0046_sequence_continuity_persistence.sql`, "utf8");
const code = sql.replace(/--.*$/gm, ""); // statements only, no comments

describe("migration 0046 — transition persistence and predecessor-bound cut intent", () => {
  it("is the latest migration, follows 0045, and leaves the applied 0045 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe("0046_sequence_continuity_persistence.sql");
    expect(files.at(-2)).toBe("0045_project_qa_direct_video.sql");
    expect(checksumOf(readFileSync(`${DIR}/0045_project_qa_direct_video.sql`, "utf8"))).toBe(
      "44cc9360b867cc1d30b5fa8d758eca311f56b01d3485bb100d235c87d265d325",
    );
  });

  it("destroys nothing: no drop table / column, no truncate, no delete, no rewrite of history", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|column|index|policy|function)\b/i);
    expect(code).not.toMatch(/\b(truncate|delete\s+from)\b/i);
    expect(code).not.toMatch(/^\s*update\s+/im);
    // the only nullability changes: a run's attempt and subject Asset, a job's attempt (guarded by the shape checks)
    expect(code.match(/drop not null/gi)?.length).toBe(3);
  });

  it("every existing run and job becomes an attempt subject; both kinds are checked", () => {
    expect(code.match(/add column subject_kind text not null default 'attempt'/g)?.length).toBe(2);
    expect(code).toMatch(/continuity_runs_subject_shape/);
    expect(code).toMatch(/continuity_analysis_jobs_subject_shape/);
    expect(code).toMatch(/references continuity_runs \(id, project_id, subject_kind\)/);
  });

  it("re-creates both guards with every field they froze before, plus subject_kind", () => {
    const run = code.slice(
      code.indexOf("function guard_continuity_run"),
      code.indexOf("$$;", code.indexOf("function guard_continuity_run")),
    );
    for (const col of [
      "project_id",
      "subject_kind",
      "attempt_id",
      "run_number",
      "subject_asset_id",
      "original_asset_id",
      "analyzer",
      "analyzer_version",
      "analyzer_kind",
      "rules_version",
      "package_fingerprint",
      "subject_fingerprint",
      "criteria_fingerprint",
      "reference_fingerprint",
      "reference_set",
      "analysis_plan",
      "external_manifest",
      "prompt_version",
      "rubric_version",
      "model",
      "automation_key",
    ])
      expect(run, col).toMatch(new RegExp(`new\\.${col} is distinct from old\\.${col}`));
    const job = code.slice(
      code.indexOf("function guard_continuity_analysis_job"),
      code.indexOf("$$;", code.indexOf("function guard_continuity_analysis_job")),
    );
    for (const col of [
      "project_id",
      "run_id",
      "subject_kind",
      "attempt_id",
      "analyzer",
      "model",
      "input_snapshot",
      "input_asset_ids",
      "idempotency_key",
      "created_by",
    ])
      expect(job, col).toMatch(new RegExp(`new\\.${col} is distinct from old\\.${col}`));
  });

  it("the transition subject's edit / item / Shot ids are history, not cascading keys; it goes with its run only", () => {
    const table = code.slice(
      code.indexOf("create table continuity_transition_subjects"),
      code.indexOf(");", code.indexOf("create table continuity_transition_subjects")),
    );
    expect(table).not.toMatch(/references episode_edits|references episode_edit_items|references shots/);
    expect(table).toMatch(/references continuity_runs \(id, project_id, subject_kind\) on delete cascade/);
    expect(table).toMatch(/unique \(project_id, transition_key, run_number\)/);
  });

  it("grants explicitly: authenticated SELECT + INSERT only; nothing for anon or either worker role", () => {
    expect(code).toMatch(/revoke all on continuity_transition_subjects from public, anon, authenticated/);
    expect(code).toMatch(
      /revoke all on continuity_transition_subjects from prism_generation_worker, prism_continuity_worker/,
    );
    expect(code).toMatch(/grant select, insert on continuity_transition_subjects to authenticated/);
    expect(code.match(/\bgrant\b/gi)?.length).toBe(1);
    expect(code).not.toMatch(/to anon|to prism_(generation|continuity)_worker/);
  });

  it("the exactly-one subject and the predecessor rules are evaluated at commit (deferred)", () => {
    expect(code.match(/deferrable initially deferred/g)?.length).toBe(3);
    expect(code).toMatch(/create constraint trigger episode_edit_items_cut_intent_check/);
    // a CHECK passes on NULL: the validator must answer false for a missing field
    expect(code).toMatch(/select i is null or coalesce\(\(/);
  });
});
