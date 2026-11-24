import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/** Static checks of migration 0068 (the Character a merged Character was merged into). Behaviour: character-merge.test.ts. */
const DIR = "supabase/migrations";
const FILE = "0068_character_merged_into.sql";
const code = readFileSync(`${DIR}/${FILE}`, "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ");

describe("migration 0068: the Character a merged Character was merged into", () => {
  it("is the latest migration, follows 0067, and leaves 0067 byte-for-byte unchanged (as applied)", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe(FILE);
    expect(files.at(-2)).toBe("0067_character_part_size.sql");
    expect(checksumOf(readFileSync(`${DIR}/0067_character_part_size.sql`, "utf8"))).toBe(
      "05ba6f3f450fad3da7570dcf45280ee2d843a92c933b59570a3e28c6309e6a55",
    );
  });

  it("adds one nullable link column that is cleared, not cascaded, when the kept Character is deleted", () => {
    expect(code).toContain(
      "alter table characters add column if not exists merged_into_id uuid references characters (id) on delete set null;",
    );
    expect(code).not.toMatch(
      /(?<!\bis )\bnot null\b|\bdefault\b|\bdrop\b|\bdelete from\b|\bpolicy\b|\bgrant\b|\bcascade\b/i,
    );
  });

  it("backfills only trashed Characters with pictures and exactly one live namesake in their project, and only the link", () => {
    expect(code).toContain("update characters t set merged_into_id = (");
    expect(code).toContain("where t.trashed_at is not null and t.merged_into_id is null");
    expect(code).toContain("exists (select 1 from generation_attempts g where g.character_id = t.id)");
    expect(code).toMatch(/\) = 1;\s*$/);
    expect(code.match(/\bupdate\b/gi)).toHaveLength(1);
  });
});
