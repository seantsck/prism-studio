import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GenerationWorker } from "@/generation/worker";
import { readGenerationConfig } from "@/generation/config";
import { healthPortFrom, startLivenessServer, WorkerLiveness } from "../worker-health";

describe("5A.1 worker liveness", () => {
  it("is live within the window, stuck after it, and only a completed loop resets it", () => {
    let t = 1_000;
    const l = new WorkerLiveness({ staleAfterMs: 100, now: () => t });
    expect(l.report()).toMatchObject({ live: true, lastLoopAgoMs: null, loops: 0 });
    t += 150; // startup gets the same window, then counts as stuck
    expect(l.report().live).toBe(false);
    l.beat({ ok: true, processed: 2 });
    expect(l.report()).toMatchObject({ live: true, lastLoopAgoMs: 0, loops: 1, processed: 2 });
    t += 101;
    expect(l.report().live).toBe(false);
  });

  it("reports consecutive tick failures without failing liveness (a dependency outage is not a stuck process)", () => {
    let t = 0;
    const l = new WorkerLiveness({ staleAfterMs: 1_000, now: () => t });
    l.beat({ ok: false, processed: 0 });
    t += 10;
    l.beat({ ok: false, processed: 0 });
    expect(l.report()).toMatchObject({ live: true, consecutiveFailures: 2 });
    l.beat({ ok: true, processed: 1 });
    expect(l.report().consecutiveFailures).toBe(0);
  });

  it("parses the port strictly and refuses a bad window", () => {
    expect(healthPortFrom(undefined)).toBeNull();
    expect(healthPortFrom(" ")).toBeNull();
    expect(healthPortFrom("8080")).toBe(8080);
    for (const bad of ["0", "70000", "80.5", "http"]) expect(() => healthPortFrom(bad), bad).toThrow();
    expect(() => new WorkerLiveness({ staleAfterMs: 0 })).toThrow();
  });

  let server: Server | null = null;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it("serves GET /healthz as 200 / 503 JSON with counts only, and 404 for anything else", async () => {
    let t = 0;
    const l = new WorkerLiveness({ staleAfterMs: 50, now: () => t });
    server = await startLivenessServer(l, 0, "127.0.0.1");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ok = await fetch(`${base}/healthz`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["consecutiveFailures", "lastLoopAgoMs", "live", "loops", "processed", "startedAgoMs"].sort(),
    );
    t += 51;
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/healthz`, { method: "POST" })).status).toBe(404);
  });
});

describe("5A.1 GenerationWorker.run observer", () => {
  const config = readGenerationConfig({
    PRISM_STUDIO_WORKER_IDLE_POLL_MS: "100",
  } as unknown as NodeJS.ProcessEnv);
  const worker = (claim: () => Promise<unknown[]>) =>
    new GenerationWorker({
      store: { claim } as never,
      registry: {} as never,
      sink: {} as never,
      config,
      logger: { info() {}, warn() {}, error() {} },
    });

  it("reports each completed iteration, ok and failed, and stops on abort", async () => {
    let calls = 0;
    const w = worker(async () => {
      calls += 1;
      if (calls === 2) throw new Error("db down");
      return [];
    });
    const seen: Array<{ ok: boolean; processed: number }> = [];
    const ctl = new AbortController();
    await w.run(ctl.signal, (e) => {
      seen.push({ ok: e.ok, processed: e.processed });
      if (seen.length === 3) ctl.abort();
    });
    expect(seen).toEqual([
      { ok: true, processed: 0 },
      { ok: false, processed: 0 },
      { ok: true, processed: 0 },
    ]);
  });

  it("an observer that throws never stops the worker", async () => {
    let calls = 0;
    const ctl = new AbortController();
    const w = worker(async () => {
      calls += 1;
      if (calls === 3) ctl.abort();
      return [];
    });
    await w.run(ctl.signal, () => {
      throw new Error("observer bug");
    });
    expect(calls).toBe(3);
  });
});

describe("5A.1 generation worker image", () => {
  const root = path.resolve(__dirname, "../../..");
  const dockerfile = readFileSync(path.join(root, "Dockerfile.generation-worker"), "utf8");
  const ignore = readFileSync(path.join(root, ".dockerignore"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim());
  const instructions = dockerfile.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));

  it("never lets an env file, git metadata or local build state into the build context", () => {
    for (const entry of [
      ".env",
      ".env.*",
      "**/.env",
      "**/.env.*",
      ".vercel",
      ".git",
      "node_modules",
      ".next",
    ])
      expect(ignore, entry).toContain(entry);
  });

  it("declares no ARG (platform build args never reach the image) and bakes in no credential", () => {
    expect(instructions.some((l) => /^\s*ARG\b/i.test(l))).toBe(false);
    expect(instructions.join("\n")).not.toMatch(
      /SECRET|PASSWORD|API_KEY|DB_URL|sb_secret|postgres(ql)?:\/\//i,
    );
    expect(
      instructions.some((l) => /^\s*COPY\s+\.\s/i.test(l)),
      "no whole-context COPY",
    ).toBe(false);
  });

  it("runs as a non-root user, in production mode, as a single Node process (SIGTERM reaches the worker)", () => {
    expect(instructions.some((l) => /^\s*USER\s+node\b/.test(l))).toBe(true);
    expect(dockerfile).toMatch(/NODE_ENV=production/);
    expect(instructions.at(-1)).toBe('CMD ["node", "--import", "tsx", "scripts/generation-worker.mts"]');
  });
});
