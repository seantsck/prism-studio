import { describe, expect, it } from "vitest";
import { onCurrentSet } from "@/domain/previs/blocking";
import {
  MISSING_SOURCE_MASTER_FRAME,
  locationSetHref,
  productionFrameSourceLineage,
  sharedSetMessage,
  sharedSetShots,
  shotSpatialHref,
  shotSwitchDecision,
  shotSwitchDecisionNow,
  spatialAxisStates,
  workingSetChanges,
} from "@/domain/previs/spatial-workspace";

const H = (c: string) => c.repeat(64);

describe("Phase 4C-I2 workspace routes", () => {
  it("the Shot route is canonical and the Location page switches Shots by URL", () => {
    expect(shotSpatialHref("p", "ep-1", "s1")).toBe("/projects/p/episodes/ep-1/shots/s1/spatial");
    expect(locationSetHref("p", "L", "s2")).toBe("/projects/p/locations/L/3d?shot=s2");
    expect(locationSetHref("p", "L", null)).toBe("/projects/p/locations/L/3d");
  });
});

describe("Shot switch on the Location page (P6)", () => {
  it("navigates when clean, asks first when the Set is dirty, and ignores the same Shot", () => {
    expect(shotSwitchDecision({ from: "A", to: "B", setDirty: false })).toBe("navigate");
    expect(shotSwitchDecision({ from: "A", to: "B", setDirty: true })).toBe("confirm");
    expect(shotSwitchDecision({ from: "A", to: "A", setDirty: true })).toBe("none");
    expect(shotSwitchDecision({ from: null, to: "B", setDirty: true })).toBe("confirm");
    expect(shotSwitchDecision({ from: "A", to: null, setDirty: false })).toBe("navigate");
  });
});

describe("Shot switch reads the Set at the switch (immediate-switch race)", () => {
  it("asks first when the Set read NOW is dirty, whatever a lagging presentation flag says", () => {
    const presentationDirty = false; // the debounced badge has not caught up with the edit yet
    let reads = 0;
    const decision = shotSwitchDecisionNow({
      from: "A",
      to: "B",
      readSetDirty: () => {
        reads++;
        return true; // the adapter, serialized at the click, already has the edit
      },
    });
    expect(presentationDirty).toBe(false);
    expect(decision).toBe("confirm");
    expect(reads).toBe(1);
  });
  it("navigates when the Set read now is clean, and never reads for the same Shot", () => {
    expect(shotSwitchDecisionNow({ from: "A", to: "B", readSetDirty: () => false })).toBe("navigate");
    const never = () => {
      throw new Error("must not read the Set for the same Shot");
    };
    expect(shotSwitchDecisionNow({ from: "A", to: "A", readSetDirty: never })).toBe("none");
  });
});

describe("working Set dirty rule (Location-owned truth only)", () => {
  const base = {
    liveFingerprint: H("a"),
    cleanFingerprint: H("a"),
    liveBaseEnvironmentFingerprint: H("e"),
    savedBaseEnvironmentFingerprint: H("e"),
  };
  it("clean when the live scene equals the clean baseline and the base environment equals the saved one", () => {
    expect(workingSetChanges(base)).toEqual({
      dirty: false,
      sceneChanged: false,
      baseEnvironmentChanged: false,
    });
  });
  it("a geometry / camera change is a Set change", () => {
    expect(workingSetChanges({ ...base, liveFingerprint: H("b") }).sceneChanged).toBe(true);
  });
  it("a skybox-only change is a Set change although sceneFingerprint did not move", () => {
    const r = workingSetChanges({ ...base, liveBaseEnvironmentFingerprint: H("f") });
    expect(r).toEqual({ dirty: true, sceneChanged: false, baseEnvironmentChanged: true });
  });
  it("a restored Shot camera is the clean baseline: not dirty while the saved fingerprint differs", () => {
    // the baseline is the saved set WITH the restored camera, not the saved fingerprint
    expect(workingSetChanges({ ...base, liveFingerprint: H("c"), cleanFingerprint: H("c") }).dirty).toBe(
      false,
    );
  });
  it("a set never saved is dirty as soon as it has a live fingerprint", () => {
    expect(
      workingSetChanges({
        liveFingerprint: H("a"),
        cleanFingerprint: null,
        liveBaseEnvironmentFingerprint: H("e"),
        savedBaseEnvironmentFingerprint: null,
      }).dirty,
    ).toBe(true);
  });
});

describe("shared Set awareness", () => {
  const data = {
    episodes: [
      { id: "e1", number: 1, order: 1 },
      { id: "e2", number: 2, order: 2 },
    ],
    shots: [
      { id: "a", episodeId: "e1", shotCode: "2A", order: 1, spatial: { locationId: "L" } },
      { id: "b", episodeId: "e1", shotCode: "2B", order: 2, spatial: { locationId: "L" } },
      { id: "c", episodeId: "e2", shotCode: "3A", order: 1, spatial: { locationId: "L" } },
      { id: "d", episodeId: "e1", shotCode: "2C", order: 3, spatial: { locationId: "M" } },
      { id: "e", episodeId: "e1", shotCode: "2D", order: 4, spatial: { locationId: null } },
    ],
  } as unknown as Parameters<typeof sharedSetShots>[0];

  it("lists the OTHER Shots currently on the Location, never the active one", () => {
    const shared = sharedSetShots(data, "L", { id: "a", episodeId: "e1" });
    expect(shared.map((s) => s.id)).toEqual(["b", "c"]);
    expect(shared.map((s) => s.label)).toEqual(["2B", "Ep 2 3A"]);
    expect(sharedSetMessage(shared)).toBe("This 3D Set is shared by 2 other Shots: 2B, Ep 2 3A.");
  });
  it("one other Shot, and none", () => {
    expect(sharedSetMessage(sharedSetShots(data, "M", null))).toBe(
      "This 3D Set is shared by 1 other Shot: Ep 1 2C.",
    );
    expect(sharedSetMessage(sharedSetShots(data, "M", { id: "d", episodeId: "e1" }))).toBeNull();
  });
});

describe("four-axis status presentation", () => {
  it("maps the server's stale / unknown arrays onto Scene · Camera · Blocking · Lighting", () => {
    expect(spatialAxisStates({ stale: ["scene", "lighting"], unknown: ["camera"] })).toEqual([
      { axis: "scene", label: "Scene", state: "stale" },
      { axis: "camera", label: "Camera", state: "unknown" },
      { axis: "blocking", label: "Blocking", state: "fresh" },
      { axis: "lighting", label: "Lighting", state: "stale" },
    ]);
  });
});

describe("Production Frame source lineage presentation", () => {
  const frame = {
    source: "previs_master" as const,
    sourceMasterFrameId: "mf-1",
    sourceSceneFingerprint: H("1"),
    sourceCameraFingerprint: H("2"),
    sourceBlockingFingerprint: null,
    sourceLightingFingerprint: null,
    sourceBaseEnvironmentFingerprint: H("5"),
  };
  it("names the existing source Master Frame and short frozen fingerprints", () => {
    const l = productionFrameSourceLineage(frame, [{ id: "mf-1", capturedAt: "2026-11-04T10:00:00.000Z" }])!;
    expect(l.source).toEqual({ id: "mf-1", capturedAt: "2026-11-04T10:00:00.000Z" });
    expect(l.missingMessage).toBeNull();
    expect(l.frozen).toBe(true);
    expect(l.fingerprints.map((f) => f.value)).toEqual([
      "1".repeat(12),
      "2".repeat(12),
      null,
      null,
      "5".repeat(12),
    ]);
  });
  it("a deleted source Master Frame is a normal, truthful state (never corruption, never a throw)", () => {
    const l = productionFrameSourceLineage(frame, [])!;
    expect(l.source).toBeNull();
    expect(l.missingMessage).toBe(MISSING_SOURCE_MASTER_FRAME);
    expect(l.frozen).toBe(true); // the frozen provenance stays
  });
  it("a frame promoted before 4C recorded nothing frozen; other sources have no lineage", () => {
    expect(productionFrameSourceLineage({ ...frame, sourceSceneFingerprint: null }, [])!.frozen).toBe(false);
    expect(productionFrameSourceLineage({ ...frame, source: "upload" }, [])).toBeNull();
  });
});

describe("onCurrentSet", () => {
  const rows = [
    { id: "1", locationId: "A", sceneDocumentId: "sa" },
    { id: "2", locationId: "B", sceneDocumentId: "sb" },
    { id: "3", locationId: "B", sceneDocumentId: "sx" },
  ];
  it("keeps only rows authored on the current Location's saved set", () => {
    expect(onCurrentSet(rows, { locationId: "B", sceneDocumentId: "sb" }).map((r) => r.id)).toEqual(["2"]);
  });
  it("with no current set nothing is current", () => {
    expect(onCurrentSet(rows, null)).toEqual([]);
  });
});
