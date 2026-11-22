import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0062 (the account's character library). Behaviour (save, add a copy to another project,
 * cleanup on failure, the cascade when a project is deleted) is covered by character-library.test.ts; the SQL itself
 * (owner-only RLS) was run on a disposable Postgres: see the PR.
 */
const DIR = "supabase/migrations";
const FILE = "0062_character_library.sql";
const sql = readFileSync(`${DIR}/${FILE}`, "utf8");
const code = sql.replace(/--.*$/gm, "").replace(/\s+/g, " ");

describe("migration 0062: the character library", () => {
  it("is the latest migration, follows 0061, and leaves 0061 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe(FILE);
    expect(files.at(-2)).toBe("0061_episode_length.sql");
    expect(checksumOf(readFileSync(`${DIR}/0061_episode_length.sql`, "utf8"))).toBe(
      "9a0f8cf8bf2c76ca717aa03f1788c86f3165f4e78252f4d28d5dc3770534d909",
    );
  });

  it("adds one owner-only table and changes nothing that exists", () => {
    expect(code).toContain("create table if not exists character_library");
    expect(code).toContain("references characters (id) on delete cascade");
    expect(code).toContain("unique (user_id, character_id)");
    expect(code).toContain("enable row level security");
    // every row is the saver's own, for a Character in a project they own
    expect(code.match(/user_id = auth\.uid\(\)/g)).toHaveLength(2);
    expect(code.match(/is_project_owner\(c\.project_id\)/g)).toHaveLength(2);
    expect(code).toContain("grant select, insert, delete on character_library to authenticated");
    expect(code).not.toMatch(/\b(drop|update|alter table (?!character_library)|anon|service_role)\b/i);
  });
});
