import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0054 (Phase 5B-S1, Production Proposals). NOT applied to hosted: behaviour is proven on
 * the disposable local database (scripts/db-story-proposals.mts).
 */
const DIR = "supabase/migrations";
const FILE = "0054_story_proposals.sql";
const sql = readFileSync(`${DIR}/${FILE}`, "utf8");
const code = sql.replace(/--.*$/gm, "");

describe("migration 0054: Production Proposals", () => {
  it("is the latest migration, follows 0053, and leaves 0051–0053 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe(FILE);
    expect(files.at(-2)).toBe("0053_location_visual_bible.sql");
    const sums: Record<string, string> = {
      "0051_generation_subjects.sql": "1f9ca2000ea666955bd518c848eb41ee58d3cc5bbd4296130ff5e5c8803bb620",
      "0052_character_visual_roles.sql": "3bbbae94ddd0e2bb4a168a4f8c89ba79a1ddb606e931bf701a144e3b20b62698",
      "0053_location_visual_bible.sql": "229eed9903086b2a0e54c22c3b815f22fde9424159c134f9583f39aebaeedad4",
    };
    for (const [f, sum] of Object.entries(sums))
      expect(checksumOf(readFileSync(`${DIR}/${f}`, "utf8"))).toBe(sum);
  });

  it("adds exactly one table, owner-only RLS without delete, and immutability triggers", () => {
    expect(code.match(/\bcreate table\b/gi)).toHaveLength(1);
    expect(code).toMatch(/create table story_proposals/);
    expect(code).toMatch(/alter table story_proposals enable row level security/);
    for (const p of ["story_proposals_select", "story_proposals_insert", "story_proposals_update"])
      expect(code).toContain(`create policy ${p} on story_proposals`);
    expect(code).not.toMatch(/for delete/i);
    expect(code).toMatch(/create trigger story_proposals_update_guard before update/);
    expect(code).toMatch(/create trigger story_proposals_insert_guard before insert/);
    expect(code).toMatch(/create trigger story_proposals_refs before insert/);
    // no data change, no other table touched
    expect(code).not.toMatch(/\b(drop|delete from|insert into|alter table (?!story_proposals))/i);
  });

  it("the Story worker role is least-privilege: proposals in flight only, result columns only, no secret", () => {
    expect(code).toMatch(/create role prism_story_worker nologin noinherit/);
    expect(code).not.toMatch(/password/i);
    expect(code).toMatch(/grant select on story_proposals to prism_story_worker/);
    const update = code.match(/grant update \(([^)]*)\) on story_proposals to prism_story_worker/)![1]!;
    expect(update).not.toMatch(/review|applied|input_text|source|estimate|confirmed/);
    expect(code).not.toMatch(
      /grant [^;]* on (assets|characters|locations|episodes|scenes|shots)\b[^;]* to prism_story_worker/,
    );
    expect(code).not.toMatch(/to prism_generation_worker|to prism_continuity_worker/);
  });
});
