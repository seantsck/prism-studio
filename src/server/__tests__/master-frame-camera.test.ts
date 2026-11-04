import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { buildPrevisDocument } from "@/domain/previs/document";
import { buildHotelCanopyEngineScene } from "@/domain/previs/hotel-canopy";
import { bookmarkCameraFingerprint } from "@/domain/previs/spatial-passes";
import { PREVIS_PRODUCTION_FRAME } from "@/domain/previs/types";

/**
 * Phase 4C (P5, release-blocking): a Master Frame must be rendered with THIS Shot's production camera. The browser may
 * still hold another Shot's bookmark (the Location page Shot switcher), so the server is the authority: it reloads the
 * Shot's bookmark, derives its canonical camera fingerprint and refuses any render that claims another camera, before a
 * byte is stored. Drives the real `captureMasterFrame` with an in-memory repository and a recording storage.
 */
const world = vi.hoisted(() => ({
  repo: null as unknown,
  puts: [] as string[],
  removes: [] as string[],
}));

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
  put: async (p: string) => void world.puts.push(p),
  get: async () => null,
  signedUrl: async () => null,
  remove: async (p: string) => void world.removes.push(p),
};
vi.mock("@/server/storage", () => ({
  checksum: (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
  getUploadStorage: async () => storage,
  storageForAsset: async () => storage,
}));

import { captureMasterFrame } from "../previs-actions";

const iso = "2026-11-04T00:00:00.000Z";

function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const v = new DataView(b.buffer);
  v.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

/** The Hotel Canopy set with its production camera moved to `x`. */
function engineSceneWithCamera(x: number) {
  const s = buildHotelCanopyEngineScene() as unknown as { cameras: Array<Record<string, unknown>> };
  const cam = s.cameras.find((c) => c.id !== "main")!;
  cam.position = { ...(cam.position as object), x };
  return s;
}

async function setup() {
  const repo = new MemoryRepository();
  world.repo = repo;
  world.puts.length = 0;
  world.removes.length = 0;
  const data = (await repo.loadProject("ojousama"))!;
  const [shotA, shotB] = data.shots;
  const location = data.locations[0]!;
  // Location L, Shot A linked to camera A; then the set's camera moves and Shot B is linked to camera B
  const s1 = await repo.previs.saveScene({
    id: "scene-1",
    projectId: data.project.id,
    locationId: location.id,
    document: buildPrevisDocument({ engineScene: engineSceneWithCamera(1), assetChecksums: {} }),
    expectedRevision: null,
    engineVersion: "t",
    userId: null,
    now: iso,
  });
  const bmA = await repo.previs.setBookmark({
    id: "bm-a",
    projectId: data.project.id,
    shotId: shotA!.id,
    locationId: location.id,
    sceneDocumentId: s1.id,
    userId: null,
    now: iso,
  });
  const s2 = await repo.previs.saveScene({
    id: "scene-1",
    projectId: data.project.id,
    locationId: location.id,
    document: buildPrevisDocument({ engineScene: engineSceneWithCamera(4), assetChecksums: {} }),
    expectedRevision: s1.revision,
    engineVersion: "t",
    userId: null,
    now: iso,
  });
  const bmB = await repo.previs.setBookmark({
    id: "bm-b",
    projectId: data.project.id,
    shotId: shotB!.id,
    locationId: location.id,
    sceneDocumentId: s2.id,
    userId: null,
    now: iso,
  });
  return { repo, data, shotA: shotA!, shotB: shotB!, location, scene: s2, bmA, bmB };
}

function captureForm(
  ctx: Awaited<ReturnType<typeof setup>>,
  shotId: string,
  cameraFingerprint: string | null,
): FormData {
  const fd = new FormData();
  fd.set("projectSlug", ctx.data.project.slug);
  fd.set("shotId", shotId);
  fd.set("locationId", ctx.location.id);
  fd.set("sceneRevision", String(ctx.scene.revision));
  if (cameraFingerprint) fd.set("cameraFingerprint", cameraFingerprint);
  const bytes = png(PREVIS_PRODUCTION_FRAME.width, PREVIS_PRODUCTION_FRAME.height);
  fd.set("file", new File([bytes], "master-frame.png", { type: "image/png" }));
  return fd;
}

async function assetCount(ctx: Awaited<ReturnType<typeof setup>>) {
  return (await ctx.repo.loadProject(ctx.data.project.slug))!.assets.length;
}

describe("captureMasterFrame camera authority (P5, release-blocking)", () => {
  beforeEach(() => {
    world.puts.length = 0;
    world.removes.length = 0;
  });

  it("the two Shots really have different production cameras", async () => {
    const ctx = await setup();
    expect(bookmarkCameraFingerprint(ctx.bmA.value)).not.toBe(bookmarkCameraFingerprint(ctx.bmB.value));
  });

  it("refuses Shot A's camera rendered as Shot B: no Master Frame, no Asset, no stored object", async () => {
    const ctx = await setup();
    const assetsBefore = await assetCount(ctx);
    const r = await captureMasterFrame(captureForm(ctx, ctx.shotB.id, bookmarkCameraFingerprint(ctx.bmA.value)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/camera/i);
    expect(await ctx.repo.previs.listMasterFrames(ctx.shotB.id)).toEqual([]);
    expect(await assetCount(ctx)).toBe(assetsBefore);
    expect(world.puts).toEqual([]);
  });

  it("refuses a render that names no camera at all", async () => {
    const ctx = await setup();
    const r = await captureMasterFrame(captureForm(ctx, ctx.shotB.id, null));
    expect(r.ok).toBe(false);
    expect(await ctx.repo.previs.listMasterFrames(ctx.shotB.id)).toEqual([]);
    expect(world.puts).toEqual([]);
  });

  it("accepts Shot B's own camera and freezes the SERVER-derived camera snapshot", async () => {
    const ctx = await setup();
    const fp = bookmarkCameraFingerprint(ctx.bmB.value);
    const r = await captureMasterFrame(captureForm(ctx, ctx.shotB.id, fp));
    expect(r.ok).toBe(true);
    const [mf] = await ctx.repo.previs.listMasterFrames(ctx.shotB.id);
    expect(mf!.cameraFingerprint).toBe(fp);
    expect(mf!.camera).toMatchObject({
      schema: "prism.render-camera.v1",
      cameraFingerprint: fp,
      bookmarkId: ctx.bmB.id,
      projection: "perspective",
      focalLengthBasis: "vertical-sensor-24mm",
    });
    expect(world.puts).toHaveLength(1);
  });
});
