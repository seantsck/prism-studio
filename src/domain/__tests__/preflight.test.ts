import { describe, expect, it } from "vitest";
import { buildShotContext } from "@/domain/context";
import { runPreflight } from "@/domain/preflight";
import { seed, shotByCode } from "./helpers";

const report = (data: ReturnType<typeof seed>, code: string) =>
  runPreflight(buildShotContext(data, shotByCode(data, code).id));
const status = (r: ReturnType<typeof report>, ruleId: string) =>
  r.items.find((i) => i.ruleId === ruleId)?.status;

describe("shot preflight", () => {
  it("marks a fully prepped shot ready, with model absence only a warning", () => {
    const r = report(seed(), "2B");
    expect(r.blockers.map((b) => b.ruleId)).toEqual([]);
    expect(r.ready).toBe(true);
    expect(status(r, "generation.model")).toBe("warn");
    expect(status(r, "performance.takes")).toBe("na");
    expect(status(r, "continuity.vehicle")).toBe("pass");
  });

  it("blocks when the storyboard frame is missing", () => {
    const r = report(seed(), "2A");
    expect(r.ready).toBe(false);
    expect(status(r, "storyboard.frame")).toBe("fail");
  });

  it("blocks when a dialogue line has no selected take or the Look is unlocked", () => {
    const r = report(seed(), "4B");
    expect(status(r, "performance.takes")).toBe("fail");
    expect(status(r, "character.look_locked")).toBe("fail");
    expect(r.ready).toBe(false);
  });

  it("requires vehicle orientation only when a vehicle is in play", () => {
    const data = seed();
    const shot = shotByCode(data, "2B");
    shot.continuity.vehicleOrientation = "";
    expect(status(report(data, "2B"), "continuity.vehicle")).toBe("fail");
    shot.continuity.vehicleInPlay = false;
    expect(status(report(data, "2B"), "continuity.vehicle")).toBe("na");
  });

  it("requires explicit weather and a consistent character count", () => {
    const data = seed();
    const shot = shotByCode(data, "3A");
    shot.continuity.weather = "";
    shot.continuity.characterCount = 2;
    const r = report(data, "3A");
    expect(status(r, "continuity.weather")).toBe("fail");
    expect(status(r, "continuity.character_count")).toBe("fail");
    expect(r.ready).toBe(false);
  });

  it("requires a previous-shot link except for the first shot", () => {
    const data = seed();
    expect(status(report(data, "1A"), "continuity.previous")).toBe("na");
    shotByCode(data, "2B").continuity.previousShotId = null;
    expect(status(report(data, "2B"), "continuity.previous")).toBe("fail");
  });

  it("is deterministic and scores readiness", () => {
    const data = seed();
    expect(report(data, "2B")).toEqual(report(data, "2B"));
    expect(report(data, "2B").score).toBeGreaterThan(report(data, "6A").score);
  });
});
