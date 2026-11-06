import { describe, expect, it } from "vitest";
import { blockingFingerprint, newBlockingEntry } from "../blocking";
import { SHOT_LIGHTING_SCHEMA, lightingFingerprint, newShotLight, parseShotLightingRig } from "../lighting";
import {
  availableSetup,
  parseSetupComponents,
  planIsNoop,
  planSetupCopy,
  SetupCopyRefusal,
  type SetupComponent,
  type SetupRows,
} from "../setup-copy";
import type { CameraBookmarkValue } from "../types";

const set = { locationId: "loc", sceneDocumentId: "scene" };
const anchor = { ...set, sceneRevision: 3, sceneFingerprint: "f".repeat(64) };
const camValue = (x: number): CameraBookmarkValue => ({
  position: { x, y: 1.6, z: 6 },
  rotation: { x: 0, y: 0, z: 0 },
  target: { x: 0, y: 1, z: 0 },
  projection: "perspective",
  fovVerticalDegrees: 40,
  focalLengthMm: 35,
  focalLengthBasis: "vertical-sensor-24mm",
  productionAspectRatio: "2.39:1",
  productionAspectValue: 2.39,
});
const intent = {
  lighting: {
    keyDirection: "",
    fill: "",
    practicals: "",
    colorTemperature: "",
    mood: "",
    referenceAssetId: null,
    continuity: "",
  },
  timeOfDay: "",
  weather: "",
};
const rig = (intensity: number) =>
  parseShotLightingRig({
    schema: SHOT_LIGHTING_SCHEMA,
    base: { mode: "replace" },
    lights: [{ ...newShotLight("point", "key"), id: "k", intensity }],
    authoredIntent: intent,
  });
const figure = (characterId: string, x: number, over: Partial<typeof anchor> = {}, revision = 1) => {
  const entry = newBlockingEntry(characterId, { x, y: 0, z: 0 });
  return {
    ...anchor,
    ...over,
    characterId,
    revision,
    entry,
    blockingFingerprint: blockingFingerprint(entry, { locationId: over.locationId ?? anchor.locationId }),
  };
};
const full = (x = 1): SetupRows => ({
  camera: { ...anchor, cameraLabel: "cam", value: camValue(x) },
  lighting: {
    ...anchor,
    revision: 2,
    rig: rig(10 * x),
    lightingFingerprint: lightingFingerprint(rig(10 * x)),
  },
  blocking: [figure("c1", x), figure("c2", x + 1)],
});
const empty: SetupRows = { camera: null, lighting: null, blocking: [] };
const plan = (
  source: SetupRows,
  destination: SetupRows,
  components: readonly SetupComponent[] = ["camera", "lighting", "blocking"],
) =>
  planSetupCopy({
    sourceShotId: "A",
    destinationShotId: "B",
    set,
    source,
    destination,
    components: [...components],
  });

describe("4D planSetupCopy", () => {
  it("plans every part, with no replacements into an empty Shot", () => {
    const p = plan(full(), empty);
    expect(p.components).toEqual(["camera", "lighting", "blocking"]);
    expect(p.camera!.replaces).toBeNull();
    expect(p.lighting!.replaces).toBeNull();
    expect(p.blocking!.figures.map((f) => f.characterId)).toEqual(["c1", "c2"]);
    expect(p.blocking!.removes).toEqual([]);
    expect(planIsNoop(p)).toBe(false);
    expect(p.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic, and identical content is a no-op", () => {
    expect(plan(full(), empty).token).toBe(plan(full(), empty).token);
    expect(planIsNoop(plan(full(), full()))).toBe(true);
  });

  it("the token changes when either side changes (a stale review is detectable)", () => {
    const t = plan(full(), empty).token;
    expect(plan(full(2), empty).token).not.toBe(t);
    expect(plan(full(), { ...empty, camera: full(5).camera }).token).not.toBe(t);
    const bumped = full();
    bumped.lighting = { ...bumped.lighting!, revision: 9 };
    expect(plan(full(), bumped).token).not.toBe(plan(full(), full()).token);
  });

  it("the token changes when the destination camera is re-anchored or relabelled with identical values", () => {
    const dest = full(5);
    const t = plan(full(), dest, ["camera"]).token;
    expect(
      plan(full(), { ...dest, camera: { ...dest.camera!, sceneRevision: 4 } }, ["camera"]).token,
    ).not.toBe(t);
    expect(
      plan(full(), { ...dest, camera: { ...dest.camera!, cameraLabel: "other" } }, ["camera"]).token,
    ).not.toBe(t);
  });

  it("rows on another set are history: never copied, never removed", () => {
    const src: SetupRows = { ...empty, blocking: [figure("c1", 1, { sceneDocumentId: "old" })] };
    expect(availableSetup(src, set)).toEqual({ camera: false, lighting: false, blocking: false });
    const dest: SetupRows = { ...empty, blocking: [figure("c9", 1, { sceneDocumentId: "old" })] };
    const p = plan(full(), dest, ["blocking"]);
    expect(p.blocking!.removes).toEqual([]);
  });

  it("blocking replaces the destination's current-set figures and lists the ones it removes", () => {
    const dest: SetupRows = { ...empty, blocking: [figure("c1", 9, {}, 4), figure("c3", 2, {}, 2)] };
    const p = plan(full(), dest, ["blocking"]);
    expect(p.blocking!.figures.find((f) => f.characterId === "c1")!.replaces).toMatchObject({ revision: 4 });
    expect(p.blocking!.removes).toEqual([
      { characterId: "c3", revision: 2, fingerprint: dest.blocking[1]!.blockingFingerprint },
    ]);
  });

  it("a destination row on another set is reported as such (it is replaced, not compare-and-set)", () => {
    const dest: SetupRows = { ...full(), lighting: { ...full().lighting!, sceneDocumentId: "old" } };
    expect(plan(full(), dest, ["lighting"]).lighting!.replaces!.onCurrentSet).toBe(false);
  });

  it("refuses: the same Shot, nothing chosen, a missing part, an unknown part", () => {
    const refuse = (fn: () => unknown) => expect(fn).toThrow(SetupCopyRefusal);
    refuse(() =>
      planSetupCopy({
        sourceShotId: "A",
        destinationShotId: "A",
        set,
        source: full(),
        destination: empty,
        components: ["camera"],
      }),
    );
    refuse(() => plan(full(), empty, []));
    refuse(() => plan(empty, full(), ["camera"]));
    refuse(() => parseSetupComponents(["camera", "audio"]));
  });

  it("the plan carries content fingerprints only — no source ids, so a copy cannot become a reference", () => {
    const p = plan(full(), empty);
    const json = JSON.stringify({ camera: p.camera, lighting: p.lighting, blocking: p.blocking });
    expect(json).not.toContain('"A"');
  });
});
