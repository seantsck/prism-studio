import { describe, expect, it } from "vitest";
import * as scripts from "../../../../scripts/lib/safety.mjs";
import { readDevUserEnv } from "../../../../scripts/lib/dev-user.mjs";
import { connectionTargetsRef, DEV_PROJECT_REF, publicUrlTargetsRef, resolveTarget } from "../target";

/**
 * Phase 5A.2: environment-scoped Supabase targeting. The application guard (src) and the script guard
 * (scripts/lib/safety.mjs) must make exactly the same decision for every input.
 */
const PROD = "abcdefghijklmnopqrst";
const OTHER = "zyxwvutsrqponmlkjihg";
const envOf = (environment?: string, ref?: string) => ({
  ...(environment === undefined ? {} : { NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT: environment }),
  ...(ref === undefined ? {} : { NEXT_PUBLIC_PRISM_STUDIO_SUPABASE_REF: ref }),
});
const outcome = (f: () => unknown) => {
  try {
    return JSON.stringify(f());
  } catch (e) {
    return `refused: ${(e as Error).message}`;
  }
};

describe("5A.2 environment-scoped Supabase target", () => {
  it("defaults to development on the DEV project (existing machines and staging unchanged)", () => {
    expect(resolveTarget({})).toEqual({ environment: "development", ref: DEV_PROJECT_REF });
    expect(scripts.resolveTarget({})).toEqual({ environment: "development", ref: DEV_PROJECT_REF });
    expect(resolveTarget({ environment: "staging" })).toEqual({
      environment: "staging",
      ref: DEV_PROJECT_REF,
    });
  });

  it("rehearsal / production must name a project that is not DEV; development / staging only DEV", () => {
    expect(resolveTarget({ environment: "production", ref: PROD })).toEqual({
      environment: "production",
      ref: PROD,
    });
    expect(resolveTarget({ environment: "rehearsal", ref: OTHER })).toEqual({
      environment: "rehearsal",
      ref: OTHER,
    });
    for (const bad of [
      { environment: "production" },
      { environment: "production", ref: DEV_PROJECT_REF },
      { environment: "rehearsal", ref: DEV_PROJECT_REF },
      { environment: "development", ref: PROD },
      { environment: "staging", ref: PROD },
      { environment: "prod", ref: PROD },
      { environment: "production", ref: "not-a-ref" },
      { environment: "production", ref: "ABCDEFGHIJKLMNOPQRST" },
    ])
      expect(() => resolveTarget(bad), JSON.stringify(bad)).toThrow(
        /refusing|must be one of|not a Supabase/i,
      );
  });

  it("the script guard and the application guard decide identically for every combination", () => {
    for (const environment of [undefined, "", "development", "staging", "rehearsal", "production", "prod"])
      for (const ref of [undefined, "", DEV_PROJECT_REF, PROD, "bad ref"]) {
        const env = envOf(environment, ref);
        expect(
          outcome(() => scripts.resolveTarget(env)),
          JSON.stringify(env),
        ).toBe(outcome(() => resolveTarget({ environment, ref })));
      }
  });

  it("matches connection strings and public URLs exactly, never by substring", () => {
    const pooled = `postgresql://postgres.${PROD}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
    const worker = `postgresql://prism_generation_worker.${PROD}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
    const direct = `postgresql://postgres:pw@db.${PROD}.supabase.co:5432/postgres`;
    for (const url of [pooled, worker, direct]) {
      expect(connectionTargetsRef(url, PROD), url).toBe(true);
      expect(scripts.connectionTargetsRef(url, PROD), url).toBe(true);
    }
    for (const url of [
      `postgresql://postgres.x${PROD}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
      `postgresql://postgres:pw@db.${PROD}.supabase.co.evil.example:5432/postgres`,
      `postgresql://postgres.${OTHER}:pw@host/${PROD}`,
      `postgresql://postgres:${PROD}@db.${OTHER}.supabase.co:5432/postgres`,
      "not a url",
    ]) {
      expect(connectionTargetsRef(url, PROD), url).toBe(false);
      expect(scripts.connectionTargetsRef(url, PROD), url).toBe(false);
    }
    expect(publicUrlTargetsRef(`https://${PROD}.supabase.co`, PROD)).toBe(true);
    for (const url of [
      `http://${PROD}.supabase.co`,
      `https://${PROD}.supabase.co.evil.example`,
      `https://evil.example/${PROD}.supabase.co`,
      `https://x${PROD}.supabase.co`,
    ])
      expect(publicUrlTargetsRef(url, PROD), url).toBe(false);
  });

  it("assertProjectRef follows the configured target", () => {
    const prodEnv = envOf("production", PROD);
    const prodUrl = `postgresql://postgres.${PROD}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
    const devUrl = `postgresql://postgres.${DEV_PROJECT_REF}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
    expect(() => scripts.assertProjectRef(prodUrl, "SUPABASE_DB_URL", prodEnv)).not.toThrow();
    expect(() => scripts.assertProjectRef(devUrl, "SUPABASE_DB_URL", prodEnv)).toThrow(/refusing/);
    expect(() => scripts.assertProjectRef(prodUrl, "SUPABASE_DB_URL", {})).toThrow(/refusing/);
    expect(() => scripts.assertProjectRef(devUrl, "SUPABASE_DB_URL", {})).not.toThrow();
  });

  it("production refuses every script that is not production-safe, and all dev-user tooling", () => {
    const prodUrl = `postgresql://postgres.${PROD}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
    const prod = { ...envOf("production", PROD), SUPABASE_DB_URL: prodUrl };
    const quiet = { ...prod };
    expect(() => scripts.assertToolAllowed("seed", {}, prod)).toThrow(/not production-safe/);
    expect(() => scripts.assertToolAllowed("migrate", { productionSafe: true }, prod)).not.toThrow();
    expect(() => scripts.assertToolAllowed("seed", {}, {})).not.toThrow(); // development is unchanged
    expect(() => scripts.startScript({ mode: "previs cleanup", env: quiet })).toThrow(/not production-safe/);
    expect(() =>
      readDevUserEnv({ ...prod, PRISM_STUDIO_DEV_USER_ID: "7b5fdc2d-0000-4000-8000-000000000000" }),
    ).toThrow(/refuses the production environment/);
    // rehearsal runs the full DB matrix on a throwaway project, so it is allowed there
    const rehearsal = {
      ...envOf("rehearsal", PROD),
      SUPABASE_DB_URL: prodUrl,
      PRISM_STUDIO_DEV_USER_ID: "7b5fdc2d-0000-4000-8000-000000000000",
    };
    expect(() => scripts.assertToolAllowed("seed", {}, rehearsal)).not.toThrow();
    expect(readDevUserEnv(rehearsal).url).toBe(prodUrl);
  });

  it("production-safe scripts are exactly migrations, validation and role provisioning", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(__dirname, "../../../../scripts");
    const safe = readdirSync(dir)
      .filter((f) => /\.(m?ts|mjs)$/.test(f))
      .filter((f) => /productionSafe:\s*true/.test(readFileSync(path.join(dir, f), "utf8")))
      .sort();
    expect(safe).toEqual([
      "continuity-db-provision.mts",
      "db-migrate-dry-run-check.mjs",
      "db-migrate.mjs",
      "db-validate.mjs",
      "story-db-provision.mts",
      "worker-db-check.mts",
      "worker-db-provision.mts",
    ]);
  });
});
