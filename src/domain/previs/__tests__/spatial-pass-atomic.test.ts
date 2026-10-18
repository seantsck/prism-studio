import { describe, expect, it } from "vitest";
import { assetSchema, type Asset } from "@/domain/schemas";
import {
  persistPassBundle,
  removePassAssets,
  type PassStoreDeps,
  type PassWrite,
} from "@/server/spatial-pass-store";
import {
  MAX_MANIFEST_JSON_CHARS,
  buildObjectManifest,
  checkUploadShape,
  expectedUploadParts,
} from "../spatial-passes";

const iso = "2026-10-18T00:00:00.000Z";
const mkAsset = (id: string, name: string): Asset =>
  assetSchema.parse({
    id,
    projectId: "p1",
    createdBy: null,
    type: "data",
    purpose: "spatial_control",
    source: "3d_render",
    name,
    originalFilename: `${id}.bin`,
    storageProvider: "local",
    bucket: null,
    objectPath: `p1/${id}/${id}.bin`,
    mime: "application/x-prism-depth-f32",
    byteSize: 4,
    checksum: `sum-${id}`,
    width: 1912,
    height: 800,
    durationMs: null,
    frameRate: null,
    sampleRate: null,
    channels: null,
    tags: [],
    notes: "",
    metadata: {},
    createdAt: iso,
    updatedAt: iso,
  });

/** In-memory object store + asset table with injectable failures. */
function world(opts: { failPutAt?: number; failUpsertAt?: number; failRemoveObject?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const rows = new Map<string, Asset>();
  const calls = { put: 0, upsert: 0, removeAsset: 0, removeObject: 0 };
  const deps: PassStoreDeps = {
    async putObject(path, bytes) {
      calls.put++;
      if (opts.failPutAt === calls.put) throw new Error("injected: upload failed");
      objects.set(path, bytes);
    },
    async upsertAsset(asset) {
      calls.upsert++;
      if (opts.failUpsertAt === calls.upsert) throw new Error("injected: asset row failed");
      rows.set(asset.id, asset);
    },
    async removeAsset(id) {
      calls.removeAsset++;
      if (!rows.delete(id)) throw new Error("no such row"); // an already-removed row is an error the helper must tolerate
    },
    async removeObject(asset) {
      calls.removeObject++;
      if (opts.failRemoveObject) throw new Error("injected: storage cleanup failed");
      if (!objects.delete(asset.objectPath!)) throw new Error("no such object");
    },
  };
  return { objects, rows, calls, deps };
}

const writes = (n: number): PassWrite[] =>
  Array.from({ length: n }, (_, i) => {
    const asset = mkAsset(`a${i}`, `pass ${i}`);
    return { asset, bytes: new Uint8Array([i]), objectPath: asset.objectPath!, mime: asset.mime! };
  });

/** history that must survive any failed capture */
function withHistory(w: ReturnType<typeof world>) {
  const old = mkAsset("old-depth", "historical depth");
  w.objects.set(old.objectPath!, new Uint8Array([9]));
  w.rows.set(old.id, old);
  return { old, snapshot: () => JSON.stringify([[...w.objects.keys()], [...w.rows.keys()]]) };
}

describe("spatial pass bundle: all-or-nothing persistence", () => {
  it("success keeps every object and row and returns the recorded bundle", async () => {
    const w = world();
    const out = await persistPassBundle(w.deps, writes(4), async () => ({ existing: false, id: "bundle" }));
    expect(out).toEqual({ existing: false, id: "bundle" });
    expect(w.objects.size).toBe(4);
    expect(w.rows.size).toBe(4);
  });

  it("a MID-CAPTURE upload failure (depth + ids stored, first mask throws) leaves nothing behind", async () => {
    const w = world({ failPutAt: 3 });
    const h = withHistory(w);
    const before = h.snapshot();
    let recorded = false;
    await expect(
      persistPassBundle(w.deps, writes(4), async () => {
        recorded = true;
        return { existing: false };
      }),
    ).rejects.toThrow("injected: upload failed"); // surfaced to the caller
    expect(w.calls.put).toBe(3); // depth and ids were really uploaded before the failure
    expect(w.calls.upsert).toBe(2); // …and had asset rows
    expect(recorded).toBe(false); // the bundle row was never written
    expect(w.rows.has("a0") || w.rows.has("a1")).toBe(false); // no asset rows from the failed capture
    expect([...w.objects.keys()].filter((k) => /a\d/.test(k))).toEqual([]); // no storage objects from it
    expect(h.snapshot()).toBe(before); // history untouched
    expect(w.objects.has(h.old.objectPath!)).toBe(true);
    expect(w.rows.has(h.old.id)).toBe(true);
  });

  it("an asset-row failure after its object was stored removes that object too", async () => {
    const w = world({ failUpsertAt: 2 });
    const h = withHistory(w);
    const before = h.snapshot();
    await expect(persistPassBundle(w.deps, writes(3), async () => ({ existing: false }))).rejects.toThrow(
      "injected: asset row failed",
    );
    expect(h.snapshot()).toBe(before);
  });

  it("a bundle-row (database) failure AFTER every upload succeeded removes all objects and rows", async () => {
    const w = world();
    const h = withHistory(w);
    const before = h.snapshot();
    await expect(
      persistPassBundle(w.deps, writes(4), async () => {
        expect(w.objects.size).toBe(5); // all four uploads + the historical one are present when the write fails
        throw new Error("injected: database write failed");
      }),
    ).rejects.toThrow("injected: database write failed");
    expect(w.calls.put).toBe(4);
    expect(h.snapshot()).toBe(before);
  });

  it("a cleanup failure never replaces the original error", async () => {
    const w = world({ failPutAt: 3, failRemoveObject: true });
    await expect(persistPassBundle(w.deps, writes(4), async () => ({ existing: false }))).rejects.toThrow(
      "injected: upload failed", // not "injected: storage cleanup failed"
    );
    expect(w.calls.removeObject).toBe(4); // every removal was still attempted
  });

  it("losing a race with an identical capture removes this attempt's surplus and returns the existing bundle", async () => {
    const w = world();
    const h = withHistory(w);
    const before = h.snapshot();
    const out = await persistPassBundle(w.deps, writes(3), async () => ({ existing: true, id: "winner" }));
    expect(out).toEqual({ existing: true, id: "winner" });
    expect(h.snapshot()).toBe(before);
  });

  it("cleanup is idempotent: repeating it, or cleaning what is already gone, does no harm", async () => {
    const w = world();
    const h = withHistory(w);
    const ws = writes(3);
    for (const x of ws) {
      await w.deps.putObject(x.objectPath, x.bytes, x.mime);
      await w.deps.upsertAsset(x.asset);
    }
    const assets = ws.map((x) => x.asset);
    await removePassAssets(w.deps, assets);
    const once = h.snapshot();
    await expect(removePassAssets(w.deps, assets)).resolves.toBeUndefined(); // second pass: everything already missing
    await expect(removePassAssets(w.deps, assets)).resolves.toBeUndefined();
    expect(h.snapshot()).toBe(once);
    expect(w.objects.has(h.old.objectPath!) && w.rows.has(h.old.id)).toBe(true); // unrelated state intact
  });
});

describe("spatial capture upload shape (bounds independent of any proxy limit)", () => {
  const manifest = buildObjectManifest({
    setObjects: [{ id: "s1" }],
    characters: [
      { characterId: "c1", blockingId: "b1" },
      { characterId: "c2", blockingId: "b2" },
    ],
  });
  const W = 1912;
  const H = 800;
  const exact = expectedUploadParts(manifest, W, H);

  it("expects exactly depth, object ids and ONE mask per Character in the manifest, at canonical sizes", () => {
    expect(exact).toEqual([
      { key: "depth", size: 1912 * 800 * 4 },
      { key: "objectIds", size: 1912 * 800 * 4 },
      { key: "mask:c1", size: 1912 * 800 },
      { key: "mask:c2", size: 1912 * 800 },
    ]);
    const ok = checkUploadShape(exact, manifest, W, H);
    expect(ok).toEqual({ ok: true, totalBytes: 6_118_400 * 2 + 1_529_600 * 2 });
    // the whole legitimate payload is ~15.3 MB: far below any proxy ceiling
    expect(ok.ok && ok.totalBytes).toBeLessThan(16 * 1024 * 1024);
  });

  it("rejects truncated and padded rasters", () => {
    const bump = (key: string, by: number) =>
      exact.map((p) => (p.key === key ? { ...p, size: p.size + by } : p));
    expect(checkUploadShape(bump("depth", -4), manifest, W, H).ok).toBe(false);
    expect(checkUploadShape(bump("depth", 4), manifest, W, H).ok).toBe(false);
    expect(checkUploadShape(bump("objectIds", 1), manifest, W, H).ok).toBe(false);
    expect(checkUploadShape(bump("mask:c1", -1), manifest, W, H).ok).toBe(false);
    expect(checkUploadShape(bump("mask:c2", 1), manifest, W, H).ok).toBe(false);
  });

  it("rejects extra, missing and duplicate files (the mask count is bounded by the saved Characters)", () => {
    expect(checkUploadShape([...exact, { key: "mask:c3", size: W * H }], manifest, W, H).ok).toBe(false);
    expect(checkUploadShape([...exact, { key: "mask:c3", size: 55 * 1024 * 1024 }], manifest, W, H).ok).toBe(
      false,
    );
    expect(checkUploadShape([...exact, { key: "extra", size: 1 }], manifest, W, H).ok).toBe(false);
    expect(
      checkUploadShape(
        exact.filter((p) => p.key !== "mask:c2"),
        manifest,
        W,
        H,
      ).ok,
    ).toBe(false);
    expect(
      checkUploadShape(
        exact.filter((p) => p.key !== "depth"),
        manifest,
        W,
        H,
      ).ok,
    ).toBe(false);
    expect(checkUploadShape([...exact, exact[0]!], manifest, W, H).ok).toBe(false);
    // a single arbitrary 55 MB blob is not accepted just because the body limit would allow it
    expect(checkUploadShape([{ key: "depth", size: 55 * 1024 * 1024 }], manifest, W, H).ok).toBe(false);
  });

  it("a Shot with no Characters expects no masks at all", () => {
    const none = buildObjectManifest({ setObjects: [{ id: "s1" }], characters: [] });
    expect(expectedUploadParts(none, W, H).map((p) => p.key)).toEqual(["depth", "objectIds"]);
    expect(
      checkUploadShape([...expectedUploadParts(none, W, H), { key: "mask:c1", size: W * H }], none, W, H).ok,
    ).toBe(false);
  });

  it("bounds the manifest text", () => {
    expect(MAX_MANIFEST_JSON_CHARS).toBe(512 * 1024);
  });
});
