import { describe, expect, it } from "vitest";
import { GenerationProviderError } from "@/domain/generation/errors";
import { GenerationWorker } from "../worker";
import { ModelRegistry } from "../registry";
import { silentLogger } from "../log";
import { prepareSubmission } from "../submission";
import type { GenerationProviderAdapter } from "../provider";
import { makeHarness, type Harness } from "./helpers";

/** A registry whose "mock" adapter delegates to the real mock but lets a test intercept submit(). */
function interceptedWorker(
  h: Harness,
  onSubmit: (call: number) => Promise<void> | void,
): { worker: GenerationWorker; calls: () => number } {
  const real = h.registry.adapter("mock")!;
  let calls = 0;
  const wrapped: GenerationProviderAdapter = Object.create(real);
  wrapped.submit = async (...args) => {
    calls += 1;
    await onSubmit(calls);
    return real.submit(...args);
  };
  const registry = new ModelRegistry([wrapped], h.config, {});
  const worker = new GenerationWorker({
    store: h.repo.generation,
    registry,
    sink: h.sink,
    config: h.config,
    logger: silentLogger,
    clock: () => h.clock.now,
    workerId: "intercepted",
    retryPolicy: { baseDelayMs: 100, maxDelayMs: 1000, jitter: 0 },
    random: () => 0,
    heartbeatMs: 0,
  });
  return { worker, calls: () => calls };
}

async function prepareFor(h: Harness, code: string, key: string, revision: string | null) {
  const data = await h.data();
  const shot = data.shots.find((s) => s.shotCode === code)!;
  const base = {
    data,
    shotId: shot.id,
    registry: h.registry,
    provider: "mock",
    modelId: "mock-video-1",
    userId: null,
    idempotencyKey: key,
    config: h.config,
    now: h.clock.now,
    projectRevision: revision,
  };
  const probe = prepareSubmission({ ...base, acknowledged: [] });
  const ignored = probe.evaluation.compatibility?.ignoredFeatures.map((f) => f.id) ?? [];
  return { data, shot, prepared: prepareSubmission({ ...base, acknowledged: ignored }) };
}

describe("Phase 2A review hardening", () => {
  it("stale package: a Look changed between validation and commit is refused, not frozen", async () => {
    const h = makeHarness();
    const before = (await h.repo.generation.projectRevision("ojousama"))!;
    const attemptsBefore = (await h.data()).attempts.length;
    const { data, prepared } = await prepareFor(h, "3A", "race-key-00001", before.revision);
    expect(prepared.input).toBeTruthy();

    // A concurrent edit to a package dependency (NOT the shot row, so shot.updatedAt is unchanged).
    const look = data.looks[0]!;
    await h.repo.upsert(data.project.id, "looks", { ...look, name: `${look.name} (edited)` });
    expect((await h.repo.generation.projectRevision("ojousama"))!.revision).not.toBe(before.revision);

    await expect(h.repo.generation.createAttemptWithJob(prepared.input!)).rejects.toMatchObject({
      code: "stale_package",
    });
    expect((await h.data()).attempts).toHaveLength(attemptsBefore);

    // A fresh read + revision succeeds.
    const revision = (await h.repo.generation.projectRevision("ojousama"))!.revision;
    const again = await prepareFor(h, "3A", "race-key-00002", revision);
    await expect(h.repo.generation.createAttemptWithJob(again.prepared.input!)).resolves.toMatchObject({
      duplicate: false,
    });
  });

  it("generation activity itself does not invalidate the package revision", async () => {
    const h = makeHarness();
    const before = (await h.repo.generation.projectRevision("ojousama"))!.revision;
    await h.submit("3A");
    expect((await h.repo.generation.projectRevision("ojousama"))!.revision).toBe(before);
  });

  it("cancel during an in-flight submit keeps the provider job id and is not 'before submission'", async () => {
    const h = makeHarness();
    const { jobId } = await h.submit("3A");
    const { worker } = interceptedWorker(h, async () => {
      // the user cancels while the provider call is in flight
      await h.repo.generation.requestCancel(jobId!, h.clock.now.toISOString());
    });
    await worker.tick();
    for (let i = 0; i < 5; i++) {
      const j = await h.repo.generation.getJob(jobId!);
      if (j?.status === "cancelled") break;
      h.clock.advance(1500);
      await worker.tick();
    }
    const job = (await h.repo.generation.getJob(jobId!))!;
    expect(job.status).toBe("cancelled");
    expect(job.providerJobId).toMatch(/^mock_/);
    expect(job.cancelOutcome).not.toBe("local_only");
  });

  it("a non-idempotent provider is NOT re-submitted after an ambiguous failure", async () => {
    const h = makeHarness();
    // mock-video-lite supports 5 s / 10 s only: give the shot a 5 s target so it is compatible.
    const data = await h.data();
    const shot = data.shots.find((s) => s.shotCode === "3A")!;
    await h.repo.upsert(data.project.id, "shots", {
      ...shot,
      durationMode: "manual",
      targetDurationMs: 5000,
      updatedAt: new Date(h.clock.now.getTime() - 1000).toISOString(),
    });
    const { jobId } = await h.submit("3A", "mock-video-lite");
    expect(jobId).toBeTruthy();
    const { worker, calls } = interceptedWorker(h, (n) => {
      if (n === 1) throw new GenerationProviderError("timeout", "net_timeout", "timed out");
    });
    await worker.tick(); // first submit: ambiguous timeout → retry scheduled
    expect((await h.repo.generation.getJob(jobId!))!.status).toBe("queued");
    h.clock.advance(5000);
    await worker.tick(); // would re-submit; must refuse instead
    const job = (await h.repo.generation.getJob(jobId!))!;
    expect(job.status).toBe("failed");
    expect(job.lastErrorCode).toBe("submission_outcome_unknown");
    expect(calls()).toBe(1); // the provider was contacted exactly once
    const view = (await h.repo.generation.getAttemptView(job.attemptId))!;
    expect(view.costs.map((c) => c.kind)).toContain("unknown");
  });

  it("an idempotent provider IS re-submitted (same key) after an ambiguous failure", async () => {
    const h = makeHarness();
    const { jobId } = await h.submit("3A", "mock-video-1");
    const { worker, calls } = interceptedWorker(h, (n) => {
      if (n === 1) throw new GenerationProviderError("timeout", "net_timeout", "timed out");
    });
    await worker.tick();
    h.clock.advance(5000);
    await worker.tick();
    expect(calls()).toBe(2);
    expect((await h.repo.generation.getJob(jobId!))!.providerJobId).toMatch(/^mock_/);
  });

  it("a disabled provider receives no new work (kill switch)", async () => {
    const h = makeHarness();
    const { jobId } = await h.submit("3A");
    const real = h.registry.adapter("mock")!;
    const disabled = new ModelRegistry([real], { ...h.config, enabledProviders: [] }, {});
    const worker = new GenerationWorker({
      store: h.repo.generation,
      registry: disabled,
      sink: h.sink,
      config: h.config,
      logger: silentLogger,
      clock: () => h.clock.now,
      heartbeatMs: 0,
    });
    await worker.tick();
    const job = (await h.repo.generation.getJob(jobId!))!;
    expect(job.status).toBe("failed");
    expect(job.lastErrorCode).toBe("provider_unavailable");
    expect(job.providerJobId).toBeNull();
  });
});
