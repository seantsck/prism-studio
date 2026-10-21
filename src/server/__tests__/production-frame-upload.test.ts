import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import { ProductionFrameError, type ProductionFrameRepository } from "@/data/production-frame-repository";
import { buildSeedProject } from "@/data/seed";
import { shotByCode } from "@/domain/__tests__/helpers";
import { newUploadAsset } from "@/domain/__tests__/production-frame-fixtures";
import { buildShotContext } from "@/domain/context";
import type { Asset } from "@/domain/schemas";
import { UserFacingError } from "../action-result";
import { persistUploadedFrame } from "../production-frame-upload";

/**
 * The upload path must leave no durable broken state whatever fails after the object was stored: the stored object is
 * removed (best effort) and nothing referencing it was written.
 */

/** The real service for reads; every create fails with `error` (a class instance cannot be spread). */
function failingRepo(svc: ProductionFrameRepository, error: Error): ProductionFrameRepository {
  return {
    listForProject: (id) => svc.listForProject(id),
    select: (i) => svc.select(i),
    usesAsset: (a) => svc.usesAsset(a),
    create: async () => {
      throw error;
    },
  };
}

async function world() {
  const data = buildSeedProject();
  const repo = new MemoryRepository([data]);
  const discarded: string[] = [];
  const discard = async (a: Asset) => void discarded.push(a.id);
  const ctx = () => buildShotContext(data, shotByCode(data, "3A").id);
  const stored = (o: Parameters<typeof newUploadAsset>[1] = {}) => newUploadAsset(data.project.id, o);
  const live = async () => (await repo.loadProject(data.project.slug))!;
  return { data, repo, svc: repo.productionFrames, discarded, discard, ctx, stored, live };
}

describe("persistUploadedFrame", () => {
  it("success: the Asset, the frame and the selection are stored together; nothing is discarded", async () => {
    const w = await world();
    const asset = w.stored({ label: "ok" });
    const r = await persistUploadedFrame({ repo: w.svc, discard: w.discard }, w.ctx(), asset, "u1");
    expect(r).toMatchObject({
      created: true,
      frame: { version: 1, assetId: asset.id },
      selection: { selectedBy: "u1" },
    });
    expect((await w.live()).assets.some((a) => a.id === asset.id)).toBe(true);
    expect(w.discarded).toEqual([]);
  });

  it("a wrongly shaped image is refused: the stored object is removed and nothing was written", async () => {
    const w = await world();
    const asset = w.stored({ label: "wrong", width: 1920, height: 1080 });
    const before = (await w.live()).assets.length;
    await expect(
      persistUploadedFrame({ repo: w.svc, discard: w.discard }, w.ctx(), asset, null),
    ).rejects.toThrow(UserFacingError);
    expect(w.discarded).toEqual([asset.id]);
    expect((await w.live()).assets.length).toBe(before);
    expect((await w.svc.listForProject(w.data.project.id)).frames).toEqual([]);
  });

  it("a persistence failure AFTER the Storage write: the object is removed, no Asset row, no frame, no selection", async () => {
    const w = await world();
    const asset = w.stored({ label: "boom" });
    // the database refused the write (here: a connection loss mid-transaction)
    const failing = failingRepo(w.svc, new ProductionFrameError("conflict", "fictional database failure"));
    const before = (await w.live()).assets.length;
    await expect(
      persistUploadedFrame({ repo: failing, discard: w.discard }, w.ctx(), asset, null),
    ).rejects.toThrow("fictional database failure");
    expect(w.discarded).toEqual([asset.id]);
    expect((await w.live()).assets.length).toBe(before);
    const { frames, selections } = await w.svc.listForProject(w.data.project.id);
    expect(frames).toEqual([]);
    expect(selections).toEqual([]);
  });

  it("a non-domain failure (a plain Error) also cleans up and propagates unchanged", async () => {
    const w = await world();
    const asset = w.stored({ label: "plain" });
    const failing = failingRepo(w.svc, new Error("socket closed"));
    await expect(
      persistUploadedFrame({ repo: failing, discard: w.discard }, w.ctx(), asset, null),
    ).rejects.toThrow("socket closed");
    expect(w.discarded).toEqual([asset.id]);
  });

  it("an identical frame already existed: it is re-selected and the redundant object is removed; the new Asset is not stored", async () => {
    const w = await world();
    const first = await persistUploadedFrame(
      { repo: w.svc, discard: w.discard },
      w.ctx(),
      w.stored({ label: "twin" }),
      null,
    );
    await persistUploadedFrame(
      { repo: w.svc, discard: w.discard },
      w.ctx(),
      w.stored({ label: "other" }),
      null,
    ); // v2 canonical
    const again = w.stored({ label: "twin" }); // same bytes (checksum), a different Asset row
    const live = await w.live();
    const assets = live.assets.length;
    const r = await persistUploadedFrame(
      { repo: w.svc, discard: w.discard },
      contextOfLive(w.data),
      again,
      null,
    );
    expect(r.created).toBe(false);
    expect(r.frame.id).toBe(first.frame.id);
    expect(r.selection?.productionFrameId).toBe(first.frame.id);
    expect(w.discarded).toEqual([again.id]);
    expect((await w.live()).assets.length).toBe(assets);
  });
});

function contextOfLive(data: ReturnType<typeof buildSeedProject>) {
  return buildShotContext(data, shotByCode(data, "3A").id);
}
