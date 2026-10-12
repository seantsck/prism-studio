import { describe, expect, it } from "vitest";
import { buildShotContext } from "@/domain/context";
import { computeShotDuration } from "@/domain/duration";
import { buildSceneAudioAssembly, buildShotTimeline, describeTimeline, timelineFromContext } from "@/domain/timeline";
import { seed, shotByCode } from "./helpers";

describe("shot timeline (explainable timing)", () => {
  it("3A: 0.8 pre-roll + 2.8 selected take + 0.9 reaction hold = 4.5s, segment by segment", () => {
    const data = seed();
    const t = timelineFromContext(buildShotContext(data, shotByCode(data, "3A").id));
    expect(t.source).toBe("performance");
    expect(t.totalMs).toBe(4500);
    expect(t.segments.map((s) => [s.kind, s.startMs, s.endMs])).toEqual([
      ["pre_roll", 0, 800],
      ["dialogue", 800, 3600],
      ["reaction", 3600, 4500],
    ]);
    expect(t.segments[1].label).toMatch(/Yumeko · selected Take 1/);
    expect(describeTimeline(t)).toEqual([
      "0.00–0.80  Pre-roll / expression",
      "0.80–3.60  Yumeko · selected Take 1",
      "3.60–4.50  Reaction hold",
      "Total 4.5s",
    ]);
  });

  it("agrees with computeShotDuration for every seeded shot", () => {
    const data = seed();
    for (const shot of data.shots) {
      const ctx = buildShotContext(data, shot.id);
      const t = timelineFromContext(ctx);
      const d = computeShotDuration(shot, data.takes);
      expect(t.totalMs, shot.shotCode).toBe(d.durationMs);
      expect(t.source, shot.shotCode).toBe(d.source);
    }
  });

  it("multi-line shots include pauses between takes", () => {
    const data = seed();
    const t = timelineFromContext(buildShotContext(data, shotByCode(data, "5A").id));
    expect(t.segments.map((s) => s.kind)).toEqual(["pre_roll", "dialogue", "pause", "dialogue", "reaction"]);
    expect(t.segments.at(-1)!.endMs).toBe(t.totalMs);
    // contiguous: each segment starts where the previous ended
    t.segments.forEach((s, i) => {
      if (i > 0) expect(s.startMs).toBe(t.segments[i - 1].endMs);
    });
  });

  it("falls back to the manual target and names the missing takes", () => {
    const data = seed();
    const t = timelineFromContext(buildShotContext(data, shotByCode(data, "4B").id));
    expect(t.source).toBe("manual_fallback");
    expect(t.totalMs).toBe(6500);
    expect(t.missingTakeLineIds).toHaveLength(1);
    expect(t.segments.at(-1)?.label).toMatch(/missing a selected take/);
  });

  it("manual shots still place selected takes so they can be heard", () => {
    const shot = {
      audio: { preRollMs: 500, postRollMs: 500, interLineGapMs: 0 },
      durationMode: "manual" as const,
      targetDurationMs: 5000,
    };
    const t = buildShotTimeline(shot as never, [
      { lineId: "l1", speaker: "A", text: "hi", take: { id: "t", takeNumber: 1, durationMs: 1500, audioAssetId: null } },
    ]);
    expect(t.totalMs).toBe(5000);
    expect(t.source).toBe("manual");
    expect(t.segments.map((s) => s.kind)).toEqual(["pre_roll", "dialogue", "manual"]);
    expect(t.segments[2]).toMatchObject({ startMs: 2000, endMs: 5000 });
  });

  it("archived takes never count as the selected take", () => {
    const data = seed();
    const shot = shotByCode(data, "3A");
    const lineId = shot.audio.dialogueLineIds[0];
    data.takes = data.takes.map((t) =>
      t.dialogueLineId === lineId && t.selected ? { ...t, selected: false, archived: true } : t,
    );
    const t = timelineFromContext(buildShotContext(data, shot.id));
    expect(t.source).toBe("manual_fallback");
  });
});

describe("scene audio assembly", () => {
  it("lays selected takes, pauses, reaction holds and placeholders on one scene timeline", () => {
    const data = seed();
    const sceneId = shotByCode(data, "2D").sceneId;
    const a = buildSceneAudioAssembly(data, sceneId);
    expect(a.totalMs).toBe(a.shots.reduce((n, s) => n + s.durationMs, 0));
    expect(a.shots[0].startMs).toBe(0);
    a.shots.forEach((s, i) => {
      if (i > 0) expect(s.startMs).toBe(a.shots[i - 1].startMs + a.shots[i - 1].durationMs);
    });
    expect(a.cues.some((c) => c.kind === "dialogue" && !c.placeholder)).toBe(true);
    expect(a.cues.some((c) => c.kind === "ambience" && c.placeholder)).toBe(true);
    // sorted by start time
    for (let i = 1; i < a.cues.length; i++) expect(a.cues[i].startMs).toBeGreaterThanOrEqual(a.cues[i - 1].startMs);
  });
});
