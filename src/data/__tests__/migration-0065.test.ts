import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/** Static checks of migration 0065 (the account's own Characters project). Behaviour: standalone-character.test.ts. */
const DIR = "supabase/migrations";
const FILE = "0065_character_studio_project.sql";
const code = readFileSync(`${DIR}/${FILE}`, "utf8").replace(/--.*$/gm, "");

describe("migration 0065: a project of purpose `library`", () => {
  it("follows 0064, and leaves 0064 byte-for-byte unchanged (as applied)", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files[files.indexOf(FILE) - 1]).toBe("0064_character_location_trash.sql");
    expect(checksumOf(readFileSync(`${DIR}/0064_character_location_trash.sql`, "utf8"))).toBe(
      "ee10d2d219157e4e33f8a82a4df35b85ffdf4874252a2c18dd104aae3908ab95",
    );
  });

  it("only widens the purpose check (every value it allowed before is still allowed)", () => {
    const statements = code
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toEqual([
      "alter table projects drop constraint if exists projects_purpose_check",
      "alter table projects add constraint projects_purpose_check check (purpose in ('production', 'benchmark', 'test', 'library'))",
    ]);
    expect(code).not.toMatch(/\b(delete|update|policy|grant|default)\b/i);
  });
});
