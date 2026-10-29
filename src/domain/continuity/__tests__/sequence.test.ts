import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assignLook,
  attachLocks,
  lockFor,
  yumekoIvory,
} from "@/domain/__tests__/character-continuity-fixtures";
import { seed, shotByCode } from "@/domain/__tests__/helpers";
import { attachViews, locationOf, viewFor } from "@/domain/__tests__/location-view-fixtures";
import { attach, draftFor, newUploadAsset } from "@/domain/__tests__/production-frame-fixtures";
import { criteriaFingerprint } from "@/domain/continuity/criteria";
import { CONTINUITY_RULES_VERSION, type ContinuityCriterion } from "@/domain/continuity/model";
import {
  assessTransition,
  buildEpisodeCuts,
  CUT_EDGE_POLICY,
  cutIntentEffective,
  cutReferenceFingerprint,
  EDIT_FACT_CRITERIA,
  editOrderInfo,
  effectiveTransitionFindings,
  firstDisplayedFrameMs,
  lastDisplayedFrameMs,
  leftEdgeWindow,
  NOT_CALIBRATED,
  PLACEHOLDER_REASON,
  referencesForCut,
  rightEdgeWindow,
  SCENE_CHANGE_REASON,
  SEMANTIC_CUT_FAMILIES,
  SEQUENCE_RULES_VERSION,
  transitionFreshness,
  transitionKey,
  type CutIntent,
  type CutReference,
  type CutTransition,
  type EffectiveCutFinding,
  type TransitionRun,
} from "@/domain/continuity/sequence";
import { DEFAULT_EDIT_RATE, type EditRate } from "@/domain/edit/edit-rate";
import type { AttemptMediaFacts } from "@/domain/edit/eligibility";
import type { EditItem, EpisodeEdit, VisualSource } from "@/domain/edit/model";
import { buildEpisodeEditView } from "@/domain/edit/view";
import type { ProductionFrame } from "@/domain/production-frame";
import {
  generationAttemptSchema,
  type Asset,
  type GenerationAttempt,
  type ProjectData,
} from "@/domain/schemas";
import { buildShotSequence } from "@/domain/shot-sequence";

/**
 * Phase 3A.4A: the cut domain over the persisted Episode Edit. Pure and in memory: seed data, no repository, provider,
 * media processing or network. Every result is advisory.
 */

// ───────────────────────── fixtures ─────────────────────────

let n = 0;
function videoAsset(data: ProjectData, durationMs: number): Asset {
  const base = newUploadAsset(data.project.id, { label: `cut-clip-${++n}` });
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

function addAttempt(data: ProjectData, code: string, o: { approved?: boolean } = {}): GenerationAttempt {
  const shotId = shotByCode(data, code).id;
  if (o.approved) for (const a of data.attempts) if (a.shotId === shotId) a.approved = false;
  const attempt = generationAttemptSchema.parse({
    id: randomUUID(),
    projectId: data.project.id,
    shotId,
    attemptNumber: 500 + ++n,
    provider: "mock",
    model: "mock-video-1",
    modality: "video",
    prompt: "",
    negativePrompt: "",
    packageSnapshot: {},
    packageFingerprint: `fp-cut-${n}`,
    modelSettings: {},
    inputAssetIds: [],
    outputAssetId: null,
    costUsd: 0,
    durationMs: null,
    status: "succeeded",
    reviewStatus: o.approved ? "approved" : "unreviewed",
    rejectionReason: "",
    notes: "",
    approved: o.approved ?? false,
    request: { purpose: "shot_output" },
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
  });
  data.attempts.push(attempt);
  return attempt;
}

interface World {
  data: ProjectData;
  media: Map<string, AttemptMediaFacts>;
}

function world(): World {
  return { data: seed(), media: new Map() };
}

/** A clip of Shot `code`: an attempt and its primary output of `durationMs`. */
function clip(w: World, code: string, durationMs = 6000, o: { approved?: boolean } = {}) {
  const attempt = addAttempt(w.data, code, o);
  const asset = videoAsset(w.data, durationMs);
  w.media.set(attempt.id, {
    attemptId: attempt.id,
    outputs: [{ assetId: asset.id, role: "primary" }],
    deliveryVersions: [],
    deliveryAssetId: null,
  });
  return { attempt, asset };
}

function videoItem(
  w: World,
  code: string,
  o: { inMs?: number; outMs?: number; durationMs?: number } = {},
): EditItem {
  const { attempt, asset } = clip(w, code, o.durationMs ?? 6000);
  return item(w.data, code, {
    kind: "video",
    attemptId: attempt.id,
    assetId: asset.id,
    sourceInMs: o.inMs ?? 0,
    sourceOutMs: o.outMs ?? 5000,
  });
}

function item(data: ProjectData, code: string, visual: VisualSource): EditItem {
  return {
    id: randomUUID(),
    shotId: shotByCode(data, code).id,
    visual,
    sourceAudio: "muted",
    performance: [],
    performanceBasis: null,
  };
}

function editOf(
  w: World,
  items: EditItem[],
  o: { rate?: EditRate; revision?: number; id?: string } = {},
): EpisodeEdit {
  return {
    id: o.id ?? "edit-1",
    projectId: w.data.project.id,
    episodeId: w.data.episodes[0].id,
    editRate: o.rate ?? DEFAULT_EDIT_RATE,
    revision: o.revision ?? 0,
    items,
  };
}

const cutsOf = (
  w: World,
  edit: EpisodeEdit,
  shotQa?: Map<string, "critical_mismatch" | "no_blocking_mismatch">,
) =>
  buildEpisodeCuts({
    data: w.data,
    view: buildEpisodeEditView(w.data, edit, { attempts: w.media, bestPointers: [] }),
    shotQa,
  });

const finding = (cut: CutTransition, key: string) => {
  const f = cut.findings.find((x) => x.criterionKey === key);
  if (!f) throw new Error(`no finding ${key} (have ${cut.findings.map((x) => x.criterionKey).join(", ")})`);
  return f;
};
const criterion = (cut: CutTransition, key: string) => cut.criteria.find((c) => c.key === key)!;
const withTrim = (i: EditItem, inMs: number, outMs: number): EditItem => ({
  ...i,
  visual: { ...(i.visual as Extract<VisualSource, { kind: "video" }>), sourceInMs: inMs, sourceOutMs: outMs },
});

// ───────────────────────── cut construction ─────────────────────────

describe("cuts come from the persisted Episode Edit's actual item order", () => {
  it("zero items → zero cuts; one item → zero cuts; three items → two cuts, in edit order", () => {
    const w = world();
    expect(cutsOf(w, editOf(w, []))).toEqual([]);
    expect(cutsOf(w, editOf(w, [videoItem(w, "2A")]))).toEqual([]);
    const items = [videoItem(w, "2A"), videoItem(w, "2B"), videoItem(w, "2C")];
    const cuts = cutsOf(w, editOf(w, items));
    expect(cuts.map((c) => [c.address.leftItemId, c.address.rightItemId])).toEqual([
      [items[0].id, items[1].id],
      [items[1].id, items[2].id],
    ]);
    expect(cuts.map((c) => c.index)).toEqual([0, 1]);
  });

  it("the edit's order decides adjacency, never shotOrder or previousShotId; the planned order is only reported", () => {
    const w = world();
    const items = [videoItem(w, "2E"), videoItem(w, "2B")];
    const edit = editOf(w, items);
    const [cut] = cutsOf(w, edit);
    expect([cut.left.shotCode, cut.right.shotCode]).toEqual(["2E", "2B"]);
    // 2B stores 2A as its previous Shot: a planning link, reported, never deciding the cut
    expect(finding(cut, "cut:link")).toMatchObject({ result: "warn", side: "right" });
    expect(
      editOrderInfo(buildEpisodeEditView(w.data, edit, { attempts: w.media, bestPointers: [] })),
    ).toEqual({
      kind: "edit_order",
      message: "Edit order differs from the planned sequence.",
    });
  });

  it("the address is (edit, left item, right item): item ids, not Shot ids", () => {
    const w = world();
    const items = [videoItem(w, "2A"), videoItem(w, "2B")];
    const [cut] = cutsOf(w, editOf(w, items, { id: "edit-x" }));
    expect(cut.address).toEqual({ editId: "edit-x", leftItemId: items[0].id, rightItemId: items[1].id });
    expect(cut.transitionKey).toBe(transitionKey(cut.address));
    expect(transitionKey({ ...cut.address, leftItemId: "other" })).not.toBe(cut.transitionKey);
    expect(transitionKey({ ...cut.address, editId: "edit-y" })).not.toBe(cut.transitionKey);
  });
});

// ───────────────────────── shared truth with the Sequence Board ─────────────────────────

describe("the cut reuses the Sequence Board's declared-truth comparison", () => {
  it("for the same two Shots, the cut's facts are exactly the board's non-link facts", () => {
    const w = world();
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2D"), videoItem(w, "2E")]));
    const board = buildShotSequence(w.data, w.data.episodes[0].id).transitions.find(
      (t) => t.toShotCode === "2E",
    )!;
    const boardFacts = [...board.changes, ...board.stable].filter((f) => f.category !== "sequence_link");
    expect([...cut.facts].sort((a, b) => a.message.localeCompare(b.message))).toEqual(
      [...boardFacts].sort((a, b) => a.message.localeCompare(b.message)),
    );
  });
});

// ───────────────────────── edge windows ─────────────────────────

describe("cut-edge-static-v1 window arithmetic (descriptors only)", () => {
  it("is 2,000 ms per side at 4 fps, audio stripped", () => {
    expect(CUT_EDGE_POLICY).toEqual({ id: "cut-edge-static-v1", windowMs: 2000, fps: 4, audio: "stripped" });
  });

  it("normal, shorter, exact and offset clips", () => {
    expect(leftEdgeWindow(0, 5000)).toEqual({ startMs: 3000, endMs: 5000 });
    expect(rightEdgeWindow(0, 5000)).toEqual({ startMs: 0, endMs: 2000 });
    // used interval shorter than W: the whole used interval
    expect(leftEdgeWindow(500, 1700)).toEqual({ startMs: 500, endMs: 1700 });
    expect(rightEdgeWindow(500, 1700)).toEqual({ startMs: 500, endMs: 1700 });
    // exactly W
    expect(leftEdgeWindow(1000, 3000)).toEqual({ startMs: 1000, endMs: 3000 });
    expect(rightEdgeWindow(1000, 3000)).toEqual({ startMs: 1000, endMs: 3000 });
    // nonzero in-point
    expect(leftEdgeWindow(1200, 6000)).toEqual({ startMs: 4000, endMs: 6000 });
    expect(rightEdgeWindow(1200, 6000)).toEqual({ startMs: 1200, endMs: 3200 });
  });

  it("edge frames: A's last displayed frame and B's first, quantised at the (rational) edit rate in item-local time", () => {
    // 5,000 ms at 24 fps: the final instant 4,999 ms is in frame 119, which starts at 4,959 ms (ceil(119000 / 24))
    expect(lastDisplayedFrameMs(0, 5000, { num: 24, den: 1 })).toBe(4959);
    expect(lastDisplayedFrameMs(1000, 6000, { num: 24, den: 1 })).toBe(5959);
    // 23.976 (24000/1001): frame 119 starts at ceil(119 · 1001 · 1000 / 24000) = 4964 ms
    expect(lastDisplayedFrameMs(0, 5000, { num: 24000, den: 1001 })).toBe(4964);
    expect(lastDisplayedFrameMs(0, 5000, { num: 25, den: 1 })).toBe(4960);
    expect(firstDisplayedFrameMs(1200)).toBe(1200);
    for (const rate of [
      { num: 24, den: 1 },
      { num: 24000, den: 1001 },
      { num: 30000, den: 1001 },
    ]) {
      const at = lastDisplayedFrameMs(333, 4777, rate);
      expect(Number.isInteger(at)).toBe(true);
      expect(at).toBeGreaterThanOrEqual(333);
      expect(at).toBeLessThan(4777);
    }
  });

  it("each video side carries its window and edge still; placeholders and empty items carry none; nothing is derived", () => {
    const w = world();
    const items = [
      videoItem(w, "2A", { inMs: 1000, outMs: 6000 }),
      videoItem(w, "2B", { inMs: 500, outMs: 4500 }),
    ];
    const [cut] = cutsOf(w, editOf(w, items));
    expect(cut.left.window).toMatchObject({
      side: "left",
      startMs: 4000,
      endMs: 6000,
      durationMs: 2000,
      fps: 4,
      audio: "stripped",
      policy: "cut-edge-static-v1",
    });
    expect(cut.right.window).toMatchObject({ side: "right", startMs: 500, endMs: 2500, durationMs: 2000 });
    expect(cut.left.still).toMatchObject({ frame: "last_displayed", atMs: 5959 });
    expect(cut.right.still).toMatchObject({ frame: "first_displayed", atMs: 500 });
    const asset = w.data.assets.find((a) => a.id === (items[0].visual as { assetId: string }).assetId)!;
    expect(cut.left.window?.parentChecksum).toBe(asset.checksum);

    const w2 = world();
    const [p] = cutsOf(
      w2,
      editOf(w2, [videoItem(w2, "2A"), item(w2.data, "2B", { kind: "none", durationMs: 3000 })]),
    );
    expect(p.right.window).toBeNull();
    expect(p.right.still).toBeNull();
  });
});

// ───────────────────────── identity + trim sensitivity ─────────────────────────

describe("transition identity: local, trim-sensitive, never the edit revision", () => {
  function base() {
    const w = world();
    const a = videoItem(w, "2A", { inMs: 0, outMs: 5000 });
    const b = videoItem(w, "2B", { inMs: 0, outMs: 5000 });
    const c = videoItem(w, "2C", { inMs: 0, outMs: 5000 });
    return { w, a, b, c };
  }
  const first = (w: World, items: EditItem[], o: Parameters<typeof editOf>[2] = {}) =>
    cutsOf(w, editOf(w, items, o))[0];

  it("the key survives trims and source replacement; the subject does not", () => {
    const { w, a, b } = base();
    const before = first(w, [a, b]);
    const trimmed = first(w, [withTrim(a, 0, 4500), b]);
    expect(trimmed.transitionKey).toBe(before.transitionKey);
    expect(trimmed.truth.subjectFingerprint).not.toBe(before.truth.subjectFingerprint);

    const other = videoItem(w, "2A");
    const replaced = first(w, [{ ...a, visual: other.visual }, b]);
    expect(replaced.transitionKey).toBe(before.transitionKey);
    expect(replaced.truth.leftSubjectFingerprint).not.toBe(before.truth.leftSubjectFingerprint);
    expect(replaced.truth.rightSubjectFingerprint).toBe(before.truth.rightSubjectFingerprint);
  });

  it("A's out-point and B's in-point always change the subject", () => {
    const { w, a, b } = base();
    const before = first(w, [a, b]).truth;
    expect(first(w, [withTrim(a, 0, 4800), b]).truth.leftSubjectFingerprint).not.toBe(
      before.leftSubjectFingerprint,
    );
    expect(first(w, [a, withTrim(b, 200, 5000)]).truth.rightSubjectFingerprint).not.toBe(
      before.rightSubjectFingerprint,
    );
  });

  it("A's in-point and B's out-point matter only when they reach the evaluated window", () => {
    const { w, a, b } = base();
    const before = first(w, [a, b]).truth;
    // 5,000 ms used: the windows are [3000, 5000] and [0, 2000]; moving A's in / B's out elsewhere changes nothing
    expect(first(w, [withTrim(a, 1000, 5000), withTrim(b, 0, 4000)]).truth.subjectFingerprint).toBe(
      before.subjectFingerprint,
    );
    // a used interval shorter than W: the window now starts at A's in-point / ends at B's out-point
    expect(first(w, [withTrim(a, 3500, 5000), b]).truth.leftSubjectFingerprint).not.toBe(
      before.leftSubjectFingerprint,
    );
    expect(first(w, [a, withTrim(b, 0, 1500)]).truth.rightSubjectFingerprint).not.toBe(
      before.rightSubjectFingerprint,
    );
  });

  it("the edit rate counts only through the exact edge frame it moves", () => {
    const { w, a, b } = base();
    const at24 = first(w, [a, b], { rate: { num: 24, den: 1 } }).truth;
    const at25 = first(w, [a, b], { rate: { num: 25, den: 1 } }).truth;
    expect(at25.leftSubjectFingerprint).not.toBe(at24.leftSubjectFingerprint); // 4959 → 4960 ms
    expect(at25.rightSubjectFingerprint).toBe(at24.rightSubjectFingerprint); // B's first frame is its in-point
  });

  it("the global edit revision, unrelated items, audio placements and source audio never change it", () => {
    const { w, a, b, c } = base();
    const before = first(w, [a, b]).truth;
    expect(first(w, [a, b], { revision: 41 }).truth).toEqual(before);
    // an unrelated cut elsewhere (B → C added, then C trimmed): A → B is untouched
    const withC = cutsOf(w, editOf(w, [a, b, withTrim(c, 100, 3000)]));
    expect(withC[0].truth).toEqual(before);
    const take = w.data.takes[0];
    const placed = {
      ...b,
      sourceAudio: "included" as const,
      performance: take
        ? [{ dialogueLineId: take.dialogueLineId, takeId: take.id, startMs: 0, takeInMs: 0, takeOutMs: 100 }]
        : [],
    };
    expect(first(w, [a, placed]).truth).toEqual(before);
  });

  it("reorder removes the cut; restoring the adjacency restores its address and identity", () => {
    const { w, a, b, c } = base();
    const ab = first(w, [a, b, c]);
    const reordered = cutsOf(w, editOf(w, [a, c, b]));
    expect(reordered.map((x) => x.transitionKey)).not.toContain(ab.transitionKey);
    const restored = cutsOf(w, editOf(w, [a, b, c]))[0];
    expect(restored.transitionKey).toBe(ab.transitionKey);
    expect(transitionFreshness(ab.truth, restored)).toEqual({ status: "current", reasons: [] });
  });

  it("freshness is local: a changed left / right picture or truth stales only this cut, with the reason", () => {
    const { w, a, b, c } = base();
    const [ab, bc] = cutsOf(w, editOf(w, [a, b, c]));
    const next = cutsOf(w, editOf(w, [withTrim(a, 0, 4000), b, c]));
    expect(transitionFreshness(ab.truth, next[0])).toEqual({
      status: "stale",
      reasons: ["The left picture at the cut changed (source, trim or edge frame)."],
    });
    expect(transitionFreshness(bc.truth, next[1]).status).toBe("current");
    expect(transitionFreshness(ab.truth, next[1]).status).toBe("other_cut");

    shotByCode(w.data, "2B").spatial.screenDirection = "Right to left";
    const truthChanged = cutsOf(w, editOf(w, [a, b, c]));
    expect(transitionFreshness(ab.truth, truthChanged[0]).reasons).toEqual([
      "The continuity truth of this cut changed.",
    ]);
  });

  it("a changed reference (Location View) stales the cut through the reference fingerprint", () => {
    const { w, a, b } = base();
    const before = first(w, [a, b]);
    const canopy = locationOf(w.data, "2A");
    const img = newUploadAsset(w.data.project.id, { label: "canopy-view", width: 1200, height: 900 });
    img.purpose = "location_ref";
    w.data.assets.push(img);
    const v = viewFor(w.data, canopy.id, img, { name: "Canopy Wide", kind: "establishing" });
    attachViews(w.data, [v], [{ shotId: shotByCode(w.data, "2B").id, view: v }]);
    const after = first(w, [a, b]);
    expect(after.truth.referenceFingerprint).not.toBe(before.truth.referenceFingerprint);
    expect(transitionFreshness(before.truth, after).reasons).toContain("A reference of this cut changed.");
  });
});

// ───────────────────────── deterministic findings ─────────────────────────

describe("deterministic cut findings (declared truth and edit facts; never pixels, never a creative fail)", () => {
  it("usable video → video inside a Scene: picture and integrity pass; every semantic criterion unchecked, not calibrated", () => {
    const w = world();
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2A"), videoItem(w, "2B")]));
    expect(finding(cut, "cut:picture").result).toBe("pass");
    expect(finding(cut, "cut:source_integrity").result).toBe("pass");
    expect(finding(cut, "cut:link").result).toBe("pass");
    expect(cut.semantic).toEqual({ mediaEligible: true, reasons: [] });
    const semantic = cut.criteria.filter((c) => c.handler === "analyzer");
    expect(semantic.length).toBeGreaterThan(0);
    for (const c of semantic) {
      expect(SEMANTIC_CUT_FAMILIES).toContain(c.family);
      expect(finding(cut, c.key)).toMatchObject({ result: "unchecked", reason: NOT_CALIBRATED(c.family!) });
    }
  });

  it("a placeholder side: deterministic facts stay; semantic criteria unchecked with the planning-picture reason", () => {
    const w = world();
    const asset = newUploadAsset(w.data.project.id, { label: "pf-2B" });
    w.data.assets.push(asset);
    const pf: ProductionFrame = { ...draftFor(w.data, "2B", { asset }), version: 1 };
    attach(w.data, [pf], pf);
    const [cut] = cutsOf(
      w,
      editOf(w, [
        videoItem(w, "2A"),
        item(w.data, "2B", { kind: "production_frame", productionFrameId: pf.id, durationMs: 3000 }),
      ]),
    );
    expect(finding(cut, "cut:picture")).toMatchObject({ result: "unchecked" });
    expect(finding(cut, "cut:picture").reason).toContain(PLACEHOLDER_REASON);
    expect(finding(cut, "cut:source_integrity").result).toBe("pass");
    expect(finding(cut, "cut:location").result).toBe("pass");
    expect(finding(cut, "cut:screen_direction").reason).toContain(PLACEHOLDER_REASON);
    expect(cut.semantic.mediaEligible).toBe(false);
    expect(cut.right.picture).toMatchObject({ kind: "production_frame", assetChecksum: pf.assetChecksum });
  });

  it("no picture: side-specific reason on every picture criterion", () => {
    const w = world();
    const [cut] = cutsOf(
      w,
      editOf(w, [item(w.data, "2A", { kind: "none", durationMs: 2000 }), videoItem(w, "2B")]),
    );
    expect(finding(cut, "cut:picture")).toMatchObject({
      result: "unchecked",
      reason: "No picture on the left of this cut.",
    });
    expect(finding(cut, "cut:axis").reason).toBe("No picture on the left of this cut.");
  });

  it("an unusable pinned source is a deterministic critical FAIL and blocks semantic preparation", () => {
    const w = world();
    const bad = videoItem(w, "2B", { durationMs: 3000, outMs: 4000 }); // trim beyond the clip
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2A"), bad]));
    expect(finding(cut, "cut:source_integrity")).toMatchObject({ result: "fail", side: "right" });
    expect(criterion(cut, "cut:source_integrity")).toMatchObject({
      severity: "critical",
      intentCoverable: false,
    });
    expect(cut.semantic.mediaEligible).toBe(false);
    expect(finding(cut, "cut:axis").reason).toBe(
      "A pinned source is not usable; semantic analysis cannot be prepared.",
    );
  });

  it("a replacement available (the Shot approved another clip) is a currentness WARN naming the side", () => {
    const w = world();
    const pinned = videoItem(w, "2B");
    clip(w, "2B", 6000, { approved: true });
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2A"), pinned]));
    expect(finding(cut, "cut:source_currentness")).toMatchObject({ result: "warn", side: "right" });
    expect(finding(cut, "cut:source_currentness").reason).toContain("approval_moved");
  });

  it("Shot QA is linked, never recomputed: only when supplied, a critical mismatch WARNs on that side", () => {
    const w = world();
    const a = videoItem(w, "2A");
    const b = videoItem(w, "2B");
    const edit = editOf(w, [a, b]);
    expect(cutsOf(w, edit)[0].findings.map((f) => f.criterionKey)).not.toContain("cut:shot_qa");
    const qa = new Map([[(a.visual as { attemptId: string }).attemptId, "critical_mismatch" as const]]);
    expect(finding(cutsOf(w, edit, qa)[0], "cut:shot_qa")).toMatchObject({ result: "warn", side: "left" });
  });

  it("a wrong / missing previous-Shot link WARNs (planning metadata, not an error)", () => {
    const w = world();
    shotByCode(w.data, "2B").continuity.previousShotId = null;
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2A"), videoItem(w, "2B")]));
    expect(finding(cut, "cut:link")).toMatchObject({
      result: "warn",
      reason: "2B has no stored previous Shot; the edit puts 2A before it.",
    });
  });

  it("Location change inside a Scene WARNs; a Location View change WARNs; the same View passes", () => {
    const w = world();
    // 1B (Tokyo Night Streets) → 1C (Black Luxury Sedan), both Scene 1
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "1B"), videoItem(w, "1C")]));
    expect(finding(cut, "cut:location")).toMatchObject({
      result: "warn",
      reason: "Location Tokyo Night Streets → Black Luxury Sedan",
    });

    const w2 = world();
    const canopy = locationOf(w2.data, "2A");
    const img = (label: string) => {
      const a = newUploadAsset(w2.data.project.id, { label, width: 1200, height: 900 });
      a.purpose = "location_ref";
      w2.data.assets.push(a);
      return a;
    };
    const wide = viewFor(w2.data, canopy.id, img("wide"), { name: "Canopy Wide", kind: "establishing" });
    const door = viewFor(w2.data, canopy.id, img("door"), { name: "Doorway", kind: "entrance" });
    attachViews(
      w2.data,
      [wide, door],
      [
        { shotId: shotByCode(w2.data, "2A").id, view: wide },
        { shotId: shotByCode(w2.data, "2B").id, view: wide },
        { shotId: shotByCode(w2.data, "2C").id, view: door },
      ],
    );
    const [same, changed] = cutsOf(
      w2,
      editOf(w2, [videoItem(w2, "2A"), videoItem(w2, "2B"), videoItem(w2, "2C")]),
    );
    expect(finding(same, "cut:location").result).toBe("pass");
    expect(finding(changed, "cut:location")).toMatchObject({
      result: "warn",
      reason: "Grand Celeste Hotel Canopy: View Canopy Wide → Doorway",
    });
    expect(changed.right.references.map((r) => r.role)).toContain("location_view");
  });

  it("Character Continuity: same Lock passes; Lock A → B is a critical-severity WARN; Lock ↔ live WARNs; Look change WARNs", () => {
    const setup = () => {
      const w = world();
      const { ivory } = yumekoIvory(w.data, "2B");
      assignLook(w.data, "2E", "Yumeko", ivory);
      return { w, ivory };
    };
    const yumekoKey = (w: World) => `cut:character:${w.data.characters.find((c) => c.name === "Yumeko")!.id}`;

    {
      const { w, ivory } = setup();
      const lock = lockFor(w.data, "Yumeko", ivory, { name: "Ivory v1" });
      attachLocks(
        w.data,
        [lock],
        [
          { code: "2B", lock },
          { code: "2E", lock },
        ],
      );
      const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2B"), videoItem(w, "2E")]));
      expect(finding(cut, yumekoKey(w))).toMatchObject({ result: "pass" });
      expect(cut.left.references).toContainEqual(
        expect.objectContaining({ role: "character_lock", checksum: lock.lockFingerprint }),
      );
    }
    {
      const { w, ivory } = setup();
      const lockA = lockFor(w.data, "Yumeko", ivory, { name: "Ivory v1" });
      ivory.hair = "loose waves";
      const lockB = lockFor(w.data, "Yumeko", ivory, { name: "Ivory v2" });
      attachLocks(
        w.data,
        [lockA, lockB],
        [
          { code: "2B", lock: lockA },
          { code: "2E", lock: lockB },
        ],
      );
      const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2B"), videoItem(w, "2E")]));
      expect(finding(cut, yumekoKey(w))).toMatchObject({
        result: "warn",
        reason: 'Yumeko: Continuity Lock "Ivory v1" → "Ivory v2"',
      });
      expect(criterion(cut, yumekoKey(w)).severity).toBe("critical");
    }
    {
      const { w, ivory } = setup();
      const lockA = lockFor(w.data, "Yumeko", ivory, { name: "Ivory v1" });
      attachLocks(w.data, [lockA], [{ code: "2B", lock: lockA }]);
      const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2B"), videoItem(w, "2E")]));
      expect(finding(cut, yumekoKey(w)).result).toBe("warn");
      expect(finding(cut, yumekoKey(w)).reason).toContain("appearance authority changes");
      expect(criterion(cut, yumekoKey(w)).severity).toBe("major");
    }
    {
      const w = world();
      yumekoIvory(w.data, "2E"); // 2B keeps Formal Black, 2E wears Ivory Suit: both live
      const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2B"), videoItem(w, "2E")]));
      expect(finding(cut, yumekoKey(w))).toMatchObject({
        result: "warn",
        reason: "Yumeko: Look Episode 1 — Formal Black → Ivory Suit",
      });
    }
  });

  it("declared screen / facing direction and weather / time differences WARN as review aids", () => {
    const w = world();
    // 2D "Faces screen-right" → 2E "Faces screen-left"
    shotByCode(w.data, "2E").continuity.timeOfDay = "Dawn";
    shotByCode(w.data, "2E").continuity.weather = "Clear";
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2D"), videoItem(w, "2E")]));
    expect(finding(cut, "cut:declared_direction")).toMatchObject({
      result: "warn",
      reason: "Screen direction changes: Faces screen-right → Faces screen-left (needs human review)",
    });
    expect(finding(cut, "cut:declared_time").result).toBe("warn");
    expect(finding(cut, "cut:declared_time").reason).toContain("Time of day changes: Night → Dawn");
    expect(finding(cut, "cut:declared_time").reason).toContain("Weather changes:");
    // nothing declared on one side: n_a, never a pass
    const [undeclared] = cutsOf(w, editOf(w, [videoItem(w, "2B"), videoItem(w, "2C")]));
    expect(finding(undeclared, "cut:declared_direction")).toMatchObject({ result: "n_a" });
  });

  it("Character entries / exits and exit / entry points are informational facts, never findings", () => {
    const w = world();
    shotByCode(w.data, "2A").spatial.exitPoint = "frame right";
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2A"), videoItem(w, "2B")]));
    expect(cut.info).toEqual([
      { kind: "character_presence", message: "Yumeko enters" },
      { kind: "exit_entry", message: "Exit frame right → entry Rear-left door" },
    ]);
    expect(cut.findings.filter((f) => f.result === "fail")).toEqual([]);
  });

  it("no free-text declared difference ever FAILs", () => {
    const w = world();
    const items = ["1A", "1B", "1C", "2A", "2B", "2C", "2D", "2E", "3A", "4A", "4B", "4C", "5A", "6A"].map(
      (c) => videoItem(w, c),
    );
    for (const cut of cutsOf(w, editOf(w, items)))
      expect(cut.findings.filter((f) => f.result === "fail").map((f) => f.criterionKey)).toEqual([]);
  });
});

// ───────────────────────── Scene boundary ─────────────────────────

describe("applicability is Prism's: across a Scene boundary, scene-continuity criteria are n_a before any analysis", () => {
  it("2E → 3A crosses a Scene: location, direction, time, props and the scene-bound semantic families are n_a", () => {
    const w = world();
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2E"), videoItem(w, "3A")]));
    expect(cut.crossesScene).toBe(true);
    for (const key of [
      "cut:location",
      "cut:declared_direction",
      "cut:declared_time",
      "cut:declared_props",
      "cut:screen_direction",
      "cut:eyeline",
      "cut:axis",
      "cut:geography",
      "cut:lighting",
      "cut:action_match",
      "cut:object_continuity",
    ]) {
      expect(finding(cut, key), key).toMatchObject({ result: "n_a", reason: SCENE_CHANGE_REASON });
      expect(criterion(cut, key).applicability).toBe("n_a");
    }
    // identity-level continuity still applies (Yumeko is on both sides); it stays unchecked, not n_a
    const appearance = cut.criteria.find((c) => c.key.startsWith("cut:character_appearance:"))!;
    expect(appearance.applicability).toBe("applies");
    expect(finding(cut, appearance.key).result).toBe("unchecked");
  });
});

// ───────────────────────── assessment ─────────────────────────

/** A semantic run of `cut` that answered every applicable analyzer criterion with PASS, except `results`. */
function semanticRun(
  cut: CutTransition,
  results: Record<string, EffectiveCutFinding["result"]> = {},
  status: TransitionRun["analysisStatus"] = "complete",
): TransitionRun {
  return {
    truth: cut.truth,
    analysisStatus: status,
    findings: cut.criteria
      .filter((c) => c.handler === "analyzer" && c.applicability === "applies")
      .map((c) => ({
        criterionKey: c.key,
        category: c.category,
        severity: c.severity,
        result: results[c.key] ?? "pass",
        intentCoverable: c.intentCoverable,
      })),
  };
}

/** 2B → 2C: inside Scene 2, no deterministic warning at all (the clean baseline). */
function cutPair() {
  const w = world();
  const a = videoItem(w, "2B");
  const b = videoItem(w, "2C");
  const [cut] = cutsOf(w, editOf(w, [a, b]));
  return { w, a, b, cut };
}

/** 2B → 2E with Yumeko under the same Lock on both sides: her appearance is a critical semantic criterion. */
function lockedPair() {
  const w = world();
  const { ivory } = yumekoIvory(w.data, "2B");
  assignLook(w.data, "2E", "Yumeko", ivory);
  const lock = lockFor(w.data, "Yumeko", ivory, { name: "Ivory v1" });
  attachLocks(
    w.data,
    [lock],
    [
      { code: "2B", lock },
      { code: "2E", lock },
    ],
  );
  const a = videoItem(w, "2B");
  const b = videoItem(w, "2E");
  const [cut] = cutsOf(w, editOf(w, [a, b]));
  const appearance = `cut:character_appearance:${w.data.characters.find((c) => c.name === "Yumeko")!.id}`;
  return { w, a, b, cut, appearance };
}

const intentFor = (cut: CutTransition, o: Partial<CutIntent> = {}): CutIntent => ({
  fromItemId: cut.address.leftItemId,
  kinds: ["time_jump"],
  scope: [],
  note: "Deliberate time jump.",
  declaredBy: null,
  declaredAt: "2026-10-29T00:00:00.000Z",
  ...o,
});

describe("assessTransition: advisory states in precedence order", () => {
  it("the clean baseline has no deterministic warning", () => {
    const { cut } = cutPair();
    expect(cut.findings.filter((f) => f.result === "warn" || f.result === "fail")).toEqual([]);
  });

  it("no run: No sequence QA yet, even with deterministic WARNs, which stay visible", () => {
    const { cut } = cutPair();
    expect(assessTransition({ cut, run: null })).toMatchObject({
      state: "no_sequence_qa",
      label: "No sequence QA yet",
    });
    const w = world();
    // 2A → 2B: declared screen direction changes
    const [warned] = cutsOf(w, editOf(w, [videoItem(w, "2A"), videoItem(w, "2B")]));
    const a = assessTransition({ cut: warned, run: null });
    expect(a.state).toBe("no_sequence_qa");
    expect(a.findings).toContainEqual(
      expect.objectContaining({ criterionKey: "cut:declared_direction", result: "warn" }),
    );
    expect(a.counts.warnings).toBe(1);
  });

  it("a deterministic source-integrity FAIL is a critical break even without a run", () => {
    const w = world();
    const [cut] = cutsOf(
      w,
      editOf(w, [videoItem(w, "2A"), videoItem(w, "2B", { durationMs: 3000, outMs: 4000 })]),
    );
    expect(assessTransition({ cut, run: null }).state).toBe("critical_break");
    // intent never covers an integrity failure
    expect(assessTransition({ cut, run: null, intent: intentFor(cut) }).state).toBe("critical_break");
  });

  it("stale beats a recorded critical failure (an old finding is not evidence about the current cut)", () => {
    const { w, a, b, cut, appearance } = lockedPair();
    expect(criterion(cut, appearance).severity).toBe("critical");
    const old = semanticRun(cut, { [appearance]: "fail" });
    const [trimmed] = cutsOf(w, editOf(w, [withTrim(a, 0, 4000), b]));
    expect(assessTransition({ cut: trimmed, run: old })).toMatchObject({ state: "sequence_stale" });
    expect(assessTransition({ cut, run: old }).state).toBe("critical_break");
  });

  it("critical break beats running; running beats needs review", () => {
    const { cut, appearance } = lockedPair();
    expect(assessTransition({ cut, run: semanticRun(cut, { [appearance]: "fail" }, "running") }).state).toBe(
      "critical_break",
    );
    expect(assessTransition({ cut, run: semanticRun(cut, { "cut:axis": "warn" }, "queued") }).state).toBe(
      "analysis_running",
    );
  });

  it("needs review on any uncovered FAIL / WARN; unchecked only when nothing fails and an important criterion is unchecked", () => {
    const { cut } = cutPair();
    expect(assessTransition({ cut, run: semanticRun(cut, { "cut:lighting": "warn" }) }).state).toBe(
      "needs_review",
    );
    expect(assessTransition({ cut, run: semanticRun(cut, { "cut:axis": "fail" }) }).state).toBe(
      "needs_review",
    );
    expect(assessTransition({ cut, run: semanticRun(cut, { "cut:axis": "unchecked" }) })).toMatchObject({
      state: "unchecked_transition",
      label: "Unchecked transition",
    });
    // an unchecked MINOR criterion is not important
    expect(assessTransition({ cut, run: semanticRun(cut, { "cut:lighting": "unchecked" }) }).state).toBe(
      "no_blocking_mismatch",
    );
  });

  it("no blocking mismatch is never called a pass, an approval or perfect continuity", () => {
    const { cut } = cutPair();
    const a = assessTransition({ cut, run: semanticRun(cut) });
    expect(a).toMatchObject({ state: "no_blocking_mismatch", label: "No blocking mismatch found" });
    expect(a.label).not.toMatch(/pass|approv|perfect/i);
  });

  it("intent covers in-scope deviations: every remaining FAIL / WARN covered → Intentional discontinuity accepted", () => {
    const { cut } = cutPair();
    const r = semanticRun(cut, { "cut:lighting": "warn", "cut:axis": "fail" });
    expect(assessTransition({ cut, run: r }).state).toBe("needs_review");
    const all = assessTransition({ cut, run: r, intent: intentFor(cut) });
    expect(all).toMatchObject({
      state: "intentional_accepted",
      intentEffective: true,
      counts: { coveredByIntent: 2, failures: 0, warnings: 0 },
    });
    // a scoped intent leaves an out-of-scope deviation open
    expect(assessTransition({ cut, run: r, intent: intentFor(cut, { scope: ["lighting"] }) }).state).toBe(
      "needs_review",
    );
    // the findings themselves are untouched
    expect(r.findings.filter((x) => x.result !== "pass").map((x) => x.result)).toEqual(["fail", "warn"]);
  });

  it("an edit-fact WARN is never covered by intent", () => {
    const { w, a, b } = cutPair();
    clip(w, "2C", 6000, { approved: true }); // 2C's approval moves away from the pinned clip
    const [cut] = cutsOf(w, editOf(w, [a, b]));
    expect(finding(cut, "cut:source_currentness").result).toBe("warn");
    expect(assessTransition({ cut, run: semanticRun(cut), intent: intentFor(cut) })).toMatchObject({
      state: "needs_review",
      intentEffective: true,
      counts: { warnings: 1, coveredByIntent: 0 },
    });
  });

  it("intent is predecessor-bound: A → B intent never covers C → B; trims keep it; adjacency changes void it", () => {
    const { w, a, b, cut } = cutPair();
    const intent = intentFor(cut);
    expect(cutIntentEffective(intent, cut.address)).toBe(true);
    const c = videoItem(w, "2D");
    const [, cb] = cutsOf(w, editOf(w, [a, c, b]));
    expect(cb.address.rightItemId).toBe(b.id);
    expect(cutIntentEffective(intent, cb.address)).toBe(false);
    const r = semanticRun(cb, { "cut:lighting": "warn" });
    expect(assessTransition({ cut: cb, run: r, intent })).toMatchObject({
      state: "needs_review",
      intentEffective: false,
    });
    // a trim keeps the same address, so the same intent still applies
    const [trimmed] = cutsOf(w, editOf(w, [withTrim(a, 0, 4200), b]));
    expect(cutIntentEffective(intent, trimmed.address)).toBe(true);
  });
});

describe("a current run is composed with the cut's CURRENT deterministic findings", () => {
  it("a currentness WARN that appears after a clean run makes the cut Needs review (the run stays current)", () => {
    const { w, a, b, cut } = cutPair();
    const r = semanticRun(cut);
    expect(assessTransition({ cut, run: r }).state).toBe("no_blocking_mismatch");
    clip(w, "2C", 6000, { approved: true });
    const [now] = cutsOf(w, editOf(w, [a, b]));
    expect(transitionFreshness(r.truth, now).status).toBe("current");
    const assessed = assessTransition({ cut: now, run: r });
    expect(assessed.state).toBe("needs_review");
    expect(assessed.findings).toContainEqual(
      expect.objectContaining({ criterionKey: "cut:source_currentness", result: "warn" }),
    );
  });

  it("a changed stored link after a clean run: the run stays current and cut:link WARN makes it Needs review", () => {
    const { w, a, b, cut } = cutPair();
    const r = semanticRun(cut);
    shotByCode(w.data, "2C").continuity.previousShotId = null;
    const [now] = cutsOf(w, editOf(w, [a, b]));
    expect(transitionFreshness(r.truth, now).status).toBe("current");
    expect(finding(now, "cut:link").result).toBe("warn");
    expect(assessTransition({ cut: now, run: r }).state).toBe("needs_review");
  });

  it("current Shot QA after a clean run: supplying it never stales the run, and its WARN appears", () => {
    const { w, a, b, cut } = cutPair();
    const r = semanticRun(cut);
    const qa = new Map([[(b.visual as { attemptId: string }).attemptId, "critical_mismatch" as const]]);
    const [now] = cutsOf(w, editOf(w, [a, b]), qa);
    expect(now.truth).toEqual(cut.truth);
    const assessed = assessTransition({ cut: now, run: r });
    expect(assessed.state).toBe("needs_review");
    expect(assessed.findings).toContainEqual(
      expect.objectContaining({ criterionKey: "cut:shot_qa", result: "warn" }),
    );
  });

  it("edit facts are outside the criteria fingerprint; declared truth is inside it", () => {
    expect(EDIT_FACT_CRITERIA).toEqual([
      "cut:picture",
      "cut:source_integrity",
      "cut:source_currentness",
      "cut:shot_qa",
      "cut:link",
    ]);
    const { w, a, b, cut } = cutPair();
    shotByCode(w.data, "2C").continuity.timeOfDay = "Dawn";
    const [now] = cutsOf(w, editOf(w, [a, b]));
    expect(transitionFreshness(cut.truth, now).reasons).toEqual([
      "The continuity truth of this cut changed.",
    ]);
  });

  it("a run's frozen deterministic value never replaces the live one; vanished criteria are ignored", () => {
    const w = world();
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2A"), videoItem(w, "2B")]));
    const r = semanticRun(cut);
    r.findings.push(
      {
        criterionKey: "cut:declared_direction",
        category: "screen_direction",
        severity: "major",
        result: "pass",
        intentCoverable: true,
      },
      {
        criterionKey: "cut:gone",
        category: "other",
        severity: "critical",
        result: "fail",
        intentCoverable: false,
      },
    );
    const merged = effectiveTransitionFindings(cut, r);
    expect(merged.map((f) => f.criterionKey)).toEqual(cut.criteria.map((c) => c.key));
    expect(merged.find((f) => f.criterionKey === "cut:declared_direction")?.result).toBe("warn");
    expect(assessTransition({ cut, run: r }).state).toBe("needs_review");
  });

  it("an n_a criterion stays n_a whatever a run says (applicability is Prism's)", () => {
    const w = world();
    const [cut] = cutsOf(w, editOf(w, [videoItem(w, "2E"), videoItem(w, "3A")]));
    const r = semanticRun(cut);
    r.findings.push({
      criterionKey: "cut:axis",
      category: "camera",
      severity: "major",
      result: "fail",
      intentCoverable: true,
    });
    expect(effectiveTransitionFindings(cut, r).find((f) => f.criterionKey === "cut:axis")?.result).toBe(
      "n_a",
    );
  });

  it("a failed run with no findings is never clean: important semantic criteria stay unchecked", () => {
    const { cut } = cutPair();
    const failed: TransitionRun = { truth: cut.truth, analysisStatus: "failed", findings: [] };
    const a = assessTransition({ cut, run: failed });
    expect(a.state).toBe("unchecked_transition");
    expect(a.counts.importantUnchecked).toBeGreaterThan(0);
    expect(a.findings.find((f) => f.criterionKey === "cut:axis")?.result).toBe("unchecked");
    // partial: only the minor criteria answered, still unchecked
    const partial: TransitionRun = {
      ...failed,
      findings: semanticRun(cut).findings.filter((f) => f.severity === "minor"),
    };
    expect(assessTransition({ cut, run: partial }).state).toBe("unchecked_transition");
  });
});

// ───────────────────────── reference relevance ─────────────────────────

describe("the reference fingerprint holds only references an applicable criterion could use", () => {
  const yumeko = (w: World) => w.data.characters.find((c) => c.name === "Yumeko")!;
  const rechecksum = (w: World, ids: string[]) => {
    for (const id of ids) w.data.assets.find((x) => x.id === id)!.checksum = "f".repeat(64);
  };

  it("a one-sided Character's references never stale the cut; a shared Character's do", () => {
    const w = world();
    const items = [videoItem(w, "2A"), videoItem(w, "2B"), videoItem(w, "2E")];
    // 2A → 2B: Yumeko enters (one-sided); 2B → 2E: Yumeko on both sides
    const [oneSided, sharedCut] = cutsOf(w, editOf(w, items));
    expect(oneSided.info).toContainEqual({ kind: "character_presence", message: "Yumeko enters" });
    expect([...oneSided.left.references, ...oneSided.right.references]).toEqual([]);
    const ids = sharedCut.right.references.filter((r) => r.role === "identity").map((r) => r.assetId!);
    expect(ids.length).toBeGreaterThan(0);
    for (const r of sharedCut.right.references)
      expect(r.usedBy).toEqual([`cut:character_appearance:${yumeko(w).id}`]);

    rechecksum(w, ids);
    const [oneSidedAfter, sharedAfter] = cutsOf(w, editOf(w, items));
    expect(oneSidedAfter.truth.referenceFingerprint).toBe(oneSided.truth.referenceFingerprint);
    expect(transitionFreshness(oneSided.truth, oneSidedAfter).status).toBe("current");
    expect(sharedAfter.truth.referenceFingerprint).not.toBe(sharedCut.truth.referenceFingerprint);
    expect(transitionFreshness(sharedCut.truth, sharedAfter).reasons).toEqual([
      "A reference of this cut changed.",
    ]);
  });

  it("a Location View image change stales a cut inside a Scene, never one across a Scene boundary", () => {
    const w = world();
    const img = (label: string) => {
      const a = newUploadAsset(w.data.project.id, { label, width: 1200, height: 900 });
      a.purpose = "location_ref";
      w.data.assets.push(a);
      return a;
    };
    const canopy = locationOf(w.data, "2A");
    const wide = viewFor(w.data, canopy.id, img("wide"), { name: "Canopy Wide", kind: "establishing" });
    const lobby = viewFor(w.data, locationOf(w.data, "3A").id, img("lobby"), {
      name: "Lobby",
      kind: "establishing",
    });
    attachViews(
      w.data,
      [wide, lobby],
      [
        { shotId: shotByCode(w.data, "2D").id, view: wide },
        { shotId: shotByCode(w.data, "2E").id, view: wide },
        { shotId: shotByCode(w.data, "3A").id, view: lobby },
      ],
    );
    const items = [videoItem(w, "2D"), videoItem(w, "2E"), videoItem(w, "3A")];
    const [inside, across] = cutsOf(w, editOf(w, items));
    expect(across.crossesScene).toBe(true);
    expect(inside.right.references.map((r) => r.role)).toContain("location_view");
    expect(across.right.references.map((r) => r.role)).not.toContain("location_view");

    // the same Views, re-imaged
    wide.assetChecksum = "a".repeat(64);
    lobby.assetChecksum = "b".repeat(64);
    const [insideAfter, acrossAfter] = cutsOf(w, editOf(w, items));
    expect(insideAfter.truth.referenceFingerprint).not.toBe(inside.truth.referenceFingerprint);
    expect(acrossAfter.truth.referenceFingerprint).toBe(across.truth.referenceFingerprint);
    expect(transitionFreshness(across.truth, acrossAfter).status).toBe("current");
  });

  it("a Lock serves the shared Character's appearance and wardrobe", () => {
    const { cut, appearance } = lockedPair();
    const lockRef = cut.left.references.find((r) => r.role === "character_lock")!;
    expect(lockRef.usedBy).toEqual(
      [appearance, appearance.replace("character_appearance", "wardrobe")].sort(),
    );
  });

  it("the Production Frame a clip came from is general provenance: kept while any semantic criterion applies", () => {
    const pf: CutReference = {
      side: "left",
      role: "production_frame",
      ref: "pf-1",
      assetId: "asset-pf",
      checksum: "c".repeat(64),
      usedBy: [],
    };
    const w = world();
    const [inside] = cutsOf(w, editOf(w, [videoItem(w, "2B"), videoItem(w, "2C")]));
    const applicable = inside.criteria
      .filter((c) => c.handler === "analyzer" && c.applicability === "applies")
      .map((c) => c.key)
      .sort();
    expect(referencesForCut(inside.criteria, [pf])).toEqual([{ ...pf, usedBy: applicable }]);
    // across a Scene with no shared Character every semantic criterion is n_a: nothing could use it
    const [across] = cutsOf(w, editOf(w, [videoItem(w, "1C"), videoItem(w, "2A")]));
    expect(across.crossesScene).toBe(true);
    expect(across.criteria.filter((c) => c.handler === "analyzer" && c.applicability === "applies")).toEqual(
      [],
    );
    expect(referencesForCut(across.criteria, [pf])).toEqual([]);
  });

  it("reference order is canonical: never ProjectData insertion order", () => {
    const w = world();
    const items = [videoItem(w, "2B"), videoItem(w, "2E")];
    const [cut] = cutsOf(w, editOf(w, items));
    expect(cut.right.references.filter((r) => r.role === "identity").length).toBeGreaterThan(1);
    w.data.identityRefs = [...w.data.identityRefs].reverse();
    const [reordered] = cutsOf(w, editOf(w, items));
    expect(reordered.truth.referenceFingerprint).toBe(cut.truth.referenceFingerprint);
    const refs = [...cut.left.references, ...cut.right.references];
    expect(cutReferenceFingerprint([...refs].reverse(), [])).toBe(cutReferenceFingerprint(refs, []));
  });
});

// ───────────────────────── comparable declarations ─────────────────────────

describe("declared criteria compare only fields declared on BOTH sides", () => {
  const pair = (setup: (w: World) => void, codes: [string, string] = ["4A", "4B"]) => {
    const w = world();
    setup(w);
    return cutsOf(w, editOf(w, [videoItem(w, codes[0]), videoItem(w, codes[1])]))[0];
  };
  const spatial = (w: World, code: string, screen: string, facing: string) => {
    shotByCode(w.data, code).spatial.screenDirection = screen;
    shotByCode(w.data, code).spatial.facingDirection = facing;
  };
  const time = (w: World, code: string, o: { timeOfDay?: string; weather?: string; lighting?: string }) => {
    const c = shotByCode(w.data, code).continuity;
    c.timeOfDay = o.timeOfDay ?? "";
    c.weather = o.weather ?? "";
    c.lighting = o.lighting ?? "";
  };
  const props = (w: World, code: string, propIds: string[], text: string) => {
    shotByCode(w.data, code).propIds = propIds;
    shotByCode(w.data, code).continuity.props = text;
  };

  it("direction: screen on one side and facing on the other is n_a, never a pass", () => {
    const mixed = pair((w) => {
      spatial(w, "4A", "left to right", "");
      spatial(w, "4B", "", "screen right");
    });
    expect(finding(mixed, "cut:declared_direction")).toMatchObject({
      result: "n_a",
      reason: "No comparable direction field is declared on both sides.",
    });
    const same = pair((w) => {
      spatial(w, "4A", "left to right", "");
      spatial(w, "4B", "Left to right", "screen right");
    });
    expect(finding(same, "cut:declared_direction").result).toBe("pass");
    const differs = pair((w) => {
      spatial(w, "4A", "left to right", "");
      spatial(w, "4B", "right to left", "");
    });
    expect(finding(differs, "cut:declared_direction").result).toBe("warn");
  });

  it("time: weather on one side and lighting on the other is n_a, never a pass", () => {
    const mixed = pair((w) => {
      time(w, "4A", { weather: "Rain" });
      time(w, "4B", { lighting: "Hard key from the window" });
    });
    expect(finding(mixed, "cut:declared_time")).toMatchObject({
      result: "n_a",
      reason: "No comparable time of day, weather or lighting field is declared on both sides.",
    });
    const same = pair((w) => {
      time(w, "4A", { timeOfDay: "Night", weather: "Rain" });
      time(w, "4B", { timeOfDay: "night", lighting: "Neon" });
    });
    expect(finding(same, "cut:declared_time")).toMatchObject({
      result: "pass",
      reason: "Same declared value in every comparable field.",
    });
    const differs = pair((w) => {
      time(w, "4A", { weather: "Rain" });
      time(w, "4B", { weather: "Clear" });
    });
    expect(finding(differs, "cut:declared_time").result).toBe("warn");
    expect(finding(differs, "cut:declared_time").reason).toContain("Weather changes: Rain → Clear");
  });

  it("props: an assigned prop set is comparable on its own; free text only when both sides declare it", () => {
    const w0 = world();
    const prop = w0.data.props[0];
    expect(prop).toBeDefined();
    const nothing = pair((w) => {
      props(w, "4A", [], "");
      props(w, "4B", [], "");
    });
    expect(finding(nothing, "cut:declared_props")).toMatchObject({
      result: "n_a",
      reason: "No comparable prop declaration on both sides.",
    });
    const oneText = pair((w) => {
      props(w, "4A", [], "Glass half full");
      props(w, "4B", [], "");
    });
    expect(finding(oneText, "cut:declared_props").result).toBe("n_a");
    const samePropSet = pair((w) => {
      props(w, "4A", [w.data.props[0].id], "");
      props(w, "4B", [w.data.props[0].id], "");
    });
    expect(finding(samePropSet, "cut:declared_props").result).toBe("pass");
    const appears = pair((w) => {
      props(w, "4A", [], "");
      props(w, "4B", [w.data.props[0].id], "");
    });
    expect(finding(appears, "cut:declared_props").result).toBe("warn");
    const textDiffers = pair((w) => {
      props(w, "4A", [], "Glass half full");
      props(w, "4B", [], "Glass empty");
    });
    expect(finding(textDiffers, "cut:declared_props").result).toBe("warn");
  });
});

// ───────────────────────── isolation from Shot QA ─────────────────────────

describe("3A.4A does not touch Shot QA identity", () => {
  it("CONTINUITY_RULES_VERSION stays 3a.1; sequence rules are their own 3a.4", () => {
    expect(CONTINUITY_RULES_VERSION).toBe("3a.1");
    expect(SEQUENCE_RULES_VERSION).toBe("3a.4");
  });

  it("the Shot criteria fingerprint of a fixed criterion list is unchanged (pinned)", () => {
    const criteria: ContinuityCriterion[] = [
      {
        key: "wardrobe:c1",
        category: "wardrobe",
        severity: "major",
        title: "Wardrobe",
        sourceRef: "Look: Formal Black",
        expected: "black gown",
        handler: "analyzer",
        capability: "wardrobe",
        position: 0,
      },
    ];
    expect(criteriaFingerprint(criteria)).toBe(
      "e828975961c846fe638364f070512f84841fbf4afa1d5eb36ba87b502616f1e1",
    );
  });
});
