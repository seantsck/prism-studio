import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cancelJob, refreshJob } from "@/server/reconstruction-jobs";
import { failJobsOfAgent } from "@/server/local-agent/jobs/service";
import { prismServer } from "@/server/local-agent/jobs/__tests__/prism-server";
import { remoteWorld } from "@/server/local-agent/jobs/__tests__/world";
import { createPairingOffer, revokeAgent } from "@/server/local-agent/service";
import { fakeMachine, machineEnv } from "../../../reconstruction/local/__tests__/fake-machine";
import { fakeBrush, fakeColmap } from "../../../reconstruction/local/__tests__/fake-tools";
import { tempDir } from "../../../reconstruction/local/__tests__/fixtures";
import { runLocalReconstruction } from "../../../reconstruction/local/engine";
import { probeLocalToolchain } from "../../../reconstruction/local/toolchain";
import { AgentClient, pairAgent } from "../client";
import { executeLease, resumeJob } from "../executor";
import { JOB_STATE_FILE, readJobState, writeJobState } from "../job-state";
import { capabilitiesFromProbe, jobToolchainFromProbe, runAgent, type RunOutcome } from "../run";

/**
 * Phase 2F M2D.3C2: the REAL agent client and executor against a real HTTP server running the production Prism
 * handlers (memory stores). COLMAP and Brush are the M2D.3A fakes, run as real child processes behind a verified
 * provenance manifest; everything from the PLY on (validation, SPZ conversion, upload, re-validation, ingestion) is
 * production code. No browser is involved in execution.
 */

let tmp: Awaited<ReturnType<typeof tempDir>>;
let w: Awaited<ReturnType<typeof remoteWorld>>;
let srv: Awaited<ReturnType<typeof prismServer>>;
let machine: Awaited<ReturnType<typeof fakeMachine>>;

beforeEach(async () => {
  tmp = await tempDir("prism-agent-jobs-");
  machine = await fakeMachine(path.join(tmp.dir, "machine"));
  w = await remoteWorld({ clock: "real" });
  srv = await prismServer(w.deps);
});
afterEach(async () => {
  await srv.close();
  await tmp.cleanup();
});

const profile = (name = "rig") => path.join(tmp.dir, "home", "profiles", name);
const workRoot = (name = "rig") => path.join(tmp.dir, "home", "work", name);

const probe = (brush = "success", o: { manifest?: boolean } = {}) =>
  probeLocalToolchain({
    platform: "win32",
    env:
      o.manifest === false
        ? { ...machineEnv(machine), PRISM_COLMAP_PROVENANCE_PATH: "" }
        : machineEnv(machine),
    commandFor: (tool) => (tool === "colmap" ? fakeColmap("success") : fakeBrush(brush)),
  });

async function pairedClient(projectId = w.A, name = "rig") {
  const offer = await createPairingOffer(w.agentStore, projectId);
  await pairAgent({
    profileDir: profile(name),
    server: srv.origin,
    code: offer.code,
    label: "Fictional rig",
  });
  return AgentClient.open(profile(name));
}

/** One heartbeat with the ready (fake) toolchain, so Prism knows this device can run jobs. */
async function beat(client: AgentClient) {
  await client.heartbeat(
    capabilitiesFromProbe(await probe(), new Date().toISOString(), "win32", "x64", { remoteJobs: true }),
  );
}

function run(
  client: AgentClient,
  o: {
    brush?: string;
    maxJobs?: number;
    signal?: AbortSignal;
    engine?: typeof runLocalReconstruction;
    manifest?: boolean;
    name?: string;
  } = {},
): Promise<RunOutcome> {
  return runAgent({
    client,
    capabilities: async (s) =>
      capabilitiesFromProbe(await probe(o.brush, o), new Date().toISOString(), "win32", "x64", {
        busy: s?.busy,
        remoteJobs: true,
      }),
    intervalMs: 150,
    signal: o.signal,
    jobs: {
      profileDir: profile(o.name),
      workRoot: workRoot(o.name),
      toolchain: async () => jobToolchainFromProbe(await probe(o.brush, o)),
      maxJobs: o.maxJobs ?? 1,
      leasePollMs: 100,
      keepaliveMs: 250,
      marginMs: 600,
      engine: o.engine,
    },
  });
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const runDirs = async (name = "rig") =>
  (await readdir(workRoot(name)).catch(() => [] as string[])).filter((n) => n.startsWith("ra-"));

describe("remote execution end to end (agent ↔ production handlers)", { timeout: 90_000 }, () => {
  it("leases, downloads exactly its photographs, runs M2D.3A, uploads one SPZ; Prism imports it", async () => {
    const imgs = await w.addImages(w.A, 3);
    await w.addImages(w.A, 2); // other project images exist: they are never requested
    const job = await w.remoteJob(w.A, imgs);
    const client = await pairedClient();
    let engineRuns = 0;
    const out = await run(client, {
      engine: (...a) => {
        engineRuns++;
        return runLocalReconstruction(...a);
      },
    });
    expect(out).toMatchObject({ kind: "jobs_done", outcomes: [{ kind: "succeeded", jobId: job.id }] });
    expect(engineRuns).toBe(1);
    const done = (await w.job(job.id))!;
    expect(done.status).toBe("succeeded");
    const rec = (await w.repo.previs.getReconstruction(done.resultReconstructionId!))!;
    expect(rec.generation!.metadata).toMatchObject({
      runner: "remote_agent",
      agentId: client.device.deviceId,
    });
    expect(rec.calibration).toMatchObject({ scaleMethod: "unknown" });
    // exactly its own photographs, each once, in order
    const sources = srv.log.filter((l) => l.includes("/sources/"));
    expect(sources).toEqual(
      [0, 1, 2].map(
        (i) =>
          `GET /api/local-agent/v1/jobs/${job.id}/leases/${done.providerOperationId!.slice(6)}/sources/${i}`,
      ),
    );
    expect(srv.log.filter((l) => l.startsWith("PUT "))).toHaveLength(1);
    // progress reached the job (stages are events), and nothing is left on the workstation
    const stages = (await w.events(job.id)).filter((e) => e.event === "progress").map((e) => e.detail.stage);
    expect(stages).toEqual(expect.arrayContaining(["camera_reconstruction", "splat_training", "uploading"]));
    expect(await runDirs()).toEqual([]);
    expect(await readJobState(profile())).toBeNull();
  });

  it("toolchain gate: an unready workstation never asks for a lease", async () => {
    await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const client = await pairedClient();
    const stop = new AbortController();
    const p = run(client, { manifest: false, signal: stop.signal });
    await waitFor(
      "three heartbeats",
      async () => srv.log.filter((l) => l.endsWith("/heartbeat")).length >= 3,
    );
    stop.abort();
    expect((await p).kind).toBe("stopped");
    expect(srv.log.some((l) => l.includes("/jobs/lease"))).toBe(false);
    expect((await w.repo.previs.listReconstructionJobs(w.locA))[0]!.status).toBe("queued");
  });

  it("one job at a time: the second is leased only after the first reached an outcome", async () => {
    const imgs = await w.addImages(w.A, 4);
    const j1 = await w.remoteJob(w.A, imgs.slice(0, 3));
    w.advance(1000);
    const j2 = await w.remoteJob(w.A, imgs.slice(1, 4));
    const client = await pairedClient();
    const out = await run(client, { maxJobs: 2 });
    expect(out).toMatchObject({
      kind: "jobs_done",
      outcomes: [
        { kind: "succeeded", jobId: j1.id },
        { kind: "succeeded", jobId: j2.id },
      ],
    });
    const firstPut = srv.log.findIndex((l) => l.startsWith("PUT "));
    const leasesBeforeFirstPut = srv.log.slice(0, firstPut).filter((l) => l.endsWith("/jobs/lease")).length;
    const secondLeaseAt = srv.log.findIndex((l, i) => i > firstPut && l.endsWith("/jobs/lease"));
    expect(leasesBeforeFirstPut).toBe(1);
    expect(secondLeaseAt).toBeGreaterThan(firstPut);
  });

  it("cancel: the next keepalive learns it, the engine (process tree) stops, nothing is uploaded or stored", async () => {
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const client = await pairedClient();
    const p = run(client, { brush: "slow" });
    await waitFor(
      "training",
      async () => (await w.job(job.id))?.providerOperation?.stage === "splat_training",
    );
    await cancelJob(await w.jobDeps(w.A), job.id);
    const out = await p;
    expect(out).toMatchObject({ kind: "jobs_done", outcomes: [{ kind: "cancelled", jobId: job.id }] });
    expect((await w.job(job.id))!.status).toBe("cancelled");
    expect(srv.log.some((l) => l.startsWith("PUT "))).toBe(false);
    expect((await w.assetsOf(w.A)).some((a) => a.purpose === "spatial_reconstruction")).toBe(false);
    // only bounded diagnostics may remain: no photographs, no COLMAP/Brush work, no output
    for (const d of await runDirs()) {
      const left = await readdir(path.join(workRoot(), d));
      expect(left.filter((n) => ["input", "output", "colmap", "brush"].includes(n))).toEqual([]);
    }
  });

  it("network loss beyond the lease: the agent stops the engine and uploads nothing; Prism fails the attempt", async () => {
    w.deps.leaseTtlMs = 2_500;
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const client = await pairedClient();
    const p = run(client, { brush: "slow" });
    await waitFor(
      "training",
      async () => (await w.job(job.id))?.providerOperation?.stage === "splat_training",
    );
    srv.state.down = true;
    const out = await p;
    expect(out).toMatchObject({ kind: "jobs_done", outcomes: [{ kind: "lost", jobId: job.id }] });
    expect(srv.log.some((l) => l.startsWith("PUT "))).toBe(false);
    srv.state.down = false;
    // the next owner refresh (or lease request) fails the stale attempt; it is never re-leased
    await new Promise((r) => setTimeout(r, 2_600));
    expect(await refreshJob(await w.jobDeps(w.A), job.id)).toMatchObject({
      status: "failed",
      errorCode: "provider_timeout",
    });
  });

  it("revoked during a job: the agent stops at once; the attempt is failed, not reassigned", async () => {
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const client = await pairedClient();
    const p = run(client, { brush: "slow" });
    await waitFor(
      "training",
      async () => (await w.job(job.id))?.providerOperation?.stage === "splat_training",
    );
    await revokeAgent(w.agentStore, w.A, client.device.deviceId);
    await failJobsOfAgent(w.deps.jobs, w.A, w.owner, client.device.deviceId);
    const out = await p;
    expect(["fatal", "jobs_done"]).toContain(out.kind);
    expect(await w.job(job.id)).toMatchObject({ status: "failed", errorCode: "provider_failed" });
    expect(srv.log.some((l) => l.startsWith("PUT "))).toBe(false);
  });

  it("a downloaded photograph that does not match its frozen checksum is never reconstructed", async () => {
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    await pairedClient();
    // a man-in-the-middle-like fault: the server's answer for photograph 2 is altered in transit
    const tampering = await AgentClient.open(profile(), {
      fetch: async (u, init) => {
        const r = await fetch(u, init);
        if (!String(u).endsWith("/sources/1")) return r;
        const bytes = new Uint8Array(await r.arrayBuffer());
        bytes[bytes.length - 1] ^= 0xff;
        return new Response(bytes, { status: r.status, headers: r.headers });
      },
    });
    let engineRuns = 0;
    const out = await run(tampering, {
      engine: async (...a) => (engineRuns++, runLocalReconstruction(...a)),
    });
    expect(out).toMatchObject({ kind: "jobs_done", outcomes: [{ kind: "failed", code: "source_invalid" }] });
    expect(engineRuns).toBe(0);
    expect(await w.job(job.id)).toMatchObject({ status: "failed", errorCode: "invalid_sources" });
    expect(await runDirs()).toEqual([]);
  });

  it("an unexpected error inside a run stops its keepalive (no stray loop, no unhandled rejection); the persisted state then fails the attempt", async () => {
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const client = await pairedClient();
    // a defect, not a protocol answer: the first source download throws a plain TypeError mid-run
    const download = client.downloadSource.bind(client);
    let thrown = 0;
    client.downloadSource = async (...a: Parameters<typeof download>) => {
      if (thrown++ === 0) {
        await new Promise((r) => setTimeout(r, 700)); // let the keepalive run a few times first
        throw new TypeError("fictional defect");
      }
      return download(...a);
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      let engineRuns = 0;
      const out = await run(client, {
        engine: async (...a) => (engineRuns++, runLocalReconstruction(...a)),
      });
      // the run loop survived the defect: the kept job state was resolved on the next pass (reported, never re-run)
      expect(out).toMatchObject({
        kind: "jobs_done",
        outcomes: [{ kind: "deferred" }, { kind: "failed", jobId: job.id, code: "interrupted" }],
      });
      expect(engineRuns).toBe(0);
      expect(await w.job(job.id)).toMatchObject({ status: "failed", errorCode: "provider_failed" });
      const progressCalls = () => srv.log.filter((l) => l.endsWith("/progress")).length;
      expect(progressCalls()).toBeGreaterThan(0); // the keepalive did run before the defect
      const settled = progressCalls();
      await new Promise((r) => setTimeout(r, 1_500)); // six keepalive intervals
      expect(progressCalls()).toBe(settled);
      expect(unhandled).toEqual([]);
      expect(await readJobState(profile())).toBeNull();
      expect(srv.log.some((l) => l.startsWith("PUT "))).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("the executor itself: an unexpected error stops and settles the keepalive before it is rethrown", async () => {
    await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const client = await pairedClient();
    await beat(client);
    const r = await client.lease();
    expect(r.lease).not.toBeNull();
    // a server that would renew forever: only the executor's own cleanup can stop the keepalive
    let keepalives = 0;
    const stub = {
      device: client.device,
      progress: async () => {
        keepalives++;
        const now = Date.now();
        return {
          protocol: "prism.local-agent.v1" as const,
          ok: true as const,
          serverTime: new Date(now).toISOString(),
          leaseExpiresAt: new Date(now + 120_000).toISOString(),
          leaseTtlMs: 120_000,
        };
      },
      fail: async () => {
        throw new Error("not expected");
      },
      uploadResult: async () => {
        throw new Error("not expected");
      },
      downloadSource: async () => {
        await new Promise((res) => setTimeout(res, 600));
        throw new TypeError("fictional defect");
      },
    } as unknown as Parameters<typeof executeLease>[0]["client"];
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        executeLease(
          {
            client: stub,
            profileDir: profile(),
            workRoot: workRoot(),
            toolchain: jobToolchainFromProbe(await probe()),
            keepaliveMs: 100,
            marginMs: 600,
          },
          r.lease!,
          r.serverTime,
        ),
      ).rejects.toThrow("fictional defect");
      expect(keepalives).toBeGreaterThan(0); // it was running
      const settled = keepalives;
      await new Promise((res) => setTimeout(res, 1_000)); // ten keepalive intervals
      expect(keepalives).toBe(settled);
      expect(unhandled).toEqual([]);
      // the state stays: the next pass of the run loop resolves it (reported failed, never re-run)
      expect(await readJobState(profile())).toMatchObject({ jobId: r.lease!.jobId });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("agent restart", { timeout: 90_000 }, () => {
  it("A: interrupted before a validated result → reported failed, never re-run (Retry is a new attempt)", async () => {
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const client = await pairedClient();
    await beat(client);
    const lease = (await client.lease()).lease!;
    // what a crash mid-training leaves: the persisted lease at stage "reconstructing", no result
    await writeJobState(profile(), {
      schema: "prism.local-agent-job.v1",
      deviceId: client.device.deviceId,
      projectId: w.A,
      jobId: lease.jobId,
      attempt: lease.attempt,
      leaseId: lease.leaseId,
      leaseExpiresAt: lease.leaseExpiresAt,
      sources: lease.sources.map((s) => ({
        ordinal: s.ordinal,
        mime: s.mime,
        byteSize: s.byteSize,
        sha256: s.sha256,
      })),
      runId: "ra-crashed-a1-00000000",
      stage: "reconstructing",
      result: null,
      updatedAt: new Date().toISOString(),
    });
    let engineRuns = 0;
    const out = await run(client, { engine: async (...a) => (engineRuns++, runLocalReconstruction(...a)) });
    expect(out).toMatchObject({ kind: "jobs_done", outcomes: [{ kind: "failed", code: "interrupted" }] });
    expect(engineRuns).toBe(0);
    const failed = (await w.job(job.id))!;
    expect(failed).toMatchObject({ status: "failed", errorCode: "provider_failed" });
    expect(failed.errorMessage).toMatch(/stopped before the run completed/);
    expect(await readJobState(profile())).toBeNull();
  });

  it("B: a validated result retained before the upload → uploaded after restart, no second COLMAP/Brush run", async () => {
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const client = await pairedClient();
    await beat(client);
    const r = await client.lease();
    let engineRuns = 0;
    const engine: typeof runLocalReconstruction = async (...a) => (
      engineRuns++,
      runLocalReconstruction(...a)
    );
    // the process "dies" at the upload: the bytes never leave
    const crashing = new Proxy(client, {
      get: (t, k) =>
        k === "uploadResult"
          ? async () => {
              throw new Error("simulated crash");
            }
          : Reflect.get(t, k, t),
    });
    const tc = jobToolchainFromProbe(await probe());
    await expect(
      executeLease(
        {
          client: crashing,
          profileDir: profile(),
          workRoot: workRoot(),
          toolchain: tc,
          engine,
          keepaliveMs: 250,
        },
        r.lease!,
        r.serverTime,
      ),
    ).rejects.toThrow("simulated crash");
    expect(engineRuns).toBe(1);
    const left = (await readJobState(profile()))!;
    expect(left.stage).toBe("uploading");
    expect(left.result?.gaussianCount).toBeGreaterThan(0);
    expect((await w.job(job.id))!.status).toBe("running");

    // restart: the retained, validated SPZ is uploaded; nothing is re-run
    const out = await resumeJob(
      { client, profileDir: profile(), workRoot: workRoot(), toolchain: tc, engine, keepaliveMs: 250 },
      left,
    );
    expect(out).toMatchObject({ kind: "succeeded", jobId: job.id });
    expect(engineRuns).toBe(1);
    expect((await w.job(job.id))!.status).toBe("succeeded");
    expect(await runDirs()).toEqual([]);
    await expect(stat(path.join(profile(), JOB_STATE_FILE))).rejects.toThrow();
  });

  it("B': a retained result that changed on disk is never uploaded", async () => {
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const client = await pairedClient();
    await beat(client);
    const r = await client.lease();
    const crashing = new Proxy(client, {
      get: (t, k) =>
        k === "uploadResult" ? async () => Promise.reject(new Error("crash")) : Reflect.get(t, k, t),
    });
    const tc = jobToolchainFromProbe(await probe());
    await executeLease(
      { client: crashing, profileDir: profile(), workRoot: workRoot(), toolchain: tc },
      r.lease!,
      r.serverTime,
    ).catch(() => undefined);
    const left = (await readJobState(profile()))!;
    const spz = path.join(workRoot(), left.runId, "output", "splat.spz");
    const bytes = await readFile(spz);
    bytes[bytes.length - 3] ^= 0xff;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(spz, bytes);
    const out = await resumeJob({ client, profileDir: profile(), workRoot: workRoot(), toolchain: tc }, left);
    expect(out).toMatchObject({ kind: "failed", code: "interrupted" });
    expect(srv.log.some((l) => l.startsWith("PUT "))).toBe(false);
    expect(await w.job(job.id)).toMatchObject({ status: "failed", errorCode: "provider_failed" });
  });
});
