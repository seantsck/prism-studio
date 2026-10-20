import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { assetSchema, type Asset } from "@/domain/schemas";
import type { ReconstructionJobRecord } from "@/domain/reconstruction/job";
import { createJob, submitJob, type JobServiceDeps } from "@/server/reconstruction-jobs";
import type { PassStoreDeps } from "@/server/spatial-pass-store";
import { fakeMachine, machineEnv } from "../../local/__tests__/fake-machine";
import { fakeBrush, fakeColmap } from "../../local/__tests__/fake-tools";
import { jpegBytes, PNG_BYTES, tempDir } from "../../local/__tests__/fixtures";
import { probeLocalToolchain } from "../../local/toolchain";
import { LocalCaptureProvider } from "../../local-capture";
import type { ReconstructionProvider } from "../../provider";
import { WorldLabsProvider } from "../../worldlabs";
import { workerBackedToolchain } from "../status";
import { LOCAL_PROVIDER_ID, type LocalJobRef, type LocalWorkerStore } from "../store";
import { LocalReconstructionWorker, type LocalWorkerOptions, type LocalWorkerTiming } from "../worker";

/**
 * TEST-ONLY world for the M2D.3B worker: the M2D.2 job service as the WEB side (create / cancel / retry / read), and
 * the worker as a separate actor that shares nothing with it but persistence (the in-memory repository + an object
 * store standing in for private Storage). External tools are the M2D.3A fakes run as real child processes, behind a
 * real, VERIFIED provenance manifest; everything after the tool output is production code.
 */

export const FAST: Partial<LocalWorkerTiming> = {
  pollMs: 100,
  cancelCheckMs: 200,
  progressWriteMs: 200,
  heartbeatMs: 250,
  shutdownGraceMs: 20_000,
  ingestRetryMs: 10,
};

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export async function localWorld(opts: { images?: number } = {}) {
  const tmp = await tempDir("prism-local-worker-test-");
  const workRoot = path.join(tmp.dir, "work");
  await mkdir(workRoot, { recursive: true });
  const machine = await fakeMachine(path.join(tmp.dir, "machine"));
  const repo = new MemoryRepository();
  const data = (await repo.loadProject("ojousama"))!;
  const projectId = data.project.id;
  const locationId = data.locations[0]!.id;
  const owner = randomUUID();
  const objects = new Map<string, Uint8Array>();

  const images: Asset[] = [];
  for (let i = 0; i < (opts.images ?? 3); i++) {
    const png = i === 1;
    const bytes = png ? PNG_BYTES : jpegBytes(i + 1);
    const id = randomUUID();
    const ext = png ? "png" : "jpg";
    const a = assetSchema.parse({
      id,
      projectId,
      createdBy: owner,
      type: "image",
      purpose: "location_ref",
      source: "upload",
      name: `lobby-${i + 1}`,
      originalFilename: `lobby-${i + 1}.${ext}`,
      storageProvider: "local",
      bucket: null,
      objectPath: `${projectId}/${id}/lobby-${i + 1}.${ext}`,
      mime: png ? "image/png" : "image/jpeg",
      byteSize: bytes.length,
      checksum: sha(bytes),
      width: 640,
      height: 480,
      durationMs: null,
      frameRate: null,
      sampleRate: null,
      channels: null,
      tags: [],
      notes: "",
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    objects.set(a.objectPath!, bytes);
    await repo.upsert(projectId, "assets", a);
    images.push(a);
  }

  const passStore: PassStoreDeps = {
    putObject: async (p, bytes) => void objects.set(p, bytes),
    upsertAsset: (a) => repo.upsert(projectId, "assets", a),
    removeAsset: (id) => repo.remove(projectId, "assets", id),
    removeObject: async (a) => void objects.delete(a.objectPath ?? ""),
  };

  const jobs = () => repo.previs.listReconstructionJobs(locationId);
  const ref = (j: ReconstructionJobRecord): LocalJobRef => ({
    id: j.id,
    projectId: j.projectId,
    ownerId: j.createdBy,
    status: j.status,
  });
  /** what the Postgres store's discovery query returns: local_capture only, oldest first */
  const store: LocalWorkerStore = {
    persistence: "memory",
    listQueued: async (limit) =>
      (await jobs())
        .filter((j) => j.provider === LOCAL_PROVIDER_ID && j.status === "queued")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit)
        .map(ref),
    listInFlight: async () =>
      (await jobs())
        .filter(
          (j) =>
            j.provider === LOCAL_PROVIDER_ID && ["submitting", "running", "ingesting"].includes(j.status),
        )
        .map(ref),
    scopeFor: async (r) => ({
      repo: repo.previs,
      findAsset: (id) => repo.findAsset(id),
      readAssetBytes: async (a) => (a.objectPath ? (objects.get(a.objectPath) ?? null) : null),
      store: passStore,
      storage: { name: "local", bucket: null },
      locationName: async () => "Grand Celeste Lobby",
      userId: r.ownerId,
    }),
  };

  // ── the web side (what the server actions do), with World Labs configured AND paid generation on: a local job
  //    must still never reach it ──
  const worldLabsFetch = vi.fn(async () => new Response("{}", { status: 500 }));
  const webEnv = {
    PRISM_LOCAL_RECONSTRUCTION_WORKER_ENABLED: "1",
    PRISM_LOCAL_RECONSTRUCTION_ROOT: workRoot,
  };
  const providers = new Map<string, ReconstructionProvider>([
    [
      "local_capture",
      new LocalCaptureProvider(workerBackedToolchain({ env: webEnv, persistence: "supabase" })),
    ],
    [
      "worldlabs_marble",
      new WorldLabsProvider({
        apiKey: "wlt-test-key-not-real",
        enabled: true,
        baseUrl: "https://api.worldlabs.ai",
        uploadHosts: ["storage.googleapis.com"],
        resultHosts: ["*.worldlabs.ai"],
        requestTimeoutMs: 1000,
        fetchImpl: worldLabsFetch as unknown as typeof fetch,
        downloader: async () => {
          throw new Error("a local job must never download from World Labs");
        },
      }),
    ],
  ]);
  const web: JobServiceDeps = {
    repo: repo.previs,
    providers,
    config: { jobsEnabled: true, paid: { enabled: true, maxUsd: 10 }, pollIntervalMs: 250 },
    projectAssets: images,
    projectId,
    locationName: () => "Grand Celeste Lobby",
    readAssetBytes: async (a) => (a.objectPath ? (objects.get(a.objectPath) ?? null) : null),
    store: passStore,
    storage: { name: "local", bucket: null },
    userId: owner,
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
    log: () => undefined,
  };

  const logs: Array<Record<string, unknown>> = [];
  const workers: LocalReconstructionWorker[] = [];
  /** the production M2D.3A probe over the fake machine (fake tools behind a real, verified provenance manifest) */
  const probe =
    (o: { colmap?: string; brush?: string; vulkan?: boolean } = {}) =>
    () =>
      probeLocalToolchain({
        platform: "win32",
        env: { ...machineEnv(machine), ...(o.vulkan === false ? { SystemRoot: tmp.dir } : {}) },
        commandFor: (tool) =>
          tool === "colmap" ? fakeColmap(o.colmap ?? "success") : fakeBrush(o.brush ?? "success"),
      });
  const worker = (
    o: {
      colmap?: string;
      brush?: string;
      timing?: Partial<LocalWorkerTiming>;
      root?: string;
      vulkan?: boolean;
    } & Partial<Pick<LocalWorkerOptions, "engine" | "hooks">> = {},
  ) => {
    const w = new LocalReconstructionWorker({
      store,
      workRoot: o.root ?? workRoot,
      probe: probe(o),
      timing: { ...FAST, ...o.timing },
      engine: o.engine,
      hooks: o.hooks,
      log: (e) => logs.push(e),
    });
    workers.push(w);
    return w;
  };

  /** "Generate Reconstruction": exactly what the server action does (create, then submit once). */
  const generate = async (sourceAssetIds = images.map((a) => a.id)) => {
    const job = await createJob(web, {
      locationId,
      sourceAssetIds,
      provider: "local_capture",
      model: null,
      options: {},
    });
    return submitJob(web, job.id);
  };
  const job = async (id: string) => (await repo.previs.getReconstructionJob(id))!;
  const waitFor = async <T>(
    fn: () => Promise<T | null | undefined | false>,
    timeoutMs = 60_000,
    what = "condition",
  ) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const resultAssets = async () =>
    ((await repo.loadProject("ojousama"))!.assets ?? []).filter(
      (a) => a.purpose === "spatial_reconstruction",
    );

  return {
    tmp,
    workRoot,
    machine,
    repo,
    projectId,
    locationId,
    owner,
    images,
    objects,
    store,
    web,
    worldLabsFetch,
    logs,
    probe,
    worker,
    generate,
    job,
    jobs,
    waitFor,
    resultAssets,
    async cleanup() {
      for (const w of workers) await w.stop().catch(() => undefined);
      await tmp.cleanup();
    },
  };
}
export type LocalWorld = Awaited<ReturnType<typeof localWorld>>;
