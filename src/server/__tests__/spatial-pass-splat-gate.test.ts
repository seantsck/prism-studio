import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { assetTokenFor, buildPrevisDocument } from "@/domain/previs/document";
import { buildHotelCanopyEngineScene } from "@/domain/previs/hotel-canopy";
import {
  cameraSourceFromBookmark,
  expectedManifest,
  expectedRasterBytes,
  spatialBundleFingerprint,
  buildControlFrame,
} from "@/domain/previs/spatial-passes";
import { SPLAT_PASSES_BLOCKED_MESSAGE, SPLAT_USER_DATA, UNKNOWN_CALIBRATION } from "@/domain/previs/splat";

/**
 * The M2C server action is the authority: a VISIBLE saved Gaussian splat must refuse an exact control-pass capture even
 * when the browser (which already blocks it) is bypassed. This drives the real `captureSpatialPassBundle` with an
 * in-memory repository and a recording storage; only the framework edges (cookies, revalidation, disk) are replaced.
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
vi.mock("@/server/storage", () => ({
  checksum: (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
  getUploadStorage: async () => ({
    name: "local",
    bucket: null,
    put: async (p: string) => void world.puts.push(p),
    get: async () => null,
    signedUrl: async () => null,
    remove: async (p: string) => void world.removes.push(p),
  }),
  storageForAsset: async () => ({
    name: "local",
    bucket: null,
    put: async () => undefined,
    get: async () => null,
    signedUrl: async () => null,
    remove: async (p: string) => void world.removes.push(p),
  }),
}));

import { captureSpatialPassBundle } from "../spatial-pass-actions";

const iso = "2026-10-18T00:00:00.000Z";
const SPLAT_UUID = "00000000-0000-4000-8000-0000000051a7";
const SPLAT_ASSET = "11111111-1111-4111-8111-111111111111";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function document(visible: boolean) {
  const s = buildHotelCanopyEngineScene();
  s.scene.push({
    ...clone(s.scene[1]),
    object_uuid: SPLAT_UUID,
    object_name: "environment",
    media_file_token: assetTokenFor(SPLAT_ASSET),
    visible,
    user_data: {
      [SPLAT_USER_DATA.reconstructionId]: "recon-1",
      [SPLAT_USER_DATA.calibration]: { ...UNKNOWN_CALIBRATION },
    },
  });
  return buildPrevisDocument({ engineScene: s, assetChecksums: { [SPLAT_ASSET]: "sum" } });
}

async function setup(visible: boolean) {
  const repo = new MemoryRepository();
  world.repo = repo;
  world.puts.length = 0;
  world.removes.length = 0;
  const data = (await repo.loadProject("ojousama"))!;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  const location = data.locations.find((l) => l.id === shot.spatial.locationId) ?? data.locations[0]!;
  const scene = await repo.previs.saveScene({
    id: "scene-1",
    projectId: data.project.id,
    locationId: location.id,
    document: document(visible),
    expectedRevision: null,
    engineVersion: "t",
    userId: null,
    now: iso,
  });
  const bookmark = await repo.previs.setBookmark({
    id: "bm-1",
    projectId: data.project.id,
    shotId: shot.id,
    locationId: location.id,
    sceneDocumentId: scene.id,
    userId: null,
    now: iso,
  });
  return { repo, data, shot, location, scene, bookmark };
}

/** A request exactly as an honest-but-UI-bypassing client would build it from the saved state. */
async function request(ctx: Awaited<ReturnType<typeof setup>>) {
  const { data, shot, location, scene, bookmark } = ctx;
  const names = Object.fromEntries(data.characters.map((c) => [c.id, c.name]));
  const manifest = expectedManifest(scene.document, [], names);
  const camera = cameraSourceFromBookmark({ id: bookmark.id }, bookmark.value);
  const frame = buildControlFrame({
    shotId: shot.id,
    scene: { documentId: scene.id, revision: scene.revision, fingerprint: scene.sceneFingerprint },
    blockingFingerprint: null,
    camera,
  });
  const form = new FormData();
  form.set("projectSlug", "ojousama");
  form.set("shotId", shot.id);
  form.set("locationId", location.id);
  form.set("cameraSource", "bookmark");
  form.set("blockingFingerprint", "");
  form.set(
    "bundleFingerprint",
    spatialBundleFingerprint({
      shotId: shot.id,
      sceneFingerprint: scene.sceneFingerprint,
      blockingFingerprint: null,
      camera: frame.camera,
      width: frame.width,
      height: frame.height,
      manifest,
    }),
  );
  form.set("manifest", JSON.stringify(manifest));
  const { width, height } = frame;
  form.set("depth", new File([new Uint8Array(expectedRasterBytes.depth(width, height))], "depth.bin"));
  form.set("objectIds", new File([new Uint8Array(expectedRasterBytes.objectIds(width, height))], "ids.bin"));
  return form;
}

const counts = async (ctx: Awaited<ReturnType<typeof setup>>) => ({
  assets: (await ctx.repo.loadProject("ojousama"))!.assets.length,
  bundles: (await ctx.repo.previs.listSpatialPassBundles(ctx.shot.id)).length,
});

describe("M2C server action: a visible saved splat is refused at the server boundary", () => {
  beforeEach(() => {
    world.puts.length = 0;
  });

  it("CASE A — the saved Set has a VISIBLE splat: rejected, and nothing is written anywhere", async () => {
    const ctx = await setup(true);
    const before = await counts(ctx);
    const form = await request(ctx);
    const result = await captureSpatialPassBundle(form);
    expect(result).toEqual({ ok: false, error: SPLAT_PASSES_BLOCKED_MESSAGE });
    const after = await counts(ctx);
    expect(after.assets, "no depth / object-id / mask Asset was created").toBe(before.assets);
    expect(after.bundles, "no bundle row was created").toBe(before.bundles);
    expect(world.puts, "no Storage object was created").toEqual([]);
    expect(world.removes, "nothing needed cleaning up").toEqual([]);
  });

  it("CASE B — the same saved splat HIDDEN: the splat gate does not refuse; the capture goes through the normal validation and is stored", async () => {
    const ctx = await setup(false);
    const form = await request(ctx);
    const result = await captureSpatialPassBundle(form);
    // an all-background fixture passes every later check, so the hidden-splat capture is stored like any other
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(world.puts.length, "depth + object-id rasters were stored (no Characters, so no masks)").toBe(2);
    expect((await counts(ctx)).bundles).toBe(1);
    expect(JSON.stringify(result.bundle.objectIds.manifest)).not.toContain(SPLAT_UUID); // the splat is never a manifest entry
  });

  it("the refusal is decided by the SAVED Set, not by anything the client sent", async () => {
    const ctx = await setup(true);
    const form = await request(ctx);
    // a client that claims a manifest/camera/fingerprint of its choosing still cannot get past the saved Set
    form.set("bundleFingerprint", "f".repeat(64));
    expect(await captureSpatialPassBundle(form)).toEqual({ ok: false, error: SPLAT_PASSES_BLOCKED_MESSAGE });
    expect(world.puts).toEqual([]);
  });
});
