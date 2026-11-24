import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/** Static checks of migration 0069 (cover art: a generation attempt whose subject is the project). */
const DIR = "supabase/migrations";
const FILE = "0069_project_cover_art.sql";
const raw = readFileSync(`${DIR}/${FILE}`, "utf8");
const code = raw.replace(/--.*$/gm, "").replace(/\s+/g, " ");

describe("migration 0069: project cover art", () => {
  it("is the latest migration, follows 0068, and leaves 0068 byte-for-byte unchanged (as applied)", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe(FILE);
    expect(files.at(-2)).toBe("0068_character_merged_into.sql");
    expect(checksumOf(readFileSync(`${DIR}/0068_character_merged_into.sql`, "utf8"))).toBe(
      "efd8c465e0cd52d11a12eb5663d78822dad4d67d77b4a866139a3d10976c9093",
    );
  });

  it("adds one defaulted flag; a row is a cover with no subject, or not a cover with exactly one", () => {
    expect(code).toContain(
      "alter table generation_attempts add column if not exists project_cover boolean not null default false;",
    );
    expect(code).toContain(
      "(not project_cover and num_nonnulls(shot_id, character_id, location_id) = 1) or (project_cover and num_nonnulls(shot_id, character_id, location_id) = 0)",
    );
    expect(code).toContain(
      "create unique index if not exists attempts_cover_number on generation_attempts (project_id, attempt_number) where project_cover;",
    );
    expect(code).not.toMatch(/\bupdate\b|\bdelete from\b|\bpolicy\b|\bgrant\b|\bdrop table\b/i);
  });

  it("keeps the append-only guard identical to 0051's, plus project_cover", () => {
    const guard = (sql: string) =>
      sql.slice(
        sql.indexOf("create or replace function guard_attempt_history"),
        sql.indexOf("$$;", sql.indexOf("create or replace function guard_attempt_history")),
      );
    const before = guard(readFileSync(`${DIR}/0051_generation_subjects.sql`, "utf8"));
    const after = guard(raw);
    expect(after.replace("     or new.project_cover is distinct from old.project_cover\n", "")).toBe(before);
  });
});
