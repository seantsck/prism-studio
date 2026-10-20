import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The remote agent's trust boundary, checked on the SOURCE: everything the workstation CLI can load (its transitive
 * import graph) must be free of database, Supabase, Storage-sink and server code, and must not name a server
 * credential. And no client component may import the server-side agent implementation.
 */

const ROOT = process.cwd();
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, path.join(base, "index.ts")])
    if (existsSync(c) && !c.endsWith(path.sep) && /\.(m?ts|tsx)$/.test(c)) return c;
  return null;
}

function graph(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      const local = resolveLocal(f, spec);
      if (local) queue.push(local);
      else if (!spec.startsWith(".") && !spec.startsWith("@/")) packages.add(spec);
    }
  }
  return {
    files: [...files].map((f) => path.relative(ROOT, f).replace(/\\/g, "/")),
    packages: [...packages],
  };
}

describe("remote agent trust boundary", () => {
  const { files, packages } = graph(path.join(ROOT, "scripts", "local-agent.mts"));

  it("loads no server, database, Supabase or Storage-sink module", () => {
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      expect(f).not.toMatch(/^src\/server\//);
      expect(f).not.toMatch(/^src\/data\//);
      expect(f).not.toMatch(/^src\/generation\//);
      expect(f).not.toMatch(/^src\/lib\/supabase\//);
      expect(f).not.toMatch(/local-worker\/(worker|postgres-store|adapter|store|status)\.ts$/);
    }
    for (const p of packages) {
      expect(p).not.toBe("pg");
      expect(p).not.toMatch(/^@supabase\//);
      expect(p).not.toBe("server-only");
    }
  });

  it("names no server credential", () => {
    const forbidden = [
      "SUPABASE_DB_URL",
      "WORKER_SUPABASE_SECRET",
      "SERVICE_ROLE",
      "service_role",
      "SUPABASE_SECRET",
      "PUBLISHABLE_KEY",
      "WLT_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "RUNWAY",
      "FAL_KEY",
      "MESHY",
    ];
    for (const f of files) {
      const text = readFileSync(path.join(ROOT, f), "utf8")
        // the agent's own trust-model comments may say what it does NOT hold
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      for (const word of forbidden) expect(`${f}: ${text.includes(word)}`).toBe(`${f}: false`);
    }
  });

  it("is started without the server's .env.local", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["local:agent"]).toBe("tsx scripts/local-agent.mts");
    expect(pkg.scripts["local:agent"]).not.toContain("env-file");
  });

  it("Local Capture does not use remote agents in M2D.3C1 (execution stays with the same-host worker)", () => {
    for (const entry of [
      "src/server/reconstruction-job-actions.ts",
      "src/server/reconstruction-jobs.ts",
      "src/lib/reconstruction/registry.ts",
      "scripts/run-local-reconstruction-worker.mts",
    ])
      for (const f of graph(path.join(ROOT, entry)).files) expect(f).not.toMatch(/local-agent/);
  });

  it("no client component imports the server-side agent implementation", () => {
    const panel = graph(path.join(ROOT, "src", "components", "local-agents-panel.tsx"));
    // the panel reaches the server ONLY through the "use server" action module (an RPC boundary)
    const direct = readFileSync(path.join(ROOT, "src", "components", "local-agents-panel.tsx"), "utf8");
    expect(direct).toContain('"use client"');
    expect(direct).not.toMatch(/@\/server\/local-agent["/]/);
    expect(direct).not.toMatch(/@\/server\/(db|repo|auth)["']/);
    const actions = readFileSync(path.join(ROOT, "src", "server", "local-agent-actions.ts"), "utf8");
    expect(actions.startsWith('"use server"')).toBe(true);
    const index = readFileSync(path.join(ROOT, "src", "server", "local-agent", "index.ts"), "utf8");
    expect(index.startsWith('import "server-only"')).toBe(true);
    expect(panel.files).toContain("src/server/local-agent-actions.ts");
  });
});

describe("M2D.3C1 is identity and control plane only (no remote job execution)", () => {
  const strip = (t: string) => t.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const JOB_WORDS = /\b(?:next-?job|claim|lease|asset|upload|download|signed.?url|complete-?job|storage)/i;

  it("exposes exactly three agent routes: pair, heartbeat, status", () => {
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }))
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else routes.push(path.relative(ROOT, path.join(dir, e.name)).replace(/\\/g, "/"));
    };
    walk(path.join(ROOT, "src", "app", "api", "local-agent"));
    expect(routes.sort()).toEqual([
      "src/app/api/local-agent/v1/heartbeat/route.ts",
      "src/app/api/local-agent/v1/pair/route.ts",
      "src/app/api/local-agent/v1/status/route.ts",
    ]);
    const protocol = readFileSync(path.join(ROOT, "src", "lib", "local-agent", "protocol.ts"), "utf8");
    const paths = protocol.slice(
      protocol.indexOf("export const PATHS"),
      protocol.indexOf("} as const", protocol.indexOf("export const PATHS")),
    );
    expect(paths.match(/^\s+\w+:/gm)?.map((k) => k.trim())).toEqual(["pair:", "heartbeat:", "status:"]);
    // the heartbeat response can carry no job: its schema admits only an empty array
    expect(protocol).toContain("jobs: z.array(z.never()).max(0)");
  });

  it("the agent CLI has no job, Asset, upload or signed-URL code path", () => {
    const { files } = graph(path.join(ROOT, "scripts", "local-agent.mts"));
    for (const f of files) {
      expect(f).not.toMatch(
        /^src\/server\/|storage|ingest|reconstruction-job|local-worker\/(worker|store|postgres-store|adapter)\./,
      );
      if (!f.startsWith("src/lib/local-agent/") && f !== "scripts/local-agent.mts") continue;
      // imports name the local toolchain probe and engine constants (capability facts only)
      const code = strip(readFileSync(path.join(ROOT, f), "utf8")).replace(/^import[^;]*;$/gm, "");
      expect(`${f}: ${code.match(JOB_WORDS)?.[0] ?? "none"}`).toBe(`${f}: none`);
    }
  });

  it("the server's agent-authenticated path reaches only the agent tables", () => {
    for (const mod of ["service.ts", "http.ts", "store.ts", "postgres-store.ts"]) {
      const { files } = graph(path.join(ROOT, "src", "server", "local-agent", mod));
      for (const f of files) {
        expect(f).not.toMatch(/reconstruction|storage|asset|generation|src\/data\//i);
      }
    }
    const sql = strip(
      readFileSync(path.join(ROOT, "src", "server", "local-agent", "postgres-store.ts"), "utf8"),
    );
    const authStore = sql.slice(
      sql.indexOf("class PostgresAgentAuthStore"),
      sql.indexOf("class PostgresOwnerAgentStore"),
    );
    const tables = new Set(
      [...authStore.matchAll(/\b(?:from|into|update|join)\s+([a-z_]+)/g)]
        .map((m) => m[1])
        .filter((t) => t !== "of"), // "for update of p"
    );
    expect([...tables].sort()).toEqual(["local_agent_pairings", "local_agents", "projects"]);
    // projects is only read (ownership re-check, title), never written
    expect(authStore).not.toMatch(/(?:update|insert into|delete from)\s+projects/);
  });
});
