import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { PrevisError } from "@/data/previs-repository";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { buildPrevisDocument } from "../document";
import { buildHotelCanopyEngineScene } from "../hotel-canopy";
import { isBookmarkStale } from "../spatial";

const NOW = new Date("2026-10-15T00:00:00Z");

async function setup() {
  const repo = new MemoryRepository();
  const data = (await repo.loadProject("ojousama"))!;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  const location = data.locations[0]!;
  const character = data.characters[0]!;
  return { repo, data, shot, location, character, project: data.project };
}

const doc = (characterId: string, mutate?: (s: ReturnType<typeof buildHotelCanopyEngineScene>) => void) => {
  const s = buildHotelCanopyEngineScene({ characterId });
  mutate?.(s);
  return buildPrevisDocument({ engineScene: s });
};

const pkgFor = async (repo: MemoryRepository, slug = "ojousama", shotId: string) => {
  const data = (await repo.loadProject(slug))!;
  const refs = await repo.previs.listSpatialReferences(data.project.id);
  const withRefs = Object.keys(refs).length ? { ...data, spatialReferences: refs } : data;
  return assembleGenerationPackage(buildShotContext(withRefs, shotId), NOW);
};

describe("GenerationPackage spatial snapshot (Phase 2F)", () => {
  it("3D is optional: a shot without a set has no spatialReference key and an unchanged fingerprint", async () => {
    const { repo, shot, data } = await setup();
    const baseline = assembleGenerationPackage(buildShotContext(data, shot.id), NOW);
    const viaLoader = await pkgFor(repo, "ojousama", shot.id);
    expect("spatialReference" in baseline).toBe(false);
    expect("spatialReference" in viaLoader).toBe(false);
    expect(viaLoader.provenance.fingerprint).toBe(baseline.provenance.fingerprint);
    expect(JSON.stringify(viaLoader)).not.toContain("spatialReference");
  });

  it("does not change shot freshness parts, so existing approvals do not go stale", async () => {
    const { repo, shot, data, location, character, project } = await setup();
    const before = assembleGenerationPackage(buildShotContext(data, shot.id), NOW);
    const saved = await repo.previs.saveScene({
      id: "scene-1",
      projectId: project.id,
      locationId: location.id,
      document: doc(character.id),
      expectedRevision: null,
      engineVersion: "t",
      userId: null,
      now: NOW.toISOString(),
    });
    await repo.previs.setBookmark({
      id: "bm-1",
      projectId: project.id,
      shotId: shot.id,
      locationId: location.id,
      sceneDocumentId: saved.id,
      userId: null,
      now: NOW.toISOString(),
    });
    const after = await pkgFor(repo, "ojousama", shot.id);
    expect(after.provenance.parts).toEqual(before.provenance.parts);
    expect(after.provenance.fingerprint).not.toBe(before.provenance.fingerprint);
  });

  it("freezes location, revision, fingerprint, camera bookmark and character blocking", async () => {
    const { repo, shot, location, character, project } = await setup();
    const saved = await repo.previs.saveScene({
      id: "scene-1",
      projectId: project.id,
      locationId: location.id,
      document: doc(character.id),
      expectedRevision: null,
      engineVersion: "t",
      userId: null,
      now: NOW.toISOString(),
    });
    await repo.previs.setBookmark({
      id: "bm-1",
      projectId: project.id,
      shotId: shot.id,
      locationId: location.id,
      sceneDocumentId: saved.id,
      userId: null,
      now: NOW.toISOString(),
    });
    const pkg = await pkgFor(repo, "ojousama", shot.id);
    const ref = pkg.spatialReference!;
    expect(ref.schemaVersion).toBe(1);
    expect(ref.locationId).toBe(location.id);
    expect(ref.sceneRevision).toBe(1);
    expect(ref.sceneFingerprint).toBe(saved.sceneFingerprint);
    expect(ref.cameraBookmark).toMatchObject({ label: "CAM-A", sceneRevision: 1 });
    expect(ref.cameraBookmark?.value.productionAspectRatio).toBe("2.39:1");
    expect(ref.characterBlocking).toEqual([expect.objectContaining({ characterId: character.id })]);
    expect(ref.masterFrameAssetId).toBeNull();
    expect(isBookmarkStale(ref)).toBe(false);
  });

  it("historical packages are immutable: A stays, B gets the new fingerprint and the camera shows stale", async () => {
    const { repo, shot, location, character, project } = await setup();
    const saved = await repo.previs.saveScene({
      id: "scene-1",
      projectId: project.id,
      locationId: location.id,
      document: doc(character.id),
      expectedRevision: null,
      engineVersion: "t",
      userId: null,
      now: NOW.toISOString(),
    });
    await repo.previs.setBookmark({
      id: "bm-1",
      projectId: project.id,
      shotId: shot.id,
      locationId: location.id,
      sceneDocumentId: saved.id,
      userId: null,
      now: NOW.toISOString(),
    });
    const a = await pkgFor(repo, "ojousama", shot.id);
    const frozenA = JSON.stringify(a); // what an attempt stores (packageSnapshot)

    await repo.previs.saveScene({
      id: "scene-x",
      projectId: project.id,
      locationId: location.id,
      document: doc(character.id, (s) => (s.scene[4].position = { x: 9, y: 0.75, z: -1 })),
      expectedRevision: 1,
      engineVersion: "t",
      userId: null,
      now: NOW.toISOString(),
    });
    const b = await pkgFor(repo, "ojousama", shot.id);

    expect(JSON.stringify(a)).toBe(frozenA);
    expect(b.spatialReference?.sceneRevision).toBe(2);
    expect(b.spatialReference?.sceneFingerprint).not.toBe(a.spatialReference?.sceneFingerprint);
    expect(b.provenance.fingerprint).not.toBe(a.provenance.fingerprint);
    // the camera was authored against revision 1 and says so
    expect(b.spatialReference?.cameraBookmark?.sceneRevision).toBe(1);
    expect(isBookmarkStale(b.spatialReference!)).toBe(true);
  });

  it("an adopted master frame is frozen by asset id; an unadopted one is not", async () => {
    const { repo, data, shot, location, character, project } = await setup();
    const asset = data.assets[0]!;
    const saved = await repo.previs.saveScene({
      id: "scene-1",
      projectId: project.id,
      locationId: location.id,
      document: doc(character.id),
      expectedRevision: null,
      engineVersion: "t",
      userId: null,
      now: NOW.toISOString(),
    });
    const bm = await repo.previs.setBookmark({
      id: "bm-1",
      projectId: project.id,
      shotId: shot.id,
      locationId: location.id,
      sceneDocumentId: saved.id,
      userId: null,
      now: NOW.toISOString(),
    });
    const frame = await repo.previs.recordMasterFrame({
      id: "mf-1",
      projectId: project.id,
      shotId: shot.id,
      locationId: location.id,
      sceneDocumentId: saved.id,
      sceneRevision: 1,
      sceneFingerprint: saved.sceneFingerprint,
      cameraBookmarkId: bm.id,
      assetId: asset.id,
      renderWidth: 1912,
      renderHeight: 800,
      productionAspectRatio: "2.39:1",
      capturedAt: NOW.toISOString(),
      userId: null,
    });
    expect((await pkgFor(repo, "ojousama", shot.id)).spatialReference?.masterFrameAssetId).toBeNull();
    await repo.previs.adoptMasterFrame(frame.id, "sb-frame-1", NOW.toISOString());
    const pkg = await pkgFor(repo, "ojousama", shot.id);
    expect(pkg.spatialReference?.masterFrameAssetId).toBe(asset.id);
    expect(pkg.assets[asset.id]).toBeDefined();
  });

  it("memory store enforces the same rules as the database", async () => {
    const { repo, shot, location, character, project } = await setup();
    const input = {
      id: "scene-1",
      projectId: project.id,
      locationId: location.id,
      document: doc(character.id),
      engineVersion: "t",
      userId: null,
      now: NOW.toISOString(),
    };
    await repo.previs.saveScene({ ...input, expectedRevision: null });
    await expect(repo.previs.saveScene({ ...input, expectedRevision: null })).rejects.toThrow(PrevisError);
    await expect(repo.previs.saveScene({ ...input, expectedRevision: 7 })).rejects.toThrow(
      /changed elsewhere/,
    );
    await expect(
      repo.previs.setBookmark({
        id: "b",
        projectId: project.id,
        shotId: "no-such-shot",
        locationId: location.id,
        sceneDocumentId: "scene-1",
        userId: null,
        now: NOW.toISOString(),
      }),
    ).rejects.toThrow(/shot is not in this project/);
    void shot;
  });
});
