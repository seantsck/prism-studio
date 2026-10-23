import { describe, expect, it } from "vitest";
import { buildAnimaticTimeline } from "@/domain/animatic";
import { buildShotContext, shotOrder } from "@/domain/context";
import { approvalSnapshot, computeShotParts, storyboardFreshness } from "@/domain/fingerprint";
import { candidateInputStaleness } from "@/domain/generated-production-frame";
import { assembleGenerationPackage, PACKAGE_SCHEMA_VERSION } from "@/domain/generation-package";
import { reorderShotsInScene, ReorderError } from "@/domain/ordering";
import { productionFrameFreshness, type ProductionFrame } from "@/domain/production-frame";
import type { ProjectData, Shot } from "@/domain/schemas";
import {
  buildShotSequence,
  planSequenceLinkSync,
  SEQUENCE_CHANGED_MESSAGE,
  sequenceLinkChanges,
  sequenceLinkPreviewKey,
  type ShotSequenceTransition,
} from "@/domain/shot-sequence";
import { addImage, assignLook, attachLocks, lockFor, yumekoIvory } from "./character-continuity-fixtures";
import { seed, shotByCode } from "./helpers";
import { locationOf, attachViews, viewFor } from "./location-view-fixtures";
import { attach, draftFor, newUploadAsset } from "./production-frame-fixtures";

/**
 * Phase 2G.5 Shot Sequence Board: a pure projection of existing production truth. Fictional seed data, in memory: no
 * persistence, provider, AI analysis, 3D set or GPU.
 */

const epOf = (data: ProjectData) => data.episodes[0].id;
const seqOf = (data: ProjectData) => buildShotSequence(data, epOf(data));
const itemOf = (data: ProjectData, code: string) => seqOf(data).shots.find((s) => s.shotCode === code)!;
const transitionTo = (data: ProjectData, code: string): ShotSequenceTransition =>
  seqOf(data).transitions.find((t) => t.toShotCode === code)!;
const id = (data: ProjectData, code: string) => shotByCode(data, code).id;

/** A selected, fresh Production Frame on Shot `code` (a production-shaped 1912×800 upload). */
function selectFrame(data: ProjectData, code: string, frames: ProductionFrame[] = []): ProductionFrame {
  const asset = newUploadAsset(data.project.id, { label: `pf-${code}` });
  data.assets.push(asset);
  const pf: ProductionFrame = { ...draftFor(data, code, { asset }), version: 1 };
  attach(data, [...frames, pf], pf);
  return pf;
}

/** Replaces the Shots in `data` (what a repository save does). */
function save(data: ProjectData, shots: Shot[]) {
  const next = new Map(shots.map((s) => [s.id, s]));
  data.shots = data.shots.map((s) => next.get(s.id) ?? s);
}

/** Moves `code` to `index` within its Scene with the EXISTING ordering rules (what reorderShots does). */
function reorder(data: ProjectData, code: string, index: number) {
  const shot = shotByCode(data, code);
  save(
    data,
    reorderShotsInScene(
      data.shots.filter((s) => s.sceneId === shot.sceneId),
      shot.id,
      index,
    ),
  );
}

// ───────────────────────── visual priority ─────────────────────────

describe("canonical display visual: Production Frame first, never pretending a Storyboard is one", () => {
  it("selected fresh PF + approved Storyboard: the Production Frame is shown", () => {
    const data = seed();
    expect(shotByCode(data, "3A")).toBeTruthy();
    const pf = selectFrame(data, "3A");
    const item = itemOf(data, "3A");
    expect(item.storyboard.approved).not.toBeNull();
    expect(item.visual).toMatchObject({ kind: "production_frame", assetId: pf.assetId, freshness: "fresh" });
    expect(item.productionFrame).toMatchObject({
      id: pf.id,
      version: 1,
      source: "upload",
      status: "current",
    });
    expect(item.health).toBe("current_production_frame");
  });

  it("no PF + approved Storyboard: Storyboard FALLBACK, labelled as such", () => {
    const data = seed();
    const item = itemOf(data, "1A");
    expect(item.productionFrame).toBeNull();
    expect(item.visual.kind).toBe("approved_storyboard");
    expect(item.health).toBe("storyboard_fallback");
  });

  it("no PF + only an unapproved Storyboard: DRAFT Storyboard (not canonical)", () => {
    const data = seed();
    const item = itemOf(data, "4A");
    expect(item.storyboard.approved).toBeNull();
    expect(item.visual.kind).toBe("draft_storyboard");
    expect(item.health).toBe("draft_storyboard_only");
  });

  it("nothing: a placeholder (no image)", () => {
    const data = seed();
    const item = itemOf(data, "2A");
    expect(item.visual).toMatchObject({ kind: "none", assetId: null });
    expect(item.health).toBe("missing_visual");
  });

  it("a STALE selected PF stays the displayed visual (the Storyboard never silently replaces it)", () => {
    const data = seed();
    const pf = selectFrame(data, "3A");
    shotByCode(data, "3A").composition.shotSize = "Extreme close-up";
    const item = itemOf(data, "3A");
    expect(item.visual).toMatchObject({ kind: "production_frame", assetId: pf.assetId, freshness: "stale" });
    expect(item.visual.changedParts).toContain("camera");
    expect(item.productionFrame?.status).toBe("stale");
    expect(item.health).toBe("stale_production_frame");
    // the same algorithm as everywhere else: no second freshness model
    expect(item.productionFrame?.changedParts).toEqual(
      productionFrameFreshness(buildShotContext(data, pf.shotId), pf).changedParts,
    );
  });

  it("a generated PF shows its frozen attempt provider / model when the attempt resolves; still understandable when not", () => {
    const data = seed();
    const asset = newUploadAsset(data.project.id, { label: "gen" });
    data.assets.push(asset);
    const pf: ProductionFrame = {
      ...draftFor(data, "3A", {
        asset,
        source: "generation_output",
        sourceGenerationAttemptId: "missing-attempt",
      }),
      version: 1,
    };
    attach(data, [pf], pf);
    expect(itemOf(data, "3A").productionFrame).toMatchObject({
      source: "generation_output",
      generated: null,
    });
  });
});

// ───────────────────────── order, grouping, runtime, summary ─────────────────────────

describe("the actual editorial sequence", () => {
  it("order is exactly shotOrder (Scene order, then Shot order), never previousShotId", () => {
    const data = seed();
    // move Scene 2 after Scene 6 and scramble a stored link: the order follows the Scenes, not the links
    data.scenes.find((s) => s.sceneNumber === "2")!.order = 99;
    shotByCode(data, "3A").continuity.previousShotId = id(data, "1A");
    const expected = data.shots.filter((s) => s.episodeId === epOf(data)).sort(shotOrder(data));
    const seq = seqOf(data);
    expect(seq.shots.map((s) => s.shotId)).toEqual(expected.map((s) => s.id));
    expect(seq.shots.map((s) => s.sequenceIndex)).toEqual(expected.map((_, i) => i));
    // Scene grouping data is on every item; the cross-Scene transition is still described
    expect(seq.shots.slice(0, 4).map((s) => s.sceneNumber)).toEqual(["1", "1", "1", "3"]);
    expect(transitionTo(data, "3A")).toMatchObject({ fromShotCode: "1C", crossesScene: true });
  });

  it("runtime and per-Shot timing are the Animatic's own (no second duration model)", () => {
    const data = seed();
    const seq = seqOf(data);
    const timeline = buildAnimaticTimeline(data, epOf(data));
    expect(seq.summary.runtimeMs).toBe(timeline.totalMs);
    expect(seq.shots.map((s) => [s.shotId, s.startMs, s.durationMs])).toEqual(
      timeline.clips.map((c) => [c.shotId, c.startMs, c.durationMs]),
    );
    reorder(data, "1C", 0);
    const after = seqOf(data);
    expect(after.summary.runtimeMs).toBe(buildAnimaticTimeline(data, epOf(data)).totalMs);
    expect(after.shots.map((s) => s.shotId)).toEqual(
      buildAnimaticTimeline(data, epOf(data)).clips.map((c) => c.shotId),
    );
  });

  it("summary totals", () => {
    const data = seed();
    selectFrame(data, "3A");
    const s = seqOf(data).summary;
    expect(s).toMatchObject({
      shots: 14,
      currentProductionFrames: 1,
      staleProductionFrames: 0,
      missingProductionFrames: 13,
      linkMismatches: 0,
      integrityBlockedShots: 0,
    });
    // 10 Shots with only an approved / draft Storyboard, 3 (2A, 4B, 6A) with nothing at all
    expect(s.storyboardOnlyShots + s.noVisualShots).toBe(13);
    expect(s.noVisualShots).toBe(3);
  });

  it("the seed sequence has ZERO automatic failures: every difference is a change for human review", () => {
    const data = seed();
    const seq = seqOf(data);
    expect(seq.transitions).toHaveLength(13);
    expect(seq.transitions.flatMap((t) => t.changes).filter((c) => c.severity === "error")).toEqual([]);
    expect(seq.transitions.every((t) => t.linkStatus === "synced")).toBe(true);
  });
});

// ───────────────────────── transitions ─────────────────────────

describe("transitions describe changes; only a sequence-link mismatch is an error", () => {
  it("stored previousShotId ≠ actual previous Shot: LINK MISMATCH on that cut", () => {
    const data = seed();
    shotByCode(data, "1C").continuity.previousShotId = id(data, "1A");
    const t = transitionTo(data, "1C");
    expect(t).toMatchObject({
      fromShotCode: "1B",
      linkStatus: "wrong",
      expectedPreviousShotId: id(data, "1B"),
      storedPreviousShotId: id(data, "1A"),
    });
    expect(t.changes.filter((c) => c.severity === "error").map((c) => c.category)).toEqual(["sequence_link"]);
    expect(itemOf(data, "1C").link).toMatchObject({ status: "wrong", storedPreviousShotId: id(data, "1A") });
    expect(seqOf(data).summary.linkMismatches).toBe(1);
  });

  it("a missing link and a non-null link on the FIRST Shot are mismatches too", () => {
    const data = seed();
    shotByCode(data, "1B").continuity.previousShotId = null;
    shotByCode(data, "1A").continuity.previousShotId = id(data, "1C");
    expect(itemOf(data, "1B").link.status).toBe("missing");
    expect(itemOf(data, "1A").link).toMatchObject({ status: "wrong", expectedPreviousShotId: null });
    expect(seqOf(data).summary.linkMismatches).toBe(2);
  });

  it("Location / Location View: same + same = stable; same Location, View A → B = view change; Location A → B = location change", () => {
    const data = seed();
    const canopy = locationOf(data, "2A");
    const img = (label: string) => {
      const a = newUploadAsset(data.project.id, { label, width: 1200, height: 900 });
      a.purpose = "location_ref";
      data.assets.push(a);
      return a;
    };
    const wide = viewFor(data, canopy.id, img("wide"), { name: "Canopy Wide", kind: "establishing" });
    const door = viewFor(data, canopy.id, img("door"), { name: "Doorway", kind: "entrance" });
    attachViews(
      data,
      [wide, door],
      [
        { shotId: id(data, "2A"), view: wide },
        { shotId: id(data, "2B"), view: wide },
        { shotId: id(data, "2C"), view: door },
      ],
    );
    expect(itemOf(data, "2A").locationView).toEqual({ id: wide.id, name: "Canopy Wide" });
    expect(transitionTo(data, "2B").stable.map((f) => f.category)).toContain("location_view");
    expect(transitionTo(data, "2B").changes.filter((c) => c.category.startsWith("location"))).toEqual([]);
    expect(transitionTo(data, "2C").changes).toContainEqual(
      expect.objectContaining({
        category: "location_view",
        severity: "change",
        from: "Canopy Wide",
        to: "Doorway",
      }),
    );
    // 2C has a View, 2D has none: nothing is inferred
    expect(transitionTo(data, "2D").changes.filter((c) => c.category.startsWith("location"))).toEqual([]);
    expect(transitionTo(data, "2A").changes).toContainEqual(
      expect.objectContaining({ category: "location", severity: "change" }),
    );
  });

  it("Character entry / exit is informational", () => {
    const data = seed();
    expect(transitionTo(data, "4B").changes).toContainEqual(
      expect.objectContaining({ category: "characters", severity: "change", message: "Takumi enters" }),
    );
    const c = transitionTo(data, "4C")
      .changes.filter((x) => x.category === "characters")
      .map((x) => x.message);
    expect(c).toEqual(["Takumi exits", "Yumeko enters"]);
  });

  it("Character Continuity: same Lock = stable; Lock A → B = Lock change; Lock → live = authority change; never an error", () => {
    const data = seed();
    const { ivory } = yumekoIvory(data, "4C");
    assignLook(data, "5A", "Yumeko", ivory);
    const lockA = lockFor(data, "Yumeko", ivory, { name: "Ivory Suit v1" });
    attachLocks(
      data,
      [lockA],
      [
        { code: "4C", lock: lockA },
        { code: "5A", lock: lockA },
      ],
    );
    expect(itemOf(data, "4C").characters[0]).toMatchObject({
      name: "Yumeko",
      authority: "lock",
      lock: { id: lockA.id, name: "Ivory Suit v1" },
    });
    expect(transitionTo(data, "5A").stable).toContainEqual(
      expect.objectContaining({
        category: "character_continuity",
        message: 'Yumeko: same Continuity Lock "Ivory Suit v1"',
      }),
    );

    ivory.hair = "loose waves";
    const lockB = lockFor(data, "Yumeko", ivory, { name: "Ivory Suit v2" });
    attachLocks(
      data,
      [lockA, lockB],
      [
        { code: "4C", lock: lockA },
        { code: "5A", lock: lockB },
      ],
    );
    expect(transitionTo(data, "5A").changes).toContainEqual(
      expect.objectContaining({
        category: "character_continuity",
        severity: "change",
        message: 'Yumeko: Continuity Lock "Ivory Suit v1" → "Ivory Suit v2"',
      }),
    );

    attachLocks(data, [lockA], [{ code: "4C", lock: lockA }]);
    const t = transitionTo(data, "5A");
    expect(t.changes).toContainEqual(
      expect.objectContaining({ category: "character_continuity", severity: "change" }),
    );
    expect(t.changes.find((c) => c.category === "character_continuity")!.message).toContain(
      "appearance authority changes",
    );
    expect(itemOf(data, "5A").characters[0]).toMatchObject({
      authority: "live",
      lock: null,
      lookName: "Ivory Suit",
    });
    expect(t.changes.filter((c) => c.severity === "error")).toEqual([]);
  });

  it("a locked Shot is compared by its Lock, never by today's library; Look.locked is not a Continuity Lock", () => {
    const data = seed();
    const { ivory } = yumekoIvory(data, "4C");
    assignLook(data, "5A", "Yumeko", ivory);
    ivory.locked = true; // the library's Look flag
    expect(itemOf(data, "4C").characters[0]).toMatchObject({ authority: "live", lock: null });
    const lockA = lockFor(data, "Yumeko", ivory, { name: "Ivory Suit v1" });
    attachLocks(
      data,
      [lockA],
      [
        { code: "4C", lock: lockA },
        { code: "5A", lock: lockA },
      ],
    );
    ivory.name = "Renamed in the library";
    expect(itemOf(data, "4C").characters[0].lookName).toBe("Ivory Suit");
    expect(transitionTo(data, "5A").stable.map((f) => f.category)).toContain("character_continuity");
  });

  it("both live: a different Look is a Look change (informational)", () => {
    const data = seed();
    const { ivory } = yumekoIvory(data, "5A");
    expect(ivory).toBeTruthy();
    expect(transitionTo(data, "5A").changes).toContainEqual(
      expect.objectContaining({ category: "look", severity: "change", to: "Ivory Suit" }),
    );
  });

  it("screen direction left-to-right → right-to-left is a human-review note, NOT a failure", () => {
    const data = seed();
    shotByCode(data, "1C").spatial.screenDirection = "Right to left";
    const t = transitionTo(data, "1C");
    const sd = t.changes.find((c) => c.category === "screen_direction")!;
    expect(sd).toMatchObject({ severity: "change", from: "Left to right", to: "Right to left" });
    expect(sd.message).toBe("Screen direction changes: Left to right → Right to left (needs human review)");
    expect(t.changes.filter((c) => c.severity === "error")).toEqual([]);
  });

  it("weather / time-of-day changes are surfaced, never marked wrong; the Scene boundary is visible", () => {
    const data = seed();
    const t = transitionTo(data, "3A");
    expect(t.crossesScene).toBe(true);
    expect(t.changes.map((c) => c.category)).toEqual(expect.arrayContaining(["scene", "weather"]));
    shotByCode(data, "3A").continuity.timeOfDay = "Dawn";
    expect(transitionTo(data, "3A").changes).toContainEqual(
      expect.objectContaining({ category: "time_of_day", severity: "change", from: "Night", to: "Dawn" }),
    );
    expect(transitionTo(data, "3A").changes.filter((c) => c.severity === "error")).toEqual([]);
  });

  it("an invalid Character Continuity selection is the Shot's integrity blocker, never a silent live fallback", () => {
    const data = seed();
    const { ivory } = yumekoIvory(data, "4C");
    const lockA = lockFor(data, "Yumeko", ivory);
    attachLocks(data, [lockA], [{ code: "4C", lock: lockA }]);
    shotByCode(data, "4C").characters[0].lookId = null; // the assignment no longer matches the Lock's Look
    const item = itemOf(data, "4C");
    expect(item.health).toBe("integrity_blocked");
    expect(item.integrityIssues.map((i) => i.code)).toEqual(["character_continuity"]);
    expect(item.characters[0].issue).not.toBeNull();
    expect(seqOf(data).summary.integrityBlockedShots).toBe(1);
  });
});

// ───────────────────────── reorder + explicit link sync ─────────────────────────

describe("reorder never touches links; the explicit sync is previewed, exact, atomic and refuses locked Shots", () => {
  it("reorder within a Scene keeps every stored link: the mismatches it creates are shown, not auto-synced", () => {
    const data = seed();
    const before = data.shots.map((s) => [s.id, s.continuity.previousShotId]);
    reorder(data, "1C", 1); // 1A, 1C, 1B
    expect(data.shots.map((s) => [s.id, s.continuity.previousShotId])).toEqual(before);
    expect(
      seqOf(data)
        .shots.slice(0, 3)
        .map((s) => s.shotCode),
    ).toEqual(["1A", "1C", "1B"]);
    expect(
      sequenceLinkChanges(data, epOf(data)).map((c) => [
        c.shotCode,
        c.fromPreviousShotCode,
        c.toPreviousShotCode,
      ]),
    ).toEqual([
      ["1C", "1B", "1A"],
      ["1B", "1A", "1C"],
      ["2A", "1C", "1B"],
    ]);
    expect(seqOf(data).summary.linkMismatches).toBe(3);
  });

  it("existing reorder rules: same Scene only, locked Shots pinned", () => {
    const data = seed();
    shotByCode(data, "1B").status = "locked";
    expect(() => reorder(data, "1B", 0)).toThrow(ReorderError);
    reorder(data, "1C", 0); // 1C lands on the first unlocked slot; 1B stays put
    expect(
      seqOf(data)
        .shots.slice(0, 3)
        .map((s) => s.shotCode),
    ).toEqual(["1C", "1B", "1A"]);
    const scene2 = data.shots.filter((s) => s.sceneId === shotByCode(data, "2A").sceneId);
    expect(() => reorderShotsInScene([...scene2, shotByCode(data, "1A")], id(data, "1A"), 0)).toThrow(
      ReorderError,
    );
  });

  it("sync: only the mismatched Shot changes, and only its previousShotId", () => {
    const data = seed();
    shotByCode(data, "1C").continuity.previousShotId = id(data, "1A");
    const key = sequenceLinkPreviewKey(data, epOf(data));
    const plan = planSequenceLinkSync(data, epOf(data), key);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.changes.map((c) => c.shotCode)).toEqual(["1C"]);
    expect(plan.shots).toHaveLength(1);
    const original = shotByCode(data, "1C");
    expect(plan.shots[0]).toEqual({
      ...original,
      continuity: { ...original.continuity, previousShotId: id(data, "1B") },
    });
    save(data, plan.shots);
    expect(shotByCode(data, "1C").continuity.previousShotId).toBe(id(data, "1B"));
    expect(sequenceLinkChanges(data, epOf(data))).toEqual([]);
    expect(seqOf(data).summary.linkMismatches).toBe(0);
  });

  it("after a sync, existing freshness marks the dependent Storyboard / Production Frame / candidate stale by itself", () => {
    const data = seed();
    reorder(data, "1C", 1); // 1A, 1C, 1B: 1C must now follow 1A
    const ctx = () => buildShotContext(data, id(data, "1C"));
    const pf = selectFrame(data, "1C");
    const approved = approvalSnapshot(ctx());
    const candidate = {
      id: "cand",
      request: { purpose: "production_frame", references: [] },
      packageSnapshot: JSON.parse(JSON.stringify(assembleGenerationPackage(ctx(), new Date(T0)))) as Record<
        string,
        unknown
      >,
    };
    expect(productionFrameFreshness(ctx(), pf).status).toBe("fresh");
    const sbFresh = () =>
      storyboardFreshness(ctx(), {
        approvedFingerprint: approved.fingerprint,
        approvedSnapshot: approved.snapshot,
      });
    expect(sbFresh().status).toBe("fresh");
    const continuityBefore = computeShotParts(ctx()).continuity;

    const plan = planSequenceLinkSync(data, epOf(data), sequenceLinkPreviewKey(data, epOf(data)));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    save(data, plan.shots);
    // nothing was flagged by hand: the changed `continuity` part does it
    expect(computeShotParts(ctx()).continuity).not.toBe(continuityBefore);
    expect(productionFrameFreshness(ctx(), pf)).toMatchObject({
      status: "stale",
      changedParts: ["continuity"],
    });
    expect(sbFresh()).toMatchObject({ status: "stale", changedParts: ["continuity"] });
    expect(candidateInputStaleness(ctx(), candidate)?.changed).toEqual(["continuity"]);
    expect(itemOf(data, "1C").health).toBe("stale_production_frame");
    // the package is still v5 and simply reflects the new link
    const pkg = assembleGenerationPackage(ctx(), new Date(T0));
    expect(PACKAGE_SCHEMA_VERSION).toBe(5);
    expect(pkg.packageSchemaVersion).toBe(5);
  });

  it("a mismatch that would change a LOCKED Shot refuses the whole sync; nothing else changes", () => {
    const data = seed();
    shotByCode(data, "1C").continuity.previousShotId = id(data, "1A");
    shotByCode(data, "1C").status = "locked";
    shotByCode(data, "2B").continuity.previousShotId = id(data, "1A");
    const plan = planSequenceLinkSync(data, epOf(data), sequenceLinkPreviewKey(data, epOf(data)));
    expect(plan).toMatchObject({ ok: false, reason: "locked" });
    expect(!plan.ok && plan.message).toContain("1C");
    expect(!plan.ok && plan.message).not.toContain("2B");
    expect(sequenceLinkChanges(data, epOf(data)).map((c) => [c.shotCode, c.locked])).toEqual([
      ["1C", true],
      ["2B", false],
    ]);
  });

  it("a confirmation from an outdated preview is refused (the sequence changed underneath it)", () => {
    const data = seed();
    shotByCode(data, "1C").continuity.previousShotId = id(data, "1A");
    const key = sequenceLinkPreviewKey(data, epOf(data));
    reorder(data, "2C", 0);
    expect(planSequenceLinkSync(data, epOf(data), key)).toEqual({
      ok: false,
      reason: "stale_preview",
      message: SEQUENCE_CHANGED_MESSAGE,
    });
    // locking a Shot also invalidates the preview
    const data2 = seed();
    shotByCode(data2, "1C").continuity.previousShotId = id(data2, "1A");
    const key2 = sequenceLinkPreviewKey(data2, epOf(data2));
    shotByCode(data2, "1C").status = "locked";
    expect(planSequenceLinkSync(data2, epOf(data2), key2)).toMatchObject({ reason: "stale_preview" });
  });

  it("nothing to sync is reported, not written", () => {
    const data = seed();
    expect(planSequenceLinkSync(data, epOf(data), sequenceLinkPreviewKey(data, epOf(data)))).toMatchObject({
      ok: false,
      reason: "nothing_to_sync",
    });
  });

  it("the preview key ignores everything but order, stored links and locked state", () => {
    const data = seed();
    const key = sequenceLinkPreviewKey(data, epOf(data));
    shotByCode(data, "2B").title = "Retitled";
    addImage(data, "unrelated");
    expect(sequenceLinkPreviewKey(data, epOf(data))).toBe(key);
  });
});

const T0 = "2026-10-23T00:00:00Z";
