import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0052 (Phase 5B-I4, Character Visual Bible invariants). NOT applied to hosted: behaviour
 * is proven on the disposable local database (scripts/db-visual-bible.mts).
 */
const DIR = "supabase/migrations";
const FILE = "0052_character_visual_roles.sql";
const code = readFileSync(`${DIR}/${FILE}`, "utf8").replace(/--.*$/gm, "");

describe("migration 0052: Character Visual Bible roles", () => {
  it("follows 0051 and leaves 0051 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files[files.indexOf(FILE) - 1]).toBe("0051_generation_subjects.sql");
    expect(checksumOf(readFileSync(`${DIR}/0051_generation_subjects.sql`, "utf8"))).toBe(
      "1f9ca2000ea666955bd518c848eb41ee58d3cc5bbd4296130ff5e5c8803bb620",
    );
  });

  it("is exactly two partial unique indexes: one canonical and one cutout per Character", () => {
    const statements = code
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toEqual([
      "create unique index identity_refs_one_canonical on character_identity_refs (character_id) where metadata ->> 'visualRole' = 'canonical'",
      "create unique index identity_refs_one_cutout on character_identity_refs (character_id) where metadata ->> 'visualRole' = 'cutout'",
    ]);
  });
});
