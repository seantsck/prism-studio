import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { PrevisError } from "@/data/previs-repository";
import { assetSchema, type Asset } from "@/domain/schemas";
import { MockReconstructionProvider } from "@/lib/reconstruction/mock";
import { ProviderError, type ReconstructionProvider } from "@/lib/reconstruction/provider";
import { WorldLabsProvider, type WorldLabsConfig } from "@/lib/reconstruction/worldlabs";
import { encodeSpzFile, syntheticPlane } from "@/lib/splat/synthetic";
import type { PassStoreDeps } from "../spatial-pass-store";
import {
  cancelJob,
  createJob,
  JobServiceError,
  refreshJob,
  retryJob,
  submitJob,
  type JobServiceDeps,
} from "../reconstruction-jobs";

const T0 = Date.parse("2026-10-18T00:00:00Z");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function image(projectId: string, name: string): Asset {
  const id = randomUUID();
  return assetSchema.parse({
    id,
    projectId,
    createdBy: null,
    type: "image",
    purpose: "location_ref",
    source: "upload",
    name,
    originalFilename: `${name}.png`,
    storageProvider: "local",
    bucket: null,
    objectPath: `${projectId}/${id}/${name}.png`,
    mime: "image/png",
    byteSize: PNG.length,
    checksum: `sum-${name}`,
    width: 640,
    height: 480,
    durationMs: null,
    frameRate: null,
    sampleRate: null,
    channels: null,
    tags: [],
    notes: "",
    metadata: {},
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
  });
}

async function world(
  opts: {
    providers?: (now: () => number) => Map<string, ReconstructionProvider>;
    paid?: { enabled: boolean; maxUsd: number | null };
    jobsEnabled?: boolean;
    failPut?: boolean;
  } = {},
) {
  const repo = new MemoryRepository();
  const data = (await repo.loadProject("ojousama"))!;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  const locationId = shot.spatial.locationId ?? data.locations[0]!.id;
  const images = ["front", "left", "right"].map((n) => image(data.project.id, n));
  for (const a of images) await repo.upsert(data.project.id, "assets", a);
  let t = T0;
  const clock = { advance: (ms: number) => (t += ms), now: () => t };
  const objects = new Map<string, Uint8Array>();
  const rows = new Map<string, Asset>();
  let failPut = opts.failPut ?? false;
  const store: PassStoreDeps = {
    async putObject(path, bytes) {
      if (failPut) throw new Error("injected: storage unavailable");
      objects.set(path, bytes);
    },
    async upsertAsset(a) {
      rows.set(a.id, a);
      await repo.upsert(data.project.id, "assets", a);
    },
    async removeAsset(id) {
      rows.delete(id);
      await repo.remove(data.project.id, "assets", id);
    },
    async removeObject(a) {
      objects.delete(a.objectPath ?? "");
    },
  };
  const providers =
    opts.providers?.(clock.now) ??
    new Map<string, ReconstructionProvider>([
      [
        "mock_reconstruction",
        new MockReconstructionProvider({ available: true, durationMs: 5000 }, clock.now),
      ],
    ]);
  const logs: Array<Record<string, unknown>> = [];
  const deps: JobServiceDeps = {
    repo: repo.previs,
    providers: providers as JobServiceDeps["providers"],
    config: {
      jobsEnabled: opts.jobsEnabled ?? true,
      paid: opts.paid ?? { enabled: false, maxUsd: null },
      pollIntervalMs: 1000,
    },
    projectAssets: images,
    projectId: data.project.id,
    locationName: () => "Grand Celeste Lobby",
    readAssetBytes: async () => PNG,
    store,
    storage: { name: "local", bucket: null },
    userId: null,
    now: () => new Date(t).toISOString(),
    newId: () => randomUUID(),
    log: (e) => logs.push(e),
  };
  return {
    repo,
    deps,
    data,
    locationId,
    images,
    clock,
    objects,
    rows,
    logs,
    setFailPut: (v: boolean) => (failPut = v),
  };
}
type W = Awaited<ReturnType<typeof world>>;

const create = (w: W, scenario = "success", order = [0, 1, 2]) =>
  createJob(w.deps, {
    locationId: w.locationId,
    sourceAssetIds: order.map((i) => w.images[i]!.id),
    provider: "mock_reconstruction",
    model: null,
    options: { provider: { scenario } },
  });

async function runToEnd(w: W, jobId: string, steps = 10) {
  let j = await w.repo.previs.getReconstructionJob(jobId);
  for (let i = 0; i < steps && j && !["succeeded", "failed", "cancelled"].includes(j.status); i++) {
    w.clock.advance(1500);
    j = await refreshJob(w.deps, jobId);
  }
  return j!;
}

describe("reconstruction job lifecycle (mock provider, memory repository)", () => {
  it("create → queued → submit → running with progress → succeeded: validated private Asset + immutable generated reconstruction", async () => {
    const w = await world();
    const job = await create(w, "success", [2, 0, 1]);
    expect(job.status).toBe("queued");
    expect(job.sources.map((s) => s.assetId)).toEqual([w.images[2]!.id, w.images[0]!.id, w.images[1]!.id]);
    expect(job.sources.map((s) => s.ordinal)).toEqual([0, 1, 2]);
    const submitted = await submitJob(w.deps, job.id);
    expect(submitted.status).toBe("running");
    expect(submitted.providerOperationId).toMatch(/^mockop_success_/);
    w.clock.advance(2000);
    const mid = await refreshJob(w.deps, job.id);
    expect(mid.status).toBe("running");
    expect(mid.progress).toBeGreaterThan(0);
    expect(mid.progress).toBeLessThan(1);

    const done = await runToEnd(w, job.id);
    expect(done.status).toBe("succeeded");
    expect(done.resultReconstructionId).toBeTruthy();
    const rec = (await w.repo.previs.getReconstruction(done.resultReconstructionId!))!;
    expect(rec).toMatchObject({
      method: "generated",
      resultKind: "gaussian_splat",
      resultFormat: "spz",
      locationId: w.locationId,
    });
    // the job's ORDER is preserved in the reconstruction provenance
    expect(rec.sources.map((s) => s.assetId)).toEqual([w.images[2]!.id, w.images[0]!.id, w.images[1]!.id]);
    expect(rec.generation).toMatchObject({
      jobId: job.id,
      attempt: 1,
      provider: "mock_reconstruction",
      operationId: done.providerOperationId,
    });
    // the mock makes no scale claim: unknown, never metres
    expect(rec.calibration).toMatchObject({
      units: "unknown",
      scaleMethod: "unknown",
      metresPerSourceUnit: null,
    });
    // one private Asset, stored, checksummed, typed
    const asset = (await w.repo.loadProject("ojousama"))!.assets.find((a) => a.id === rec.resultAssetId)!;
    expect(asset).toMatchObject({
      type: "3d",
      purpose: "spatial_reconstruction",
      source: "provider_output",
      mime: "application/x-spz",
    });
    expect(w.objects.size).toBe(1);
    expect(JSON.stringify([done, rec])).not.toMatch(/https?:|blob:|signature|token=/i);
    const events = (await w.repo.previs.listReconstructionJobEvents(job.id)).map((e) => e.event);
    expect(events).toEqual(
      expect.arrayContaining([
        "created",
        "queued",
        "submitted",
        "provider_running",
        "progress",
        "provider_succeeded",
        "ingesting",
        "succeeded",
      ]),
    );
  });

  it("polling is rate-limited: a refresh within the interval does not call the provider", async () => {
    const w = await world();
    const job = await create(w);
    await submitJob(w.deps, job.id);
    const provider = w.deps.providers.get("mock_reconstruction")!;
    const spy = vi.spyOn(provider, "getOperation");
    await refreshJob(w.deps, job.id); // < 1 s after submit
    expect(spy).not.toHaveBeenCalled();
    w.clock.advance(1200);
    await refreshJob(w.deps, job.id);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("provider failure → failed provider_failed; later refreshes never change a terminal job", async () => {
    const w = await world();
    const job = await create(w, "fail");
    await submitJob(w.deps, job.id);
    const done = await runToEnd(w, job.id);
    expect(done).toMatchObject({ status: "failed", errorCode: "provider_failed" });
    w.clock.advance(5000);
    expect(await refreshJob(w.deps, job.id)).toEqual(done);
    expect(w.objects.size).toBe(0);
  });

  it("an INVALID provider result is refused by Prism validation: no Asset, no reconstruction", async () => {
    const w = await world();
    const job = await create(w, "invalid");
    await submitJob(w.deps, job.id);
    const done = await runToEnd(w, job.id);
    expect(done).toMatchObject({ status: "failed", errorCode: "result_invalid" });
    expect(w.objects.size).toBe(0);
    expect(await w.repo.previs.listReconstructions(w.locationId)).toEqual([]);
  });

  it("an OVERSIZE result is refused before any byte is stored", async () => {
    const w = await world();
    const job = await create(w, "oversize");
    await submitJob(w.deps, job.id);
    const done = await runToEnd(w, job.id);
    expect(done).toMatchObject({ status: "failed", errorCode: "result_too_large" });
    expect(w.objects.size).toBe(0);
  });

  it("cancel: a provider that supports it confirms; the job is cancelled and stays cancelled", async () => {
    const w = await world();
    const job = await create(w, "slow");
    await submitJob(w.deps, job.id);
    const c = await cancelJob(w.deps, job.id);
    expect(c.status).toBe("cancelled");
    expect(c.providerOperation).toMatchObject({ cancelConfirmedByProvider: true });
    w.clock.advance(10_000);
    expect((await refreshJob(w.deps, job.id)).status).toBe("cancelled");
  });

  it("an UNANSWERED submit is ambiguous: failed submit_ambiguous, the provider is never asked twice", async () => {
    const w = await world();
    const provider = w.deps.providers.get("mock_reconstruction")!;
    const spy = vi.spyOn(provider, "submit");
    const job = await create(w, "submit_timeout");
    const r = await submitJob(w.deps, job.id);
    expect(r).toMatchObject({ status: "failed", errorCode: "submit_ambiguous" });
    expect(r.errorMessage).toMatch(/may still have been accepted/);
    expect(await submitJob(w.deps, job.id)).toEqual(r);
    expect(await refreshJob(w.deps, job.id)).toEqual(r);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a local poll timeout does NOT fail a running provider operation", async () => {
    const w = await world();
    const job = await create(w, "slow");
    await submitJob(w.deps, job.id);
    const provider = w.deps.providers.get("mock_reconstruction")!;
    vi.spyOn(provider, "getOperation").mockRejectedValueOnce(new ProviderError("timeout", "no answer"));
    w.clock.advance(1500);
    const r = await refreshJob(w.deps, job.id);
    expect(r.status).toBe("running");
    expect(r.providerOperationId).toBe(
      (await w.repo.previs.getReconstructionJob(job.id))!.providerOperationId,
    );
  });

  it("retry creates a NEW attempt; the failed attempt is untouched history; provider inputs are reused", async () => {
    const w = await world();
    const job = await create(w, "fail");
    await submitJob(w.deps, job.id);
    const failed = await runToEnd(w, job.id);
    const retried = await retryJob(w.deps, failed.id);
    expect(retried.id).not.toBe(failed.id);
    expect(retried).toMatchObject({
      attempt: 2,
      previousJobId: failed.id,
      jobFingerprint: failed.jobFingerprint,
      status: "running",
    });
    expect(retried.providerOperationId).not.toBe(failed.providerOperationId);
    expect(retried.providerInputs!.map((p) => p.providerAssetId)).toEqual(
      failed.providerInputs!.map((p) => p.providerAssetId),
    );
    expect(await w.repo.previs.getReconstructionJob(failed.id)).toEqual(failed);
    await expect(retryJob(w.deps, retried.id)).rejects.toBeInstanceOf(JobServiceError);
  });

  it("a replaced reference image (new checksum) is refused at submission: create a new job", async () => {
    const w = await world();
    const job = await create(w);
    w.deps.projectAssets = w.images.map((a, i) => (i === 0 ? { ...a, checksum: "CHANGED" } : a));
    const r = await submitJob(w.deps, job.id);
    expect(r).toMatchObject({ status: "failed", errorCode: "invalid_sources" });
  });

  it("cross-project sources are rejected at creation", async () => {
    const w = await world();
    await expect(
      createJob(w.deps, {
        locationId: w.locationId,
        sourceAssetIds: [randomUUID()],
        provider: "mock_reconstruction",
        model: null,
        options: {},
      }),
    ).rejects.toMatchObject({ code: "invalid_sources" });
  });
});

describe("atomic ingestion and lost races", () => {
  it("a storage failure leaves the job INGESTING (bounded retries), never a half reconstruction", async () => {
    const w = await world({ failPut: true });
    const job = await create(w);
    await submitJob(w.deps, job.id);
    let j = job;
    for (let i = 0; i < 6 && j.status !== "ingesting"; i++) {
      w.clock.advance(1500);
      j = await refreshJob(w.deps, job.id);
    }
    expect(j.status).toBe("ingesting");
    expect(w.objects.size).toBe(0);
    expect(w.rows.size).toBe(0);
    expect(await w.repo.previs.listReconstructions(w.locationId)).toEqual([]);
    // storage recovers: the next poll ingests exactly once
    w.setFailPut(false);
    w.clock.advance(1500);
    j = await refreshJob(w.deps, job.id);
    expect(j.status).toBe("succeeded");
    expect(w.objects.size).toBe(1);
    expect((await w.repo.previs.listReconstructions(w.locationId)).length).toBe(1);
  });

  it("persistent storage failure ends as ingest_failed after the bounded attempts, with nothing left behind", async () => {
    const w = await world({ failPut: true });
    const job = await create(w);
    await submitJob(w.deps, job.id);
    const done = await runToEnd(w, job.id, 20);
    expect(done).toMatchObject({ status: "failed", errorCode: "ingest_failed" });
    expect(w.objects.size + w.rows.size).toBe(0);
    expect(await w.repo.previs.listReconstructions(w.locationId)).toEqual([]);
  });

  it("an Asset-row failure is cleaned up (object removed) and retried", async () => {
    const w = await world();
    const job = await create(w);
    await submitJob(w.deps, job.id);
    const orig = w.deps.store.upsertAsset;
    let once = true;
    w.deps.store = {
      ...w.deps.store,
      upsertAsset: async (a) => {
        if (once) {
          once = false;
          throw new Error("injected: row");
        }
        return orig(a);
      },
    };
    const done = await runToEnd(w, job.id);
    expect(done.status).toBe("succeeded");
    expect(w.objects.size).toBe(1); // the failed attempt's object was removed; only the winner's remains
  });

  it("a reconstruction-row / job-finalisation failure removes the attempt's Asset and object", async () => {
    const w = await world();
    const job = await create(w);
    await submitJob(w.deps, job.id);
    const spy = vi
      .spyOn(w.repo.previs, "completeReconstructionJob")
      .mockRejectedValueOnce(new Error("injected: db"));
    let j = job;
    for (let i = 0; i < 8 && j.status !== "ingesting"; i++) {
      w.clock.advance(1500);
      j = await refreshJob(w.deps, job.id);
    }
    expect(spy).toHaveBeenCalledTimes(1);
    expect(j.status).toBe("ingesting");
    expect(w.objects.size + w.rows.size).toBe(0);
    const done = await runToEnd(w, job.id);
    expect(done.status).toBe("succeeded");
    expect(w.objects.size).toBe(1);
  });

  it("two pollers racing the same success ingest EXACTLY once (one Asset, one reconstruction)", async () => {
    const w = await world();
    const job = await create(w);
    await submitJob(w.deps, job.id);
    w.clock.advance(6000);
    // both read the job before either writes
    const [a, b] = await Promise.all([refreshJob(w.deps, job.id), refreshJob(w.deps, job.id)]);
    const final = await w.repo.previs.getReconstructionJob(job.id);
    expect([a.status, b.status]).toContain(final!.status);
    const done = await runToEnd(w, job.id);
    expect(done.status).toBe("succeeded");
    expect(w.objects.size).toBe(1);
    expect((await w.repo.previs.listReconstructions(w.locationId)).length).toBe(1);
  });

  it("the database refuses a second reconstruction for the same job", async () => {
    const w = await world();
    const job = await create(w);
    await submitJob(w.deps, job.id);
    const done = await runToEnd(w, job.id);
    const rec = (await w.repo.previs.getReconstruction(done.resultReconstructionId!))!;
    await expect(
      w.repo.previs.recordReconstruction({
        ...rec,
        id: randomUUID(),
        userId: null,
        now: "t",
        resultAssetId: randomUUID(),
        generation: rec.generation,
      }),
    ).rejects.toBeInstanceOf(PrevisError);
  });
});

describe("the live-spend gate (billable providers)", () => {
  const fakeWorldLabs = (submit: ReturnType<typeof vi.fn>) => {
    const config: WorldLabsConfig = {
      apiKey: "wlt-test-key-not-real",
      enabled: true,
      baseUrl: "https://api.worldlabs.ai",
      uploadHosts: ["storage.googleapis.com"],
      resultHosts: ["*.worldlabs.ai"],
      requestTimeoutMs: 1000,
      fetchImpl: submit as unknown as typeof fetch,
      downloader: async () => encodeSpzFile(syntheticPlane({ n: 4 })),
    };
    return new WorldLabsProvider(config);
  };

  it("paid generation OFF: the provider is never called, even with the feature flag on and an API key present", async () => {
    const fetchSpy = vi.fn();
    const w = await world({
      providers: () => new Map([["worldlabs_marble", fakeWorldLabs(fetchSpy)]]),
      paid: { enabled: false, maxUsd: 10 },
    });
    await expect(
      createJob(w.deps, {
        locationId: w.locationId,
        sourceAssetIds: [w.images[0]!.id],
        provider: "worldlabs_marble",
        model: "marble-1.1",
        options: {},
      }),
    ).rejects.toMatchObject({ code: "spend_blocked" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a job queued while paid was on is still blocked at SUBMIT if paid is switched off (no upload, no submit)", async () => {
    const fetchSpy = vi.fn();
    const w = await world({
      providers: () => new Map([["worldlabs_marble", fakeWorldLabs(fetchSpy)]]),
      paid: { enabled: true, maxUsd: 5 },
    });
    const job = await createJob(w.deps, {
      locationId: w.locationId,
      sourceAssetIds: [w.images[0]!.id],
      provider: "worldlabs_marble",
      model: "marble-1.1",
      options: {},
    });
    w.deps.config = { ...w.deps.config, paid: { enabled: false, maxUsd: 5 } };
    const r = await submitJob(w.deps, job.id);
    expect(r).toMatchObject({ status: "failed", errorCode: "spend_blocked" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a ceiling below the documented MAXIMUM price blocks (variable pricing is never assumed cheap)", async () => {
    const fetchSpy = vi.fn();
    const w = await world({
      providers: () => new Map([["worldlabs_marble", fakeWorldLabs(fetchSpy)]]),
      paid: { enabled: true, maxUsd: 2 },
    });
    // marble-1.1-plus is documented as up to 3,000 credits ($2.40)
    await expect(
      createJob(w.deps, {
        locationId: w.locationId,
        sourceAssetIds: [w.images[0]!.id],
        provider: "worldlabs_marble",
        model: "marble-1.1-plus",
        options: {},
      }),
    ).rejects.toMatchObject({ code: "spend_blocked" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the feature flag OFF blocks every provider (mock included)", async () => {
    const w = await world({ jobsEnabled: false });
    await expect(create(w)).rejects.toMatchObject({ code: "not_configured" });
  });
});
