import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/** Static checks of migration 0070 (animated Characters: an art style, and the Character a likeness comes from). */
const DIR = "supabase/migrations";
const FILE = "0070_character_art_style.sql";
const code = readFileSync(`${DIR}/${FILE}`, "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ");

describe("migration 0070: animated Characters", () => {
  it("follows 0069, and leaves 0069 byte-for-byte unchanged (as applied)", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files[files.indexOf(FILE) - 1]).toBe("0069_project_cover_art.sql");
    expect(checksumOf(readFileSync(`${DIR}/0069_project_cover_art.sql`, "utf8"))).toBe(
      "07b96d96d43459454dd16019d76b59a44eac60be86ee4553c0db67f37294e3ff",
    );
  });

  it("adds two nullable columns; the likeness link is cleared, not cascaded, when that Character is deleted", () => {
    expect(code).toContain("alter table characters add column if not exists art_style text;");
    expect(code).toContain(
      "alter table characters add column if not exists likeness_from_id uuid references characters (id) on delete set null;",
    );
    expect(code).not.toMatch(
      /\bnot null\b|\bdefault\b|\bdrop\b|\bupdate\b|\bdelete from\b|\bpolicy\b|\bgrant\b|\bcascade\b/i,
    );
  });
});
