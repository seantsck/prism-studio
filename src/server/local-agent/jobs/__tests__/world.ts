import { createHash, randomUUID } from "node:crypto";
import { MemoryRepository } from "@/data/memory-repository";
import { buildSeedProject } from "@/data/seed";
import type { ProjectData } from "@/domain/schemas";
import { assetSchema, type Asset } from "@/domain/schemas";
import { MAX_SPLAT_BYTES } from "@/domain/previs/splat";
import type { OutputSink } from "@/generation/sink";
import { jpegBytes, PNG_BYTES } from "@/lib/reconstruction/local/__tests__/fixtures";
import type { ReconstructionProvider } from "@/lib/reconstruction/provider";
import { RemoteAgentCaptureProvider, type RemoteAgentView } from "@/lib/reconstruction/remote-agent-capture";
import { encodeSpzFile, syntheticPlane } from "@/lib/splat/synthetic";
import type { FinalResult } from "@/lib/local-agent/protocol";
import { createJob, type JobServiceDeps } from "@/server/reconstruction-jobs";
import { capabilities, ORIGIN, TestAgent } from "../../__tests__/helpers";
import { createPairingOffer, heartbeat, redeemPairing } from "../../service";
import { MemoryAgentStore } from "../../store";
import type { RemoteJobDeps } from "../service";
import { memoryRemoteJobStore } from "../store";

/**
 * TEST-ONLY world for remote Local Agent jobs: the Prism server's in-memory repository with TWO projects of the SAME
 * owner (so project isolation is proven by the server's own checks, not by ownership), an object store standing in
 * for private Storage, fictional paired workstations (their own Ed25519 keys) and a controllable clock.
 */

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A second seed project with every id replaced consistently (no id is shared with the first). */
function remappedSeed(slug: string): ProjectData {
  const text = JSON.stringify(buildSeedProject());
  const map = new Map<string, string>();
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const remapped = JSON.parse(
    text.replace(UUID, (id) => map.get(id) ?? (map.set(id, randomUUID()), map.get(id)!)),
  );
  // the owner stays the same user: isolation must come from the device's project, not from RLS ownership
  const owner = buildSeedProject().project.userId;
  return { ...remapped, project: { ...remapped.project, slug, userId: owner } };
}

export const READY: RemoteAgentView = { state: "ready", active: 1, online: 1, ready: 1, busy: 0 };

/**
 * `clock: "real"` follows the wall clock (for a REAL agent client, which signs with Date.now); `advance` then adds an
 * offset. The default is a fixed clock (for TestAgent, which signs with the world's clock).
 */
export async function remoteWorld(o: { clock?: "fixed" | "real"; origin?: string } = {}) {
  const seedA = buildSeedProject();
  const seedB = remappedSeed("other-project");
  const repo = new MemoryRepository([seedA, seedB]);
  const A = seedA.project.id;
  const B = seedB.project.id;
  const locA = seedA.locations[0]!.id;
  const locB = seedB.locations[0]!.id;
  const owner = seedA.project.userId;
  const base = o.clock === "real" ? null : Date.parse("2026-10-20T12:00:00.000Z");
  let offset = 0;
  const now = () => (base ?? Date.now()) + offset;
  const objects = new Map<string, Uint8Array>();
  const sinkCalls = { get: 0, put: 0 };
  const sink: OutputSink = {
    name: "local",
    bucket: null,
    put: async (p, bytes) => {
      sinkCalls.put++;
      objects.set(p, bytes);
    },
    get: async (p) => {
      sinkCalls.get++;
      return objects.get(p) ?? null;
    },
    remove: async (p) => void objects.delete(p),
  };

  async function addImages(projectId: string, n: number): Promise<Asset[]> {
    const out: Asset[] = [];
    for (let i = 0; i < n; i++) {
      const png = i % 3 === 1;
      const bytes = png ? new Uint8Array([...PNG_BYTES, i]) : jpegBytes(i + 1 + projectId.charCodeAt(0));
      const id = randomUUID();
      const ext = png ? "png" : "jpg";
      const a = assetSchema.parse({
        id,
        projectId,
        createdBy: owner,
        type: "image",
        purpose: "location_ref",
        source: "upload",
        name: `ref-${i + 1}`,
        originalFilename: `IMG_${i + 1}.${ext}`,
        storageProvider: "local",
        bucket: null,
        objectPath: `${projectId}/${id}/ref-${i + 1}.${ext}`,
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
        createdAt: new Date(now()).toISOString(),
        updatedAt: new Date(now()).toISOString(),
      });
      objects.set(a.objectPath!, bytes);
      await repo.upsert(projectId, "assets", a);
      out.push(a);
    }
    return out;
  }

  const agentStore = new MemoryAgentStore({
    ownerOf: (id) => repo.projectOwner(id)?.userId ?? null,
    projectTitle: (id) => repo.projectOwner(id)?.title ?? null,
    userId: () => owner,
    now,
  });
  const jobs = memoryRemoteJobStore(repo, sink);
  const deps: RemoteJobDeps = {
    agent: { store: agentStore, canonicalOrigin: o.origin ?? ORIGIN, now, remoteJobs: true },
    jobs,
    available: true,
    newId: () => randomUUID(),
    log: () => undefined,
  };

  let remoteView: RemoteAgentView = READY;
  async function jobDeps(projectId: string, extra: ReconstructionProvider[] = []): Promise<JobServiceDeps> {
    const data = (await repo.loadProject(projectId === A ? seedA.project.slug : seedB.project.slug))!;
    const providers = new Map<string, ReconstructionProvider>();
    providers.set("local_agent_capture", new RemoteAgentCaptureProvider({ view: () => remoteView }));
    for (const p of extra) providers.set(p.id, p);
    return {
      repo: repo.previs,
      providers,
      config: { jobsEnabled: true, paid: { enabled: false, maxUsd: null }, pollIntervalMs: 5000 },
      projectAssets: data.assets,
      projectId,
      locationName: (id) => data.locations.find((l) => l.id === id)?.name ?? null,
      readAssetBytes: async (a) => objects.get(a.objectPath ?? "") ?? null,
      store: {
        putObject: async (p, b) => void objects.set(p, b),
        upsertAsset: (a) => repo.upsert(projectId, "assets", a),
        removeAsset: (id) => repo.remove(projectId, "assets", id),
        removeObject: async (a) => void objects.delete(a.objectPath ?? ""),
      },
      storage: { name: "local", bucket: null },
      userId: owner,
      now: () => new Date(now()).toISOString(),
      newId: () => randomUUID(),
    };
  }

  /** A queued Remote Local Agent job of `projectId` (its own images, in the given order). */
  async function remoteJob(projectId: string, images: Asset[]) {
    return createJob(await jobDeps(projectId), {
      locationId: projectId === A ? locA : locB,
      sourceAssetIds: images.map((a) => a.id),
      provider: "local_agent_capture",
      model: null,
      options: {},
    });
  }

  /** A fictional workstation paired to `projectId` and heartbeating a ready toolchain that runs remote jobs. */
  async function agent(projectId: string, caps = capabilities()) {
    const offer = await createPairingOffer(agentStore, projectId);
    const a = new TestAgent(now);
    const r = await redeemPairing(deps.agent, a.pairBody(offer.code));
    a.deviceId = r.device.id;
    await heartbeat(
      deps.agent,
      a.heartbeat(
        {},
        {
          ...caps,
          engine: { ...caps.engine, qualityProfiles: ["draft", "standard"] },
          execution: { remoteJobs: true },
        },
      ),
    );
    return a;
  }

  return {
    repo,
    A,
    B,
    locA,
    locB,
    owner,
    objects,
    sinkCalls,
    agentStore,
    deps,
    jobDeps,
    remoteJob,
    agent,
    addImages,
    setRemoteView: (v: RemoteAgentView) => void (remoteView = v),
    now,
    advance: (ms: number) => void (offset += ms),
    job: (id: string) => repo.previs.getReconstructionJob(id),
    events: (id: string) => repo.previs.listReconstructionJobEvents(id),
    assetsOf: async (projectId: string) =>
      (await repo.loadProject(projectId === A ? seedA.project.slug : seedB.project.slug))!.assets,
  };
}

/** A real, valid SPZ (64 Gaussians) and the result declaration that matches the test agent's recorded tools. */
export function spzResult(o: { inputImages?: number } = {}): { bytes: Uint8Array; result: FinalResult } {
  const bytes = encodeSpzFile(syntheticPlane({ n: 8 }));
  if (bytes.length > MAX_SPLAT_BYTES) throw new Error("fixture too large");
  const caps = capabilities();
  return {
    bytes,
    result: {
      format: "spz",
      sha256: sha(bytes),
      byteSize: bytes.length,
      gaussianCount: 64,
      shDegree: 0,
      inputImages: o.inputImages ?? 3,
      registeredImages: o.inputImages ?? 3,
      registrationRatio: 1,
      sparsePoints: 1200,
      quality: "standard",
      colmap: {
        version: caps.toolchain.colmap.version!,
        sourceCommit: caps.toolchain.colmap.fingerprint!.sourceCommit,
        binarySha256: caps.toolchain.colmap.fingerprint!.binarySha256,
      },
      brush: { version: caps.toolchain.brush.version! },
      spzEncoder: "@sparkjsdev/spark@0.1.10 SpzWriter",
      spzVersion: 3,
      lossless: false,
      clamped: { positions: 0, colors: 0, scales: 0, sh: 0 },
    },
  };
}

export { ORIGIN };
