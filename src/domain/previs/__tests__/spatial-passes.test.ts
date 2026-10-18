import { describe, expect, it } from "vitest";
import { evaluateCameraPath } from "../camera-path";
import { buildHotelCanopyCameraPath, buildHotelCanopyEngineScene } from "../hotel-canopy";
import { buildPrevisDocument } from "../document";
import { bookmarkFromCamera } from "../camera";
import {
  CHARACTER_MASKS_SCHEMA,
  CHARACTER_MASK_FORMAT,
  DEPTH_FORMAT,
  OBJECT_ID_FORMAT,
  SPATIAL_MIME_LIST,
  bookmarkCameraFingerprint,
  buildControlFrame,
  buildControlPassesReference,
  buildObjectManifest,
  cameraSourceFromBookmark,
  cameraSourceFromPath,
  controlCameraFromPose,
  controlCameraFromState,
  countObjectPixels,
  decodeDepthF32,
  decodeMaskU8,
  decodeObjectIdsU32,
  depthMatchesIds,
  depthMetadata,
  depthPreviewRgba,
  deriveCharacterMasks,
  encodeDepthF32,
  encodeMaskU8,
  encodeObjectIdsU32,
  expectedManifest,
  manifestIdentity,
  maskPreviewRgba,
  objectIdPreviewRgba,
  objectIndexColor,
  pickCurrentBundle,
  spatialBundleFingerprint,
  spatialPassStaleReasons,
  validateDepth,
  validateMaskValues,
  withPixelCounts,
  type CharacterMasksJson,
  type ControlCameraSource,
  type ObjectManifest,
  type SpatialBundleLike,
  type SpatialCurrentState,
} from "../spatial-passes";

const SCENE_FP = "a".repeat(64);
const BLOCK_FP = "b".repeat(64);
const PATH_FP = "c".repeat(64);

const pathSource = (timeMs = 2000, fp = PATH_FP): ControlCameraSource => {
  const path = buildHotelCanopyCameraPath();
  return cameraSourceFromPath(path, { id: "path-1", revision: 3, pathFingerprint: fp }, timeMs);
};

const manifestOf = (
  sets: string[] = ["s-1", "s-2"],
  chars: Array<[string, string]> = [
    ["char-yumeko", "blk-1"],
    ["char-sean", "blk-2"],
  ],
): ObjectManifest =>
  buildObjectManifest({
    setObjects: sets.map((id) => ({ id })),
    characters: chars.map(([characterId, blockingId]) => ({ characterId, blockingId })),
  });

describe("raw machine formats", () => {
  it("round-trips Float32 depth, Uint32 ids and Uint8 masks little-endian", () => {
    const depth = new Float32Array([0, 0.05, 1.5, 12.25, 1999.999]);
    const bytes = encodeDepthF32(depth);
    expect(bytes.byteLength).toBe(20);
    // 1.5f = 0x3FC00000 little-endian
    expect(Array.from(bytes.slice(8, 12))).toEqual([0x00, 0x00, 0xc0, 0x3f]);
    expect(Array.from(decodeDepthF32(bytes, 5, 1))).toEqual(Array.from(depth));

    const ids = new Uint32Array([0, 1, 2, 70000, 0xffffffff]);
    const idBytes = encodeObjectIdsU32(ids);
    expect(Array.from(idBytes.slice(12, 16))).toEqual([0x70, 0x11, 0x01, 0x00]); // 70000 = 0x11170
    expect(Array.from(decodeObjectIdsU32(idBytes, 5, 1))).toEqual(Array.from(ids));

    const mask = new Uint8Array([0, 255, 255, 0]);
    expect(Array.from(decodeMaskU8(encodeMaskU8(mask), 2, 2))).toEqual([0, 255, 255, 0]);
  });

  it("refuses data of the wrong size (never guesses a shape)", () => {
    expect(() => decodeDepthF32(new Uint8Array(7), 2, 1)).toThrow(/8 bytes/);
    expect(() => decodeObjectIdsU32(new Uint8Array(12), 2, 2)).toThrow(/16 bytes/);
    expect(() => decodeMaskU8(new Uint8Array(3), 2, 2)).toThrow(/4 bytes/);
  });

  it("uses truthful machine MIME types, never image types", () => {
    expect(SPATIAL_MIME_LIST).toHaveLength(3);
    for (const m of SPATIAL_MIME_LIST) {
      expect(m.startsWith("application/x-prism-")).toBe(true);
      expect(m.startsWith("image/")).toBe(false);
    }
    expect(DEPTH_FORMAT).toBe("prism.depth-f32.v1");
    expect(OBJECT_ID_FORMAT).toBe("prism.object-id-u32.v1");
    expect(CHARACTER_MASK_FORMAT).toBe("prism.character-mask-u8.v1");
  });
});

describe("depth validation", () => {
  it("accepts background (0) and in-range geometry; reports stats", () => {
    const r = validateDepth(new Float32Array([0, 0.5, 3, 40, 0]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stats).toEqual({ validPixelCount: 3, minDepth: 0.5, maxDepth: 40 });
    const meta = depthMetadata(r.ok ? r.stats : { validPixelCount: 0, minDepth: null, maxDepth: null });
    expect(meta).toMatchObject({
      schema: DEPTH_FORMAT,
      semantic: "linear-view-space-depth",
      units: "metres",
      backgroundValue: 0,
      rowOrder: "top-to-bottom",
      endianness: "little",
      near: 0.05,
      far: 2000,
    });
  });

  it("rejects NaN, Infinity, negative and out-of-range values", () => {
    expect(validateDepth(new Float32Array([1, NaN])).ok).toBe(false);
    expect(validateDepth(new Float32Array([1, Infinity])).ok).toBe(false);
    expect(validateDepth(new Float32Array([1, -0.5])).ok).toBe(false);
    expect(validateDepth(new Float32Array([0.01])).ok).toBe(false); // inside the near plane
    expect(validateDepth(new Float32Array([5000])).ok).toBe(false); // beyond the far plane
  });

  it("an all-background frame is valid (nothing visible)", () => {
    const r = validateDepth(new Float32Array(10));
    expect(r.ok && r.stats.validPixelCount === 0 && r.stats.minDepth === null).toBe(true);
  });
});

describe("object manifest", () => {
  it("assigns bundle-local indices 1..N deterministically, set objects first then Character proxies", () => {
    const m = manifestOf(
      ["z-obj", "a-obj"],
      [
        ["char-b", "x"],
        ["char-a", "y"],
      ],
    );
    expect(m.objects.map((o) => [o.index, o.semanticId])).toEqual([
      [1, "set_object:a-obj"],
      [2, "set_object:z-obj"],
      [3, "character_proxy:char-a"],
      [4, "character_proxy:char-b"],
    ]);
    expect(m.objects.map((o) => o.category)).toEqual([
      "set_object",
      "set_object",
      "character_proxy",
      "character_proxy",
    ]);
    expect(m.objects[2]).toMatchObject({ characterId: "char-a", blockingId: "y" });
    expect(m.objects[0]).toMatchObject({ sceneObjectId: "a-obj" });
  });

  it("does not depend on input order or labels (so not on runtime THREE uuids or selection)", () => {
    const a = buildObjectManifest({
      setObjects: [
        { id: "s2", name: "Box" },
        { id: "s1", name: "Car" },
      ],
      characters: [{ characterId: "c1", blockingId: "b1", name: "Yumeko" }],
    });
    const b = buildObjectManifest({
      setObjects: [{ id: "s1" }, { id: "s2" }],
      characters: [{ characterId: "c1", blockingId: "b1" }],
    });
    expect(manifestIdentity(a)).toEqual(manifestIdentity(b));
  });

  it("indices are BUNDLE-LOCAL: adding an object may renumber, and the bundle fingerprint then differs", () => {
    const before = manifestOf(["s-2"], []);
    const after = manifestOf(["s-1", "s-2"], []);
    expect(before.objects.find((o) => o.semanticId === "set_object:s-2")!.index).toBe(1);
    expect(after.objects.find((o) => o.semanticId === "set_object:s-2")!.index).toBe(2);
    const base = {
      shotId: "shot",
      sceneFingerprint: SCENE_FP,
      blockingFingerprint: null,
      camera: pathSource(),
      width: 1912,
      height: 800,
    };
    expect(spatialBundleFingerprint({ ...base, manifest: before })).not.toBe(
      spatialBundleFingerprint({ ...base, manifest: after }),
    );
  });

  it("rejects a duplicate production object", () => {
    expect(() => buildObjectManifest({ setObjects: [{ id: "s" }, { id: "s" }], characters: [] })).toThrow(
      /Duplicate/,
    );
  });

  it("is derived from the SAVED Set + blocking: lights, hidden objects and hidden proxies are excluded", () => {
    const doc = buildPrevisDocument({ engineScene: buildHotelCanopyEngineScene() });
    const withHidden = {
      ...doc,
      objects: [
        ...doc.objects,
        { ...doc.objects[0], id: "hidden-1", visible: false },
        { ...doc.objects[0], id: "light-1", kind: "light" as const },
      ],
    };
    const m = expectedManifest(
      withHidden,
      [
        { characterId: "c1", id: "b1", entry: { visibility: true } },
        { characterId: "c2", id: "b2", entry: { visibility: false } },
      ],
      { c1: "Yumeko" },
    );
    const ids = m.objects.map((o) => o.semanticId);
    expect(ids).not.toContain("set_object:hidden-1");
    expect(ids).not.toContain("set_object:light-1");
    expect(ids).toContain("character_proxy:c1");
    expect(ids).not.toContain("character_proxy:c2");
    expect(m.objects.find((o) => o.characterId === "c1")?.label).toBe("Yumeko");
    // every non-light visible set object of the document is present
    const expected = doc.objects.filter((o) => o.kind !== "light" && o.visible).length;
    expect(m.objects.filter((o) => o.category === "set_object")).toHaveLength(expected);
  });
});

describe("object ids and Character masks", () => {
  // 6×3 raster, row 0 = TOP. 1 = wall (set object), 2 = Yumeko (front), 3 = Sean (partly behind Yumeko)
  const W = 6;
  const H = 3;
  const manifest = buildObjectManifest({
    setObjects: [{ id: "wall" }],
    characters: [
      { characterId: "yumeko", blockingId: "b1" },
      { characterId: "sean", blockingId: "b2" },
    ],
  });
  const idx = (cid: string) => manifest.objects.find((o) => o.characterId === cid)!.index;
  const Y = idx("yumeko");
  const S = idx("sean");
  // Yumeko occludes the left part of Sean: Sean's pixels at x=2,3 are replaced by Yumeko
  const ids = new Uint32Array([
    1,
    1,
    1,
    1,
    1,
    1, //
    1,
    Y,
    Y,
    S,
    S,
    1,
    1,
    Y,
    Y,
    S,
    S,
    1,
  ]);

  it("counts pixels per object and rejects an index outside the manifest", () => {
    const c = countObjectPixels(ids, manifest.objects.length);
    expect(c.ok && Array.from(c.counts)).toEqual([0, 10, 4, 4]);
    expect(countObjectPixels(new Uint32Array([0, 9]), manifest.objects.length).ok).toBe(false);
    const withCounts = withPixelCounts(manifest, (c as { counts: Uint32Array }).counts);
    expect(withCounts.objects.map((o) => o.visiblePixelCount)).toEqual([10, 4, 4]);
  });

  it("derives one exact binary mask per Character from the id raster", () => {
    const masks = deriveCharacterMasks(ids, manifest);
    expect(masks.map((m) => m.characterId).sort()).toEqual(["sean", "yumeko"]);
    for (const m of masks) {
      expect(validateMaskValues(m.mask)).toBe(true);
      for (let i = 0; i < ids.length; i++) expect(m.mask[i] === 255).toBe(ids[i] === m.objectIndex);
    }
    // the wall is a Set object: no mask
    expect(
      masks.some((m) => m.objectIndex === manifest.objects.find((o) => o.category === "set_object")!.index),
    ).toBe(false);
  });

  it("masks are VISIBLE pixels: the occluded Character's mask excludes pixels the front Character covers", () => {
    const [sean] = deriveCharacterMasks(ids, manifest).filter((m) => m.characterId === "sean");
    const yumekoMask = deriveCharacterMasks(ids, manifest).find((m) => m.characterId === "yumeko")!;
    for (let i = 0; i < ids.length; i++)
      expect(sean.mask[i] === 255 && yumekoMask.mask[i] === 255).toBe(false);
    // 2 columns × 2 rows of Sean are visible; a Sean standing fully in front would have owned all 8
    expect(sean.visiblePixelCount).toBe(4);
  });

  it("a Character that is enabled but fully occluded keeps its manifest entry and an all-zero mask", () => {
    const hidden = new Uint32Array(ids).map((v) => (v === S ? 1 : v)); // wall covers Sean entirely
    const m = deriveCharacterMasks(hidden, manifest).find((x) => x.characterId === "sean")!;
    expect(m.visiblePixelCount).toBe(0);
    expect(m.mask.every((v) => v === 0)).toBe(true);
    expect(manifest.objects.some((o) => o.characterId === "sean")).toBe(true);
  });

  it("uses one stored convention: row 0 is the TOP row, flat index = y·width + x", () => {
    const m = deriveCharacterMasks(ids, manifest).find((x) => x.characterId === "yumeko")!;
    // Yumeko occupies rows 1 and 2, columns 1 and 2 (row 0 = top)
    const on: Array<[number, number]> = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m.mask[y * W + x] === 255) on.push([x, y]);
    expect(on).toEqual([
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
    ]);
  });

  it("depth and ids must cover exactly the same pixels", () => {
    const depth = new Float32Array(ids.length).map((_, i) => (ids[i] > 0 ? 2 : 0));
    expect(depthMatchesIds(depth, ids)).toBe(true);
    depth[0] = 0;
    expect(depthMatchesIds(depth, ids)).toBe(false);
    expect(depthMatchesIds(new Float32Array(3), ids)).toBe(false);
  });

  it("rejects a mask with values other than 0 and 255", () => {
    expect(validateMaskValues(new Uint8Array([0, 255, 128]))).toBe(false);
    expect(validateMaskValues(new Uint8Array([0, 255, 0]))).toBe(true);
  });
});

describe("camera source (explicit, by value, never the navigation camera)", () => {
  it("a camera-path capture uses the SHARED evaluator at the playhead time", () => {
    const path = buildHotelCanopyCameraPath();
    const src = cameraSourceFromPath(path, { id: "p", revision: 2, pathFingerprint: PATH_FP }, 1750);
    expect(src.kind).toBe("camera_path");
    const state = evaluateCameraPath(path, 1750)!;
    expect(src.camera).toEqual(controlCameraFromState(state));
    expect(src.kind === "camera_path" && src.timeMs).toBe(1750);
    expect(src.kind === "camera_path" && src.cameraPathRevision).toBe(2);
    // different times give different cameras
    const other = cameraSourceFromPath(path, { id: "p", revision: 2, pathFingerprint: PATH_FP }, 3000);
    expect(other.camera).not.toEqual(src.camera);
  });

  it("freezes enough intrinsics/extrinsics to reconstruct rays", () => {
    const c = pathSource(1000).camera;
    expect(c).toMatchObject({ sensorHeightMm: 24, near: 0.05, far: 2000, width: 1912, height: 800 });
    expect(c.aspect).toBeCloseTo(1912 / 800, 5);
    expect(c.fovVerticalDegrees).toBeCloseTo((2 * Math.atan(24 / (2 * c.focalLengthMm)) * 180) / Math.PI, 4);
    expect(Math.hypot(c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w)).toBeCloseTo(1, 5);
    expect(c.quaternion.w).toBeGreaterThanOrEqual(0);
    expect(Object.keys(c.position).sort()).toEqual(["x", "y", "z"]);
  });

  it("refuses a time that is not a whole millisecond inside the path", () => {
    const path = buildHotelCanopyCameraPath();
    const rec = { id: "p", revision: 1, pathFingerprint: PATH_FP };
    expect(() => cameraSourceFromPath(path, rec, 12.5)).toThrow();
    expect(() => cameraSourceFromPath(path, rec, -1)).toThrow();
    expect(() => cameraSourceFromPath(path, rec, path.durationMs + 1)).toThrow();
  });

  it("a bookmark capture derives from the frozen bookmark value and has its own identity", () => {
    const value = bookmarkFromCamera({
      id: "c",
      label: "CAM-A",
      position: { x: 1, y: 1.6, z: 6 },
      rotation: { x: 0, y: 0.2, z: 0 },
      focalLengthMm: 35,
    });
    const src = cameraSourceFromBookmark({ id: "bm-1" }, value);
    expect(src.kind).toBe("bookmark");
    expect(src.kind === "bookmark" && src.bookmarkFingerprint).toBe(bookmarkCameraFingerprint(value));
    const moved = { ...value, position: { ...value.position, x: 1.5 } };
    expect(bookmarkCameraFingerprint(moved)).not.toBe(bookmarkCameraFingerprint(value));
    // the same pose through the explicit pose helper matches the bookmark's camera
    expect(src.camera).toEqual(controlCameraFromPose(value.position, value.rotation, 35));
  });

  it("builds a control frame at the full 1912×800 Production Frame", () => {
    const frame = buildControlFrame({
      shotId: "shot",
      scene: { documentId: "d", revision: 4, fingerprint: SCENE_FP },
      blockingFingerprint: BLOCK_FP,
      camera: pathSource(2000),
    });
    expect(frame).toMatchObject({
      schema: "prism.spatial-control-frame.v1",
      width: 1912,
      height: 800,
      capturedTimeMs: 2000,
    });
    expect(
      buildControlFrame({
        ...frame,
        camera: cameraSourceFromBookmark(
          { id: "b" },
          bookmarkFromCamera({
            id: "c",
            label: "c",
            position: { x: 0, y: 1, z: 5 },
            rotation: { x: 0, y: 0, z: 0 },
            focalLengthMm: 35,
          }),
        ),
      }).capturedTimeMs,
    ).toBe(0);
  });
});

describe("bundle fingerprint", () => {
  const manifest = manifestOf();
  const base = {
    shotId: "shot-3a",
    sceneFingerprint: SCENE_FP,
    blockingFingerprint: BLOCK_FP as string | null,
    camera: pathSource(2000),
    width: 1912,
    height: 800,
    manifest,
  };
  const fp = (o: Partial<typeof base> = {}) => spatialBundleFingerprint({ ...base, ...o });

  it("is deterministic", () => {
    expect(fp()).toBe(fp());
    expect(fp()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with the shot, scene, rendered blocking, camera source/time, size and manifest", () => {
    const f = fp();
    expect(fp({ shotId: "shot-3b" })).not.toBe(f);
    expect(fp({ sceneFingerprint: "d".repeat(64) })).not.toBe(f);
    expect(fp({ blockingFingerprint: "e".repeat(64) })).not.toBe(f);
    expect(fp({ blockingFingerprint: null })).not.toBe(f);
    expect(fp({ camera: pathSource(2500) })).not.toBe(f);
    expect(fp({ camera: pathSource(2000, "f".repeat(64)) })).not.toBe(f);
    expect(fp({ width: 956, height: 400 })).not.toBe(f);
    expect(fp({ manifest: manifestOf(["s-1"]) })).not.toBe(f);
  });

  it("ignores descriptive manifest data (labels, pixel counts)", () => {
    const labelled: ObjectManifest = {
      ...manifest,
      objects: manifest.objects.map((o) => ({ ...o, label: "Pretty name", visiblePixelCount: 123 })),
    };
    expect(fp({ manifest: labelled })).toBe(fp());
  });
});

describe("staleness (scene, camera, blocking; never audio)", () => {
  const camera = pathSource(2000);
  const bundle = { sceneFingerprint: SCENE_FP, blockingFingerprint: BLOCK_FP as string | null, camera };
  const current: SpatialCurrentState = {
    sceneFingerprint: SCENE_FP,
    blockingFingerprint: BLOCK_FP,
    pathFingerprint: PATH_FP,
    bookmarkCameraFingerprint: null,
  };

  it("is current when scene, camera path and rendered blocking match", () => {
    expect(spatialPassStaleReasons(bundle, current)).toEqual([]);
  });

  it("STALE SCENE when the saved Set changes", () => {
    expect(spatialPassStaleReasons(bundle, { ...current, sceneFingerprint: "d".repeat(64) })).toEqual([
      "scene",
    ]);
    expect(spatialPassStaleReasons(bundle, { ...current, sceneFingerprint: null })).toContain("scene");
  });

  it("STALE CAMERA when the saved camera path changes (or disappears)", () => {
    expect(spatialPassStaleReasons(bundle, { ...current, pathFingerprint: "d".repeat(64) })).toEqual([
      "camera",
    ]);
    expect(spatialPassStaleReasons(bundle, { ...current, pathFingerprint: null })).toEqual(["camera"]);
  });

  it("STALE CAMERA for a bookmark capture only when the Production Camera bookmark changes", () => {
    const value = bookmarkFromCamera({
      id: "c",
      label: "c",
      position: { x: 0, y: 1, z: 5 },
      rotation: { x: 0, y: 0, z: 0 },
      focalLengthMm: 35,
    });
    const bm = { ...bundle, camera: cameraSourceFromBookmark({ id: "bm" }, value) };
    const cur = {
      ...current,
      pathFingerprint: null,
      bookmarkCameraFingerprint: bookmarkCameraFingerprint(value),
    };
    expect(spatialPassStaleReasons(bm, cur)).toEqual([]);
    // a camera path now exists for the Shot: the bookmark capture is still exactly what it was
    expect(spatialPassStaleReasons(bm, { ...cur, pathFingerprint: PATH_FP })).toEqual([]);
    const moved = bookmarkCameraFingerprint({ ...value, focalLengthMm: 50 });
    expect(spatialPassStaleReasons(bm, { ...cur, bookmarkCameraFingerprint: moved })).toEqual(["camera"]);
  });

  it("STALE BLOCKING when the rendered blocking layer changes (including appearing or disappearing)", () => {
    expect(spatialPassStaleReasons(bundle, { ...current, blockingFingerprint: "d".repeat(64) })).toEqual([
      "blocking",
    ]);
    expect(spatialPassStaleReasons(bundle, { ...current, blockingFingerprint: null })).toEqual(["blocking"]);
    expect(
      spatialPassStaleReasons(
        { ...bundle, blockingFingerprint: null },
        { ...current, blockingFingerprint: BLOCK_FP },
      ),
    ).toEqual(["blocking"]);
  });

  it("can report several reasons at once", () => {
    expect(
      spatialPassStaleReasons(bundle, {
        sceneFingerprint: "d".repeat(64),
        blockingFingerprint: null,
        pathFingerprint: "e".repeat(64),
        bookmarkCameraFingerprint: null,
      }),
    ).toEqual(["scene", "camera", "blocking"]);
  });

  it("audio is not an input: the current state has no audio field at all", () => {
    expect(Object.keys(current).sort()).toEqual([
      "blockingFingerprint",
      "bookmarkCameraFingerprint",
      "pathFingerprint",
      "sceneFingerprint",
    ]);
  });

  it("selects the latest CURRENT bundle, never merely the newest", () => {
    const mk = (id: string, createdAt: string, over: Partial<typeof bundle> = {}) => ({
      id,
      createdAt,
      ...bundle,
      ...over,
    });
    const oldCurrent = mk("old", "2026-10-17T10:00:00Z");
    const newerCurrent = mk("newer", "2026-10-17T11:00:00Z");
    const newestStale = mk("newest-stale", "2026-10-17T12:00:00Z", { blockingFingerprint: "d".repeat(64) });
    expect(pickCurrentBundle([oldCurrent, newestStale, newerCurrent], current)?.id).toBe("newer");
    expect(pickCurrentBundle([newestStale], current)).toBeNull();
    expect(pickCurrentBundle([], current)).toBeNull();
  });
});

describe("GenerationPackage reference", () => {
  const manifest = withPixelCounts(manifestOf(), new Uint32Array([0, 40, 30, 20, 10]));
  const masks: CharacterMasksJson = {
    schema: CHARACTER_MASKS_SCHEMA,
    masks: {
      "char-yumeko": {
        blockingId: "blk-1",
        blockingRevision: 2,
        blockingFingerprint: "1".repeat(64),
        objectIndex: 3,
        assetId: "asset-mask-y",
        encoding: CHARACTER_MASK_FORMAT,
        visiblePixelCount: 20,
      },
      "char-sean": {
        blockingId: "blk-2",
        blockingRevision: 1,
        blockingFingerprint: "2".repeat(64),
        objectIndex: 4,
        assetId: "asset-mask-s",
        encoding: CHARACTER_MASK_FORMAT,
        visiblePixelCount: 0,
      },
    },
  };
  const bundle: SpatialBundleLike = {
    id: "bundle-1",
    bundleFingerprint: "9".repeat(64),
    width: 1912,
    height: 800,
    camera: pathSource(2000),
    depth: {
      assetId: "asset-depth",
      encoding: DEPTH_FORMAT,
      metadata: depthMetadata({ validPixelCount: 10, minDepth: 1.25, maxDepth: 30 }),
    },
    objectIds: { assetId: "asset-ids", encoding: OBJECT_ID_FORMAT, manifest },
    characterMasks: masks,
  };

  it("references assets by id and carries manifest + camera BY VALUE (no URLs, no bytes)", () => {
    const ref = buildControlPassesReference(bundle);
    expect(ref).toMatchObject({
      schemaVersion: 1,
      bundleId: "bundle-1",
      cameraSource: "camera_path",
      width: 1912,
      height: 800,
      rowOrder: "top-to-bottom",
      depth: {
        assetId: "asset-depth",
        encoding: DEPTH_FORMAT,
        units: "metres",
        backgroundValue: 0,
        near: 0.05,
        far: 2000,
      },
      objectIds: { assetId: "asset-ids", encoding: OBJECT_ID_FORMAT },
    });
    expect(ref.camera).toEqual(bundle.camera);
    expect(ref.objectIds.manifest.objects).toHaveLength(4);
    expect(ref.characterMasks.map((m) => m.characterId)).toEqual(["char-sean", "char-yumeko"]); // sorted by id
    expect(ref.characterMasks.find((m) => m.characterId === "char-sean")).toMatchObject({
      visiblePixelCount: 0,
      blockingFingerprint: "2".repeat(64),
    });
    expect(JSON.stringify(ref)).not.toMatch(/https?:|blob:|X-Amz|token=|signature/i);
  });

  it("is frozen by value: mutating the stored bundle afterwards cannot change the reference", () => {
    const ref = buildControlPassesReference(bundle);
    const snapshot = JSON.stringify(ref);
    bundle.objectIds.manifest.objects[0].label = "mutated";
    bundle.camera.camera.position.x = 999;
    expect(JSON.stringify(ref)).toBe(snapshot);
    bundle.objectIds.manifest.objects[0].label = undefined;
    bundle.camera = pathSource(2000);
  });
});

describe("display previews (never canonical data)", () => {
  it("depth preview: nearest → dark, farthest → light, background black", () => {
    const px = depthPreviewRgba(new Float32Array([0, 2, 6, 10]));
    expect(px[0]).toBe(0); // background
    expect(px[4]).toBeLessThan(px[8]);
    expect(px[8]).toBeLessThan(px[12]);
    expect(px[12]).toBe(255);
    expect(px[4]).toBeGreaterThan(0); // nearest geometry is dark but distinguishable from background
  });

  it("object-id preview: deterministic false colour, background black, indices distinguishable", () => {
    const a = objectIdPreviewRgba(new Uint32Array([0, 1, 2, 3]));
    const b = objectIdPreviewRgba(new Uint32Array([0, 1, 2, 3]));
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a.slice(0, 3))).toEqual([0, 0, 0]);
    const colours = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => objectIndexColor(i).join(","));
    expect(new Set(colours).size).toBe(8);
  });

  it("mask preview is exactly black/white from the canonical bytes (no anti-aliasing)", () => {
    const px = maskPreviewRgba(new Uint8Array([0, 255, 0, 255]));
    expect(Array.from(px)).toEqual([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  });
});
