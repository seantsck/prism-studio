import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { PrevisError } from "@/data/previs-repository";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { buildPrevisDocument } from "../document";
import { buildHotelCanopyCameraPath, buildHotelCanopyEngineScene } from "../hotel-canopy";
import { cameraPathFingerprint, upsertKeyframe } from "../camera-path";
import { isCameraMotionStale } from "../spatial";

const NOW = new Date("2026-10-15T00:00:00Z");
const iso = NOW.toISOString();

async function setup() {
  const repo = new MemoryRepository();
  const data = (await repo.loadProject("ojousama"))!;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  const location = data.locations[0]!;
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
  return { repo, shot, location, project, scene, base };
}

const pkg = async (repo: MemoryRepository, shotId: string) => {
  const data = (await repo.loadProject("ojousama"))!;
  const refs = await repo.previs.listSpatialReferences(data.project.id);
  return assembleGenerationPackage(buildShotContext({ ...data, spatialReferences: refs }, shotId), NOW);
};

describe("camera motion in the GenerationPackage (Phase 2F M2A)", () => {
  it("is optional: a shot with a set but no path has no cameraMotion key", async () => {
    const { repo, shot, base } = await setup();
    await repo.previs.setBookmark({ id: "bm", ...base });
    const p = await pkg(repo, shot.id);
    expect(p.spatialReference).toBeDefined();
    expect("cameraMotion" in p.spatialReference!).toBe(false);
    expect(JSON.stringify(p)).not.toContain("cameraMotion");
  });

  it("freezes the authored path by value, with fingerprint, lens basis and a null previs asset", async () => {
    const { repo, shot, base } = await setup();
    const path = buildHotelCanopyCameraPath();
    const rec = await repo.previs.saveCameraPath({ id: "path-1", ...base, path, expectedRevision: null });
    const p = await pkg(repo, shot.id);
    const m = p.spatialReference!.cameraMotion!;
    expect(m.cameraPathId).toBe("path-1");
    expect(m.cameraPathRevision).toBe(1);
    expect(m.cameraPathFingerprint).toBe(rec.pathFingerprint);
    expect(m.cameraPathFingerprint).toBe(cameraPathFingerprint(path));
    expect(m.keyframes).toHaveLength(3);
    expect(m.keyframes[1].focalLengthMm).toBe(50);
    expect(m.focalLengthBasis).toBe("vertical-sensor-24mm");
    expect(m.durationMs).toBe(4000);
    expect(m.frameRate).toBe(24);
    expect(m.previsAssetId).toBeNull();
    // authoring the path does not touch the shot's freshness parts
    const baseline = assembleGenerationPackage(
      buildShotContext((await repo.loadProject("ojousama"))!, shot.id),
      NOW,
    );
    expect(p.provenance.parts).toEqual(baseline.provenance.parts);
  });

  it("references the previs rendered from exactly this path, and none rendered from an older one", async () => {
    const { repo, shot, base, project } = await setup();
    const path = buildHotelCanopyCameraPath();
    const saved = await repo.previs.saveCameraPath({ id: "path-1", ...base, path, expectedRevision: null });
    await repo.previs.recordPrevisClip({
      id: "clip-1",
      projectId: project.id,
      shotId: shot.id,
      locationId: base.locationId,
      cameraPathId: saved.id,
      pathRevision: saved.revision,
      pathFingerprint: saved.pathFingerprint,
      sceneDocumentId: base.sceneDocumentId,
      sceneRevision: base.sceneRevision,
      sceneFingerprint: base.sceneFingerprint,
      assetId: "asset-previs-1",
      frameRate: 24,
      durationMs: 4000,
      renderWidth: 956,
      renderHeight: 400,
      container: "mp4",
      codec: "avc",
      hasAudio: false,
      audioAssetId: null,
      audioMix: null,
      audioMixFingerprint: null,
      renderedAt: iso,
      userId: null,
    });
    expect((await pkg(repo, shot.id)).spatialReference!.cameraMotion!.previsAssetId).toBe("asset-previs-1");

    // the path is edited: the old clip no longer describes the live motion
    const moved = upsertKeyframe(path, { ...path.keyframes[1], focalLengthMm: 60 });
    await repo.previs.saveCameraPath({ id: "x", ...base, path: moved, expectedRevision: 1 });
    expect((await pkg(repo, shot.id)).spatialReference!.cameraMotion!.previsAssetId).toBeNull();
  });

  it("historical packages are immutable: A keeps fingerprint X while the live path moves to Y", async () => {
    const { repo, shot, base } = await setup();
    const path = buildHotelCanopyCameraPath();
    await repo.previs.saveCameraPath({ id: "path-1", ...base, path, expectedRevision: null });
    const a = await pkg(repo, shot.id);
    const aSnapshot = JSON.stringify(a);
    const x = a.spatialReference!.cameraMotion!.cameraPathFingerprint;

    const edited = upsertKeyframe(path, { ...path.keyframes[2], focalLengthMm: 85 });
    await repo.previs.saveCameraPath({ id: "ignored", ...base, path: edited, expectedRevision: 1 });
    const b = await pkg(repo, shot.id);
    const y = b.spatialReference!.cameraMotion!.cameraPathFingerprint;

    expect(y).not.toBe(x);
    expect(b.provenance.fingerprint).not.toBe(a.provenance.fingerprint);
    expect(b.spatialReference!.cameraMotion!.cameraPathRevision).toBe(2);
    // package A is a value: nothing about it changed
    expect(JSON.stringify(a)).toBe(aSnapshot);
    expect(a.spatialReference!.cameraMotion!.keyframes[2].focalLengthMm).toBe(70);
    expect(a.spatialReference!.cameraMotion!.cameraPathFingerprint).toBe(x);
  });

  it("editing the frozen object cannot reach the live path (deep copy)", async () => {
    const { repo, shot, base } = await setup();
    await repo.previs.saveCameraPath({
      id: "p",
      ...base,
      path: buildHotelCanopyCameraPath(),
      expectedRevision: null,
    });
    const a = await pkg(repo, shot.id);
    a.spatialReference!.cameraMotion!.keyframes[0].focalLengthMm = 999;
    const live = await repo.previs.getCameraPathForShot(shot.id);
    expect(live!.path.keyframes[0].focalLengthMm).toBe(35);
  });

  it("marks the motion stale when the set changed after the path was saved (not deleted)", async () => {
    const { repo, shot, base, location, project } = await setup();
    await repo.previs.saveCameraPath({
      id: "p",
      ...base,
      path: buildHotelCanopyCameraPath(),
      expectedRevision: null,
    });
    expect(isCameraMotionStale((await pkg(repo, shot.id)).spatialReference!)).toBe(false);

    const s = buildHotelCanopyEngineScene();
    s.scene[4].position = { x: 9, y: 0.75, z: -2 };
    await repo.previs.saveScene({
      id: "ignored",
      projectId: project.id,
      locationId: location.id,
      document: buildPrevisDocument({ engineScene: s }),
      expectedRevision: 1,
      engineVersion: "t",
      userId: null,
      now: iso,
    });
    const p = await pkg(repo, shot.id);
    expect(isCameraMotionStale(p.spatialReference!)).toBe(true);
    expect(p.spatialReference!.cameraMotion).toBeDefined();
    expect(await repo.previs.getCameraPathForShot(shot.id)).not.toBeNull();
  });

  it("memory store enforces the database rules: CAS revision, one first save, valid paths only", async () => {
    const { repo, shot, base } = await setup();
    const path = buildHotelCanopyCameraPath();
    await repo.previs.saveCameraPath({ id: "p", ...base, path, expectedRevision: null });
    await expect(
      repo.previs.saveCameraPath({ id: "p2", ...base, path, expectedRevision: null }),
    ).rejects.toBeInstanceOf(PrevisError);
    await expect(
      repo.previs.saveCameraPath({ id: "p3", ...base, path, expectedRevision: 7 }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      repo.previs.saveCameraPath({
        id: "p4",
        ...base,
        path: { ...path, durationMs: 1000 },
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    const ok = await repo.previs.saveCameraPath({ id: "p5", ...base, path, expectedRevision: 1 });
    expect(ok.revision).toBe(2);
    expect(ok.id).toBe("p");
    expect((await repo.previs.getCameraPathForShot(shot.id))!.revision).toBe(2);
  });
});

describe("previs asset taxonomy", () => {
  it("accepts a local_previs video asset (source is part of the shared asset schema)", async () => {
    const { assetSchema } = await import("@/domain/schemas");
    const r = assetSchema.safeParse({
      id: "a1",
      projectId: "p1",
      createdBy: null,
      type: "video",
      purpose: "video_reference",
      source: "local_previs",
      name: "previs",
      originalFilename: "previs.webm",
      storageProvider: "local",
      bucket: null,
      objectPath: "p/a/previs.webm",
      mime: "video/webm",
      byteSize: 10,
      checksum: "abc",
      width: 956,
      height: 400,
      durationMs: 4000,
      frameRate: 24,
      sampleRate: null,
      channels: null,
      tags: ["previs"],
      notes: "",
      metadata: {},
      createdAt: iso,
      updatedAt: iso,
    });
    expect(r.success).toBe(true);
  });
});
