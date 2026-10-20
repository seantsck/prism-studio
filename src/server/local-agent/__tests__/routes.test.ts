import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The feature flag is the FIRST thing every agent endpoint checks: while PRISM_LOCAL_AGENTS_ENABLED is not "1", a
 * request is answered `not_enabled` before its body is read and before any store, database or repository is reached,
 * so nothing (a pairing offer, a device counter) can change.
 */

const touched = vi.hoisted(() => ({ pool: 0, repo: 0, user: 0, mode: 0 }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({ getPool: () => (touched.pool++, {}) }));
vi.mock("@/server/repo", () => ({ getRepo: async () => (touched.repo++, {}) }));
vi.mock("@/server/auth", () => ({ requireUser: async () => (touched.user++, {}) }));
vi.mock("@/lib/supabase/config", () => ({ persistenceMode: () => (touched.mode++, "supabase") }));
vi.mock("@/data/postgres-repository", () => ({ rlsPreamble: () => "" }));

const { POST: pair } = await import("@/app/api/local-agent/v1/pair/route");
const { POST: heartbeat } = await import("@/app/api/local-agent/v1/heartbeat/route");
const { GET: status } = await import("@/app/api/local-agent/v1/status/route");
const { POST: lease } = await import("@/app/api/local-agent/v1/jobs/lease/route");
const { GET: source } =
  await import("@/app/api/local-agent/v1/jobs/[jobId]/leases/[leaseId]/sources/[ordinal]/route");
const { POST: progressRoute } =
  await import("@/app/api/local-agent/v1/jobs/[jobId]/leases/[leaseId]/progress/route");
const { POST: failRoute } = await import("@/app/api/local-agent/v1/jobs/[jobId]/leases/[leaseId]/fail/route");
const { PUT: result } = await import("@/app/api/local-agent/v1/jobs/[jobId]/leases/[leaseId]/result/route");
const { agentServiceDeps, remoteJobDeps, remoteAgentAvailability } = await import("@/server/local-agent");

// test-only names: the variables this suite sets and restores (fictional values; never a real key)
const ENV_NAMES = [
  "PRISM_LOCAL_AGENTS_ENABLED",
  "PRISM_RECONSTRUCTION_JOBS_ENABLED",
  "PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY",
  "PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
] as const;
const saved = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
beforeEach(() => {
  Object.assign(touched, { pool: 0, repo: 0, user: 0, mode: 0 });
});
afterEach(() => {
  for (const n of ENV_NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

const JOB = "00000000-0000-4000-8000-000000000001";
const LEASE = "0123456789abcdef0123456789abcdef";
const leaseParams = { params: Promise.resolve({ jobId: JOB, leaseId: LEASE }) };
const jobUrl = (tail: string) =>
  `https://studio.example.test/api/local-agent/v1/jobs/${JOB}/leases/${LEASE}/${tail}`;
const bigUpload = () =>
  new Request(jobUrl("result"), {
    method: "PUT",
    headers: {
      "content-type": "application/x-spz",
      "content-length": String(40 * 1024 * 1024),
      "x-prism-agent-id": "00000000-0000-4000-8000-000000000002",
    },
    body: new Uint8Array(16),
  });

const post = (path: string) =>
  new Request(`https://studio.example.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-prism-agent-counter": "1" },
    body: JSON.stringify({ protocol: "prism.local-agent.v1" }),
  });

describe("agent endpoints while local agents are disabled", () => {
  it.each([undefined, "", "0", "true", "yes", " 1"])(
    "PRISM_LOCAL_AGENTS_ENABLED=%j → not_enabled, nothing touched",
    async (v) => {
      if (v === undefined) delete process.env.PRISM_LOCAL_AGENTS_ENABLED;
      else process.env.PRISM_LOCAL_AGENTS_ENABLED = v;
      const reqs = [
        post("/api/local-agent/v1/pair"),
        post("/api/local-agent/v1/heartbeat"),
        post("/api/local-agent/v1/jobs/lease"),
        new Request(jobUrl("progress"), { method: "POST", body: "{}" }),
        new Request(jobUrl("fail"), { method: "POST", body: "{}" }),
        bigUpload(),
      ];
      const statusReq = new Request("https://studio.example.test/api/local-agent/v1/status");
      const sourceReq = new Request(jobUrl("sources/0"));
      const responses = [
        await pair(reqs[0]),
        await heartbeat(reqs[1]),
        await status(statusReq),
        await lease(reqs[2]),
        await source(sourceReq, {
          params: Promise.resolve({ jobId: JOB, leaseId: LEASE, ordinal: "0" }),
        }),
        await progressRoute(reqs[3], leaseParams),
        await failRoute(reqs[4], leaseParams),
        await result(reqs[5], leaseParams),
      ];
      for (const r of responses) {
        expect(r.status).toBe(404);
        expect(r.headers.get("cache-control")).toBe("no-store");
        const body = await r.json();
        expect(body).toMatchObject({ ok: false, error: { code: "not_enabled" } });
      }
      // no body was read, and no store, pool, repository or session was reached
      for (const r of reqs) expect(r.bodyUsed).toBe(false);
      expect(touched).toEqual({ pool: 0, repo: 0, user: 0, mode: 0 });
    },
  );

  it("only the exact value 1 enables them (the store is then reached)", async () => {
    process.env.PRISM_LOCAL_AGENTS_ENABLED = "1";
    await status(new Request("https://studio.example.test/api/local-agent/v1/status")).catch(() => undefined);
    expect(touched.mode).toBe(1);
  });
});

describe("remote agents enabled, but no dedicated agent-relay key (fail closed, no fallback)", () => {
  const configure = (extra: Record<string, string>) => {
    process.env.PRISM_LOCAL_AGENTS_ENABLED = "1";
    process.env.PRISM_RECONSTRUCTION_JOBS_ENABLED = "1";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://lyqdxiyjperhniwhzsvg.supabase.co";
    delete process.env.PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY;
    // other privileged keys present on the server must NOT be used in its place
    process.env.PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY = "sb_secret_fictional_worker_key_for_tests";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_fictional_service_role_for_tests";
    Object.assign(process.env, extra);
  };

  it("execution is unavailable; the control plane (pair/heartbeat/status) is not affected", async () => {
    configure({});
    expect((await remoteJobDeps()).available).toBe(false);
    // the heartbeat/status still work; status then reports remoteExecution "not_available"
    expect((await agentServiceDeps()).remoteJobs).toBe(false);
    expect(await remoteAgentAvailability("00000000-0000-4000-8000-0000000000aa")).toMatchObject({
      state: "not_configured",
    });
  });

  it("a result upload is refused before its body is read or the database is reached", async () => {
    configure({});
    const req = bigUpload();
    const r = await result(req, leaseParams);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ ok: false, error: { code: "job_not_available" } });
    expect(req.bodyUsed).toBe(false);
  });

  it("with the dedicated key configured, execution becomes available", async () => {
    configure({ PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY: "sb_secret_fictional_relay_key_for_tests" });
    expect((await remoteJobDeps()).available).toBe(true);
    expect((await agentServiceDeps()).remoteJobs).toBe(true);
  });

  it("a publishable key in the relay variable is refused (fail closed)", async () => {
    configure({ PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY: "sb_publishable_fictional" });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await remoteJobDeps()).available).toBe(false);
      // the log names the variable, never its value
      expect(JSON.stringify(err.mock.calls)).not.toContain("sb_publishable_fictional");
    } finally {
      err.mockRestore();
    }
  });
});
