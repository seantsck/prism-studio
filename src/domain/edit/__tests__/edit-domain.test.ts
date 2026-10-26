import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { seed, shotByCode } from "@/domain/__tests__/helpers";
import { attach, draftFor, newUploadAsset } from "@/domain/__tests__/production-frame-fixtures";
import { buildShotContext } from "@/domain/context";
import { computeShotParts } from "@/domain/fingerprint";
import type { ProductionFrame } from "@/domain/production-frame";
import {
  generationAttemptSchema,
  type Asset,
  type GenerationAttempt,
  type ProjectData,
} from "@/domain/schemas";
import { selectTake } from "@/domain/takes";
import {
  EDIT_RATES,
  editRateFromFps,
  frameAtMs,
  frameTimecode,
  msAtFrame,
  type EditRate,
} from "../edit-rate";
import { videoSourceViolations, type AttemptMediaFacts, type EditMediaFacts } from "../eligibility";
import {
  editShapeViolations,
  itemDurationMs,
  type EditItem,
  type EpisodeEdit,
  type VisualSource,
} from "../model";
import { proposeEpisodeAssembly, proposeShotItem } from "../proposal";
import { buildEpisodeEditView, editItemLineage, editTiming, sceneRuns } from "../view";

// ───────────────────────── fixtures (pure data; no repository, no provider) ─────────────────────────

let n = 0;
function videoAsset(data: ProjectData, durationMs: number | null, o: { projectId?: string } = {}): Asset {
  const base = newUploadAsset(o.projectId ?? data.project.id, { label: `clip-${++n}` });
  const asset: Asset = {
    ...base,
    type: "video",
    purpose: "generation_output",
    mime: "video/mp4",
    durationMs,
  };
  data.assets.push(asset);
  return asset;
}

function addAttempt(
  data: ProjectData,
  code: string,
  o: {
    purpose?: string | null;
    approved?: boolean;
    status?: GenerationAttempt["status"];
    packageSnapshot?: Record<string, unknown>;
    request?: Record<string, unknown>;
  } = {},
): GenerationAttempt {
  const shotId = shotByCode(data, code).id;
  if (o.approved) for (const a of data.attempts) if (a.shotId === shotId) a.approved = false;
  const attempt = generationAttemptSchema.parse({
    id: randomUUID(),
    projectId: data.project.id,
    shotId,
    attemptNumber: 100 + ++n,
    provider: "mock",
    model: "mock-video-1",
    modality: "video",
    prompt: "",
    negativePrompt: "",
    packageSnapshot: o.packageSnapshot ?? {},
    packageFingerprint: `fp-${n}`,
    modelSettings: {},
    inputAssetIds: [],
    outputAssetId: null,
    costUsd: 0,
    durationMs: null,
    status: o.status ?? "succeeded",
    reviewStatus: o.approved ? "approved" : "unreviewed",
    rejectionReason: "",
    notes: "",
    approved: o.approved ?? false,
    request: o.purpose === null ? null : { purpose: o.purpose ?? "shot_output", ...o.request },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  });
  data.attempts.push(attempt);
  return attempt;
}

/** A clip: an attempt, its primary output and (optionally) a delivery version selected as master. */
function clip(
  data: ProjectData,
  media: Map<string, AttemptMediaFacts>,
  code: string,
  durationMs: number,
  o: Parameters<typeof addAttempt>[2] & { deliveryMs?: number } = {},
) {
  const attempt = addAttempt(data, code, o);
  const primary = videoAsset(data, durationMs);
  const delivery = o.deliveryMs !== undefined ? videoAsset(data, o.deliveryMs) : null;
  media.set(attempt.id, {
    attemptId: attempt.id,
    outputs: [{ assetId: primary.id, role: "primary" }],
    deliveryVersions: delivery ? [{ assetId: delivery.id, parentAssetId: primary.id, version: 1 }] : [],
    deliveryAssetId: delivery?.id ?? null,
  });
  return { attempt, primary, delivery };
}

const facts = (
  attempts: Map<string, AttemptMediaFacts>,
  bestPointers: EditMediaFacts["bestPointers"] = [],
) => ({
  attempts,
  bestPointers,
});

const episodeId = (data: ProjectData) => data.episodes[0].id;

/** Persists a proposal the way 2I.1B will: ids assigned, nothing else changed. */
function editFrom(data: ProjectData, media: EditMediaFacts): EpisodeEdit {
  const p = proposeEpisodeAssembly(data, episodeId(data), media);
  return {
    id: randomUUID(),
    projectId: data.project.id,
    episodeId: p.episodeId,
    editRate: p.editRate,
    revision: 0,
    items: p.items.map((i) => ({
      id: randomUUID(),
      shotId: i.shotId,
      visual: i.visual,
      sourceAudio: i.sourceAudio,
      performance: i.performance,
      performanceBasis: i.performanceBasis,
    })),
  };
}

const item = (shotId: string, visual: VisualSource, o: Partial<EditItem> = {}): EditItem => ({
  id: randomUUID(),
  shotId,
  visual,
  sourceAudio: "muted",
  performance: [],
  performanceBasis: null,
  ...o,
});

const itemOf = (edit: EpisodeEdit, data: ProjectData, code: string) =>
  edit.items.find((i) => i.shotId === shotByCode(data, code).id)!;

// ───────────────────────── eligibility ─────────────────────────

describe("video source eligibility", () => {
  it("a Production Frame candidate attempt can never be a video source, even with a video Asset", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    const { attempt, primary } = clip(data, media, "3A", 5000, { purpose: "production_frame" });
    const v = {
      kind: "video" as const,
      attemptId: attempt.id,
      assetId: primary.id,
      sourceInMs: 0,
      sourceOutMs: 4000,
    };
    expect(videoSourceViolations(data, attempt.shotId, v, facts(media))).toEqual(["not_shot_output"]);
  });

  it("Shot-output purposes are eligible: shot_output, animate_production_frame, and history with no purpose", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    for (const purpose of ["shot_output", "animate_production_frame", null]) {
      const { attempt, primary } = clip(data, media, "3A", 5000, { purpose });
      const v = {
        kind: "video" as const,
        attemptId: attempt.id,
        assetId: primary.id,
        sourceInMs: 0,
        sourceOutMs: 5000,
      };
      expect(videoSourceViolations(data, attempt.shotId, v, facts(media))).toEqual([]);
    }
  });

  it("checks the exact attempt / Asset / Shot / project ownership, the status and the trim", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    const { attempt, primary, delivery } = clip(data, media, "3A", 5000, { deliveryMs: 4500 });
    const other = clip(data, media, "3A", 5000);
    const shot3A = attempt.shotId;
    const v = (o: Partial<Extract<VisualSource, { kind: "video" }>>) => ({
      kind: "video" as const,
      attemptId: attempt.id,
      assetId: primary.id,
      sourceInMs: 0,
      sourceOutMs: 4000,
      ...o,
    });
    const check = (o: Parameters<typeof v>[0], shotId = shot3A) =>
      videoSourceViolations(data, shotId, v(o), facts(media));

    expect(check({})).toEqual([]);
    expect(check({ assetId: delivery!.id, sourceOutMs: 4500 })).toEqual([]); // a delivery version of the attempt
    expect(check({}, shotByCode(data, "3A").id === shot3A ? shotByCode(data, "2B").id : shot3A)).toEqual([
      "wrong_shot",
    ]);
    expect(check({ assetId: other.primary.id })).toEqual(["asset_not_of_attempt"]); // another attempt's file
    expect(check({ attemptId: randomUUID() })).toEqual(["attempt_not_found"]);
    expect(check({ sourceInMs: 1000, sourceOutMs: 5001 })).toEqual(["range_outside_asset"]);
    expect(check({ sourceInMs: 3000, sourceOutMs: 3000 })).toEqual(["invalid_range"]);
    expect(check({ sourceInMs: 0.5, sourceOutMs: 3000 })).toEqual(["invalid_range"]);

    const foreign = videoAsset(data, 5000, { projectId: randomUUID() });
    media.get(attempt.id)!.outputs = [
      ...media.get(attempt.id)!.outputs,
      { assetId: foreign.id, role: "variant" },
    ];
    expect(check({ assetId: foreign.id })).toEqual(["wrong_project"]);

    const image = { ...newUploadAsset(data.project.id, { label: "still" }), durationMs: 5000 };
    data.assets.push(image);
    media.get(attempt.id)!.outputs = [
      ...media.get(attempt.id)!.outputs,
      { assetId: image.id, role: "variant" },
    ];
    expect(check({ assetId: image.id })).toEqual(["asset_not_video"]);

    const unknown = videoAsset(data, null);
    media.get(attempt.id)!.outputs = [
      ...media.get(attempt.id)!.outputs,
      { assetId: unknown.id, role: "variant" },
    ];
    expect(check({ assetId: unknown.id })).toEqual(["asset_duration_unknown"]);

    const failed = clip(data, media, "3A", 5000, { status: "failed" });
    expect(
      videoSourceViolations(
        data,
        shot3A,
        v({ attemptId: failed.attempt.id, assetId: failed.primary.id }),
        facts(media),
      ),
    ).toEqual(["not_succeeded"]);
  });
});

// ───────────────────────── timing ─────────────────────────

describe("timing: integer ms, contiguous, frames from absolute positions", () => {
  it("a short video item is exactly its chosen source interval; the next item follows it immediately", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    clip(data, media, "1A", 2500, { approved: true }); // 1A plans 4000 ms
    const proposed = proposeShotItem(data, shotByCode(data, "1A").id, facts(media));
    expect(proposed.visual).toMatchObject({ kind: "video", sourceInMs: 0, sourceOutMs: 2500 });
    expect(proposed.notes).toContainEqual({ code: "clip_shorter_than_planned", shortByMs: 1500 });

    const edit = editFrom(data, facts(media));
    const view = buildEpisodeEditView(data, edit, facts(media));
    const [first, second] = view.items;
    expect(first.timing).toMatchObject({ startMs: 0, endMs: 2500, durationMs: 2500 });
    expect(first.duration).toEqual({ itemMs: 2500, plannedMs: 4000, deltaMs: -1500 });
    expect(second.timing.startMs).toBe(2500); // no hold, no padding, no blank media
  });

  it("a longer clip is proposed trimmed to the planned duration (never extended)", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    clip(data, media, "1A", 9000, { approved: true });
    const p = proposeShotItem(data, shotByCode(data, "1A").id, facts(media));
    expect(p.visual).toMatchObject({ kind: "video", sourceInMs: 0, sourceOutMs: 4000 });
  });

  it("a placeholder still may hold for the Shot's planned duration, labelled as a placeholder", () => {
    const data = seed();
    const p = proposeShotItem(data, shotByCode(data, "1B").id, facts(new Map()));
    expect(p.visual).toEqual({
      kind: "storyboard_frame",
      storyboardFrameId: expect.any(String),
      durationMs: 3500,
    });
    expect(p.visualReason).toBe("placeholder_storyboard");
    const none = proposeShotItem(data, shotByCode(data, "2A").id, facts(new Map())); // no storyboard approved
    expect(none.visual).toEqual({ kind: "none", durationMs: 3000 });
    expect(none.visualReason).toBe("no_source");
  });

  it("starts are the exact integer sum of the item durations; the total is their sum", () => {
    const data = seed();
    const edit = editFrom(data, facts(new Map()));
    const view = buildEpisodeEditView(data, edit, facts(new Map()));
    let cursor = 0;
    for (const i of view.items) {
      expect(i.timing.startMs).toBe(cursor);
      expect(Number.isSafeInteger(i.timing.startMs)).toBe(true);
      cursor += itemDurationMs(i.item.visual);
    }
    expect(view.totalMs).toBe(cursor);
    expect(view.totalMs).toBe(
      4000 + 3500 + 4500 + 3000 + 3000 + 3500 + 4300 + 5100 + 4500 + 3500 + 6500 + 4700 + 6800 + 5000,
    );
  });

  it("frames come from absolute positions: no accumulated rounding at 24000/1001", () => {
    const rate: EditRate = { num: 24000, den: 1001 };
    const items = Array.from({ length: 1000 }, () => ({
      visual: { kind: "none" as const, durationMs: 1000 },
    }));
    const { timings, totalMs, totalFrames } = editTiming(items, rate);
    expect(totalMs).toBe(1_000_000);
    expect(totalFrames).toBe(23976); // floor(1,000,000 ms × 24000 / 1001000)
    // the per-item frame spans telescope to the same total ...
    expect(timings.reduce((s, t) => s + (t.endFrame - t.startFrame), 0)).toBe(23976);
    // ... whereas rounding each 1 s item to whole frames and adding them up would drift by 976 frames
    expect(1000 * Math.floor((1000 * 24000) / 1001000)).toBe(23000);
  });

  it.each([
    [{ num: 24, den: 1 }, 86400],
    [{ num: 24000, den: 1001 }, 86313],
    [{ num: 25, den: 1 }, 90000],
    [{ num: 30000, den: 1001 }, 107892],
    [{ num: 30, den: 1 }, 108000],
  ])("one hour at %o is %i frames; frame ↔ ms round-trips", (rate, frames) => {
    expect(EDIT_RATES).toContainEqual(rate);
    expect(frameAtMs(3_600_000, rate)).toBe(frames);
    for (const f of [0, 1, 2, 23, 24, 1001, 12345, frames])
      expect(frameAtMs(msAtFrame(f, rate), rate)).toBe(f);
  });

  it("the edit rate comes from the bible's decimal frame rate, NTSC as exact rationals", () => {
    expect(editRateFromFps(23.976)).toEqual({ rate: { num: 24000, den: 1001 }, exact: true });
    expect(editRateFromFps(29.97)).toEqual({ rate: { num: 30000, den: 1001 }, exact: true });
    expect(editRateFromFps(25)).toEqual({ rate: { num: 25, den: 1 }, exact: true });
    expect(editRateFromFps(60)).toEqual({ rate: { num: 24, den: 1 }, exact: false });
    expect(proposeEpisodeAssembly(seed(), seed().episodes[0].id, facts(new Map())).editRate).toEqual({
      num: 24,
      den: 1,
    });
    expect(frameTimecode(86313, { num: 24000, den: 1001 })).toBe("00:59:56:09");
  });

  it("frame positions refuse non-integer time (no floats enter the edit)", () => {
    expect(() => frameAtMs(1.5, { num: 24, den: 1 })).toThrow();
  });
});

// ───────────────────────── order and Scene runs ─────────────────────────

describe("order and Scene runs", () => {
  it("the proposal follows the Sequence Board order", () => {
    const data = seed();
    const p = proposeEpisodeAssembly(data, episodeId(data), facts(new Map()));
    expect(p.items.map((i) => data.shots.find((s) => s.id === i.shotId)!.shotCode)).toEqual([
      "1A",
      "1B",
      "1C",
      "2A",
      "2B",
      "2C",
      "2D",
      "2E",
      "3A",
      "4A",
      "4B",
      "4C",
      "5A",
      "6A",
    ]);
  });

  it("Scene A, A, B, A gives TWO runs of Scene A (an intercut is not assumed away)", () => {
    const data = seed();
    const shot = (c: string) => shotByCode(data, c);
    const edit: EpisodeEdit = {
      id: randomUUID(),
      projectId: data.project.id,
      episodeId: episodeId(data),
      editRate: { num: 24, den: 1 },
      revision: 0,
      items: ["1A", "1B", "2A", "1C"].map((c) => item(shot(c).id, { kind: "none", durationMs: 1000 })),
    };
    const view = buildEpisodeEditView(data, edit, facts(new Map()));
    expect(
      view.sceneRuns.map((r) => [r.sceneId, r.occurrence, r.firstIndex, r.lastIndex, r.startMs, r.endMs]),
    ).toEqual([
      [shot("1A").sceneId, 1, 0, 1, 0, 2000],
      [shot("2A").sceneId, 1, 2, 2, 2000, 3000],
      [shot("1C").sceneId, 2, 3, 3, 3000, 4000],
    ]);
    expect(
      sceneRuns(
        ["a", "b", "a", "a", "c", "a"],
        Array.from({ length: 6 }, (_, i) => ({ startMs: i, endMs: i + 1 })),
      ).map((r) => `${r.sceneId}${r.occurrence}`),
    ).toEqual(["a1", "b1", "a2", "c1", "a3"]);
  });

  it("a Sequence Board reorder is reported as divergence; the edit order does not change", () => {
    const data = seed();
    const edit = editFrom(data, facts(new Map()));
    const before = structuredClone(edit.items);
    expect(buildEpisodeEditView(data, edit, facts(new Map())).orderDiffersFromSequence).toBe(false);
    const a = shotByCode(data, "1A");
    const b = shotByCode(data, "1B");
    [a.order, b.order] = [b.order, a.order];
    const view = buildEpisodeEditView(data, edit, facts(new Map()));
    expect(view.orderDiffersFromSequence).toBe(true);
    expect(edit.items).toEqual(before);
    expect(view.items.map((i) => i.item.id)).toEqual(before.map((i) => i.id));
  });

  it("an Episode Shot that is not in the edit is reported, not inserted", () => {
    const data = seed();
    const edit = editFrom(data, facts(new Map()));
    edit.items = edit.items.filter((i) => i.shotId !== shotByCode(data, "4A").id);
    expect(buildEpisodeEditView(data, edit, facts(new Map())).notInEditShotIds).toEqual([
      shotByCode(data, "4A").id,
    ]);
  });
});

// ───────────────────────── proposal vs editorial decision ─────────────────────────

describe("the proposal recommends; the edit decides", () => {
  it("proposes the approved clip's delivery master, else its primary output; never Best; says why", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    const approved = clip(data, media, "3A", 6000, { approved: true, deliveryMs: 4400 });
    const best = clip(data, media, "3A", 6000);
    const p = proposeShotItem(
      data,
      approved.attempt.shotId,
      facts(media, [{ setId: "s1", shotId: approved.attempt.shotId, attemptId: best.attempt.id }]),
    );
    expect(p.visual).toEqual({
      kind: "video",
      attemptId: approved.attempt.id,
      assetId: approved.delivery!.id,
      sourceInMs: 0,
      sourceOutMs: 4400,
    });
    expect(p.visualReason).toBe("approved_clip_delivery_master");
    expect(p.notes).toContainEqual({ code: "best_not_followed", attemptId: best.attempt.id });

    const primaryOnly = clip(data, media, "1A", 6000, { approved: true });
    expect(proposeShotItem(data, primaryOnly.attempt.shotId, facts(media)).visual).toMatchObject({
      assetId: primaryOnly.primary.id,
      sourceOutMs: 4000,
    });
  });

  it("without an approved clip, a Best clip is NOT proposed: the placeholder is", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    const best = clip(data, media, "1A", 6000);
    const p = proposeShotItem(
      data,
      best.attempt.shotId,
      facts(media, [{ setId: "s", shotId: best.attempt.shotId, attemptId: best.attempt.id }]),
    );
    expect(p.visual.kind).toBe("storyboard_frame");
    expect(p.notes).toContainEqual({ code: "best_not_followed", attemptId: best.attempt.id });
  });

  it("an approved Production Frame attempt (bad history) is never proposed as video", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    clip(data, media, "1A", 6000, { approved: true, purpose: "production_frame" });
    expect(proposeShotItem(data, shotByCode(data, "1A").id, facts(media)).visual.kind).toBe(
      "storyboard_frame",
    );
  });

  it("the selected Production Frame is the first placeholder choice", () => {
    const data = seed();
    const asset = newUploadAsset(data.project.id, { label: "pf-3A" });
    data.assets.push(asset);
    const frame: ProductionFrame = { ...draftFor(data, "3A", { asset }), version: 1 };
    attach(data, [frame], frame);
    const p = proposeShotItem(data, frame.shotId, facts(new Map()));
    expect(p.visual).toEqual({ kind: "production_frame", productionFrameId: frame.id, durationMs: 4500 });
    expect(p.visualReason).toBe("placeholder_production_frame");
  });

  it("Best changing never changes the pinned source and never offers a replacement", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    const pinned = clip(data, media, "3A", 5000, { approved: true });
    const edit = editFrom(data, facts(media));
    const before = structuredClone(itemOf(edit, data, "3A"));
    const other = clip(data, media, "3A", 5000);
    const view = buildEpisodeEditView(
      data,
      edit,
      facts(media, [{ setId: "s", shotId: pinned.attempt.shotId, attemptId: other.attempt.id }]),
    );
    const v = view.items.find((i) => i.item.id === before.id)!;
    expect(v.visual).toMatchObject({
      kind: "video",
      isBest: false,
      bestElsewhereAttemptIds: [other.attempt.id],
      approved: true,
    });
    expect(v.replacement).toBeNull();
    expect(itemOf(edit, data, "3A")).toEqual(before);
  });

  it("approval moving reports approval_moved and proposes (not applies) the new clip", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    clip(data, media, "3A", 5000, { approved: true });
    const edit = editFrom(data, facts(media));
    const before = structuredClone(itemOf(edit, data, "3A"));
    const next = clip(data, media, "3A", 5000, { approved: true });
    const v = buildEpisodeEditView(data, edit, facts(media)).items.find((i) => i.item.id === before.id)!;
    expect(v.visual).toMatchObject({
      kind: "video",
      approved: false,
      approvedElsewhereAttemptId: next.attempt.id,
      usable: true,
    });
    expect(v.replacement).toEqual({
      reason: "approval_moved",
      visual: {
        kind: "video",
        attemptId: next.attempt.id,
        assetId: next.primary.id,
        sourceInMs: 0,
        sourceOutMs: 4500,
      },
    });
    expect(itemOf(edit, data, "3A")).toEqual(before);
  });

  it("a newer delivery master of the pinned attempt is reported; the pinned Asset stays", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    const c = clip(data, media, "3A", 5000, { approved: true });
    const edit = editFrom(data, facts(media)); // pinned the primary (no master yet)
    const v2 = videoAsset(data, 4500);
    media.set(c.attempt.id, {
      ...media.get(c.attempt.id)!,
      deliveryVersions: [{ assetId: v2.id, parentAssetId: c.primary.id, version: 1 }],
      deliveryAssetId: v2.id,
    });
    const v = buildEpisodeEditView(data, edit, facts(media)).items.find(
      (i) => i.item.shotId === c.attempt.shotId,
    )!;
    expect(v.visual).toMatchObject({ newerDeliveryMasterAssetId: v2.id });
    expect(v.replacement?.reason).toBe("delivery_master_changed");
    expect(itemOf(edit, data, "3A").visual).toMatchObject({ assetId: c.primary.id });
  });

  it("a placeholder whose Shot gains an approved clip reports clip_available", () => {
    const data = seed();
    const edit = editFrom(data, facts(new Map()));
    const media = new Map<string, AttemptMediaFacts>();
    const c = clip(data, media, "1B", 3000, { approved: true });
    const v = buildEpisodeEditView(data, edit, facts(media)).items.find(
      (i) => i.item.shotId === c.attempt.shotId,
    )!;
    expect(v.visual).toMatchObject({ kind: "storyboard_frame", clipAvailableAttemptId: c.attempt.id });
    expect(v.replacement?.reason).toBe("clip_available");
  });

  it("a pinned clip that is no longer usable is reported, never swapped", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    const c = clip(data, media, "3A", 5000, { approved: true });
    const edit = editFrom(data, facts(media));
    data.assets = data.assets.filter((a) => a.id !== c.primary.id);
    const v = buildEpisodeEditView(data, edit, facts(media)).items.find(
      (i) => i.item.shotId === c.attempt.shotId,
    )!;
    expect(v.visual).toMatchObject({ usable: false, violations: ["asset_not_found"] });
    expect(itemOf(edit, data, "3A").visual).toMatchObject({ assetId: c.primary.id });
  });

  it("a new selected Production Frame makes the pinned animation stale (2H freshness), still pinned", () => {
    const data = seed();
    const a1 = newUploadAsset(data.project.id, { label: "pf1" });
    data.assets.push(a1);
    const f1: ProductionFrame = { ...draftFor(data, "3A", { asset: a1 }), version: 1 };
    attach(data, [f1], f1);
    const ctx = buildShotContext(data, f1.shotId);
    const snapshot = {
      provenance: { parts: computeShotParts(ctx) },
      references: { productionFrame: { frameId: f1.id, assetId: a1.id } },
    };
    const media = new Map<string, AttemptMediaFacts>();
    clip(data, media, "3A", 5000, {
      approved: true,
      purpose: "animate_production_frame",
      packageSnapshot: snapshot,
      request: { startFrameAssetId: a1.id }, // 2H: the frame IS the first frame
    });
    const edit = editFrom(data, facts(media));
    const fresh = buildEpisodeEditView(data, edit, facts(media)).items.find(
      (i) => i.item.shotId === f1.shotId,
    )!;
    expect(fresh.visual).toMatchObject({ freshness: { status: "fresh" }, productionFrameChanged: false });

    const a2 = newUploadAsset(data.project.id, { label: "pf2" });
    data.assets.push(a2);
    const f2: ProductionFrame = { ...draftFor(data, "3A", { asset: a2 }), version: 2 };
    attach(data, [f1, f2], f2);
    const stale = buildEpisodeEditView(data, edit, facts(media)).items.find(
      (i) => i.item.shotId === f1.shotId,
    )!;
    expect(stale.visual).toMatchObject({ freshness: { status: "stale" }, productionFrameChanged: true });
    expect(itemOf(edit, data, "3A").visual.kind).toBe("video");
  });
});

// ───────────────────────── performance ─────────────────────────

describe("performance placements", () => {
  it("are item-relative references to the exact selected take, laid out like the Shot timeline", () => {
    const data = seed();
    const ctx = buildShotContext(data, shotByCode(data, "3A").id);
    const line = ctx.lines[0];
    const p = proposeShotItem(data, ctx.shot.id, facts(new Map()));
    expect(p.sourceAudio).toBe("muted");
    expect(p.performance).toEqual([
      {
        dialogueLineId: line.line.id,
        takeId: line.selectedTake!.id,
        startMs: 800,
        takeInMs: 0,
        takeOutMs: 2800,
      },
    ]);
    // a placement is a reference: nothing about the take's audio or waveform is copied
    expect(Object.keys(p.performance[0]).sort()).toEqual([
      "dialogueLineId",
      "startMs",
      "takeId",
      "takeInMs",
      "takeOutMs",
    ]);
  });

  it("trimming the picture's source-in does not move the audio (it is anchored to the item)", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    clip(data, media, "3A", 8000, { approved: true });
    const edit = editFrom(data, facts(media));
    const it3A = itemOf(edit, data, "3A");
    const placement = structuredClone(it3A.performance[0]);
    it3A.visual = {
      ...(it3A.visual as Extract<VisualSource, { kind: "video" }>),
      sourceInMs: 1000,
      sourceOutMs: 5500,
    };
    expect(editShapeViolations(edit)).toEqual([]);
    expect(it3A.performance[0]).toEqual(placement);
  });

  it("a take clipped by a short item is clipped, not moved; a take past the item end is left out, both noted", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    clip(data, media, "3A", 2000, { approved: true }); // 0.8 s pre-roll + 2.8 s take do not fit in 2 s
    const p = proposeShotItem(data, shotByCode(data, "3A").id, facts(media));
    expect(p.performance[0]).toMatchObject({ startMs: 800, takeInMs: 0, takeOutMs: 1200 });
    expect(p.notes.map((x) => x.code)).toContain("take_clipped_to_item");
    const tiny = new Map<string, AttemptMediaFacts>();
    const data2 = seed();
    clip(data2, tiny, "3A", 700, { approved: true });
    const q = proposeShotItem(data2, shotByCode(data2, "3A").id, facts(tiny));
    expect(q.performance).toEqual([]);
    expect(q.notes.map((x) => x.code)).toContain("take_outside_item");
  });

  it("explicit silence: no placement means no dialogue, and the unplaced line is reported", () => {
    const data = seed();
    const edit = editFrom(data, facts(new Map()));
    const it3A = itemOf(edit, data, "3A");
    it3A.performance = [];
    const v = buildEpisodeEditView(data, edit, facts(new Map())).items.find((i) => i.item.id === it3A.id)!;
    expect(v.performance.placements).toEqual([]);
    expect(v.performance.unplacedLineIds).toEqual([buildShotContext(data, it3A.shotId).lines[0].line.id]);
    // a Shot without dialogue proposes no placements at all
    expect(proposeShotItem(data, shotByCode(data, "1A").id, facts(new Map())).performance).toEqual([]);
  });

  it("a line with no selected take is reported as missing (silence by absence)", () => {
    const data = seed();
    const p = proposeShotItem(data, shotByCode(data, "4B").id, facts(new Map()));
    expect(p.performance).toEqual([]);
    expect(p.notes.map((x) => x.code)).toContain("missing_take");
  });

  it("a newly selected take is reported as take_superseded; the pinned take stays", () => {
    const data = seed();
    const edit = editFrom(data, facts(new Map()));
    const it3A = itemOf(edit, data, "3A");
    const pinned = it3A.performance[0];
    const other = data.takes.find(
      (t) => t.dialogueLineId === pinned.dialogueLineId && t.id !== pinned.takeId && !t.archived,
    )!;
    data.takes = selectTake(data.takes, other.id);
    const v = buildEpisodeEditView(data, edit, facts(new Map())).items.find((i) => i.item.id === it3A.id)!;
    expect(v.performance.placements).toEqual([
      {
        dialogueLineId: pinned.dialogueLineId,
        takeId: pinned.takeId,
        state: "take_superseded",
        selectedTakeId: other.id,
      },
    ]);
    expect(v.performance.performanceChanged).toBe(true);
    expect(itemOf(edit, data, "3A").performance[0]).toEqual(pinned);
  });

  it("a line removed from the Shot is reported as line_removed", () => {
    const data = seed();
    const edit = editFrom(data, facts(new Map()));
    const it3A = itemOf(edit, data, "3A");
    shotByCode(data, "3A").audio.dialogueLineIds = [];
    const v = buildEpisodeEditView(data, edit, facts(new Map())).items.find((i) => i.item.id === it3A.id)!;
    expect(v.performance.placements[0].state).toBe("line_removed");
  });

  it("a planned duration change is reported against the placement basis", () => {
    const data = seed();
    const edit = editFrom(data, facts(new Map()));
    const it1A = itemOf(edit, data, "1A");
    shotByCode(data, "1A").targetDurationMs = 5200;
    const v = buildEpisodeEditView(data, edit, facts(new Map())).items.find((i) => i.item.id === it1A.id)!;
    expect(v.performance.plannedTimingChanged).toBe(true);
    expect(v.duration).toEqual({ itemMs: 4000, plannedMs: 5200, deltaMs: -1200 });
    expect(itemDurationMs(it1A.visual)).toBe(4000);
  });

  it("the shape allows J/L cuts; Phase 2I.1 validation keeps every placement inside its item", () => {
    const data = seed();
    const take = data.takes.find((t) => t.selected)!;
    const shotId = shotByCode(data, "3A").id;
    const at = (startMs: number, out = 1000) => ({
      editRate: { num: 24, den: 1 },
      items: [
        item(
          shotId,
          { kind: "none", durationMs: 3000 },
          {
            performance: [
              { dialogueLineId: take.dialogueLineId, takeId: take.id, startMs, takeInMs: 0, takeOutMs: out },
            ],
          },
        ),
      ],
    });
    expect(editShapeViolations(at(0))).toEqual([]);
    expect(editShapeViolations(at(2000))).toEqual([]);
    expect(editShapeViolations(at(-200)).map((v) => v.code)).toEqual(["placement_outside_item"]); // a J-cut, representable
    expect(editShapeViolations(at(2500)).map((v) => v.code)).toEqual(["placement_outside_item"]); // an L-cut, representable
  });
});

// ───────────────────────── shape + lineage ─────────────────────────

describe("edit shape and lineage", () => {
  it("one item per Shot and stable ids are Phase 2I.1 invariants", () => {
    const data = seed();
    const shotId = shotByCode(data, "1A").id;
    const a = item(shotId, { kind: "none", durationMs: 1000 });
    const b = item(shotId, { kind: "none", durationMs: 1000 });
    expect(editShapeViolations({ editRate: { num: 24, den: 1 }, items: [a, b] })).toEqual([
      { code: "duplicate_shot", shotId },
    ]);
    expect(
      editShapeViolations({
        editRate: { num: 24, den: 1 },
        items: [a, { ...b, id: a.id, shotId: shotByCode(data, "1B").id }],
      }),
    ).toEqual([{ code: "duplicate_item_id", itemId: a.id }]);
    expect(editShapeViolations({ editRate: { num: 23, den: 1 }, items: [] })).toEqual([
      { code: "invalid_edit_rate" },
    ]);
    expect(
      editShapeViolations({
        editRate: { num: 24, den: 1 },
        items: [item(shotId, { kind: "none", durationMs: 0 })],
      }).map((v) => v.code),
    ).toEqual(["empty_item"]);
  });

  it("the proposed edit for the seed is structurally valid and every source is eligible", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    clip(data, media, "3A", 5000, { approved: true, deliveryMs: 4500 });
    const edit = editFrom(data, facts(media));
    expect(editShapeViolations(edit)).toEqual([]);
    for (const v of buildEpisodeEditView(data, edit, facts(media)).items)
      expect(v.visual.violations).toEqual([]);
  });

  it("lineage follows references: Shot → attempt → exact Asset → original; line → take → audio Asset", () => {
    const data = seed();
    const media = new Map<string, AttemptMediaFacts>();
    const c = clip(data, media, "3A", 5000, {
      approved: true,
      deliveryMs: 4500,
      purpose: "animate_production_frame",
    });
    const edit = editFrom(data, facts(media));
    const it3A = itemOf(edit, data, "3A");
    const { picture, audio } = editItemLineage(data, it3A, facts(media));
    expect(picture).toEqual([
      { step: "shot", shotId: c.attempt.shotId, shotCode: "3A" },
      {
        step: "attempt",
        attemptId: c.attempt.id,
        attemptNumber: c.attempt.attemptNumber,
        model: "mock-video-1",
        purpose: "animate_production_frame",
      },
      { step: "asset", assetId: c.delivery!.id, role: "delivery_version", isCurrentDeliveryMaster: true },
      { step: "derived_from", assetId: c.primary.id, version: 1 },
    ]);
    const take = data.takes.find((t) => t.id === it3A.performance[0].takeId)!;
    expect(audio).toEqual([
      {
        dialogueLineId: take.dialogueLineId,
        speaker: "Yumeko",
        takeId: take.id,
        takeNumber: take.takeNumber,
        sourceType: take.sourceType,
        audioAssetId: take.audioAssetId,
      },
    ]);
  });
});
