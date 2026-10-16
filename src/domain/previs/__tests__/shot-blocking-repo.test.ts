import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { PrevisError } from "@/data/previs-repository";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { pickCurrentClip, previsStaleReasons } from "../audio-mix";
import {
  blockingFingerprint,
  blockingStaleReasons,
  newBlockingEntry,
  renderedBlockingFingerprint,
  renderedBlockingProvenance,
  type ShotBlockingEntry,
} from "../blocking";
import { buildPrevisDocument } from "../document";
import {
  buildHotelCanopyCameraPath,
  buildHotelCanopyEngineScene,
  buildHotelCanopyShotBlocking,
} from "../hotel-canopy";
import { presetById, setPoseJoint, withHeadDirection } from "../pose";
import { quatFromAxisAngle, DEG } from "../quat";
import { isShotBlockingStale } from "../spatial";

const NOW = new Date("2026-10-16T00:00:00Z");
const iso = NOW.toISOString();

async function setup() {
  const repo = new MemoryRepository();
  const data = (await repo.loadProject("ojousama"))!;
  const shotA = data.shots.find((s) => s.shotCode === "2A")!;
  const shotB = data.shots.find((s) => s.shotCode === "2B")!;
  expect(shotA.spatial.locationId).toBe(shotB.spatial.locationId); // two Shots, ONE Location
  const location = data.locations.find((l) => l.id === shotA.spatial.locationId)!;
  const yumeko = data.characters.find((c) => c.name === "Yumeko")!;
  const sean = data.characters.find((c) => c.name === "Sean")!;
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
  const save = (
    shotId: string,
    entry: ShotBlockingEntry,
    expectedRevision: number | null,
    id = `b-${shotId}-${entry.characterId}`,
  ) =>
    repo.previs.saveShotBlocking({
      id,
      projectId: project.id,
      shotId,
      characterId: entry.characterId,
      locationId: location.id,
      sceneDocumentId: scene.id,
      sceneRevision: scene.revision,
      sceneFingerprint: scene.sceneFingerprint,
      entry,
      expectedRevision,
      userId: null,
      now: iso,
    });
  return { repo, data, shotA, shotB, location, yumeko, sean, project, scene, save };
}

const pkg = async (repo: MemoryRepository, shotId: string) => {
  const data = (await repo.loadProject("ojousama"))!;
  const refs = await repo.previs.listSpatialReferences(data.project.id);
  return assembleGenerationPackage(buildShotContext({ ...data, spatialReferences: refs }, shotId), NOW);
};

describe("Shot blocking persistence", () => {
  it("stores one blocking state per (shot, character) with the set state it was authored against", async () => {
    const { repo, shotA, yumeko, save, scene } = await setup();
    const entry = newBlockingEntry(yumeko.id, { x: 1, y: 0, z: -2 });
    const rec = await save(shotA.id, entry, null);
    expect(rec.revision).toBe(1);
    expect(rec.sceneRevision).toBe(scene.revision);
    expect(rec.sceneFingerprint).toBe(scene.sceneFingerprint);
    expect(rec.rigVersion).toBe("prism.humanoid-rig.v1");
    expect(rec.entry).toEqual(entry);
    expect(rec.poseFingerprint).toHaveLength(64);
    expect(rec.blockingFingerprint).toBe(blockingFingerprint(entry, { locationId: rec.locationId }));
    expect(await repo.previs.listShotBlocking(shotA.id)).toHaveLength(1);
  });

  it("compare-and-set: a first save with a revision, or a stale revision, conflicts", async () => {
    const { shotA, yumeko, save } = await setup();
    const entry = newBlockingEntry(yumeko.id);
    await expect(save(shotA.id, entry, 4)).rejects.toMatchObject({ code: "conflict" });
    const first = await save(shotA.id, entry, null);
    const moved = { ...entry, root: { ...entry.root, position: { x: 2, y: 0, z: 0 } } };
    await expect(save(shotA.id, moved, null)).rejects.toMatchObject({ code: "conflict" });
    const second = await save(shotA.id, moved, first.revision);
    expect(second.revision).toBe(2);
    await expect(save(shotA.id, entry, first.revision)).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects a character, shot or location that is not in the project, and mismatched entries", async () => {
    const { repo, shotA, yumeko, sean, project, scene, location } = await setup();
    const base = {
      projectId: project.id,
      locationId: location.id,
      sceneDocumentId: scene.id,
      sceneRevision: 1,
      sceneFingerprint: scene.sceneFingerprint,
      expectedRevision: null,
      userId: null,
      now: iso,
    };
    const e = newBlockingEntry(yumeko.id);
    await expect(
      repo.previs.saveShotBlocking({
        ...base,
        id: "x",
        shotId: shotA.id,
        characterId: "not-a-character",
        entry: { ...e, characterId: "not-a-character" },
      }),
    ).rejects.toBeInstanceOf(PrevisError);
    await expect(
      repo.previs.saveShotBlocking({ ...base, id: "x", shotId: "nope", characterId: yumeko.id, entry: e }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      repo.previs.saveShotBlocking({
        ...base,
        id: "x",
        locationId: "nope",
        shotId: shotA.id,
        characterId: yumeko.id,
        entry: e,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      repo.previs.saveShotBlocking({ ...base, id: "x", shotId: shotA.id, characterId: sean.id, entry: e }),
    ).rejects.toMatchObject({ code: "invalid" }); // the entry is Yumeko's
    await expect(
      repo.previs.saveShotBlocking({
        ...base,
        id: "x",
        shotId: shotA.id,
        characterId: yumeko.id,
        entry: { ...e, pose: { ...e.pose, joints: { root: { x: 0, y: 1, z: 0, w: 0 } } } },
      }),
    ).rejects.toMatchObject({ code: "invalid" }); // the root is blocking, never a pose joint
  });

  it("CROSS-SHOT ISOLATION: the same Character in two Shots of one Location never shares blocking", async () => {
    const { repo, shotA, shotB, yumeko, save } = await setup();
    const a = newBlockingEntry(yumeko.id, { x: -1, y: 0, z: -4 });
    const b = { ...newBlockingEntry(yumeko.id, { x: 3, y: 0, z: 1 }), pose: presetById("seated").pose };
    const ra = await save(shotA.id, a, null);
    const rb = await save(shotB.id, b, null);
    expect(ra.id).not.toBe(rb.id);

    // editing A must never modify B
    const editedA = {
      ...a,
      pose: withHeadDirection(a.pose, 40, 0),
      root: { ...a.root, position: { x: -2, y: 0, z: -4 } },
    };
    await save(shotA.id, editedA, ra.revision);
    const [la] = await repo.previs.listShotBlocking(shotA.id);
    const [lb] = await repo.previs.listShotBlocking(shotB.id);
    expect(la.entry.root.position.x).toBe(-2);
    expect(lb.entry).toEqual(b);
    expect(lb.revision).toBe(1);
    expect(lb.blockingFingerprint).toBe(rb.blockingFingerprint);

    // removing from A leaves B
    await repo.previs.removeShotBlocking({
      projectId: ra.projectId,
      shotId: shotA.id,
      characterId: yumeko.id,
      expectedRevision: 2,
    });
    expect(await repo.previs.listShotBlocking(shotA.id)).toHaveLength(0);
    expect((await repo.previs.listShotBlocking(shotB.id))[0].entry).toEqual(b);
  });

  it("removal is compare-and-set and reports a missing figure", async () => {
    const { repo, shotA, yumeko, save, project } = await setup();
    const r = await save(shotA.id, newBlockingEntry(yumeko.id), null);
    await expect(
      repo.previs.removeShotBlocking({
        projectId: project.id,
        shotId: shotA.id,
        characterId: yumeko.id,
        expectedRevision: 9,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await repo.previs.removeShotBlocking({
      projectId: project.id,
      shotId: shotA.id,
      characterId: yumeko.id,
      expectedRevision: r.revision,
    });
    await expect(
      repo.previs.removeShotBlocking({
        projectId: project.id,
        shotId: shotA.id,
        characterId: yumeko.id,
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("does not touch the Location's persistent set", async () => {
    const { repo, shotA, yumeko, save, location, scene } = await setup();
    await save(shotA.id, newBlockingEntry(yumeko.id), null);
    const after = (await repo.previs.getSceneForLocation(location.id))!;
    expect(after.revision).toBe(scene.revision);
    expect(after.sceneFingerprint).toBe(scene.sceneFingerprint);
    expect(JSON.stringify(after.document)).not.toContain("prismBlocking");
  });
});

describe("blocking staleness and re-anchoring", () => {
  it("a Set change makes blocking STALE without deleting it; re-anchor updates only the anchor", async () => {
    const { repo, shotA, yumeko, save, location, project } = await setup();
    const entry = {
      ...newBlockingEntry(yumeko.id, { x: 0.5, y: 0, z: -3 }),
      pose: withHeadDirection(presetById("hands_on_hips").pose, 20, 5),
    };
    const rec = await save(shotA.id, entry, null);
    expect(isShotBlockingStale((await pkg(repo, shotA.id)).spatialReference!)).toBe(false);

    const moved = buildHotelCanopyEngineScene();
    moved.scene[3].position = { x: 1, y: 1.2, z: -5.75 }; // the doorway moved
    const newScene = await repo.previs.saveScene({
      id: "ignored",
      projectId: project.id,
      locationId: location.id,
      document: buildPrevisDocument({ engineScene: moved }),
      expectedRevision: 1,
      engineVersion: "t",
      userId: null,
      now: iso,
    });
    const stale = (await pkg(repo, shotA.id)).spatialReference!;
    expect(isShotBlockingStale(stale)).toBe(true);
    expect(
      blockingStaleReasons(
        { sceneFingerprint: rec.sceneFingerprint },
        { sceneFingerprint: newScene.sceneFingerprint },
      ),
    ).toEqual(["scene"]);
    expect(await repo.previs.listShotBlocking(shotA.id)).toHaveLength(1); // kept

    const [re] = await repo.previs.reanchorShotBlocking({
      projectId: project.id,
      shotId: shotA.id,
      sceneDocumentId: newScene.id,
      userId: null,
      now: iso,
    });
    expect(re.sceneRevision).toBe(newScene.revision);
    expect(re.sceneFingerprint).toBe(newScene.sceneFingerprint);
    // root + pose are untouched, so the blocking identity is unchanged
    expect(re.entry).toEqual(entry);
    expect(re.blockingFingerprint).toBe(rec.blockingFingerprint);
    expect(re.poseFingerprint).toBe(rec.poseFingerprint);
    expect(isShotBlockingStale((await pkg(repo, shotA.id)).spatialReference!)).toBe(false);
  });
});

describe("renders carry the blocking they showed", () => {
  const clip = (over: Record<string, unknown> = {}) => ({
    pathFingerprint: "p",
    audioMixFingerprint: null as string | null,
    blockingFingerprint: null as string | null,
    renderedAt: "2026-10-16T00:00:00Z",
    ...over,
  });

  it("only a visible figure counts as part of the picture", () => {
    const e = newBlockingEntry("c1");
    const anchor = { locationId: "l" };
    expect(renderedBlockingFingerprint([], anchor)).toBeNull();
    expect(renderedBlockingFingerprint([{ ...e, visibility: false }], anchor)).toBeNull();
    expect(renderedBlockingFingerprint([e], anchor)).toBe(renderedBlockingFingerprint([e], anchor));
    const prov = renderedBlockingProvenance(
      [{ id: "bid", characterId: "c1", revision: 3, entry: e, sceneRevision: 1, sceneFingerprint: "s" }],
      anchor,
    )!;
    expect(prov.figures).toEqual([
      { characterId: "c1", blockingId: "bid", revision: 3, fingerprint: blockingFingerprint(e, anchor) },
    ]);
    expect(JSON.stringify(prov)).not.toMatch(/https?:|blob:|token/i);
  });

  it("a previs made before any blocking becomes stale once blocking appears — silent or not", () => {
    const old = clip();
    expect(pickCurrentClip([old], "p", null, null)).toBe(old);
    expect(pickCurrentClip([old], "p", null, "bfp")).toBeNull();
    const withBlocking = clip({ blockingFingerprint: "bfp" });
    expect(pickCurrentClip([old, withBlocking], "p", null, "bfp")).toBe(withBlocking);
    // a silent previs ignores audio changes but NOT blocking changes
    expect(pickCurrentClip([clip({ blockingFingerprint: "bfp" })], "p", "other-audio", "bfp")).not.toBeNull();
    expect(pickCurrentClip([clip({ blockingFingerprint: "bfp" })], "p", null, "bfp2")).toBeNull();
  });

  it("stale reasons list blocking next to scene, camera and audio", () => {
    const base = {
      clip: {
        sceneFingerprint: "s",
        pathFingerprint: "p",
        audioMixFingerprint: null,
        blockingFingerprint: "b1",
      },
      currentSceneFingerprint: "s",
      currentPathFingerprint: "p",
      currentAudioMixFingerprint: "any-audio",
    };
    expect(previsStaleReasons({ ...base, currentBlockingFingerprint: "b1" })).toEqual([]);
    expect(previsStaleReasons({ ...base, currentBlockingFingerprint: "b2" })).toEqual(["blocking"]);
    expect(
      previsStaleReasons({ ...base, currentSceneFingerprint: "x", currentBlockingFingerprint: null }),
    ).toEqual(["scene", "blocking"]);
    // a clip rendered before M2B (no field) is current only while there is still no blocking
    const legacy = {
      ...base,
      clip: { sceneFingerprint: "s", pathFingerprint: "p", audioMixFingerprint: null },
    };
    expect(previsStaleReasons(legacy)).toEqual([]);
    expect(previsStaleReasons({ ...legacy, currentBlockingFingerprint: "b1" })).toEqual(["blocking"]);
  });

  it("the package references a previs only when it showed the CURRENT blocking; history is kept", async () => {
    const { repo, shotA, yumeko, save, project, scene, location } = await setup();
    const savedPath = await repo.previs.saveCameraPath({
      id: "path-1",
      projectId: project.id,
      shotId: shotA.id,
      locationId: location.id,
      sceneDocumentId: scene.id,
      sceneRevision: scene.revision,
      sceneFingerprint: scene.sceneFingerprint,
      path: buildHotelCanopyCameraPath(),
      expectedRevision: null,
      userId: null,
      now: iso,
    });
    const record = (id: string, blocking: ReturnType<typeof renderedBlockingProvenance>) =>
      repo.previs.recordPrevisClip({
        id,
        projectId: project.id,
        shotId: shotA.id,
        locationId: location.id,
        cameraPathId: savedPath.id,
        pathRevision: savedPath.revision,
        pathFingerprint: savedPath.pathFingerprint,
        sceneDocumentId: scene.id,
        sceneRevision: scene.revision,
        sceneFingerprint: scene.sceneFingerprint,
        assetId: `asset-${id}`,
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
        blockingFingerprint: blocking?.fingerprint ?? null,
        blocking: blocking?.figures ?? null,
        renderedAt: id === "clip-1" ? "2026-10-16T00:00:01Z" : "2026-10-16T00:00:02Z",
        userId: null,
      });

    await record("clip-1", null); // made before any blocking existed
    expect((await pkg(repo, shotA.id)).spatialReference!.cameraMotion!.previsAssetId).toBe("asset-clip-1");

    const entry = newBlockingEntry(yumeko.id, { x: 1, y: 0, z: -2 });
    const first = await save(shotA.id, entry, null);
    // the old silent previs does not show Yumeko's proxy any more
    expect((await pkg(repo, shotA.id)).spatialReference!.cameraMotion!.previsAssetId).toBeNull();

    const prov1 = renderedBlockingProvenance(
      [
        {
          id: first.id,
          characterId: first.characterId,
          revision: first.revision,
          entry: first.entry,
          sceneRevision: 1,
          sceneFingerprint: first.sceneFingerprint,
        },
      ],
      { locationId: location.id },
    );
    await record("clip-2", prov1);
    expect((await pkg(repo, shotA.id)).spatialReference!.cameraMotion!.previsAssetId).toBe("asset-clip-2");

    // changing Yumeko's pose makes clip-2 stale; neither clip is deleted or rewritten
    await save(
      shotA.id,
      { ...entry, pose: setPoseJoint(entry.pose, "leftLowerArm", quatFromAxisAngle("x", -70 * DEG)) },
      first.revision,
    );
    expect((await pkg(repo, shotA.id)).spatialReference!.cameraMotion!.previsAssetId).toBeNull();
    const clips = await repo.previs.listPrevisClips(shotA.id);
    expect(clips.map((c) => c.id).sort()).toEqual(["clip-1", "clip-2"]);
    expect(clips.find((c) => c.id === "clip-2")!.blocking).toEqual(prov1!.figures);
  });
});

describe("GenerationPackage blocking", () => {
  it("is optional: a Shot without blocking has the same package bytes as before M2B", async () => {
    const { repo, shotB } = await setup();
    // a bookmark-only spatial reference
    const p = await pkg(repo, shotB.id);
    expect(JSON.stringify(p)).not.toContain("shotBlocking");
  });

  it("freezes the blocking BY VALUE, with identity kept in a separate channel", async () => {
    const { repo, shotA, yumeko, sean, save } = await setup();
    const [y, s] = buildHotelCanopyShotBlocking({ yumekoId: yumeko.id, seanId: sean.id });
    await save(shotA.id, y!, null);
    await save(shotA.id, s!, null);
    const a = await pkg(repo, shotA.id);
    const aJson = JSON.stringify(a);
    const ref = a.spatialReference!.shotBlocking!;
    expect(ref.schemaVersion).toBe(1);
    expect(ref.figures).toHaveLength(2);
    const fy = ref.figures.find((f) => f.characterId === yumeko.id)!;
    expect(fy).toMatchObject({ rigVersion: "prism.humanoid-rig.v1", visible: true, revision: 1 });
    expect(fy.root.position).toEqual(y!.root.position);
    expect(fy.root.heightMeters).toBeCloseTo(1.7, 3);
    expect(fy.pose.schemaVersion).toBe(1);
    expect(Object.keys(fy.pose.joints).sort()).toEqual(["head", "neck"]);
    expect(fy.summary).toMatch(/^Yumeko: standing at \(-0\.8, 0\.0, -4\.6\)/);
    expect(ref.layerFingerprint).toHaveLength(64);

    // the blocking channel never describes appearance
    const blockingJson = JSON.stringify(ref).toLowerCase();
    for (const word of ["hair", "wardrobe", "skin", "face", "likeness", "look", "identity"]) {
      expect(blockingJson, word).not.toContain(`"${word}`);
    }

    // historical immutability: change live blocking, compile again
    const live = (await repo.previs.listShotBlocking(shotA.id)).find((r) => r.characterId === yumeko.id)!;
    await save(shotA.id, { ...y!, pose: presetById("seated").pose }, live.revision);
    const b = await pkg(repo, shotA.id);
    expect(JSON.stringify(a)).toBe(aJson); // package A is a value
    expect(b.provenance.fingerprint).not.toBe(a.provenance.fingerprint);
    const fb = b.spatialReference!.shotBlocking!.figures.find((f) => f.characterId === yumeko.id)!;
    expect(fb.fingerprint).not.toBe(fy.fingerprint);
    expect(fb.revision).toBe(2);
    expect(b.spatialReference!.shotBlocking!.layerFingerprint).not.toBe(ref.layerFingerprint);
    expect(fy.pose.joints).not.toHaveProperty("leftUpperLeg");
    expect(fb.pose.joints).toHaveProperty("leftUpperLeg");

    // editing the frozen object cannot reach the live row
    a.spatialReference!.shotBlocking!.figures[0]!.root.position.x = 999;
    expect((await repo.previs.listShotBlocking(shotA.id))[0]!.entry.root.position.x).not.toBe(999);
  });

  it("a hidden proxy is still frozen but not part of the rendered layer", async () => {
    const { repo, shotA, yumeko, save } = await setup();
    await save(shotA.id, { ...newBlockingEntry(yumeko.id), visibility: false }, null);
    const ref = (await pkg(repo, shotA.id)).spatialReference!.shotBlocking!;
    expect(ref.figures[0]!.visible).toBe(false);
    expect(ref.layerFingerprint).toBeNull();
  });

  it("does not disturb the legacy scene-level characterBlocking list", async () => {
    const { repo, shotA, yumeko, save } = await setup();
    await save(shotA.id, newBlockingEntry(yumeko.id), null);
    const ref = (await pkg(repo, shotA.id)).spatialReference!;
    expect(Array.isArray(ref.characterBlocking)).toBe(true);
    expect(ref.characterBlocking.every((c) => "objectId" in c)).toBe(true);
  });
});
