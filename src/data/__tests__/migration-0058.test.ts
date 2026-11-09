import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0058 (Phase 5B-V3, practical Episode editing ON the 2I.1 Episode Edit). NOT applied to
 * hosted: behaviour is proven on the disposable local database (scripts/db-episode-edits.mts, section 9).
 */
const DIR = "supabase/migrations";
const FILE = "0058_episode_edit_v3.sql";
const sql = readFileSync(`${DIR}/${FILE}`, "utf8");
const code = sql.replace(/--.*$/gm, "");

describe("migration 0058: Episode Edit V3 (transitions, titles, saved revisions)", () => {
  it("is the latest migration, follows 0057, and leaves 0043 / 0046 / 0051–0057 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe(FILE);
    expect(files.at(-2)).toBe("0057_shot_direction_proposals.sql");
    expect(checksumOf(readFileSync(`${DIR}/0057_shot_direction_proposals.sql`, "utf8"))).toBe(
      "737b81a115ec186a22c0db0e71ee2114a6d5e59df2029645a0562b46803defa7",
    );
  });

  it("extends the existing edit tables (no second timeline) and adds exactly one table: the saved revisions", () => {
    expect(code.match(/\bcreate table\b/gi)).toHaveLength(1);
    expect(code).toMatch(/create table episode_edit_revisions \(/);
    expect(code).toMatch(/alter table episode_edit_items\s+add column incoming_transition jsonb/);
    expect(code).toMatch(
      /alter table episode_edits\s+add column titles jsonb not null default '\[\]'::jsonb/,
    );
    expect(code).not.toMatch(/drop (table|constraint|column)/i);
    expect(code).not.toMatch(/episode_edit_items_one_per_shot/); // split is deferred: the 2I.1 rule stays
  });

  it("transitions: a shape check plus a DEFERRED commit-time check of the predecessor and both neighbours", () => {
    expect(code).toMatch(/t ->> 'kind' = 'dissolve'/);
    expect(code).toMatch(/between 100 and 2000/);
    expect(code).toMatch(
      /create constraint trigger episode_edit_items_transition_check\s+after insert or update or delete on episode_edit_items deferrable initially deferred/,
    );
    expect(code).toMatch(/\/ 2\.0/); // half of the shorter neighbour
  });

  it("titles: at most one opening and one closing card with real text, 0.5–20 s, a known style", () => {
    expect(code).toMatch(/jsonb_array_length\(t\) <= 2/);
    expect(code).toMatch(/not in \('opening', 'closing'\)/);
    expect(code).toMatch(/not between 500 and 20000/);
    expect(code).toMatch(/not in \('film', 'plain'\)/);
  });

  it("saved revisions: owner SELECT / INSERT only, immutable by trigger, cascade with the edit, no worker grant", () => {
    expect(code).toMatch(/alter table episode_edit_revisions enable row level security/);
    expect(code).toMatch(
      /create policy episode_edit_revisions_owner_select on episode_edit_revisions for select/,
    );
    expect(code).toMatch(
      /create policy episode_edit_revisions_owner_insert on episode_edit_revisions for insert/,
    );
    expect(code).not.toMatch(/on episode_edit_revisions for (update|delete|all)/);
    expect(code).toMatch(/before update on episode_edit_revisions/);
    expect(code).toMatch(/a saved edit revision is immutable/);
    expect(code).toMatch(/references episode_edits \(id, project_id\) on delete cascade/);
    expect(code).toMatch(/unique \(edit_id, number\)/);
    expect(code).not.toMatch(/prism_generation_worker|prism_continuity_worker|prism_story_worker/);
  });
});
