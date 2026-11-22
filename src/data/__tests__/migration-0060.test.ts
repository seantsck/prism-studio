import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0060 (archived projects). Behaviour (archive, restore, the delete cascade under RLS, and
 * the app working before it is applied) is proven on the disposable local database; see docs/persistence.md.
 */
const DIR = "supabase/migrations";
const FILE = "0060_project_archive.sql";
const sql = readFileSync(`${DIR}/${FILE}`, "utf8");
const code = sql.replace(/--.*$/gm, "");

describe("migration 0060: archived projects", () => {
  it("is the latest migration, follows 0059, and leaves 0059 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe(FILE);
    expect(files.at(-2)).toBe("0059_episode_renders.sql");
    expect(checksumOf(readFileSync(`${DIR}/0059_episode_renders.sql`, "utf8"))).toBe(
      "453367af9af3f9f15ffcc3a61ffaff9bd6e2dd4d15bd62cd8a791b3949b661d6",
    );
  });

  it("adds one nullable timestamp to projects and nothing else (every existing project stays active)", () => {
    const statements = code
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toEqual(["alter table projects add column if not exists archived_at timestamptz"]);
    expect(code).not.toMatch(/\b(drop|delete|update|policy|grant|not null|default)\b/i);
  });
});
