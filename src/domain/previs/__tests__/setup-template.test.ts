import { describe, expect, it } from "vitest";
import { blockingFingerprint, newBlockingEntry } from "../blocking";
import { SHOT_LIGHTING_SCHEMA, lightingFingerprint, newShotLight, parseShotLightingRig } from "../lighting";
import { planSetupCopy, SetupCopyRefusal, type SetupRows } from "../setup-copy";
import {
  normalizeTemplateName,
  parseSetupTemplateContent,
  setupTemplateContentFingerprint,
  snapshotSetupTemplate,
  templateAsSetupRows,
  templateParts,
} from "../setup-template";
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
const intent = (mood: string) => ({
  lighting: {
    keyDirection: "",
    fill: "",
    practicals: "",
    colorTemperature: "",
    mood,
    referenceAssetId: null,
    continuity: "",
  },
  timeOfDay: "",
  weather: "",
});
const rig = (i: number, mood = "") =>
  parseShotLightingRig({
    schema: SHOT_LIGHTING_SCHEMA,
    base: { mode: "replace" },
    lights: [{ ...newShotLight("point", "key"), id: "k", intensity: i }],
    authoredIntent: intent(mood),
  });
const fig = (characterId: string, x: number, over: Partial<typeof anchor> = {}) => {
  const entry = newBlockingEntry(characterId, { x, y: 0, z: 0 });
  return {
    ...anchor,
    ...over,
    characterId,
    revision: 1,
    entry,
    blockingFingerprint: blockingFingerprint(entry, set),
  };
};
const rows = (x = 1, mood = ""): SetupRows => ({
  camera: { ...anchor, cameraLabel: "cam", value: camValue(x) },
  lighting: {
    ...anchor,
    revision: 2,
    rig: rig(10 * x, mood),
    lightingFingerprint: lightingFingerprint(rig(10 * x)),
  },
  blocking: [fig("c2", x + 1), fig("c1", x)],
});
const ALL = ["camera", "lighting", "blocking"];

describe("4D-I2 setup templates (domain)", () => {
  it("a snapshot holds the values, sorted, without the Shot's authored lighting text", () => {
    const c = snapshotSetupTemplate({ rows: rows(1, "warm"), set, components: ALL });
    expect(templateParts(c)).toEqual(["camera", "lighting", "blocking"]);
    expect(c.lighting!.rig).not.toHaveProperty("authoredIntent");
    expect(c.blocking!.map((f) => f.characterId)).toEqual(["c1", "c2"]);
    expect(c.camera!.sceneRevision).toBe(3);
  });

  it("only the chosen parts are saved; a part the Shot does not have on this set is refused", () => {
    expect(templateParts(snapshotSetupTemplate({ rows: rows(), set, components: ["lighting"] }))).toEqual([
      "lighting",
    ]);
    const empty: SetupRows = { camera: null, lighting: null, blocking: [] };
    expect(() => snapshotSetupTemplate({ rows: empty, set, components: ["camera"] })).toThrow(
      SetupCopyRefusal,
    );
    expect(() => snapshotSetupTemplate({ rows: rows(), set, components: [] })).toThrow(SetupCopyRefusal);
    // a row the Shot left on another set is history: never saved
    const old: SetupRows = { ...empty, blocking: [fig("c1", 1, { sceneDocumentId: "old" })] };
    expect(() => snapshotSetupTemplate({ rows: old, set, components: ["blocking"] })).toThrow(
      SetupCopyRefusal,
    );
  });

  it("the content fingerprint is the values only: not the Shot's notes, the set anchor or anything descriptive", () => {
    const fp = (r: SetupRows) =>
      setupTemplateContentFingerprint(snapshotSetupTemplate({ rows: r, set, components: ALL }), set);
    expect(fp(rows(1, "warm"))).toBe(fp(rows(1, "cold")));
    const reanchored = rows();
    reanchored.camera = { ...reanchored.camera!, sceneRevision: 9 };
    expect(fp(reanchored)).toBe(fp(rows()));
    expect(fp(rows(2))).not.toBe(fp(rows(1)));
  });

  it("the stored shape is strict: no authored lighting text, no duplicate or mismatched figures, never empty", () => {
    const c = snapshotSetupTemplate({ rows: rows(), set, components: ALL });
    const withIntent = {
      ...c,
      lighting: { ...c.lighting!, rig: { ...c.lighting!.rig, authoredIntent: intent("x") } },
    };
    expect(() => parseSetupTemplateContent(withIntent)).toThrow();
    expect(() => parseSetupTemplateContent({ ...c, blocking: [c.blocking![0], c.blocking![0]] })).toThrow();
    const mismatched = { ...c.blocking![0]!, characterId: "someone-else" };
    expect(() => parseSetupTemplateContent({ ...c, blocking: [mismatched] })).toThrow();
    expect(() => parseSetupTemplateContent({ camera: null, lighting: null, blocking: null })).toThrow();
  });

  it("applying plans like a Shot-to-Shot copy: identical fingerprints; the template revision is in the token", () => {
    const c = snapshotSetupTemplate({ rows: rows(), set, components: ALL });
    const src = templateAsSetupRows(c, set);
    expect(src.lighting!.lightingFingerprint).toBe(rows().lighting!.lightingFingerprint);
    expect(src.blocking.map((b) => b.blockingFingerprint).sort()).toEqual(
      rows()
        .blocking.map((b) => b.blockingFingerprint)
        .sort(),
    );
    const plan = (revision: number) =>
      planSetupCopy({
        sourceShotId: null,
        template: { id: "T", revision, contentFingerprint: setupTemplateContentFingerprint(c, set) },
        destinationShotId: "B",
        set,
        source: src,
        destination: { camera: null, lighting: null, blocking: [] },
        components: ALL as never,
      });
    expect(plan(1).token).not.toBe(plan(2).token);
    expect(plan(1).template).toMatchObject({ id: "T", revision: 1 });
    expect(plan(1).sourceShotId).toBeNull();
  });

  it("a plan needs exactly one origin", () => {
    const base = {
      destinationShotId: "B",
      set,
      source: rows(),
      destination: rows(),
      components: ["camera"] as never,
    };
    expect(() => planSetupCopy({ ...base, sourceShotId: null })).toThrow(SetupCopyRefusal);
    expect(() =>
      planSetupCopy({
        ...base,
        sourceShotId: "A",
        template: { id: "T", revision: 1, contentFingerprint: "0".repeat(64) },
      }),
    ).toThrow(SetupCopyRefusal);
  });

  it("names are trimmed, collapsed and bounded", () => {
    expect(normalizeTemplateName("  Night   key ")).toBe("Night key");
    expect(() => normalizeTemplateName("  ")).toThrow(SetupCopyRefusal);
    expect(() => normalizeTemplateName("x".repeat(121))).toThrow(SetupCopyRefusal);
  });
});
