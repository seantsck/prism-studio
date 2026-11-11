import { describe, expect, it } from "vitest";
import type { EditItem, EditTitleCard, EpisodeEdit, VisualSource } from "../model";
import { maxDissolveMs } from "../model";
import { buildPlaybackPlan, dissolveMix, itemAt, outgoingAt, titleAt } from "../playback";
import { editTimeline, segmentAt, transitionViolations } from "../timeline";

/** Phase 5B-V3: THE canonical timeline math (titles, trims, holds, dissolve overlaps) and what reads it. */

const rate = { num: 24, den: 1 };
const video = (ms: number, inMs = 0): VisualSource => ({
  kind: "video",
  attemptId: "att",
  assetId: "asset",
  sourceInMs: inMs,
  sourceOutMs: inMs + ms,
});
const still = (ms: number): VisualSource => ({
  kind: "production_frame",
  productionFrameId: "pf",
  durationMs: ms,
});
const item = (id: string, visual: VisualSource, dissolveFrom?: [string, number]): EditItem => ({
  id,
  shotId: `shot-${id}`,
  visual,
  sourceAudio: "muted",
  performance: [],
  performanceBasis: null,
  incomingTransition: dissolveFrom
    ? { kind: "dissolve", fromItemId: dissolveFrom[0], durationMs: dissolveFrom[1] }
    : null,
});
const title = (placement: "opening" | "closing", durationMs: number): EditTitleCard => ({
  id: `00000000-0000-4000-8000-00000000000${placement === "opening" ? 1 : 2}`,
  placement,
  title: "お嬢様、僕と結婚してください。",
  subtitle: "Episode 1 — The Arrangement",
  durationMs,
  style: "film",
});
const edit = (items: EditItem[], titles: EditTitleCard[] = []): EpisodeEdit => ({
  id: "edit",
  projectId: "p",
  episodeId: "e",
  editRate: rate,
  revision: 3,
  items,
  titles,
});

describe("5B-V3 canonical timeline", () => {
  it("Clip A 5.0 s → cross dissolve 0.5 s → Clip B 4.0 s = 8.5 s (not 9.0 s)", () => {
    const t = editTimeline(edit([item("a", video(5000)), item("b", video(4000), ["a", 500])]));
    expect(t.totalMs).toBe(8500);
    expect(t.overlapMs).toBe(500);
    expect(t.items.map((i) => [i.startMs, i.endMs])).toEqual([
      [0, 5000],
      [4500, 8500],
    ]);
    expect(t.items[0]!.transitionOutMs).toBe(500);
    expect(t.items[1]!.transitionInMs).toBe(500);
  });

  it("a cut joins items back to back; trims and holds are the item durations", () => {
    const t = editTimeline(
      edit([item("a", video(3000, 1200)), item("b", still(2500)), item("c", video(1000))]),
    );
    expect(t.items.map((i) => [i.startMs, i.durationMs])).toEqual([
      [0, 3000],
      [3000, 2500],
      [5500, 1000],
    ]);
    expect(t.totalMs).toBe(6500);
  });

  it("titles contribute their duration: opening before the first item, closing after the last", () => {
    const t = editTimeline(
      edit(
        [item("a", video(5000)), item("b", video(4000), ["a", 500])],
        [title("opening", 4000), title("closing", 3000)],
      ),
    );
    expect(t.segments.map((s) => (s.kind === "title" ? s.placement : s.item.id))).toEqual([
      "opening",
      "a",
      "b",
      "closing",
    ]);
    expect(t.titles[0]).toMatchObject({ startMs: 0, endMs: 4000 });
    expect(t.items[0]!.startMs).toBe(4000);
    expect(t.items[1]!.startMs).toBe(8500);
    expect(t.titles[1]).toMatchObject({ startMs: 12_500, endMs: 15_500 });
    expect(t.totalMs).toBe(4000 + 8500 + 3000);
    expect(t.totalFrames).toBe(Math.floor((15_500 * 24) / 1000));
  });

  it("a stale dissolve (another item is now before it) is a cut on the timeline", () => {
    const t = editTimeline(edit([item("x", video(5000)), item("b", video(4000), ["a", 500])]));
    expect(t.totalMs).toBe(9000);
    expect(t.items[1]!.transitionInMs).toBe(0);
  });

  it("transition rules: at most half of the shorter neighbour (capped at 2 s), at least 0.1 s, never on the first item", () => {
    expect(maxDissolveMs(1000, 1000)).toBe(500); // a 3 s dissolve between two 1 s clips is refused
    expect(maxDissolveMs(10_000, 9000)).toBe(2000);
    expect(transitionViolations([item("a", video(1000)), item("b", video(1000), ["a", 3000])])).toEqual([
      { code: "transition_too_long", itemId: "b", maxMs: 500 },
    ]);
    expect(transitionViolations([item("a", video(1000)), item("b", video(1000), ["a", 500])])).toEqual([]);
    expect(
      transitionViolations([item("a", video(5000)), item("b", video(5000), ["a", 50])])[0],
    ).toMatchObject({
      code: "transition_too_short",
    });
    expect(transitionViolations([item("a", video(5000), ["z", 500])])[0]).toMatchObject({
      code: "transition_on_first",
    });
    expect(
      transitionViolations([item("x", video(5000)), item("b", video(5000), ["a", 500])])[0],
    ).toMatchObject({
      code: "transition_stale",
    });
    // an item dissolving on both sides is never more than consumed
    const both = [
      item("a", video(1000)),
      item("b", video(1000), ["a", 500]),
      item("c", video(1000), ["b", 500]),
    ];
    expect(transitionViolations(both)).toEqual([]);
    expect(editTimeline(edit(both)).totalMs).toBe(2000);
  });

  it("segmentAt / playback: the incoming item wins an overlap, the outgoing one shows under it, mixed linearly", () => {
    const e = edit([item("a", video(5000)), item("b", still(4000), ["a", 1000])], [title("opening", 2000)]);
    const t = editTimeline(e);
    expect(segmentAt(t, 1000)).toMatchObject({ kind: "title", placement: "opening" });
    expect(segmentAt(t, 2000)).toMatchObject({ kind: "item", index: 0 });
    expect(segmentAt(t, 6500)).toMatchObject({ kind: "item", index: 1 });
    const plan = buildPlaybackPlan(e, { pictureUrl: () => "/api/assets/x", takeUrl: () => null });
    expect(plan.totalMs).toBe(t.totalMs);
    expect(titleAt(plan, 500)?.placement).toBe("opening");
    expect(itemAt(plan, 500)).toBeNull(); // a title, no item
    expect(itemAt(plan, 6000)?.itemId).toBe("b"); // inside the dissolve (b starts at 6000)
    expect(outgoingAt(plan, 6000)?.itemId).toBe("a");
    expect(dissolveMix(itemAt(plan, 6500)!, 6500)).toBeCloseTo(0.5);
    expect(outgoingAt(plan, 7000)).toBeNull(); // a ended at 7000
    expect(dissolveMix(itemAt(plan, 7500)!, 7500)).toBe(1);
    expect(itemAt(plan, 5999)?.itemId).toBe("a");
  });
});
