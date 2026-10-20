import { describe, expect, it } from "vitest";
import {
  INGEST_GRACE_MS,
  jobPaths,
  LEASE_TTL_MS,
  PATHS,
  PROTOCOL,
  type AgentFailureCode,
} from "@/lib/local-agent/protocol";
import { cancelJob, refreshJob, retryJob } from "@/server/reconstruction-jobs";
import { readWorldLabsConfig, WorldLabsProvider } from "@/lib/reconstruction/worldlabs";
import { capabilities, type TestAgent } from "../../__tests__/helpers";
import { AgentProtocolError, status } from "../../service";
import { revokeAgent } from "../../service";
import {
  agentFailureMessage,
  failJob,
  failJobsOfAgent,
  leaseJob,
  progress,
  REMOTE_FAILURE_MAP,
  resultUploadGate,
  serveSource,
  uploadResult,
} from "../service";
import { remoteWorld, spzResult } from "./world";

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no error";
  } catch (e) {
    if (e instanceof AgentProtocolError) return e.code;
    throw e;
  }
}

type World = Awaited<ReturnType<typeof remoteWorld>>;
const leaseReq = (a: TestAgent) => a.request("POST", PATHS.lease, { protocol: PROTOCOL });
const srcReq = (a: TestAgent, jobId: string, leaseId: string, ord: number) =>
  a.request("GET", jobPaths(jobId, leaseId).source(ord), null);
const progReq = (a: TestAgent, jobId: string, leaseId: string, body: Record<string, unknown>, o = {}) =>
  a.request("POST", jobPaths(jobId, leaseId).progress, { protocol: PROTOCOL, ...body }, o);
const failReq = (a: TestAgent, jobId: string, leaseId: string, body: Record<string, unknown>) =>
  a.request("POST", jobPaths(jobId, leaseId).fail, { protocol: PROTOCOL, ...body });
const putReq = (a: TestAgent, jobId: string, leaseId: string, bytes: Uint8Array, o = {}) =>
  a.request("PUT", jobPaths(jobId, leaseId).result, null, { rawBody: bytes, ...o });

/** One project-A job leased by a fresh agent. */
async function leased(w: World, images = 3) {
  const imgs = await w.addImages(w.A, images);
  const job = await w.remoteJob(w.A, imgs);
  const a = await w.agent(w.A);
  const r = await leaseJob(w.deps, leaseReq(a));
  return { a, job, imgs, lease: r.lease!, serverTime: r.serverTime };
}

/** Declares the result (final progress) and returns the bytes to upload. */
async function declare(w: World, a: TestAgent, jobId: string, leaseId: string) {
  const { bytes, result } = spzResult();
  await progress(
    w.deps,
    progReq(a, jobId, leaseId, { stage: "uploading", progress: 1, message: "Uploading", result }),
    jobId,
    leaseId,
  );
  return bytes;
}

// ───────────────────────── lease ─────────────────────────

describe("lease", () => {
  it("claims the project's oldest queued job: queued → running, opaque lease, exact frozen sources, no Storage detail", async () => {
    const w = await remoteWorld();
    const imgs = await w.addImages(w.A, 4);
    const first = await w.remoteJob(w.A, imgs.slice(0, 3));
    w.advance(1000);
    await w.remoteJob(w.A, imgs.slice(1, 4));
    const a = await w.agent(w.A);
    const r = await leaseJob(w.deps, leaseReq(a));
    expect(r.idle).toBeNull();
    const lease = r.lease!;
    expect(lease).toMatchObject({
      jobId: first.id,
      attempt: 1,
      resumed: false,
      quality: "standard",
      leaseTtlMs: LEASE_TTL_MS,
    });
    expect(lease.leaseId).toMatch(/^[0-9a-f]{32}$/);
    expect(lease.sources.map((s) => [s.ordinal, s.assetId, s.mime, s.byteSize, s.sha256])).toEqual(
      first.sources.map((s) => [s.ordinal, s.assetId, s.mime, s.byteSize, s.checksum]),
    );
    expect(lease.sources[1]!.path).toBe(
      `/api/local-agent/v1/jobs/${first.id}/leases/${lease.leaseId}/sources/1`,
    );
    // nothing about where the bytes live: no bucket, object path, URL, file name or credential
    const text = JSON.stringify(r);
    for (const leak of ["objectPath", "bucket", "http", "IMG_", "ref-1", "secret", "token"])
      expect(text).not.toContain(leak);
    const job = (await w.job(first.id))!;
    expect(job.status).toBe("running");
    expect(job.providerOperationId).toBe(`agent:${lease.leaseId}`);
    expect(job.providerOperation).toMatchObject({
      runner: "remote_agent",
      agentId: a.deviceId,
      leaseId: lease.leaseId,
      stage: "leased",
    });
    expect(job.providerOperation!.tools).toMatchObject({
      colmap: { version: "4.2.1" },
      brush: { version: "0.3.0" },
    });
    expect((await w.events(first.id)).map((e) => e.event)).toEqual([
      "created",
      "queued",
      "submitted",
      "provider_running",
    ]);
  });

  it("idle answers: no job, toolchain not ready, an M2D.3C1 agent, remote jobs unavailable", async () => {
    const w = await remoteWorld();
    const a = await w.agent(w.A);
    expect(await leaseJob(w.deps, leaseReq(a))).toMatchObject({ lease: null, idle: "no_job" });
    await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const notReady = await w.agent(w.A, capabilities({ state: "gpu_unavailable" }));
    expect(await leaseJob(w.deps, leaseReq(notReady))).toMatchObject({
      lease: null,
      idle: "toolchain_not_ready",
    });
    // an M2D.3C1 agent (no execution claim) is never given a job
    const c1 = await w.agent(w.A);
    const { heartbeat } = await import("../../service");
    await heartbeat(w.deps.agent, c1.heartbeat({}, capabilities()));
    expect(await leaseJob(w.deps, leaseReq(c1))).toMatchObject({ lease: null, idle: "toolchain_not_ready" });
    expect(await leaseJob({ ...w.deps, available: false }, leaseReq(a))).toMatchObject({
      lease: null,
      idle: "remote_jobs_unavailable",
    });
    // and none of these touched the job
    expect((await w.repo.previs.listReconstructionJobs(w.locA))[0]!.status).toBe("queued");
  });

  it("the same agent asking again gets its SAME live lease (a lost response never starts a second job)", async () => {
    const w = await remoteWorld();
    const imgs = await w.addImages(w.A, 4);
    const j1 = await w.remoteJob(w.A, imgs.slice(0, 3));
    w.advance(1000);
    await w.remoteJob(w.A, imgs.slice(1, 4));
    const a = await w.agent(w.A);
    const first = (await leaseJob(w.deps, leaseReq(a))).lease!;
    w.advance(30_000);
    const again = (await leaseJob(w.deps, leaseReq(a))).lease!;
    expect(again).toMatchObject({ jobId: j1.id, leaseId: first.leaseId, resumed: true });
    expect(Date.parse(again.leaseExpiresAt)).toBeGreaterThan(Date.parse(first.leaseExpiresAt));
    const queued = (await w.repo.previs.listReconstructionJobs(w.locA)).filter((j) => j.status === "queued");
    expect(queued).toHaveLength(1);
  });

  it("two agents racing for one job: exactly one wins; with two jobs each gets a different one", async () => {
    const w = await remoteWorld();
    const imgs = await w.addImages(w.A, 4);
    const job = await w.remoteJob(w.A, imgs.slice(0, 3));
    const [a, b] = [await w.agent(w.A), await w.agent(w.A)];
    const rs = await Promise.all([leaseJob(w.deps, leaseReq(a)), leaseJob(w.deps, leaseReq(b))]);
    expect(rs.filter((r) => r.lease).map((r) => r.lease!.jobId)).toEqual([job.id]);
    expect(rs.filter((r) => !r.lease).map((r) => r.idle)).toEqual(["no_job"]);
    const second = await w.remoteJob(w.A, imgs.slice(1, 4));
    const c = await w.agent(w.A);
    const loser = rs[0]!.lease ? b : a;
    const more = await Promise.all([leaseJob(w.deps, leaseReq(loser)), leaseJob(w.deps, leaseReq(c))]);
    expect(more.filter((r) => r.lease).map((r) => r.lease!.jobId)).toEqual([second.id]);
    // never the same attempt twice
    const holders = (await w.repo.previs.listReconstructionJobs(w.locA)).map(
      (j) => j.providerOperation?.agentId,
    );
    expect(new Set(holders.filter(Boolean)).size).toBe(2);
  });

  it("an agent never leases another project's job, nor a same-host local_capture job", async () => {
    const w = await remoteWorld();
    await w.remoteJob(w.B, await w.addImages(w.B, 3));
    // a same-host job in the agent's own project (written directly: the same-host worker owns it)
    const imgs = await w.addImages(w.A, 3);
    const deps = await w.jobDeps(w.A);
    await deps.repo.createReconstructionJob({
      id: crypto.randomUUID(),
      projectId: w.A,
      locationId: w.locA,
      attempt: 1,
      previousJobId: null,
      provider: "local_capture",
      capability: "local_capture",
      model: null,
      resultKind: "gaussian_splat",
      sources: imgs.map((i, n) => ({
        ordinal: n,
        kind: "image" as const,
        assetId: i.id,
        checksum: i.checksum!,
        mime: i.mime!,
        width: 640,
        height: 480,
        byteSize: i.byteSize!,
      })),
      options: { displayName: null, provider: {} },
      costEstimate: null,
      status: "queued",
      userId: w.owner,
      now: new Date(w.now()).toISOString(),
    });
    const a = await w.agent(w.A);
    expect(await leaseJob(w.deps, leaseReq(a))).toMatchObject({ lease: null, idle: "no_job" });
    // and the same-host discovery never sees a remote job
    expect(
      w.repo.previs.discoverReconstructionJobs({
        provider: "local_capture",
        projectId: w.B,
        statuses: ["queued"],
      }),
    ).toEqual([]);
    expect(
      w.repo.previs.discoverReconstructionJobs({
        provider: "local_agent_capture",
        projectId: w.A,
        statuses: ["queued"],
      }),
    ).toEqual([]);
  });

  it("an expired lease is reaped (failed, provider_timeout) and NEVER re-leased; queued work still flows", async () => {
    const w = await remoteWorld();
    const { lease, imgs } = await leased(w, 4);
    w.advance(LEASE_TTL_MS + 1);
    const other = await w.agent(w.A);
    const next = await w.remoteJob(w.A, imgs.slice(1, 4));
    const r = await leaseJob(w.deps, leaseReq(other));
    expect(r.lease?.jobId).toBe(next.id);
    const stale = (await w.job(lease.jobId))!;
    expect(stale).toMatchObject({ status: "failed", errorCode: "provider_timeout" });
    expect(stale.errorMessage).toMatch(/stopped reporting/);
  });

  it("relay Storage withdrawn (no dedicated key): a held lease gets no source, no progress, no failure write, no upload", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w);
    const off = { ...w.deps, available: false };
    const before = (await w.job(lease.jobId))!.revision;
    const reads = { ...w.sinkCalls };
    expect(
      await code(serveSource(off, srcReq(a, lease.jobId, lease.leaseId, 0), lease.jobId, lease.leaseId, 0)),
    ).toBe("job_not_available");
    expect(
      await code(
        progress(
          off,
          progReq(a, lease.jobId, lease.leaseId, { stage: "downloading", progress: 0, message: "x" }),
          lease.jobId,
          lease.leaseId,
        ),
      ),
    ).toBe("job_not_available");
    expect(
      await code(
        failJob(
          off,
          failReq(a, lease.jobId, lease.leaseId, { code: "brush_failed", stage: null, message: "x" }),
          lease.jobId,
          lease.leaseId,
        ),
      ),
    ).toBe("job_not_available");
    expect(await code(resultUploadGate(off, a.deviceId, lease.jobId, lease.leaseId, 10))).toBe(
      "job_not_available",
    );
    expect((await w.job(lease.jobId))!.revision).toBe(before);
    expect(w.sinkCalls).toEqual(reads); // no private Storage read or write
  });

  it("a claim interrupted between its two writes (queued → submitting, then the server dies) is held by its lease, then failed; never claimed twice", async () => {
    const w = await remoteWorld();
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const a = await w.agent(w.A);
    const previs = w.repo.previs;
    const update = previs.updateReconstructionJob.bind(previs);
    previs.updateReconstructionJob = async (...args: Parameters<typeof update>) => {
      if (args[2].status === "running") throw new Error("fictional crash between the two claim writes");
      return update(...args);
    };
    try {
      await expect(leaseJob(w.deps, leaseReq(a))).rejects.toThrow("fictional crash");
    } finally {
      previs.updateReconstructionJob = update;
    }
    // the FIRST write already froze the whole remote authority: runner, device, opaque lease, its expiry
    const half = (await w.job(job.id))!;
    expect(half.status).toBe("submitting");
    expect(half.providerOperationId).toMatch(/^agent:[0-9a-f]{32}$/);
    expect(half.providerOperation).toMatchObject({
      runner: "remote_agent",
      agentId: a.deviceId,
      leaseId: half.providerOperationId!.slice("agent:".length),
      leaseExpiresAt: new Date(w.now() + LEASE_TTL_MS).toISOString(),
    });
    // while that lease lives, no other workstation can take the job
    const b = await w.agent(w.A);
    w.advance(LEASE_TTL_MS - 1_000);
    expect(await leaseJob(w.deps, leaseReq(b))).toMatchObject({ lease: null, idle: "no_job" });
    expect((await w.job(job.id))!.status).toBe("submitting");
    // past it, the reaper fails that SAME attempt: no second claim, no new attempt, nothing re-run
    w.advance(1_001);
    expect(await leaseJob(w.deps, leaseReq(b))).toMatchObject({ lease: null, idle: "no_job" });
    expect(await w.job(job.id)).toMatchObject({
      status: "failed",
      errorCode: "provider_timeout",
      attempt: 1,
      providerOperationId: half.providerOperationId,
    });
    expect(await w.repo.previs.listReconstructionJobs(w.locA)).toHaveLength(1);
    // the original agent's late requests are refused
    expect(await code(leaseJob(w.deps, leaseReq(a)))).toBe("no error");
    expect(
      await code(
        progress(
          w.deps,
          progReq(a, job.id, half.providerOperationId!.slice(6), {
            stage: "downloading",
            progress: 0,
            message: "x",
          }),
          job.id,
          half.providerOperationId!.slice(6),
        ),
      ),
    ).toBe("job_not_available");
  });

  it("a claim interrupted after its first write is also failed by the owner's refresh once the lease expired", async () => {
    const w = await remoteWorld();
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const a = await w.agent(w.A);
    const previs = w.repo.previs;
    const update = previs.updateReconstructionJob.bind(previs);
    previs.updateReconstructionJob = async (...args: Parameters<typeof update>) => {
      if (args[2].status === "running") throw new Error("fictional crash");
      return update(...args);
    };
    try {
      await expect(leaseJob(w.deps, leaseReq(a))).rejects.toThrow("fictional crash");
    } finally {
      previs.updateReconstructionJob = update;
    }
    expect(await refreshJob(await w.jobDeps(w.A), job.id)).toMatchObject({ status: "submitting" });
    w.advance(LEASE_TTL_MS + 1);
    expect(await refreshJob(await w.jobDeps(w.A), job.id)).toMatchObject({
      status: "failed",
      errorCode: "provider_timeout",
    });
  });

  it("a job whose frozen sources cannot run remotely fails at claim time (invalid_sources)", async () => {
    const w = await remoteWorld();
    const imgs = await w.addImages(w.A, 3);
    const job = await w.remoteJob(w.A, imgs);
    // corrupt the frozen snapshot the way an old row could look (no checksum)
    const raw = (
      w.repo.previs as unknown as { jobs: Map<string, { sources: Array<{ checksum: string | null }> }> }
    ).jobs.get(job.id)!;
    raw.sources[2]!.checksum = null;
    const a = await w.agent(w.A);
    expect(await leaseJob(w.deps, leaseReq(a))).toMatchObject({ lease: null, idle: "no_job" });
    expect(await w.job(job.id)).toMatchObject({ status: "failed", errorCode: "invalid_sources" });
  });
});

// ───────────────────────── sources ─────────────────────────

describe("sources", () => {
  it("serves exactly the frozen photograph, re-verified, and nothing else", async () => {
    const w = await remoteWorld();
    const { a, lease, imgs } = await leased(w);
    const s = await serveSource(
      w.deps,
      srcReq(a, lease.jobId, lease.leaseId, 1),
      lease.jobId,
      lease.leaseId,
      1,
    );
    expect(Buffer.from(s.bytes)).toEqual(Buffer.from(w.objects.get(imgs[1]!.objectPath!)!));
    expect(s).toMatchObject({ mime: imgs[1]!.mime, sha256: imgs[1]!.checksum });
  });

  it("no IDOR: another device, another project's agent, another lease, another job, an ordinal outside the job", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w, 4);
    const sameProject = await w.agent(w.A);
    const otherProject = await w.agent(w.B);
    const otherJob = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const get = (who: TestAgent, jobId: string, leaseId: string, ord: number) =>
      code(serveSource(w.deps, srcReq(who, jobId, leaseId, ord), jobId, leaseId, ord));
    const before = w.sinkCalls.get;
    expect(await get(sameProject, lease.jobId, lease.leaseId, 0)).toBe("lease_mismatch");
    expect(await get(otherProject, lease.jobId, lease.leaseId, 0)).toBe("lease_mismatch");
    expect(await get(a, lease.jobId, "0".repeat(32), 0)).toBe("lease_mismatch");
    expect(await get(a, otherJob.id, lease.leaseId, 0)).toBe("lease_mismatch");
    expect(await get(a, crypto.randomUUID(), lease.leaseId, 0)).toBe("lease_mismatch");
    expect(await get(a, lease.jobId, lease.leaseId, 4)).toBe("source_unavailable");
    expect(await get(a, lease.jobId, lease.leaseId, 299)).toBe("source_unavailable");
    // not one byte of Storage was read for any refusal
    expect(w.sinkCalls.get).toBe(before);
    expect((await w.job(lease.jobId))!.status).toBe("running");
  });

  it("cancelled job, expired lease, revoked agent: refused", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w);
    await cancelJob(await w.jobDeps(w.A), lease.jobId);
    expect(
      await code(
        serveSource(w.deps, srcReq(a, lease.jobId, lease.leaseId, 0), lease.jobId, lease.leaseId, 0),
      ),
    ).toBe("job_cancelled");

    const w2 = await remoteWorld();
    const l2 = await leased(w2);
    w2.advance(LEASE_TTL_MS + 1);
    expect(
      await code(
        serveSource(
          w2.deps,
          srcReq(l2.a, l2.lease.jobId, l2.lease.leaseId, 0),
          l2.lease.jobId,
          l2.lease.leaseId,
          0,
        ),
      ),
    ).toBe("lease_expired");
    expect(await w2.job(l2.lease.jobId)).toMatchObject({ status: "failed", errorCode: "provider_timeout" });

    const w3 = await remoteWorld();
    const l3 = await leased(w3);
    await revokeAgent(w3.agentStore, w3.A, l3.a.deviceId);
    expect(
      await code(
        serveSource(
          w3.deps,
          srcReq(l3.a, l3.lease.jobId, l3.lease.leaseId, 0),
          l3.lease.jobId,
          l3.lease.leaseId,
          0,
        ),
      ),
    ).toBe("device_revoked");
  });

  it("a source that changed since the job was frozen fails the job instead of serving it", async () => {
    const w = await remoteWorld();
    const { a, lease, imgs } = await leased(w);
    w.objects.set(imgs[2]!.objectPath!, new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9]));
    expect(
      await code(
        serveSource(w.deps, srcReq(a, lease.jobId, lease.leaseId, 2), lease.jobId, lease.leaseId, 2),
      ),
    ).toBe("source_unavailable");
    expect(await w.job(lease.jobId)).toMatchObject({ status: "failed", errorCode: "invalid_sources" });
  });
});

// ───────────────────────── progress / keepalive ─────────────────────────

describe("progress and keepalive", () => {
  it("renews the lease; a stage change is written and is an event; same-stage updates are throttled", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w);
    const p = (body: Record<string, unknown>) =>
      progress(w.deps, progReq(a, lease.jobId, lease.leaseId, body), lease.jobId, lease.leaseId);
    w.advance(10_000);
    const r1 = await p({ stage: "downloading", progress: 0, message: "Downloading" });
    expect(Date.parse(r1.leaseExpiresAt)).toBe(w.now() + LEASE_TTL_MS);
    const rev = (await w.job(lease.jobId))!.revision;
    w.advance(500);
    const r2 = await p({ stage: "downloading", progress: 0.01, message: "Downloading" });
    expect(r2.leaseExpiresAt).toBe(r1.leaseExpiresAt);
    expect((await w.job(lease.jobId))!.revision).toBe(rev); // acknowledged, not written
    w.advance(2_000);
    await p({ stage: "downloading", progress: 0.02, message: "Downloading" });
    expect((await w.job(lease.jobId))!.revision).toBe(rev + 1);
    await p({ stage: "splat_training", progress: 0.4, message: "Training on WS-FICTIONAL as someone" });
    const job = (await w.job(lease.jobId))!;
    expect(JSON.stringify(job)).not.toMatch(/WS-FICTIONAL|someone/);
    expect(job).toMatchObject({ status: "running", progress: 0.4 });
    // the server's own words for the stage, never the workstation's text
    expect(job.providerOperation).toMatchObject({
      stage: "splat_training",
      description: "Splat training (Brush)",
    });
    const ev = (await w.events(lease.jobId)).filter((e) => e.event === "progress").map((e) => e.detail.stage);
    expect(ev).toEqual(["downloading", "splat_training"]);
  });

  it("a cancelled job answers job_cancelled; a finished one job_not_available", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w);
    await cancelJob(await w.jobDeps(w.A), lease.jobId);
    expect(
      await code(
        progress(
          w.deps,
          progReq(a, lease.jobId, lease.leaseId, { stage: "splat_training", progress: 0.5, message: "x" }),
          lease.jobId,
          lease.leaseId,
        ),
      ),
    ).toBe("job_cancelled");
    const w2 = await remoteWorld();
    const l2 = await leased(w2);
    await failJob(
      w2.deps,
      failReq(l2.a, l2.lease.jobId, l2.lease.leaseId, {
        code: "colmap_failed",
        stage: "camera_reconstruction",
        message: "no model",
      }),
      l2.lease.jobId,
      l2.lease.leaseId,
    );
    expect(
      await code(
        progress(
          w2.deps,
          progReq(l2.a, l2.lease.jobId, l2.lease.leaseId, {
            stage: "splat_training",
            progress: 0.5,
            message: "x",
          }),
          l2.lease.jobId,
          l2.lease.leaseId,
        ),
      ),
    ).toBe("job_not_available");
  });

  it("the final result must match the job and the toolchain recorded at lease time, and is frozen once", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w);
    const { result } = spzResult();
    const send = (body: Record<string, unknown>) =>
      code(progress(w.deps, progReq(a, lease.jobId, lease.leaseId, body), lease.jobId, lease.leaseId));
    expect(await send({ stage: "splat_training", progress: 1, message: "x", result })).toBe(
      "result_rejected",
    );
    expect(
      await send({
        stage: "uploading",
        progress: 1,
        message: "x",
        result: { ...result, colmap: { ...result.colmap, binarySha256: "b".repeat(64) } },
      }),
    ).toBe("result_rejected");
    expect(
      await send({
        stage: "uploading",
        progress: 1,
        message: "x",
        result: { ...result, brush: { version: "0.4.0" } },
      }),
    ).toBe("result_rejected");
    expect(
      await send({
        stage: "uploading",
        progress: 1,
        message: "x",
        result: { ...result, inputImages: 4, registeredImages: 4 },
      }),
    ).toBe("result_rejected");
    expect(
      await send({ stage: "uploading", progress: 1, message: "x", result: { ...result, path: "C:\\x" } }),
    ).toBe("malformed_request");
    expect(await send({ stage: "uploading", progress: 1, message: "x", result })).toBe("no error");
    expect((await w.job(lease.jobId))!.providerOperation!.result).toMatchObject({ sha256: result.sha256 });
    w.advance(3000);
    expect(await send({ stage: "uploading", progress: 1, message: "again", result })).toBe("no error"); // idempotent
    expect(
      await send({
        stage: "uploading",
        progress: 1,
        message: "x",
        result: { ...result, sha256: "c".repeat(64) },
      }),
    ).toBe("result_rejected");
  });
});

// ───────────────────────── failure ─────────────────────────

describe("failure report", () => {
  it.each(Object.entries(REMOTE_FAILURE_MAP))(
    "agent %s → job %s (server-chosen)",
    async (agentCode, jobCode) => {
      const w = await remoteWorld();
      const { a, lease } = await leased(w);
      const r = await failJob(
        w.deps,
        failReq(a, lease.jobId, lease.leaseId, {
          code: agentCode,
          stage: "splat_training",
          message:
            "Brush stopped at C:\\Users\\someone\\x and /home/someone/y on WS-FICTIONAL (cmd: brush --x) lease abc",
        }),
        lease.jobId,
        lease.leaseId,
      );
      expect(r.job.status).toBe("failed");
      const job = (await w.job(lease.jobId))!;
      expect(job.errorCode).toBe(jobCode);
      // the server's own message for the code; none of the workstation's text is stored
      expect(job.errorMessage).toBe(agentFailureMessage(agentCode as keyof typeof REMOTE_FAILURE_MAP));
      expect(JSON.stringify(job)).not.toMatch(/someone|WS-FICTIONAL|brush --x|lease abc/);
      expect(job.providerOperation).toMatchObject({ stage: "failed", agentError: { code: agentCode } });
    },
  );

  it("the workstation cannot forge a cancellation, choose a status, or name a free-form code", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w);
    expect(agentFailureMessage("cancelled")).toMatch(/stopped before the run completed/);
    expect(
      await code(
        failJob(
          w.deps,
          failReq(a, lease.jobId, lease.leaseId, { code: "succeeded", stage: null, message: "" }),
          lease.jobId,
          lease.leaseId,
        ),
      ),
    ).toBe("malformed_request");
    expect(
      await code(
        failJob(
          w.deps,
          failReq(a, lease.jobId, lease.leaseId, {
            code: "cancelled",
            stage: null,
            message: "x",
            status: "cancelled",
          }),
          lease.jobId,
          lease.leaseId,
        ),
      ),
    ).toBe("malformed_request");
    await failJob(
      w.deps,
      failReq(a, lease.jobId, lease.leaseId, {
        code: "cancelled" satisfies AgentFailureCode,
        stage: null,
        message: "x",
      }),
      lease.jobId,
      lease.leaseId,
    );
    expect(await w.job(lease.jobId)).toMatchObject({ status: "failed", errorCode: "provider_failed" });
  });

  it("after the owner cancelled, a failure report answers job_cancelled and changes nothing", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w);
    await cancelJob(await w.jobDeps(w.A), lease.jobId);
    expect(
      await code(
        failJob(
          w.deps,
          failReq(a, lease.jobId, lease.leaseId, { code: "colmap_failed", stage: null, message: "x" }),
          lease.jobId,
          lease.leaseId,
        ),
      ),
    ).toBe("job_cancelled");
    expect((await w.job(lease.jobId))!.status).toBe("cancelled");
  });
});

// ───────────────────────── result ─────────────────────────

describe("result upload", () => {
  it("re-validates, imports through the shared M2D.2 ingestion: private Asset, immutable reconstruction, success", async () => {
    const w = await remoteWorld();
    const { a, lease, imgs } = await leased(w);
    const bytes = await declare(w, a, lease.jobId, lease.leaseId);
    const r = await uploadResult(
      w.deps,
      putReq(a, lease.jobId, lease.leaseId, bytes),
      lease.jobId,
      lease.leaseId,
    );
    expect(r.job).toMatchObject({ id: lease.jobId, status: "succeeded" });
    const job = (await w.job(lease.jobId))!;
    expect(job.status).toBe("succeeded");
    const rec = (await w.repo.previs.getReconstruction(job.resultReconstructionId!))!;
    expect(rec).toMatchObject({ method: "generated", resultFormat: "spz", gaussianCount: 64 });
    expect(rec.sources.map((s) => s.assetId)).toEqual(imgs.map((i) => i.id));
    expect(rec.calibration).toMatchObject({ scaleMethod: "unknown", metresPerSourceUnit: null });
    const meta = rec.generation!.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({
      runner: "remote_agent",
      agentId: a.deviceId,
      lossless: false,
      quality: "standard",
    });
    expect(JSON.stringify(rec.generation)).not.toMatch(
      /[A-Za-z]:\\|\/home\/|leaseId|publicKey|MCowBQYDK2VwAyEA/,
    );
    const asset = (await w.assetsOf(w.A)).find((x) => x.id === rec.resultAssetId)!;
    expect(asset).toMatchObject({
      storageProvider: "local",
      mime: "application/x-spz",
      byteSize: bytes.length,
      purpose: "spatial_reconstruction",
    });
    expect(asset.objectPath!.startsWith(`${w.A}/`)).toBe(true);
    expect((await w.events(lease.jobId)).map((e) => e.event).slice(-3)).toEqual([
      "provider_succeeded",
      "ingesting",
      "succeeded",
    ]);
  });

  it("refuses wrong bytes, invalid SPZ and undeclared results; the job fails truthfully and nothing is stored", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w);
    expect(
      await code(
        uploadResult(
          w.deps,
          putReq(a, lease.jobId, lease.leaseId, new Uint8Array(10)),
          lease.jobId,
          lease.leaseId,
        ),
      ),
    ).toBe("result_rejected");
    expect((await w.job(lease.jobId))!.status).toBe("running"); // nothing declared yet: nothing to judge
    const bytes = await declare(w, a, lease.jobId, lease.leaseId);
    const tampered = new Uint8Array(bytes);
    tampered[20] ^= 0xff;
    expect(
      await code(
        uploadResult(w.deps, putReq(a, lease.jobId, lease.leaseId, tampered), lease.jobId, lease.leaseId),
      ),
    ).toBe("result_rejected");
    expect(await w.job(lease.jobId)).toMatchObject({ status: "failed", errorCode: "result_invalid" });
    expect((await w.assetsOf(w.A)).some((x) => x.purpose === "spatial_reconstruction")).toBe(false);

    // a declared checksum of bytes that are not an SPZ at all
    const w2 = await remoteWorld();
    const l2 = await leased(w2);
    const junk = new Uint8Array(500).fill(7);
    const { result } = spzResult();
    const { createHash } = await import("node:crypto");
    const fake = {
      ...result,
      sha256: createHash("sha256").update(junk).digest("hex"),
      byteSize: junk.length,
    };
    await progress(
      w2.deps,
      progReq(l2.a, l2.lease.jobId, l2.lease.leaseId, {
        stage: "uploading",
        progress: 1,
        message: "x",
        result: fake,
      }),
      l2.lease.jobId,
      l2.lease.leaseId,
    );
    expect(
      await code(
        uploadResult(
          w2.deps,
          putReq(l2.a, l2.lease.jobId, l2.lease.leaseId, junk),
          l2.lease.jobId,
          l2.lease.leaseId,
        ),
      ),
    ).toBe("result_rejected");
    expect(await w2.job(l2.lease.jobId)).toMatchObject({ status: "failed", errorCode: "result_invalid" });
  });

  it("wrong device, wrong lease, another project's agent: refused before anything is judged", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w);
    const bytes = await declare(w, a, lease.jobId, lease.leaseId);
    const other = await w.agent(w.A);
    const foreign = await w.agent(w.B);
    expect(
      await code(
        uploadResult(w.deps, putReq(other, lease.jobId, lease.leaseId, bytes), lease.jobId, lease.leaseId),
      ),
    ).toBe("lease_mismatch");
    expect(
      await code(
        uploadResult(w.deps, putReq(foreign, lease.jobId, lease.leaseId, bytes), lease.jobId, lease.leaseId),
      ),
    ).toBe("lease_mismatch");
    expect(
      await code(
        uploadResult(w.deps, putReq(a, lease.jobId, "f".repeat(32), bytes), lease.jobId, "f".repeat(32)),
      ),
    ).toBe("lease_mismatch");
    // the pre-body gate: only the claimed device's lease with the declared length passes
    expect(
      await code(resultUploadGate(w.deps, other.deviceId, lease.jobId, lease.leaseId, bytes.length)),
    ).toBe("lease_mismatch");
    expect(
      await code(resultUploadGate(w.deps, a.deviceId, lease.jobId, lease.leaseId, bytes.length + 1)),
    ).toBe("result_rejected");
    expect(await code(resultUploadGate(w.deps, a.deviceId, lease.jobId, lease.leaseId, null))).toBe(
      "result_rejected",
    );
    expect(await resultUploadGate(w.deps, a.deviceId, lease.jobId, lease.leaseId, bytes.length)).toBe(
      bytes.length,
    );
    expect((await w.job(lease.jobId))!.status).toBe("running");
  });

  it("cancelled job: refused, no Asset; expired lease: judged by when the upload was SIGNED", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w);
    const bytes = await declare(w, a, lease.jobId, lease.leaseId);
    await cancelJob(await w.jobDeps(w.A), lease.jobId);
    expect(
      await code(
        uploadResult(w.deps, putReq(a, lease.jobId, lease.leaseId, bytes), lease.jobId, lease.leaseId),
      ),
    ).toBe("job_cancelled");
    expect((await w.assetsOf(w.A)).some((x) => x.purpose === "spatial_reconstruction")).toBe(false);

    const w2 = await remoteWorld();
    const l2 = await leased(w2);
    const b2 = await declare(w2, l2.a, l2.lease.jobId, l2.lease.leaseId);
    const expiresAt = Date.parse((await w2.job(l2.lease.jobId))!.providerOperation!.leaseExpiresAt as string);
    // signed while the lease was valid, arriving after it (a long upload): accepted
    const signedInTime = putReq(l2.a, l2.lease.jobId, l2.lease.leaseId, b2, { timestamp: expiresAt - 1000 });
    w2.advance(expiresAt - w2.now() + 30_000);
    expect((await uploadResult(w2.deps, signedInTime, l2.lease.jobId, l2.lease.leaseId)).job.status).toBe(
      "succeeded",
    );

    const w3 = await remoteWorld();
    const l3 = await leased(w3);
    const b3 = await declare(w3, l3.a, l3.lease.jobId, l3.lease.leaseId);
    w3.advance(LEASE_TTL_MS + 1);
    expect(
      await code(
        uploadResult(
          w3.deps,
          putReq(l3.a, l3.lease.jobId, l3.lease.leaseId, b3),
          l3.lease.jobId,
          l3.lease.leaseId,
        ),
      ),
    ).toBe("lease_expired");
    expect(await w3.job(l3.lease.jobId)).toMatchObject({ status: "failed", errorCode: "provider_timeout" });
  });

  it("exactly once: a repeated upload returns the existing outcome; concurrent uploads import once", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w);
    const bytes = await declare(w, a, lease.jobId, lease.leaseId);
    const results = await Promise.all([
      code(uploadResult(w.deps, putReq(a, lease.jobId, lease.leaseId, bytes), lease.jobId, lease.leaseId)),
      code(uploadResult(w.deps, putReq(a, lease.jobId, lease.leaseId, bytes), lease.jobId, lease.leaseId)),
      code(uploadResult(w.deps, putReq(a, lease.jobId, lease.leaseId, bytes), lease.jobId, lease.leaseId)),
    ]);
    expect(results.filter((r) => r === "no error").length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r === "no error" || r === "result_pending" || r === "counter_replayed")).toBe(
      true,
    );
    const again = await uploadResult(
      w.deps,
      putReq(a, lease.jobId, lease.leaseId, bytes),
      lease.jobId,
      lease.leaseId,
    );
    expect(again.job.status).toBe("succeeded");
    const splats = (await w.assetsOf(w.A)).filter((x) => x.purpose === "spatial_reconstruction");
    expect(splats).toHaveLength(1);
    expect(again.job.reconstructionId).toBe((await w.job(lease.jobId))!.resultReconstructionId);
  });

  it("ingesting: the workstation's authority is over; only the server-side import grace applies", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w);
    await declare(w, a, lease.jobId, lease.leaseId);
    // the server won running → ingesting (as uploadResult does) and its import is still in progress
    const j = (await w.job(lease.jobId))!;
    await w.repo.previs.updateReconstructionJob(
      j.id,
      j.revision,
      {
        status: "ingesting",
        progress: 1,
        providerOperation: {
          ...j.providerOperation,
          stage: "ingesting",
          leaseExpiresAt: new Date(w.now() + INGEST_GRACE_MS).toISOString(),
        },
      },
      new Date(w.now()).toISOString(),
    );
    const ingesting = (await w.job(lease.jobId))!;
    // no renewal: progress is refused and does not move the grace deadline
    w.advance(60_000);
    expect(
      await code(
        progress(
          w.deps,
          progReq(a, lease.jobId, lease.leaseId, { stage: "uploading", progress: 1, message: "x" }),
          lease.jobId,
          lease.leaseId,
        ),
      ),
    ).toBe("job_not_available");
    // a lease request neither renews it nor hands out another job while the result is imported
    expect(await leaseJob(w.deps, leaseReq(a))).toMatchObject({ lease: null, idle: "no_job" });
    expect((await w.job(lease.jobId))!.revision).toBe(ingesting.revision);
    expect((await w.job(lease.jobId))!.providerOperation!.leaseExpiresAt).toBe(
      ingesting.providerOperation!.leaseExpiresAt,
    );
    // a server import that never finished (process died): failed once the grace ends, never re-leased
    w.advance(INGEST_GRACE_MS);
    expect(await refreshJob(await w.jobDeps(w.A), lease.jobId)).toMatchObject({
      status: "failed",
      errorCode: "provider_timeout",
    });
  });

  it("cancel racing the upload: whichever compare-and-set wins is final (a cancel that won stores nothing)", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w);
    const bytes = await declare(w, a, lease.jobId, lease.leaseId);
    const jobDeps = await w.jobDeps(w.A);
    const deps = {
      ...w.deps,
      hooks: { beforeIngestClaim: async () => void (await cancelJob(jobDeps, lease.jobId)) },
    };
    expect(
      await code(
        uploadResult(deps, putReq(a, lease.jobId, lease.leaseId, bytes), lease.jobId, lease.leaseId),
      ),
    ).toBe("job_cancelled");
    expect((await w.job(lease.jobId))!.status).toBe("cancelled");
    expect((await w.assetsOf(w.A)).some((x) => x.purpose === "spatial_reconstruction")).toBe(false);
    // and once imported, a cancel cannot change it
    const w2 = await remoteWorld();
    const l2 = await leased(w2);
    const b2 = await declare(w2, l2.a, l2.lease.jobId, l2.lease.leaseId);
    await uploadResult(
      w2.deps,
      putReq(l2.a, l2.lease.jobId, l2.lease.leaseId, b2),
      l2.lease.jobId,
      l2.lease.leaseId,
    );
    expect((await cancelJob(await w2.jobDeps(w2.A), l2.lease.jobId)).status).toBe("succeeded");
  });
});

// ───────────────────────── revocation, web reconciliation, no fallback ─────────────────────────

describe("project-scoped availability", () => {
  it("one owner, two projects: project A's ready workstation never makes Remote Local Agent ready in project B", async () => {
    const w = await remoteWorld();
    const { remoteAgentView } = await import("@/lib/reconstruction/remote-agent-capture");
    // the same signed-in owner owns both projects
    expect((await w.repo.projectOwner(w.B))?.userId).toBe((await w.repo.projectOwner(w.A))?.userId);
    await w.agent(w.A);
    const server = { enabled: true, configured: true };
    const viewOf = async (p: string) => remoteAgentView(await w.agentStore.listDevices(p), w.now(), server);
    expect(await viewOf(w.A)).toMatchObject({ state: "ready", ready: 1 });
    expect(await viewOf(w.B)).toMatchObject({ state: "no_agents", ready: 0 });
    // and project A's workstation never sees project B's queued job
    const jobB = await w.remoteJob(w.B, await w.addImages(w.B, 3));
    const a2 = await w.agent(w.A);
    expect(await leaseJob(w.deps, leaseReq(a2))).toMatchObject({ lease: null, idle: "no_job" });
    expect(await w.job(jobB.id)).toMatchObject({ status: "queued" });
  });
});

describe("relay key rotation (no re-pairing)", () => {
  it("the SAME paired device keeps heartbeating while execution is withdrawn, and leases again once it returns", async () => {
    const w = await remoteWorld();
    const job = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const a = await w.agent(w.A);
    const { heartbeat } = await import("../../service");
    const caps = capabilities();
    const execCaps = {
      ...caps,
      engine: { ...caps.engine, qualityProfiles: ["draft" as const, "standard" as const] },
      execution: { remoteJobs: true as const },
    };
    const off = { ...w.deps, available: false, agent: { ...w.deps.agent, remoteJobs: false } };
    // key removed: control plane fine, execution unavailable, the job waits (queued, untouched)
    await heartbeat(off.agent, a.heartbeat({}, execCaps));
    expect(await status(off.agent, a.request("GET", PATHS.status, null))).toMatchObject({
      remoteExecution: "not_available",
    });
    expect(await leaseJob(off, leaseReq(a))).toMatchObject({ lease: null, idle: "remote_jobs_unavailable" });
    expect(await w.job(job.id)).toMatchObject({ status: "queued" });
    // a new key configured: the same device (same key pair, no new pairing) leases the waiting job
    const on = { ...w.deps, available: true, agent: { ...w.deps.agent, remoteJobs: true } };
    await heartbeat(on.agent, a.heartbeat({}, execCaps));
    expect(await status(on.agent, a.request("GET", PATHS.status, null))).toMatchObject({
      remoteExecution: "available",
    });
    expect((await leaseJob(on, leaseReq(a))).lease?.jobId).toBe(job.id);
    expect((await w.agentStore.listDevices(w.A)).filter((d) => d.status === "active")).toHaveLength(1);
  });
});

describe("lease id secrecy", () => {
  it("the lease id never appears in server logs, job events or the reconstruction's provenance", async () => {
    const w = await remoteWorld();
    const logs: unknown[] = [];
    w.deps.log = (e) => logs.push(e);
    const { a, lease } = await leased(w);
    const bytes = await declare(w, a, lease.jobId, lease.leaseId);
    await uploadResult(w.deps, putReq(a, lease.jobId, lease.leaseId, bytes), lease.jobId, lease.leaseId);
    const job = (await w.job(lease.jobId))!;
    expect(job.status).toBe("succeeded");
    const rec = (await w.repo.previs.getReconstruction(job.resultReconstructionId!))!;
    const tail = lease.leaseId.slice(-12);
    for (const text of [
      JSON.stringify(logs),
      JSON.stringify(await w.events(lease.jobId)),
      JSON.stringify(rec),
    ]) {
      expect(text).not.toContain(lease.leaseId);
      expect(text).not.toContain(tail);
    }
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("request ownership on every lease route", () => {
  it("knowing the job, lease and Asset ids grants nothing without THE device's key, project and lease", async () => {
    const w = await remoteWorld();
    const { a, lease } = await leased(w);
    const bytes = await declare(w, a, lease.jobId, lease.leaseId);
    const sameProject = await w.agent(w.A);
    const otherProject = await w.agent(w.B);
    const otherJob = await w.remoteJob(w.A, await w.addImages(w.A, 3));
    const wrongLease = "f".repeat(32);
    const before = { rev: (await w.job(lease.jobId))!.revision, sink: { ...w.sinkCalls } };
    const routes = (who: TestAgent, jobId: string, leaseId: string, o: { agentId?: string } = {}) => [
      serveSource(w.deps, who.request("GET", jobPaths(jobId, leaseId).source(0), null, o), jobId, leaseId, 0),
      progress(
        w.deps,
        progReq(who, jobId, leaseId, { stage: "downloading", progress: 0, message: "x" }, o),
        jobId,
        leaseId,
      ),
      failJob(
        w.deps,
        who.request(
          "POST",
          jobPaths(jobId, leaseId).fail,
          { protocol: PROTOCOL, code: "brush_failed", stage: null, message: "x" },
          o,
        ),
        jobId,
        leaseId,
      ),
      uploadResult(w.deps, putReq(who, jobId, leaseId, bytes, o), jobId, leaseId),
    ];
    const all = async (ps: Promise<unknown>[]) => Promise.all(ps.map((p) => code(p)));
    const mismatch = ["lease_mismatch", "lease_mismatch", "lease_mismatch", "lease_mismatch"];
    expect(await all(routes(sameProject, lease.jobId, lease.leaseId))).toEqual(mismatch);
    expect(await all(routes(otherProject, lease.jobId, lease.leaseId))).toEqual(mismatch);
    expect(await all(routes(a, lease.jobId, wrongLease))).toEqual(mismatch);
    expect(await all(routes(a, otherJob.id, lease.leaseId))).toEqual(mismatch);
    // another device signing while claiming the holder's id: the signature does not verify
    const forged = await all(routes(sameProject, lease.jobId, lease.leaseId, { agentId: a.deviceId }));
    expect(new Set(forged)).toEqual(new Set(["invalid_signature"]));
    // nothing changed and no private byte was read or written
    expect((await w.job(lease.jobId))!.revision).toBe(before.rev);
    expect(w.sinkCalls).toEqual(before.sink);
    expect(await w.job(otherJob.id)).toMatchObject({ status: "queued" });
  });
});

describe("revocation and reconciliation", () => {
  it("revoking a device fails its active job at once (never reassigned); other devices' jobs are untouched", async () => {
    const w = await remoteWorld();
    const imgs = await w.addImages(w.A, 4);
    const j1 = await w.remoteJob(w.A, imgs.slice(0, 3));
    const j2 = await w.remoteJob(w.A, imgs.slice(1, 4));
    const [a, b] = [await w.agent(w.A), await w.agent(w.A)];
    const la = (await leaseJob(w.deps, leaseReq(a))).lease!;
    const lb = (await leaseJob(w.deps, leaseReq(b))).lease!;
    expect(new Set([la.jobId, lb.jobId])).toEqual(new Set([j1.id, j2.id]));
    await revokeAgent(w.agentStore, w.A, a.deviceId);
    expect(await failJobsOfAgent(w.deps.jobs, w.A, w.owner, a.deviceId, w.now)).toBe(1);
    expect(await w.job(la.jobId)).toMatchObject({ status: "failed", errorCode: "provider_failed" });
    expect((await w.job(la.jobId))!.errorMessage).toMatch(/revoked/);
    expect((await w.job(lb.jobId))!.status).toBe("running");
    expect(await code(leaseJob(w.deps, leaseReq(a)))).toBe("device_revoked");
    expect(await code(status(w.deps.agent, a.request("GET", PATHS.status, null)))).toBe("device_revoked");
  });

  it("the web side only reconciles: an expired remote lease fails on refresh; World Labs is never called", async () => {
    const w = await remoteWorld();
    const calls: string[] = [];
    const wlt = new WorldLabsProvider({
      ...readWorldLabsConfig({ WLT_API_KEY: "fictional-test-key", WORLDLABS_RECONSTRUCTION_ENABLED: "1" }),
      fetchImpl: (async (u: unknown) => (calls.push(String(u)), new Response("{}"))) as typeof fetch,
      downloader: async (u) => (calls.push(String(u)), new Uint8Array(0)),
    });
    const { lease } = await leased(w);
    const deps = await w.jobDeps(w.A, [wlt]);
    expect((await refreshJob(deps, lease.jobId)).status).toBe("running");
    w.advance(LEASE_TTL_MS + 1);
    const failed = await refreshJob(deps, lease.jobId);
    expect(failed).toMatchObject({ status: "failed", errorCode: "provider_timeout" });
    // retry is a NEW attempt of the SAME provider, queued for a workstation (never a substitute)
    const retried = await retryJob(deps, lease.jobId);
    expect(retried).toMatchObject({ provider: "local_agent_capture", status: "queued", attempt: 2 });
    expect(calls).toEqual([]);
  });

  it("a remote job cannot be created when no workstation of the project is ready (no fallback)", async () => {
    const w = await remoteWorld();
    w.setRemoteView({ state: "offline", active: 1, online: 0, ready: 0, busy: 0 });
    await expect(w.remoteJob(w.A, await w.addImages(w.A, 3))).rejects.toMatchObject({
      code: "capability_unavailable",
    });
  });
});
