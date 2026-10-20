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

  it("the same-host worker (M2D.3B) never loads remote-agent code and only ever claims local_capture", () => {
    for (const entry of [
      "scripts/run-local-reconstruction-worker.mts",
      "src/lib/reconstruction/local-worker/worker.ts",
      "src/lib/reconstruction/local-worker/postgres-store.ts",
    ])
      for (const f of graph(path.join(ROOT, entry)).files) {
        expect(f).not.toMatch(/^src\/lib\/local-agent\/agent\//);
        expect(f).not.toMatch(/^src\/server\/local-agent\//);
      }
    const store = readFileSync(path.join(ROOT, "src/lib/reconstruction/local-worker/store.ts"), "utf8");
    expect(store).toContain('export const LOCAL_PROVIDER_ID = "local_capture";');
    // and the remote path only ever discovers local_agent_capture
    const remote = readFileSync(path.join(ROOT, "src/server/local-agent/jobs/store.ts"), "utf8");
    expect(remote).toContain("REMOTE_AGENT_PROVIDER_ID");
    expect(remote).not.toContain("LOCAL_PROVIDER_ID");
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

describe("M2D.3C2 remote execution boundary", () => {
  const strip = (t: string) => t.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const walk = (dir: string, out: string[] = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true }))
      if (e.isDirectory()) walk(path.join(dir, e.name), out);
      else out.push(path.relative(ROOT, path.join(dir, e.name)).replace(/\\/g, "/"));
    return out;
  };

  it("exposes exactly the versioned agent routes: pair, heartbeat, status and the four lease routes", () => {
    expect(walk(path.join(ROOT, "src", "app", "api", "local-agent")).sort()).toEqual([
      "src/app/api/local-agent/v1/heartbeat/route.ts",
      "src/app/api/local-agent/v1/jobs/[jobId]/leases/[leaseId]/fail/route.ts",
      "src/app/api/local-agent/v1/jobs/[jobId]/leases/[leaseId]/progress/route.ts",
      "src/app/api/local-agent/v1/jobs/[jobId]/leases/[leaseId]/result/route.ts",
      "src/app/api/local-agent/v1/jobs/[jobId]/leases/[leaseId]/sources/[ordinal]/route.ts",
      "src/app/api/local-agent/v1/jobs/lease/route.ts",
      "src/app/api/local-agent/v1/pair/route.ts",
      "src/app/api/local-agent/v1/status/route.ts",
    ]);
    // every one is behind the feature flag, first
    for (const f of walk(path.join(ROOT, "src", "app", "api", "local-agent"))) {
      const text = readFileSync(path.join(ROOT, f), "utf8");
      expect(text).toMatch(/if \(!localAgentsEnabled\(\)\) return agentError\("not_enabled"\);/);
    }
    // the heartbeat stays M2D.3C1-compatible: it never carries a job (leasing is its own route)
    const protocol = readFileSync(path.join(ROOT, "src", "lib", "local-agent", "protocol.ts"), "utf8");
    expect(protocol).toContain("jobs: z.array(z.never()).max(0)");
  });

  it("the agent CLI knows only the Prism agent protocol and the M2D.3A engine: no Storage client, no signed URL", () => {
    const { files, packages } = graph(path.join(ROOT, "scripts", "local-agent.mts"));
    expect(files).toContain("src/lib/local-agent/agent/executor.ts");
    expect(files).toContain("src/lib/reconstruction/local/engine.ts");
    for (const f of files) {
      expect(f).not.toMatch(/^src\/server\/|^src\/data\/|^src\/generation\/|^src\/lib\/supabase\//);
      expect(f).not.toMatch(/local-worker\/(worker|store|postgres-store|adapter|status)\.ts$/);
      const code = strip(readFileSync(path.join(ROOT, f), "utf8"));
      expect(
        `${f}: ${code.match(/signedUrl|createSignedUrl|storage\.from\(|supabase|service_role/i)?.[0] ?? "none"}`,
      ).toBe(`${f}: none`);
    }
    for (const pkg of packages) expect(pkg).not.toMatch(/^(pg|@supabase\/.*|server-only|next(\/.*)?)$/);
  });

  it("only the server's relay module reads the agent-relay Storage key, and it is server-only", () => {
    const relay = "src/server/local-agent/relay-storage.ts";
    expect(readFileSync(path.join(ROOT, relay), "utf8").startsWith('import "server-only"')).toBe(true);
    const readers = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))].filter(
      (f) =>
        /\.(m?[jt]sx?)$/.test(f) &&
        !f.includes("__tests__") &&
        // code, not documentation: comments may explain the key without reading it
        strip(readFileSync(path.join(ROOT, f), "utf8")).includes(
          "PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY",
        ),
    );
    // the relay module reads it; the redaction lists only NAME it so its value is never logged; the hosted test
    // harness (db:remote-agent-jobs) plays the SERVER's role. No agent-side module is ever among them.
    expect(readers.sort()).toEqual(
      ["scripts/db-remote-agent-jobs.mts", "scripts/lib/safety.mjs", relay, "src/lib/auth/redact.ts"].sort(),
    );
    // no client component reaches the relay or the job service
    for (const f of walk(path.join(ROOT, "src", "components")).filter((x) => x.endsWith(".tsx"))) {
      const text = readFileSync(path.join(ROOT, f), "utf8");
      expect(text).not.toMatch(/@\/server\/local-agent\/(relay-storage|jobs)/);
    }
  });

  it("the agent-authenticated auth store reaches only the agent tables; the job store only reconstruction jobs", () => {
    const sql = strip(
      readFileSync(path.join(ROOT, "src", "server", "local-agent", "postgres-store.ts"), "utf8"),
    );
    const authStore = sql.slice(
      sql.indexOf("class PostgresAgentAuthStore"),
      sql.indexOf("class PostgresOwnerAgentStore"),
    );
    const tablesOf = (text: string) =>
      [...new Set([...text.matchAll(/\b(?:from|into|update|join)\s+([a-z_]+)/g)].map((m) => m[1]))]
        .filter((t) => t !== "of") // "for update of p"
        .sort();
    expect(tablesOf(authStore)).toEqual(["local_agent_pairings", "local_agents", "projects"]);
    expect(authStore).not.toMatch(/(?:update|insert into|delete from)\s+projects/);
    // remote job discovery: one table, read only; everything else goes through the owner's RLS-bound repositories
    const jobs = strip(
      readFileSync(path.join(ROOT, "src", "server", "local-agent", "jobs", "store.ts"), "utf8"),
    );
    expect(tablesOf(jobs)).toEqual(["locations", "reconstruction_jobs"]);
    expect(jobs).not.toMatch(/\b(?:insert into|delete from|update)\s+\w+/i);
    expect(jobs).toContain("rlsPreamble(claims)");
  });
});
