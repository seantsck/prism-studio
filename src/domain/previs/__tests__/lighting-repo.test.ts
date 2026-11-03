import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { LIGHTING_RIG_ELSEWHERE, PrevisError } from "@/data/previs-repository";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { buildPrevisDocument } from "../document";
import { buildHotelCanopyEngineScene } from "../hotel-canopy";
import {
  SHOT_LIGHTING_SCHEMA,
  authoredLightingIntent,
  buildRenderLighting,
  lightingFingerprint,
  newShotLight,
  parseShotLightingRig,
} from "../lighting";

const iso = "2026-11-01T00:00:00.000Z";

async function setup() {
  const repo = new MemoryRepository();
  const data = (await repo.loadProject("ojousama"))!;
  const shotA = data.shots.find((s) => s.shotCode === "2A")!;
  const shotB = data.shots.find((s) => s.shotCode === "2B")!;
  const location = data.locations.find((l) => l.id === shotA.spatial.locationId)!;
  const project = data.project;
  const scene = await repo.previs.saveScene({
    id: "scene-1",
    projectId: project.id,
    locationId: location.id,
    document: buildPrevisDocument({ engineScene: buildHotelCanopyEngineScene() }),
    expectedRevision: null,
    engineVersion: "test",
    userId: null,
    now: iso,
  });
  const rigOf = (intensity: number, mode: "engine_default" | "replace" = "replace") =>
    parseShotLightingRig({
      schema: SHOT_LIGHTING_SCHEMA,
      base: { mode },
      lights: [{ ...newShotLight("point", "key"), intensity }],
      authoredIntent: authoredLightingIntent(shotA),
    });
  const save = (shotId: string, intensity: number, expectedRevision: number | null) =>
    repo.previs.saveLightingRig({
      id: `rig-${shotId}-${intensity}`,
      projectId: project.id,
      shotId,
      locationId: location.id,
      sceneDocumentId: scene.id,
      sceneRevision: scene.revision,
      sceneFingerprint: scene.sceneFingerprint,
      rig: rigOf(intensity),
      expectedRevision,
      userId: null,
      now: iso,
    });
  const refs = () => repo.previs.listSpatialReferences(project.id);
  return { repo, data, shotA, shotB, location, project, scene, rigOf, save, refs };
}

describe("Shot Lighting repository (memory)", () => {
  it("creates revision 1, increments by one and derives the fingerprint", async () => {
    const { save, shotA, rigOf } = await setup();
    const one = await save(shotA.id, 10, null);
    expect(one.revision).toBe(1);
    expect(one.lightingFingerprint).toBe(lightingFingerprint(rigOf(10)));
    const two = await save(shotA.id, 20, 1);
    expect(two.revision).toBe(2);
    expect(two.id).toBe(one.id);
    expect(two.lightingFingerprint).toBe(lightingFingerprint(rigOf(20)));
  });

  it("refuses a stale revision, a second first save and a first save that expects one", async () => {
    const { save, shotA, shotB } = await setup();
    await save(shotA.id, 10, null);
    await expect(save(shotA.id, 11, 7)).rejects.toMatchObject({ code: "conflict" });
    await expect(save(shotA.id, 11, null)).rejects.toMatchObject({ code: "conflict" });
    await expect(save(shotB.id, 11, 1)).rejects.toMatchObject({ code: "conflict" });
  });

  it("isolates Shots, and never touches the scene", async () => {
    const { repo, save, shotA, shotB, location, scene } = await setup();
    await save(shotA.id, 10, null);
    expect(await repo.previs.getLightingRigForShot(shotB.id)).toBeNull();
    const after = (await repo.previs.getSceneForLocation(location.id))!;
    expect(after.revision).toBe(scene.revision);
    expect(after.sceneFingerprint).toBe(scene.sceneFingerprint);
    expect(after.document).toEqual(scene.document);
  });

  it("refuses a scene document of another Location and an unknown Shot", async () => {
    const { repo, data, project, shotA, scene, rigOf, location } = await setup();
    const other = data.locations.find((l) => l.id !== location.id)!;
    const input = {
      id: "x",
      projectId: project.id,
      shotId: shotA.id,
      locationId: other.id,
      sceneDocumentId: scene.id,
      sceneRevision: 1,
      sceneFingerprint: scene.sceneFingerprint,
      rig: rigOf(1),
      expectedRevision: null,
      userId: null,
      now: iso,
    };
    await expect(repo.previs.saveLightingRig(input)).rejects.toBeInstanceOf(PrevisError);
    await expect(
      repo.previs.saveLightingRig({ ...input, locationId: location.id, shotId: "missing" }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("a rig cannot move to another set", async () => {
    const { repo, data, project, shotA, save, rigOf, location } = await setup();
    await save(shotA.id, 10, null);
    const other = data.locations.find((l) => l.id !== location.id)!;
    const s2 = await repo.previs.saveScene({
      id: "scene-2",
      projectId: project.id,
      locationId: other.id,
      document: buildPrevisDocument({ engineScene: buildHotelCanopyEngineScene() }),
      expectedRevision: null,
      engineVersion: "test",
      userId: null,
      now: iso,
    });
    await expect(
      repo.previs.saveLightingRig({
        id: "y",
        projectId: project.id,
        shotId: shotA.id,
        locationId: other.id,
        sceneDocumentId: s2.id,
        sceneRevision: s2.revision,
        sceneFingerprint: s2.sceneFingerprint,
        rig: rigOf(1),
        expectedRevision: 1,
        userId: null,
        now: iso,
      }),
    ).rejects.toThrow(LIGHTING_RIG_ELSEWHERE);
  });

  it("clear is compare-and-set and leaves render history alone", async () => {
    const { repo, save, project, shotA, location, scene, rigOf } = await setup();
    const rig = await save(shotA.id, 10, null);
    const lighting = buildRenderLighting({ rig, scene: scene.document });
    const frame = await repo.previs.recordMasterFrame({
      id: "mf-1",
      projectId: project.id,
      shotId: shotA.id,
      locationId: location.id,
      sceneDocumentId: scene.id,
      sceneRevision: scene.revision,
      sceneFingerprint: scene.sceneFingerprint,
      cameraBookmarkId: null,
      assetId: "asset-1",
      renderWidth: 1912,
      renderHeight: 800,
      productionAspectRatio: "2.39:1",
      capturedAt: iso,
      lightingFingerprint: rig.lightingFingerprint,
      lighting,
      userId: null,
    });
    await expect(
      repo.previs.clearLightingRig({ projectId: project.id, shotId: shotA.id, expectedRevision: 9 }),
    ).rejects.toMatchObject({ code: "conflict" });
    await repo.previs.clearLightingRig({ projectId: project.id, shotId: shotA.id, expectedRevision: 1 });
    expect(await repo.previs.getLightingRigForShot(shotA.id)).toBeNull();
    await expect(
      repo.previs.clearLightingRig({ projectId: project.id, shotId: shotA.id, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
    const kept = (await repo.previs.getMasterFrame(frame.id))!;
    expect(kept.lightingFingerprint).toBe(lightingFingerprint(rigOf(10)));
    expect(kept.lighting?.rigId).toBe(rig.id);
  });

  it("a render without a rig stores null/null", async () => {
    const { repo, project, shotA, location, scene } = await setup();
    const frame = await repo.previs.recordMasterFrame({
      id: "mf-2",
      projectId: project.id,
      shotId: shotA.id,
      locationId: location.id,
      sceneDocumentId: scene.id,
      sceneRevision: scene.revision,
      sceneFingerprint: scene.sceneFingerprint,
      cameraBookmarkId: null,
      assetId: "asset-1",
      renderWidth: 1912,
      renderHeight: 800,
      productionAspectRatio: "2.39:1",
      capturedAt: iso,
      userId: null,
    });
    expect(frame.lightingFingerprint).toBeNull();
    expect(frame.lighting).toBeNull();
  });
});

describe("spatialReference.shotLighting", () => {
  it("a Shot with ONLY a rig still gets a spatial reference, frozen by value", async () => {
    const { save, shotA, shotB, refs, scene } = await setup();
    const rig = await save(shotA.id, 10, null);
    const r = await refs();
    expect(r[shotB.id]).toBeUndefined();
    expect(r[shotA.id].sceneDocumentId).toBe(scene.id);
    expect(r[shotA.id].cameraBookmark).toBeNull();
    const ref = r[shotA.id].shotLighting!;
    expect(ref.rigId).toBe(rig.id);
    expect(ref.rigRevision).toBe(1);
    expect(ref.lightingFingerprint).toBe(rig.lightingFingerprint);
    expect(ref.rig.lights[0].id).toBe("key");
    expect(ref.productionFrameLightingFingerprint).toBeNull();
    expect(JSON.stringify(ref)).not.toMatch(/https?:|blob:/);
    await save(shotA.id, 20, 1);
    expect(ref.rig.lights[0].intensity).toBe(10); // the earlier reference did not follow the live rig
  });

  it("is omitted, not null, without a rig", async () => {
    const { repo, project, shotA, location, scene, refs } = await setup();
    await repo.previs.setBookmark({
      id: "bm",
      projectId: project.id,
      shotId: shotA.id,
      locationId: location.id,
      sceneDocumentId: scene.id,
      userId: null,
      now: iso,
    });
    expect("shotLighting" in (await refs())[shotA.id]).toBe(false);
  });

  it("names the Master Frame behind the SELECTED Production Frame, never the newest or adopted one", async () => {
    const { repo, project, shotA, location, scene, save, refs, data } = await setup();
    const asset = data.assets.find((a) => a.type === "image")!;
    const rig1 = await save(shotA.id, 10, null);
    const frame = (id: string, capturedAt: string, rig: typeof rig1 | null) =>
      repo.previs.recordMasterFrame({
        id,
        projectId: project.id,
        shotId: shotA.id,
        locationId: location.id,
        sceneDocumentId: scene.id,
        sceneRevision: scene.revision,
        sceneFingerprint: scene.sceneFingerprint,
        cameraBookmarkId: null,
        assetId: asset.id,
        renderWidth: 1912,
        renderHeight: 800,
        productionAspectRatio: "2.39:1",
        capturedAt,
        ...(rig
          ? {
              lightingFingerprint: rig.lightingFingerprint,
              lighting: buildRenderLighting({ rig, scene: scene.document }),
            }
          : {}),
        userId: null,
      });
    await frame("mf-source", "2026-11-01T01:00:00.000Z", rig1);
    const rig2 = await save(shotA.id, 20, 1);
    // a NEWER frame with different lighting, also adopted: neither may be mistaken for the source
    await frame("mf-newest", "2026-11-01T02:00:00.000Z", rig2);
    await repo.previs.adoptMasterFrame("mf-newest", "sb-1", "2026-11-01T03:00:00.000Z");

    const select = (s: { source: string; sourceMasterFrameId: string | null } | null) => {
      const pf = repo.productionFrames as unknown as { selectedFrame: (p: string, id: string) => unknown };
      pf.selectedFrame = () => s;
    };
    select({ source: "previs_master", sourceMasterFrameId: "mf-source" });
    const ref = (await refs())[shotA.id].shotLighting!;
    expect(ref.lightingFingerprint).toBe(rig2.lightingFingerprint);
    expect(ref.productionFrameLightingFingerprint).toBe(rig1.lightingFingerprint);

    select({ source: "storyboard", sourceMasterFrameId: null });
    expect((await refs())[shotA.id].shotLighting!.productionFrameLightingFingerprint).toBeNull();
    select(null);
    expect((await refs())[shotA.id].shotLighting!.productionFrameLightingFingerprint).toBeNull();

    await frame("mf-unlit", "2026-11-01T00:30:00.000Z", null);
    select({ source: "previs_master", sourceMasterFrameId: "mf-unlit" });
    expect((await refs())[shotA.id].shotLighting!.productionFrameLightingFingerprint).toBeNull();
  });
});

describe("no-3D regression", () => {
  it("a Shot with no spatial data has an unchanged package with no spatial key", async () => {
    const repo = new MemoryRepository();
    const data = (await repo.loadProject("ojousama"))!;
    const refs = await repo.previs.listSpatialReferences(data.project.id);
    expect(refs).toEqual({});
    const shot = data.shots[0];
    const pkg = assembleGenerationPackage(buildShotContext(data, shot.id), new Date(iso));
    expect(pkg).not.toHaveProperty("spatialReference");
    expect(JSON.stringify(pkg)).not.toContain("shotLighting");
    expect(JSON.stringify(pkg)).not.toContain("prism.shot-lighting");
  });
});
