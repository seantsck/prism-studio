import { describe, expect, it } from "vitest";
import {
  CONTROL_PASS_REFUSAL,
  controlPassRefusal,
  environmentReport,
  environmentSaveIssues,
  splatCalibrationStale,
  splatScaleDegenerate,
  splatTransformNotFinite,
} from "../environment-capability";
import { assetTokenFor, buildPrevisDocument, sceneFingerprint } from "../document";
import { buildHotelCanopyEngineScene } from "../hotel-canopy";
import {
  manualCalibration,
  providerEstimatedCalibration,
  SPLAT_PASSES_BLOCKED_MESSAGE,
  SPLAT_USER_DATA,
  UNKNOWN_CALIBRATION,
  type SplatCalibration,
} from "../splat";

const SPLAT_UUID = "00000000-0000-4000-8000-0000000051a7";
const SPLAT_ASSET = "11111111-1111-4111-8111-111111111111";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function engineScene(opts: {
  visible?: boolean;
  scale?: unknown;
  position?: unknown;
  rotation?: unknown;
  calibration?: SplatCalibration;
}) {
  const s = buildHotelCanopyEngineScene();
  const base = clone(s.scene[1]) as unknown as Record<string, unknown>;
  s.scene.push({
    ...base,
    object_uuid: SPLAT_UUID,
    object_name: "environment",
    media_file_token: assetTokenFor(SPLAT_ASSET),
    visible: opts.visible ?? true,
    ...(opts.position !== undefined ? { position: opts.position } : {}),
    ...(opts.rotation !== undefined ? { rotation: opts.rotation } : {}),
    ...(opts.scale !== undefined ? { scale: opts.scale } : {}),
    user_data: {
      [SPLAT_USER_DATA.reconstructionId]: "recon-1",
      [SPLAT_USER_DATA.calibration]: opts.calibration ?? { ...UNKNOWN_CALIBRATION },
    },
  } as never);
  return s;
}
const doc = (s: unknown) =>
  buildPrevisDocument({ engineScene: s as never, assetChecksums: { [SPLAT_ASSET]: "sum" } });
const splatOf = (s: unknown) => doc(s).objects.find((o) => o.kind === "splat")!;
const op = (r: ReturnType<typeof environmentReport>, name: string) =>
  r!.operations.find((o) => o.operation === name)!;

describe("4E environment capability — no splat, no report (3D stays optional)", () => {
  it("a Set without a splat gets no report, no save issues and no control-pass refusal", () => {
    const s = buildHotelCanopyEngineScene();
    const d = doc(s);
    expect(environmentReport(d.objects)).toBeNull();
    expect(environmentSaveIssues(s, d.objects)).toEqual([]);
    expect(controlPassRefusal(d.objects)).toBeNull();
  });

  it("a glb or primitive with a degenerate scale is not an environment limit (existing parsing unchanged)", () => {
    const s = buildHotelCanopyEngineScene();
    (s.scene[1] as unknown as Record<string, unknown>).scale = { x: 0, y: 0, z: 0 };
    expect(environmentSaveIssues(s, doc(s).objects)).toEqual([]);
  });
});

describe("4E control-pass refusal (D6, unchanged message)", () => {
  it("a visible splat refuses control passes with the M2C message; a hidden one does not", () => {
    expect(controlPassRefusal(doc(engineScene({ visible: true })).objects)).toEqual(CONTROL_PASS_REFUSAL);
    expect(CONTROL_PASS_REFUSAL.message).toBe(SPLAT_PASSES_BLOCKED_MESSAGE);
    expect(controlPassRefusal(doc(engineScene({ visible: false })).objects)).toBeNull();
  });

  it("the report marks control passes unavailable while visible, available once hidden", () => {
    const visible = environmentReport(doc(engineScene({ visible: true })).objects)!;
    expect(visible.status).toBe("view_only");
    expect(op(visible, "control_passes")).toMatchObject({
      state: "unavailable",
      note: SPLAT_PASSES_BLOCKED_MESSAGE,
    });
    expect(op(visible, "render").state).toBe("available");
    expect(op(visible, "lighting").state).toBe("limited");
    const hidden = environmentReport(doc(engineScene({ visible: false })).objects)!;
    expect(hidden.status).toBe("hidden");
    expect(op(hidden, "control_passes").state).toBe("available");
    expect(op(hidden, "render").state).toBe("limited");
  });
});

describe("4E scale truth in the report", () => {
  it("unknown scale: framing and blocking are limited and say why", () => {
    const r = environmentReport(doc(engineScene({})).objects)!;
    expect(r.scale).toBe("unknown");
    expect(op(r, "framing")).toMatchObject({ state: "limited" });
    expect(op(r, "framing").note).toContain("Not to real-world scale");
  });

  it("manual scale matching the transform: framing available, save available", () => {
    const s = engineScene({ scale: { x: 0.5, y: 0.5, z: 0.5 }, calibration: manualCalibration(0.5) });
    const r = environmentReport(doc(s).objects)!;
    expect(r.issues).toEqual([]);
    expect(op(r, "framing")).toMatchObject({ state: "available" });
    expect(op(r, "framing").note).toContain("1 source unit = 0.5 m");
    expect(op(r, "save").state).toBe("available");
  });

  it("a provider estimate is never called exact", () => {
    const s = engineScene({ scale: { x: 2, y: 2, z: 2 }, calibration: providerEstimatedCalibration(2) });
    const r = environmentReport(doc(s).objects)!;
    expect(op(r, "framing")).toMatchObject({ state: "limited" });
    expect(op(r, "framing").note).toContain("estimate");
  });
});

describe("4E environment limits", () => {
  it("non-finite transforms are refused on the raw scene (NaN, Infinity, and JSON's null for them)", () => {
    for (const bad of [
      { scale: { x: Number.NaN, y: 1, z: 1 } },
      { scale: { x: 1, y: Number.POSITIVE_INFINITY, z: 1 } },
      { position: { x: 0, y: null, z: 0 } },
      { rotation: { x: 0, y: 0 } },
      { position: "origin" },
      { scale: { x: "1", y: 1, z: 1 } },
    ]) {
      const s = engineScene(bad);
      expect(splatTransformNotFinite(s)?.code, JSON.stringify(bad)).toBe("SPLAT_TRANSFORM_NOT_FINITE");
      expect(environmentSaveIssues(s, doc(s).objects).map((i) => i.code)).toEqual([
        "SPLAT_TRANSFORM_NOT_FINITE",
      ]);
    }
    // a JSON round trip (what the browser sends) turns Infinity into null: still refused, never coerced to 0
    const wire = JSON.parse(JSON.stringify(engineScene({ scale: { x: Infinity, y: 1, z: 1 } })));
    expect(splatTransformNotFinite(wire)?.code).toBe("SPLAT_TRANSFORM_NOT_FINITE");
    // an absent scale is the engine default (1), not an error
    expect(splatTransformNotFinite(engineScene({}))).toBeNull();
  });

  it("a scale that rounds to 0 at fingerprint precision (1e-5) is degenerate; negative (mirrored) is not", () => {
    expect(splatScaleDegenerate({ x: 0, y: 1, z: 1 })).toBe(true);
    expect(splatScaleDegenerate({ x: 1, y: 0.000004, z: 1 })).toBe(true);
    expect(splatScaleDegenerate({ x: 1, y: 1, z: 0.00001 })).toBe(false);
    expect(splatScaleDegenerate({ x: -1, y: 1, z: 1 })).toBe(false);
    const s = engineScene({ scale: { x: 1, y: 0, z: 1 } });
    const r = environmentReport(doc(s).objects)!;
    expect(r.status).toBe("needs_attention");
    expect(r.issues.map((i) => i.code)).toEqual(["SPLAT_SCALE_DEGENERATE"]);
    expect(op(r, "save").state).toBe("unavailable");
  });

  it("a metric calibration the transform no longer honours is stale; unknown units never are", () => {
    const cal = manualCalibration(0.5);
    expect(splatCalibrationStale({ x: 0.5, y: 0.5, z: 0.5 }, cal)).toBe(false);
    expect(splatCalibrationStale({ x: 0.500004, y: 0.5, z: 0.5 }, cal)).toBe(false); // same at 1e-5
    expect(splatCalibrationStale({ x: 0.7, y: 0.7, z: 0.7 }, cal)).toBe(true);
    expect(splatCalibrationStale({ x: 0.5, y: 0.5, z: 0.6 }, cal)).toBe(true);
    expect(splatCalibrationStale({ x: -0.5, y: 0.5, z: 0.5 }, cal)).toBe(true);
    expect(splatCalibrationStale({ x: 3, y: 1, z: 2 }, { ...UNKNOWN_CALIBRATION })).toBe(false);
    expect(splatCalibrationStale({ x: 3, y: 3, z: 3 }, null)).toBe(false);
    const s = engineScene({ scale: { x: 0.7, y: 0.7, z: 0.7 }, calibration: cal });
    const issues = environmentSaveIssues(s, doc(s).objects);
    expect(issues.map((i) => i.code)).toEqual(["SPLAT_CALIBRATION_STALE"]);
    expect(issues[0]!.message).toContain("1 source unit = 0.5 m");
    expect(issues[0]!.message).toContain("Scale unknown");
  });

  it("the report is derived only: it never changes the Set's identity", () => {
    const s = engineScene({ scale: { x: 0.7, y: 0.7, z: 0.7 }, calibration: manualCalibration(0.5) });
    const d = doc(s);
    const before = sceneFingerprint(d);
    environmentReport(d.objects);
    environmentSaveIssues(s, d.objects);
    expect(sceneFingerprint(d)).toBe(before);
    expect(splatOf(s).calibration).toEqual(manualCalibration(0.5));
  });
});
