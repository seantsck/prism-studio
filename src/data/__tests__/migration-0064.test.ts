import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/** Static checks of migration 0064 (Characters and Locations in the Trash). Behaviour: subject-trash.test.ts. */
const DIR = "supabase/migrations";
const FILE = "0064_character_location_trash.sql";
const code = readFileSync(`${DIR}/${FILE}`, "utf8").replace(/--.*$/gm, "");

describe("migration 0064: Characters and Locations in the Trash", () => {
  it("follows 0063, and leaves 0063 byte-for-byte unchanged (as applied)", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files[files.indexOf(FILE) - 1]).toBe("0063_project_trash.sql");
    expect(checksumOf(readFileSync(`${DIR}/0063_project_trash.sql`, "utf8"))).toBe(
      "08b8bb152e5f17adcc8fcd88c9b7dd31b24443301efef969cf667f09440235c1",
    );
  });

  it("adds one nullable timestamp to characters and to locations, and nothing else", () => {
    const statements = code
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toEqual([
      "alter table characters add column if not exists trashed_at timestamptz",
      "alter table locations add column if not exists trashed_at timestamptz",
    ]);
    expect(code).not.toMatch(/\b(drop|delete|update|policy|grant|not null|default)\b/i);
  });
});
