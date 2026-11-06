import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { newBlockingEntry, onCurrentSet, renderedBlockingProvenance } from "@/domain/previs/blocking";
import { buildPrevisDocument } from "@/domain/previs/document";
import { buildHotelCanopyEngineScene } from "@/domain/previs/hotel-canopy";
import {
  SHOT_LIGHTING_SCHEMA,
  authoredLightingIntent,
  lightingFingerprint,
  newShotLight,
  parseShotLightingRig,
} from "@/domain/previs/lighting";
import { SAME_LOCATION_ONLY, SETUP_CHANGED, SETUP_SHOT_GONE } from "@/domain/previs/setup-copy";
import { bookmarkCameraFingerprint } from "@/domain/previs/spatial-passes";
import { PREVIS_PRODUCTION_FRAME } from "@/domain/previs/types";
import { shotSchema } from "@/domain/schemas";

/**
 * Phase 4D: "Copy setup from…" copies VALUES, never references. Exercised through the REAL server actions on the
 * in-memory repository: independence both ways, source deletion, fingerprints and staleness, Project / Location
 * scoping without existence leaks, atomicity, stale-review refusal, and the Master Frame path reading only the
 * destination's own rows afterwards.
 */
const world = vi.hoisted(() => ({ repo: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth", () => ({ requireUser: async () => ({ kind: "memory", id: "tester" }) }));
vi.mock("@/server/repo", () => ({
  getRepo: async () => world.repo,
  requireProjectFresh: async (slug: string) => {
    const data = await (world.repo as MemoryRepository).loadProject(slug);
    if (!data) throw new (await import("../action-result")).UserFacingError("That project no longer exists.");
    return data;
  },
}));
vi.mock("@/server/previs", () => ({ getPrevisRepo: async () => (world.repo as MemoryRepository).previs }));
const storage = {
  name: "local",
  bucket: null,
  put: async () => undefined,
  get: async () => null,
  signedUrl: async () => null,
  remove: async () => undefined,
};
vi.mock("@/server/storage", () => ({
  checksum: (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
  getUploadStorage: async () => storage,
  storageForAsset: async () => storage,
}));

import { captureMasterFrame, saveShotBlocking, saveShotLighting } from "../previs-actions";
import { copyShotSetup, previewShotSetupCopy } from "../setup-copy-actions";
import { currentSpatialStateFor, promotionStateFor } from "../master-frame-promotion";

const iso = "2026-11-05T00:00:00.000Z";

function png(): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const v = new DataView(b.buffer);
  v.setUint32(8, 13);
  b.set([0x49, 0x48, 0x44, 0x52], 12);
  v.setUint32(16, PREVIS_PRODUCTION_FRAME.width);
  v.setUint32(20, PREVIS_PRODUCTION_FRAME.height);
  return b;
}

async function setup() {
  const repo = new MemoryRepository();
  world.repo = repo;
  const data = (await repo.loadProject("ojousama"))!;
  const project = data.project;
  const shots = data.shots;
  const A = shots.find((s) => s.spatial.locationId)!;
  const loc = A.spatial.locationId!;
  const otherLoc = data.locations.find((l) => l.id !== loc)!.id;
  const B0 = shots.find((s) => s.id !== A.id)!;
  const C0 = shots.find((s) => s.id !== A.id && s.id !== B0.id)!;
  const [c1, c2] = data.characters;
  // B: same Location, its OWN lighting notes (so a copy must never carry A's); C: another Location
  const put = (s: (typeof shots)[number], over: Record<string, unknown>) =>
    repo.upsert(project.id, "shots", shotSchema.parse({ ...s, ...over, updatedAt: iso }));
  await put(B0, {
    spatial: { ...B0.spatial, locationId: loc },
    lighting: { ...B0.lighting, mood: "B's own cold morning mood" },
  });
  await put(C0, { spatial: { ...C0.spatial, locationId: otherLoc } });
  const fresh = async () => (await repo.loadProject(project.slug))!;
  const B = (await fresh()).shots.find((s) => s.id === B0.id)!;

  const doc = (dx = 0) => {
    const d = buildPrevisDocument({ engineScene: buildHotelCanopyEngineScene() });
    d.productionCamera!.position.x += dx;
    return d;
  };
  const scene = await repo.previs.saveScene({
    id: "scene-1",
    projectId: project.id,
    locationId: loc,
    document: doc(),
    expectedRevision: null,
    engineVersion: "t",
    userId: null,
    now: iso,
  });
  await repo.previs.saveScene({
    id: "scene-2",
    projectId: project.id,
    locationId: otherLoc,
    document: doc(),
    expectedRevision: null,
    engineVersion: "t",
    userId: null,
    now: iso,
  });
  const link = (shotId: string) =>
    repo.previs.setBookmark({
      id: `bm-${shotId}`,
      projectId: project.id,
      shotId,
      locationId: loc,
      sceneDocumentId: scene.id,
      userId: null,
      now: iso,
    });
  const form = (shotId: string, fields: Record<string, string>, slug = project.slug) => {
    const fd = new FormData();
    fd.set("projectSlug", slug);
    fd.set("shotId", shotId);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };
  const light = (shotId: string, intensity: number, expectedRevision: number | null) =>
    saveShotLighting(
      form(shotId, {
        locationId: loc,
        expectedRevision: expectedRevision === null ? "" : String(expectedRevision),
        rigJson: JSON.stringify({
          schema: SHOT_LIGHTING_SCHEMA,
          base: { mode: "replace" },
          lights: [{ ...newShotLight("point", "key"), id: "key-1", intensity }],
        }),
      }),
    );
  const block = (shotId: string, characterId: string, x: number, expectedRevision: number | null) =>
    saveShotBlocking(
      form(shotId, {
        locationId: loc,
        blockingJson: JSON.stringify({
          save: [{ entry: newBlockingEntry(characterId, { x, y: 0, z: 0 }), expectedRevision }],
          remove: [],
        }),
      }),
    );
  const preview = (destId: string, sourceId: string, components?: string[], slug?: string) =>
    previewShotSetupCopy(
      form(
        destId,
        { sourceShotId: sourceId, ...(components ? { components: JSON.stringify(components) } : {}) },
        slug,
      ),
    );
  const copy = (destId: string, sourceId: string, components: string[], token: string, slug?: string) =>
    copyShotSetup(
      form(destId, { sourceShotId: sourceId, components: JSON.stringify(components), token }, slug),
    );
  /** everything the destination owns, by value */
  const snapshot = async (shotId: string) => ({
    camera: await repo.previs.getBookmarkForShot(shotId),
    lighting: await repo.previs.getLightingRigForShot(shotId),
    blocking: await repo.previs.listShotBlocking(shotId),
  });
  const capture = async (shotId: string) => {
    const s = (await repo.previs.getSceneForLocation(loc))!;
    const bm = (await repo.previs.getBookmarkForShot(shotId))!;
    const rig = await repo.previs.getLightingRigForShot(shotId);
    const figures = onCurrentSet(await repo.previs.listShotBlocking(shotId), {
      locationId: loc,
      sceneDocumentId: s.id,
    });
    const fd = form(shotId, {
      blockingFingerprint: renderedBlockingProvenance(figures, { locationId: loc })?.fingerprint ?? "",
      locationId: loc,
      sceneRevision: String(s.revision),
      cameraFingerprint: bookmarkCameraFingerprint(bm.value),
      lightingFingerprint: rig?.lightingFingerprint ?? "",
    });
    fd.set("file", new File([png()], "master-frame.png", { type: "image/png" }));
    return captureMasterFrame(fd);
  };
  return {
    repo,
    project,
    A,
    B,
    C: C0,
    loc,
    otherLoc,
    c1: c1!,
    c2: c2!,
    scene,
    doc,
    link,
    light,
    block,
    preview,
    copy,
    snapshot,
    capture,
    fresh,
  };
}

type W = Awaited<ReturnType<typeof setup>>;

/** A with a full setup on the current set: camera, lighting, two blocked characters. */
async function withSourceSetup(w: W) {
  await w.link(w.A.id);
  expect((await w.light(w.A.id, 40, null)).ok).toBe(true);
  expect((await w.block(w.A.id, w.c1.id, 1, null)).ok).toBe(true);
  expect((await w.block(w.A.id, w.c2.id, 2, null)).ok).toBe(true);
}

async function copyAll(w: W, dest = w.B.id, src = w.A.id) {
  const p = await w.preview(dest, src);
  if (!p.ok) throw new Error(p.error);
  const r = await w.copy(dest, src, p.plan!.components, p.plan!.token);
  if (!r.ok) throw new Error(r.error);
  return { preview: p, result: r };
}

describe("Phase 4D: copy setup from another Shot — explicit copies, never live links", () => {
  let w: W;
  beforeEach(async () => {
    w = await setup();
    await withSourceSetup(w);
  });

  it("the preview shows exactly what would be copied and writes nothing", async () => {
    const before = await w.snapshot(w.B.id);
    const p = await w.preview(w.B.id, w.A.id);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.available).toEqual({ camera: true, lighting: true, blocking: true });
    expect(p.plan!.components).toEqual(["camera", "lighting", "blocking"]);
    expect(p.plan!.camera!.replaces).toBeNull();
    expect(p.plan!.lighting!.lightCount).toBe(1);
    expect(p.plan!.blocking!.figures.map((f) => f.characterId).sort()).toEqual([w.c1.id, w.c2.id].sort());
    expect(p.characters[w.c1.id]).toBe(w.c1.name);
    expect(await w.snapshot(w.B.id)).toEqual(before);
  });

  it("COPY: the destination receives its OWN rows with the source's values and identical fingerprints", async () => {
    const a = await w.snapshot(w.A.id);
    await copyAll(w);
    const b = await w.snapshot(w.B.id);
    // own rows: the destination's ids and Shot, never the source's
    expect(b.camera!.shotId).toBe(w.B.id);
    expect(b.camera!.id).not.toBe(a.camera!.id);
    expect(b.lighting!.shotId).toBe(w.B.id);
    expect(b.lighting!.id).not.toBe(a.lighting!.id);
    expect(b.blocking.every((r) => r.shotId === w.B.id)).toBe(true);
    expect(b.blocking.map((r) => r.id).some((id) => a.blocking.some((x) => x.id === id))).toBe(false);
    // the same values give the same content fingerprints
    expect(bookmarkCameraFingerprint(b.camera!.value)).toBe(bookmarkCameraFingerprint(a.camera!.value));
    expect(b.lighting!.lightingFingerprint).toBe(a.lighting!.lightingFingerprint);
    expect(b.blocking.map((r) => r.blockingFingerprint)).toEqual(
      a.blocking.map((r) => r.blockingFingerprint),
    );
    // the scene anchor travels with the value (a stale source stays visibly stale)
    expect([b.camera!.sceneRevision, b.lighting!.sceneRevision]).toEqual([
      a.camera!.sceneRevision,
      a.lighting!.sceneRevision,
    ]);
    // lighting keeps the DESTINATION's own authored notes, not the source's
    expect(b.lighting!.rig.authoredIntent).toEqual(authoredLightingIntent(w.B));
    expect(b.lighting!.rig.authoredIntent.lighting.mood).toBe("B's own cold morning mood");
    expect(a.lighting!.rig.authoredIntent).not.toEqual(b.lighting!.rig.authoredIntent);
    // the source is untouched by the copy
    expect(await w.snapshot(w.A.id)).toEqual(a);
  });

  it("COPY INDEPENDENCE: editing the source afterwards changes nothing on the destination", async () => {
    await copyAll(w);
    const b = await w.snapshot(w.B.id);
    const aRig = (await w.repo.previs.getLightingRigForShot(w.A.id))!;
    expect((await w.light(w.A.id, 99, aRig.revision)).ok).toBe(true);
    const aFig = (await w.repo.previs.listShotBlocking(w.A.id)).find((r) => r.characterId === w.c1.id)!;
    expect((await w.block(w.A.id, w.c1.id, 7, aFig.revision)).ok).toBe(true);
    // a new production camera on the set, re-linked for A only
    await w.repo.previs.saveScene({
      id: "x",
      projectId: w.project.id,
      locationId: w.loc,
      document: w.doc(3),
      expectedRevision: w.scene.revision,
      engineVersion: "t",
      userId: null,
      now: iso,
    });
    await w.link(w.A.id);
    const a2 = await w.snapshot(w.A.id);
    expect(a2.lighting!.lightingFingerprint).not.toBe(b.lighting!.lightingFingerprint);
    expect(bookmarkCameraFingerprint(a2.camera!.value)).not.toBe(bookmarkCameraFingerprint(b.camera!.value));
    expect(await w.snapshot(w.B.id)).toEqual(b);
  });

  it("REVERSE INDEPENDENCE: editing the destination changes nothing on the source", async () => {
    await copyAll(w);
    const a = await w.snapshot(w.A.id);
    const bRig = (await w.repo.previs.getLightingRigForShot(w.B.id))!;
    expect((await w.light(w.B.id, 5, bRig.revision)).ok).toBe(true);
    const bFig = (await w.repo.previs.listShotBlocking(w.B.id)).find((r) => r.characterId === w.c2.id)!;
    expect((await w.block(w.B.id, w.c2.id, 9, bFig.revision)).ok).toBe(true);
    expect(await w.snapshot(w.A.id)).toEqual(a);
  });

  it("SOURCE DELETION: deleting the source Shot leaves the destination complete and usable", async () => {
    await copyAll(w);
    const b = await w.snapshot(w.B.id);
    await w.repo.remove(w.project.id, "shots", w.A.id);
    expect((await w.fresh()).shots.some((s) => s.id === w.A.id)).toBe(false);
    expect(await w.snapshot(w.B.id)).toEqual(b);
    const r = await w.capture(w.B.id);
    expect(r.ok).toBe(true);
    // and a copy FROM the deleted Shot is refused like any unknown Shot
    const gone = await w.preview(w.B.id, w.A.id);
    expect(gone).toEqual({ ok: false, error: SETUP_SHOT_GONE });
  });

  it("NO LIVE LINK: after the copy the destination's capture and spatial state never read the source", async () => {
    await copyAll(w);
    const previs = w.repo.previs;
    const reads: string[] = [];
    for (const m of ["getBookmarkForShot", "getLightingRigForShot", "listShotBlocking"] as const) {
      const orig = previs[m].bind(previs) as (id: string) => Promise<unknown>;
      vi.spyOn(previs, m).mockImplementation(((id: string) => {
        reads.push(id);
        return orig(id);
      }) as never);
    }
    const r = await w.capture(w.B.id);
    expect(r.ok).toBe(true);
    const st = await currentSpatialStateFor(previs, { shotId: w.B.id, locationId: w.loc });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((id) => id === w.B.id)).toBe(true);
    const mf = (await previs.listMasterFrames(w.B.id))[0]!;
    const own = (await previs.getBookmarkForShot(w.B.id))!;
    expect(mf.cameraBookmarkId).toBe(own.id);
    expect(mf.camera!.bookmarkId).toBe(own.id);
    expect(mf.lightingFingerprint).toBe((await previs.getLightingRigForShot(w.B.id))!.lightingFingerprint);
    expect(st.cameraFingerprint).toBe(bookmarkCameraFingerprint(own.value));
    vi.restoreAllMocks();
  });

  it("FRAMES: a source edit stales only the source's Master Frame; the destination's stays fresh", async () => {
    await copyAll(w);
    expect((await w.capture(w.A.id)).ok).toBe(true);
    expect((await w.capture(w.B.id)).ok).toBe(true);
    const mfA = (await w.repo.previs.listMasterFrames(w.A.id))[0]!;
    const mfB = (await w.repo.previs.listMasterFrames(w.B.id))[0]!;
    const aRig = (await w.repo.previs.getLightingRigForShot(w.A.id))!;
    expect((await w.light(w.A.id, 77, aRig.revision)).ok).toBe(true);
    const stA = await promotionStateFor(w.repo.previs, mfA, { shotId: w.A.id, locationId: w.loc });
    const stB = await promotionStateFor(w.repo.previs, mfB, { shotId: w.B.id, locationId: w.loc });
    expect(stA.stale).toContain("lighting");
    expect(stB.stale).toEqual([]);
    expect(stB.requiresConfirmation).toBe(false);
  });

  it("a later copy over the destination stales the destination's own earlier Master Frame (it changed B)", async () => {
    await copyAll(w);
    expect((await w.capture(w.B.id)).ok).toBe(true);
    const mfB = (await w.repo.previs.listMasterFrames(w.B.id))[0]!;
    const aRig = (await w.repo.previs.getLightingRigForShot(w.A.id))!;
    expect((await w.light(w.A.id, 12, aRig.revision)).ok).toBe(true);
    await copyAll(w); // B now takes A's new lighting, explicitly
    const st = await promotionStateFor(w.repo.previs, mfB, { shotId: w.B.id, locationId: w.loc });
    expect(st.stale).toContain("lighting");
  });

  it("a copy can choose parts; unchosen parts of the destination are left exactly as they were", async () => {
    await w.link(w.B.id);
    const before = await w.snapshot(w.B.id);
    const p = await w.preview(w.B.id, w.A.id, ["lighting"]);
    expect(p.ok && p.plan!.components).toEqual(["lighting"]);
    if (!p.ok) return;
    expect((await w.copy(w.B.id, w.A.id, ["lighting"], p.plan!.token)).ok).toBe(true);
    const after = await w.snapshot(w.B.id);
    expect(after.camera).toEqual(before.camera);
    expect(after.blocking).toEqual(before.blocking);
    expect(after.lighting!.lightingFingerprint).toBe(
      (await w.repo.previs.getLightingRigForShot(w.A.id))!.lightingFingerprint,
    );
  });

  it("copying blocking REPLACES the destination's blocking and says which figures it removes", async () => {
    const [c3] = (await w.fresh()).characters.filter((c) => c.id !== w.c1.id && c.id !== w.c2.id);
    expect((await w.block(w.B.id, c3!.id, 4, null)).ok).toBe(true);
    const p = await w.preview(w.B.id, w.A.id, ["blocking"]);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.plan!.blocking!.removes.map((r) => r.characterId)).toEqual([c3!.id]);
    expect((await w.copy(w.B.id, w.A.id, ["blocking"], p.plan!.token)).ok).toBe(true);
    const ids = (await w.repo.previs.listShotBlocking(w.B.id)).map((r) => r.characterId).sort();
    expect(ids).toEqual([w.c1.id, w.c2.id].sort());
  });

  it("a stale review is refused and writes nothing (the source changed after the preview)", async () => {
    const p = await w.preview(w.B.id, w.A.id);
    if (!p.ok) throw new Error(p.error);
    const aRig = (await w.repo.previs.getLightingRigForShot(w.A.id))!;
    expect((await w.light(w.A.id, 55, aRig.revision)).ok).toBe(true);
    const before = await w.snapshot(w.B.id);
    const r = await w.copy(w.B.id, w.A.id, p.plan!.components, p.plan!.token);
    expect(r).toEqual({ ok: false, error: SETUP_CHANGED, conflict: true });
    expect(await w.snapshot(w.B.id)).toEqual(before);
  });

  it("a stale review is refused when the DESTINATION changed after the preview (never a silent overwrite)", async () => {
    const p = await w.preview(w.B.id, w.A.id);
    if (!p.ok) throw new Error(p.error);
    expect((await w.light(w.B.id, 3, null)).ok).toBe(true);
    const before = await w.snapshot(w.B.id);
    const r = await w.copy(w.B.id, w.A.id, p.plan!.components, p.plan!.token);
    expect(r.ok).toBe(false);
    expect(await w.snapshot(w.B.id)).toEqual(before);
  });

  it("a copy must name the reviewed token; a forged or missing one is refused", async () => {
    const before = await w.snapshot(w.B.id);
    expect((await w.copy(w.B.id, w.A.id, ["camera"], "")).ok).toBe(false);
    const forged = await w.copy(w.B.id, w.A.id, ["camera"], "0".repeat(64));
    expect(forged).toEqual({ ok: false, error: SETUP_CHANGED, conflict: true });
    expect(await w.snapshot(w.B.id)).toEqual(before);
  });

  it("ATOMICITY: a failure while building the copy leaves the destination exactly as it was", async () => {
    const p = await w.preview(w.B.id, w.A.id);
    if (!p.ok) throw new Error(p.error);
    // the last part (blocking) cannot be written: its character left the Project after the review
    await w.repo.remove(w.project.id, "characters", w.c2.id);
    const before = await w.snapshot(w.B.id);
    const r = await w.copy(w.B.id, w.A.id, p.plan!.components, p.plan!.token);
    expect(r.ok).toBe(false);
    const after = await w.snapshot(w.B.id);
    expect(after).toEqual(before);
    expect(after.camera).toBeNull(); // camera and lighting were NOT written ahead of the failure
    expect(after.lighting).toBeNull();
  });

  it("CROSS-LOCATION: a copy between Shots in different Locations is refused", async () => {
    const r = await w.preview(w.C.id, w.A.id);
    expect(r).toEqual({ ok: false, error: SAME_LOCATION_ONLY });
  });

  it("a Shot cannot copy onto itself, and an unknown part name is refused", async () => {
    expect((await w.preview(w.A.id, w.A.id)).ok).toBe(false);
    const bad = await w.preview(w.B.id, w.A.id, ["camera", "sound"]);
    expect(bad.ok).toBe(false);
  });

  it("a part the source does not have on the current set cannot be copied", async () => {
    const p = await w.preview(w.A.id, w.B.id); // B has nothing yet
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.available).toEqual({ camera: false, lighting: false, blocking: false });
    expect(p.plan).toBeNull();
    const forced = await w.preview(w.A.id, w.B.id, ["camera"]);
    expect(forced.ok).toBe(false);
  });
});

describe("Phase 4D: Project scoping and no existence leaks", () => {
  it("CROSS-PROJECT: another Project's Shot is neither a source nor a destination, with one indistinguishable answer", async () => {
    const w = await setup();
    await withSourceSetup(w);
    // a second, foreign Project holding a Shot set in an identically named Location
    const mine = (await w.fresh())!;
    const foreignId = "00000000-0000-4000-8000-0000000f0e19";
    const foreignSlug = "foreign-project";
    await w.repo.createProject(
      { ...mine.project, id: foreignId, slug: foreignSlug },
      { ...mine.bible, projectId: foreignId },
    );
    const foreignShotId = "00000000-0000-4000-8000-0000000f0e1a";
    await w.repo.upsert(
      foreignId,
      "shots",
      shotSchema.parse({ ...w.A, id: foreignShotId, projectId: foreignId }),
    );
    expect((await w.repo.loadProject(foreignSlug))!.shots.map((x) => x.id)).toEqual([foreignShotId]);
    const unknown = "00000000-0000-4000-8000-00000000abcd";
    const answers = [await w.preview(w.B.id, unknown), await w.preview(unknown, w.A.id)];
    answers.push(await w.preview(w.B.id, foreignShotId)); // a foreign source into my Shot
    answers.push(await w.preview(foreignShotId, w.A.id)); // my source into a foreign Shot
    answers.push(await w.preview(foreignShotId, w.A.id, undefined, foreignSlug)); // my source, via the foreign slug
    for (const a of answers) expect(a).toEqual({ ok: false, error: SETUP_SHOT_GONE });
    const before = await w.snapshot(w.B.id);
    expect((await w.copy(w.B.id, unknown, ["camera"], "0".repeat(64))).ok).toBe(false);
    expect(await w.snapshot(w.B.id)).toEqual(before);
  });

  it("an unreadable Project gets the same refusal as a missing one, before any Shot is looked at", async () => {
    const w = await setup();
    await withSourceSetup(w);
    const r = await w.preview(w.B.id, w.A.id, undefined, "someone-elses-project");
    expect(r).toEqual({ ok: false, error: "That project no longer exists." });
    const c = await w.copy(w.B.id, w.A.id, ["camera"], "0".repeat(64), "someone-elses-project");
    expect(c).toEqual({ ok: false, error: "That project no longer exists." });
  });

  it("the repository rechecks both Shots' Location inside the copy (a Shot moved after review is refused)", async () => {
    const w = await setup();
    await withSourceSetup(w);
    const p = await w.preview(w.B.id, w.A.id);
    if (!p.ok) throw new Error(p.error);
    const scene = (await w.repo.previs.getSceneForLocation(w.loc))!;
    const now = (await w.fresh()).shots.find((s) => s.id === w.B.id)!;
    await w.repo.upsert(
      w.project.id,
      "shots",
      shotSchema.parse({ ...now, spatial: { ...now.spatial, locationId: w.otherLoc }, updatedAt: iso }),
    );
    await expect(
      w.repo.previs.copyShotSetup({
        projectId: w.project.id,
        sourceShotId: w.A.id,
        destinationShotId: w.B.id,
        locationId: w.loc,
        sceneDocumentId: scene.id,
        components: p.plan!.components,
        expectedToken: p.plan!.token,
        destinationIntent: authoredLightingIntent(w.B),
        userId: null,
        now: iso,
      }),
    ).rejects.toThrow(SETUP_CHANGED);
    expect(await w.snapshot(w.B.id)).toEqual({ camera: null, lighting: null, blocking: [] });
  });

  it("the repository itself refuses a source or destination outside the Project (defence in depth)", async () => {
    const w = await setup();
    await withSourceSetup(w);
    const scene = (await w.repo.previs.getSceneForLocation(w.loc))!;
    const base = {
      projectId: "another-project",
      sourceShotId: w.A.id,
      destinationShotId: w.B.id,
      locationId: w.loc,
      sceneDocumentId: scene.id,
      components: ["camera" as const],
      expectedToken: "0".repeat(64),
      destinationIntent: authoredLightingIntent(w.B),
      userId: null,
      now: iso,
    };
    await expect(w.repo.previs.copyShotSetup(base)).rejects.toThrow();
    expect(await w.repo.previs.getBookmarkForShot(w.B.id)).toBeNull();
  });
});

describe("Phase 4D: fingerprints are content-only", () => {
  it("identical lights give the identical lighting fingerprint whatever the Shot's notes", () => {
    const lights = [{ ...newShotLight("point", "key"), id: "k" }];
    const fp = (mood: string) =>
      lightingFingerprint(
        parseShotLightingRig({
          schema: SHOT_LIGHTING_SCHEMA,
          base: { mode: "replace" },
          lights,
          authoredIntent: {
            lighting: {
              keyDirection: "",
              fill: "",
              practicals: "",
              colorTemperature: "",
              mood,
              referenceAssetId: null,
              continuity: "",
            },
            timeOfDay: "",
            weather: "",
          },
        }),
      );
    expect(fp("warm")).toBe(fp("cold"));
  });
});
