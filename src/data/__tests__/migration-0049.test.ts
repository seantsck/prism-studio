import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0049 (Phase 4C-I1, spatial camera and Production Frame source provenance). NOT applied to
 * hosted in 4C-I1: its behaviour is proven on a disposable local database by scripts/db-spatial-source.mts.
 */

const DIR = "supabase/migrations";
const FILE = "0049_spatial_camera_and_frame_source.sql";
const sql = readFileSync(`${DIR}/${FILE}`, "utf8");
const code = sql.replace(/--.*$/gm, ""); // statements only, no comments

describe("migration 0049: spatial camera and Production Frame source provenance", () => {
  it("is the latest migration, follows 0048, and leaves 0048 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe(FILE);
    expect(files.at(-2)).toBe("0048_shot_lighting_rigs.sql");
    expect(checksumOf(readFileSync(`${DIR}/0048_shot_lighting_rigs.sql`, "utf8"))).toBe(
      "d59c8ef800ce83f78492b4e030a07d6349d06fb1c2e04daeec195384860034b1",
    );
  });

  it("only adds nullable columns, two CHECKs and one trigger: no table, row write, grant or destruction", () => {
    expect(code).not.toMatch(/\bcreate table\b/i);
    expect(code).not.toMatch(/\bdrop\s+(table|column|index|policy|function|trigger|constraint)\b/i);
    expect(code).not.toMatch(/\b(truncate|delete\s+from|insert\s+into)\b/i);
    expect(code).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    expect(code).not.toMatch(/\b(grant|revoke|create policy|security definer)\b/i);
    // every new column is nullable (`is not null` inside the CHECKs is fine)
    expect(code).not.toMatch(/add column \w+ [^;]*\bnot null\b/i);
    const added = [...code.matchAll(/add column (\w+)/gi)].map((m) => m[1]).sort();
    expect(added).toEqual(
      [
        "camera_fingerprint",
        "camera_json",
        "source_blocking_fingerprint",
        "source_camera_fingerprint",
        "source_lighting_fingerprint",
        "source_scene_fingerprint",
      ].sort(),
    );
    expect(code.match(/create trigger \w+/gi)).toEqual([
      "create trigger shot_production_frames_spatial_source_check",
    ]);
  });

  it("adds no foreign key and no stale / unknown arrays", () => {
    expect(code).not.toMatch(/\breferences\b/i);
    expect(code).not.toMatch(/source_spatial_(stale|unknown)/i);
    expect(code).not.toMatch(/text\[\]/i);
  });

  it("the exact-source trigger compares the four fingerprints with IS DISTINCT FROM and never reads current state", () => {
    for (const col of ["scene", "camera", "blocking", "lighting"])
      expect(code).toMatch(
        new RegExp(`mf\.${col}_fingerprint is distinct from new\.source_${col}_fingerprint`),
      );
    expect(code).toMatch(/mf\.project_id is distinct from new\.project_id/);
    expect(code).toMatch(/mf\.shot_id is distinct from new\.shot_id/);
    expect(code).toMatch(/mf\.asset_id is distinct from new\.asset_id/);
    expect(code).not.toMatch(
      /shot_camera_bookmarks|shot_light_rigs|shot_character_blocking|location_scene_documents/,
    );
  });
});
