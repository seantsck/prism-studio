import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { ProductionFrameError } from "@/data/production-frame-repository";
import { buildSeedProject } from "@/data/seed";
import { shotByCode } from "@/domain/__tests__/helpers";
import {
  contextOf,
  draftFor,
  newUploadAsset,
  remappedSeed,
  T,
} from "@/domain/__tests__/production-frame-fixtures";
import type { ProductionFrameDraft } from "@/domain/production-frame";
import type { ProjectData } from "@/domain/schemas";

/**
 * The in-memory Production Frame service, with the same semantics the Postgres implementation has (and
 * `npm run db:production-frames` proves against the real database).
 */

async function world() {
  const a = buildSeedProject();
  const b = remappedSeed("other-project");
  const repo = new MemoryRepository([a, b]);
  const svc = repo.productionFrames;
  const load = async (data: ProjectData) => (await repo.loadProject(data.project.slug))!;
  /** a stored upload Asset for a shot, drafted against the live project */
  const upload = async (
    data: ProjectData,
    code: string,
    label: string,
    dims: { width?: number; height?: number } = {},
  ) => {
    const asset = newUploadAsset(data.project.id, { label, ...dims });
    const live = await load(data);
    return { asset, draft: draftFor(live, code, { asset }) };
  };
  const create = async (data: ProjectData, code: string, label: string, select = true) => {
    const { asset, draft } = await upload(data, code, label);
    return svc.create({ draft, newAsset: asset, select, userId: null, now: T });
  };
  return { repo, svc, a, b, load, upload, create };
}

const errCode = async (p: Promise<unknown>) =>
  ((await p.catch((e: unknown) => e)) as ProductionFrameError).code;

describe("creating Production Frames", () => {
  it("an upload stores its NEW Asset and its frame together, versions it 1, and selects it", async () => {
    const w = await world();
    const { asset, draft } = await w.upload(w.a, "3A", "first");
    const before = (await w.load(w.a)).assets.length;
    const r = await w.svc.create({ draft, newAsset: asset, select: true, userId: "u1", now: T });
    expect(r).toMatchObject({ created: true, frame: { version: 1, assetId: asset.id, source: "upload" } });
    expect(r.selection).toMatchObject({ productionFrameId: r.frame.id, selectedBy: "u1" });
    const after = await w.load(w.a);
    expect(after.assets.length).toBe(before + 1);
    expect(after.assets.find((x) => x.id === asset.id)).toMatchObject({
      purpose: "production_frame",
      type: "image",
    });
    const listed = await w.svc.listForProject(w.a.project.id);
    expect(listed.frames).toHaveLength(1);
    expect(listed.selections).toHaveLength(1);
  });

  it("a promotion REUSES the existing Asset: nothing is copied or added", async () => {
    const w = await world();
    const stored = newUploadAsset(w.a.project.id, { label: "storyboard-image" });
    await w.repo.upsert(w.a.project.id, "assets", stored);
    const live = await w.load(w.a);
    const draft = draftFor(live, "3A", {
      asset: stored,
      source: "storyboard",
      sourceStoryboardFrameId: "sb-1",
    });
    const assets = live.assets.length;
    const r = await w.svc.create({ draft, newAsset: null, select: true, userId: null, now: T });
    expect(r.frame).toMatchObject({
      assetId: stored.id,
      source: "storyboard",
      sourceStoryboardFrameId: "sb-1",
    });
    expect((await w.load(w.a)).assets.length).toBe(assets);
  });

  it("versions rise 1, 2, 3 per Shot; another Shot starts at 1", async () => {
    const w = await world();
    expect((await w.create(w.a, "3A", "a")).frame.version).toBe(1);
    expect((await w.create(w.a, "3A", "b")).frame.version).toBe(2);
    expect((await w.create(w.a, "3A", "c")).frame.version).toBe(3);
    expect((await w.create(w.a, "4C", "d")).frame.version).toBe(1);
  });

  it("creating without selecting leaves the canonical frame alone", async () => {
    const w = await world();
    const first = await w.create(w.a, "3A", "a");
    const second = await w.create(w.a, "3A", "b", false);
    expect(second.selection?.productionFrameId).toBe(first.frame.id);
    const { selections } = await w.svc.listForProject(w.a.project.id);
    expect(selections.map((s) => s.productionFrameId)).toEqual([first.frame.id]);
  });

  it("an identical frame (same Shot, source, image checksum and intent) is returned and re-selected, not duplicated", async () => {
    const w = await world();
    const a = await w.create(w.a, "3A", "same");
    await w.create(w.a, "3A", "other"); // v2 is now canonical
    const live = await w.load(w.a);
    // the same image bytes (same checksum) as a new upload: a different Asset row, the same artifact
    const again = newUploadAsset(w.a.project.id, { label: "same" });
    const draft = draftFor(live, "3A", { asset: again });
    const assets = (await w.load(w.a)).assets.length;
    const r = await w.svc.create({ draft, newAsset: again, select: true, userId: null, now: T });
    expect(r.created).toBe(false);
    expect(r.frame.id).toBe(a.frame.id);
    expect(r.selection?.productionFrameId).toBe(a.frame.id);
    // the new Asset was NOT stored (the caller removes its uploaded object)
    expect((await w.load(w.a)).assets.length).toBe(assets);
    expect((await w.svc.listForProject(w.a.project.id)).frames).toHaveLength(2);
  });

  it("if the Shot's intent CHANGED, the same image is a legitimately new frame (its meaning differs)", async () => {
    const w = await world();
    const stored = newUploadAsset(w.a.project.id, { label: "shared" });
    await w.repo.upsert(w.a.project.id, "assets", stored);
    const live = await w.load(w.a);
    const one = await w.svc.create({
      draft: draftFor(live, "3A", { asset: stored }),
      newAsset: null,
      select: true,
      userId: null,
      now: T,
    });
    const shot = { ...shotByCode(live, "3A") };
    shot.lighting = { ...shot.lighting, mood: "a new mood" };
    await w.repo.upsert(w.a.project.id, "shots", shot);
    const changed = await w.load(w.a);
    const two = await w.svc.create({
      draft: draftFor(changed, "3A", { asset: stored }),
      newAsset: null,
      select: true,
      userId: null,
      now: T,
    });
    expect(two.created).toBe(true);
    expect(two.frame.version).toBe(2);
    expect(two.frame.assetId).toBe(one.frame.assetId);
    expect(two.frame.intentFingerprint).not.toBe(one.frame.intentFingerprint);
  });

  it("concurrent creates never duplicate a version; identical concurrent creates make exactly one frame", async () => {
    const w = await world();
    const distinct = await Promise.all(Array.from({ length: 8 }, (_, i) => w.create(w.a, "3A", `c${i}`)));
    expect(distinct.map((r) => r.frame.version).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const { asset } = await w.upload(w.a, "4C", "twin");
    const live = await w.load(w.a);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        w.svc.create({
          draft: { ...draftFor(live, "4C", { asset }) } as ProductionFrameDraft,
          newAsset: { ...asset },
          select: true,
          userId: null,
          now: T,
        }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.frame.id)).size).toBe(1);
    const shotId = shotByCode(live, "4C").id;
    const list = (await w.svc.listForProject(w.a.project.id)).frames.filter((f) => f.shotId === shotId);
    expect(list).toHaveLength(1);
  });

  it("refuses an image that is not this project's, or does not match the frozen facts", async () => {
    const w = await world();
    const live = await w.load(w.a);
    const mine = newUploadAsset(w.a.project.id, { label: "mine" });
    const draft = draftFor(live, "3A", { asset: mine });
    const base = { select: true, userId: null, now: T };
    // the image is not in the project at all (no newAsset, no stored row)
    expect(await errCode(w.svc.create({ draft, newAsset: null, ...base }))).toBe("wrong_project");
    // another project's Asset
    const foreign = newUploadAsset(w.b.project.id, { label: "foreign" });
    await w.repo.upsert(w.b.project.id, "assets", foreign);
    expect(
      await errCode(w.svc.create({ draft: { ...draft, assetId: foreign.id }, newAsset: null, ...base })),
    ).toBe("wrong_project");
    // facts that differ from the Asset
    expect(
      await errCode(
        w.svc.create({ draft: { ...draft, assetChecksum: "0".repeat(64) }, newAsset: mine, ...base }),
      ),
    ).toBe("invalid");
    expect(await errCode(w.svc.create({ draft: { ...draft, width: 1000 }, newAsset: mine, ...base }))).toBe(
      "invalid",
    );
    // a Shot of another project
    expect(
      await errCode(
        w.svc.create({ draft: { ...draft, shotId: shotByCode(w.b, "3A").id }, newAsset: mine, ...base }),
      ),
    ).toBe("not_found");
    // nothing was stored by any refusal
    expect((await w.svc.listForProject(w.a.project.id)).frames).toHaveLength(0);
  });

  it("returns copies: editing a result never edits the stored history", async () => {
    const w = await world();
    const r = await w.create(w.a, "3A", "copy");
    r.frame.width = 1;
    (r.frame.intentSnapshot as { x?: number }).x = 1;
    const stored = (await w.svc.listForProject(w.a.project.id)).frames[0]!;
    expect(stored.width).toBe(1912);
    expect(stored.intentSnapshot).not.toHaveProperty("x");
  });
});

describe("selection", () => {
  it("v1 → v2 → v1: both frame rows are untouched, one selection row, current = v1", async () => {
    const w = await world();
    const v1 = (await w.create(w.a, "3A", "one")).frame;
    const v2 = (await w.create(w.a, "3A", "two")).frame;
    const shotId = v1.shotId;
    const snapshot = structuredClone((await w.svc.listForProject(w.a.project.id)).frames);
    const pick = (id: string) =>
      w.svc.select({ projectId: w.a.project.id, shotId, productionFrameId: id, userId: "u", now: T });
    await pick(v1.id);
    expect((await w.svc.listForProject(w.a.project.id)).selections.map((s) => s.productionFrameId)).toEqual([
      v1.id,
    ]);
    await pick(v2.id);
    await pick(v1.id);
    const { frames, selections } = await w.svc.listForProject(w.a.project.id);
    expect(frames).toEqual(snapshot); // history unchanged by any selection
    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({ shotId, productionFrameId: v1.id });
    expect(frames).toHaveLength(2); // no copies
  });

  it("only a frame of the SAME Shot and the SAME project can be selected", async () => {
    const w = await world();
    const mine = (await w.create(w.a, "3A", "mine")).frame;
    const otherShot = (await w.create(w.a, "4C", "other-shot")).frame;
    const theirs = (await w.create(w.b, "3A", "theirs")).frame;
    const base = { projectId: w.a.project.id, shotId: mine.shotId, userId: null, now: T };
    expect(await errCode(w.svc.select({ ...base, productionFrameId: otherShot.id }))).toBe("wrong_shot");
    expect(await errCode(w.svc.select({ ...base, productionFrameId: theirs.id }))).toBe("wrong_project");
    expect(
      await errCode(w.svc.select({ ...base, productionFrameId: "00000000-0000-4000-8000-000000000000" })),
    ).toBe("not_found");
    expect(
      await errCode(w.svc.select({ ...base, shotId: shotByCode(w.b, "3A").id, productionFrameId: mine.id })),
    ).toBe("not_found");
    // the pointer still names the original frame
    const sel = (await w.svc.listForProject(w.a.project.id)).selections.find((s) => s.shotId === mine.shotId);
    expect(sel?.productionFrameId).toBe(mine.id);
  });

  it("compare-and-set: a stale view conflicts instead of silently overwriting", async () => {
    const w = await world();
    const v1 = (await w.create(w.a, "3A", "one")).frame; // selected
    const v2 = (await w.create(w.a, "3A", "two", false)).frame;
    const base = { projectId: w.a.project.id, shotId: v1.shotId, userId: null, now: T };
    expect(
      await errCode(w.svc.select({ ...base, productionFrameId: v2.id, expectedSelectedFrameId: null })),
    ).toBe("conflict");
    expect(
      await errCode(w.svc.select({ ...base, productionFrameId: v2.id, expectedSelectedFrameId: v2.id })),
    ).toBe("conflict");
    await expect(
      w.svc.select({ ...base, productionFrameId: v2.id, expectedSelectedFrameId: v1.id }),
    ).resolves.toMatchObject({ productionFrameId: v2.id });
    // unconditional selection still works
    await expect(w.svc.select({ ...base, productionFrameId: v1.id })).resolves.toMatchObject({
      productionFrameId: v1.id,
    });
  });

  it("two tabs choosing from the same view: the first wins, the second gets a conflict; one selection row", async () => {
    const w = await world();
    const v1 = (await w.create(w.a, "3A", "one")).frame;
    const v2 = (await w.create(w.a, "3A", "two", false)).frame;
    const v3 = (await w.create(w.a, "3A", "three", false)).frame;
    const results = await Promise.allSettled(
      [v2, v3].map((f) =>
        w.svc.select({
          projectId: w.a.project.id,
          shotId: v1.shotId,
          productionFrameId: f.id,
          userId: null,
          now: T,
          expectedSelectedFrameId: v1.id,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await w.svc.listForProject(w.a.project.id)).selections).toHaveLength(1);
  });
});

describe("lifecycle housekeeping", () => {
  it("usesAsset says whether any frame pins an Asset", async () => {
    const w = await world();
    const r = await w.create(w.a, "3A", "pin");
    expect(await w.svc.usesAsset(r.frame.assetId)).toBe(true);
    expect(await w.svc.usesAsset("00000000-0000-4000-8000-000000000000")).toBe(false);
  });

  it("deleting a Shot takes its frames and selection with it (the database cascades the same way)", async () => {
    const w = await world();
    const r = await w.create(w.a, "3A", "doomed");
    await w.create(w.a, "4C", "kept");
    await w.repo.remove(w.a.project.id, "shots", r.frame.shotId);
    const { frames, selections } = await w.svc.listForProject(w.a.project.id);
    expect(frames.map((f) => f.shotId)).not.toContain(r.frame.shotId);
    expect(selections.map((s) => s.shotId)).not.toContain(r.frame.shotId);
    expect(frames).toHaveLength(1);
  });

  it("the live ShotContext built from the repository sees frames and selection without any 3D data", async () => {
    const w = await world();
    const r = await w.create(w.a, "3A", "ctx");
    const data = await w.load(w.a);
    const { frames, selections } = await w.svc.listForProject(w.a.project.id);
    data.productionFrames = frames;
    data.productionFrameSelections = selections;
    const ctx = contextOf(data, "3A");
    expect(ctx.selectedProductionFrame?.id).toBe(r.frame.id);
    expect(ctx.spatial).toBeUndefined();
  });
});
