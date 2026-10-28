import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0044 (Phase 3A.2). Applied to hosted DEV on 2026-10-28: the file is now immutable, so
 * its ledger checksum is pinned here. The hosted behaviour is covered by db:validate / db:behavior / db:rls /
 * db:worker-role.
 */

const DIR = "supabase/migrations";
const sql = readFileSync(`${DIR}/0044_shot_qa_automation.sql`, "utf8");
const code = sql.replace(/--.*$/gm, ""); // statements only, no comments

describe("migration 0044 — Shot QA automation", () => {
  it("follows 0043, never touches it, and is itself unchanged since it was applied (ledger checksums)", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files[files.indexOf("0044_shot_qa_automation.sql") - 1]).toBe("0043_episode_edits.sql");
    expect(checksumOf(sql)).toBe("31abe729026e1c89b9590d9167b2d608b1747de4bae72fdf7bcdb7961b72dcd7");
    expect(checksumOf(readFileSync(`${DIR}/0043_episode_edits.sql`, "utf8"))).toBe(
      "9e8e6d0a176aa6a9d7c23388df6a43f46fb362bd1b27e36c714d5c9d94128124",
    );
  });

  it("is forward-only and narrow: one new table, one new run column, one partial unique index, no drops", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|column|index|policy|function)\b/i);
    expect(code.match(/create table/gi)).toHaveLength(1);
    expect(code).toMatch(/create table project_qa_policies/);
    expect(code.match(/alter table\s+(\w+)/gi)!.map((m) => m.split(/\s+/).at(-1))).toEqual([
      "continuity_runs",
      "project_qa_policies",
    ]);
    expect(code).toMatch(/add column automation_key text/);
    expect(code).toMatch(
      /create unique index continuity_runs_automation_key\s+on continuity_runs \(project_id, automation_key\)\s+where automation_key is not null/,
    );
  });

  it("the automatic identity is frozen by the run guard, alongside every 0021/0022 frozen column", () => {
    const guard = code.slice(code.indexOf("create or replace function guard_continuity_run"));
    for (const col of [
      "project_id",
      "attempt_id",
      "subject_asset_id",
      "rules_version",
      "criteria_fingerprint",
      "reference_set",
      "analysis_plan",
      "external_manifest",
      "model",
      "automation_key",
    ])
      expect(guard).toContain(`new.${col} is distinct from old.${col}`);
  });

  it("policy defaults to OFF and automatic must be fully explicit (analyzer, consent, two finite ceilings)", () => {
    expect(code).toMatch(/semantic_mode\s+text not null default 'off'/);
    expect(code).toMatch(/external_media_allowed boolean not null default false/);
    expect(code).toMatch(
      /semantic_mode <> 'automatic'\s+or \(analyzer is not null and external_media_allowed\s+and max_cost_per_run_usd is not null and max_cost_per_day_usd is not null\)/,
    );
    expect(code).toMatch(/max_cost_per_run_usd <= max_cost_per_day_usd/);
    expect(code).toMatch(/revision\s+integer not null default 1 check \(revision >= 1\)/);
  });

  it("owner-only RLS, no anonymous access, and NO grant to either worker role", () => {
    expect(code).toMatch(/alter table project_qa_policies enable row level security/);
    expect(code).toMatch(
      /create policy project_qa_policies_owner on project_qa_policies for all to authenticated\s+using \(is_project_owner\(project_id\)\) with check \(is_project_owner\(project_id\)\)/,
    );
    expect(code).not.toMatch(/\bgrant\b/i);
    for (const role of ["anon", "prism_generation_worker", "prism_continuity_worker"])
      expect(code).toContain(`revoke all on project_qa_policies from ${role};`);
  });
});
