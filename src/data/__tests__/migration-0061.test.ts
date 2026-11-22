import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0061 (an Episode's target length). Behaviour (setting a length, and the app working before
 * it is applied) is covered by the repository and series-start tests.
 */
const DIR = "supabase/migrations";
const FILE = "0061_episode_length.sql";
const sql = readFileSync(`${DIR}/${FILE}`, "utf8");
const code = sql.replace(/--.*$/gm, "");

describe("migration 0061: an Episode's target length", () => {
  it("is the latest migration, follows 0060, and leaves 0060 byte-for-byte unchanged (as applied)", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe(FILE);
    expect(files.at(-2)).toBe("0060_project_archive.sql");
    expect(checksumOf(readFileSync(`${DIR}/0060_project_archive.sql`, "utf8"))).toBe(
      "53bb2afcf1617d1d1929600fd1bc322342669f834e1a6884b95291e27a8a4bf2",
    );
  });

  it("adds one nullable, bounded integer to episodes and nothing else (every Episode keeps no length)", () => {
    const statements = code
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toEqual([
      "alter table episodes add column if not exists target_minutes integer check (target_minutes is null or target_minutes between 1 and 600)",
    ]);
    expect(code).not.toMatch(/\b(drop|delete|update|policy|grant|not null|default)\b/i);
  });
});
