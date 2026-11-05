import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0048 (Phase 4B, Shot Lighting Rigs). NOT applied to hosted in 4B-A: its behaviour is proven on
 * a disposable local database by scripts/db-lighting.mts and the existing db:* verifiers (docs/local-supabase.md).
 */

const DIR = "supabase/migrations";
const FILE = "0048_shot_lighting_rigs.sql";
const sql = readFileSync(`${DIR}/${FILE}`, "utf8");
const code = sql.replace(/--.*$/gm, ""); // statements only, no comments

describe("migration 0048: Shot Lighting Rigs and render-history provenance guards", () => {
  it("follows 0047, and leaves 0045, 0046 and 0047 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files).toContain(FILE);
    expect(files[files.indexOf(FILE) - 1]).toBe("0047_sequence_qa_automation.sql");
    const sumOf = (f: string) => checksumOf(readFileSync(`${DIR}/${f}`, "utf8"));
    expect(sumOf("0045_project_qa_direct_video.sql")).toBe(
      "44cc9360b867cc1d30b5fa8d758eca311f56b01d3485bb100d235c87d265d325",
    );
    expect(sumOf("0046_sequence_continuity_persistence.sql")).toBe(
      "eab65b89c4dec2a6f7b6befbee1de859f30d0b91872e5df6014729bbc26071a1",
    );
    expect(sumOf("0047_sequence_qa_automation.sql")).toBe(
      "eb8ed24bef736480106ec392859f66e0d2a61321df631a08d5ade1fe71df5dd0",
    );
  });

  it("creates exactly one table, destroys nothing and writes or backfills no row", () => {
    expect(code.match(/create table\s+\w+/gi)).toEqual(["create table shot_light_rigs"]);
    expect(code).not.toMatch(/\bdrop\s+(table|column|index|policy|function|trigger|constraint)\b/i);
    expect(code).not.toMatch(/\b(truncate|delete\s+from|insert\s+into)\b/i);
    expect(code).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });

  it("has no SECURITY DEFINER, owner-only RLS, and no privilege for anon or either worker role", () => {
    expect(code).not.toMatch(/security\s+definer/i);
    expect(code).toMatch(/alter table shot_light_rigs enable row level security/);
    expect(code).toMatch(
      /create policy shot_light_rigs_owner on shot_light_rigs for all to authenticated\s+using \(is_project_owner\(project_id\)\) with check \(is_project_owner\(project_id\)\)/,
    );
    expect(code).toMatch(/revoke all on shot_light_rigs from public, anon/);
    expect(code).toMatch(/revoke all on shot_light_rigs from prism_generation_worker/);
    expect(code).toMatch(/revoke all on shot_light_rigs from prism_continuity_worker/);
    // the only grant goes to authenticated, on the new table
    expect(code.match(/\bgrant\b[^;]*;/gi)).toEqual([
      "grant select, insert, update, delete on shot_light_rigs to authenticated;",
    ]);
  });

  it("adds nullable lighting provenance pairs to both render tables, checked as a pair", () => {
    for (const t of ["scene_master_frames", "shot_previs_clips"]) {
      expect(code).toContain(`alter table ${t} add column lighting_fingerprint text;`);
      expect(code).toContain(`alter table ${t} add column lighting_json jsonb;`);
      expect(code).toMatch(new RegExp(`alter table ${t} add constraint ${t}_lighting_check check`));
      // the statements above are complete (`;`), so neither column can carry a NOT NULL or a default
    }
  });

  it("guards render provenance deny-by-default, permitting only adoption and FK SET NULL", () => {
    expect(code).toMatch(
      /to_jsonb\(new\) - array\['adopted_at', 'adopted_frame_id', 'camera_bookmark_id'\]\)\s+is distinct from \(to_jsonb\(old\) - array\['adopted_at', 'adopted_frame_id', 'camera_bookmark_id'\]\)/,
    );
    expect(code).toMatch(
      /new\.camera_bookmark_id is distinct from old\.camera_bookmark_id and new\.camera_bookmark_id is not null/,
    );
    expect(code).toMatch(
      /\(to_jsonb\(new\) - 'camera_path_id'\) is distinct from \(to_jsonb\(old\) - 'camera_path_id'\)/,
    );
    expect(code).toMatch(
      /new\.camera_path_id is distinct from old\.camera_path_id and new\.camera_path_id is not null/,
    );
    expect(code).toMatch(
      /create trigger scene_master_frames_provenance_guard before update on scene_master_frames/,
    );
    expect(code).toMatch(
      /create trigger shot_previs_clips_provenance_guard before update on shot_previs_clips/,
    );
    // UPDATE only: DELETE and cascades stay allowed
    expect(code).not.toMatch(/before (delete|update or delete|delete or update)/i);
  });
});
