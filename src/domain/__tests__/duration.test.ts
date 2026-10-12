import { describe, expect, it } from "vitest";
import { computeShotDuration } from "@/domain/duration";
import { seed, shotByCode } from "./helpers";

describe("shot duration from selected performance", () => {
  it("derives 4.5s for 3A: 0.8 pre + 2.8 line + 0.9 post", () => {
    const data = seed();
    const shot = shotByCode(data, "3A");
    const result = computeShotDuration(shot, data.takes);
    expect(result.source).toBe("performance");
    expect(result.durationMs).toBe(4500);
    expect(result.breakdown).toEqual({ preRollMs: 800, performanceMs: 2800, gapsMs: 0, postRollMs: 900 });
  });

  it("follows the selected take, not other takes", () => {
    const data = seed();
    const shot = shotByCode(data, "3A");
    const takes = data.takes.map((t) =>
      t.dialogueLineId === shot.audio.dialogueLineIds[0] ? { ...t, selected: t.takeNumber === 2 } : t,
    );
    expect(computeShotDuration(shot, takes).durationMs).toBe(800 + 3300 + 900);
  });

  it("adds inter-line gaps for multi-line shots", () => {
    const data = seed();
    const shot = shotByCode(data, "5A");
    expect(computeShotDuration(shot, data.takes).durationMs).toBe(400 + 2600 + 600 + 2300 + 900);
  });

  it("falls back to manual duration when a line has no selected take", () => {
    const data = seed();
    const shot = shotByCode(data, "4B");
    const result = computeShotDuration(shot, data.takes);
    expect(result.source).toBe("manual_fallback");
    expect(result.durationMs).toBe(6500);
    expect(result.missingTakeLineIds).toHaveLength(1);
  });

  it("uses manual duration in manual mode regardless of takes", () => {
    const data = seed();
    const shot = { ...shotByCode(data, "3A"), durationMode: "manual" as const, targetDurationMs: 6000 };
    expect(computeShotDuration(shot, data.takes)).toMatchObject({ source: "manual", durationMs: 6000 });
  });
});
