import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checksumOf } from "../../../scripts/lib/migrations.mjs";

/**
 * Static checks of migration 0059 (Phase 5B-V4, final Episode renders) and of the renderer's credential boundary. NOT
 * applied to hosted: behaviour is proven on the disposable local database (scripts/db-renders.mts).
 */
const DIR = "supabase/migrations";
const FILE = "0059_episode_renders.sql";
const sql = readFileSync(`${DIR}/${FILE}`, "utf8");
const code = sql.replace(/--.*$/gm, "");

describe("migration 0059: Episode renders", () => {
  it("is the latest migration, follows 0058, and leaves 0058 byte-for-byte unchanged", () => {
    const files = readdirSync(DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    expect(files.at(-1)).toBe(FILE);
    expect(files.at(-2)).toBe("0058_episode_edit_v3.sql");
    expect(checksumOf(readFileSync(`${DIR}/0058_episode_edit_v3.sql`, "utf8"))).toBe(
      "90d9ce9f42cec49ae7c42c43b22b625469bfedc27186fa252508c83e67f7833e",
    );
  });

  it("adds the render job and the segment cache (no media bytes in Postgres), and the 'episode_render' Asset purpose", () => {
    expect(code.match(/\bcreate table\b/gi)).toHaveLength(2);
    expect(code).toMatch(/create table episode_renders \(/);
    expect(code).toMatch(/create table render_segment_cache \(/);
    expect(code).not.toMatch(/\bbytea\b/);
    expect(code).toMatch(/'production_frame',\s*'episode_render'/);
    expect(code).toMatch(/unique \(episode_id, number\)/);
    expect(code).toMatch(/constraint episode_renders_completed_has_output check/);
  });

  it("guards frozen inputs, the lifecycle and the owner's narrow rights in the database", () => {
    expect(code).toMatch(/a render''s frozen inputs cannot change/);
    expect(code).toMatch(/is history and cannot change/);
    expect(code).toMatch(/only the render worker advances a render/);
    expect(code).toMatch(/only the owner retries a render/);
    for (const [from, to] of [
      ["queued", "'rendering_segments', 'cancelled'"],
      ["rendering_segments", "'assembling', 'failed'"],
      ["assembling", "'verifying', 'failed'"],
      ["verifying", "'completed', 'failed'"],
    ])
      expect(code).toContain(`(old.status = '${from}' and new.status in (${to}))`);
    expect(code).not.toMatch(/for delete/i);
  });

  it("a least-privilege render worker role: active renders, the cache, the project's Assets, the output Asset only", () => {
    expect(code).toMatch(/create role prism_render_worker nologin noinherit/);
    expect(code).toMatch(/revoke all on all tables in schema public from prism_render_worker/);
    const grants = [...code.matchAll(/grant ([^;]+?) on (\w+) to prism_render_worker/g)].map((m) => m[2]);
    expect(new Set(grants)).toEqual(new Set(["episode_renders", "render_segment_cache", "assets"]));
    expect(code).toMatch(/grant usage on schema public to prism_render_worker/);
    expect(code).toMatch(/purpose = 'episode_render' and type = 'video'/);
    expect(code).not.toMatch(/to prism_(generation|continuity|story)_worker/);
  });
});

describe("5B-V4 renderer credential boundary (static)", () => {
  const files = (dir: string, out: string[] = []): string[] => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) {
        if (f.name !== "__tests__") files(p, out);
      } else if (/\.(ts|tsx|mts)$/.test(f.name)) out.push(p);
    }
    return out;
  };
  it("the renderer and its worker read no provider, Story or generation credential", () => {
    for (const f of [...files("src/render"), "scripts/render-worker.mts"]) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(
        /OPENAI|RUNWAY|PHOTOROOM|GEMINI|STORY_WORKER|PRISM_STUDIO_WORKER_DB_URL|PRISM_STUDIO_PROVIDER_|SERVICE_ROLE/,
      );
    }
  });
});
