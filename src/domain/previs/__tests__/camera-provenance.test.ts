import { describe, expect, it } from "vitest";
import { fingerprint } from "@/domain/hash";
import { bookmarkFromCamera, productionRenderSpec } from "../camera";
import {
  buildRenderCamera,
  parseRenderCamera,
  RENDER_CAMERA_SCHEMA,
  renderCameraFingerprint,
} from "../camera-provenance";
import {
  bookmarkCameraFingerprint,
  controlCameraFromBookmark,
  controlCameraFromState,
} from "../spatial-passes";
import { baseEnvironmentFingerprint } from "../lighting";
import {
  masterFramePromotionState,
  masterFrameSpatialStatus,
  type CurrentSpatialState,
  type MasterFrameSpatialSource,
} from "../spatial-status";
import type { CameraBookmarkValue } from "../types";

const cam = (over: Partial<{ x: number; rx: number; ry: number; f: number }> = {}): CameraBookmarkValue =>
  bookmarkFromCamera({
    id: "c",
    label: "Camera",
    position: { x: over.x ?? 1.5, y: 1.6, z: -3 },
    rotation: { x: over.rx ?? -0.1, y: over.ry ?? 0.4, z: 0 },
    focalLengthMm: over.f ?? 35,
  });

describe("canonical render camera (prism.render-camera.v1)", () => {
  it("uses the ONE existing camera identity", () => {
    const b = cam();
    expect(renderCameraFingerprint(b)).toBe(bookmarkCameraFingerprint(b));
    expect(bookmarkCameraFingerprint(b)).toBe(fingerprint(controlCameraFromBookmark(b)));
  });

  it("same camera → same fingerprint; -0 does not change it", () => {
    expect(bookmarkCameraFingerprint(cam())).toBe(bookmarkCameraFingerprint(cam()));
    const zero = cam({ x: 0 });
    const negZero = cam({ x: -0 });
    expect(bookmarkCameraFingerprint(negZero)).toBe(bookmarkCameraFingerprint(zero));
  });

  it("an equivalent rotation (quaternion sign) does not change it", () => {
    const a = cam({ rx: 0 });
    const b = cam({ rx: 2 * Math.PI }); // the same orientation; Euler→quaternion gives the opposite sign
    expect(bookmarkCameraFingerprint(b)).toBe(bookmarkCameraFingerprint(a));
    const c = controlCameraFromBookmark(cam());
    const q = c.quaternion;
    const flipped = controlCameraFromState({
      position: c.position,
      quaternion: { x: -q.x, y: -q.y, z: -q.z, w: -q.w },
      focalLengthMm: c.focalLengthMm,
    } as Parameters<typeof controlCameraFromState>[0]);
    expect(fingerprint(flipped)).toBe(fingerprint(c));
  });

  it("position, rotation and focal length each change it", () => {
    const base = bookmarkCameraFingerprint(cam());
    expect(bookmarkCameraFingerprint(cam({ x: 1.6 }))).not.toBe(base);
    expect(bookmarkCameraFingerprint(cam({ ry: 0.5 }))).not.toBe(base);
    expect(bookmarkCameraFingerprint(cam({ f: 50 }))).not.toBe(base);
  });

  it("the frame geometry is inside the identity (width, height, aspect, near, far)", () => {
    const c = controlCameraFromBookmark(cam());
    const base = fingerprint(c);
    for (const over of [{ width: 1920 }, { height: 1080 }, { aspect: 1.78 }, { near: 0.1 }, { far: 1000 }])
      expect(fingerprint({ ...c, ...over })).not.toBe(base);
  });

  it("the identity holds exactly what the production render uses", () => {
    const b = cam();
    const c = controlCameraFromBookmark(b);
    const spec = productionRenderSpec(b);
    expect([c.width, c.height, c.near, c.far]).toEqual([spec.width, spec.height, spec.near, spec.far]);
    expect(c.fovVerticalDegrees).toBeCloseTo(spec.fovVerticalDegrees, 5);
    expect(c.aspect).toBeCloseTo(spec.aspect, 5);
  });

  it("builds the snapshot from a bookmark only: no navigation camera, viewport, URL or engine object", () => {
    const b = cam();
    const snap = buildRenderCamera({ id: "bm-1", cameraLabel: "Hero", value: b });
    expect(snap.schema).toBe(RENDER_CAMERA_SCHEMA);
    expect(snap.cameraFingerprint).toBe(bookmarkCameraFingerprint(b));
    expect(Object.keys(snap).sort()).toEqual(
      [
        "bookmarkId",
        "bookmarkLabel",
        "camera",
        "cameraFingerprint",
        "focalLengthBasis",
        "productionAspectRatio",
        "projection",
        "schema",
      ].sort(),
    );
    expect(Object.keys(snap.camera).sort()).toEqual(
      [
        "aspect",
        "far",
        "focalLengthMm",
        "fovVerticalDegrees",
        "height",
        "near",
        "position",
        "quaternion",
        "sensorHeightMm",
        "width",
      ].sort(),
    );
    expect(JSON.stringify(snap)).not.toMatch(/https?:|blob:|navigation|viewport/);
    expect(parseRenderCamera(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
    expect(parseRenderCamera({ ...snap, schema: "other" })).toBeNull();
  });
});

const ENV = { upstreamCommit: "engine-1", skybox: "m_1" };
const frame = (over: Partial<MasterFrameSpatialSource> = {}): MasterFrameSpatialSource & { id: string } => ({
  id: "mf-1",
  sceneFingerprint: "a".repeat(64),
  cameraFingerprint: "c".repeat(64),
  blockingFingerprint: null,
  lightingFingerprint: null,
  lighting: null,
  baseEnvironmentFingerprint: baseEnvironmentFingerprint(ENV),
  ...over,
});
const now = (over: Partial<CurrentSpatialState> = {}): CurrentSpatialState => ({
  sceneFingerprint: "a".repeat(64),
  cameraFingerprint: "c".repeat(64),
  blockingFingerprint: null,
  lighting: { lightingFingerprint: null, baseEnvironment: ENV },
  ...over,
});

describe("masterFrameSpatialStatus", () => {
  it("fresh when everything matches; no rig / no blocking then and now stays fresh", () => {
    expect(masterFrameSpatialStatus(frame(), now())).toEqual({ stale: [], unknown: [] });
  });
  it("camera: different or absent current bookmark is stale; unrecorded camera is UNKNOWN, never fresh", () => {
    expect(masterFrameSpatialStatus(frame(), now({ cameraFingerprint: "d".repeat(64) })).stale).toEqual([
      "camera",
    ]);
    expect(masterFrameSpatialStatus(frame(), now({ cameraFingerprint: null })).stale).toEqual(["camera"]);
    const u = masterFrameSpatialStatus(frame({ cameraFingerprint: null }), now());
    expect(u).toEqual({ stale: [], unknown: ["camera"] });
    expect(
      masterFrameSpatialStatus(frame({ cameraFingerprint: null }), now({ cameraFingerprint: null })),
    ).toEqual({
      stale: [],
      unknown: ["camera"],
    });
  });
  it("scene, blocking and lighting keep their 4B semantics, in canonical axis order", () => {
    const s = masterFrameSpatialStatus(
      frame(),
      now({
        sceneFingerprint: null,
        blockingFingerprint: "b".repeat(64),
        lighting: { lightingFingerprint: "e".repeat(64), baseEnvironment: null },
        cameraFingerprint: "d".repeat(64),
      }),
    );
    expect(s.stale).toEqual(["scene", "camera", "blocking", "lighting"]);
  });
});

describe("promotion digest", () => {
  it("is deterministic and needs no confirmation when fresh", () => {
    const a = masterFramePromotionState({ masterFrame: frame(), current: now() });
    const b = masterFramePromotionState({ masterFrame: frame(), current: now() });
    expect(a.digest).toBe(b.digest);
    expect(a.requiresConfirmation).toBe(false);
  });
  it("binds the frame id, every current value (explicit null) and the axes", () => {
    const base = masterFramePromotionState({ masterFrame: frame(), current: now() }).digest;
    const variants = [
      masterFramePromotionState({ masterFrame: { ...frame(), id: "mf-2" }, current: now() }),
      masterFramePromotionState({ masterFrame: frame(), current: now({ sceneFingerprint: "f".repeat(64) }) }),
      masterFramePromotionState({ masterFrame: frame(), current: now({ cameraFingerprint: null }) }),
      masterFramePromotionState({
        masterFrame: frame(),
        current: now({ blockingFingerprint: "b".repeat(64) }),
      }),
      masterFramePromotionState({
        masterFrame: frame(),
        current: now({ lighting: { lightingFingerprint: "e".repeat(64), baseEnvironment: null } }),
      }),
      masterFramePromotionState({ masterFrame: frame({ cameraFingerprint: null }), current: now() }),
    ];
    for (const v of variants) expect(v.digest).not.toBe(base);
    expect(new Set(variants.map((v) => v.digest)).size).toBe(variants.length);
  });
  it("stale or unknown requires confirmation and says why", () => {
    const s = masterFramePromotionState({ masterFrame: frame({ cameraFingerprint: null }), current: now() });
    expect(s.requiresConfirmation).toBe(true);
    expect(s.messages.join(" ")).toContain("UNKNOWN CAMERA PROVENANCE");
  });
});

describe("base environment identity and the lighting axis (4C-I1 remediation)", () => {
  it("baseEnvironmentFingerprint is canonical: deterministic, changed by skybox and engine commit only", () => {
    const fp = baseEnvironmentFingerprint(ENV);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(baseEnvironmentFingerprint({ skybox: "m_1", upstreamCommit: "engine-1" })).toBe(fp);
    expect(baseEnvironmentFingerprint({ ...ENV, skybox: "m_2" })).not.toBe(fp);
    expect(baseEnvironmentFingerprint({ ...ENV, skybox: null })).not.toBe(fp);
    expect(baseEnvironmentFingerprint({ ...ENV, upstreamCommit: "engine-2" })).not.toBe(fp);
    expect(() => baseEnvironmentFingerprint({ ...ENV, extra: 1 } as never)).toThrow();
  });

  it("no rig + same base environment is fresh; a skybox-only change is STALE LIGHTING (scene untouched)", () => {
    expect(masterFrameSpatialStatus(frame(), now())).toEqual({ stale: [], unknown: [] });
    const s = masterFrameSpatialStatus(
      frame(),
      now({ lighting: { lightingFingerprint: null, baseEnvironment: { ...ENV, skybox: "m_2" } } }),
    );
    expect(s).toEqual({ stale: ["lighting"], unknown: [] });
  });

  it("a frame with no frozen base environment and no render-lighting snapshot is UNKNOWN lighting, never fresh", () => {
    const s = masterFrameSpatialStatus(frame({ baseEnvironmentFingerprint: null }), now());
    expect(s).toEqual({ stale: [], unknown: ["lighting"] });
    // a rig change is still definitely stale
    const r = masterFrameSpatialStatus(
      frame({ baseEnvironmentFingerprint: null }),
      now({ lighting: { lightingFingerprint: "e".repeat(64), baseEnvironment: ENV } }),
    );
    expect(r).toEqual({ stale: ["lighting"], unknown: [] });
  });

  it("a historical frame's frozen render-lighting snapshot is used for status when it exists", () => {
    const hist = frame({
      baseEnvironmentFingerprint: null,
      lightingFingerprint: "e".repeat(64),
      lighting: { baseEnvironment: ENV },
    });
    const rig = (env: typeof ENV) =>
      now({ lighting: { lightingFingerprint: "e".repeat(64), baseEnvironment: env } });
    expect(masterFrameSpatialStatus(hist, rig(ENV))).toEqual({ stale: [], unknown: [] });
    expect(masterFrameSpatialStatus(hist, rig({ ...ENV, skybox: "m_5" }))).toEqual({
      stale: ["lighting"],
      unknown: [],
    });
  });

  it("the promotion digest binds the current base environment", () => {
    const a = masterFramePromotionState({ masterFrame: frame(), current: now() });
    const b = masterFramePromotionState({
      masterFrame: frame(),
      current: now({ lighting: { lightingFingerprint: null, baseEnvironment: { ...ENV, skybox: "m_2" } } }),
    });
    expect(a.current.baseEnvironmentFingerprint).toBe(baseEnvironmentFingerprint(ENV));
    expect(b.digest).not.toBe(a.digest);
    expect(b.requiresConfirmation).toBe(true);
  });
});
