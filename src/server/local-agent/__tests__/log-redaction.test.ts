import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig, { AGENT_LEASE_PATH_RE } from "../../../../next.config";

/**
 * Phase 2F M2D.3D1: a remote-agent lease id is part of the job route paths
 * (/api/local-agent/v1/jobs/<job>/leases/<lease>/...). It is not a credential, but no log needs it. The application's
 * own logging is enforced here; infrastructure (proxy / edge / platform) logs are a deployment gate
 * (docs/reconstruction-acceptance.md).
 */

const ROOT = process.cwd();
const JOB = "00000000-0000-4000-8000-000000000001";
const LEASE = "0123456789abcdef0123456789abcdef";

describe("application request logs never carry lease ids", () => {
  it("the dev server's request log skips exactly the lease routes", () => {
    const ignore = (nextConfig.logging as { incomingRequests: { ignore: RegExp[] } }).incomingRequests.ignore;
    expect(ignore).toContain(AGENT_LEASE_PATH_RE);
    for (const tail of ["sources/0", "progress", "fail", "result", "result?x=1"])
      expect(AGENT_LEASE_PATH_RE.test(`/api/local-agent/v1/jobs/${JOB}/leases/${LEASE}/${tail}`), tail).toBe(
        true,
      );
    for (const p of [
      "/api/local-agent/v1/jobs/lease",
      "/api/local-agent/v1/heartbeat",
      "/api/local-agent/v1/pair",
      "/api/local-agent/v1/status",
      "/projects/x/agents",
    ])
      expect(AGENT_LEASE_PATH_RE.test(p), p).toBe(false);
  });

  it("no log call in the agent server code or its routes formats a request URL, a path or a lease id", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }))
        if (e.isDirectory()) {
          if (e.name !== "__tests__") walk(path.join(dir, e.name));
        } else if (/\.tsx?$/.test(e.name)) files.push(path.join(dir, e.name));
    };
    walk(path.join(ROOT, "src", "server", "local-agent"));
    walk(path.join(ROOT, "src", "app", "api", "local-agent"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/console\.(?:log|info|warn|error|debug)\(([^;]*)\)/g))
        expect(`${path.basename(f)}: ${m[1]}`).not.toMatch(
          /\b(?:req|request)\.url\b|\.pathname\b|leaseId\b|nextUrl/,
        );
      // the structured job log never carries a lease id field
      for (const m of text.matchAll(/log\(deps, \{([^}]*)\}/g))
        expect(`${path.basename(f)}: ${m[1]}`).not.toMatch(/\blease(?:Id)?\s*:/);
    }
  });
});
