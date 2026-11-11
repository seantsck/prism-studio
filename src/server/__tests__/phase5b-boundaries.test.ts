import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPENAI_IMAGE_SECRET_ENV } from "@/generation/providers/openai-image/adapter";
import { OPENAI_STORY_SECRET_ENV } from "@/story/providers/openai";

/**
 * Phase 5B convergence: the security boundary between the Story worker, the generation worker and the browser, read
 * from the integrated code (static; the database side is proven by scripts/db-story-worker-login.mts and the
 * generation worker-role suites on the disposable database).
 */
function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== "__tests__") files(p, out);
    } else if (/\.(tsx?|mts|mjs)$/.test(f)) out.push(p);
  }
  return out;
}
const read = (p: string) => readFileSync(p, "utf8");
const STORY_SECRETS = [
  OPENAI_STORY_SECRET_ENV,
  "PRISM_STUDIO_STORY_WORKER_DB_URL",
  "PRISM_STUDIO_STORY_DB_PASSWORD",
];
const GENERATION_SECRETS = [
  OPENAI_IMAGE_SECRET_ENV,
  "PRISM_STUDIO_PROVIDER_OPENAI_IMAGE_API_KEY",
  "PRISM_STUDIO_PROVIDER_PHOTOROOM_API_KEY",
  "RUNWAYML_API_SECRET",
  "PRISM_STUDIO_WORKER_DB_URL",
  "PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY",
];

describe("Phase 5B security boundary (integrated line)", () => {
  it("the generation worker and its providers never read a Story credential", () => {
    for (const f of [...files("src/generation"), "scripts/generation-worker.mts"])
      for (const s of STORY_SECRETS) expect(read(f), `${f} reads ${s}`).not.toContain(s);
  });

  it("the Story worker and Story code never read a generation credential or the generation worker's database login", () => {
    for (const f of [...files("src/story"), "scripts/story-worker.mts", "scripts/story-db-provision.mts"])
      for (const s of GENERATION_SECRETS) expect(read(f), `${f} reads ${s}`).not.toContain(s);
    // the Story worker builds ONLY the Story registry and Story / writing / shot-list / direction stores
    const worker = read("scripts/story-worker.mts");
    expect(worker).not.toMatch(/generation\/registry|createRegistry\(|GenerationWorker/);
    expect(worker).toMatch(/role !== "prism_story_worker"/);
  });

  it("no browser module can reach a provider credential, a worker registry or a worker DB login", () => {
    const client = files("src").filter((f) => /^\s*["']use client["']/.test(read(f)));
    expect(client.length).toBeGreaterThan(10);
    for (const f of client) {
      const s = read(f);
      for (const k of [...STORY_SECRETS, ...GENERATION_SECRETS])
        expect(s, `${f} names ${k}`).not.toContain(k);
      expect(s, f).not.toMatch(/from ["']@\/(story|generation)\/(registry|providers|worker)/);
    }
    for (const f of files("src"))
      expect(read(f), f).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(STORY|PROVIDER|WORKER)[A-Z_]*/);
  });

  it("Story migrations grant nothing to the generation or continuity workers, and the Story worker nothing on production tables", () => {
    for (const n of [
      "0054_story_proposals",
      "0055_story_writing",
      "0056_shot_list_proposals",
      "0057_shot_direction_proposals",
    ]) {
      const sql = read(`supabase/migrations/${n}.sql`).replace(/--.*$/gm, "");
      expect(sql, n).not.toMatch(/to prism_generation_worker|to prism_continuity_worker/);
      const grants = [...sql.matchAll(/grant ([^;]+) on (\w+) to prism_story_worker/g)].map((m) => m[2]);
      for (const t of grants)
        expect(
          ["story_proposals", "writing_proposals", "shot_list_proposals", "shot_direction_proposals"],
          n,
        ).toContain(t);
    }
  });
});
