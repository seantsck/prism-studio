import { describe, expect, it } from "vitest";
import { GenerationSubmitError } from "@/data/generation-repository";
import { makeHarness } from "./helpers";

/** Drives the worker until the job is terminal (advancing the fake clock between ticks). */
async function drive(h: ReturnType<typeof makeHarness>, jobId: string, maxTicks = 20, stepMs = 1500) {
  const worker = h.worker();
  for (let i = 0; i < maxTicks; i++) {
    const job = await h.repo.generation.getJob(jobId);
    if (job && ["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await worker.tick();
    h.clock.advance(stepMs);
  }
  return (await h.repo.generation.getJob(jobId))!;
}

describe("generation worker (mock provider, in-memory store)", () => {
  it("3A: full happy path — queued → submitted → generating → ingested outputs → succeeded", async () => {
    const h = makeHarness();
    const { prepared, attemptId, jobId } = await h.submit("3A");
    expect(prepared.evaluation.gate.blockers).toEqual([]);
    expect(attemptId).toBeTruthy();

    // submitted state: attempt is frozen and queued
    const queued = await h.repo.generation.getAttemptView(attemptId!);
    expect(queued?.attempt.status).toBe("queued");
    expect(queued?.attempt.attemptNumber).toBe(1);
    expect(queued?.job?.status).toBe("queued");
    expect(queued?.costs.map((c) => c.kind)).toEqual(["estimated"]);

    const job = await drive(h, jobId!);
    expect(job.status).toBe("succeeded");
    expect(job.providerJobId).toMatch(/^mock_/);
    expect(job.actualCost).toBeGreaterThan(0);

    const view = await h.repo.generation.getAttemptView(attemptId!);
    expect(view?.attempt.status).toBe("succeeded");
    expect(view?.attempt.reviewStatus).toBe("unreviewed");
    expect(view?.outputs.map((o) => [o.output.role, o.output.position, o.asset.type])).toEqual([
      ["primary", 0, "video"],
      ["preview", 1, "image"],
    ]);
    expect(view?.attempt.outputAssetId).toBe(view?.outputs[0]!.asset.id);
    const primary = view!.outputs[0]!.asset;
    expect(primary.purpose).toBe("generation_output");
    expect(primary.source).toBe("provider_output");
    expect(primary.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(primary.mime).toBe("video/webm");
    expect(await h.sink.get(primary.objectPath!)).toBeTruthy();
    expect(view?.costs.map((c) => c.kind).sort()).toEqual(["actual", "estimated"]);

    const events = await h.repo.generation.listJobEvents(jobId!);
    // (zero-latency mock reports "processing" immediately, so there is no separate "submitted" step)
    expect(events.map((e) => e.toStatus)).toEqual([
      "queued",
      "submitting",
      "processing",
      "ingesting",
      "succeeded",
    ]);
  });

  it("the frozen attempt keeps its package, plan and request independent of later project changes", async () => {
    const h = makeHarness();
    const { attemptId, jobId } = await h.submit("3A");
    const before = JSON.stringify(
      (await h.repo.generation.getAttemptView(attemptId!))!.attempt.packageSnapshot,
    );
    await drive(h, jobId!);
    const after = (await h.repo.generation.getAttemptView(attemptId!))!.attempt;
    expect(JSON.stringify(after.packageSnapshot)).toBe(before);
    expect(after.promptPlan?.sections.length).toBeGreaterThan(3);
    expect((after.request as { modelId: string }).modelId).toBe("mock-video-1");
    expect(after.packageFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("transient provider errors are retried with backoff and then succeed", async () => {
    const h = makeHarness();
    const { jobId } = await h.submit("3A", "mock-video-flaky");
    const job = await drive(h, jobId!, 40, 400);
    expect(job.status).toBe("succeeded");
    expect(job.attemptCount).toBeGreaterThan(1);
    const events = await h.repo.generation.listJobEvents(jobId!);
    expect(events.some((e) => /Retrying/.test(e.note))).toBe(true);
  });

  it("content rejection is terminal, never retried, and recorded with a safe category", async () => {
    const h = makeHarness();
    const { jobId, attemptId } = await h.submit("3A", "mock-video-rejects");
    const job = await drive(h, jobId!);
    expect(job.status).toBe("failed");
    expect(job.lastErrorCategory).toBe("content_rejected");
    expect(job.lastErrorCode).toBe("content_policy");
    expect(job.lastErrorMessage).toContain("Generation rejected by provider.");
    expect(job.attemptCount).toBe(1);
    const view = await h.repo.generation.getAttemptView(attemptId!);
    expect(view?.attempt.status).toBe("failed");
    // submitted before it failed → billing unknown is recorded, never invented
    expect(view?.costs.find((c) => c.kind === "unknown")?.amount).toBeNull();
  });

  it("a job the provider never finishes times out", async () => {
    const h = makeHarness();
    const { jobId } = await h.submit("3A", "mock-video-hang");
    const worker = h.worker();
    await worker.tick();
    h.clock.advance(2000);
    await worker.tick(); // processing
    h.clock.advance(31_000);
    await worker.tick();
    const job = (await h.repo.generation.getJob(jobId!))!;
    expect(job.status).toBe("failed");
    expect(job.lastErrorCategory).toBe("timeout");
  });

  it("cancelling a queued job is local and nothing reaches a provider", async () => {
    const h = makeHarness();
    const { jobId, attemptId } = await h.submit("3A");
    const cancelled = await h.repo.generation.requestCancel(jobId!, h.clock.now.toISOString());
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.cancelOutcome).toBe("local_only");
    expect(cancelled?.providerJobId).toBeNull();
    expect((await h.repo.generation.getAttemptView(attemptId!))?.attempt.status).toBe("cancelled");
    expect(await h.worker().tick()).toBe(0);
  });

  it("cancelling a submitted job asks the provider and records the confirmed outcome", async () => {
    const h = makeHarness();
    const { jobId } = await h.submit("3A");
    const worker = h.worker();
    await worker.tick(); // → submitted
    expect(["submitted", "processing"]).toContain((await h.repo.generation.getJob(jobId!))?.status);
    await h.repo.generation.requestCancel(jobId!, h.clock.now.toISOString());
    await worker.tick();
    const job = (await h.repo.generation.getJob(jobId!))!;
    expect(job.status).toBe("cancelled");
    expect(job.cancelOutcome).toBe("confirmed");
  });

  it("when the provider cannot cancel, Prism says so instead of claiming it did", async () => {
    const h = makeHarness();
    // mock-video-lite: 5 s / 10 s only. Give 3A a 5 s target so the model is compatible.
    const data = await h.data();
    const shot = data.shots.find((s) => s.shotCode === "3A")!;
    await h.repo.upsert(data.project.id, "shots", {
      ...shot,
      durationMode: "manual",
      targetDurationMs: 5000,
      updatedAt: new Date(h.clock.now.getTime() - 1000).toISOString(),
    });
    const { jobId, prepared } = await h.submit("3A", "mock-video-lite");
    expect(prepared.evaluation.gate.blockers).toEqual([]);
    const worker = h.worker();
    await worker.tick();
    await h.repo.generation.requestCancel(jobId!, h.clock.now.toISOString());
    await worker.tick();
    const job = (await h.repo.generation.getJob(jobId!))!;
    expect(job.status).toBe("cancelled");
    expect(job.cancelOutcome).toBe("not_supported");
    const events = await h.repo.generation.listJobEvents(jobId!);
    expect(events.at(-1)?.note).toMatch(/did not confirm/);
  });

  it("claims are exclusive while a lease is valid and recover after it expires", async () => {
    const h = makeHarness();
    await h.submit("3A");
    const store = h.repo.generation;
    const now = h.clock.now.toISOString();
    const a = await store.claim({ workerId: "A", now, leaseMs: 5000, limit: 5 });
    const b = await store.claim({ workerId: "B", now, leaseMs: 5000, limit: 5 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
    h.clock.advance(6000);
    const c = await store.claim({ workerId: "B", now: h.clock.now.toISOString(), leaseMs: 5000, limit: 5 });
    expect(c).toHaveLength(1);
    expect(c[0]!.job.leaseOwner).toBe("B");
    // the first worker's token is now useless
    await expect(
      store.update(a[0]!.job.id, a[0]!.job.leaseToken!, { providerStatus: "x" }, h.clock.now.toISOString()),
    ).rejects.toThrow(/Lease/);
  });

  it("heartbeat extends a lease; a stranger's token cannot", async () => {
    const h = makeHarness();
    await h.submit("3A");
    const store = h.repo.generation;
    const [claim] = await store.claim({
      workerId: "A",
      now: h.clock.now.toISOString(),
      leaseMs: 1000,
      limit: 1,
    });
    expect(
      await store.heartbeat(claim!.job.id, claim!.job.leaseToken!, h.clock.now.toISOString(), 60_000),
    ).toBe(true);
    expect(await store.heartbeat(claim!.job.id, "not-the-token", h.clock.now.toISOString(), 60_000)).toBe(
      false,
    );
    h.clock.advance(30_000);
    expect(
      await store.claim({ workerId: "B", now: h.clock.now.toISOString(), leaseMs: 1000, limit: 1 }),
    ).toHaveLength(0);
  });

  it("restart recovery: a job interrupted mid-flight is resumed by a new worker", async () => {
    const h = makeHarness();
    const { jobId } = await h.submit("3A");
    const store = h.repo.generation;
    // Worker A claims and "crashes" without finishing.
    await store.claim({ workerId: "A", now: h.clock.now.toISOString(), leaseMs: 1000, limit: 1 });
    h.clock.advance(5000);
    const job = await drive(h, jobId!);
    expect(job.status).toBe("succeeded");
  });

  it("duplicate submissions: same key replays, same shot is blocked while active, project cap holds", async () => {
    const h = makeHarness();
    const first = await h.submit("3A", "mock-video-1", { key: "dup-key-0001" });
    const replay = await h.submit("3A", "mock-video-1", { key: "dup-key-0001" });
    expect(replay.attemptId).toBe(first.attemptId);

    await expect(h.submit("3A", "mock-video-1", { key: "another-key-0002" })).rejects.toThrow(
      GenerationSubmitError,
    );
    await expect(h.submit("3A", "mock-video-1", { key: "another-key-0002" })).rejects.toMatchObject({
      code: "duplicate_active",
    });
  });

  it("only the project's cap of active generations may exist", async () => {
    const h = makeHarness({ PRISM_STUDIO_GENERATION_MAX_ACTIVE_PER_PROJECT: "1" });
    await h.submit("3A");
    const other = await (async () => {
      const d = await h.data();
      return d.shots.find((s) => s.shotCode !== "3A")!.shotCode;
    })();
    await expect(h.submit(other)).rejects.toMatchObject({
      code: expect.stringMatching(/project_busy|duplicate_active/),
    });
  });

  it("stale shot: submission is refused when the shot changed after the package was built", async () => {
    const h = makeHarness();
    const data = await h.data();
    const shot = data.shots.find((s) => s.shotCode === "3A")!;
    const { prepared } = await h.submit("3A", "mock-video-1", { key: "stale-key-0001" });
    // cancel that one so the dup check does not interfere, then change the shot under a prepared input
    await h.repo.generation.requestCancel(
      (await h.repo.generation.listActiveProjectJobs(data.project.id))[0]!.id,
      h.clock.now.toISOString(),
    );
    await h.repo.upsert(data.project.id, "shots", {
      ...shot,
      title: "Changed title",
      updatedAt: "2030-01-01T00:00:00.000Z",
    });
    const stale = {
      ...prepared.input!,
      job: { ...prepared.input!.job, id: crypto.randomUUID(), idempotencyKey: "stale-key-0002" },
    };
    await expect(h.repo.generation.createAttemptWithJob(stale)).rejects.toMatchObject({ code: "stale_shot" });
  });
});
