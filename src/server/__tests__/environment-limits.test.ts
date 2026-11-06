import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { assetTokenFor } from "@/domain/previs/document";
import { buildHotelCanopyEngineScene } from "@/domain/previs/hotel-canopy";
import {
  manualCalibration,
  SPLAT_FORMAT_INFO,
  SPLAT_USER_DATA,
  UNKNOWN_CALIBRATION,
  type SplatCalibration,
} from "@/domain/previs/splat";
import { assetSchema } from "@/domain/schemas";

/**
 * Phase 4E: the real `saveLocationScene` enforces the environment limits on the server (the browser's pre-check is a
 * convenience only). A refused save writes nothing: no new revision, the stored document unchanged. Authorization and
 * ownership refusals come first, so a limit can never be used to learn about a Project or reconstruction.
 */
const world = vi.hoisted(() => ({ repo: null as unknown }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth", () => ({ requireUser: async () => ({ kind: "memory", id: "tester" }) }));
vi.mock("@/server/repo", async () => {
  const { UserFacingError } = await import("@/server/action-result");
  return {
    getRepo: async () => world.repo,
    requireProjectFresh: async (slug: string) => {
      const data = await (world.repo as MemoryRepository).loadProject(slug);
      if (!data) throw new UserFacingError("That project no longer exists.");
      return data;
    },
  };
});
vi.mock("@/server/previs", () => ({ getPrevisRepo: async () => (world.repo as MemoryRepository).previs }));
vi.mock("@/server/storage", () => ({
  checksum: () => "sum",
  getUploadStorage: async () => {
    throw new Error("a scene save never touches storage");
  },
  storageForAsset: async () => null,
}));

import { saveLocationScene } from "../previs-actions";

const iso = "2026-11-06T00:00:00.000Z";
const SPLAT_UUID = "00000000-0000-4000-8000-0000000051a7";
const SPLAT_ASSET = "11111111-1111-4111-8111-111111111111";
const FOREIGN_ASSET = "22222222-2222-4222-8222-222222222222";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

let repo: MemoryRepository;
let locationId: string;
let reconstructionId: string;

beforeEach(async () => {
  repo = new MemoryRepository();
  world.repo = repo;
  const data = (await repo.loadProject("ojousama"))!;
  locationId = data.locations[0]!.id;
  const asset = assetSchema.parse({
    id: SPLAT_ASSET,
    projectId: data.project.id,
    createdBy: null,
    type: "3d",
    purpose: "spatial_reconstruction",
    source: "import",
    name: "env",
    originalFilename: "env.splat",
    storageProvider: "local",
    bucket: null,
    objectPath: `x/${SPLAT_ASSET}.splat`,
    mime: SPLAT_FORMAT_INFO.splat.mime,
    byteSize: 32,
    checksum: "sum",
    width: null,
    height: null,
    durationMs: null,
    frameRate: null,
    sampleRate: null,
    channels: null,
    tags: ["gaussian_splat", "splat"],
    notes: "",
    metadata: {},
    createdAt: iso,
    updatedAt: iso,
  });
  await repo.upsert(data.project.id, "assets", asset);
  const rec = await repo.previs.recordReconstruction({
    id: "recon-4e",
    projectId: data.project.id,
    locationId,
    method: "imported",
    resultKind: "gaussian_splat",
    resultAssetId: SPLAT_ASSET,
    resultChecksum: "sum",
    resultFormat: "splat",
    gaussianCount: 1,
    sources: [],
    calibration: { ...UNKNOWN_CALIBRATION },
    userId: null,
    now: iso,
  });
  reconstructionId = rec.id;
});

function scene(opts: { scale?: unknown; calibration?: SplatCalibration; asset?: string } = {}) {
  const s = buildHotelCanopyEngineScene();
  s.scene.push({
    ...clone(s.scene[1]),
    object_uuid: SPLAT_UUID,
    object_name: "environment",
    media_file_token: assetTokenFor(opts.asset ?? SPLAT_ASSET),
    visible: true,
    ...(opts.scale !== undefined ? { scale: opts.scale } : {}),
    user_data: {
      [SPLAT_USER_DATA.reconstructionId]: reconstructionId,
      [SPLAT_USER_DATA.calibration]: opts.calibration ?? { ...UNKNOWN_CALIBRATION },
    },
  } as never);
  return s;
}

function form(sceneJson: string, expectedRevision: number | null, slug = "ojousama") {
  const f = new FormData();
  f.set("projectSlug", slug);
  f.set("locationId", locationId);
  f.set("expectedRevision", expectedRevision === null ? "" : String(expectedRevision));
  f.set("sceneJson", sceneJson);
  return f;
}
const save = (s: unknown, rev: number | null = null, slug?: string) =>
  saveLocationScene(form(JSON.stringify(s), rev, slug));

describe("4E environment limits on saveLocationScene", () => {
  it("a splat within its limits saves (unknown units, and a manual calibration the transform honours)", async () => {
    expect(await save(scene())).toMatchObject({ ok: true, revision: 1 });
    const r = await save(
      scene({ scale: { x: 0.5, y: 0.5, z: 0.5 }, calibration: manualCalibration(0.5) }),
      1,
    );
    expect(r).toMatchObject({ ok: true, revision: 2 });
  });

  it("a stale calibration is refused and nothing is written", async () => {
    const first = await save(
      scene({ scale: { x: 0.5, y: 0.5, z: 0.5 }, calibration: manualCalibration(0.5) }),
    );
    expect(first.ok).toBe(true);
    const before = await repo.previs.getSceneForLocation(locationId);
    const r = await save(
      scene({ scale: { x: 0.8, y: 0.8, z: 0.8 }, calibration: manualCalibration(0.5) }),
      1,
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("scaled after its calibration");
    const after = await repo.previs.getSceneForLocation(locationId);
    expect(after?.revision).toBe(1);
    expect(after?.sceneFingerprint).toBe(before?.sceneFingerprint);
  });

  it("a collapsed scale is refused before the first save (no Set is created)", async () => {
    const r = await save(scene({ scale: { x: 1, y: 0, z: 1 } }));
    expect(r).toEqual({ ok: false, error: expect.stringContaining("zero scale") });
    expect(await repo.previs.getSceneForLocation(locationId)).toBeNull();
  });

  it("an out-of-range number on the wire (1e999 parses to Infinity) is refused, never coerced to 0", async () => {
    const json = JSON.stringify(scene({ scale: { x: 7.123456789, y: 1, z: 1 } })).replace(
      '"x":7.123456789',
      '"x":1e999',
    );
    expect(json).toContain("1e999");
    const r = await saveLocationScene(form(json, null));
    expect(r).toEqual({ ok: false, error: expect.stringContaining("not a finite number") });
    expect(await repo.previs.getSceneForLocation(locationId)).toBeNull();
  });

  it("ownership refusals come first: a foreign asset or an unknown Project never reaches the limits", async () => {
    const collapsed = { x: 0, y: 0, z: 0 };
    expect(await save(scene({ asset: FOREIGN_ASSET, scale: collapsed }))).toEqual({
      ok: false,
      error: "The 3D set references an asset that is not in this project.",
    });
    expect(await save(scene({ scale: collapsed }), null, "no-such-project")).toEqual({
      ok: false,
      error: "That project no longer exists.",
    });
  });

  it("a Set without a splat is untouched by 4E (a degenerate primitive still saves as before)", async () => {
    const s = buildHotelCanopyEngineScene();
    (s.scene[1] as unknown as Record<string, unknown>).scale = { x: 0, y: 1, z: 1 };
    expect(await save(s)).toMatchObject({ ok: true, revision: 1 });
  });
});
