import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "../../local/__tests__/fixtures";
import { UNVERIFIED_MESSAGE } from "../../local/colmap-provenance";
import { LocalCaptureProvider } from "../../local-capture";
import {
  acquireWorkerLock,
  HEARTBEAT_FILE,
  HEARTBEAT_SCHEMA,
  LOCK_FILE,
  newWorkerId,
  readHeartbeat,
  WORKER_VERSION,
  workRootId,
  writeHeartbeat,
  type ToolchainReadiness,
  type WorkerHeartbeat,
} from "../runtime";
import { localExecutionStatus, workerBackedToolchain } from "../status";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});
async function root() {
  const t = await tempDir("prism-local-worker-test-");
  cleanups.push(t.cleanup);
  return t.dir;
}

const T = Date.parse("2026-10-19T12:00:00Z");
const ready = (state: ToolchainReadiness["state"] = "ready"): ToolchainReadiness => ({
  state,
  colmap: { provenance: state === "colmap_unverified" ? "unverified" : "verified", version: "4.2.1" },
  brush: { version: "0.3.0", compatible: true },
  gpu: { loaderPresent: true },
  checkedAt: new Date(T).toISOString(),
});
const heartbeat = (dir: string, over: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat => ({
  schema: HEARTBEAT_SCHEMA,
  workerId: "local-0a1b2c3d-00ff00ff",
  pid: 4242,
  startedAt: new Date(T - 60_000).toISOString(),
  lastHeartbeatAt: new Date(T).toISOString(),
  workerVersion: WORKER_VERSION,
  workRoot: workRootId(dir),
  toolchain: ready(),
  busy: false,
  ...over,
});
const env = (dir: string) => ({
  PRISM_LOCAL_RECONSTRUCTION_WORKER_ENABLED: "1",
  PRISM_LOCAL_RECONSTRUCTION_ROOT: dir,
});

describe("worker identity", () => {
  it("is local-<hostname hash>-<random>: never the raw hostname", () => {
    const id = newWorkerId("STUDIO-PC-of-someone");
    expect(id).toMatch(/^local-[0-9a-f]{8}-[0-9a-f]{8}$/);
    expect(id).not.toMatch(/studio|someone/i);
    expect(newWorkerId("STUDIO-PC-of-someone").slice(0, 14)).toBe(id.slice(0, 14));
    expect(newWorkerId("STUDIO-PC-of-someone")).not.toBe(id);
  });
});

describe("heartbeat", () => {
  it("fresh → online; old → offline (stale, last facts kept); malformed → offline; another root → not accepted", async () => {
    const dir = await root();
    expect(readHeartbeat(dir, T)).toMatchObject({ state: "offline", reason: "missing" });

    await writeHeartbeat(dir, heartbeat(dir));
    expect(readHeartbeat(dir, T + 5_000)).toMatchObject({ state: "online" });
    const stale = readHeartbeat(dir, T + 16_000);
    expect(stale).toMatchObject({ state: "offline", reason: "stale" });
    expect(stale.state === "offline" && stale.last?.toolchain.state).toBe("ready");
    // a clock far in the future is not "fresh" either
    expect(readHeartbeat(dir, T - 60_000)).toMatchObject({ state: "offline", reason: "stale" });

    await writeFile(path.join(dir, HEARTBEAT_FILE), "{ not json");
    expect(readHeartbeat(dir, T)).toMatchObject({ state: "offline", reason: "malformed", last: null });
    await writeFile(
      path.join(dir, HEARTBEAT_FILE),
      JSON.stringify({ ...heartbeat(dir), dbUrl: "postgres://x" }),
    );
    expect(readHeartbeat(dir, T)).toMatchObject({ state: "offline", reason: "malformed" }); // strict: no extras

    const other = await root();
    await writeHeartbeat(dir, heartbeat(other)); // a heartbeat naming another work root
    expect(readHeartbeat(dir, T)).toMatchObject({ state: "offline", reason: "other_root", last: null });
  });

  it("is written atomically and holds only safe facts: no path, credential, URL or hostname", async () => {
    const dir = await root();
    for (let i = 0; i < 20; i++) await writeHeartbeat(dir, heartbeat(dir, { busy: i % 2 === 0 }));
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    const text = await readFile(path.join(dir, HEARTBEAT_FILE), "utf8");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      [
        "busy",
        "lastHeartbeatAt",
        "pid",
        "schema",
        "startedAt",
        "toolchain",
        "workRoot",
        "workerId",
        "workerVersion",
      ].sort(),
    );
    expect(text).not.toContain(dir);
    expect(text).not.toMatch(/postgres|https?:|key|secret|password/i);
  });
});

describe("single-worker lock", () => {
  const me = (pid = 1111) => ({
    workerId: `local-00000000-${String(pid).padStart(8, "0")}`,
    pid,
    startedAt: "t",
  });

  it("a second worker on the same root is refused while the first is alive (and nothing is killed)", async () => {
    const dir = await root();
    const first = await acquireWorkerLock(dir, me(1111), () => true);
    const probed: number[] = [];
    await expect(
      // the liveness check only PROBES the holder (signal 0); the other worker is never stopped
      acquireWorkerLock(dir, me(2222), (pid) => (probed.push(pid), true)),
    ).rejects.toThrow(/already running on this work root/);
    expect(probed).toEqual([1111]);
    await first.release();
    const second = await acquireWorkerLock(dir, me(2222), () => true);
    await second.release();
    expect(await readdir(dir)).not.toContain(LOCK_FILE);
  });

  it("a stale lock (its process is gone) is recovered; an unreadable one is refused, not deleted", async () => {
    const dir = await root();
    await acquireWorkerLock(dir, me(3333), () => true); // never released: a crash
    const next = await acquireWorkerLock(dir, me(4444), () => false);
    expect(next.recoveredStale).toMatchObject({ pid: 3333 });
    expect((await readdir(dir)).filter((n) => n.startsWith(LOCK_FILE))).toEqual([LOCK_FILE]);
    await next.release();

    await writeFile(path.join(dir, LOCK_FILE), "garbage");
    await expect(acquireWorkerLock(dir, me(5555), () => false)).rejects.toThrow(/unreadable/);
    expect(await readFile(path.join(dir, LOCK_FILE), "utf8")).toBe("garbage");
  });

  it("release removes only its own lock", async () => {
    const dir = await root();
    const a = await acquireWorkerLock(dir, me(1), () => false);
    await writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ schema: "x", workerId: "someone-else" }));
    await a.release();
    expect(await readdir(dir)).toContain(LOCK_FILE);
  });
});

describe("Local Capture availability = toolchain ready AND worker online", () => {
  const status = (dir: string, nowMs: number, e: Record<string, string> = env(dir)) =>
    localExecutionStatus({ env: e, persistence: "supabase", nowMs, repoRoot: path.join(dir, "..", "repo") });

  it("both ready → available, the free local default", async () => {
    const dir = await root();
    await writeHeartbeat(dir, heartbeat(dir));
    expect(status(dir, T)).toMatchObject({
      installed: true,
      reason: null,
      runtime: { worker: "online", toolchain: "ready", busy: false },
    });
    const p = new LocalCaptureProvider(
      workerBackedToolchain({
        env: env(dir),
        persistence: "supabase",
        now: () => T,
        repoRoot: path.join(dir, "..", "repo"),
      }),
    );
    expect(p.status()).toMatchObject({
      capability: "available",
      configured: true,
      local: { worker: "online" },
    });
  });

  it("verified toolchain but the worker stopped → unavailable (never 'ready')", async () => {
    const dir = await root();
    await writeHeartbeat(dir, heartbeat(dir));
    const s = status(dir, T + 60_000);
    expect(s).toMatchObject({ installed: false, runtime: { worker: "offline", toolchain: "ready" } });
    expect(s.reason).toMatch(/worker is not running/);
    expect(s.runtime?.toolchainLabel).toBe("Ready (last reported)");
    const p = new LocalCaptureProvider({ probe: () => s });
    expect(p.status()).toMatchObject({ capability: "unavailable", local: { worker: "offline" } });
  });

  it("worker running but the toolchain is not ready (unverified COLMAP, missing Brush, no GPU) → not usable", async () => {
    const dir = await root();
    for (const [state, reason] of [
      ["colmap_unverified", UNVERIFIED_MESSAGE],
      ["brush_missing", /Brush is not installed/],
      ["gpu_unavailable", /Vulkan/],
      ["colmap_missing", /COLMAP is not installed/],
    ] as const) {
      await writeHeartbeat(dir, heartbeat(dir, { toolchain: ready(state) }));
      const s = status(dir, T);
      expect(s).toMatchObject({ installed: false, runtime: { worker: "online", toolchain: state } });
      expect(s.reason).toMatch(reason);
      expect(new LocalCaptureProvider({ probe: () => s }).status().capability).toBe("not_installed");
    }
  });

  it("memory persistence, a disabled worker switch or an invalid root → not enabled (nothing is probed or started)", async () => {
    const dir = await root();
    await writeHeartbeat(dir, heartbeat(dir));
    expect(localExecutionStatus({ env: env(dir), persistence: "memory", nowMs: T })).toMatchObject({
      installed: false,
      runtime: { worker: "not_enabled" },
    });
    expect(status(dir, T, { PRISM_LOCAL_RECONSTRUCTION_ROOT: dir })).toMatchObject({
      installed: false,
      runtime: { worker: "not_enabled" },
    });
    expect(
      status(dir, T, {
        PRISM_LOCAL_RECONSTRUCTION_WORKER_ENABLED: "1",
        PRISM_LOCAL_RECONSTRUCTION_ROOT: "relative/root",
      }),
    ).toMatchObject({ installed: false, reason: expect.stringMatching(/work root/) });
  });

  it("busy is reported (queued jobs wait); the view never carries a path, pid or environment", async () => {
    const dir = await root();
    await writeHeartbeat(dir, heartbeat(dir, { busy: true }));
    const s = status(dir, T);
    expect(s.runtime).toEqual({ worker: "online", toolchain: "ready", toolchainLabel: "Ready", busy: true });
    expect(JSON.stringify(s)).not.toContain(dir);
    expect(JSON.stringify(s)).not.toContain("4242");
  });
});
