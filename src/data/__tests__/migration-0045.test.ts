import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0045 (Phase 3A.3), which is BUILT but not applied to any database in this phase. The
 * hosted behaviour is covered by db:validate / db:behavior / db:rls / db:worker-role at the 0045 hosted gate.
 */

const DIR = "supabase/migrations";
const sql = readFileSync(`${DIR}/0045_project_qa_direct_video.sql`, "utf8");
const code = sql.replace(/--.*$/gm, ""); // statements only, no comments

describe("migration 0045 — full-video consent for temporal Shot QA", () => {
  it("is the latest migration, follows 0044, and leaves the applied 0044 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe("0045_project_qa_direct_video.sql");
    expect(files.at(-2)).toBe("0044_shot_qa_automation.sql");
    expect(checksumOf(readFileSync(`${DIR}/0044_shot_qa_automation.sql`, "utf8"))).toBe(
      "31abe729026e1c89b9590d9167b2d608b1747de4bae72fdf7bcdb7961b72dcd7",
    );
  });

  it("only adds ONE column to project_qa_policies: no table, no index, no function, no drop", () => {
    const statements = code
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(
      /^alter table project_qa_policies\s+add column direct_video_allowed boolean not null default false$/,
    );
    expect(code).not.toMatch(/\b(create|drop|truncate|delete|update|insert)\b/i);
  });

  it("defaults to false, so no historical policy (including a 3A.2 automatic one) gains full-video consent", () => {
    expect(code).toMatch(/direct_video_allowed boolean not null default false/);
    expect(code).not.toMatch(/default true/i);
  });

  it("changes no access: no grant, no revoke, no policy (owner-only RLS on the table is unchanged)", () => {
    expect(code).not.toMatch(/\b(grant|revoke)\b/i);
    expect(code).not.toMatch(/\bpolicy\b/i);
    expect(code).not.toMatch(/prism_(generation|continuity)_worker|\banon\b|\bpublic\b/i);
  });
});
