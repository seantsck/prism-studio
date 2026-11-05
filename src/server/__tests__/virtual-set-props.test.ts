import { describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { buildPrevisDocument } from "@/domain/previs/document";
import { buildHotelCanopyEngineScene } from "@/domain/previs/hotel-canopy";
import {
  SHOT_LIGHTING_SCHEMA,
  authoredLightingIntent,
  newShotLight,
  parseShotLightingRig,
} from "@/domain/previs/lighting";
import { shotSchema, type ProjectData } from "@/domain/schemas";

vi.mock("server-only", () => ({}));

import { loadVirtualSetProps } from "../virtual-set-props";

/**
 * Phase 4C-I2: the ONE editor loader shared by the Location 3D page and the Shot Spatial Workspace, on the in-memory
 * repository. Each test asserts the few facts that matter (no snapshots of the whole prop object).
 */
const iso = "2026-11-04T00:00:00.000Z";

async function world() {
  const repo = new MemoryRepository();
  let data = (await repo.loadProject("ojousama"))!;
  const project = data.project;
  // two Shots on the same Location L (the shared set), plus a second Location M without any 3D set
  const byLoc = new Map<string, ProjectData["shots"]>();
  for (const s of data.shots)
    if (s.spatial.locationId)
      byLoc.set(s.spatial.locationId, [...(byLoc.get(s.spatial.locationId) ?? []), s]);
  const [L, onL] = [...byLoc].find(([, list]) => list.length >= 2)!;
  const [a, b] = onL;
  const M = data.locations.find((l) => l.id !== L)!.id;
  const location = (id: string) => data.locations.find((l) => l.id === id)!;

  const save = (locationId: string, cameraX: number, expectedRevision: number | null) => {
    const s = buildHotelCanopyEngineScene() as unknown as { cameras: Array<Record<string, unknown>> };
    const cam = s.cameras.find((c) => c.id !== "main")!;
    cam.position = { ...(cam.position as object), x: cameraX };
    return repo.previs.saveScene({
      id: `scene-${locationId}`,
      projectId: project.id,
      locationId,
      document: buildPrevisDocument({ engineScene: s }),
      expectedRevision,
      engineVersion: "t",
      userId: null,
      now: iso,
    });
  };
  const sceneL = await save(L, 1, null);
  const bookmark = (shotId: string, locationId: string, sceneDocumentId: string, id: string) =>
    repo.previs.setBookmark({
      id,
      projectId: project.id,
      shotId,
      locationId,
      sceneDocumentId,
      userId: null,
      now: iso,
    });
  await bookmark(a!.id, L, sceneL.id, "bm-a");
  const rig = (
    shotId: string,
    shot: ProjectData["shots"][number],
    intensity: number,
    sceneId: string,
    loc: string,
  ) =>
    repo.previs.saveLightingRig({
      id: `rig-${shotId}`,
      projectId: project.id,
      shotId,
      locationId: loc,
      sceneDocumentId: sceneId,
      sceneRevision: 1,
      sceneFingerprint: sceneL.sceneFingerprint,
      rig: parseShotLightingRig({
        schema: SHOT_LIGHTING_SCHEMA,
        base: { mode: "replace" },
        lights: [{ ...newShotLight("point", "key"), intensity }],
        authoredIntent: authoredLightingIntent(shot),
      }),
      expectedRevision: null,
      userId: null,
      now: iso,
    });
  await rig(a!.id, a!, 2, sceneL.id, L);

  const reload = async () => (data = (await repo.loadProject("ojousama"))!);
  const assign = async (shotId: string, locationId: string | null) => {
    const shot = data.shots.find((s) => s.id === shotId)!;
    await repo.upsert(
      project.id,
      "shots",
      shotSchema.parse({ ...shot, spatial: { ...shot.spatial, locationId }, updatedAt: iso }),
    );
    await reload();
  };
  const load = (locationId: string, activeShotId: string | null, kind: "location" | "shot") =>
    loadVirtualSetProps({
      slug: "ojousama",
      data,
      previs: repo.previs,
      location: location(locationId),
      activeShotId,
      context: kind === "location" ? { kind } : { kind, shotPrepHref: "/prep" },
    });
  return { repo, L, M, a: a!, b: b!, sceneL, save, bookmark, assign, load, reload, data: () => data };
}

describe("loadVirtualSetProps (Phase 4C-I2 shared loader)", () => {
  it("Location mode with no Shot: the set and its Shot list, no Shot-owned state", async () => {
    const w = await world();
    const p = await w.load(w.L, null, "location");
    expect(p.mode.kind).toBe("location");
    expect(p.activeShotId).toBeNull();
    expect(p.scene.sceneDocumentId).toBe(w.sceneL.id);
    expect(p.scene.baseEnvironmentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(p.mode.kind === "location" && p.mode.shots.map((s) => s.id)).toEqual(
      expect.arrayContaining([w.a.id, w.b.id]),
    );
    expect(p.bookmark).toBeNull();
    expect(p.shotLighting).toBeNull();
    // every Shot on L is affected by a save
    expect(p.sharedWith.map((s) => s.id)).toEqual(expect.arrayContaining([w.a.id, w.b.id]));
  });

  it("Location mode A and B: each gets ONLY its own Shot-owned state", async () => {
    const w = await world();
    const pa = await w.load(w.L, w.a.id, "location");
    const pb = await w.load(w.L, w.b.id, "location");
    expect(pa.activeShotId).toBe(w.a.id);
    expect(pa.bookmark?.id).toBe("bm-a");
    expect(pa.shotLighting?.rig?.shotId).toBe(w.a.id);
    expect(pb.activeShotId).toBe(w.b.id);
    expect(pb.bookmark).toBeNull();
    expect(pb.shotLighting?.rig).toBeNull();
    expect(pb.masterFrames).toEqual([]);
    // the same Location set for both
    expect(pb.scene.sceneDocumentId).toBe(pa.scene.sceneDocumentId);
  });

  it("an unknown ?shot= is not opened in Location mode", async () => {
    const w = await world();
    expect((await w.load(w.L, "no-such-shot", "location")).activeShotId).toBeNull();
  });

  it("Shot mode: the route's Shot on its CURRENT Location, no selector list, sharedWith excludes it", async () => {
    const w = await world();
    const p = await w.load(w.L, w.a.id, "shot");
    expect(p.mode.kind).toBe("shot");
    expect(p.mode.kind === "shot" && p.mode.shot.id).toBe(w.a.id);
    expect(p.mode.kind === "shot" && p.mode.shotPrepHref).toBe("/prep");
    expect(p.locationId).toBe(w.L);
    expect(p.bookmark?.id).toBe("bm-a");
    expect(p.sharedWith.map((s) => s.id)).toContain(w.b.id);
    expect(p.sharedWith.map((s) => s.id)).not.toContain(w.a.id);
  });

  it("Shot mode on a Location with no scene: an empty new set (nothing is created)", async () => {
    const w = await world();
    await w.assign(w.a.id, w.M);
    const p = await w.load(w.M, w.a.id, "shot");
    expect(p.scene).toEqual({
      sceneDocumentId: null,
      revision: null,
      fingerprint: null,
      baseEnvironmentFingerprint: null,
      engineScene: null,
    });
    expect(await w.repo.previs.getSceneForLocation(w.M)).toBeNull();
  });

  it("A -> B reassignment: old-Location rows are history, never current working state", async () => {
    const w = await world();
    await w.assign(w.a.id, w.M);
    const sceneM = await w.save(w.M, 3, null);
    const p = await w.load(w.M, w.a.id, "shot");
    expect(p.scene.sceneDocumentId).toBe(sceneM.id);
    expect(p.bookmark).toBeNull(); // the L bookmark is not M's camera
    expect(p.blocking).toEqual([]);
    expect(p.cameraPath).toBeNull();
    // the rig is handed over for compare-and-set only; the panel never applies a rig of another Location
    expect(p.shotLighting?.rig?.locationId).toBe(w.L);
    // once M has its own camera, that one is current
    await w.bookmark(w.a.id, w.M, sceneM.id, "bm-a");
    expect((await w.load(w.M, w.a.id, "shot")).bookmark?.sceneFingerprint).toBe(sceneM.sceneFingerprint);
  });

  it("an old-Location Master Frame stays in the Shot's history, marked as captured on another Location", async () => {
    const w = await world();
    const bm = (await w.repo.previs.getBookmarkForShot(w.a.id))!;
    await w.repo.previs.recordMasterFrame({
      id: "mf-old",
      projectId: w.data().project.id,
      shotId: w.a.id,
      locationId: w.L,
      sceneDocumentId: w.sceneL.id,
      sceneRevision: w.sceneL.revision,
      sceneFingerprint: w.sceneL.sceneFingerprint,
      bookmarkId: bm.id,
      assetId: "asset-old",
      renderWidth: 1920,
      renderHeight: 804,
      capturedBy: null,
      capturedAt: iso,
      blockingFingerprint: null,
      lightingFingerprint: null,
      lighting: null,
    } as unknown as Parameters<typeof w.repo.previs.recordMasterFrame>[0]);
    await w.assign(w.a.id, w.M);
    await w.save(w.M, 3, null);
    const p = await w.load(w.M, w.a.id, "shot");
    expect(p.masterFrames.map((f) => [f.id, f.otherSet])).toEqual([["mf-old", true]]);
  });
});
