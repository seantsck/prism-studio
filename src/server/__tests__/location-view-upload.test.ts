import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@/data/memory-repository";
import type { LocationViewRepository } from "@/data/location-view-repository";
import { newUploadAsset } from "@/domain/__tests__/production-frame-fixtures";
import type { Asset } from "@/domain/schemas";
import { persistUploadedLocationView } from "../location-view-upload";

/**
 * Phase 2G.3: an uploaded Location View leaves no durable broken state. Memory repository, no Storage, no network.
 */
async function setup() {
  const repo = new MemoryRepository();
  const data = (await repo.loadProject("ojousama"))!;
  const location = data.locations.find((l) => l.name === "Sky-View Restaurant")!;
  const discarded: string[] = [];
  const discard = async (a: Asset) => {
    discarded.push(a.id);
  };
  const upload = (label: string, o: { width?: number; height?: number } = {}) => ({
    ...newUploadAsset(data.project.id, { label, ...o }),
    purpose: "location_ref" as const,
  });
  const assetCount = async () => (await repo.loadProject("ojousama"))!.assets.length;
  return { repo, location, discarded, discard, upload, assetCount };
}

describe("persistUploadedLocationView", () => {
  it("success: one private location_ref Asset and its view, stored together; nothing discarded", async () => {
    const { repo, location, discarded, discard, upload, assetCount } = await setup();
    const before = await assetCount();
    const asset = upload("window", { width: 900, height: 1200 }); // portrait: accepted, never cropped
    const r = await persistUploadedLocationView(
      { repo: repo.locationViews, discard },
      location,
      asset,
      {
        name: "Window side",
        kind: "side",
      },
      null,
    );
    expect(r.created).toBe(true);
    expect(r.view).toMatchObject({ source: "upload", assetId: asset.id, width: 900, height: 1200 });
    expect(await assetCount()).toBe(before + 1);
    expect(discarded).toEqual([]);
  });

  it("a duplicate returns the existing view and removes the redundant object", async () => {
    const { repo, location, discarded, discard, upload, assetCount } = await setup();
    const first = upload("dup");
    await persistUploadedLocationView(
      { repo: repo.locationViews, discard },
      location,
      first,
      { name: "Bar", kind: "zone" },
      null,
    );
    const count = await assetCount();
    const again = { ...upload("dup"), id: "second-upload" }; // same bytes (checksum) as `first`
    const r = await persistUploadedLocationView(
      { repo: repo.locationViews, discard },
      location,
      again,
      { name: "Bar", kind: "zone" },
      null,
    );
    expect(r.created).toBe(false);
    expect(discarded).toEqual(["second-upload"]);
    expect(await assetCount()).toBe(count);
  });

  it("a refused spec or a failed write removes the stored object and writes nothing", async () => {
    const { repo, location, discarded, discard, upload, assetCount } = await setup();
    const before = await assetCount();
    const bad = upload("bad");
    await expect(
      persistUploadedLocationView(
        { repo: repo.locationViews, discard },
        location,
        bad,
        { name: "", kind: "zone" },
        null,
      ),
    ).rejects.toThrow(/Name the Location View/);
    const failing: LocationViewRepository = {
      ...repo.locationViews,
      create: async () => {
        throw new Error("database unavailable");
      },
    } as unknown as LocationViewRepository;
    const lost = upload("lost");
    await expect(
      persistUploadedLocationView(
        { repo: failing, discard },
        location,
        lost,
        { name: "Entry", kind: "entrance" },
        null,
      ),
    ).rejects.toThrow(/database unavailable/);
    expect(discarded).toEqual([bad.id, lost.id]);
    expect(await assetCount()).toBe(before);
  });
});
