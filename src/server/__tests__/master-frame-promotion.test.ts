import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { buildPrevisDocument } from "@/domain/previs/document";
import { buildHotelCanopyEngineScene } from "@/domain/previs/hotel-canopy";
import {
  SHOT_LIGHTING_SCHEMA,
  authoredLightingIntent,
  newShotLight,
  parseShotLightingRig,
} from "@/domain/previs/lighting";
import { bookmarkCameraFingerprint } from "@/domain/previs/spatial-passes";
import { PREVIS_PRODUCTION_FRAME } from "@/domain/previs/types";
import { draftProductionFrame, productionFrameFreshness } from "@/domain/production-frame";

/**
 * Phase 4C-I1: safe Master Frame → Production Frame promotion, end to end through the REAL server actions
 * (`captureMasterFrame`, `promoteMasterFrame`) on the in-memory repository (which models the full 0049 schema).
 */
const world = vi.hoisted(() => ({ repo: null as unknown, puts: [] as string[] }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth", () => ({ requireUser: async () => ({ kind: "memory", id: "tester" }) }));
vi.mock("@/server/repo", () => ({
  getRepo: async () => world.repo,
  requireProjectFresh: async (slug: string) => {
    const repo = world.repo as MemoryRepository;
    const data = await repo.loadProject(slug);
    if (!data) throw new Error("no project");
    // what the real loader attaches (server/repo.ts withSpatialReferences + withProductionFrames)
    const refs = await repo.previs.listSpatialReferences(data.project.id);
    const { frames, selections } = await repo.productionFrames.listForProject(data.project.id);
    return {
      ...data,
      ...(Object.keys(refs).length ? { spatialReferences: refs } : {}),
      productionFrames: frames,
      productionFrameSelections: selections,
    };
  },
}));
vi.mock("@/server/previs", () => ({ getPrevisRepo: async () => (world.repo as MemoryRepository).previs }));
vi.mock("@/server/production-frames", () => ({
  getProductionFrameRepo: async () => (world.repo as MemoryRepository).productionFrames,
}));
const storage = {
  name: "local",
  bucket: null,
  put: async (p: string) => void world.puts.push(p),
  get: async () => null,
  signedUrl: async () => null,
  remove: async () => undefined,
};
vi.mock("@/server/storage", () => ({
  checksum: (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
  getUploadStorage: async () => storage,
  storageForAsset: async () => storage,
}));

import { captureMasterFrame } from "../previs-actions";
import { promoteMasterFrame } from "../production-frame-actions";

const iso = "2026-11-04T00:00:00.000Z";
const NOW = new Date(iso);
let pngSeq = 0;

function png(): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const v = new DataView(b.buffer);
  v.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  v.setUint32(16, PREVIS_PRODUCTION_FRAME.width);
  v.setUint32(20, PREVIS_PRODUCTION_FRAME.height);
  v.setUint32(40, ++pngSeq); // distinct bytes → distinct checksum per capture
  return b;
}

function engineScene(cameraX: number) {
  const s = buildHotelCanopyEngineScene() as unknown as { cameras: Array<Record<string, unknown>> };
  const cam = s.cameras.find((c) => c.id !== "main")!;
  cam.position = { ...(cam.position as object), x: cameraX };
  return s;
}

async function setup() {
  const repo = new MemoryRepository();
  world.repo = repo;
  world.puts.length = 0;
  const data = (await repo.loadProject("ojousama"))!;
  const shot = data.shots.find((s) => s.shotCode === "2A")!;
  const location = data.locations.find((l) => l.id === shot.spatial.locationId)!;
  const project = data.project;
  let scene = await repo.previs.saveScene({
    id: "scene-1",
    projectId: project.id,
    locationId: location.id,
    document: buildPrevisDocument({ engineScene: engineScene(1) }),
    expectedRevision: null,
    engineVersion: "t",
    userId: null,
    now: iso,
  });
  const link = async () =>
    repo.previs.setBookmark({
      id: "bm-1",
      projectId: project.id,
      shotId: shot.id,
      locationId: location.id,
      sceneDocumentId: scene.id,
      userId: null,
      now: iso,
    });
  await link();

  /** moves the set's production camera and re-links the Shot (the Shot's camera changes) */
  const moveCamera = async (x: number) => {
    scene = await repo.previs.saveScene({
      id: "scene-1",
      projectId: project.id,
      locationId: location.id,
      document: buildPrevisDocument({ engineScene: engineScene(x) }),
      expectedRevision: scene.revision,
      engineVersion: "t",
      userId: null,
      now: iso,
    });
    await link();
  };
  const rigOf = (intensity: number) =>
    parseShotLightingRig({
      schema: SHOT_LIGHTING_SCHEMA,
      base: { mode: "replace" },
      lights: [{ ...newShotLight("point", "key"), intensity }],
      authoredIntent: authoredLightingIntent(shot),
    });
  const light = async (intensity: number) => {
    const cur = await repo.previs.getLightingRigForShot(shot.id);
    return repo.previs.saveLightingRig({
      id: "rig-1",
      projectId: project.id,
      shotId: shot.id,
      locationId: location.id,
      sceneDocumentId: scene.id,
      sceneRevision: scene.revision,
      sceneFingerprint: scene.sceneFingerprint,
      rig: rigOf(intensity),
      expectedRevision: cur?.revision ?? null,
      userId: null,
      now: iso,
    });
  };

  /** an honest capture of the Shot's current camera, set and lighting */
  const capture = async () => {
    const bm = (await repo.previs.getBookmarkForShot(shot.id))!;
    const rig = await repo.previs.getLightingRigForShot(shot.id);
    const fd = new FormData();
    fd.set("projectSlug", project.slug);
    fd.set("shotId", shot.id);
    fd.set("locationId", location.id);
    fd.set("sceneRevision", String(scene.revision));
    fd.set("cameraFingerprint", bookmarkCameraFingerprint(bm.value));
    if (rig) fd.set("lightingFingerprint", rig.lightingFingerprint);
    fd.set("file", new File([png()], "master-frame.png", { type: "image/png" }));
    const r = await captureMasterFrame(fd);
    if (!r.ok) throw new Error(r.error);
    return (await repo.previs.getMasterFrame(r.masterFrameId))!;
  };

  const promote = (masterFrameId: string, digest?: string) => {
    const fd = new FormData();
    fd.set("projectSlug", project.slug);
    fd.set("shotId", shot.id);
    fd.set("masterFrameId", masterFrameId);
    if (digest) fd.set("confirmDigest", digest);
    return promoteMasterFrame(fd);
  };
  const frames = async () =>
    (await repo.productionFrames.listForProject(project.id)).frames.filter((f) => f.shotId === shot.id);
  const selectedId = () => repo.productionFrames.selectedFrameId(project.id, shot.id);
  /** exactly what the server's loader hands an action (spatial references + Production Frames attached) */
  const loaded = async () => {
    const d = (await repo.loadProject(project.slug))!;
    const refs = await repo.previs.listSpatialReferences(d.project.id);
    const { frames: pfs, selections } = await repo.productionFrames.listForProject(d.project.id);
    return {
      ...d,
      ...(Object.keys(refs).length ? { spatialReferences: refs } : {}),
      productionFrames: pfs,
      productionFrameSelections: selections,
    };
  };
  const pkg = async () => assembleGenerationPackage(buildShotContext(await loaded(), shot.id), NOW);
  return {
    repo,
    project,
    shot,
    location,
    scene: () => scene,
    moveCamera,
    light,
    capture,
    promote,
    frames,
    selectedId,
    pkg,
    loaded,
  };
}

type World = Awaited<ReturnType<typeof setup>>;

/** a pre-4C Master Frame (no camera provenance), with its stored image Asset */
async function historicalMasterFrame(w: World) {
  const fresh = await w.capture();
  const id = "mf-historical";
  await w.repo.previs.recordMasterFrame({
    id,
    projectId: w.project.id,
    shotId: w.shot.id,
    locationId: w.location.id,
    sceneDocumentId: fresh.sceneDocumentId,
    sceneRevision: fresh.sceneRevision,
    sceneFingerprint: fresh.sceneFingerprint,
    cameraBookmarkId: fresh.cameraBookmarkId,
    assetId: fresh.assetId,
    renderWidth: fresh.renderWidth,
    renderHeight: fresh.renderHeight,
    productionAspectRatio: fresh.productionAspectRatio,
    capturedAt: "2026-01-01T00:00:00.000Z",
    blockingFingerprint: fresh.blockingFingerprint,
    blocking: fresh.blocking,
    lightingFingerprint: fresh.lightingFingerprint,
    lighting: fresh.lighting,
    userId: null,
  });
  return (await w.repo.previs.getMasterFrame(id))!;
}

const confirmationOf = (r: Awaited<ReturnType<typeof promoteMasterFrame>>) => {
  if (r.ok || !r.confirmationRequired || !r.confirmation)
    throw new Error(`expected a confirmation, got ${JSON.stringify(r)}`);
  return r.confirmation;
};

describe("Master Frame promotion (Phase 4C-I1)", () => {
  beforeEach(() => {
    world.puts.length = 0;
  });

  it("a fresh Master Frame promotes without confirmation and freezes its own four fingerprints", async () => {
    const w = await setup();
    await w.light(10);
    const mf = await w.capture();
    const r = await w.promote(mf.id);
    expect(r.ok).toBe(true);
    const [pf] = await w.frames();
    expect(pf!.sourceMasterFrameId).toBe(mf.id);
    expect(pf!.sourceSceneFingerprint).toBe(mf.sceneFingerprint);
    expect(pf!.sourceCameraFingerprint).toBe(mf.cameraFingerprint);
    expect(pf!.sourceCameraFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(pf!.sourceBlockingFingerprint).toBe(mf.blockingFingerprint);
    expect(pf!.sourceLightingFingerprint).toBe(mf.lightingFingerprint);
    expect(w.selectedId()).toBe(pf!.id);
    expect(JSON.stringify(pf)).not.toMatch(/stale|unknown|promotedFresh/i);
    const p = await w.pkg();
    expect(p.references.productionFrame!.sourceSpatial).toEqual({
      schemaVersion: 1,
      masterFrameId: mf.id,
      sceneFingerprint: mf.sceneFingerprint,
      cameraFingerprint: mf.cameraFingerprint,
      blockingFingerprint: mf.blockingFingerprint,
      lightingFingerprint: mf.lightingFingerprint,
    });
  });

  it("fresh → stale camera: confirmation required, nothing created; the confirmed digest promotes", async () => {
    const w = await setup();
    const mf = await w.capture();
    await w.moveCamera(7);
    const c = confirmationOf(await w.promote(mf.id));
    expect(c.stale).toEqual(["scene", "camera"]);
    expect(c.unknown).toEqual([]);
    expect(c.changed).toBe(false);
    expect(c.messages.join(" ")).toContain("STALE CAMERA");
    expect(await w.frames()).toEqual([]);
    expect(w.selectedId()).toBeNull();
    const ok = await w.promote(mf.id, c.digest);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.message).toMatch(/Used anyway/);
    expect(await w.frames()).toHaveLength(1);
  });

  it("unknown camera (historical frame) needs confirmation and is reported separately from stale", async () => {
    const w = await setup();
    const mf = await historicalMasterFrame(w);
    expect(mf.cameraFingerprint).toBeNull();
    const c = confirmationOf(await w.promote(mf.id));
    expect(c.unknown).toEqual(["camera"]);
    expect(c.stale).toEqual([]);
    expect(c.messages.join(" ")).toContain("UNKNOWN CAMERA PROVENANCE");
    expect(await w.frames()).toEqual([]);
    expect((await w.promote(mf.id, c.digest)).ok).toBe(true);
    const [pf] = await w.frames();
    // frozen, with the camera axis legitimately null (the source never recorded one)
    expect(pf!.sourceSceneFingerprint).toBe(mf.sceneFingerprint);
    expect(pf!.sourceCameraFingerprint).toBeNull();
  });

  it("TOCTOU: an old digest after a lighting change creates and selects NOTHING and asks again", async () => {
    const w = await setup();
    const mf = await w.capture();
    // something already selected, to prove the selection is unchanged
    const other = await w.capture();
    expect((await w.promote(other.id)).ok).toBe(true);
    const selectedBefore = w.selectedId();
    const framesBefore = (await w.frames()).length;
    await w.moveCamera(9);
    const first = confirmationOf(await w.promote(mf.id));
    await w.light(55); // the setup changes after the person saw the confirmation
    const second = confirmationOf(await w.promote(mf.id, first.digest));
    expect(second.changed).toBe(true);
    expect(second.digest).not.toBe(first.digest);
    expect(second.stale).toContain("lighting");
    expect((await w.frames()).length).toBe(framesBefore);
    expect(w.selectedId()).toBe(selectedBefore);
    // the fresh digest works
    expect((await w.promote(mf.id, second.digest)).ok).toBe(true);
  });

  it("a forged digest is refused even when the frame is fresh; the browser's stale/unknown view is never read", async () => {
    const w = await setup();
    const mf = await w.capture();
    const fd = new FormData();
    fd.set("projectSlug", w.project.slug);
    fd.set("shotId", w.shot.id);
    fd.set("masterFrameId", mf.id);
    fd.set("confirmDigest", "0".repeat(64));
    fd.set("stale", "[]");
    fd.set("unknown", "[]");
    const r = await promoteMasterFrame(fd);
    expect(confirmationOf(r).changed).toBe(true);
    expect(await w.frames()).toEqual([]);
  });

  it("exact source: promoting older A after newer B freezes A's fingerprints, never B's", async () => {
    const w = await setup();
    await w.light(10);
    const a = await w.capture();
    await w.moveCamera(3);
    await w.light(20);
    const b = await w.capture();
    expect(a.cameraFingerprint).not.toBe(b.cameraFingerprint);
    const c = confirmationOf(await w.promote(a.id));
    expect((await w.promote(a.id, c.digest)).ok).toBe(true);
    const [pf] = await w.frames();
    expect(pf!.sourceMasterFrameId).toBe(a.id);
    expect([pf!.sourceSceneFingerprint, pf!.sourceCameraFingerprint, pf!.sourceLightingFingerprint]).toEqual([
      a.sceneFingerprint,
      a.cameraFingerprint,
      a.lightingFingerprint,
    ]);
    expect(pf!.sourceCameraFingerprint).not.toBe(b.cameraFingerprint);
    expect(pf!.sourceLightingFingerprint).not.toBe(b.lightingFingerprint);
  });

  it("dedup Case A: fresh first, stale + confirmed later → the same immutable frame, intrinsic A lineage", async () => {
    const w = await setup();
    await w.light(10);
    const a = await w.capture();
    expect((await w.promote(a.id)).ok).toBe(true);
    const [first] = await w.frames();
    await w.light(20); // lighting is not visual intent: the frame identity is unchanged
    const c = confirmationOf(await w.promote(a.id));
    const again = await w.promote(a.id, c.digest);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.message).toMatch(/already exists/);
    const all = await w.frames();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(first);
    expect(all[0]!.sourceCameraFingerprint).toBe(a.cameraFingerprint);
    expect(all[0]!.sourceLightingFingerprint).toBe(a.lightingFingerprint);
  });

  it("dedup Case B: stale + confirmed first, fresh later → the same frame; no field records either attempt", async () => {
    const w = await setup();
    await w.light(10);
    const a = await w.capture();
    await w.light(20);
    const c = confirmationOf(await w.promote(a.id));
    expect(c.stale).toEqual(["lighting"]);
    expect((await w.promote(a.id, c.digest)).ok).toBe(true);
    const [first] = await w.frames();
    await w.light(10); // back to the lighting A was rendered with: A is fresh again
    const again = await w.promote(a.id);
    expect(again.ok).toBe(true);
    const all = await w.frames();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(first);
    expect(JSON.stringify(all[0])).not.toMatch(/stale|unknown|confirm/i);
  });

  it("a scene edit between promotions is new visual intent (2G.1 rule): a new version, the identical A lineage", async () => {
    const w = await setup();
    const a = await w.capture();
    expect((await w.promote(a.id)).ok).toBe(true);
    await w.moveCamera(5); // the Shot's intent snapshot freezes the set fingerprint, so this is a different intent
    const c = confirmationOf(await w.promote(a.id));
    const r = await w.promote(a.id, c.digest);
    expect(r.ok).toBe(true);
    const all = await w.frames();
    expect(all.map((f) => f.version).sort()).toEqual([1, 2]);
    const lineage = (f: (typeof all)[number]) => [
      f.sourceMasterFrameId,
      f.sourceSceneFingerprint,
      f.sourceCameraFingerprint,
      f.sourceBlockingFingerprint,
      f.sourceLightingFingerprint,
    ];
    expect(lineage(all[0]!)).toEqual(lineage(all[1]!));
    expect(all[0]!.frameFingerprint).not.toBe(all[1]!.frameFingerprint);
    for (const f of all) expect(JSON.stringify(f)).not.toMatch(/stale|unknown|confirm|promotedFresh/i);
  });

  it("a pre-4C duplicate is reselected untouched: its source provenance stays null", async () => {
    const w = await setup();
    const a = await w.capture();
    // a Production Frame of A made before 4C (no source provenance)
    const data = await w.loaded();
    const ctx = buildShotContext(data, w.shot.id);
    const drafted = draftProductionFrame(ctx, {
      id: "pf-historical",
      now: iso,
      userId: null,
      source: "previs_master",
      sourceMasterFrameId: a.id,
      asset: ctx.assets.get(a.assetId)!,
    });
    if (!drafted.ok) throw new Error(drafted.problem.message);
    await w.repo.productionFrames.create({
      draft: drafted.draft,
      newAsset: null,
      select: false,
      userId: null,
      now: iso,
    });
    const r = await w.promote(a.id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toMatch(/already exists/);
    const all = await w.frames();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe("pf-historical");
    expect(all[0]!.sourceSceneFingerprint).toBeNull();
    expect(w.selectedId()).toBe("pf-historical");
    expect("sourceSpatial" in (await w.pkg()).references.productionFrame!).toBe(false);
  });

  it("source deletion: the 4C frame keeps its id, fingerprints, package sourceSpatial and P3 lighting", async () => {
    const w = await setup();
    await w.light(10);
    const a = await w.capture();
    expect((await w.promote(a.id)).ok).toBe(true);
    const [before] = await w.frames();
    const pkgBefore = await w.pkg();
    w.repo.previs.deleteMasterFrame(a.id);
    expect(await w.repo.previs.getMasterFrame(a.id)).toBeNull();
    const [after] = await w.frames();
    expect(after).toEqual(before);
    expect(after!.sourceMasterFrameId).toBe(a.id);
    const pkgAfter = await w.pkg();
    expect(pkgAfter.references.productionFrame!.sourceSpatial).toEqual(
      pkgBefore.references.productionFrame!.sourceSpatial,
    );
    expect(pkgAfter.spatialReference!.shotLighting!.productionFrameLightingFingerprint).toBe(
      a.lightingFingerprint,
    );
  });

  it("P3: a historical frame whose source row is gone falls to null; it is never the current rig", async () => {
    const w = await setup();
    await w.light(10);
    const a = await w.capture();
    const data = await w.loaded();
    const ctx = buildShotContext(data, w.shot.id);
    const drafted = draftProductionFrame(ctx, {
      id: "pf-old",
      now: iso,
      userId: null,
      source: "previs_master",
      sourceMasterFrameId: a.id,
      asset: ctx.assets.get(a.assetId)!,
    });
    if (!drafted.ok) throw new Error(drafted.problem.message);
    await w.repo.productionFrames.create({
      draft: drafted.draft,
      newAsset: null,
      select: true,
      userId: null,
      now: iso,
    });
    // through the 4B chain while the source exists
    expect((await w.pkg()).spatialReference!.shotLighting!.productionFrameLightingFingerprint).toBe(
      a.lightingFingerprint,
    );
    w.repo.previs.deleteMasterFrame(a.id);
    const ref = (await w.pkg()).spatialReference!.shotLighting!;
    expect(ref.productionFrameLightingFingerprint).toBeNull();
    expect(ref.lightingFingerprint).toBe(a.lightingFingerprint); // the current rig exists; it is not used
  });

  it("package: sourceSpatial (what made the image) may differ from spatialReference (the setup now)", async () => {
    const w = await setup();
    const a = await w.capture();
    expect((await w.promote(a.id)).ok).toBe(true);
    await w.moveCamera(6);
    const p = await w.pkg();
    const src = p.references.productionFrame!.sourceSpatial!;
    expect(src.sceneFingerprint).not.toBe(p.spatialReference!.sceneFingerprint);
    expect(src.cameraFingerprint).toBe(a.cameraFingerprint);
    // neither is corrupt: the package assembles and keeps both
    expect(p.spatialReference!.sceneFingerprint).toBe(w.scene().sceneFingerprint);
  });

  it("3D edits never stale an approved Production Frame (freshness is visual intent only)", async () => {
    const w = await setup();
    const a = await w.capture();
    expect((await w.promote(a.id)).ok).toBe(true);
    await w.moveCamera(8);
    await w.light(77);
    const data = await w.loaded();
    const ctx = buildShotContext(data, w.shot.id);
    expect(productionFrameFreshness(ctx, ctx.selectedProductionFrame).status).toBe("fresh");
    expect((await w.pkg()).references.productionFrame!.freshness).toBe("fresh");
  });

  it("memory mirrors the exact-source trigger: mismatched or orphaned provenance is refused", async () => {
    const w = await setup();
    const a = await w.capture();
    const data = await w.loaded();
    const ctx = buildShotContext(data, w.shot.id);
    const draft = (spatial: Parameters<typeof draftProductionFrame>[1]["sourceSpatial"], id = "pf-x") => {
      const d = draftProductionFrame(ctx, {
        id,
        now: iso,
        userId: null,
        source: "previs_master",
        sourceMasterFrameId: a.id,
        sourceSpatial: spatial,
        asset: ctx.assets.get(a.assetId)!,
      });
      if (!d.ok) throw new Error(d.problem.message);
      return w.repo.productionFrames.create({
        draft: d.draft,
        newAsset: null,
        select: false,
        userId: null,
        now: iso,
      });
    };
    const exact = {
      sceneFingerprint: a.sceneFingerprint,
      cameraFingerprint: a.cameraFingerprint,
      blockingFingerprint: a.blockingFingerprint,
      lightingFingerprint: a.lightingFingerprint,
    };
    await expect(draft({ ...exact, sceneFingerprint: "1".repeat(64) })).rejects.toThrow(/does not match/);
    await expect(draft({ ...exact, cameraFingerprint: "2".repeat(64) })).rejects.toThrow(/does not match/);
    await expect(draft({ ...exact, cameraFingerprint: null })).rejects.toThrow(/does not match/);
    await expect(draft({ ...exact, lightingFingerprint: "3".repeat(64) })).rejects.toThrow(/does not match/);
    await expect(draft({ ...exact, blockingFingerprint: "4".repeat(64) })).rejects.toThrow(/does not match/);
    w.repo.previs.deleteMasterFrame(a.id);
    await expect(draft(exact)).rejects.toThrow(/does not exist/);
    // a non-3D source cannot carry spatial provenance at all
    const up = draftProductionFrame(ctx, {
      id: "pf-u",
      now: iso,
      userId: null,
      source: "storyboard",
      sourceStoryboardFrameId: "sb",
      sourceSpatial: exact,
      asset: ctx.assets.get(a.assetId)!,
    });
    expect(up.ok).toBe(false);
  });
});
