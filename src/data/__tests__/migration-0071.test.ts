import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/** Static checks of migration 0071 (the Actor a Character is played by). */
const DIR = "supabase/migrations";
const FILE = "0071_character_actor.sql";
const code = readFileSync(`${DIR}/${FILE}`, "utf8").replace(/--.*$/gm, "").replace(/\s+/g, " ");

describe("migration 0071: the Actor a Character is played by", () => {
  it("is the latest migration, follows 0070, and leaves 0070 byte-for-byte unchanged (as applied)", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe(FILE);
    expect(files.at(-2)).toBe("0070_character_art_style.sql");
    expect(checksumOf(readFileSync(`${DIR}/0070_character_art_style.sql`, "utf8"))).toBe(
      "efd02fe5bb06f26956e7d967d3d004e6c079cbd46ce3cee14435d7aa84189eca",
    );
  });

  it("adds one nullable link that is cleared, not cascaded, when the Actor is deleted", () => {
    expect(code).toContain(
      "alter table characters add column if not exists actor_id uuid references characters (id) on delete set null;",
    );
    expect(code).not.toMatch(
      /\bnot null\b|\bdefault\b|\bdrop\b|\bupdate\b|\bdelete from\b|\bpolicy\b|\bgrant\b|\bcascade\b/i,
    );
  });
});
