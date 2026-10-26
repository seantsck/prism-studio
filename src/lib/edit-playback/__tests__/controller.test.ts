import { beforeEach, describe, expect, it } from "vitest";
import type { EpisodeEdit } from "@/domain/edit/model";
import {
  buildPlaybackPlan,
  itemAt,
  placementSourceMs,
  placementsAt,
  playheadLabel,
  videoSourceMs,
  type PlaybackPlan,
} from "@/domain/edit/playback";
import { DRIFT_MS, RoughCutController, type MediaPort, type PlaybackSnapshot } from "../controller";

/**
 * Phase 2I.1E: the pure playback timeline and the rough-cut controller, with a deterministic clock and fake media
 * (no browser media, no sleeps). The edit below:
 *   A  video   source 0.5 s → 2.5 s (2000 ms)   placement L1 at +300 ms, take 0.2 s → 1.2 s
 *   B  storyboard still, hold 1500 ms         (no placement: explicit silence)
 *   C  none, 1000 ms                          placement L2 at 0, take 0 → 800 ms (audio over no picture)
 *   D  video   source 0 → 1 s, clip audio included; two placements (L3 at 0, L4 at 500)
 * total 5500 ms.
 */

const edit: EpisodeEdit = {
  id: "edit-1",
  projectId: "p",
  episodeId: "e",
  editRate: { num: 24, den: 1 },
  revision: 7,
  items: [
    {
      id: "A",
      shotId: "sA",
      visual: { kind: "video", attemptId: "at1", assetId: "vA", sourceInMs: 500, sourceOutMs: 2500 },
      sourceAudio: "muted",
      performance: [{ dialogueLineId: "L1", takeId: "t1", startMs: 300, takeInMs: 200, takeOutMs: 1200 }],
      performanceBasis: null,
    },
    {
      id: "B",
      shotId: "sB",
      visual: { kind: "storyboard_frame", storyboardFrameId: "f1", durationMs: 1500 },
      sourceAudio: "muted",
      performance: [],
      performanceBasis: null,
    },
    {
      id: "C",
      shotId: "sC",
      visual: { kind: "none", durationMs: 1000 },
      sourceAudio: "muted",
      performance: [{ dialogueLineId: "L2", takeId: "t2", startMs: 0, takeInMs: 0, takeOutMs: 800 }],
      performanceBasis: null,
    },
    {
      id: "D",
      shotId: "sD",
      visual: { kind: "video", attemptId: "at2", assetId: "vD", sourceInMs: 0, sourceOutMs: 1000 },
      sourceAudio: "included",
      performance: [
        { dialogueLineId: "L3", takeId: "t3", startMs: 0, takeInMs: 0, takeOutMs: 400 },
        { dialogueLineId: "L4", takeId: "t4", startMs: 500, takeInMs: 100, takeOutMs: 600 },
      ],
      performanceBasis: null,
    },
  ],
};
const urls: Record<string, string> = { vA: "/api/assets/vA", f1: "/api/assets/f1", vD: "/api/assets/vD" };
const media = {
  pictureUrl: (i: EpisodeEdit["items"][number]) =>
    i.visual.kind === "video"
      ? urls[i.visual.assetId]!
      : i.visual.kind === "storyboard_frame"
        ? urls[i.visual.storyboardFrameId]!
        : null,
  takeUrl: (takeId: string) => `/api/assets/take-${takeId}`,
};

describe("playback plan (pure)", () => {
  const plan = buildPlaybackPlan(edit, media);

  it("lays items back to back from 0 in integer ms; total is the sum", () => {
    expect(plan.items.map((i) => [i.itemId, i.startMs, i.endMs])).toEqual([
      ["A", 0, 2000],
      ["B", 2000, 3500],
      ["C", 3500, 4500],
      ["D", 4500, 5500],
    ]);
    expect(plan.totalMs).toBe(5500);
    expect(plan.revision).toBe(7);
  });

  it("current item: a boundary belongs to the next item; nothing at or after the end", () => {
    expect(itemAt(plan, 0)!.itemId).toBe("A");
    expect(itemAt(plan, 1999)!.itemId).toBe("A");
    expect(itemAt(plan, 2000)!.itemId).toBe("B");
    expect(itemAt(plan, 4499)!.itemId).toBe("C");
    expect(itemAt(plan, 4500)!.itemId).toBe("D");
    expect(itemAt(plan, 5500)).toBeNull();
  });

  it("maps timeline time into the video's trim and never outside it", () => {
    const a = plan.items[0]!;
    expect(videoSourceMs(a, 0)).toBe(500);
    expect(videoSourceMs(a, 1234)).toBe(1734);
    expect(videoSourceMs(a, 5000)).toBe(2500);
    expect(videoSourceMs(plan.items[1]!, 2500)).toBeNull(); // a still has no source time
  });

  it("places performance at item start + offset for take out − take in; maps into the take", () => {
    const [l1, l2, l3, l4] = plan.placements;
    expect([l1!.startMs, l1!.endMs]).toEqual([300, 1300]);
    expect([l2!.startMs, l2!.endMs]).toEqual([3500, 4300]); // under the no-picture item
    expect([l3!.startMs, l3!.endMs, l4!.startMs, l4!.endMs]).toEqual([4500, 4900, 5000, 5500]);
    expect(placementSourceMs(l1!, 300)).toBe(200);
    expect(placementSourceMs(l1!, 800)).toBe(700);
    expect(placementsAt(plan, 2500)).toEqual([]); // B: explicit silence
    expect(placementsAt(plan, 5100).map((p) => p.dialogueLineId)).toEqual(["L4"]);
  });

  it("carries the clip-audio policy and media addresses exactly as pinned", () => {
    expect(plan.items.map((i) => i.clipAudio)).toEqual([false, false, false, true]);
    expect(plan.items.map((i) => i.pictureUrl)).toEqual([
      "/api/assets/vA",
      "/api/assets/f1",
      null,
      "/api/assets/vD",
    ]);
  });

  it("derives frames from absolute positions at the edit rate", () => {
    expect(playheadLabel(plan, 2000)).toEqual({ frame: 48, timecode: "00:00:02:00" });
  });
});

class FakePort implements MediaPort {
  url: string | null = null;
  t = 0;
  playing = false;
  muted = true;
  seeks: number[] = [];
  disposed = false;
  rejectWith: string | null = null;
  private err: (() => void) | null = null;
  load(url: string | null) {
    this.url = url;
  }
  currentTimeMs() {
    return this.t;
  }
  seekMs(ms: number) {
    this.t = ms;
    this.seeks.push(ms);
  }
  play() {
    if (this.rejectWith) return Promise.reject(Object.assign(new Error("x"), { name: this.rejectWith }));
    this.playing = true;
    return Promise.resolve();
  }
  pause() {
    this.playing = false;
  }
  setMuted(m: boolean) {
    this.muted = m;
  }
  onError(cb: () => void) {
    this.err = cb;
  }
  fail() {
    this.err?.();
  }
  dispose() {
    this.disposed = true;
    this.playing = false;
  }
}

let now = 0;
let frames: Array<() => void> = [];
let video: FakePort;
let audios: FakePort[];
let last: PlaybackSnapshot | null;
let plan: PlaybackPlan;
const make = (p: PlaybackPlan = buildPlaybackPlan(edit, media)) => {
  plan = p;
  return new RoughCutController(
    p,
    {
      now: () => now,
      requestFrame: (cb) => frames.push(cb),
      cancelFrame: () => {
        frames = [];
      },
      video,
      createAudio: () => {
        const a = new FakePort();
        audios.push(a);
        return a;
      },
    },
    (s) => {
      last = s;
    },
  );
};
/** Advances the wall clock by `ms` in 20 ms frames, with the followed media playing in real time. */
const advance = (ms: number) => {
  for (let done = 0; done < ms; done += 20) {
    now += 20;
    if (video.playing) video.t += 20;
    for (const a of audios) if (a.playing) a.t += 20;
    const run = frames;
    frames = [];
    for (const f of run) f();
  }
};
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  now = 1000;
  frames = [];
  video = new FakePort();
  audios = [];
  last = null;
});

describe("rough-cut controller (one master clock)", () => {
  it("does nothing until play; then the clock advances and the first item is active", () => {
    const c = make();
    expect(c.snapshot()).toMatchObject({ playing: false, timeMs: 0 });
    expect(video.playing).toBe(false);
    c.play();
    expect(video.url).toBe("/api/assets/vA");
    expect(video.seeks.at(-1)).toBe(500); // starts at the persisted source in
    expect(video.muted).toBe(true); // clip audio muted
    advance(1000);
    expect(last!.timeMs).toBe(1000);
    expect(last!.item!.itemId).toBe("A");
    expect(last!.videoSourceMs).toBe(1500);
  });

  it("plays the placement from its take in at its offset, and only while it sounds", () => {
    const c = make();
    c.play();
    advance(280);
    expect(audios).toHaveLength(0);
    advance(40); // crosses 300 ms
    expect(audios).toHaveLength(1);
    expect(audios[0]!.url).toBe("/api/assets/take-t1");
    expect(audios[0]!.seeks[0]).toBe(200); // activated on the 300 ms frame: exactly its take in
    advance(1000); // past 1300 ms: the placement ended
    expect(audios[0]!.disposed).toBe(true);
  });

  it("switches deterministically at the trim's end: the video stops, the still holds, no take plays (silence)", () => {
    const c = make();
    c.play();
    advance(2000);
    expect(last!.item!.itemId).toBe("B");
    expect(video.playing).toBe(false);
    expect(last!.placements).toEqual([]);
    advance(1480);
    expect(last!.item!.itemId).toBe("B"); // held for its full 1500 ms
    advance(40);
    expect(last!.item!.itemId).toBe("C");
  });

  it("plays a no-picture interval (not skipped) with its performance", () => {
    const c = make();
    c.seek(3600);
    expect(c.snapshot().item!.kind).toBe("none");
    expect(c.snapshot().placements).toEqual([{ key: "C:L2", sourceMs: 100, audible: true }]);
  });

  it("handles several placements of one item independently and includes the clip's own audio when chosen", () => {
    const c = make();
    c.seek(4600);
    c.play();
    expect(video.url).toBe("/api/assets/vD");
    expect(video.muted).toBe(false); // included
    expect(audios.map((a) => a.url)).toEqual(["/api/assets/take-t3"]);
    advance(500); // 5100: L3 ended, L4 sounding
    expect(last!.placements.map((p) => p.key)).toEqual(["D:L4"]);
    expect(audios.find((a) => a.url === "/api/assets/take-t4")!.playing).toBe(true);
    expect(audios.find((a) => a.url === "/api/assets/take-t3")!.disposed).toBe(true);
  });

  it("seek reconstructs picture and audio; while paused nothing plays, while playing it continues", () => {
    const c = make();
    c.seek(800);
    expect(video.seeks.at(-1)).toBe(1300);
    expect(audios[0]!.seeks.at(-1)).toBe(700); // take in 200 + 500 elapsed
    expect(video.playing).toBe(false);
    expect(audios[0]!.playing).toBe(false);
    c.play();
    c.seek(1200);
    expect(c.snapshot().playing).toBe(true);
    expect(video.seeks.at(-1)).toBe(1700);
    expect(video.playing).toBe(true);
  });

  it("pause freezes the clock; restart returns to 0; the end stops playback", () => {
    const c = make();
    c.play();
    advance(600);
    c.pause();
    const t = c.snapshot().timeMs;
    advance(1000);
    expect(c.snapshot().timeMs).toBe(t);
    expect(video.playing).toBe(false);
    c.restart();
    expect(c.snapshot()).toMatchObject({ timeMs: 0, playing: false });
    c.play();
    advance(6000);
    expect(last).toMatchObject({ timeMs: 5500, playing: false, ended: true, item: null });
    expect(audios.every((a) => !a.playing)).toBe(true);
    c.seek(5500);
    expect(c.snapshot()).toMatchObject({ ended: true, playing: false });
    c.play(); // from the end: starts over
    expect(c.snapshot().timeMs).toBe(0);
  });

  it("re-seeks a following element only when it drifts beyond the tolerance", () => {
    const c = make();
    c.play();
    advance(200);
    const seeks = video.seeks.length;
    video.t += DRIFT_MS - 10; // within tolerance
    advance(20);
    expect(video.seeks.length).toBe(seeks);
    video.t += DRIFT_MS * 2; // drifted
    advance(20);
    expect(video.seeks.length).toBe(seeks + 1);
    expect(video.seeks.at(-1)).toBe(videoSourceMs(plan.items[0]!, last!.timeMs));
  });

  it("an unavailable picture or take keeps the interval playing, reported, never substituted", async () => {
    const c = make();
    c.play();
    video.fail();
    expect(last!.failedPictures.has("A")).toBe(true);
    advance(400);
    audios[0]!.fail();
    expect(last!.failedTakes.has("A:L1")).toBe(true);
    advance(1000);
    expect(last!.timeMs).toBe(1400);
    expect(last!.item!.itemId).toBe("A");
    expect(audios).toHaveLength(1); // the failed take is not retried or replaced
    await flush();
  });

  it("a browser refusal to start media is reported; the clock still runs", async () => {
    video.rejectWith = "NotAllowedError";
    const c = make();
    c.play();
    await flush();
    expect(last!.mediaBlocked).toBe(true);
    advance(100);
    expect(last!.timeMs).toBe(100);
  });

  it("dispose stops and releases everything (an edit change rebuilds the player)", () => {
    const c = make();
    c.seek(400);
    c.play();
    c.dispose();
    expect(video.url).toBeNull();
    expect(audios.every((a) => a.disposed)).toBe(true);
    advance(500);
    c.play();
    expect(frames).toEqual([]);
  });

  it("a plan with no items never plays", () => {
    const c = make(buildPlaybackPlan({ ...edit, items: [] }, media));
    c.play();
    expect(c.snapshot()).toMatchObject({ playing: false, timeMs: 0, ended: true });
  });
});
