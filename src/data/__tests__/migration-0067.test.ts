import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/** Static checks of migration 0067 (a Character's size of part). Behaviour: character-ai.test.ts. */
const DIR = "supabase/migrations";
const FILE = "0067_character_part_size.sql";
const code = readFileSync(`${DIR}/${FILE}`, "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ");

describe("migration 0067: a Character's size of part", () => {
  it("follows 0066, and leaves 0066 byte-for-byte unchanged (as applied)", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files[files.indexOf(FILE) - 1]).toBe("0066_location_library.sql");
    expect(checksumOf(readFileSync(`${DIR}/0066_location_library.sql`, "utf8"))).toBe(
      "e1d93abe73fffde12dc82bd29003e69e5f4cf1ba133168e1576b5e6f679ab60b",
    );
  });

  it("adds one nullable, checked column and changes nothing else", () => {
    expect(code).toContain("alter table characters add column if not exists part_size text;");
    expect(code).toContain("check (part_size in ('lead', 'supporting', 'minor'))");
    expect(code).not.toMatch(/\bnot null\b|\bdefault\b|\bdrop\b|\bupdate characters\b|\bpolicy\b|\bgrant\b/i);
  });
});
