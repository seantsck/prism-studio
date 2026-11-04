import { describe, expect, it } from "vitest";
import { pickCurrentClip, previsStaleReasons, STALE_REASON_LABEL } from "../audio-mix";
import {
  MAX_LIGHT_COORDINATE,
  MAX_LIGHT_INTENSITY,
  MAX_LIGHT_RANGE,
  MAX_SHOT_LIGHTS,
  MAX_SPOT_CONE_DEG,
  MIN_SPOT_CONE_DEG,
  SHOT_LIGHTING_SCHEMA,
  authoredLightingIntent,
  baseEnvironmentOf,
  buildRenderLighting,
  emptyShotLightingDraft,
  isRenderLightingStale,
  lightingFingerprint,
  lightingReview,
  masterFrameStaleReasons,
  newShotLight,
  parseShotLightingDraft,
  parseShotLightingRig,
  selectedProductionFrameLighting,
  shotLightingRigSchema,
  type AuthoredLightingIntent,
  type ShotLight,
} from "../lighting";

const intent: AuthoredLightingIntent = {
  lighting: {
    keyDirection: "camera left",
    fill: "low",
    practicals: "",
    colorTemperature: "warm",
    mood: "tense",
    referenceAssetId: null,
    continuity: "",
  },
  timeOfDay: "night",
  weather: "rain",
};

const point = (over: Record<string, unknown> = {}) => ({ ...newShotLight("point", "a"), ...over });
const spot = (over: Record<string, unknown> = {}) => ({ ...newShotLight("spot", "s"), ...over });
const draft = (lights: unknown[], mode = "engine_default") => ({
  schema: SHOT_LIGHTING_SCHEMA,
  base: { mode },
  lights,
});
const rig = (lights: ShotLight[], mode: "engine_default" | "replace" = "replace") =>
  parseShotLightingRig({ ...draft(lights, mode), authoredIntent: intent });

describe("prism.shot-lighting.v1 schema", () => {
  it("pins its bounds", () => {
    expect(MAX_SHOT_LIGHTS).toBe(16);
    expect(MAX_LIGHT_INTENSITY).toBe(1000);
    expect(MAX_LIGHT_RANGE).toBe(1000);
    expect([MIN_SPOT_CONE_DEG, MAX_SPOT_CONE_DEG]).toEqual([1, 90]);
    expect(MAX_LIGHT_COORDINATE).toBe(10_000);
  });

  it("accepts each light type's defaults", () => {
    for (const t of ["ambient", "point", "directional", "spot"] as const)
      expect(() => parseShotLightingDraft(draft([newShotLight(t, "x")]))).not.toThrow();
  });

  it.each([
    ["castShadow true", point({ castShadow: true })],
    ["an unknown light type (RectAreaLight)", point({ type: "rect_area" })],
    ["stored Kelvin", point({ colorTemperatureK: 3200 })],
    ["lumens", point({ lumens: 800 })],
    ["area softness", point({ softness: 0.5 })],
    ["a penumbra on a point light", point({ penumbra: 0.2 })],
    ["a position on an ambient light", { ...newShotLight("ambient", "a"), position: { x: 0, y: 0, z: 0 } }],
    ["a point light with no position", { ...point(), position: undefined }],
    ["negative intensity", point({ intensity: -1 })],
    ["intensity above the bound", point({ intensity: MAX_LIGHT_INTENSITY + 1 })],
    ["non-finite intensity", point({ intensity: Infinity })],
    ["NaN position", point({ position: { x: NaN, y: 0, z: 0 } })],
    ["a coordinate above the bound", point({ position: { x: MAX_LIGHT_COORDINATE + 1, y: 0, z: 0 } })],
    ["a three-digit colour", point({ color: "#fff" })],
    ["a named colour", point({ color: "red" })],
    ["a range above the bound", point({ range: MAX_LIGHT_RANGE + 1 })],
    ["a cone below the bound", spot({ coneAngleDeg: 0 })],
    ["a cone above the bound", spot({ coneAngleDeg: 91 })],
    ["a penumbra above 1", spot({ penumbra: 1.1 })],
    [
      "a spot aimed at itself",
      spot({ target: newShotLight("spot", "s").type === "spot" ? { x: 2, y: 3, z: 2 } : {} }),
    ],
    ["an unknown role", point({ role: "hero" })],
    ["a bad id", point({ id: "has spaces" })],
  ])("refuses %s", (_name, light) => {
    expect(() => parseShotLightingDraft(draft([light]))).toThrow();
  });

  it("refuses duplicate ids, more than 16 lights and an unknown base mode", () => {
    expect(() => parseShotLightingDraft(draft([point(), point()]))).toThrow();
    expect(() =>
      parseShotLightingDraft(draft(Array.from({ length: 17 }, (_, i) => point({ id: `l${i}` })))),
    ).toThrow();
    expect(() =>
      parseShotLightingDraft(draft(Array.from({ length: 16 }, (_, i) => point({ id: `l${i}` })))),
    ).not.toThrow();
    expect(() => parseShotLightingDraft(draft([], "hdri"))).toThrow();
  });

  it("refuses an authored intent from the browser: the server reads it from the Shot", () => {
    expect(() => parseShotLightingDraft({ ...draft([]), authoredIntent: intent })).toThrow();
    expect(shotLightingRigSchema.safeParse({ ...draft([]) }).success).toBe(false);
  });

  it("lowercases colours and drops a meaningless castShadow:false", () => {
    const d = parseShotLightingDraft(draft([point({ color: "#FFAA00", castShadow: false })]));
    expect(d.lights[0].color).toBe("#ffaa00");
    expect("castShadow" in d.lights[0]).toBe(false);
  });

  it("freezes authored intent from the Shot's structured lighting and continuity", () => {
    const got = authoredLightingIntent({
      lighting: { ...intent.lighting, continuity: undefined } as never,
      continuity: { lighting: "note", timeOfDay: "dusk", weather: "fog" },
    });
    expect(got.lighting.continuity).toBe("note");
    expect(got.lighting.keyDirection).toBe("camera left");
    expect(got.timeOfDay).toBe("dusk");
    expect(got.weather).toBe("fog");
  });
});

describe("lightingFingerprint", () => {
  const base = rig([newShotLight("spot", "s"), newShotLight("point", "p")]);
  const fp = lightingFingerprint(base);
  const withLight = (over: Record<string, unknown>) =>
    lightingFingerprint(
      parseShotLightingRig({
        ...base,
        lights: base.lights.map((l) => (l.id === "s" ? { ...l, ...over } : l)),
      }),
    );

  it("is order-independent and ignores label, role and authored intent", () => {
    expect(lightingFingerprint({ ...base, lights: [...base.lights].reverse() })).toBe(fp);
    expect(withLight({ label: "Hero key" })).toBe(fp);
    expect(withLight({ role: "rim" })).toBe(fp);
    expect(
      lightingFingerprint(parseShotLightingRig({ ...base, authoredIntent: { ...intent, weather: "clear" } })),
    ).toBe(fp);
  });

  it.each([
    ["enabled", { enabled: false }],
    ["color", { color: "#ff0000" }],
    ["intensity", { intensity: 41 }],
    ["position", { position: { x: 9, y: 3, z: 2 } }],
    ["target", { target: { x: 9, y: 1, z: 0 } }],
    ["range", { range: 7 }],
    ["cone", { coneAngleDeg: 12 }],
    ["penumbra", { penumbra: 0.9 }],
  ])("changes with %s", (_n, over) => {
    expect(withLight(over)).not.toBe(fp);
  });

  it("changes with the base mode and keeps a disabled light in its identity", () => {
    expect(lightingFingerprint({ ...base, base: { mode: "engine_default" } })).not.toBe(fp);
    expect(lightingFingerprint(rig([{ ...newShotLight("point", "p"), enabled: false }]))).not.toBe(
      lightingFingerprint(rig([])),
    );
  });

  it("ignores sub-precision noise and -0", () => {
    const a = rig([{ ...newShotLight("point", "p"), intensity: 1 }]);
    const b = rig([{ ...newShotLight("point", "p"), intensity: 1.0000001 }]);
    expect(lightingFingerprint(a)).toBe(lightingFingerprint(b));
    const z = (x: number) =>
      lightingFingerprint(rig([{ ...newShotLight("point", "p"), position: { x, y: 1, z: 1 } } as ShotLight]));
    expect(z(-0)).toBe(z(0));
  });
});

describe("render lighting snapshot", () => {
  const r = rig([newShotLight("point", "p")]);
  const rec = { id: "rig-1", revision: 3, lightingFingerprint: lightingFingerprint(r), rig: r };
  const scene = { scene: { skybox: "m_1" }, upstreamCommit: "abc" };

  it("records the rig by value and the saved skybox, and no URL", () => {
    const snap = buildRenderLighting({ rig: rec, scene });
    expect(snap.schema).toBe("prism.render-lighting.v1");
    expect(snap.rigRevision).toBe(3);
    expect(snap.rigFingerprint).toBe(rec.lightingFingerprint);
    expect(snap.baseEnvironment).toEqual({ upstreamCommit: "abc", skybox: "m_1" });
    expect(JSON.stringify(snap)).not.toMatch(/https?:|blob:|token=/);
  });

  it("reads a scene with no skybox as null", () => {
    expect(baseEnvironmentOf({ scene: {}, upstreamCommit: "abc" }).skybox).toBeNull();
  });

  it("is the same whatever the saved base light says: the engine normalises it (see the 4B vendor patch)", () => {
    const base = {
      media_file_token: "DirectionalLight",
      object_uuid: "d",
      visible: true,
      position: { x: 5, y: 10, z: 3 },
    };
    const of = (s: unknown[]) =>
      baseEnvironmentOf({ scene: { skybox: "m_1", scene: s }, upstreamCommit: "abc" });
    const reference = of([base]);
    expect(of([{ ...base, visible: false }])).toEqual(reference);
    expect(of([{ ...base, position: { x: -8, y: 1, z: -6 } }])).toEqual(reference);
    expect(of([])).toEqual(reference);
    // the UI theme is not provenance: it is not an input at all
    expect(Object.keys(reference).sort()).toEqual(["skybox", "upstreamCommit"]);
  });
});

describe("staleness", () => {
  const env = { upstreamCommit: "abc", skybox: "m_1" };
  const none = { lightingFingerprint: null, lighting: null };
  const lit = { lightingFingerprint: "f".repeat(64), lighting: { baseEnvironment: env } };

  it("no rig then and no rig now is not stale: 4B does not condemn history", () => {
    expect(isRenderLightingStale(none, { lightingFingerprint: null, baseEnvironment: env })).toBe(false);
  });

  it("detects a changed, added and removed rig", () => {
    const f = "e".repeat(64);
    expect(isRenderLightingStale(lit, { lightingFingerprint: f, baseEnvironment: env })).toBe(true);
    expect(isRenderLightingStale(none, { lightingFingerprint: f, baseEnvironment: env })).toBe(true);
    expect(isRenderLightingStale(lit, { lightingFingerprint: null, baseEnvironment: env })).toBe(true);
  });

  it("detects a changed skybox under the same rig, only when both are known", () => {
    const same = lit.lightingFingerprint;
    expect(
      isRenderLightingStale(lit, {
        lightingFingerprint: same,
        baseEnvironment: { ...env, skybox: "m_2" },
      }),
    ).toBe(true);
    expect(isRenderLightingStale(lit, { lightingFingerprint: same, baseEnvironment: null })).toBe(false);
  });

  it("masterFrameStaleReasons reports scene, blocking and lighting, and no camera reason", () => {
    const frame = { sceneFingerprint: "s", blockingFingerprint: "b", ...lit };
    const current = { lightingFingerprint: lit.lightingFingerprint, baseEnvironment: env };
    expect(
      masterFrameStaleReasons({
        frame,
        currentSceneFingerprint: "s",
        currentBlockingFingerprint: "b",
        currentLighting: current,
      }),
    ).toEqual([]);
    expect(
      masterFrameStaleReasons({
        frame,
        currentSceneFingerprint: "x",
        currentBlockingFingerprint: "y",
        currentLighting: { lightingFingerprint: null, baseEnvironment: env },
      }),
    ).toEqual(["scene", "blocking", "lighting"]);
  });

  it("previsStaleReasons adds lighting and keeps the other reasons", () => {
    const clip = {
      sceneFingerprint: "s",
      pathFingerprint: "p",
      audioMixFingerprint: null,
      blockingFingerprint: null,
      lightingFingerprint: lit.lightingFingerprint,
      lighting: lit.lighting,
    };
    const ok = {
      clip,
      currentSceneFingerprint: "s",
      currentPathFingerprint: "p",
      currentAudioMixFingerprint: null,
      currentBlockingFingerprint: null,
      currentLighting: { lightingFingerprint: lit.lightingFingerprint, baseEnvironment: env },
    };
    expect(previsStaleReasons(ok)).toEqual([]);
    expect(
      previsStaleReasons({
        ...ok,
        currentLighting: { lightingFingerprint: "e".repeat(64), baseEnvironment: env },
      }),
    ).toEqual(["lighting"]);
    expect(STALE_REASON_LABEL.lighting).toBe("STALE LIGHTING");
    // a clip from before rigs, with no rig now and no lighting argument, stays exactly as it was
    expect(
      previsStaleReasons({
        clip: { sceneFingerprint: "s", pathFingerprint: "p", audioMixFingerprint: null },
        currentSceneFingerprint: "s",
        currentPathFingerprint: "p",
        currentAudioMixFingerprint: null,
      }),
    ).toEqual([]);
  });

  it("pickCurrentClip only calls a clip current when its lighting matches", () => {
    const clip = (lightingFingerprint: string | null, renderedAt: string) => ({
      pathFingerprint: "p",
      audioMixFingerprint: null,
      lightingFingerprint,
      renderedAt,
    });
    const a = clip(null, "2026-01-01");
    const b = clip("f", "2026-01-02");
    expect(pickCurrentClip([a, b], "p", null, null, "f")).toBe(b);
    expect(pickCurrentClip([a, b], "p", null, null, null)).toBe(a);
    expect(pickCurrentClip([a, b], "p", null, null, "other")).toBeNull();
  });
});

describe("review conditions", () => {
  const r = rig([]);
  it("reports nothing when nothing moved, whatever the key order", () => {
    const shuffled = { weather: "rain", timeOfDay: "night", lighting: { ...intent.lighting } };
    expect(
      lightingReview({
        rig: r,
        rigSceneFingerprint: "s",
        currentIntent: shuffled,
        currentSceneFingerprint: "s",
      }),
    ).toEqual([]);
  });
  it("reports authored intent and set changes, and an unknown set as no claim", () => {
    expect(
      lightingReview({
        rig: r,
        rigSceneFingerprint: "s",
        currentIntent: { ...intent, weather: "clear" },
        currentSceneFingerprint: "t",
      }),
    ).toEqual(["authored_intent_changed", "set_changed"]);
    expect(
      lightingReview({
        rig: r,
        rigSceneFingerprint: "s",
        currentIntent: intent,
        currentSceneFingerprint: null,
      }),
    ).toEqual([]);
  });
});

describe("selectedProductionFrameLighting", () => {
  const lookup = (id: string) => ({ exact: "exact-fp", newest: "newest-fp", historical: null })[id];

  it("follows the selected frame's own source id", () => {
    expect(
      selectedProductionFrameLighting({
        selected: { source: "previs_master", sourceMasterFrameId: "exact" },
        masterFrameLighting: lookup,
      }),
    ).toBe("exact-fp");
  });
  it("is null for a non-previs source, no selection, an unlit Master Frame and a missing one", () => {
    const of = (selected: { source: string; sourceMasterFrameId: string | null } | null) =>
      selectedProductionFrameLighting({ selected, masterFrameLighting: lookup });
    expect(of({ source: "storyboard", sourceMasterFrameId: null })).toBeNull();
    expect(of(null)).toBeNull();
    expect(of({ source: "previs_master", sourceMasterFrameId: "historical" })).toBeNull();
    expect(of({ source: "previs_master", sourceMasterFrameId: "gone" })).toBeNull();
  });
});

describe("defaults", () => {
  it("an empty draft is valid", () => {
    expect(() => parseShotLightingDraft(emptyShotLightingDraft())).not.toThrow();
  });
});
