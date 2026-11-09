import { describe, expect, it } from "vitest";
import type { EditItem, EpisodeEdit } from "@/domain/edit/model";
import { buildRenderManifest } from "@/domain/edit/render-manifest";
import type { ProjectData } from "@/domain/schemas";
import { renderFileName } from "../filename";
import {
  buildRenderPlan,
  MAX_AUDIO_SOURCES_PER_PIECE,
  MAX_PICTURE_SOURCES_PER_PIECE,
  missingMedia,
  pictureSourcesOf,
  RenderPlanError,
} from "../plan";
import { deliveryProfile, parseAspectRatio } from "../profile";

/** Phase 5B-V4: the pure render plan (manifest → bounded pieces), its timing math and its cache identity. */

const sum = (c: string) => c.padEnd(64, "0");
const data = (over: Partial<Record<string, string>> = {}) =>
  ({
    assets: [
      { id: "clip", checksum: sum(over.clip ?? "a1"), mime: "video/webm", objectPath: "p/clip/clip.webm" },
      { id: "img", checksum: sum("b2"), mime: "image/png", objectPath: "p/img/img.png" },
      { id: "tone", checksum: sum("c3"), mime: "audio/wav", objectPath: "p/tone/tone.wav" },
    ],
    productionFrames: [{ id: "pf", assetId: "img" }],
    frames: [],
    shots: [
      { id: "s1", shotCode: "3A" },
      { id: "s2", shotCode: "3B" },
      { id: "s3", shotCode: "3C" },
      { id: "s4", shotCode: "3D" },
    ],
    takes: [{ id: "t1", audioAssetId: "tone" }],
    bible: { aspectRatio: "2.39:1", deliveryWidth: null, deliveryHeight: null },
  }) as unknown as ProjectData;
const video = (
  id: string,
  shotId: string,
  inMs: number,
  outMs: number,
  extra: Partial<EditItem> = {},
): EditItem => ({
  id,
  shotId,
  visual: { kind: "video", attemptId: "att", assetId: "clip", sourceInMs: inMs, sourceOutMs: outMs },
  sourceAudio: "muted",
  performance: [],
  performanceBasis: null,
  ...extra,
});
const still = (id: string, shotId: string, ms: number, extra: Partial<EditItem> = {}): EditItem => ({
  id,
  shotId,
  visual: { kind: "production_frame", productionFrameId: "pf", durationMs: ms },
  sourceAudio: "muted",
  performance: [],
  performanceBasis: null,
  ...extra,
});
const edit = (items: EditItem[], titles: EpisodeEdit["titles"] = []): EpisodeEdit => ({
  id: "e",
  projectId: "p",
  episodeId: "ep",
  editRate: { num: 24, den: 1 },
  revision: 4,
  items,
  titles,
});
const OPENING = {
  id: "00000000-0000-4000-8000-000000000001",
  placement: "opening" as const,
  title: "お嬢様、僕と結婚してください。",
  subtitle: "Episode 1 — The Arrangement",
  durationMs: 4000,
  style: "film" as const,
};
const ojou = () =>
  edit(
    [
      video("i1", "s1", 500, 4500, {
        performance: [{ dialogueLineId: "l1", takeId: "t1", startMs: 800, takeInMs: 0, takeOutMs: 2800 }],
      }),
      still("i3", "s3", 4500),
      video("i2", "s2", 600, 4600, {
        incomingTransition: { kind: "dissolve", durationMs: 750, fromItemId: "i3" },
      }),
    ],
    [OPENING],
  );
const fonts = {
  film: { family: "Noto Serif JP", checksum: sum("f") },
  plain: { family: "Noto Sans JP", checksum: sum("g") },
};

describe("5B-V4 delivery profile", () => {
  it("Ojou-sama: 2.39:1 at 24/1 → 1920×804 H.264 yuv420p, AAC 48 kHz; the Bible's delivery size wins when set", () => {
    const m = buildRenderManifest(data(), ojou());
    const p = deliveryProfile(m.target);
    expect(p.canvas).toEqual({ width: 1920, height: 804 });
    expect(p.fps).toEqual({ num: 24, den: 1 });
    expect(p.video).toMatchObject({ codec: "h264", pixFmt: "yuv420p", gopFrames: 48 });
    expect(p.audio).toMatchObject({ codec: "aac", sampleRate: 48000, channels: 2 });
    expect(deliveryProfile({ ...m.target, width: 2048, height: 858 }).canvas).toEqual({
      width: 2048,
      height: 858,
    });
    expect(parseAspectRatio("16:9")).toBeCloseTo(16 / 9);
    expect(renderFileName("ojousama", { number: 1, title: "The Arrangement" })).toBe(
      "ojousama-episode-1-the-arrangement.mp4",
    );
    expect(renderFileName("my/../proj", { number: 2, title: "Ça va? <x>" })).toBe(
      "my-proj-episode-2-ca-va-x.mp4",
    );
  });
});

describe("5B-V4 render plan", () => {
  it("10. pieces cover the canonical timeline exactly: title, bodies, ONE transition per dissolve; frames telescope", () => {
    const m = buildRenderManifest(data(), ojou());
    const plan = buildRenderPlan(m, deliveryProfile(m.target), fonts);
    // title 4 s | 3A 4.0 s | 3C 4.5 s − 0.75 | dissolve 0.75 | 3B 4.0 s − 0.75
    expect(plan.pieces.map((p) => [p.kind, p.frames])).toEqual([
      ["title", 96],
      ["body", 96],
      ["body", 90],
      ["transition", 18],
      ["body", 78],
    ]);
    expect(plan.totalFrames).toBe(m.totalFrames);
    expect(plan.totalFrames).toBe(((4000 + 4000 + 4500 + 4000 - 750) * 24) / 1000);
    expect(plan.totalSamples).toBe((plan.totalFrames / 24) * 48000);
    expect(plan.dissolveMs).toBe(750);
    // contiguous, in order
    plan.pieces.forEach(
      (p, i) => i && expect(p.startFrame).toBe(plan.pieces[i - 1]!.startFrame + plan.pieces[i - 1]!.frames),
    );
    // 4. trims: the 3A body starts at its source in point; the 3B body starts 0.75 s into its trim (after the dissolve)
    const [, a, , t, b] = plan.pieces;
    expect(a!.kind === "body" && a!.picture.sourceStartMs).toBe(500);
    expect(t!.kind === "transition" && [t!.from.kind, t!.from.sourceStartMs, t!.to.sourceStartMs]).toEqual([
      "still",
      0,
      600,
    ]);
    expect(b!.kind === "body" && b!.picture.sourceStartMs).toBe(600 + 750);
  });

  it("12. audio: a placed take sounds at its manifest position (3A start + 0.8 s), trimmed to the pieces it spans", () => {
    const m = buildRenderManifest(data(), ojou());
    const plan = buildRenderPlan(m, deliveryProfile(m.target), fonts);
    expect(plan.hasAudio).toBe(true);
    const a = plan.pieces[1]!;
    expect(a.audio).toEqual([
      expect.objectContaining({
        kind: "take",
        assetId: "tone",
        offsetMs: 800,
        sourceStartMs: 0,
        durationMs: 2800,
      }),
    ]);
    // no other piece carries it
    expect(plan.pieces.filter((p) => p.audio.length).length).toBe(1);
    // video-only when nothing sounds anywhere
    const silent = buildRenderManifest(data(), edit([video("i1", "s1", 0, 2000), still("i3", "s3", 1000)]));
    expect(buildRenderPlan(silent, deliveryProfile(silent.target)).hasAudio).toBe(false);
  });

  it("1. a final render refuses missing media, naming the Shots", () => {
    const m = buildRenderManifest(
      data(),
      edit([
        video("i1", "s1", 0, 2000),
        { ...still("i4", "s4", 1000), visual: { kind: "none", durationMs: 1000 } },
      ]),
    );
    expect(missingMedia(m)).toEqual([{ itemId: "i4", shotCode: "3D" }]);
    expect(() => buildRenderPlan(m, deliveryProfile(m.target))).toThrow(
      new RenderPlanError("missing_media", "Episode contains 1 item with missing media: 3D.", ["3D"]),
    );
  });

  it("16 / 18. segment identity is deterministic, independent of position, and changes with any source, parameter or font", () => {
    const m = buildRenderManifest(data(), ojou());
    const p = deliveryProfile(m.target);
    const keys = (x: ReturnType<typeof buildRenderPlan>) => x.pieces.map((y) => y.cacheKey);
    expect(keys(buildRenderPlan(m, p, fonts))).toEqual(
      keys(buildRenderPlan(buildRenderManifest(data(), ojou()), p, fonts)),
    );
    expect(new Set(keys(buildRenderPlan(m, p, fonts))).size).toBe(5);
    // a changed source checksum → every piece using it gets a new key; the others keep theirs
    const changed = buildRenderPlan(buildRenderManifest(data({ clip: "zz" }), ojou()), p, fonts);
    const [title, a, c, t, b] = keys(changed);
    const base = keys(buildRenderPlan(m, p, fonts));
    expect([title === base[0], a === base[1], c === base[2], t === base[3], b === base[4]]).toEqual([
      true,
      false,
      true,
      false,
      false,
    ]);
    // another profile (preset), or another font, never reuses
    expect(keys(buildRenderPlan(m, deliveryProfile(m.target, { preset: "ultrafast" }), fonts))[1]).not.toBe(
      base[1],
    );
    expect(
      keys(buildRenderPlan(m, p, { ...fonts, film: { family: "Noto Serif CJK", checksum: sum("h") } }))[0],
    ).not.toBe(base[0]);
    // moving a piece on the timeline keeps its identity (a longer title shifts everything after it)
    const later = buildRenderManifest(data(), { ...ojou(), titles: [{ ...OPENING, durationMs: 5000 }] });
    expect(keys(buildRenderPlan(later, p, fonts)).slice(1)).toEqual(base.slice(1));
  });

  it("15. bounded rendering: no piece opens more than 2 pictures; a 60-item Episode is 60+ small pieces, never one graph", () => {
    const items: EditItem[] = [];
    for (let i = 0; i < 60; i++)
      items.push(
        i % 3 === 0
          ? still(`i${i}`, "s3", 2000)
          : video(
              `i${i}`,
              "s1",
              0,
              2000,
              i % 2
                ? { incomingTransition: { kind: "dissolve", durationMs: 500, fromItemId: `i${i - 1}` } }
                : {},
            ),
      );
    const m = buildRenderManifest(data(), edit(items, [OPENING]));
    const plan = buildRenderPlan(m, deliveryProfile(m.target), fonts);
    expect(plan.pieces.length).toBeGreaterThan(60);
    for (const piece of plan.pieces) {
      expect(pictureSourcesOf(piece).length).toBeLessThanOrEqual(MAX_PICTURE_SOURCES_PER_PIECE);
      expect(piece.audio.length).toBeLessThanOrEqual(MAX_AUDIO_SOURCES_PER_PIECE);
    }
    expect(plan.totalFrames).toBe(m.totalFrames);
  });
});
