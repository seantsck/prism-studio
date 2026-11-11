import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0053 (Phase 5B-I5, Location Visual Bible). NOT applied to hosted: behaviour is proven on
 * the disposable local database (scripts/db-location-visual-bible.mts).
 */
const DIR = "supabase/migrations";
const FILE = "0053_location_visual_bible.sql";
const code = readFileSync(`${DIR}/${FILE}`, "utf8").replace(/--.*$/gm, "");

describe("migration 0053: Location Visual Bible", () => {
  it("follows 0052 and leaves 0051 and 0052 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files[files.indexOf(FILE) - 1]).toBe("0052_character_visual_roles.sql");
    expect(checksumOf(readFileSync(`${DIR}/0051_generation_subjects.sql`, "utf8"))).toBe(
      "1f9ca2000ea666955bd518c848eb41ee58d3cc5bbd4296130ff5e5c8803bb620",
    );
    expect(checksumOf(readFileSync(`${DIR}/0052_character_visual_roles.sql`, "utf8"))).toBe(
      "3bbbae94ddd0e2bb4a168a4f8c89ba79a1ddb606e931bf701a144e3b20b62698",
    );
  });

  it("is exactly one additive column with a default and one shape check: no table, no data change", () => {
    const statements = code
      .split(/;\s*$/m)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toBe(
      "alter table locations add column visual_bible jsonb not null default '{}'::jsonb",
    );
    expect(statements[1]).toMatch(
      /^alter table locations add constraint locations_visual_bible_shape check \(/,
    );
    expect(code).not.toMatch(/\b(create table|drop|update|delete|insert)\b/i);
  });
});
