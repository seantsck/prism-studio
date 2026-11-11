import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  auditStoryWorkerRole,
  ProvisionRefused,
  provisionStoryWorkerLogin,
  STORY_WORKER_ROLE,
} from "../story-worker-role";

/**
 * Phase 5B-S2: provisioning the Story worker's database login (`prism_story_worker`). Unit level, against a scripted
 * client; the real login and its privileges are proven on the disposable database (scripts/db-story-worker-login.mts).
 */
const SECRET = "x".repeat(20) + "-generated-secret-value";

function client(role: Record<string, boolean> | null) {
  const sent: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    sent,
    query: async (sql: string, params?: unknown[]) => {
      sent.push({ sql, params });
      if (sql.startsWith("select rolcanlogin")) return { rowCount: role ? 1 : 0, rows: role ? [role] : [] };
      if (sql.startsWith("select format("))
        return { rowCount: 1, rows: [{ sql: "ALTER ROLE <built server-side>" }] };
      return { rowCount: 0, rows: [] };
    },
  };
}
const plain = {
  rolcanlogin: false,
  rolsuper: false,
  rolbypassrls: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
};

describe("Story worker login provisioning", () => {
  it("refuses a short secret, a missing role and an elevated role — and changes nothing", async () => {
    await expect(provisionStoryWorkerLogin(client(plain) as never, "short")).rejects.toBeInstanceOf(
      ProvisionRefused,
    );
    await expect(provisionStoryWorkerLogin(client(null) as never, SECRET)).rejects.toThrow(
      /Apply migrations 0054 and 0055/,
    );
    const elevated = client({ ...plain, rolbypassrls: true });
    await expect(provisionStoryWorkerLogin(elevated as never, SECRET)).rejects.toThrow(/elevated attributes/);
    expect(elevated.sent.some((q) => /alter role/i.test(q.sql))).toBe(false);
  });

  it("enables LOGIN once; repeat runs are no-ops unless --rotate; the secret only travels as a bind parameter", async () => {
    const fresh = client(plain);
    expect(await provisionStoryWorkerLogin(fresh as never, SECRET)).toBe("enabled");
    const format = fresh.sent.find((q) => q.sql.startsWith("select format("))!;
    expect(format.sql).not.toContain(SECRET);
    expect(format.params).toEqual([STORY_WORKER_ROLE, SECRET, 5]);
    expect(fresh.sent.every((q) => !q.sql.includes(SECRET))).toBe(true);
    const again = client({ ...plain, rolcanlogin: true });
    expect(await provisionStoryWorkerLogin(again as never, SECRET)).toBe("unchanged");
    expect(again.sent.some((q) => q.sql.startsWith("select format("))).toBe(false);
    expect(
      await provisionStoryWorkerLogin(client({ ...plain, rolcanlogin: true }) as never, SECRET, {
        rotate: true,
      }),
    ).toBe("rotated");
  });

  it("the audit flags any privilege beyond writing/story proposals in flight", async () => {
    const audit = await auditStoryWorkerRole({
      query: async (sql: string) => {
        if (sql.includes("from pg_roles"))
          return { rowCount: 1, rows: [{ ...plain, rolinherit: false, rolcanlogin: true }] };
        if (sql.includes("pg_auth_members")) return { rowCount: 1, rows: [{ n: 0 }] };
        if (sql.includes("role_table_grants"))
          return {
            rowCount: 3,
            rows: [
              { table_name: "story_proposals", privilege_type: "SELECT" },
              { table_name: "writing_proposals", privilege_type: "SELECT" },
              { table_name: "characters", privilege_type: "SELECT" },
            ],
          };
        if (sql.includes("column_privileges"))
          return {
            rowCount: 2,
            rows: [
              { table_name: "writing_proposals", column_name: "result" },
              { table_name: "writing_proposals", column_name: "accepted_alternative" },
            ],
          };
        if (sql.includes("has_schema_privilege")) return { rowCount: 1, rows: [{ c: false }] };
        return { rowCount: 0, rows: [] };
      },
    } as never);
    expect(audit.failures).toEqual([
      "SELECT on characters",
      "UPDATE (accepted_alternative) on writing_proposals",
    ]);
  });

  it("the CLI never prints the secret and documents the worker-host-only URL", () => {
    const cli = readFileSync("scripts/story-db-provision.mts", "utf8");
    expect(cli).toContain("process.env.PRISM_STUDIO_STORY_DB_PASSWORD");
    // the variable holding the secret is never interpolated into, or passed to, any output call
    expect(cli).not.toMatch(/\$\{password\}|console\.(log|error)\(\s*password\b/);
    expect(cli).toContain('const password = process.env.PRISM_STUDIO_STORY_DB_PASSWORD ?? "";');
    expect(cli).toContain("provisionStoryWorkerLogin(client, password, { rotate })");
    // the only code use of the variable: lines mentioning it outside comments and strings are exactly those two
    const code = cli
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .map((l) => l.replace(/(["'`]).*?\1/g, ""));
    expect(code.filter((l) => /\bpassword\b/.test(l))).toHaveLength(2);
    expect(cli).toMatch(/PRISM_STUDIO_STORY_WORKER_DB_URL=postgresql:\/\/<login>:<password>@/);
    expect(cli).not.toMatch(/process\.env\.NEXT_PUBLIC/);
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["story:db:provision"]).toBe(
      "tsx --env-file=.env.local scripts/story-db-provision.mts",
    );
  });
});
