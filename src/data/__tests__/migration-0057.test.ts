import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0057 (Phase 5B-S5, Storyboard Direction Proposals). NOT applied to hosted: behaviour is
 * proven on the disposable local database (scripts/db-shot-directions.mts).
 */
const DIR = "supabase/migrations";
const FILE = "0057_shot_direction_proposals.sql";
const sql = readFileSync(`${DIR}/${FILE}`, "utf8");
const code = sql.replace(/--.*$/gm, "");

describe("migration 0057: Storyboard Direction Proposals", () => {
  it("follows 0056, and leaves 0051–0056 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files[files.indexOf(FILE) - 1]).toBe("0056_shot_list_proposals.sql");
    const sums: Record<string, string> = {
      "0051_generation_subjects.sql": "1f9ca2000ea666955bd518c848eb41ee58d3cc5bbd4296130ff5e5c8803bb620",
      "0052_character_visual_roles.sql": "3bbbae94ddd0e2bb4a168a4f8c89ba79a1ddb606e931bf701a144e3b20b62698",
      "0053_location_visual_bible.sql": "229eed9903086b2a0e54c22c3b815f22fde9424159c134f9583f39aebaeedad4",
      "0054_story_proposals.sql": "382747f5ec051784b29523fd7940cd3bc59edb523526cc1dd837c6b168f087a8",
      "0055_story_writing.sql": "5de7cc21db73922b4473718a29b08a7f7a63770e45b775ad9134a9aa1afb3bd3",
      "0056_shot_list_proposals.sql": "01d2452bab12641bbc7883d0b0bfdf131a5f80cc8acd43cae15750c88d6b5859",
    };
    for (const [f, sum] of Object.entries(sums))
      expect(checksumOf(readFileSync(`${DIR}/${f}`, "utf8"))).toBe(sum);
  });

  it("adds exactly one versioned table per Shot with owner-only RLS, no delete, and immutability triggers", () => {
    expect(code.match(/\bcreate table\b/gi)).toHaveLength(1);
    expect(code).toMatch(/create table shot_direction_proposals \(/);
    expect(code).toMatch(/shot_id\s+uuid not null references shots \(id\) on delete cascade/);
    expect(code).toMatch(/unique \(shot_id, version\)/);
    for (const p of ["select", "insert", "update"])
      expect(code).toContain(`create policy shot_direction_proposals_${p} on shot_direction_proposals`);
    expect(code).not.toMatch(/for delete/i);
    for (const t of ["refs before insert", "insert_guard before insert", "update_guard before update"])
      expect(code).toContain(`create trigger shot_direction_proposals_${t}`);
    // never changes a Shot and alters no existing table (no S5-only Shot columns)
    expect(code).not.toMatch(/\b(drop|delete from|insert into|alter table (?!shot_direction_proposals\b))/i);
    expect(code).not.toMatch(/update shots|alter table shots/i);
  });

  it("the Story worker: directions in flight only, result columns only; no secret", () => {
    expect(code).not.toMatch(/password|create role/i);
    expect(code).toMatch(/grant select on shot_direction_proposals to prism_story_worker/);
    const update = code.match(
      /grant update \(([^)]*)\) on shot_direction_proposals to prism_story_worker/,
    )![1]!;
    expect(update).not.toMatch(/review|applied|context|instruction|estimate|confirmed|fingerprint/);
    expect(code).not.toMatch(
      /grant [^;]* on (shots|scenes|characters|locations|character_looks|location_views)\b[^;]* to prism_story_worker/,
    );
    expect(code).not.toMatch(/to prism_generation_worker|to prism_continuity_worker/);
  });
});
