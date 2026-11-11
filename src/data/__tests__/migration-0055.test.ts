import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0055 (Phase 5B-S2, the AI writing assistant). NOT applied to hosted: behaviour is proven
 * on the disposable local database (scripts/db-story-writing.mts, scripts/db-story-worker-login.mts).
 */
const DIR = "supabase/migrations";
const FILE = "0055_story_writing.sql";
const sql = readFileSync(`${DIR}/${FILE}`, "utf8");
const code = sql.replace(/--.*$/gm, "");
const TABLES = ["script_revisions", "writing_sessions", "writing_proposals", "scene_story_changes"];

describe("migration 0055: AI writing assistant", () => {
  it("follows 0054, and leaves 0051–0054 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files[files.indexOf(FILE) - 1]).toBe("0054_story_proposals.sql");
    const sums: Record<string, string> = {
      "0051_generation_subjects.sql": "1f9ca2000ea666955bd518c848eb41ee58d3cc5bbd4296130ff5e5c8803bb620",
      "0052_character_visual_roles.sql": "3bbbae94ddd0e2bb4a168a4f8c89ba79a1ddb606e931bf701a144e3b20b62698",
      "0053_location_visual_bible.sql": "229eed9903086b2a0e54c22c3b815f22fde9424159c134f9583f39aebaeedad4",
      "0054_story_proposals.sql": "382747f5ec051784b29523fd7940cd3bc59edb523526cc1dd837c6b168f087a8",
    };
    for (const [f, sum] of Object.entries(sums))
      expect(checksumOf(readFileSync(`${DIR}/${f}`, "utf8"))).toBe(sum);
  });

  it("adds four tables with owner-only RLS, no delete policy, and immutability triggers", () => {
    expect(code.match(/\bcreate table\b/gi)).toHaveLength(4);
    for (const t of TABLES) {
      expect(code).toMatch(new RegExp(`create table ${t} \\(`));
      expect(code).toMatch(new RegExp(`alter table ${t} enable row level security`));
      expect(code).toContain(`create policy ${t}_select on ${t}`);
      expect(code).toContain(`create policy ${t}_insert on ${t}`);
    }
    expect(code).not.toMatch(/for delete/i);
    // revisions are insert-only: no update policy, and a trigger refuses every update
    expect(code).not.toContain("create policy script_revisions_update");
    expect(code).toMatch(/create trigger script_revisions_immutable before update/);
    expect(code).toMatch(/create trigger writing_proposals_update_guard before update/);
    expect(code).toMatch(/create trigger writing_proposals_insert_guard before insert/);
    expect(code).toMatch(/reserved writing spend never decreases/);
    // no data change and no existing table altered (except the new FK between the two new tables)
    expect(code).not.toMatch(/\b(drop|delete from|insert into)\b/i);
    expect(
      [...code.matchAll(/alter table (\w+)/g)].map((m) => m[1]).filter((t) => !TABLES.includes(t!)),
    ).toEqual([]);
  });

  it("the Story worker gets writing proposals in flight only, result columns only; no secret anywhere", () => {
    expect(code).not.toMatch(/password|create role/i);
    expect(code).toMatch(/grant select on writing_proposals to prism_story_worker/);
    const update = code.match(/grant update \(([^)]*)\) on writing_proposals to prism_story_worker/)![1]!;
    expect(update).not.toMatch(
      /accepted|saved|decided|instruction|target_text|context|estimate|confirmed|scope/,
    );
    for (const t of ["script_revisions", "writing_sessions", "scene_story_changes"])
      expect(code).not.toMatch(new RegExp(`on ${t}[^;]* to prism_story_worker`));
    expect(code).toMatch(
      /writing_proposals_worker_select on writing_proposals for select to prism_story_worker/,
    );
    expect(code).not.toMatch(/to prism_generation_worker|to prism_continuity_worker/);
  });
});
