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

const saved = process.env.PRISM_LOCAL_AGENTS_ENABLED;
beforeEach(() => {
  Object.assign(touched, { pool: 0, repo: 0, user: 0, mode: 0 });
});
afterEach(() => {
  if (saved === undefined) delete process.env.PRISM_LOCAL_AGENTS_ENABLED;
  else process.env.PRISM_LOCAL_AGENTS_ENABLED = saved;
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
      const reqs = [post("/api/local-agent/v1/pair"), post("/api/local-agent/v1/heartbeat")];
      const statusReq = new Request("https://studio.example.test/api/local-agent/v1/status");
      const responses = [await pair(reqs[0]), await heartbeat(reqs[1]), await status(statusReq)];
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
