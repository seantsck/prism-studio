import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FREE_COST_ESTIMATE,
  isTerminal,
  orderedSources,
  type ReconstructionJobRecord,
} from "@/domain/reconstruction/job";
import { inspectSplat } from "@/lib/splat/inspect";
import { cancelJob, refreshJob, retryJob } from "@/server/reconstruction-jobs";
import { fakeBrush, fakeColmap } from "../../local/__tests__/fake-tools";
import { APPROVED_COLMAP, sha256OfFile } from "../../local/colmap-provenance";
import { runLocalReconstruction } from "../../local/engine";
import { SPZ_ENCODER } from "../../local/spz";
import { newRunId, operationIdFor, STOPPED_MESSAGE, toEngineRequest } from "../adapter";
import { HEARTBEAT_FILE, LOCK_FILE, readHeartbeat, workRootId, writeHeartbeat } from "../runtime";
import { LocalReconstructionWorker } from "../worker";
import { localWorld, type LocalWorld } from "./harness";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
});
async function world(o: Parameters<typeof localWorld>[0] = {}) {
  const w = await localWorld(o);
  cleanups.push(w.cleanup);
  return w;
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const runDirs = async (w: LocalWorld) =>
  [
    ...(await readdir(w.workRoot)),
    ...(await readdir(path.join(w.workRoot, ".staging")).catch(() => [] as string[])),
  ].filter((n) => n.startsWith("lr-"));
const terminal = (w: LocalWorld, id: string, ms = 90_000) =>
  w.waitFor(
    async () => {
      const j = await w.job(id);
      return isTerminal(j.status) ? j : null;
    },
    ms,
    `job ${id} to finish`,
  );
const atStage = (w: LocalWorld, id: string, stage: string) =>
  w.waitFor(
    async () => {
      const j = await w.job(id);
      return j.status === "running" && j.providerOperation?.stage === stage ? j : null;
    },
    60_000,
    `stage ${stage}`,
  );

/** The tools a claim records on the job, for the fake machine (what a real verified build would record). */
async function recordedTools(w: LocalWorld) {
  return {
    colmap: {
      version: APPROVED_COLMAP.version,
      sourceCommit: APPROVED_COLMAP.commit,
      binarySha256: await sha256OfFile(w.machine.colmapExe),
    },
    brush: { version: "0.3.0" },
    spzEncoder: SPZ_ENCODER,
  };
}

/** The job state a worker that CRASHED mid-run leaves behind: claimed by this work root, running, its run id. */
async function crashedRun(w: LocalWorld, job: ReconstructionJobRecord) {
  const runId = newRunId(job);
  const tools = await recordedTools(w);
  const op = {
    runner: "local_worker",
    workerId: "local-deadbeef-00000000",
    runId,
    workRoot: workRootId(w.workRoot),
    quality: "standard",
    tools,
    stage: "splat_training",
    description: "Training the Gaussian splat (iteration 200 of 30000)",
  };
  let j = await w.repo.previs.updateReconstructionJob(
    job.id,
    job.revision,
    { status: "submitting", providerOperationId: operationIdFor(runId), providerOperation: op },
    new Date().toISOString(),
  );
  j = await w.repo.previs.updateReconstructionJob(
    j.id,
    j.revision,
    { status: "running", progress: 0.4, providerOperation: op },
    new Date().toISOString(),
  );
  // the dead process's lock (a pid that does not exist)
  await writeFile(
    path.join(w.workRoot, LOCK_FILE),
    JSON.stringify({
      schema: "prism.local-reconstruction-worker-lock.v1",
      workerId: op.workerId,
      pid: 2_000_000_000,
      startedAt: "2026-10-19T00:00:00Z",
    }),
  );
  return { job: j, runId, tools };
}

/**
 * Queued jobs, created while a worker is online (Local Capture is only offered then). Each is a DIFFERENT request
 * (another photo order: the same request twice is the same attempt, refused by the job identity).
 */
let requests = 0;
async function queued(w: LocalWorld, n = 1) {
  const gate = w.worker();
  await gate.start();
  const out = [];
  for (let i = 0; i < n; i++) {
    const ids = w.images.map((a) => a.id);
    const k = requests++ % ids.length;
    out.push(await w.generate([...ids.slice(k), ...ids.slice(0, k)]));
  }
  await gate.stop();
  return out;
}

describe("availability: toolchain ready AND worker online (no paid fallback)", () => {
  it("toolchain ready but the worker is offline → unavailable, Generate refused, no job; a queued job waits for the worker", async () => {
    const w = await world();
    // never started: nothing to offer, nothing created
    await expect(w.generate()).rejects.toMatchObject({ code: "not_configured" });

    const a = w.worker();
    await a.start();
    expect(w.web.providers.get("local_capture")!.status()).toMatchObject({
      capability: "available",
      local: { worker: "online", toolchain: "ready" },
    });
    const job = await w.generate();
    expect(job).toMatchObject({ status: "queued", provider: "local_capture" });
    expect(job.costEstimate).toMatchObject({ costClass: "free" });
    const online = readHeartbeat(w.workRoot, Date.now());
    if (online.state !== "online") throw new Error("expected an online worker");
    await a.stop();
    expect(readHeartbeat(w.workRoot, Date.now()).state).toBe("offline");

    // the verified toolchain is still installed, but no worker runs: its last heartbeat (READY toolchain) is stale
    await writeHeartbeat(w.workRoot, {
      ...online.heartbeat,
      lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const status = w.web.providers.get("local_capture")!.status();
    expect(status).toMatchObject({
      capability: "unavailable",
      local: { worker: "offline", toolchain: "ready" },
    });
    await expect(w.generate()).rejects.toMatchObject({ code: "capability_unavailable" });
    expect((await w.jobs()).length).toBe(1);

    // the web never runs, fails or polls the queued local job while the worker is away
    for (let i = 0; i < 3; i++) await refreshJob(w.web, job.id);
    await new Promise((r) => setTimeout(r, 500));
    expect(await w.job(job.id)).toMatchObject({ status: "queued", revision: job.revision });

    // the worker returns: the job runs
    const b = w.worker();
    expect(await b.runUntilIdle()).toBe(1);
    expect((await w.job(job.id)).status).toBe("succeeded");
    expect(w.worldLabsFetch).not.toHaveBeenCalled();
  }, 120_000);
});

describe("browser close (merge-critical): the worker runs the job with no client at all", () => {
  it("create → worker claims → NO client polling → COLMAP → Brush → validated SPZ → private Asset → immutable reconstruction → succeeded when the client returns", async () => {
    const w = await world();
    const ww = w.worker();
    await ww.start();
    const created = await w.generate();
    expect(created.status).toBe("queued"); // the request returned; the browser now closes

    const updates = vi.spyOn(w.repo.previs, "updateReconstructionJob");
    const running = ww.run(); // the separate worker process
    const done = await terminal(w, created.id);
    await ww.stop();
    await running;

    expect(done).toMatchObject({
      status: "succeeded",
      progress: 1,
      errorCode: null,
      provider: "local_capture",
    });
    expect(done.providerOperationId).toMatch(/^local:lr-[0-9a-f]{12}-a1-[0-9a-f]{8}$/);
    // the client comes back later: reading changes nothing and shows the result
    expect(await refreshJob(w.web, created.id)).toEqual(done);

    // the immutable generated reconstruction, with unknown (never inferred) scale and safe local provenance
    const rec = (await w.repo.previs.getReconstruction(done.resultReconstructionId!))!;
    expect(rec).toMatchObject({
      method: "generated",
      resultKind: "gaussian_splat",
      resultFormat: "spz",
      calibration: { units: "unknown", metresPerSourceUnit: null, scaleMethod: "unknown" },
      generation: {
        jobId: done.id,
        provider: "local_capture",
        operationId: done.providerOperationId,
        metadata: {
          engine: "prism-local-reconstruction",
          runner: "local_worker",
          quality: "standard",
          colmap: { version: "4.2.1", sourceCommit: APPROVED_COLMAP.commit },
          brush: { version: "0.3.0" },
          inputImages: 3,
          registeredImages: 3,
          registrationRatio: 1,
          shDegree: 3,
          spzVersion: 3,
          lossless: false,
          format: "spz",
          gaussianCount: 64,
        },
      },
    });
    expect(rec.sources.map((s) => s.assetId)).toEqual(w.images.map((a) => a.id)); // the user's order
    // the private Asset holds exactly the validated bytes
    const assets = await w.resultAssets();
    expect(assets).toHaveLength(1);
    const bytes = w.objects.get(assets[0]!.objectPath!)!;
    expect(sha(bytes)).toBe(rec.resultChecksum);
    expect(inspectSplat(bytes, "x.spz")).toMatchObject({ ok: true, gaussianCount: 64 });
    expect(assets[0]).toMatchObject({
      purpose: "spatial_reconstruction",
      mime: rec ? expect.any(String) : "",
    });
    // nothing persisted names a path, the machine or a credential
    const persisted = JSON.stringify([
      done.providerOperation,
      done.providerResult,
      rec.generation,
      assets[0],
    ]);
    expect(persisted).not.toContain(w.tmp.dir);
    expect(persisted).not.toMatch(/[A-Za-z]:\\\\|\/home\/|\/Users\/|postgres|https?:|secret/i);

    // events: stage changes only (never every Brush iteration), in order
    const events = await w.repo.previs.listReconstructionJobEvents(created.id);
    expect(events.map((e) => e.event)).toEqual([
      "created",
      "queued",
      "submitted",
      "provider_running",
      "progress",
      "progress",
      "progress",
      "progress",
      "progress",
      "provider_succeeded",
      "ingesting",
      "succeeded",
    ]);
    expect(events.filter((e) => e.event === "progress").map((e) => e.detail.stage)).toEqual([
      "camera_reconstruction",
      "splat_training",
      "validating_ply",
      "converting_spz",
      "validating_spz",
    ]);
    // progress writes are throttled: a handful of row updates for the whole run
    expect(updates.mock.calls.length).toBeLessThan(20);

    // cleanup after success: Prism's private Asset is the durable copy; no run, staging, PLY or COLMAP data is kept
    expect(await runDirs(w)).toEqual([]);
    expect(w.worldLabsFetch).not.toHaveBeenCalled();
  }, 120_000);
});

describe("claiming", () => {
  it("two workers race for one queued job: exactly one claims it; one Asset, one reconstruction", async () => {
    const w = await world();
    const [job] = await queued(w);
    const a = w.worker();
    const b = w.worker({ root: path.join(w.tmp.dir, "work-2") });
    await Promise.all([a.start(), b.start()]);
    const ran = await Promise.all([a.tick(), b.tick()]);
    expect(ran.filter(Boolean)).toHaveLength(1);
    expect((await w.job(job!.id)).status).toBe("succeeded");
    expect(await w.resultAssets()).toHaveLength(1);
    expect(w.logs.some((l) => l.claim === "lost") || ran.includes(false)).toBe(true);
  }, 120_000);

  it("never claims another provider's job (World Labs, mock, unknown), even if discovery returned it", async () => {
    const w = await world();
    const others: ReconstructionJobRecord[] = [];
    for (const provider of ["worldlabs_marble", "mock_reconstruction", "future_provider"])
      others.push(
        await w.repo.previs.createReconstructionJob({
          id: randomUUID(),
          projectId: w.projectId,
          locationId: w.locationId,
          attempt: 1,
          previousJobId: null,
          provider,
          capability: "x",
          model: null,
          resultKind: "gaussian_splat",
          sources: orderedSources(
            w.images.map((a) => ({
              assetId: a.id,
              checksum: a.checksum!,
              mime: a.mime!,
              width: 640,
              height: 480,
              byteSize: a.byteSize!,
            })),
          ),
          options: { displayName: null, provider: {} },
          costEstimate: FREE_COST_ESTIMATE("x"),
          status: "queued",
          userId: w.owner,
          now: new Date().toISOString(),
        }),
      );
    // a (hypothetically) broken discovery that returns everything queued
    const leaky = {
      ...w.store,
      listQueued: async () =>
        others.map((j) => ({ id: j.id, projectId: j.projectId, ownerId: w.owner, status: j.status })),
    };
    const ww = new LocalReconstructionWorker({
      store: leaky,
      workRoot: w.workRoot,
      probe: w.probe(),
      timing: { pollMs: 50 },
      log: () => undefined,
    });
    cleanups.push(() => ww.stop());
    await ww.start();
    expect(await ww.tick()).toBe(false);
    for (const j of others) expect(await w.job(j.id)).toMatchObject({ status: "queued", revision: 1 });
  }, 60_000);

  it("ONE reconstruction at a time: a second queued job waits for the first", async () => {
    const w = await world();
    const jobs = await queued(w, 2);
    const ww = w.worker();
    await ww.start();
    const loop = ww.run();
    let maxActive = 0;
    await w.waitFor(
      async () => {
        const all = await Promise.all(jobs.map((j) => w.job(j.id)));
        maxActive = Math.max(
          maxActive,
          all.filter((j) => ["submitting", "running", "ingesting"].includes(j.status)).length,
        );
        return all.every((j) => j.status === "succeeded");
      },
      120_000,
      "both jobs",
    );
    await ww.stop();
    await loop;
    expect(maxActive).toBe(1);
    expect(await w.resultAssets()).toHaveLength(2);
  }, 180_000);
});

describe("source security", () => {
  it("re-verifies every source from private storage against the frozen checksums before any tool runs", async () => {
    const w = await world();
    const second = w.images[1]!;
    const original = w.objects.get(second.objectPath!)!;
    const engine = vi.fn(runLocalReconstruction);
    const ww = w.worker({ engine });
    const expectRefused = async (id: string) =>
      expect(await w.job(id)).toMatchObject({
        status: "failed",
        errorCode: "invalid_sources",
        errorMessage: expect.stringMatching(/changed or is no longer readable/),
      });
    // 1. the stored BYTES of one image changed after the job froze its checksum
    const [tampered] = await queued(w);
    w.objects.set(second.objectPath!, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 9, 9, 9]));
    await ww.runUntilIdle();
    await expectRefused(tampered!.id);
    // 2. the Asset ROW now describes other content
    w.objects.set(second.objectPath!, original);
    await ww.stop();
    const [changedRow] = await queued(w);
    await w.repo.upsert(w.projectId, "assets", { ...second, checksum: "f".repeat(64) });
    await w.worker({ engine }).runUntilIdle();
    await expectRefused(changedRow!.id);
    expect(engine).not.toHaveBeenCalled();
    expect(await runDirs(w)).toEqual([]);
    expect(await w.resultAssets()).toHaveLength(0);
  }, 120_000);
});

describe("cancellation", () => {
  it("cancel while Brush trains: the worker aborts promptly, no Asset, no reconstruction, workspace removed, job cancelled", async () => {
    const w = await world();
    const [job] = await queued(w);
    const ww = w.worker({ brush: "slow", timing: { staleWorkspaceMs: 0 } });
    await ww.start();
    const loop = ww.run();
    const running = await atStage(w, job!.id, "splat_training");
    expect(running.progress).toBeGreaterThan(0);
    // the sweeper never removes the ACTIVE workspace, even when everything counts as "old"; the staged copies are
    // already gone (the engine verified its own)
    await ww.sweep(true);
    expect(await runDirs(w)).toEqual([running.providerOperation!.runId]);
    const t0 = Date.now();
    const cancelled = await cancelJob(w.web, job!.id);
    expect(cancelled).toMatchObject({ status: "cancelled", errorMessage: null });
    await w.waitFor(async () => !ww.busy, 30_000, "the worker to stop the run");
    expect(Date.now() - t0).toBeLessThan(10_000);
    await ww.stop();
    await loop;

    expect(await w.job(job!.id)).toMatchObject({ status: "cancelled", resultReconstructionId: null });
    expect(await w.resultAssets()).toHaveLength(0);
    expect(await runDirs(w)).toEqual([]);
    const events = (await w.repo.previs.listReconstructionJobEvents(job!.id)).map((e) => e.event);
    expect(events).toContain("cancel_requested");
    expect(events).not.toContain("failed");
    expect(w.logs.some((l) => l.outcome === "cancelled")).toBe(true);
    expect(w.worldLabsFetch).not.toHaveBeenCalled();
  }, 120_000);

  it("cancel at the very moment the engine finishes: the cancel wins, the result is discarded, nothing is imported", async () => {
    const w = await world();
    const [job] = await queued(w);
    const ww = w.worker({ hooks: { beforeIngestClaim: async (j) => void (await cancelJob(w.web, j.id)) } });
    await ww.runUntilIdle();
    expect(await w.job(job!.id)).toMatchObject({ status: "cancelled", resultReconstructionId: null });
    expect(await w.resultAssets()).toHaveLength(0);
    expect(await runDirs(w)).toEqual([]);
    expect(w.logs.some((l) => l.outcome === "discarded")).toBe(true);
  }, 120_000);

  it("once the import won, a later cancel cannot change the succeeded history", async () => {
    const w = await world();
    const [job] = await queued(w);
    await w.worker().runUntilIdle();
    const done = await w.job(job!.id);
    expect(done.status).toBe("succeeded");
    expect(await cancelJob(w.web, job!.id)).toEqual(done);
    expect(await w.resultAssets()).toHaveLength(1);
  }, 120_000);
});

describe("worker shutdown and restart", () => {
  it("SIGINT/SIGTERM while running: the run is aborted, recorded truthfully, the workspace removed, lock and heartbeat released", async () => {
    const w = await world();
    const [job] = await queued(w);
    const ww = w.worker({ brush: "slow" });
    await ww.start();
    const loop = ww.run();
    await atStage(w, job!.id, "splat_training");
    await ww.stop();
    await loop;
    expect(await w.job(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "provider_failed",
      errorMessage: STOPPED_MESSAGE,
    });
    expect(await w.resultAssets()).toHaveLength(0);
    expect(await runDirs(w)).toEqual([]);
    const left = await readdir(w.workRoot);
    expect(left).not.toContain(LOCK_FILE);
    expect(left).not.toContain(HEARTBEAT_FILE);
  }, 120_000);

  it("crash BEFORE a valid result: restart fails the stale attempt (no automatic re-run); Retry is a new attempt that runs", async () => {
    const w = await world();
    const [job] = await queued(w);
    const { runId } = await crashedRun(w, job!);
    await mkdir(path.join(w.workRoot, runId, "colmap"), { recursive: true });
    await writeFile(path.join(w.workRoot, runId, "colmap", "database.db"), "partial");

    const engine = vi.fn(runLocalReconstruction);
    const ww = w.worker({ engine });
    await ww.start(); // takes over the dead worker's lock and resolves its run
    expect(w.logs.some((l) => l.lock === "recovered_stale")).toBe(true);
    expect(await w.job(job!.id)).toMatchObject({
      status: "failed",
      errorCode: "provider_failed",
      errorMessage: STOPPED_MESSAGE,
    });
    expect(engine).not.toHaveBeenCalled(); // never re-trained invisibly
    expect(await runDirs(w)).toEqual([]);

    // Retry is the user's explicit choice: a NEW attempt, still local, still free
    const retry = await retryJob(w.web, job!.id);
    expect(retry).toMatchObject({
      status: "queued",
      attempt: 2,
      previousJobId: job!.id,
      provider: "local_capture",
    });
    await ww.runUntilIdle();
    expect(await w.job(retry.id)).toMatchObject({ status: "succeeded" });
    expect(engine).toHaveBeenCalledTimes(1);
    expect(w.worldLabsFetch).not.toHaveBeenCalled();
  }, 180_000);

  it("crash AFTER a validated SPZ but before import: restart imports ONLY (no second training), exactly once", async () => {
    const w = await world();
    const [job] = await queued(w);
    const { job: running, runId, tools } = await crashedRun(w, job!);
    // the crashed worker's engine had finished: a real retained, validated run for exactly this job's sources
    const staged = path.join(w.tmp.dir, "staged");
    await mkdir(staged, { recursive: true });
    const files = [];
    for (const s of running.sources) {
      const a = w.images.find((x) => x.id === s.assetId)!;
      const p = path.join(staged, `${s.ordinal}.${a.mime === "image/png" ? "png" : "jpg"}`);
      await writeFile(p, w.objects.get(a.objectPath!)!);
      files.push({ ordinal: s.ordinal, path: p, checksum: s.checksum!, mime: s.mime! });
    }
    await runLocalReconstruction(toEngineRequest(runId, files), {
      toolchain: {
        colmap: fakeColmap(),
        brush: fakeBrush(),
        versions: { colmap: tools.colmap.version, brush: tools.brush.version },
      },
      workRoot: w.workRoot,
    });

    const engine = vi.fn(runLocalReconstruction);
    const ww = w.worker({ engine });
    await ww.start();
    expect(w.logs.some((l) => l.recovery === "resume_import")).toBe(true);
    const done = await w.job(job!.id);
    expect(done).toMatchObject({ status: "succeeded", providerOperationId: operationIdFor(runId) });
    expect(engine).not.toHaveBeenCalled();
    expect(await w.resultAssets()).toHaveLength(1);
    expect(await runDirs(w)).toEqual([]);
    // a second restart finds nothing to do
    await ww.stop();
    const again = w.worker({ engine });
    await again.start();
    expect(await w.resultAssets()).toHaveLength(1);
  }, 180_000);

  it("a retained result that does not match (tampered output) is never imported", async () => {
    const w = await world();
    const [job] = await queued(w);
    const { job: running, runId, tools } = await crashedRun(w, job!);
    const files = [];
    await mkdir(path.join(w.tmp.dir, "staged"), { recursive: true });
    for (const s of running.sources) {
      const a = w.images.find((x) => x.id === s.assetId)!;
      const p = path.join(w.tmp.dir, "staged", `${s.ordinal}.bin`);
      await writeFile(p, w.objects.get(a.objectPath!)!);
      files.push({ ordinal: s.ordinal, path: p, checksum: s.checksum!, mime: s.mime! });
    }
    await runLocalReconstruction(toEngineRequest(runId, files), {
      toolchain: {
        colmap: fakeColmap(),
        brush: fakeBrush(),
        versions: { colmap: tools.colmap.version, brush: tools.brush.version },
      },
      workRoot: w.workRoot,
    });
    await appendFile(path.join(w.workRoot, runId, "output", "splat.spz"), "x");
    // and an arbitrary SPZ lying in the work root is never associated with anything
    await mkdir(path.join(w.workRoot, "lr-foreign-a1-00000000", "output"), { recursive: true });
    await writeFile(path.join(w.workRoot, "lr-foreign-a1-00000000", "output", "splat.spz"), "spz?");

    await w.worker().start();
    expect(await w.job(job!.id)).toMatchObject({ status: "failed", errorMessage: STOPPED_MESSAGE });
    expect(await w.resultAssets()).toHaveLength(0);
    expect(w.logs.some((l) => l.recovery === "fail" && l.reason === "output size")).toBe(true);
  }, 180_000);

  it("leaves jobs claimed from ANOTHER work root to their own worker", async () => {
    const w = await world();
    const [job] = await queued(w);
    const { job: running } = await crashedRun(w, job!);
    const other = w.worker({ root: path.join(w.tmp.dir, "elsewhere") });
    await other.start();
    expect(await w.job(job!.id)).toMatchObject({ status: "running", revision: running.revision });
  }, 60_000);
});

describe("failures and cleanup", () => {
  it("no usable GPU (Brush finds no adapter): failed truthfully, toolchain reported unavailable, later jobs wait", async () => {
    const w = await world();
    const [first, second] = await queued(w, 2);
    const ww = w.worker({ brush: "no_adapter" });
    await ww.runUntilIdle();
    const failed = await w.job(first!.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "capability_unavailable" });
    expect(failed.errorMessage).toMatch(/GPU|adapter|Vulkan/i);
    expect(failed.errorMessage).not.toContain(w.tmp.dir);
    expect(failed.providerOperation).toMatchObject({ localError: { localCode: "gpu_unavailable" } });
    // the worker stops claiming: the second job stays queued, and the server no longer offers Local Capture
    expect((await w.job(second!.id)).status).toBe("queued");
    await w.waitFor(
      async () =>
        readHeartbeat(w.workRoot, Date.now()).state === "online" &&
        w.web.providers.get("local_capture")!.status().local?.toolchain === "gpu_unavailable",
      10_000,
      "the heartbeat to report the GPU",
    );
    expect(w.web.providers.get("local_capture")!.status().capability).toBe("not_installed");
    // bounded diagnostics only: logs + failure manifest, no inputs, COLMAP data or partial output
    const [dir] = await runDirs(w);
    expect((await readdir(path.join(w.workRoot, dir!))).sort()).toEqual(["logs", "manifest.json"]);
    expect(w.worldLabsFetch).not.toHaveBeenCalled();
  }, 120_000);

  it("a failing reconstruction fails; World Labs is never called and no other job is created", async () => {
    const w = await world();
    const [job] = await queued(w);
    await w.worker({ colmap: "few" }).runUntilIdle();
    expect(await w.job(job!.id)).toMatchObject({ status: "failed", errorCode: "provider_failed" });
    expect((await w.job(job!.id)).errorMessage).toMatch(/could be placed/);
    expect(await w.jobs()).toHaveLength(1);
    expect(w.worldLabsFetch).not.toHaveBeenCalled();
  }, 120_000);

  it("the sweeper removes only old worker run directories, never anything else", async () => {
    const w = await world();
    const ww = w.worker({ timing: { staleWorkspaceMs: 60_000 } });
    await ww.start();
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const d of [
      "lr-aaaaaaaaaaaa-a1-00000000",
      ".staging/lr-bbbbbbbbbbbb-a1-00000000",
      "keep-me",
      "lr-fresh",
    ]) {
      await mkdir(path.join(w.workRoot, d), { recursive: true });
      if (d !== "lr-fresh") await utimes(path.join(w.workRoot, d), old, old);
    }
    expect(await ww.sweep(true)).toBe(2);
    const left = await readdir(w.workRoot);
    expect(left).toContain("keep-me");
    expect(left).toContain("lr-fresh");
    expect(left).not.toContain("lr-aaaaaaaaaaaa-a1-00000000");
    await expect(stat(path.join(w.workRoot, ".staging", "lr-bbbbbbbbbbbb-a1-00000000"))).rejects.toThrow();
  }, 60_000);
});
