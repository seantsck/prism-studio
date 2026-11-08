import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0051 (Phase 5B-I1, generation subjects). NOT applied to hosted: the shared DEV database
 * is still read by the deployed owner-review build, whose code assumes every attempt has a Shot. Behaviour is proven
 * on a disposable local database. This file guards order, prior-migration integrity and the statement envelope.
 */
const DIR = "supabase/migrations";
const FILE = "0051_generation_subjects.sql";
const sql = readFileSync(`${DIR}/${FILE}`, "utf8");
const code = sql.replace(/--.*$/gm, "");
// the one privileged piece: the 0051 shared-database compatibility gate's release trigger (checked on its own below)
const RELEASE =
  /create or replace function release_subject_image_outputs\(\)[\s\S]*?\$\$;\s*revoke all on function release_subject_image_outputs\(\) from public;\s*create trigger assets_release_subject_image_outputs\s+before delete on assets\s+for each row execute function release_subject_image_outputs\(\);/;
const release = RELEASE.exec(code)?.[0] ?? "";
const rest = code.replace(RELEASE, "");

describe("migration 0051: generation subjects (Character / Location images)", () => {
  it("follows 0050 (0052 follows it; see migration-0052.test.ts) and leaves 0050 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files[files.indexOf(FILE) - 1]).toBe("0050_shot_setup_templates.sql");
    expect(checksumOf(readFileSync(`${DIR}/0050_shot_setup_templates.sql`, "utf8"))).toBe(
      "19cdbc22592756dd6749ab6aba900b9f94380f64a249f4a48fa07b91353debe0",
    );
  });

  it("is additive: no new table, no destruction, no row writes, no grant or policy change, no SECURITY DEFINER (outside the release trigger)", () => {
    expect(release).not.toBe("");
    expect(rest).not.toMatch(/\bcreate table\b/i);
    expect(rest).not.toMatch(/\bsecurity definer\b/i);
    expect(rest).not.toMatch(/\bdrop\s+(table|column|index|policy|function|trigger|constraint)\b/i);
    expect(rest).not.toMatch(/\b(truncate\s+\w|delete\s+from|insert\s+into)\b/i);
    expect(rest).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    expect(rest).not.toMatch(/\b(grant|revoke)\b/i);
    expect(rest).not.toMatch(/\b(create|alter|drop)\s+policy\b/i);
  });

  it("0051 shared-database compatibility gate: the release trigger drops ONLY a subject attempt's output link", () => {
    expect(release).toMatch(/language plpgsql security definer set search_path = public/);
    // exactly one data statement: a delete of generation_outputs rows for THIS asset whose attempt has no Shot
    expect(release.match(/\b(delete from|insert into|update \w+ set|truncate)\b/gi)).toEqual(["delete from"]);
    expect(release).toMatch(/delete from generation_outputs o\s+using generation_attempts a/);
    expect(release).toMatch(/o\.asset_id = old\.id/);
    expect(release).toMatch(/o\.project_id = old\.project_id/);
    expect(release).toMatch(/a\.id = o\.attempt_id/);
    expect(release).toMatch(/a\.shot_id is null;/);
    expect(release).toMatch(/return old;/);
    expect(release).toMatch(/revoke all on function release_subject_image_outputs\(\) from public;/);
  });

  it("allows exactly one subject, keeps subjects in their project, and keeps subject attempts image-only and unapproved", () => {
    expect(code).toMatch(/alter column shot_id drop not null/);
    expect(code).toMatch(/check \(num_nonnulls\(shot_id, character_id, location_id\) = 1\)/);
    expect(code).toMatch(/foreign key \(character_id, project_id\) references characters \(id, project_id\)/);
    expect(code).toMatch(/foreign key \(location_id, project_id\) references locations \(id, project_id\)/);
    expect(code).toMatch(/check \(shot_id is not null or modality = 'image'\)/);
    expect(code).toMatch(/check \(shot_id is not null or approved = false\)/);
    expect(code).toMatch(
      /unique index attempts_character_number on generation_attempts \(character_id, attempt_number\)/,
    );
    expect(code).toMatch(
      /unique index attempts_location_number on generation_attempts \(location_id, attempt_number\)/,
    );
  });

  it("keeps the append-only guard identical plus the two subject columns", () => {
    const guard = (s: string) =>
      (/create or replace function guard_attempt_history\(\)[\s\S]*?\$\$;/.exec(s)?.[0] ?? "")
        .replace(/\s+/g, " ")
        .replace(/ or new\.(character_id|location_id) is distinct from old\.\1/g, "");
    const previous = readFileSync(`${DIR}/0019_generation_adaptation.sql`, "utf8").replace(/--.*$/gm, "");
    expect(guard(code)).toBe(guard(previous));
    expect(code).toMatch(/new\.character_id is distinct from old\.character_id/);
    expect(code).toMatch(/new\.location_id is distinct from old\.location_id/);
  });
});
