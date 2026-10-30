import { describe, expect, it } from "vitest";
import { shotByCode } from "@/domain/__tests__/helpers";
import { NOT_CALIBRATED, PLACEHOLDER_REASON, SCENE_CHANGE_REASON } from "@/domain/continuity/sequence";
import { editOf, item, videoItem, world, type World } from "@/domain/continuity/__tests__/cut-fixtures";
import type { EditItem, EpisodeEdit } from "@/domain/edit/model";
import { proposeEpisodeAssembly } from "@/domain/edit/proposal";
import { cutAnchor, cutMarker } from "../cut-marker-model";
import { editPage, proposalPage } from "../episode-edit-model";
import {
  continuityPage,
  EDGE_MEDIA_NOTE,
  NO_EDIT_MESSAGE,
  supervisorLinks,
} from "../sequence-continuity-model";

/**
 * Phase 3A.4B display models: the Continuity Supervisor (the actual cuts of a persisted Episode Edit) and the Episode
 * Edit's incoming-cut markers. Pure: seed data and in-memory edits, no repository, provider or media processing.
 */

const mediaOf = (w: World) => ({ attempts: w.media, bestPointers: [] });
const page = (w: World, edit: EpisodeEdit) =>
  continuityPage({ data: w.data, episode: w.data.episodes[0], edit, media: mediaOf(w) });
const rowsOf = (w: World, items: EditItem[]) => page(w, editOf(w, items)).rows;
const storyboardItem = (w: World, code: string): EditItem => {
  const frame = w.data.frames.find((f) => f.shotId === shotByCode(w.data, code).id && f.assetId)!;
  // a stored still (the seed's frames reference assets without an object)
  w.data.assets.find((a) => a.id === frame.assetId)!.objectPath = `test/${frame.assetId}.png`;
  return item(w.data, code, { kind: "storyboard_frame", storyboardFrameId: frame.id, durationMs: 3000 });
};

describe("Continuity Supervisor model: the persisted edit's actual cuts", () => {
  it("no persisted edit has its own state; the loader never invents cuts (links only)", () => {
    const w = world();
    expect(NO_EDIT_MESSAGE).toBe(
      "Sequence Continuity needs a persisted Episode Edit because the edit determines the actual cuts.",
    );
    expect(supervisorLinks(w.data, w.data.episodes[0])).toEqual({
      edit: "/projects/ojousama/episodes/ep-1/edit",
      sequence: "/projects/ojousama/episodes/ep-1/sequence",
    });
  });

  it("zero or one item: no cuts, no rows, zero counts", () => {
    const w = world();
    expect(rowsOf(w, [])).toEqual([]);
    const one = page(w, editOf(w, [videoItem(w, "2A")]));
    expect(one.rows).toEqual([]);
    expect(one.summary).toEqual({
      cuts: 0,
      criticalBreaks: 0,
      warningCuts: 0,
      semanticUnchecked: 0,
      sceneBoundaries: 0,
      semanticMediaBlocked: 0,
    });
  });

  it("a normal video → video cut: no sequence QA yet, every semantic criterion unchecked (not calibrated), truthful previews", () => {
    const w = world();
    const a = videoItem(w, "2B", { inMs: 1000, outMs: 6000 });
    const b = videoItem(w, "2C", { inMs: 500, outMs: 4500 });
    const [row] = rowsOf(w, [a, b]);
    expect(row).toMatchObject({
      anchor: `cut-${a.id}-${b.id}`,
      title: "2B → 2C",
      state: "no_sequence_qa",
      stateLabel: "No sequence QA yet",
      crossesScene: false,
      mediaEligible: true,
      flags: { hasFail: false, hasWarn: false, hasUnchecked: true },
      attention: [],
    });
    expect(row.anchor).toBe(cutAnchor({ leftItemId: a.id, rightItemId: b.id }));
    expect(row.semantic.length).toBeGreaterThan(0);
    for (const f of row.semantic) {
      expect(f.result).toBe("unchecked");
      expect(f.handler).toBe("analyzer");
      expect(f.reason).toMatch(/is not yet calibrated/);
    }
    expect(row.semantic.find((f) => f.key === "cut:axis")?.reason).toBe(NOT_CALIBRATED("axis"));
    expect(row.semanticUnchecked).toBe(row.semantic.length);
    // previews: the pinned sources through the private asset route; descriptors as text, never "exact" media
    const va = a.visual as { attemptId: string; assetId: string };
    expect(row.left.picture).toMatchObject({ mediaType: "video", mediaUrl: `/api/assets/${va.assetId}` });
    expect(row.left.trim).toBe("Used trim 1.000 s – 6.000 s (source time)");
    expect(row.left.window).toBe(
      "Future edge window 4.000 s – 6.000 s · 2.000 s at 4 fps, audio stripped (cut-edge-static-v1)",
    );
    expect(row.left.edgeFrame).toBe("Last displayed frame at source 5.959 s (computed)");
    expect(row.right.edgeFrame).toBe("First displayed frame at source 0.500 s (computed)");
    expect(JSON.stringify(row)).not.toMatch(/exact (last|first) frame/i);
    expect(row.hasClipEdge).toBe(true);
    expect(EDGE_MEDIA_NOTE).toBe(
      "For generated clips, exact cut-edge media will be available when cut-edge derivation is implemented.",
    );
    // links: Shot Prep, and the pinned attempt's existing Shot QA page
    expect(row.left.shotPrepUrl).toBe(
      `/projects/ojousama/episodes/ep-1/shots/${shotByCode(w.data, "2B").id}`,
    );
    expect(row.left.shotQaUrl).toBe(`/projects/ojousama/generations/${va.attemptId}/continuity`);
    expect(row.topIssue).toMatchObject({ tone: "info" });
  });

  it("rows follow the edit's actual order; a deterministic link WARN shows while the state stays No sequence QA yet", () => {
    const w = world();
    const p = page(w, editOf(w, [videoItem(w, "2E"), videoItem(w, "2B"), videoItem(w, "2C")]));
    expect(p.rows.map((r) => r.title)).toEqual(["2E → 2B", "2B → 2C"]);
    expect(p.info).toEqual(["Edit order differs from the planned sequence."]);
    const [first] = p.rows;
    expect(first.state).toBe("no_sequence_qa");
    expect(first.flags.hasWarn).toBe(true);
    expect(first.attention.map((f) => f.key)).toContain("cut:link");
    expect(first.attention.every((f) => f.handler === "deterministic")).toBe(true);
    expect(first.topIssue?.tone).toBe("warn");
  });

  it("warning counts come from deterministic FINDINGS, never the state", () => {
    const w = world();
    // 2A → 2B: the declared screen direction changes; 2B → 2C is clean
    const p = page(w, editOf(w, [videoItem(w, "2A"), videoItem(w, "2B"), videoItem(w, "2C")]));
    expect(p.rows.map((r) => r.state)).toEqual(["no_sequence_qa", "no_sequence_qa"]);
    expect(p.rows.map((r) => r.flags.hasWarn)).toEqual([true, false]);
    expect(p.rows[0].attention.map((f) => f.key)).toEqual(["cut:declared_direction"]);
    expect(p.rows[0].checks.map((f) => f.result)).not.toContain("warn");
    expect(p.summary.warningCuts).toBe(1);
    expect(p.filterCounts).toMatchObject({ all: 2, warnings: 1, critical: 0 });
  });

  it("an unusable pinned source is a critical break with a FAIL top issue", () => {
    const w = world();
    const bad = videoItem(w, "2B", { durationMs: 3000, outMs: 4000 }); // trim beyond the clip
    const p = page(w, editOf(w, [videoItem(w, "2A"), bad]));
    const [row] = p.rows;
    expect(row).toMatchObject({ state: "critical_break", stateLabel: "Critical continuity break" });
    expect(row.flags.hasFail).toBe(true);
    expect(row.topIssue).toMatchObject({ tone: "fail" });
    expect(row.topIssue?.text).toMatch(/^Pinned sources are valid: The right source is not usable/);
    expect(row.right.usable).toBe(false);
    expect(p.summary.criticalBreaks).toBe(1);
    expect(p.filterCounts.critical).toBe(1);
  });

  it("a Scene boundary: Prism's n_a is shown and never counted as unchecked", () => {
    const w = world();
    const [cross] = rowsOf(w, [videoItem(w, "2E"), videoItem(w, "3A")]);
    expect(cross.crossesScene).toBe(true);
    expect(cross.semantic.find((f) => f.key === "cut:axis")).toMatchObject({
      result: "n_a",
      reason: SCENE_CHANGE_REASON,
    });
    const unchecked = cross.semantic.filter((f) => f.result === "unchecked");
    expect(unchecked.map((f) => f.key.split(":").slice(0, 2).join(":"))).toEqual([
      "cut:character_appearance",
    ]);
    expect(cross.semanticUnchecked).toBe(1);
    expect(cross.flags.hasUnchecked).toBe(true);

    // across a Scene with no shared Character every semantic criterion is n_a: nothing unchecked
    const w2 = world();
    const p = page(w2, editOf(w2, [videoItem(w2, "1C"), videoItem(w2, "2A")]));
    expect(p.rows[0].semantic.every((f) => f.result === "n_a")).toBe(true);
    expect(p.rows[0].flags.hasUnchecked).toBe(false);
    expect(p.summary).toMatchObject({ sceneBoundaries: 1, semanticUnchecked: 0 });
    expect(p.filterCounts).toMatchObject({ scene: 1, unchecked: 0 });
  });

  it("placeholders and empty items: real stills through the asset route, the planning reason, media blocked", () => {
    const w = world();
    const p = page(
      w,
      editOf(w, [
        storyboardItem(w, "2B"),
        item(w.data, "2C", { kind: "none", durationMs: 2000 }),
        videoItem(w, "2D"),
      ]),
    );
    const [a, b] = p.rows;
    expect(a.left.picture.mediaType).toBe("image");
    expect(a.left.picture.mediaUrl).toMatch(/^\/api\/assets\/[0-9a-f-]+$/);
    expect(a.left).toMatchObject({ trim: null, window: null, edgeFrame: null, shotQaUrl: null });
    expect(a.right.picture).toMatchObject({ mediaType: null, mediaUrl: null, source: "No picture yet" });
    expect(a.semantic[0].reason).toContain(PLACEHOLDER_REASON);
    expect(a.mediaEligible).toBe(false);
    expect(b.right.shotQaUrl).not.toBeNull();
    expect(p.summary.semanticMediaBlocked).toBe(2);
    // placeholder → no picture: no generated-clip side, so no exact-edge-media note
    expect(a.hasClipEdge).toBe(false);
    expect(b.hasClipEdge).toBe(true);
    expect(p.filterCounts.media_blocked).toBe(2);
  });
});

describe("Cuts blocked from semantic media: every cut whose media a future analysis could not use", () => {
  it("placeholder → video, no picture → video and unusable video → video are blocked; valid clips are not", () => {
    const w = world();
    const placeholder = page(w, editOf(w, [storyboardItem(w, "2B"), videoItem(w, "2C")]));
    const noPicture = page(
      w,
      editOf(w, [item(w.data, "2B", { kind: "none", durationMs: 2000 }), videoItem(w, "2C")]),
    );
    const unusable = page(
      w,
      editOf(w, [videoItem(w, "2B"), videoItem(w, "2C", { durationMs: 3000, outMs: 4000 })]),
    );
    const valid = page(w, editOf(w, [videoItem(w, "2B"), videoItem(w, "2C")]));
    for (const [p, blocked] of [
      [placeholder, true],
      [noPicture, true],
      [unusable, true],
      [valid, false],
    ] as const) {
      expect(p.rows[0].mediaEligible).toBe(!blocked);
      expect(p.summary.semanticMediaBlocked).toBe(blocked ? 1 : 0);
      // the summary and the Media blocked filter agree
      expect(p.filterCounts.media_blocked).toBe(p.summary.semanticMediaBlocked);
    }
    expect(unusable.rows[0].mediaReasons).toEqual(["The right source is not usable."]);
    // an unusable clip is still a clip: not "no clip on a side"
    expect(unusable.rows[0].hasClipEdge).toBe(true);
  });
});

describe("Episode Edit incoming-cut markers", () => {
  it("first item none; each later item the cut from its predecessor, linking to the Supervisor anchor", () => {
    const w = world();
    const items = [videoItem(w, "2A"), videoItem(w, "2B"), videoItem(w, "2C")];
    const edit = editOf(w, items);
    const rows = editPage(w.data, edit, mediaOf(w)).rows;
    expect(rows[0].incomingCut).toBeUndefined();
    expect(rows.slice(1).map((r) => r.incomingCut?.anchor)).toEqual([
      cutAnchor({ leftItemId: items[0].id, rightItemId: items[1].id }),
      cutAnchor({ leftItemId: items[1].id, rightItemId: items[2].id }),
    ]);
    // the same anchors as the Supervisor rows
    expect(rows.slice(1).map((r) => r.incomingCut?.anchor)).toEqual(page(w, edit).rows.map((r) => r.anchor));
    // 2A → 2B warns (declared direction); 2B → 2C has no deterministic issue: neutral, never a pass
    expect(rows[1].incomingCut).toMatchObject({ tone: "warn", issues: 1 });
    expect(rows[1].incomingCut?.label).toBe(
      "Cut 2A → 2B: 1 deterministic warning. Review this cut in the Continuity Supervisor.",
    );
    expect(rows[2].incomingCut).toMatchObject({ tone: "neutral", issues: 0 });
  });

  it("a current source-integrity failure is the fail tone", () => {
    const w = world();
    const edit = editOf(w, [videoItem(w, "2A"), videoItem(w, "2B", { durationMs: 3000, outMs: 4000 })]);
    expect(editPage(w.data, edit, mediaOf(w)).rows[1].incomingCut).toMatchObject({ tone: "fail" });
  });

  it("a proposal is not an edit: no cut markers", () => {
    const w = world();
    const episodeId = w.data.episodes[0].id;
    const media = mediaOf(w);
    const proposal = proposalPage(w.data, proposeEpisodeAssembly(w.data, episodeId, media), media);
    expect(proposal.rows.length).toBeGreaterThan(1);
    expect(proposal.rows.every((r) => r.incomingCut === undefined)).toBe(true);
  });

  it("cutMarker counts current deterministic FAIL + WARN only", () => {
    const w = world();
    const [row] = page(w, editOf(w, [videoItem(w, "2E"), videoItem(w, "2B")])).rows;
    const edit = editOf(w, [videoItem(w, "2E"), videoItem(w, "2B")]);
    const marker = editPage(w.data, edit, mediaOf(w)).rows[1].incomingCut!;
    expect(marker.issues).toBe(row.attention.length);
    expect(typeof cutMarker).toBe("function");
  });
});

describe("3A.4C: declared cut intent in the Supervisor", () => {
  const declare = (e: EpisodeEdit, right: number): EpisodeEdit => ({
    ...e,
    items: e.items.map((it, i) =>
      i === right
        ? {
            ...it,
            incomingCutIntent: {
              fromItemId: e.items[right - 1]!.id,
              kinds: ["time_jump", "lighting_transition"],
              scope: [],
              note: "Hours later; the light changes on purpose.",
              declaredBy: "11111111-2222-4333-8444-555555555555",
              declaredAt: "2026-10-29T12:00:00.000Z",
            },
          }
        : it,
    ),
  });

  it("no intent: null; an effective intent is shown with kinds, scope and note, and the state is unchanged", () => {
    const w = world();
    const e = editOf(w, [videoItem(w, "2A"), videoItem(w, "2B"), videoItem(w, "2C")]);
    const plain = page(w, e);
    expect(plain.rows.map((r) => r.intent)).toEqual([null, null]);
    const withIntent = page(w, declare(e, 1));
    expect(withIntent.rows[0]!.intent).toMatchObject({
      effective: true,
      kinds: ["Time jump", "Lighting transition"],
      scope: ["Every continuity category"],
      note: "Hours later; the light changes on purpose.",
    });
    expect(withIntent.rows[1]!.intent).toBeNull();
    // no semantic run exists: intent never fabricates "Intentional discontinuity accepted"
    expect(withIntent.rows.map((r) => r.state)).toEqual(plain.rows.map((r) => r.state));
    expect(withIntent.rows[0]!.stateLabel).toBe("No sequence QA yet");
    // and findings are untouched (the declared direction WARN of 2A → 2B stays)
    expect(withIntent.rows[0]!.attention).toEqual(plain.rows[0]!.attention);
    expect(withIntent.projectSlug).toBe("ojousama");
  });
});
