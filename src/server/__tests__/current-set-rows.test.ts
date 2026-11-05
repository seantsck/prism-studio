import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { newBlockingEntry } from "@/domain/previs/blocking";
import { emptyCameraPath, keyframeFromCamera, upsertKeyframe } from "@/domain/previs/camera-path";
import { buildPrevisDocument } from "@/domain/previs/document";
import { buildHotelCanopyEngineScene } from "@/domain/previs/hotel-canopy";
import { bookmarkCameraFingerprint } from "@/domain/previs/spatial-passes";
import { PREVIS_PRODUCTION_FRAME } from "@/domain/previs/types";
import { shotSchema } from "@/domain/schemas";

/**
 * Phase 4C-I2 (narrow I1 fix): after A -> B reassignment, Shot-owned rows authored on A's set are HISTORY. They are not
 * rendered, fingerprinted or compared as the Shot's working state on B, and a first save on B replaces them instead
 * of failing compare-and-set. Exercised through the REAL server actions on the in-memory repository.
 */
const world = vi.hoisted(() => ({ repo: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth", () => ({ requireUser: async () => ({ kind: "memory", id: "tester" }) }));
vi.mock("@/server/repo", () => ({
  getRepo: async () => world.repo,
  requireProjectFresh: async (slug: string) => {
    const data = await (world.repo as MemoryRepository).loadProject(slug);
    if (!data) throw new Error("no project");
    return data;
  },
}));
vi.mock("@/server/previs", () => ({ getPrevisRepo: async () => (world.repo as MemoryRepository).previs }));
const storage = {
  name: "local",
  bucket: null,
  put: async () => undefined,
  get: async () => null,
  signedUrl: async () => null,
  remove: async () => undefined,
};
vi.mock("@/server/storage", () => ({
  checksum: (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
  getUploadStorage: async () => storage,
  storageForAsset: async () => storage,
}));

import { captureMasterFrame, saveShotBlocking, saveShotCameraPath } from "../previs-actions";
import { currentSpatialStateFor, promotionStateFor } from "../master-frame-promotion";

const iso = "2026-11-04T00:00:00.000Z";

function png(): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const v = new DataView(b.buffer);
  v.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  v.setUint32(16, PREVIS_PRODUCTION_FRAME.width);
  v.setUint32(20, PREVIS_PRODUCTION_FRAME.height);
  return b;
}

const cam = (x: number) => ({
  position: { x, y: 1.6, z: 6 },
  rotation: { x: 0, y: 0, z: 0 },
  focalLengthMm: 35,
});
const path = () => {
  let p = emptyCameraPath(2000, 24);
  p = upsertKeyframe(p, keyframeFromCamera("k1", 0, cam(0), "linear"));
  p = upsertKeyframe(p, keyframeFromCamera("k2", 2000, cam(1), "linear"));
  return p;
};

async function setup() {
  const repo = new MemoryRepository();
  world.repo = repo;
  const data = (await repo.loadProject("ojousama"))!;
  const shot = data.shots.find((s) => s.spatial.locationId)!;
  const A = shot.spatial.locationId!;
  const B = data.locations.find((l) => l.id !== A)!.id;
  const character = data.characters[0]!;
  const project = data.project;
  const saveScene = (locationId: string) =>
    repo.previs.saveScene({
      id: `scene-${locationId}`,
      projectId: project.id,
      locationId,
      document: buildPrevisDocument({ engineScene: buildHotelCanopyEngineScene() }),
      expectedRevision: null,
      engineVersion: "t",
      userId: null,
      now: iso,
    });
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    fd.set("projectSlug", project.slug);
    fd.set("shotId", shot.id);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };
  const blockingSave = (locationId: string, x: number, expectedRevision: number | null) =>
    saveShotBlocking(
      form({
        locationId,
        blockingJson: JSON.stringify({
          save: [{ entry: newBlockingEntry(character.id, { x, y: 0, z: 0 }), expectedRevision }],
          remove: [],
        }),
      }),
    );
  const pathSave = (locationId: string, expectedRevision: number | null) =>
    saveShotCameraPath(
      form({
        locationId,
        expectedRevision: expectedRevision === null ? "" : String(expectedRevision),
        pathJson: JSON.stringify(path()),
      }),
    );
  const reassign = async (locationId: string) => {
    const now = (await repo.loadProject(project.slug))!.shots.find((s) => s.id === shot.id)!;
    await repo.upsert(
      project.id,
      "shots",
      shotSchema.parse({ ...now, spatial: { ...now.spatial, locationId }, updatedAt: iso }),
    );
  };
  return { repo, project, shot, A, B, character, saveScene, blockingSave, pathSave, reassign, form };
}

describe("Phase 4C-I2: Shot-owned rows on another Location's set are history", () => {
  let w: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    w = await setup();
    await w.saveScene(w.A);
    const r1 = await w.blockingSave(w.A, 1, null);
    expect(r1.ok).toBe(true);
    const r2 = await w.pathSave(w.A, null);
    expect(r2.ok).toBe(true);
    await w.reassign(w.B);
    await w.saveScene(w.B);
  });

  it("the CURRENT blocking on B excludes the row authored on A (promotion state)", async () => {
    const sceneB = (await w.repo.previs.getSceneForLocation(w.B))!;
    const st = await currentSpatialStateFor(w.repo.previs, { shotId: w.shot.id, locationId: w.B });
    expect(st.sceneFingerprint).toBe(sceneB.sceneFingerprint);
    expect(st.blockingFingerprint).toBeNull(); // before I2 the A row was re-anchored at B and counted
    // the A row is kept as history, not deleted
    expect((await w.repo.previs.listShotBlocking(w.shot.id)).map((r) => r.locationId)).toEqual([w.A]);
  });

  it("a capture on B is not refused because of a blocking row left on A", async () => {
    const sceneB = (await w.repo.previs.getSceneForLocation(w.B))!;
    const bm = await w.repo.previs.setBookmark({
      id: "bm-b",
      projectId: w.project.id,
      shotId: w.shot.id,
      locationId: w.B,
      sceneDocumentId: sceneB.id,
      userId: null,
      now: iso,
    });
    const fd = w.form({
      locationId: w.B,
      sceneRevision: String(sceneB.revision),
      cameraFingerprint: bookmarkCameraFingerprint(bm.value),
    });
    fd.set("file", new File([png()], "master-frame.png", { type: "image/png" }));
    const r = await captureMasterFrame(fd);
    expect(r.ok).toBe(true);
    const mf = (await w.repo.previs.listMasterFrames(w.shot.id))[0]!;
    expect(mf.locationId).toBe(w.B);
    expect(mf.blockingFingerprint).toBeNull();
  });

  it("the first blocking save on B replaces the A row (no false conflict); strict CAS on B afterwards", async () => {
    const r = await w.blockingSave(w.B, 2, null);
    expect(r.ok).toBe(true);
    const rows = await w.repo.previs.listShotBlocking(w.shot.id);
    const sceneB = (await w.repo.previs.getSceneForLocation(w.B))!;
    expect(rows.map((x) => [x.locationId, x.sceneDocumentId])).toEqual([[w.B, sceneB.id]]);
    // a second editor that also believes there is no row on B is refused, as before
    const again = await w.blockingSave(w.B, 3, null);
    expect(again.ok).toBe(false);
  });

  it("the first camera-path save on B replaces the A path (no false conflict); strict CAS on B afterwards", async () => {
    const r = await w.pathSave(w.B, null);
    expect(r.ok).toBe(true);
    const sceneB = (await w.repo.previs.getSceneForLocation(w.B))!;
    expect((await w.repo.previs.getCameraPathForShot(w.shot.id))!.sceneDocumentId).toBe(sceneB.id);
    expect((await w.pathSave(w.B, null)).ok).toBe(false);
  });
});

describe("Phase 4C-I2: a Master Frame from another Location's set is never scene-fresh", () => {
  it("even when the new Location's set has the identical content fingerprint", async () => {
    const w = await setup();
    const sceneA = await w.saveScene(w.A);
    const bm = await w.repo.previs.setBookmark({
      id: "bm-a",
      projectId: w.project.id,
      shotId: w.shot.id,
      locationId: w.A,
      sceneDocumentId: sceneA.id,
      userId: null,
      now: iso,
    });
    const fd = w.form({
      locationId: w.A,
      sceneRevision: String(sceneA.revision),
      cameraFingerprint: bookmarkCameraFingerprint(bm.value),
    });
    fd.set("file", new File([png()], "master-frame.png", { type: "image/png" }));
    expect((await captureMasterFrame(fd)).ok).toBe(true);
    const mf = (await w.repo.previs.listMasterFrames(w.shot.id))[0]!;
    await w.reassign(w.B);
    const sceneB = await w.saveScene(w.B); // the SAME engine scene: the same content fingerprint
    expect(sceneB.sceneFingerprint).toBe(sceneA.sceneFingerprint);
    const st = await promotionStateFor(w.repo.previs, mf, { shotId: w.shot.id, locationId: w.B });
    expect(st.stale).toContain("scene");
    expect(st.requiresConfirmation).toBe(true);
    // and on its own set it is still fresh on the scene axis
    const back = await promotionStateFor(w.repo.previs, mf, { shotId: w.shot.id, locationId: w.A });
    expect(back.stale).not.toContain("scene");
  });
});
