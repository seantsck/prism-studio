import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0050 (Phase 4D-I2, named Shot setup templates and setup-copy history). NOT applied to hosted
 * in 4D-I2: its behaviour (RLS, grants, append-only history, snapshot-not-link) is proven on a disposable local database by
 * scripts/db-setup-templates.mts. This file only guards order, prior-migration integrity and the statement envelope.
 */

const DIR = "supabase/migrations";
const FILE = "0050_shot_setup_templates.sql";
const sql = readFileSync(`${DIR}/${FILE}`, "utf8");
const code = sql.replace(/--.*$/gm, ""); // statements only, no comments

describe("migration 0050: named Shot setup templates and setup-copy history", () => {
  it("is the latest migration, follows 0049, and leaves 0048 and 0049 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe(FILE);
    expect(files.at(-2)).toBe("0049_spatial_camera_and_frame_source.sql");
    const sumOf = (f: string) => checksumOf(readFileSync(`${DIR}/${f}`, "utf8"));
    expect(sumOf("0048_shot_lighting_rigs.sql")).toBe(
      "d59c8ef800ce83f78492b4e030a07d6349d06fb1c2e04daeec195384860034b1",
    );
    expect(sumOf("0049_spatial_camera_and_frame_source.sql")).toBe(
      "9b4589caa4ed19bf92e6dc9f77217587bf3b08f99977578871c69113f9da19fb",
    );
  });

  it("is additive: two new tables, no SECURITY DEFINER, no destruction and no existing-row writes", () => {
    expect(code.match(/create table \w+/gi)).toEqual([
      "create table shot_setup_templates",
      "create table shot_setup_copies",
    ]);
    expect(code).not.toMatch(/\bsecurity definer\b/i);
    expect(code).not.toMatch(/\bdrop\s+(table|column|index|policy|function|trigger|constraint)\b/i);
    expect(code).not.toMatch(/\b(truncate\s+\w|delete\s+from|insert\s+into)\b/i);
    expect(code).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    // the only ALTERs enable RLS on the two new tables: no existing table is altered
    expect(code.match(/alter table [^;]+;/gi)).toEqual([
      "alter table shot_setup_templates enable row level security;",
      "alter table shot_setup_copies enable row level security;",
    ]);
  });

  it("grants authenticated only what the design allows: full CRUD on templates, select + insert on copy history", () => {
    expect(code.match(/grant [^;]+;/gi)).toEqual([
      "grant select, insert, update, delete on shot_setup_templates to authenticated;",
      "grant select, insert on shot_setup_copies to authenticated;",
    ]);
  });
});
