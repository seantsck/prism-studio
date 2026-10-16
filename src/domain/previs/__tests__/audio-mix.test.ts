import { describe, expect, it } from "vitest";
import { buildShotContext } from "@/domain/context";
import { computeShotDuration, layoutPerformance } from "@/domain/duration";
import { buildAudioCues } from "@/lib/previs/performance-audio";
import { seed, shotByCode } from "@/domain/__tests__/helpers";
import {
  audioMixFingerprint,
  buildPerformanceAudioPlan,
  layoutTimelineCues,
  pickCurrentClip,
  previsStaleReasons,
  type TimelineTake,
} from "../audio-mix";
import { performanceAudioPlanForShot, shotTimelineCues } from "../audio-mix-shot";

// pre-roll 500 · take A 600 (440 Hz) · gap 300 · take B 800 (660 Hz) · post-roll 200
const A: TimelineTake = { assetId: "asset-a", assetChecksum: "c".repeat(64), durationMs: 600 };
const B: TimelineTake = { assetId: "asset-b", assetChecksum: "d".repeat(64), durationMs: 800 };
const SHOT_MS = 500 + 600 + 300 + 800 + 200; // 2400

const plan = (takes: Array<TimelineTake | null> = [A, B], over: Record<string, number> = {}) =>
  buildPerformanceAudioPlan({
    renderDurationMs: over.render ?? 2400,
    shotDurationMs: over.shot ?? SHOT_MS,
    cues: layoutTimelineCues(over.pre ?? 500, over.gap ?? 300, takes),
  })!;

describe("one Shot timeline for camera, interactive audio and the offline mix", () => {
  it("layoutPerformance is the arithmetic behind computeShotDuration", () => {
    const layout = layoutPerformance(500, 300, [600, 800]);
    expect(layout.segments).toEqual([
      { startMs: 500, durationMs: 600 },
      { startMs: 1400, durationMs: 800 },
    ]);
    expect(layout.speechEndMs + 200).toBe(SHOT_MS);
  });

  it("pre-roll shifts the first take; gaps are preserved; post-roll is the tail", () => {
    const p = plan();
    expect(p.cues.map((c) => [c.assetId, c.timelineStartMs, c.durationMs])).toEqual([
      ["asset-a", 500, 600],
      ["asset-b", 1400, 800],
    ]);
    // gap between the takes is exactly the Shot's inter-line gap, and silence follows B until the render ends
    expect(p.cues[1]!.timelineStartMs - (p.cues[0]!.timelineStartMs + p.cues[0]!.durationMs)).toBe(300);
    expect(p.durationMs - (p.cues[1]!.timelineStartMs + p.cues[1]!.durationMs)).toBe(200);
  });

  it("a take without an audio file is silent but still occupies its time", () => {
    const silent: TimelineTake = { assetId: null, assetChecksum: null, durationMs: 700 };
    const p = plan([silent, B], { render: 3000, shot: 3000 });
    expect(p.cues).toHaveLength(1);
    expect(p.cues[0]!.timelineStartMs).toBe(500 + 700 + 300);
  });

  it("a line with no selected take occupies no time", () => {
    const p = plan([A, null, B]);
    expect(p.cues.map((c) => c.timelineStartMs)).toEqual([500, 1400]);
  });

  it("a cue is trimmed to the rendered duration and a cue starting after it is dropped", () => {
    const p = plan([A, B], { render: 1700 });
    expect(p.cues.map((c) => c.durationMs)).toEqual([600, 300]);
    expect(plan([A, B], { render: 1000 }).cues.map((c) => c.assetId)).toEqual(["asset-a"]);
    expect(
      buildPerformanceAudioPlan({
        renderDurationMs: 400,
        shotDurationMs: 2400,
        cues: layoutTimelineCues(500, 300, [A]),
      }),
    ).toBeNull();
  });

  it("interactive cues, the offline plan and computeShotDuration agree for every seeded shot", () => {
    const data = seed();
    for (const shot of data.shots) {
      const ctx = buildShotContext(data, shot.id);
      const d = computeShotDuration(shot, data.takes);
      const { cues, shotDurationMs } = shotTimelineCues(data, shot.id);
      expect(shotDurationMs, shot.shotCode).toBe(d.durationMs);
      const interactive = buildAudioCues({
        preRollMs: ctx.shot.audio.preRollMs,
        interLineGapMs: ctx.shot.audio.interLineGapMs,
        takes: ctx.lines.map((l) => l.selectedTake ?? null),
      });
      expect(
        interactive.map((c) => [c.assetId, c.startMs, c.durationMs]),
        shot.shotCode,
      ).toEqual(cues.filter((c) => c.assetId).map((c) => [c.assetId, c.startMs, c.durationMs]));
      const offline = performanceAudioPlanForShot(data, shot.id, d.durationMs || 4000);
      if (d.breakdown && offline) {
        // the last cue ends exactly where speech ends; the post-roll is what remains
        const last = offline.cues[offline.cues.length - 1]!;
        expect(last.timelineStartMs + last.durationMs + d.breakdown.postRollMs, shot.shotCode).toBe(
          d.durationMs,
        );
      }
    }
  });

  it("the seeded 3A shot places its selected take after the pre-roll", () => {
    const data = seed();
    const shot = shotByCode(data, "3A");
    const p = performanceAudioPlanForShot(data, shot.id, 4500)!;
    expect(p.cues[0]!.timelineStartMs).toBe(800);
    expect(p.cues[0]!.durationMs).toBe(2800);
    expect(p.sampleRate).toBe(48_000);
    expect(p.channels).toBe(2);
  });
});

describe("audio mix fingerprint", () => {
  const fp = (p = plan()) => audioMixFingerprint(p);

  it("is deterministic and a sha-256", () => {
    expect(fp()).toMatch(/^[0-9a-f]{64}$/);
    expect(fp()).toBe(fp(plan()));
  });

  it("changes when the mix content changes", () => {
    const base = fp();
    expect(fp(plan([B, A]))).not.toBe(base); // cue order
    expect(fp(plan([A, { ...B, assetId: "asset-z" }]))).not.toBe(base); // selected take
    expect(fp(plan([A, { ...B, assetChecksum: "e".repeat(64) }]))).not.toBe(base); // asset bytes
    expect(fp(plan([A, { ...B, durationMs: 700 }]))).not.toBe(base); // take duration
    expect(fp(plan([A, B], { pre: 600 }))).not.toBe(base); // pre-roll
    expect(fp(plan([A, B], { gap: 400 }))).not.toBe(base); // gap
    expect(fp(plan([A, B], { shot: SHOT_MS + 100 }))).not.toBe(base); // post-roll (Shot duration)
    const shifted = plan();
    shifted.cues[0] = { ...shifted.cues[0]!, sourceStartMs: 50 };
    expect(fp(shifted)).not.toBe(base); // source offset
  });

  it("does not depend on anything outside the mix", () => {
    const p = plan();
    // extra, non-mix state riding along on the object cannot influence the identity
    const withUi = { ...p, playheadMs: 1234, volume: 0.5, selected: "x", objectUrl: "blob:abc" };
    expect(audioMixFingerprint(withUi)).toBe(fp(p));
  });
});

describe("previs staleness is judged by what the clip contains", () => {
  const cur = { currentSceneFingerprint: "S", currentPathFingerprint: "P" };
  const silent = { sceneFingerprint: "S", pathFingerprint: "P", audioMixFingerprint: null };
  const withAudio = { sceneFingerprint: "S", pathFingerprint: "P", audioMixFingerprint: "M1" };

  it("current when scene, path (and mix, if the clip has audio) match", () => {
    expect(previsStaleReasons({ clip: silent, ...cur, currentAudioMixFingerprint: null })).toEqual([]);
    expect(previsStaleReasons({ clip: withAudio, ...cur, currentAudioMixFingerprint: "M1" })).toEqual([]);
  });

  it("scene and camera changes stale any clip", () => {
    expect(
      previsStaleReasons({
        clip: silent,
        currentSceneFingerprint: "S2",
        currentPathFingerprint: "P",
        currentAudioMixFingerprint: null,
      }),
    ).toEqual(["scene"]);
    expect(
      previsStaleReasons({
        clip: withAudio,
        currentSceneFingerprint: "S",
        currentPathFingerprint: "P2",
        currentAudioMixFingerprint: "M1",
      }),
    ).toEqual(["camera"]);
  });

  it("an audio change stales an audio previs but NOT a silent one", () => {
    expect(previsStaleReasons({ clip: withAudio, ...cur, currentAudioMixFingerprint: "M2" })).toEqual([
      "audio",
    ]);
    expect(previsStaleReasons({ clip: withAudio, ...cur, currentAudioMixFingerprint: null })).toEqual([
      "audio",
    ]);
    expect(previsStaleReasons({ clip: silent, ...cur, currentAudioMixFingerprint: "M2" })).toEqual([]);
  });

  it("reports every reason at once", () => {
    expect(
      previsStaleReasons({
        clip: withAudio,
        currentSceneFingerprint: "S2",
        currentPathFingerprint: "P2",
        currentAudioMixFingerprint: "M2",
      }),
    ).toEqual(["scene", "camera", "audio"]);
  });
});

describe("the latest CURRENT previs", () => {
  const c = (id: string, path: string, mix: string | null, at: string) => ({
    id,
    pathFingerprint: path,
    audioMixFingerprint: mix,
    renderedAt: at,
  });
  it("skips an audio clip whose mix is stale and falls back to the latest valid one", () => {
    const clips = [
      c("new-audio", "P", "M1", "2026-01-03"),
      c("silent", "P", null, "2026-01-02"),
      c("old-audio", "P", "M0", "2026-01-01"),
    ];
    expect(pickCurrentClip(clips, "P", "M1")?.id).toBe("new-audio");
    expect(pickCurrentClip(clips, "P", "M9")?.id).toBe("silent"); // takes changed: the silent camera test stands
    expect(pickCurrentClip(clips, "P2", "M1")).toBeNull(); // camera changed
  });
});
