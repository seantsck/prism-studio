import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismServer } from "@/server/local-agent/jobs/__tests__/prism-server";
import { remoteWorld } from "@/server/local-agent/jobs/__tests__/world";
import { createPairingOffer } from "@/server/local-agent/service";
import { refreshJob } from "@/server/reconstruction-jobs";
import { fakeMachine, machineEnv } from "../../../reconstruction/local/__tests__/fake-machine";
import { tempDir } from "../../../reconstruction/local/__tests__/fixtures";

/**
 * Phase 2F M2D.3C2 with the REAL agent CLI as a separate process (the way a workstation runs it): a minimal
 * environment with NO database, Supabase, Storage, worker or provider credential; fake M2D.3A tools behind a
 * verified provenance manifest. Prism is a real HTTP server running the production handlers. These are the process-
 * level cases a browser test cannot drive: a crash mid-run, a crash after a validated result, Prism going away.
 */

let tmp: Awaited<ReturnType<typeof tempDir>>;
let w: Awaited<ReturnType<typeof remoteWorld>>;
let srv: Awaited<ReturnType<typeof prismServer>>;
let machine: Awaited<ReturnType<typeof fakeMachine>>;
const children: ChildProcess[] = [];

beforeEach(async () => {
  tmp = await tempDir("prism-agent-cli-");
  machine = await fakeMachine(path.join(tmp.dir, "machine"));
  w = await remoteWorld({ clock: "real" });
  srv = await prismServer(w.deps);
});
afterEach(async () => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill();
  await srv.close();
  await tmp.cleanup();
});

const home = () => path.join(tmp.dir, "agent-home");

/** The real CLI, minimal environment. Returns the process, its output so far, and its exit. */
function cli(args: string[], extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    TEMP: process.env.TEMP ?? os.tmpdir(),
    TMP: process.env.TMP ?? os.tmpdir(),
    NODE_ENV: "test",
    PRISM_LOCAL_AGENT_HOME: home(),
    ...machineEnv(machine),
    // the process itself needs the real SystemRoot; the fake one (with the Vulkan loader) is for the probe only
    SystemRoot: process.env.SystemRoot ?? "",
    PRISM_LOCAL_TEST_SYSTEM_ROOT: machine.sysRoot,
    ...extra,
  };
  for (const k of Object.keys(env))
    if (/SUPABASE|DATABASE|DB_URL|SECRET|SERVICE|WLT_|OPENAI|GEMINI/.test(k)) delete env[k];
  const child = spawn(
    process.execPath,
    [path.resolve("node_modules/tsx/dist/cli.mjs"), "scripts/local-agent.mts", ...args],
    {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: env as NodeJS.ProcessEnv,
    },
  );
  children.push(child);
  const out = { text: "" };
  child.stdout!.on("data", (d: Buffer) => (out.text += String(d)));
  child.stderr!.on("data", (d: Buffer) => (out.text += String(d)));
  const exit = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, out, exit, env };
}

async function pair(projectId = w.A, profile = "default") {
  const offer = await createPairingOffer(w.agentStore, projectId);
  const p = cli([
    "pair",
    "--server",
    srv.origin,
    "--code",
    offer.code,
    "--label",
    "Fictional rig",
    "--profile",
    profile,
  ]);
  expect(await p.exit, p.out.text).toBe(0);
  expect(p.out.text).not.toContain(offer.code);
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** COLMAP RECONSTRUCTION runs recorded by the fake (version/help probes are not reconstructions) */
const colmapRuns = async (record: string) =>
  (await readFile(record, "utf8").catch(() => ""))
    .split(/\r?\n/)
    .filter((l) => l.includes('"feature_extractor"')).length;

const runArgs = (profile = "default", jobs = 1) => [
  "run",
  "--fake-tools",
  "--max-jobs",
  String(jobs),
  "--poll-ms",
  "200",
  "--profile",
  profile,
];
const workDirs = async (profile = "default") =>
  (await readdir(path.join(home(), "work", profile)).catch(() => [] as string[])).filter((n) =>
    n.startsWith("ra-"),
  );

describe("the real agent CLI process", { timeout: 180_000 }, () => {
  it("runs a remote job end to end with no server credential in its environment", async () => {
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    await pair();
    const r = cli(runArgs());
    expect(Object.keys(r.env).some((k) => /SUPABASE|DB_URL|WORKER|SERVICE_ROLE|WLT_/.test(k))).toBe(false);
    expect(await r.exit, r.out.text).toBe(0);
    expect(r.out.text).toContain("Jobs: succeeded");
    expect((await w.job(job.id))!.status).toBe("succeeded");
    expect(await workDirs()).toEqual([]);
    // the console never shows a path to a photograph, a key, or Prism storage details
    expect(r.out.text).not.toMatch(/BEGIN PRIVATE KEY|objectPath|\.local-storage|prism-assets/);
  });

  it("crash before a validated result → restart reports the attempt failed; COLMAP/Brush are not run again", async () => {
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    await pair();
    const record = path.join(tmp.dir, "colmap-calls.jsonl");
    const first = cli(runArgs(), { FAKE_BRUSH_MODE: "slow", FAKE_COLMAP_RECORD: record });
    await waitFor(
      "training",
      async () => (await w.job(job.id))?.providerOperation?.stage === "splat_training",
    );
    first.child.kill("SIGKILL"); // a crash: nothing is reported, the lease is still live
    await first.exit;
    const callsBefore = await colmapRuns(record);
    expect(callsBefore).toBe(1);
    expect((await w.job(job.id))!.status).toBe("running");
    const second = cli(runArgs(), { FAKE_COLMAP_RECORD: record });
    expect(await second.exit, second.out.text).toBe(0);
    expect(second.out.text).toContain("Jobs: failed");
    expect(await colmapRuns(record)).toBe(callsBefore);
    const failed = (await w.job(job.id))!;
    expect(failed).toMatchObject({ status: "failed", errorCode: "provider_failed" });
    expect(failed.errorMessage).toMatch(/stopped before the run completed/);
  });

  it("crash after a validated result → restart uploads the retained SPZ only (no second engine run)", async () => {
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    await pair();
    const record = path.join(tmp.dir, "colmap-calls.jsonl");
    const first = cli(runArgs(), { PRISM_AGENT_TEST_CRASH_BEFORE_UPLOAD: "1", FAKE_COLMAP_RECORD: record });
    expect(await first.exit).toBe(137);
    expect(first.out.text).toContain("simulated crash before upload");
    const calls = await colmapRuns(record);
    expect(calls).toBe(1);
    expect((await w.job(job.id))!.status).toBe("running");
    const second = cli(runArgs(), { FAKE_COLMAP_RECORD: record });
    expect(await second.exit, second.out.text).toBe(0);
    expect(second.out.text).toContain("a validated result is retained: uploading it (no re-run)");
    expect(second.out.text).toContain("Jobs: succeeded");
    expect(await colmapRuns(record)).toBe(calls);
    expect((await w.job(job.id))!.status).toBe("succeeded");
    expect(await workDirs()).toEqual([]);
  });

  it("Prism unreachable past the lease: the agent stops the engine, uploads nothing; Prism fails the attempt", async () => {
    // longer than one keepalive (10 s) plus the agent's safety margin, short enough for a test
    w.deps.leaseTtlMs = 20_000;
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    await pair();
    const r = cli(runArgs(), { FAKE_BRUSH_MODE: "slow" });
    await waitFor(
      "training",
      async () => (await w.job(job.id))?.providerOperation?.stage === "splat_training",
    );
    srv.state.down = true;
    expect(await r.exit, r.out.text).toBe(0);
    expect(r.out.text).toMatch(/stopping \(lease_lost\)/);
    expect(r.out.text).toContain("Jobs: lost");
    expect(srv.log.some((l) => l.startsWith("PUT "))).toBe(false);
    srv.state.down = false;
    await new Promise((res) => setTimeout(res, 1_000));
    expect(await refreshJob(await w.jobDeps(w.A), job.id)).toMatchObject({
      status: "failed",
      errorCode: "provider_timeout",
    });
  });

  it("two workstations of one project, one job: exactly one runs it; another project's agent never sees it", async () => {
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    await pair(w.A, "rig-1");
    await pair(w.A, "rig-2");
    await pair(w.B, "foreign");
    const runs = [cli(runArgs("rig-1")), cli(runArgs("rig-2")), cli(runArgs("foreign"))];
    await waitFor("the job to finish", async () => (await w.job(job.id))?.status === "succeeded");
    for (const r of runs) r.child.kill();
    await Promise.all(runs.map((r) => r.exit));
    const leasedBy = runs.filter((r) => r.out.text.includes(`leased job …${job.id.slice(-8)}`));
    expect(leasedBy).toHaveLength(1);
    expect(runs[2]!.out.text).not.toContain("leased job");
    // the job's sources were fetched by exactly one device, once each
    expect(srv.log.filter((l) => l.includes(`/jobs/${job.id}/`) && l.includes("/sources/"))).toHaveLength(3);
  });
});
