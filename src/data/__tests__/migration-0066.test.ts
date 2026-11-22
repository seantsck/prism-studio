import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/** Static checks of migration 0066 (the location library). Behaviour: location-library.test.ts. */
const DIR = "supabase/migrations";
const FILE = "0066_location_library.sql";
const code = readFileSync(`${DIR}/${FILE}`, "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ");

describe("migration 0066: the location library", () => {
  it("is the latest migration, follows 0065, and leaves 0065 byte-for-byte unchanged (as applied)", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe(FILE);
    expect(files.at(-2)).toBe("0065_character_studio_project.sql");
    expect(checksumOf(readFileSync(`${DIR}/0065_character_studio_project.sql`, "utf8"))).toBe(
      "a42604678465fb067a27d1a661313f2725891547add7678fe2d32bf0e5ea4793",
    );
  });

  it("adds one owner-only table and changes nothing that exists", () => {
    expect(code).toContain("create table if not exists location_library");
    expect(code).toContain("references locations (id) on delete cascade");
    expect(code).toContain("unique (user_id, location_id)");
    expect(code).toContain("enable row level security");
    expect(code.match(/user_id = auth\.uid\(\)/g)).toHaveLength(2);
    expect(code.match(/is_project_owner\(l\.project_id\)/g)).toHaveLength(2);
    expect(code).toContain("grant select, insert, delete on location_library to authenticated");
    expect(code).not.toMatch(/\b(drop|update|alter table (?!location_library)|anon|service_role)\b/i);
  });
});
