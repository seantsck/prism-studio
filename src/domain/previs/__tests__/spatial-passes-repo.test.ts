import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import type { NewSpatialPassBundle } from "@/data/previs-repository";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { assetSchema } from "@/domain/schemas";
import { newBlockingEntry, renderedBlockingProvenance } from "../blocking";
import { cameraPathFingerprint, upsertKeyframe } from "../camera-path";
import { buildPrevisDocument } from "../document";
import { buildHotelCanopyCameraPath, buildHotelCanopyEngineScene } from "../hotel-canopy";
import {
  CHARACTER_MASKS_SCHEMA,
  CHARACTER_MASK_FORMAT,
  DEPTH_FORMAT,
  OBJECT_ID_FORMAT,
  SPATIAL_MIME,
  cameraSourceFromBookmark,
  cameraSourceFromPath,
  depthMetadata,
  expectedManifest,
  spatialBundleFingerprint,
  type CharacterMasksJson,
  type ControlCameraSource,
} from "../spatial-passes";

const NOW = new Date("2026-10-17T00:00:00Z");
const iso = NOW.toISOString();

async function setup() {
  const repo = new MemoryRepository();
  const data = (await repo.loadProject("ojousama"))!;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  const other = data.shots.find((s) => s.shotCode === "2A")!;
  const location = data.locations.find((l) => l.id === shot.spatial.locationId) ?? data.locations[0]!;
  const yumeko = data.characters.find((c) => c.name === "Yumeko")!;
  const project = data.project;
  const scene = await repo.previs.saveScene({
    id: "scene-1",
    projectId: project.id,
    locationId: location.id,
    document: buildPrevisDocument({ engineScene: buildHotelCanopyEngineScene() }),
    expectedRevision: null,
    engineVersion: "t",
    userId: null,
    now: iso,
  });
  const base = {
    projectId: project.id,
    shotId: shot.id,
    locationId: location.id,
    sceneDocumentId: scene.id,
    sceneRevision: scene.revision,
    sceneFingerprint: scene.sceneFingerprint,
    userId: null,
    now: iso,
  };
  const bookmark = await repo.previs.setBookmark({ id: "bm-1", ...base });
  const path = await repo.previs.saveCameraPath({
    id: "path-1",
    ...base,
    path: buildHotelCanopyCameraPath(),
    expectedRevision: null,
  });
  const blocking = await repo.previs.saveShotBlocking({
    id: "blk-1",
    projectId: project.id,
    shotId: shot.id,
    characterId: yumeko.id,
    locationId: location.id,
    sceneDocumentId: scene.id,
    sceneRevision: scene.revision,
    sceneFingerprint: scene.sceneFingerprint,
    entry: newBlockingEntry(yumeko.id, { x: 0.5, y: 0, z: -2 }),
    expectedRevision: null,
    userId: null,
    now: iso,
  });
  return { repo, data, shot, other, location, yumeko, project, scene, base, bookmark, path, blocking };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Builds a bundle exactly the way the server action does, from SAVED state. */
async function bundleFor(
  ctx: Ctx,
  camera: ControlCameraSource,
  id: string,
  createdAt = iso,
): Promise<NewSpatialPassBundle> {
  const { repo, shot, scene, location, yumeko } = ctx;
  const scn = (await repo.previs.getScene(scene.id))!;
  const records = await repo.previs.listShotBlocking(shot.id);
  const manifest = expectedManifest(scn.document, records, { [yumeko.id]: "Yumeko" });
  const prov = renderedBlockingProvenance(records, { locationId: location.id });
  const characterMasks: CharacterMasksJson = {
    schema: CHARACTER_MASKS_SCHEMA,
    masks: Object.fromEntries(
      records
        .filter((r) => r.entry.visibility)
        .map((r) => [
          r.characterId,
          {
            blockingId: r.id,
            blockingRevision: r.revision,
            blockingFingerprint: r.blockingFingerprint,
            objectIndex: manifest.objects.find((o) => o.characterId === r.characterId)!.index,
            assetId: `mask-${id}-${r.characterId}`,
            encoding: CHARACTER_MASK_FORMAT,
            visiblePixelCount: 1000,
          },
        ]),
    ),
  };
  return {
    id,
    projectId: ctx.project.id,
    shotId: shot.id,
    locationId: location.id,
    sceneDocumentId: scn.id,
    sceneRevision: scn.revision,
    sceneFingerprint: scn.sceneFingerprint,
    blockingFingerprint: prov?.fingerprint ?? null,
    camera,
    bundleFingerprint: spatialBundleFingerprint({
      shotId: shot.id,
      sceneFingerprint: scn.sceneFingerprint,
      blockingFingerprint: prov?.fingerprint ?? null,
      camera,
      width: 1912,
      height: 800,
      manifest,
    }),
    width: 1912,
    height: 800,
    depth: {
      assetId: `depth-${id}`,
      encoding: DEPTH_FORMAT,
      metadata: depthMetadata({ validPixelCount: 5000, minDepth: 1.5, maxDepth: 22 }),
    },
    objectIds: { assetId: `ids-${id}`, encoding: OBJECT_ID_FORMAT, manifest },
    characterMasks,
    createdAt,
    userId: null,
  };
}

const pathCamera = (ctx: Ctx, timeMs: number) =>
  cameraSourceFromPath(
    ctx.path.path,
    { id: ctx.path.id, revision: ctx.path.revision, pathFingerprint: ctx.path.pathFingerprint },
    timeMs,
  );

const pkg = async (repo: MemoryRepository, shotId: string) => {
  const data = (await repo.loadProject("ojousama"))!;
  const refs = await repo.previs.listSpatialReferences(data.project.id);
  return assembleGenerationPackage(buildShotContext({ ...data, spatialReferences: refs }, shotId), NOW);
};

describe("spatial pass bundles in the repository (Phase 2F M2C)", () => {
  it("records an immutable bundle, newest first, scoped to the Shot", async () => {
    const ctx = await setup();
    const a = await ctx.repo.previs.recordSpatialPassBundle(
      await bundleFor(ctx, pathCamera(ctx, 1000), "b1", "2026-10-17T10:00:00Z"),
    );
    const b = await ctx.repo.previs.recordSpatialPassBundle(
      await bundleFor(ctx, pathCamera(ctx, 2000), "b2", "2026-10-17T11:00:00Z"),
    );
    expect(a.existing).toBe(false);
    expect(a.record.schemaVersion).toBe("prism.spatial-pass-bundle.v1");
    expect(a.record.sceneFingerprint).toBe(ctx.scene.sceneFingerprint);
    expect(a.record.camera.kind).toBe("camera_path");
    expect((await ctx.repo.previs.listSpatialPassBundles(ctx.shot.id)).map((x) => x.id)).toEqual([
      "b2",
      "b1",
    ]);
    expect(await ctx.repo.previs.listSpatialPassBundles(ctx.other.id)).toEqual([]); // another Shot of the project
    expect((await ctx.repo.previs.getSpatialPassBundle("b1"))?.depth.assetId).toBe("depth-b1");
    expect(b.record.id).toBe("b2");
  });

  it("captures the same exact control frame once (deterministic rendering)", async () => {
    const ctx = await setup();
    const first = await ctx.repo.previs.recordSpatialPassBundle(
      await bundleFor(ctx, pathCamera(ctx, 2000), "b1"),
    );
    const again = await ctx.repo.previs.recordSpatialPassBundle(
      await bundleFor(ctx, pathCamera(ctx, 2000), "b2"),
    );
    expect(again.existing).toBe(true);
    expect(again.record.id).toBe(first.record.id);
    expect(await ctx.repo.previs.listSpatialPassBundles(ctx.shot.id)).toHaveLength(1);
  });

  it("rejects a shot or location that is not in the project", async () => {
    const ctx = await setup();
    const b = await bundleFor(ctx, pathCamera(ctx, 0), "b1");
    await expect(ctx.repo.previs.recordSpatialPassBundle({ ...b, shotId: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(ctx.repo.previs.recordSpatialPassBundle({ ...b, locationId: "nope" })).rejects.toMatchObject(
      {
        code: "not_found",
      },
    );
  });

  it("knows which assets a bundle pins (depth, object ids and masks)", async () => {
    const ctx = await setup();
    const b = await bundleFor(ctx, pathCamera(ctx, 0), "b1");
    await ctx.repo.previs.recordSpatialPassBundle(b);
    const maskId = Object.values(b.characterMasks.masks)[0].assetId;
    for (const id of ["depth-b1", "ids-b1", maskId])
      expect(await ctx.repo.previs.spatialPassUsesAsset(id)).toBe(true);
    expect(await ctx.repo.previs.spatialPassUsesAsset("something-else")).toBe(false);
  });
});

describe("controlPasses in the GenerationPackage", () => {
  it("is optional: no bundle → no controlPasses key (earlier packages are byte-identical)", async () => {
    const ctx = await setup();
    const p = await pkg(ctx.repo, ctx.shot.id);
    expect("controlPasses" in p.spatialReference!).toBe(false);
    expect(JSON.stringify(p)).not.toContain("controlPasses");
  });

  it("freezes the CURRENT bundle by value: ids, manifest, camera, per-Character mask blocking identity", async () => {
    const ctx = await setup();
    const b = await bundleFor(ctx, pathCamera(ctx, 2000), "b1");
    await ctx.repo.previs.recordSpatialPassBundle(b);
    const p = await pkg(ctx.repo, ctx.shot.id);
    const cp = p.spatialReference!.controlPasses!;
    expect(cp.bundleId).toBe("b1");
    expect(cp.bundleFingerprint).toBe(b.bundleFingerprint);
    expect(cp.cameraSource).toBe("camera_path");
    expect(cp.camera).toEqual(b.camera);
    expect(cp.width).toBe(1912);
    expect(cp.height).toBe(800);
    expect(cp.depth).toMatchObject({
      assetId: "depth-b1",
      units: "metres",
      backgroundValue: 0,
      encoding: DEPTH_FORMAT,
    });
    expect(cp.objectIds.assetId).toBe("ids-b1");
    expect(cp.objectIds.manifest.objects.some((o) => o.category === "character_proxy")).toBe(true);
    expect(cp.characterMasks).toHaveLength(1);
    expect(cp.characterMasks[0]).toMatchObject({
      characterId: ctx.yumeko.id,
      blockingFingerprint: ctx.blocking.blockingFingerprint,
    });
    // identity stays a separate channel: nothing about the Character's face/wardrobe is in the passes
    expect(JSON.stringify(cp)).not.toMatch(/wardrobe|identityReference|https?:|blob:|token=/i);
  });

  it("describes the pass assets by value (checksum, size, MIME, dimensions) when they exist", async () => {
    const ctx = await setup();
    const b = await bundleFor(ctx, pathCamera(ctx, 2000), "b1");
    await ctx.repo.previs.recordSpatialPassBundle(b);
    const mk = (id: string, mime: string, bytes: number) =>
      assetSchema.parse({
        id,
        projectId: ctx.project.id,
        createdBy: null,
        type: "data",
        purpose: "spatial_control",
        source: "3d_render",
        name: id,
        originalFilename: `${id}.bin`,
        storageProvider: "local",
        bucket: null,
        objectPath: `${ctx.project.id}/${id}/${id}.bin`,
        mime,
        byteSize: bytes,
        checksum: `sha-${id}`,
        width: 1912,
        height: 800,
        durationMs: null,
        frameRate: null,
        sampleRate: null,
        channels: null,
        tags: [],
        notes: "",
        metadata: {},
        createdAt: iso,
        updatedAt: iso,
      });
    const maskId = Object.values(b.characterMasks.masks)[0].assetId;
    for (const a of [
      mk("depth-b1", SPATIAL_MIME.depth, 6118400),
      mk("ids-b1", SPATIAL_MIME.objectIds, 6118400),
      mk(maskId, SPATIAL_MIME.characterMask, 1529600),
    ])
      await ctx.repo.upsert(ctx.project.id, "assets", a);
    const p = await pkg(ctx.repo, ctx.shot.id);
    expect(p.assets["depth-b1"]).toMatchObject({
      type: "data",
      purpose: "spatial_control",
      mime: SPATIAL_MIME.depth,
      byteSize: 6118400,
      checksum: "sha-depth-b1",
    });
    expect(p.assets[maskId].mime).toBe(SPATIAL_MIME.characterMask);
  });

  it("is HISTORICALLY IMMUTABLE: later edits never alter a compiled package, and a new one differs", async () => {
    const ctx = await setup();
    await ctx.repo.previs.recordSpatialPassBundle(await bundleFor(ctx, pathCamera(ctx, 2000), "b1"));
    const before = await pkg(ctx.repo, ctx.shot.id);
    const frozen = JSON.stringify(before);
    // edit the live blocking: the old bundle is no longer current
    await ctx.repo.previs.saveShotBlocking({
      id: "blk-1",
      projectId: ctx.project.id,
      shotId: ctx.shot.id,
      characterId: ctx.yumeko.id,
      locationId: ctx.location.id,
      sceneDocumentId: ctx.scene.id,
      sceneRevision: ctx.scene.revision,
      sceneFingerprint: ctx.scene.sceneFingerprint,
      entry: newBlockingEntry(ctx.yumeko.id, { x: 3, y: 0, z: -1 }),
      expectedRevision: ctx.blocking.revision,
      userId: null,
      now: iso,
    });
    expect(JSON.stringify(before)).toBe(frozen); // the compiled object is unchanged
    const stale = await pkg(ctx.repo, ctx.shot.id);
    expect("controlPasses" in stale.spatialReference!).toBe(false); // stale bundles are never frozen into a new package
    // capture again against the new blocking → a new, different package
    await ctx.repo.previs.recordSpatialPassBundle(await bundleFor(ctx, pathCamera(ctx, 2000), "b2"));
    const after = await pkg(ctx.repo, ctx.shot.id);
    expect(after.spatialReference!.controlPasses!.bundleId).toBe("b2");
    expect(after.spatialReference!.controlPasses!.bundleFingerprint).not.toBe(
      before.spatialReference!.controlPasses!.bundleFingerprint,
    );
    expect(after.provenance.fingerprint).not.toBe(before.provenance.fingerprint);
    // the historical bundle is still stored
    expect((await ctx.repo.previs.listSpatialPassBundles(ctx.shot.id)).map((x) => x.id).sort()).toEqual([
      "b1",
      "b2",
    ]);
  });

  it("a camera-path capture stops being current when the saved path changes (STALE CAMERA)", async () => {
    const ctx = await setup();
    await ctx.repo.previs.recordSpatialPassBundle(await bundleFor(ctx, pathCamera(ctx, 2000), "b1"));
    expect((await pkg(ctx.repo, ctx.shot.id)).spatialReference!.controlPasses?.bundleId).toBe("b1");
    const moved = upsertKeyframe(ctx.path.path, {
      ...ctx.path.path.keyframes[1],
      position: { x: 9, y: 2, z: 9 },
    });
    expect(cameraPathFingerprint(moved)).not.toBe(ctx.path.pathFingerprint);
    await ctx.repo.previs.saveCameraPath({
      id: "path-1",
      ...ctx.base,
      path: moved,
      expectedRevision: ctx.path.revision,
    });
    expect((await pkg(ctx.repo, ctx.shot.id)).spatialReference!.controlPasses).toBeUndefined();
  });

  it("a Production Camera bookmark capture stays current when a camera path is added or audio changes", async () => {
    const ctx = await setup();
    const bm = cameraSourceFromBookmark({ id: ctx.bookmark.id }, ctx.bookmark.value);
    await ctx.repo.previs.recordSpatialPassBundle(await bundleFor(ctx, bm, "bm-bundle"));
    expect((await pkg(ctx.repo, ctx.shot.id)).spatialReference!.controlPasses?.bundleId).toBe("bm-bundle");
    const data = (await ctx.repo.loadProject("ojousama"))!;
    const refs = await ctx.repo.previs.listSpatialReferences(data.project.id, () => "f".repeat(64)); // an audio mix now exists
    expect(refs[ctx.shot.id].controlPasses?.bundleId).toBe("bm-bundle"); // audio never stales the passes
  });

  it("a Set change stales the bundle (STALE SCENE)", async () => {
    const ctx = await setup();
    await ctx.repo.previs.recordSpatialPassBundle(await bundleFor(ctx, pathCamera(ctx, 2000), "b1"));
    const engine = buildHotelCanopyEngineScene() as unknown as { scene: Array<Record<string, unknown>> };
    const changed = {
      ...engine,
      scene: engine.scene.map((o, i) => (i === 0 ? { ...o, position: { x: 4, y: 0, z: 4 } } : o)),
    };
    await ctx.repo.previs.saveScene({
      id: "scene-1",
      projectId: ctx.project.id,
      locationId: ctx.location.id,
      document: buildPrevisDocument({ engineScene: changed }),
      expectedRevision: ctx.scene.revision,
      engineVersion: "t",
      userId: null,
      now: iso,
    });
    expect((await pkg(ctx.repo, ctx.shot.id)).spatialReference!.controlPasses).toBeUndefined();
  });
});
