import { describe, expect, it } from "vitest";
import { computeShotDuration } from "@/domain/duration";
import {
  buildAudioCues,
  PerformanceAudioScheduler,
  type AudioCue,
  type AudioLike,
  type SchedulerEnv,
} from "../performance-audio";

class FakeAudio implements AudioLike {
  currentTime = 0;
  preload = "";
  plays = 0;
  playing = false;
  released = false;
  constructor(readonly assetId: string) {}
  play() {
    this.plays++;
    this.playing = true;
    return Promise.resolve();
  }
  pause() {
    this.playing = false;
  }
  release() {
    this.released = true;
  }
}

/** Deterministic env: a manual clock, fake timers, no audio hardware. */
function makeEnv() {
  const created: FakeAudio[] = [];
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const env: SchedulerEnv = {
    createAudio: (id) => {
      const a = new FakeAudio(id);
      created.push(a);
      return a;
    },
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h) => void timers.delete(h as number),
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = target;
  };
  return { env, created, advance, pending: () => timers.size };
}

// pre-roll 500, take A 2000, gap 300, take B 1500  → A 500–2500, B 2800–4300
const CUES: AudioCue[] = [
  { assetId: "A", startMs: 500, durationMs: 2000 },
  { assetId: "B", startMs: 2800, durationMs: 1500 },
];
const live = (c: FakeAudio[]) => c.filter((a) => a.playing);

describe("buildAudioCues (timing mirrors computeShotDuration)", () => {
  const audio = { preRollMs: 500, interLineGapMs: 300, postRollMs: 200, dialogueLineIds: ["l1", "l2"] };
  it("places takes after pre-roll and preserves gaps", () => {
    const cues = buildAudioCues({
      preRollMs: 500,
      interLineGapMs: 300,
      takes: [
        { audioAssetId: "A", durationMs: 2000 },
        { audioAssetId: "B", durationMs: 1500 },
      ],
    });
    expect(cues).toEqual(CUES);
  });
  it("a take without audio is silent but still occupies its time", () => {
    const cues = buildAudioCues({
      preRollMs: 500,
      interLineGapMs: 300,
      takes: [{ audioAssetId: null, durationMs: 2000 }, null, { audioAssetId: "B", durationMs: 1500 }],
    });
    expect(cues).toEqual([{ assetId: "B", startMs: 500 + 2000 + 300, durationMs: 1500 }]);
  });
  it("agrees with the Shot duration authority", () => {
    const duration = computeShotDuration(
      { durationMode: "from_audio", targetDurationMs: null, audio } as never,
      [
        { dialogueLineId: "l1", selected: true, durationMs: 2000 },
        { dialogueLineId: "l2", selected: true, durationMs: 1500 },
      ] as never,
    );
    const cues = buildAudioCues({
      preRollMs: audio.preRollMs,
      interLineGapMs: audio.interLineGapMs,
      takes: [
        { durationMs: 2000, audioAssetId: "A" },
        { durationMs: 1500, audioAssetId: "B" },
      ],
    });
    const last = cues[cues.length - 1]!;
    expect(last.startMs + last.durationMs + audio.postRollMs).toBe(duration.durationMs);
  });
});

describe("PerformanceAudioScheduler", () => {
  it("A/B: from 0 the take starts at the pre-roll offset, not immediately", () => {
    const { env, created, advance } = makeEnv();
    const s = new PerformanceAudioScheduler(env, CUES);
    s.start(0);
    expect(live(created)).toHaveLength(0); // pre-roll is silent
    advance(499);
    expect(live(created)).toHaveLength(0);
    advance(1);
    expect(live(created).map((a) => a.assetId)).toEqual(["A"]);
    expect(created[0]!.currentTime).toBe(0); // from the start of the take
  });

  it("C: the gap between takes is preserved", () => {
    const { env, created, advance } = makeEnv();
    const s = new PerformanceAudioScheduler(env, CUES);
    s.start(0);
    advance(2799);
    expect(created.find((a) => a.assetId === "B")!.plays).toBe(0);
    advance(1);
    expect(created.find((a) => a.assetId === "B")!.plays).toBe(1);
    // B starts 300 ms after A's 2500 end
    expect(2800 - (500 + 2000)).toBe(300);
  });

  it("D: seeking into the middle of a take starts from the right source offset", () => {
    const { env, created } = makeEnv();
    const s = new PerformanceAudioScheduler(env, CUES);
    s.start(1500); // 1000 ms into A
    const a = created.find((x) => x.assetId === "A")!;
    expect(a.playing).toBe(true);
    expect(a.currentTime).toBeCloseTo(1.0, 6);
    expect(created.find((x) => x.assetId === "B")!.plays).toBe(0); // armed, not yet playing
  });

  it("E: seeking into a gap plays no take, then the next take starts on time", () => {
    const { env, created, advance } = makeEnv();
    const s = new PerformanceAudioScheduler(env, CUES);
    s.start(2600); // in the 2500–2800 gap
    expect(live(created)).toHaveLength(0);
    expect(created.map((a) => a.assetId)).toEqual(["B"]); // A is past, never created
    advance(199);
    expect(live(created)).toHaveLength(0);
    advance(1);
    expect(live(created).map((a) => a.assetId)).toEqual(["B"]);
  });

  it("F/G: pause stops audio; resume uses the playhead, not zero", () => {
    const { env, created, advance } = makeEnv();
    const s = new PerformanceAudioScheduler(env, CUES);
    s.start(0);
    advance(1500); // playhead 1500 → 1000 ms into A
    expect(live(created)).toHaveLength(1);
    s.stop(); // pause
    expect(live(created)).toHaveLength(0);
    expect(s.activeCount).toBe(0);
    advance(5000); // nothing pending may fire while paused
    expect(created.reduce((n, a) => n + a.plays, 0)).toBe(1);
    s.start(1500); // resume at the playhead
    const resumed = created.filter((a) => a.assetId === "A").pop()!;
    expect(created.filter((a) => a.assetId === "A")).toHaveLength(2); // old one released, new one resumed
    expect(resumed.currentTime).toBeCloseTo(1.0, 6);
    expect(resumed.playing).toBe(true);
  });

  it("H: stopping at the timeline end silences everything and cancels pending starts", () => {
    const { env, created, advance, pending } = makeEnv();
    const s = new PerformanceAudioScheduler(env, CUES);
    s.start(0);
    advance(3000);
    s.stop(); // what the panel does at durationMs
    expect(live(created)).toHaveLength(0);
    expect(pending()).toBe(0);
    expect(created.every((a) => a.released)).toBe(true);
  });

  it("starting past every take creates nothing", () => {
    const { env, created } = makeEnv();
    const s = new PerformanceAudioScheduler(env, CUES);
    s.start(4300);
    expect(created).toHaveLength(0);
  });

  it("I: repeated scrubbing never leaves overlapping audio or stray timers", () => {
    const { env, created, advance, pending } = makeEnv();
    const s = new PerformanceAudioScheduler(env, CUES);
    for (const t of [0, 800, 1200, 1900, 600, 2600, 100, 2000]) {
      s.start(t);
      expect(s.activeCount).toBeLessThanOrEqual(CUES.length);
      expect(live(created).length).toBeLessThanOrEqual(1);
    }
    s.start(2000); // final seek into A
    advance(10_000);
    expect(live(created).filter((a) => a.assetId === "A")).toHaveLength(1);
    // every superseded element was paused and released
    const stale = created.slice(0, created.length - s.activeCount);
    expect(stale.every((a) => !a.playing && a.released)).toBe(true);
    s.stop();
    expect(pending()).toBe(0);
  });

  it("J: dispose (editor unmount) stops audio, releases elements, clears timers and refuses to restart", () => {
    const { env, created, advance, pending } = makeEnv();
    const s = new PerformanceAudioScheduler(env, CUES);
    s.start(1500);
    expect(live(created)).toHaveLength(1);
    expect(pending()).toBe(1);
    s.dispose();
    expect(live(created)).toHaveLength(0);
    expect(created.every((a) => a.released)).toBe(true);
    expect(pending()).toBe(0);
    advance(10_000);
    expect(created.reduce((n, a) => n + a.plays, 0)).toBe(1);
    s.start(0); // a late tick after unmount must not resurrect audio
    expect(created).toHaveLength(2);
  });
});
