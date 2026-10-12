import { describe, expect, it } from "vitest";
import { buildShotContext } from "@/domain/context";
import { runPreflight } from "@/domain/preflight";
import { seed, shotByCode } from "./helpers";

const blockers = (data: ReturnType<typeof seed>, code: string) =>
  runPreflight(buildShotContext(data, shotByCode(data, code).id)).blockers.map((b) => b.ruleId);

describe("required continuity constraints", () => {
  it("fails when continuity is not approved", () => {
    expect(blockers(seed(), "1C")).toContain("approval.continuity");
  });

  it("fails when time of day is missing on both shot and scene", () => {
    const data = seed();
    const shot = shotByCode(data, "3A");
    shot.continuity.timeOfDay = "";
    data.scenes.find((s) => s.id === shot.sceneId)!.timeOfDay = "";
    expect(blockers(data, "3A")).toContain("continuity.time_of_day");
  });

  it("requires a locked set", () => {
    expect(blockers(seed(), "5A")).toContain("set.locked");
  });

  it("requires a declared count of 0 for empty frames", () => {
    const data = seed();
    shotByCode(data, "1A").continuity.characterCount = null;
    expect(blockers(data, "1A")).toContain("character.assigned");
  });
});
