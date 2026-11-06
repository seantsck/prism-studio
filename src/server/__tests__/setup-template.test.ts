import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { newBlockingEntry, onCurrentSet, renderedBlockingProvenance } from "@/domain/previs/blocking";
import { buildPrevisDocument } from "@/domain/previs/document";
import { buildHotelCanopyEngineScene } from "@/domain/previs/hotel-canopy";
import { SHOT_LIGHTING_SCHEMA, authoredLightingIntent, newShotLight } from "@/domain/previs/lighting";
import { SETUP_CHANGED, SETUP_SHOT_GONE } from "@/domain/previs/setup-copy";
import { TEMPLATE_GONE, TEMPLATE_OTHER_SET } from "@/domain/previs/setup-template";
import { bookmarkCameraFingerprint } from "@/domain/previs/spatial-passes";
import { PREVIS_PRODUCTION_FRAME } from "@/domain/previs/types";
import { shotSchema } from "@/domain/schemas";

/**
 * Phase 4D-I2: named setup templates are SOURCES FOR COPIES, never runtime dependencies. Exercised through the REAL
 * server actions on the in-memory repository: snapshot independence, apply independence both ways, template edits and
 * deletion never reaching a Shot, safe provenance after deletion, no template read by capture / spatial state,
 * content-only fingerprints, partial templates, atomicity, stale reviews (template, destination, set), the set
 * compatibility rule, and Project scoping with one indistinguishable answer.
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
import { currentSpatialStateFor, promotionStateFor } from "../master-frame-promotion";
import { copyShotSetup, previewShotSetupCopy } from "../setup-copy-actions";
import {
  copyTemplateSetup,
  deleteSetupTemplate,
  previewTemplateSetupCopy,
  renameSetupTemplate,
  replaceSetupTemplateContent,
  saveSetupTemplate,
} from "../setup-template-actions";

const iso = "2026-11-06T00:00:00.000Z";

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
  const A = data.shots.find((s) => s.spatial.locationId)!;
  const loc = A.spatial.locationId!;
  const otherLoc = data.locations.find((l) => l.id !== loc)!.id;
  const B0 = data.shots.find((s) => s.id !== A.id)!;
  const C0 = data.shots.find((s) => s.id !== A.id && s.id !== B0.id)!;
  const [c1, c2] = data.characters;
  const put = (s: (typeof data.shots)[number], over: Record<string, unknown>) =>
    repo.upsert(project.id, "shots", shotSchema.parse({ ...s, ...over, updatedAt: iso }));
  await put(B0, {
    spatial: { ...B0.spatial, locationId: loc },
    lighting: { ...B0.lighting, mood: "B's own mood" },
  });
  await put(C0, { spatial: { ...C0.spatial, locationId: otherLoc } });
  const fresh = async () => (await repo.loadProject(project.slug))!;
  const B = (await fresh()).shots.find((s) => s.id === B0.id)!;
  const saveScene = (locationId: string, id: string, expectedRevision: number | null = null) =>
    repo.previs.saveScene({
      id,
      projectId: project.id,
      locationId,
      document: buildPrevisDocument({ engineScene: buildHotelCanopyEngineScene() }),
      expectedRevision,
      engineVersion: "t",
      userId: null,
      now: iso,
    });
  const scene = await saveScene(loc, "scene-1");
  await saveScene(otherLoc, "scene-2");
  const link = (shotId: string, locationId = loc) =>
    repo.previs.getSceneForLocation(locationId).then((s) =>
      repo.previs.setBookmark({
        id: `bm-${shotId}`,
        projectId: project.id,
        shotId,
        locationId,
        sceneDocumentId: s!.id,
        userId: null,
        now: iso,
      }),
    );
  const form = (fields: Record<string, string>, slug = project.slug) => {
    const fd = new FormData();
    fd.set("projectSlug", slug);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };
  const light = async (shotId: string, intensity: number) => {
    const cur = await repo.previs.getLightingRigForShot(shotId);
    return saveShotLighting(
      form({
        shotId,
        locationId: loc,
        expectedRevision: cur ? String(cur.revision) : "",
        rigJson: JSON.stringify({
          schema: SHOT_LIGHTING_SCHEMA,
          base: { mode: "replace" },
          lights: [{ ...newShotLight("point", "key"), id: "key-1", intensity }],
        }),
      }),
    );
  };
  const block = async (shotId: string, characterId: string, x: number) => {
    const cur = (await repo.previs.listShotBlocking(shotId)).find((r) => r.characterId === characterId);
    return saveShotBlocking(
      form({
        shotId,
        locationId: loc,
        blockingJson: JSON.stringify({
          save: [
            {
              entry: newBlockingEntry(characterId, { x, y: 0, z: 0 }),
              expectedRevision: cur?.revision ?? null,
            },
          ],
          remove: [],
        }),
      }),
    );
  };
  const saveTemplate = (shotId: string, name: string, components = ["camera", "lighting", "blocking"]) =>
    saveSetupTemplate(form({ shotId, name, description: "", components: JSON.stringify(components) }));
  const preview = (shotId: string, templateId: string, components?: string[], slug?: string) =>
    previewTemplateSetupCopy(
      form({ shotId, templateId, ...(components ? { components: JSON.stringify(components) } : {}) }, slug),
    );
  const apply = async (shotId: string, templateId: string, components?: string[]) => {
    const p = await preview(shotId, templateId, components);
    if (!p.ok) throw new Error(p.error);
    const r = await copyTemplateSetup(
      form({ shotId, templateId, components: JSON.stringify(p.plan!.components), token: p.plan!.token }),
    );
    if (!r.ok) throw new Error(r.error);
    return { p, r };
  };
  const shotState = async (shotId: string) => ({
    camera: await repo.previs.getBookmarkForShot(shotId),
    lighting: await repo.previs.getLightingRigForShot(shotId),
    blocking: await repo.previs.listShotBlocking(shotId),
  });
  const tpl = async (id: string) => (await repo.previs.getSetupTemplate(id))!;
  const capture = async (shotId: string) => {
    const s = (await repo.previs.getSceneForLocation(loc))!;
    const bm = (await repo.previs.getBookmarkForShot(shotId))!;
    const rig = await repo.previs.getLightingRigForShot(shotId);
    const figures = onCurrentSet(await repo.previs.listShotBlocking(shotId), {
      locationId: loc,
      sceneDocumentId: s.id,
    });
    const fd = form({
      shotId,
      locationId: loc,
      sceneRevision: String(s.revision),
      cameraFingerprint: bookmarkCameraFingerprint(bm.value),
      lightingFingerprint: rig?.lightingFingerprint ?? "",
      blockingFingerprint: renderedBlockingProvenance(figures, { locationId: loc })?.fingerprint ?? "",
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
    saveScene,
    link,
    light,
    block,
    form,
    saveTemplate,
    preview,
    apply,
    shotState,
    tpl,
    capture,
    fresh,
  };
}
type W = Awaited<ReturnType<typeof setup>>;

async function sourceSetup(w: W) {
  await w.link(w.A.id);
  expect((await w.light(w.A.id, 40)).ok).toBe(true);
  expect((await w.block(w.A.id, w.c1.id, 1)).ok).toBe(true);
  expect((await w.block(w.A.id, w.c2.id, 2)).ok).toBe(true);
}
async function savedTemplate(w: W, name = "Night key", components?: string[]) {
  const r = await w.saveTemplate(w.A.id, name, components);
  if (!r.ok) throw new Error(r.error);
  return r.template;
}

describe("Phase 4D-I2: named setup templates — sources for copies, never runtime dependencies", () => {
  let w: W;
  beforeEach(async () => {
    w = await setup();
    await sourceSetup(w);
  });

  it("SNAPSHOT: saving copies the Shot's values; editing the Shot afterwards leaves the template unchanged", async () => {
    const t = await savedTemplate(w);
    expect(t.parts).toEqual(["camera", "lighting", "blocking"]);
    expect(t.revision).toBe(1);
    expect(t.sourceShotCode).toBe(w.A.shotCode);
    const before = await w.tpl(t.id);
    // the template holds VALUES, never the Shot's authored lighting text
    expect(before.content.lighting!.rig).not.toHaveProperty("authoredIntent");
    expect((await w.light(w.A.id, 99)).ok).toBe(true);
    expect((await w.block(w.A.id, w.c1.id, 8)).ok).toBe(true);
    expect(await w.tpl(t.id)).toEqual(before);
  });

  it("APPLY: copies the template's values into the destination's OWN rows with native fingerprints", async () => {
    const t = await savedTemplate(w);
    const a = await w.shotState(w.A.id);
    const { r } = await w.apply(w.B.id, t.id);
    expect(r.ok && r.templateName).toBe("Night key");
    const b = await w.shotState(w.B.id);
    expect(b.camera!.shotId).toBe(w.B.id);
    expect(b.camera!.id).not.toBe(a.camera!.id);
    expect(bookmarkCameraFingerprint(b.camera!.value)).toBe(bookmarkCameraFingerprint(a.camera!.value));
    expect(b.lighting!.lightingFingerprint).toBe(a.lighting!.lightingFingerprint);
    expect(b.blocking.map((x) => x.blockingFingerprint)).toEqual(
      a.blocking.map((x) => x.blockingFingerprint),
    );
    expect(b.lighting!.rig.authoredIntent).toEqual(authoredLightingIntent(w.B));
  });

  it("APPLY INDEPENDENCE: editing the template (rename or new values) never changes a Shot that copied it", async () => {
    const t = await savedTemplate(w);
    await w.apply(w.B.id, t.id);
    const b = await w.shotState(w.B.id);
    const renamed = await renameSetupTemplate(
      w.form({ templateId: t.id, expectedRevision: "1", name: "Night key v2", description: "warmer" }),
    );
    expect(renamed.ok).toBe(true);
    expect((await w.light(w.A.id, 300)).ok).toBe(true);
    const replaced = await replaceSetupTemplateContent(
      w.form({
        templateId: t.id,
        expectedRevision: "2",
        shotId: w.A.id,
        components: JSON.stringify(["lighting"]),
      }),
    );
    expect(replaced.ok).toBe(true);
    expect((await w.tpl(t.id)).content.camera).toBeNull();
    expect(await w.shotState(w.B.id)).toEqual(b);
  });

  it("rename changes the revision but never the content fingerprint", async () => {
    const t = await savedTemplate(w);
    const r = await renameSetupTemplate(
      w.form({ templateId: t.id, expectedRevision: "1", name: "Other", description: "" }),
    );
    expect(r.ok && r.template.revision).toBe(2);
    expect(r.ok && r.template.contentFingerprint).toBe(t.contentFingerprint);
    // identical values saved under another name: the same content fingerprint
    const twin = await savedTemplate(w, "Twin");
    expect(twin.contentFingerprint).toBe(t.contentFingerprint);
  });

  it("DESTINATION INDEPENDENCE: editing the destination never changes the template", async () => {
    const t = await savedTemplate(w);
    await w.apply(w.B.id, t.id);
    const before = await w.tpl(t.id);
    expect((await w.light(w.B.id, 5)).ok).toBe(true);
    expect((await w.block(w.B.id, w.c2.id, 9)).ok).toBe(true);
    expect(await w.tpl(t.id)).toEqual(before);
  });

  it("DELETION: deleting the template leaves the Shot complete and usable; provenance keeps the name", async () => {
    const t = await savedTemplate(w);
    await w.apply(w.B.id, t.id);
    const b = await w.shotState(w.B.id);
    expect((await deleteSetupTemplate(w.form({ templateId: t.id, expectedRevision: "1" }))).ok).toBe(true);
    expect(await w.repo.previs.getSetupTemplate(t.id)).toBeNull();
    expect(await w.shotState(w.B.id)).toEqual(b);
    expect((await w.capture(w.B.id)).ok).toBe(true);
    const [rec] = await w.repo.previs.listSetupCopies(w.project.id, w.B.id);
    expect(rec).toMatchObject({
      sourceKind: "template",
      templateId: null,
      templateName: "Night key",
      templateRevision: 1,
    });
    expect(rec!.components).toEqual(["camera", "lighting", "blocking"]);
    // and the deleted template is gone for every action, with the one answer
    expect(await w.preview(w.B.id, t.id)).toEqual({ ok: false, error: TEMPLATE_GONE });
  });

  it("deleting the Shot a template was saved from leaves the template intact (display-only provenance)", async () => {
    const t = await savedTemplate(w);
    const before = await w.tpl(t.id);
    await w.repo.remove(w.project.id, "shots", w.A.id);
    const after = await w.tpl(t.id);
    expect(after.sourceShotId).toBeNull();
    expect(after.sourceShotCode).toBe(w.A.shotCode);
    expect({ ...after, sourceShotId: before.sourceShotId }).toEqual(before);
    await w.apply(w.B.id, t.id); // still a usable source
  });

  it("NO LIVE READS: after applying, capture and spatial state never consult the template store", async () => {
    const t = await savedTemplate(w);
    await w.apply(w.B.id, t.id);
    const previs = w.repo.previs;
    const spies = (
      ["getSetupTemplate", "listSetupTemplates", "setupTemplatesReady", "listSetupCopies"] as const
    ).map((m) => vi.spyOn(previs, m));
    expect((await w.capture(w.B.id)).ok).toBe(true);
    const st = await currentSpatialStateFor(previs, { shotId: w.B.id, locationId: w.loc });
    expect(st.cameraFingerprint).toBe(
      bookmarkCameraFingerprint((await previs.getBookmarkForShot(w.B.id))!.value),
    );
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("FINGERPRINTS: a template edit stales nothing; a Shot edit stales only that Shot's Master Frame", async () => {
    const t = await savedTemplate(w);
    await w.apply(w.B.id, t.id);
    expect((await w.capture(w.B.id)).ok).toBe(true);
    const mf = (await w.repo.previs.listMasterFrames(w.B.id))[0]!;
    await replaceSetupTemplateContent(
      w.form({
        templateId: t.id,
        expectedRevision: "1",
        shotId: w.A.id,
        components: JSON.stringify(["lighting"]),
      }),
    );
    expect((await w.light(w.A.id, 123)).ok).toBe(true);
    const fresh = await promotionStateFor(w.repo.previs, mf, { shotId: w.B.id, locationId: w.loc });
    expect(fresh.stale).toEqual([]);
    expect((await w.light(w.B.id, 7)).ok).toBe(true);
    const stale = await promotionStateFor(w.repo.previs, mf, { shotId: w.B.id, locationId: w.loc });
    expect(stale.stale).toContain("lighting");
  });

  it("PARTIAL templates: camera only, lighting only, blocking only, and a combination", async () => {
    for (const parts of [["camera"], ["lighting"], ["blocking"], ["camera", "blocking"]]) {
      const ww = await setup();
      await sourceSetup(ww);
      const r = await ww.saveTemplate(ww.A.id, `T ${parts.join("+")}`, parts);
      if (!r.ok) throw new Error(r.error);
      expect(r.template.parts).toEqual(parts);
      const p = await ww.preview(ww.B.id, r.template.id);
      expect(p.ok && p.plan!.components).toEqual(parts);
      if (!p.ok) continue;
      for (const c of ["camera", "lighting", "blocking"] as const)
        expect(p.available[c]).toBe(parts.includes(c));
      // a part the template does not hold cannot be forced
      const missing = ["camera", "lighting", "blocking"].find((c) => !parts.includes(c));
      if (missing) expect((await ww.preview(ww.B.id, r.template.id, [missing])).ok).toBe(false);
      await ww.apply(ww.B.id, r.template.id);
      const b = await ww.shotState(ww.B.id);
      expect(!!b.camera).toBe(parts.includes("camera"));
      expect(!!b.lighting).toBe(parts.includes("lighting"));
      expect(b.blocking.length > 0).toBe(parts.includes("blocking"));
    }
  });

  it("ATOMICITY: a failure on the last part leaves the destination exactly as before and records nothing", async () => {
    const t = await savedTemplate(w);
    const p = await w.preview(w.B.id, t.id);
    if (!p.ok) throw new Error(p.error);
    await w.repo.remove(w.project.id, "characters", w.c2.id); // the blocking part can no longer be written
    const before = await w.shotState(w.B.id);
    const r = await copyTemplateSetup(
      w.form({
        shotId: w.B.id,
        templateId: t.id,
        components: JSON.stringify(p.plan!.components),
        token: p.plan!.token,
      }),
    );
    expect(r.ok).toBe(false);
    expect(await w.shotState(w.B.id)).toEqual(before);
    expect(await w.repo.previs.listSetupCopies(w.project.id, w.B.id)).toEqual([]);
  });

  it("STALE REVIEW: an edited template, a changed destination and a new set are each refused", async () => {
    const t = await savedTemplate(w);
    const confirm = (p: Awaited<ReturnType<W["preview"]>>) =>
      p.ok
        ? copyTemplateSetup(
            w.form({
              shotId: w.B.id,
              templateId: t.id,
              components: JSON.stringify(p.plan!.components),
              token: p.plan!.token,
            }),
          )
        : Promise.reject(new Error(p.error));
    // the template changed (even only its name: the review named its revision)
    const p1 = await w.preview(w.B.id, t.id);
    await renameSetupTemplate(
      w.form({ templateId: t.id, expectedRevision: "1", name: "Renamed", description: "" }),
    );
    expect(await confirm(p1)).toEqual({ ok: false, error: SETUP_CHANGED, conflict: true });
    // the destination changed
    const p2 = await w.preview(w.B.id, t.id);
    expect((await w.light(w.B.id, 3)).ok).toBe(true);
    expect(await confirm(p2)).toEqual({ ok: false, error: SETUP_CHANGED, conflict: true });
    // the destination left the Location after the review
    const p3 = await w.preview(w.B.id, t.id);
    const now = (await w.fresh()).shots.find((s) => s.id === w.B.id)!;
    await w.repo.upsert(
      w.project.id,
      "shots",
      shotSchema.parse({ ...now, spatial: { ...now.spatial, locationId: w.otherLoc }, updatedAt: iso }),
    );
    const moved = await confirm(p3);
    expect(moved.ok).toBe(false);
    expect((await w.shotState(w.B.id)).camera).toBeNull();
    expect(await w.repo.previs.listSetupCopies(w.project.id, w.B.id)).toEqual([]);
  });

  it("SET COMPATIBILITY: a template is refused on a Shot in another Location", async () => {
    const t = await savedTemplate(w);
    expect(await w.preview(w.C.id, t.id)).toEqual({ ok: false, error: TEMPLATE_OTHER_SET });
  });

  it("a duplicate template name on the same set is refused; an empty name is refused", async () => {
    await savedTemplate(w, "Same");
    const dup = await w.saveTemplate(w.A.id, "Same");
    expect(dup.ok).toBe(false);
    expect((await w.saveTemplate(w.A.id, "   ")).ok).toBe(false);
  });

  it("stale template edits are refused (compare-and-set on revision)", async () => {
    const t = await savedTemplate(w);
    await renameSetupTemplate(
      w.form({ templateId: t.id, expectedRevision: "1", name: "x", description: "" }),
    );
    const stale = await renameSetupTemplate(
      w.form({ templateId: t.id, expectedRevision: "1", name: "y", description: "" }),
    );
    expect(stale.ok).toBe(false);
    expect((await deleteSetupTemplate(w.form({ templateId: t.id, expectedRevision: "1" }))).ok).toBe(false);
    expect(await w.repo.previs.getSetupTemplate(t.id)).not.toBeNull();
  });

  it("a Shot-to-Shot copy (4D-I1) now also leaves a provenance record", async () => {
    const p = await previewShotSetupCopy(w.form({ shotId: w.B.id, sourceShotId: w.A.id }));
    if (!p.ok) throw new Error(p.error);
    const r = await copyShotSetup(
      w.form({
        shotId: w.B.id,
        sourceShotId: w.A.id,
        components: JSON.stringify(p.plan!.components),
        token: p.plan!.token,
      }),
    );
    expect(r.ok).toBe(true);
    const [rec] = await w.repo.previs.listSetupCopies(w.project.id, w.B.id);
    expect(rec).toMatchObject({
      sourceKind: "shot",
      sourceShotId: w.A.id,
      sourceShotCode: w.A.shotCode,
      templateId: null,
    });
  });
});

describe("Phase 4D-I2: Project scoping and no existence leaks", () => {
  it("another Project's template is refused with the same answer as a deleted or malformed id", async () => {
    const w = await setup();
    await sourceSetup(w);
    const t = await savedTemplate(w);
    const mine = await w.fresh();
    const foreignId = "00000000-0000-4000-8000-0000000f0e29";
    await w.repo.createProject(
      { ...mine.project, id: foreignId, slug: "foreign-project" },
      { ...mine.bible, projectId: foreignId },
    );
    const foreignShot = "00000000-0000-4000-8000-0000000f0e2a";
    await w.repo.upsert(
      foreignId,
      "shots",
      shotSchema.parse({ ...w.A, id: foreignShot, projectId: foreignId }),
    );
    const answers = [
      await w.preview(w.B.id, "00000000-0000-4000-8000-00000000dead"),
      await w.preview(w.B.id, "not-a-uuid"),
      // my template through the foreign Project's slug: that Project has no such template
      await w.preview(foreignShot, t.id, undefined, "foreign-project"),
    ];
    expect(answers[0]).toEqual({ ok: false, error: TEMPLATE_GONE });
    expect(answers[1]).toEqual({ ok: false, error: TEMPLATE_GONE });
    // the foreign Shot has no Location there, so it is refused before any template lookup: no template detail leaks
    expect(answers[2].ok).toBe(false);
    expect(JSON.stringify(answers[2])).not.toContain("Night key");
    const rename = await renameSetupTemplate(
      w.form({ templateId: t.id, expectedRevision: "1", name: "hijack", description: "" }, "foreign-project"),
    );
    expect(rename).toEqual({ ok: false, error: TEMPLATE_GONE });
    const del = await deleteSetupTemplate(
      w.form({ templateId: t.id, expectedRevision: "1" }, "foreign-project"),
    );
    expect(del).toEqual({ ok: false, error: TEMPLATE_GONE });
    expect((await w.tpl(t.id)).name).toBe("Night key");
    // a foreign Shot cannot be a template source or destination in my Project
    expect(await w.saveTemplate(foreignShot, "x")).toEqual({ ok: false, error: SETUP_SHOT_GONE });
  });

  it("an unreadable Project gets the usual refusal for every template action", async () => {
    const w = await setup();
    const r = await saveSetupTemplate(
      w.form({ shotId: w.A.id, name: "x", components: JSON.stringify(["camera"]) }, "someone-elses-project"),
    );
    expect(r).toEqual({ ok: false, error: "That project no longer exists." });
  });

  it("the repository refuses a template outside the Project (defence in depth)", async () => {
    const w = await setup();
    await sourceSetup(w);
    const t = await savedTemplate(w);
    const scene = (await w.repo.previs.getSceneForLocation(w.loc))!;
    await expect(
      w.repo.previs.copyTemplateSetup({
        projectId: "another-project",
        templateId: t.id,
        destinationShotId: w.B.id,
        locationId: w.loc,
        sceneDocumentId: scene.id,
        components: ["camera"],
        expectedToken: "0".repeat(64),
        destinationIntent: authoredLightingIntent(w.B),
        userId: null,
        now: iso,
      }),
    ).rejects.toThrow();
    await expect(
      w.repo.previs.deleteSetupTemplate({
        projectId: "another-project",
        templateId: t.id,
        expectedRevision: 1,
      }),
    ).rejects.toThrow(TEMPLATE_GONE);
    expect(await w.repo.previs.getSetupTemplate(t.id)).not.toBeNull();
  });
});
