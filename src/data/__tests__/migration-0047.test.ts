import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0047 (Phase 3A.4F). NOT applied to hosted in 3A.4F-A: its behaviour is proven on a disposable
 * local database by scripts/db-sequence-automation.mts and the existing db:* verifiers (docs/local-supabase.md).
 */

const DIR = "supabase/migrations";
const sql = readFileSync(`${DIR}/0047_sequence_qa_automation.sql`, "utf8");
const code = sql.replace(/--.*$/gm, ""); // statements only, no comments

describe("migration 0047: Sequence automation policy and cut settling clocks", () => {
  it("is the latest migration, follows 0046, and leaves 0044, 0045 and 0046 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe("0047_sequence_qa_automation.sql");
    expect(files.at(-2)).toBe("0046_sequence_continuity_persistence.sql");
    const sumOf = (f: string) => checksumOf(readFileSync(`${DIR}/${f}`, "utf8"));
    expect(sumOf("0044_shot_qa_automation.sql")).toBe(
      "31abe729026e1c89b9590d9167b2d608b1747de4bae72fdf7bcdb7961b72dcd7",
    );
    expect(sumOf("0045_project_qa_direct_video.sql")).toBe(
      "44cc9360b867cc1d30b5fa8d758eca311f56b01d3485bb100d235c87d265d325",
    );
    expect(sumOf("0046_sequence_continuity_persistence.sql")).toBe(
      "eab65b89c4dec2a6f7b6befbee1de859f30d0b91872e5df6014729bbc26071a1",
    );
  });

  it("creates no table, destroys nothing and rewrites no history", () => {
    expect(code).not.toMatch(/create table/i);
    expect(code).not.toMatch(/\bdrop\s+(table|column|index|policy|function|trigger)\b/i);
    expect(code).not.toMatch(/\b(truncate|delete\s+from|insert\s+into)\b/i);
    // the only UPDATEs are the touches inside the two trigger functions
    expect(code.match(/\bupdate\s+\w+\s+set/gi)).toEqual([
      "update shots set",
      "update characters set",
      "update characters set",
    ]);
  });

  it("existing Projects opt into nothing: Sequence mode defaults off, batch cap defaults 20 within 1..20", () => {
    expect(code).toMatch(/add column sequence_semantic_mode text not null default 'off'/);
    expect(code).toMatch(/sequence_semantic_mode in \('off', 'suggest', 'automatic'\)/);
    expect(code).toMatch(/add column max_transitions_per_batch integer not null default 20/);
    expect(code).toMatch(/max_transitions_per_batch between 1 and 20/);
    expect(code).not.toMatch(/default 'automatic'|default 'suggest'/);
  });

  it("automatic is explicit and independent of the Shot mode", () => {
    const check = code.slice(code.indexOf("project_qa_policies_sequence_automatic_is_explicit"));
    for (const part of [
      "analyzer is not null",
      "external_media_allowed",
      "direct_video_allowed",
      "max_cost_per_run_usd is not null",
      "max_cost_per_day_usd is not null",
    ])
      expect(check).toContain(part);
    expect(code).not.toMatch(/semantic_mode/);
  });

  it("the triggers cover exactly the mutations with no clock, and only touch a timestamp", () => {
    const triggers = [...code.matchAll(/create trigger (\w+)\s+after ([a-z ]+?) on (\w+)/gi)].map((m) => [
      m[1],
      m[2],
      m[3],
    ]);
    expect(triggers).toEqual([
      ["shot_location_view_selections_touch_shot", "delete", "shot_location_view_selections"],
      ["shot_character_continuity_selections_touch_shot", "delete", "shot_character_continuity_selections"],
      ["shot_props_touch_shot", "delete", "shot_props"],
      ["character_identity_refs_touch_character", "insert or update or delete", "character_identity_refs"],
    ]);
    for (const m of code.matchAll(/\bupdate\s+(shots|characters)\s+set\s+([^;]+?)\s+where/gi))
      expect(m[2]).toBe("updated_at = now()");
    // database triggers, so FK cascades are covered too
    expect(code).not.toMatch(/\bsecurity definer\b/i);
  });

  it("changes no access: no grant, no revoke, no policy, no worker role", () => {
    expect(code).not.toMatch(/\b(grant|revoke)\b/i);
    expect(code).not.toMatch(/create policy/i);
    expect(code).not.toMatch(/prism_(generation|continuity)_worker|\banon\b/i);
  });
});
