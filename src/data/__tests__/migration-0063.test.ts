import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/** Static checks of migration 0063 (projects in the Trash). Behaviour is covered by project-trash.test.ts. */
const DIR = "supabase/migrations";
const FILE = "0063_project_trash.sql";
const code = readFileSync(`${DIR}/${FILE}`, "utf8").replace(/--.*$/gm, "");

describe("migration 0063: projects in the Trash", () => {
  it("follows 0062, and leaves 0062 byte-for-byte unchanged (as applied)", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files[files.indexOf(FILE) - 1]).toBe("0062_character_library.sql");
    expect(checksumOf(readFileSync(`${DIR}/0062_character_library.sql`, "utf8"))).toBe(
      "494469e8f1ea9bc74a2a2aaf8104a1aacd3921879dab884e1619338024aa18bf",
    );
  });

  it("adds one nullable timestamp to projects and nothing else (no existing project is in the Trash)", () => {
    const statements = code
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toEqual(["alter table projects add column if not exists trashed_at timestamptz"]);
    expect(code).not.toMatch(/\b(drop|delete|update|policy|grant|not null|default)\b/i);
  });
});
