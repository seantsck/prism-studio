import { describe, expect, it } from "vitest";
import {
  assetIdFromToken,
  assetTokenFor,
  buildPrevisDocument,
  characterBlocking,
  extractNavigationCamera,
  findEphemeralStrings,
  sceneFingerprint,
} from "../document";
import { bookmarkFromCamera, focalLengthToFovDegrees, lookTargetFromEuler } from "../camera";
import { buildHotelCanopyEngineScene, HOTEL_CANOPY_OBJECTS } from "../hotel-canopy";
import { PREVIS_SCHEMA, PREVIS_UPSTREAM_COMMIT, previsDocumentSchema } from "../types";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const build = (scene = buildHotelCanopyEngineScene({ characterId: "char-yumeko" })) =>
  buildPrevisDocument({ engineScene: scene });

describe("prism.previs.v1 wrapper", () => {
  it("wraps the engine scene with explicit Prism metadata and validates", () => {
    const doc = build();
    expect(doc.schema).toBe(PREVIS_SCHEMA);
    expect(doc.engine).toBe("artcraft-derived");
    expect(doc.upstreamCommit).toBe(PREVIS_UPSTREAM_COMMIT);
    expect(doc.productionFrame).toEqual({ ratio: "2.39:1", width: 1912, height: 800 });
    expect(() => previsDocumentSchema.parse(doc)).not.toThrow();
  });

  it("normalises objects, the mannequin's character and the production camera", () => {
    const doc = build();
    expect(doc.objects).toHaveLength(HOTEL_CANOPY_OBJECTS.length);
    const mannequin = doc.objects.find((o) => o.kind === "mannequin")!;
    expect(mannequin.characterId).toBe("char-yumeko");
    expect(doc.productionCamera).toMatchObject({ id: "cam-a", label: "CAM-A", focalLengthMm: 35 });
    expect(characterBlocking(doc)).toEqual([
      expect.objectContaining({ characterId: "char-yumeko", objectId: mannequin.id }),
    ]);
  });

  it("separates the editor navigation camera from the production camera", () => {
    const doc = build();
    expect(doc.editor.navigationCamera).toEqual({
      position: { x: 6, y: 4, z: 9 },
      rotation: { x: -0.25, y: 0.55, z: 0 },
    });
    expect(doc.productionCamera?.position).toEqual({ x: 1.2, y: 1.6, z: 5.5 });
    expect(extractNavigationCamera({ camera_data: { position: { x: 1, y: 2, z: 3 } } })).toBeNull();
  });
});

describe("assets: ids, never URLs", () => {
  it("round-trips a Prism asset id through the engine token", () => {
    expect(assetTokenFor("a-1")).toBe("m_a-1");
    expect(assetIdFromToken("m_a-1")).toBe("a-1");
    expect(assetIdFromToken("Parim")).toBeNull();
    expect(assetIdFromToken("m_")).toBeNull();
  });

  it("binds a GLB to its asset id and checksum", () => {
    const scene = buildHotelCanopyEngineScene();
    scene.scene.push({
      ...clone(scene.scene[1]),
      object_uuid: "00000000-0000-4000-8000-00000000a001",
      object_name: "Prop",
      media_file_token: assetTokenFor("asset-glb-1"),
      user_data: { media_file_type: "glb" },
    });
    const doc = buildPrevisDocument({ engineScene: scene, assetChecksums: { "asset-glb-1": "sha-abc" } });
    const glb = doc.objects.find((o) => o.kind === "glb")!;
    expect(glb.assetId).toBe("asset-glb-1");
    expect(glb.assetChecksum).toBe("sha-abc");
    expect(doc.assetBindings).toEqual({ "asset-glb-1": { checksum: "sha-abc" } });
  });

  it("refuses to persist a scene carrying signed URLs or blob URLs", () => {
    for (const bad of [
      "https://cdn.example.com/a.glb?X-Amz-Signature=abc",
      "blob:http://localhost/abc",
      "data:image/png;base64,AAAA",
      "https://storage/x?token=eyJ",
    ]) {
      const scene = buildHotelCanopyEngineScene();
      scene.scene[0].user_data = { ...scene.scene[0].user_data, leak: bad };
      expect(() => buildPrevisDocument({ engineScene: scene })).toThrow(/ephemeral/);
    }
    expect(findEphemeralStrings({ a: "m_asset-1", b: ["Parim", "Box"] })).toEqual([]);
  });

  it("the built-in acceptance set is clean", () => {
    expect(findEphemeralStrings(buildHotelCanopyEngineScene())).toEqual([]);
  });
});

describe("scene fingerprint", () => {
  const base = () => build();

  it("is deterministic and independent of object order", () => {
    const a = base();
    const b = build(
      (() => {
        const s = buildHotelCanopyEngineScene({ characterId: "char-yumeko" });
        s.scene.reverse();
        return s;
      })(),
    );
    expect(sceneFingerprint(a)).toBe(sceneFingerprint(b));
    expect(sceneFingerprint(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when production-relevant spatial truth changes", () => {
    const f0 = sceneFingerprint(base());
    const edit = (fn: (s: ReturnType<typeof buildHotelCanopyEngineScene>) => void) => {
      const s = buildHotelCanopyEngineScene({ characterId: "char-yumeko" });
      fn(s);
      return sceneFingerprint(build(s));
    };
    expect(edit((s) => (s.scene[4].position = { x: 9, y: 0.75, z: -1 }))).not.toBe(f0); // object transform
    expect(edit((s) => s.scene.pop())).not.toBe(f0); // object removed
    expect(edit((s) => s.scene.push({ ...clone(s.scene[1]), object_uuid: "x-new" }))).not.toBe(f0); // object added
    expect(edit((s) => (s.cameras[1].position = { x: 2, y: 1.6, z: 5.5 }))).not.toBe(f0); // production camera
    expect(edit((s) => (s.cameras[1].focalLength = 50))).not.toBe(f0); // lens
    expect(
      edit((s) => {
        s.scene[6].user_data = { ...s.scene[6].user_data, prismCharacterId: "char-other" };
      }),
    ).not.toBe(f0); // blocking association
  });

  it("does not change for selection, hover, panel or the editor navigation camera", () => {
    const f0 = sceneFingerprint(base());
    const s = buildHotelCanopyEngineScene({ characterId: "char-yumeko" });
    s.camera_data = { position: { x: -20, y: 9, z: 4 }, rotation: { x: 0.3, y: -1, z: 0 } };
    s.cameras[0].position = { x: -20, y: 9, z: 4 }; // the editor ("main") camera
    s.selectedCameraId = "main";
    const noisy = clone(s) as typeof s & Record<string, unknown>;
    noisy.selectedObject = "x";
    noisy.hoveredObject = "y";
    noisy.inspectorTab = "transform";
    noisy.panelWidth = 420;
    expect(sceneFingerprint(build(noisy))).toBe(f0);
  });

  it("ignores sub-precision float noise", () => {
    const f0 = sceneFingerprint(base());
    const s = buildHotelCanopyEngineScene({ characterId: "char-yumeko" });
    s.scene[4].position = { x: 4.2 + 1e-9, y: 0.75 - 1e-9, z: -1 };
    expect(sceneFingerprint(build(s))).toBe(f0);
  });
});

describe("camera bookmark maths", () => {
  it("derives vertical FOV from focal length on the stated 24 mm sensor model", () => {
    expect(focalLengthToFovDegrees(24)).toBeCloseTo(53.13, 1);
    expect(focalLengthToFovDegrees(35)).toBeCloseTo(37.85, 1);
  });

  it("the target is one unit ahead of the camera", () => {
    const t0 = lookTargetFromEuler({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    expect(t0).toEqual({ x: 0, y: 0, z: -1 });
    const t1 = lookTargetFromEuler({ x: 1, y: 2, z: 3 }, { x: 0, y: Math.PI / 2, z: 0 });
    expect(t1.x).toBeCloseTo(0);
    expect(t1.z).toBeCloseTo(3);
  });

  it("states its lens basis and the production aspect", () => {
    const b = bookmarkFromCamera(build().productionCamera!);
    expect(b.focalLengthBasis).toBe("vertical-sensor-24mm");
    expect(b.productionAspectRatio).toBe("2.39:1");
    expect(b.productionAspectValue).toBeCloseTo(2.39, 2);
  });
});
