import { describe, expect, it } from "vitest";
import { assetTokenFor, buildPrevisDocument, sceneFingerprint, spatialSnapshot } from "../document";
import { buildHotelCanopyEngineScene } from "../hotel-canopy";
import {
  buildSpatialEnvironment,
  calibrationSchema,
  canonicalSources,
  hasVisibleSplat,
  isSplatMime,
  manualCalibration,
  parseCalibration,
  reconstructionFingerprint,
  RECONSTRUCTION_SCHEMA,
  SPLAT_FORMAT_INFO,
  SPLAT_USER_DATA,
  UNKNOWN_CALIBRATION,
  type ReconstructionIdentity,
  type SpatialReconstructionRecord,
} from "../splat";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const SPLAT_UUID = "00000000-0000-4000-8000-0000000051a7";

function sceneWithSplat(
  over: Partial<{
    visible: boolean;
    position: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
    locked: boolean;
    calibration: unknown;
  }> = {},
) {
  const scene = buildHotelCanopyEngineScene({ characterId: "char-yumeko" });
  scene.scene.push({
    ...clone(scene.scene[1]),
    object_uuid: SPLAT_UUID,
    object_name: "Hotel Canopy reconstruction",
    media_file_token: assetTokenFor("asset-splat-1"),
    position: over.position ?? { x: 0, y: 0, z: 0 },
    scale: over.scale ?? { x: 1, y: 1, z: 1 },
    visible: over.visible ?? true,
    locked: over.locked ?? false,
    user_data: {
      [SPLAT_USER_DATA.reconstructionId]: "recon-1",
      [SPLAT_USER_DATA.calibration]: over.calibration ?? { ...UNKNOWN_CALIBRATION },
    },
  });
  return scene;
}
const docOf = (scene = sceneWithSplat(), checksum = "sha-splat-a") =>
  buildPrevisDocument({ engineScene: scene, assetChecksums: { "asset-splat-1": checksum } });

describe("splat file formats", () => {
  it("states a truthful machine MIME for every enabled format", () => {
    expect(SPLAT_FORMAT_INFO.splat.mime).toBe("application/x-gaussian-splat");
    expect(SPLAT_FORMAT_INFO.spz.mime).toBe("application/x-spz");
    expect(SPLAT_FORMAT_INFO.ply.mime).toBe("application/x-ply");
    expect(isSplatMime("application/x-spz")).toBe(true);
    expect(isSplatMime("model/gltf-binary")).toBe(false);
    expect(isSplatMime(null)).toBe(false);
  });
});

describe("calibration: metric scale is never assumed", () => {
  it("defaults to unknown units with no metres-per-unit", () => {
    expect(UNKNOWN_CALIBRATION).toMatchObject({
      units: "unknown",
      metresPerSourceUnit: null,
      scaleMethod: "unknown",
    });
    expect(parseCalibration(undefined)).toMatchObject({ units: "unknown", scaleMethod: "unknown" });
    expect(parseCalibration({ units: "metres", metresPerSourceUnit: 1 })).toMatchObject({ units: "unknown" });
  });
  it("only a manual entry makes the scale metric, and the pairing is enforced", () => {
    expect(manualCalibration(0.5)).toMatchObject({
      units: "metres",
      metresPerSourceUnit: 0.5,
      scaleMethod: "manual",
    });
    expect(() => manualCalibration(0)).toThrow();
    expect(() => manualCalibration(-1)).toThrow();
    expect(() => manualCalibration(Number.NaN)).toThrow();
    expect(
      calibrationSchema.safeParse({ units: "metres", metresPerSourceUnit: null, scaleMethod: "unknown" })
        .success,
    ).toBe(false);
    expect(
      calibrationSchema.safeParse({ units: "unknown", metresPerSourceUnit: 2, scaleMethod: "manual" })
        .success,
    ).toBe(false);
  });
});

describe("reconstruction fingerprint", () => {
  const base: ReconstructionIdentity = {
    locationId: "loc-1",
    method: "imported",
    resultKind: "gaussian_splat",
    result: { assetId: "asset-splat-1", checksum: "sha-a" },
    sources: [
      { assetId: "ref-2", checksum: "sha-r2" },
      { assetId: "ref-1", checksum: "sha-r1" },
    ],
    calibration: { ...UNKNOWN_CALIBRATION },
  };
  const fp = (o: Partial<ReconstructionIdentity> = {}) => reconstructionFingerprint({ ...base, ...o });

  it("is stable and independent of source order and duplicates", () => {
    expect(fp()).toMatch(/^[0-9a-f]{64}$/);
    expect(fp({ sources: [...base.sources].reverse() })).toBe(fp());
    expect(fp({ sources: [...base.sources, base.sources[0]!] })).toBe(fp());
    expect(canonicalSources(base.sources).map((s) => s.assetId)).toEqual(["ref-1", "ref-2"]);
  });
  it("changes with the schema inputs", () => {
    const h = fp();
    expect(fp({ locationId: "loc-2" })).not.toBe(h);
    expect(fp({ result: { assetId: "asset-splat-1", checksum: "sha-b" } })).not.toBe(h);
    expect(fp({ result: { assetId: "asset-splat-2", checksum: "sha-a" } })).not.toBe(h);
    expect(fp({ sources: [base.sources[0]!] })).not.toBe(h);
    expect(fp({ sources: [{ assetId: "ref-2", checksum: "CHANGED" }, base.sources[1]!] })).not.toBe(h);
    expect(fp({ sources: [] })).not.toBe(h);
    expect(fp({ calibration: manualCalibration(2) })).not.toBe(h);
  });
  it("carries the schema version in its name", () => {
    expect(RECONSTRUCTION_SCHEMA).toBe("prism.spatial-reconstruction.v1");
  });
});

describe("splat objects in the Set document", () => {
  it("normalises a splat as its own kind bound to an asset, a checksum and a reconstruction", () => {
    const doc = docOf();
    const splat = doc.objects.find((o) => o.kind === "splat")!;
    expect(splat).toMatchObject({
      id: SPLAT_UUID,
      assetId: "asset-splat-1",
      assetChecksum: "sha-splat-a",
      reconstructionId: "recon-1",
      calibration: { units: "unknown", scaleMethod: "unknown" },
    });
    expect(doc.objects.filter((o) => o.kind === "glb")).toHaveLength(0);
    expect(hasVisibleSplat(doc.objects)).toBe(true);
    expect(doc.assetBindings["asset-splat-1"]).toEqual({ checksum: "sha-splat-a" });
  });

  it("a Set WITHOUT a splat keeps its historical fingerprint shape (no new keys)", () => {
    const doc = buildPrevisDocument({ engineScene: buildHotelCanopyEngineScene({ characterId: "c" }) });
    for (const o of spatialSnapshot(doc).objects) {
      expect(Object.keys(o).sort()).toEqual(
        [
          "assetChecksum",
          "assetId",
          "characterId",
          "color",
          "id",
          "kind",
          "name",
          "position",
          "rotation",
          "scale",
          "shape",
          "visible",
        ].sort(),
      );
    }
    expect(hasVisibleSplat(doc.objects)).toBe(false);
  });

  it("the Set fingerprint changes when the splat asset, transform, visibility or presence changes", () => {
    const base = sceneFingerprint(docOf());
    expect(sceneFingerprint(docOf(sceneWithSplat(), "sha-splat-B"))).not.toBe(base); // asset content
    expect(sceneFingerprint(docOf(sceneWithSplat({ position: { x: 1, y: 0, z: 0 } })))).not.toBe(base);
    expect(sceneFingerprint(docOf(sceneWithSplat({ scale: { x: 2, y: 2, z: 2 } })))).not.toBe(base);
    expect(sceneFingerprint(docOf(sceneWithSplat({ visible: false })))).not.toBe(base);
    expect(sceneFingerprint(docOf(sceneWithSplat({ calibration: manualCalibration(0.25) })))).not.toBe(base);
    const without = buildPrevisDocument({
      engineScene: buildHotelCanopyEngineScene({ characterId: "char-yumeko" }),
    });
    expect(sceneFingerprint(without)).not.toBe(base); // added / removed
  });

  it("is NOT changed by lock state, runtime loading state or the navigation camera", () => {
    const base = sceneFingerprint(docOf());
    expect(sceneFingerprint(docOf(sceneWithSplat({ locked: true })))).toBe(base);
    const noisy = sceneWithSplat();
    (noisy as unknown as { camera_data: unknown }).camera_data = {
      position: { x: 99, y: 9, z: 9 },
      rotation: { x: 0, y: 0, z: 0 },
    };
    const last = noisy.scene[noisy.scene.length - 1] as { user_data: Record<string, unknown> };
    last.user_data.loadingPercent = 37; // runtime-only noise that is not production truth
    last.user_data.bufferState = "uploaded";
    expect(sceneFingerprint(docOf(noisy))).toBe(base);
  });

  it("never lets a temporary URL into the persisted document", () => {
    const bad = sceneWithSplat();
    (bad.scene[bad.scene.length - 1] as { user_data: Record<string, unknown> }).user_data.src =
      "blob:http://x/abc";
    expect(() => docOf(bad)).toThrow(/ephemeral/i);
  });
});

describe("spatial environment frozen into a package", () => {
  const record: SpatialReconstructionRecord = {
    id: "recon-1",
    projectId: "p",
    locationId: "loc-1",
    schemaVersion: RECONSTRUCTION_SCHEMA,
    method: "imported",
    resultKind: "gaussian_splat",
    resultAssetId: "asset-splat-1",
    resultChecksum: "sha-splat-a",
    resultFormat: "splat",
    gaussianCount: 576,
    sources: [
      { assetId: "ref-2", checksum: "sha-r2" },
      { assetId: "ref-1", checksum: "sha-r1" },
    ],
    calibration: { ...UNKNOWN_CALIBRATION },
    fingerprint: "f".repeat(64),
    createdBy: null,
    createdAt: "2026-10-18T00:00:00.000Z",
  };

  it("records identity, transform, calibration and provenance by value, with no URL or bytes", () => {
    const doc = docOf(sceneWithSplat({ position: { x: 1, y: 2, z: 3 }, scale: { x: 2, y: 2, z: 2 } }));
    const env = buildSpatialEnvironment(
      doc.objects.find((o) => o.kind === "splat")!,
      record,
    );
    expect(env).toMatchObject({
      kind: "gaussian_splat",
      sceneObjectId: SPLAT_UUID,
      reconstructionId: "recon-1",
      reconstructionFingerprint: "f".repeat(64),
      assetId: "asset-splat-1",
      assetChecksum: "sha-splat-a",
      format: "splat",
      gaussianCount: 576,
      transform: { position: { x: 1, y: 2, z: 3 }, scale: { x: 2, y: 2, z: 2 } },
      calibration: { units: "unknown", metresPerSourceUnit: null, scaleMethod: "unknown" },
      sourceReferenceAssetIds: ["ref-1", "ref-2"],
    });
    expect(env.transform.orientation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(JSON.stringify(env)).not.toMatch(/https?:|blob:|token=|signature/i);
  });
});
