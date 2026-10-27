import { describe, expect, it } from "vitest";
import { MockAnalysisProvider } from "@/continuity/analysis/mock-provider";
import { buildShotContext } from "@/domain/context";
import { buildAnalysisPlan, type PlannerAnalyzer } from "@/domain/continuity/analysis/plan";
import type { AnalysisMedia } from "@/domain/continuity/analysis/types";
import {
  buildCriteria,
  buildReferenceSet,
  criteriaFingerprint,
  frozenShotTruth,
  NO_FROZEN_TRUTH,
  type CriteriaContext,
} from "@/domain/continuity/criteria";
import { CONTINUITY_RULES_VERSION, type ContinuityCriterion } from "@/domain/continuity/model";
import { staleness } from "@/domain/continuity/status";
import { assembleGenerationPackage, type GenerationPackage } from "@/domain/generation-package";
import { fingerprint } from "@/domain/hash";
import type { ProductionFrame } from "@/domain/production-frame";
import type { ProjectData } from "@/domain/schemas";
import {
  attachLocks,
  lockFor,
  uploadIdentity,
  yumekoIvory,
} from "@/domain/__tests__/character-continuity-fixtures";
import { seed, shotByCode } from "@/domain/__tests__/helpers";
import { attachViews, locationOf, viewFor } from "@/domain/__tests__/location-view-fixtures";
import {
  attach,
  draftFor,
  newUploadAsset,
  seedWithFrame,
} from "@/domain/__tests__/production-frame-fixtures";

/**
 * Phase 3A.1 Shot fidelity criteria: Production Frame / Location View fidelity from the attempt's FROZEN package,
 * camera framing vs movement, honest constraint routing, freshness when the Shot moves on. Pure; no provider.
 */

const NOW = new Date("2026-10-27T00:00:00Z");
const pkgOf = (data: ProjectData, code: string) =>
  assembleGenerationPackage(buildShotContext(data, shotByCode(data, code).id), NOW);
const ANIMATE = { purpose: "animate_production_frame" };
const GENERIC = { purpose: "shot_output" };

const ctx = (pkg: GenerationPackage, extra: Partial<CriteriaContext> = {}): CriteriaContext => ({
  pkg,
  adaptation: null,
  protectedComposition: [],
  deliverySize: null,
  ...extra,
});
const byKey = (cs: ContinuityCriterion[], key: string) => cs.find((c) => c.key === key);

/** A seed whose Shot `code` has a selected Doorway Location View. */
function seedWithView(code = "2A") {
  const data = seed();
  const location = locationOf(data, code);
  const asset = newUploadAsset(data.project.id, { label: "doorway", width: 1024, height: 768 });
  asset.purpose = "location_ref";
  data.assets.push(asset);
  const view = viewFor(data, location.id, asset, {
    name: "Doorway",
    kind: "entrance",
    entranceId: location.entrances[0]?.id ?? null,
    zoneId: location.zones[0]?.id ?? null,
    viewpointDescription: "from the revolving doors toward the red carpet",
    orientation: "south-facing",
  });
  attachViews(data, [view], [{ shotId: shotByCode(data, code).id, view }]);
  return { data, location, asset, view };
}

const media = (
  m: Partial<AnalysisMedia> & Pick<AnalysisMedia, "inputId" | "kind" | "role">,
): AnalysisMedia => ({
  label: m.role,
  assetId: `asset-${m.inputId}`,
  checksum: null,
  mime: "image/png",
  width: 640,
  height: 360,
  byteSize: 1000,
  durationMs: null,
  atMs: null,
  ...m,
});
const OUTPUT_FRAMES = [0, 2500].map((at) =>
  media({ inputId: `frame:${at}`, kind: "output_frame", role: "output_frame", atMs: at }),
);
const mock = (): PlannerAnalyzer => new MockAnalysisProvider().plannerView();

describe("frozen Shot truth is read by value from the attempt's package", () => {
  it("older / empty packages carry none: nothing is invented", () => {
    expect(frozenShotTruth({ packageSnapshot: {} })).toEqual(NO_FROZEN_TRUTH);
    expect(frozenShotTruth({ packageSnapshot: null })).toEqual(NO_FROZEN_TRUTH);
    expect(
      frozenShotTruth({ packageSnapshot: { references: { productionFrame: { assetId: "" } } } }),
    ).toEqual(NO_FROZEN_TRUTH);
  });

  it("reads the Production Frame (asset + checksum + version) and the animation purpose", () => {
    const { data, asset, frame } = seedWithFrame("3A");
    const pkg = pkgOf(data, "3A");
    const f = frozenShotTruth({ packageSnapshot: pkg, request: ANIMATE });
    expect(f.productionFrame).toEqual({
      frameId: frame.id,
      assetId: asset.id,
      version: 1,
      checksum: asset.checksum,
    });
    expect(f.animation).toBe(true);
    expect(frozenShotTruth({ packageSnapshot: pkg, request: GENERIC }).animation).toBe(false);
  });
});

describe("Production Frame fidelity criterion", () => {
  it("exists only when the attempt was generated from a Production Frame", () => {
    const plain = buildCriteria(ctx(pkgOf(seed(), "3A"), { frozen: NO_FROZEN_TRUTH }));
    expect(byKey(plain, "production_frame")).toBeUndefined();
    const { data } = seedWithFrame("3A");
    const pkg = pkgOf(data, "3A");
    // a Shot with a PF selected TODAY but an attempt not generated from one: no fidelity criterion
    expect(byKey(buildCriteria(ctx(pkg)), "production_frame")).toBeUndefined();
    const cs = buildCriteria(
      ctx(pkg, { frozen: frozenShotTruth({ packageSnapshot: pkg, request: GENERIC }) }),
    );
    expect(byKey(cs, "production_frame")).toMatchObject({
      category: "composition",
      severity: "major",
      handler: "analyzer",
      capability: "composition",
      referenceRoles: ["production_frame"],
      title: "Production Frame v1 fidelity",
    });
  });

  it("image-to-video: the opening image must preserve the exact first frame (critical)", () => {
    const { data } = seedWithFrame("3A");
    const pkg = pkgOf(data, "3A");
    const c = byKey(
      buildCriteria(ctx(pkg, { frozen: frozenShotTruth({ packageSnapshot: pkg, request: ANIMATE }) })),
      "production_frame",
    )!;
    expect(c.severity).toBe("critical");
    expect(c.title).toBe("Opening image — Production Frame v1");
    expect(c.expected).toMatch(/opening image preserves Production Frame v1/);
    expect(c.sourceRef).toMatch(/exact first frame/);
  });

  it("judges against the FROZEN frame, never today's selection; selecting another frame makes the QA stale", () => {
    const { data, asset } = seedWithFrame("3A");
    const atGeneration = pkgOf(data, "3A");
    const frozen = frozenShotTruth({ packageSnapshot: atGeneration, request: ANIMATE });
    const before = {
      criteria: buildCriteria(ctx(atGeneration, { frozen })),
      refs: buildReferenceSet(atGeneration, null, undefined, frozen),
    };
    expect(before.refs.items.find((i) => i.role === "production_frame")).toMatchObject({
      assetId: asset.id,
      checksum: asset.checksum,
    });
    expect(before.refs.items.some((i) => i.role === "selection_change")).toBe(false);

    // the filmmaker selects Production Frame v2 afterwards
    const v2Asset = newUploadAsset(data.project.id, { label: "frame-3A-v2" });
    data.assets.push(v2Asset);
    const v2: ProductionFrame = { ...draftFor(data, "3A", { asset: v2Asset }), version: 2 };
    attach(data, [...(data.productionFrames ?? []), v2], v2);
    const today = pkgOf(data, "3A");
    expect(today.references.productionFrame?.version).toBe(2);
    const after = {
      criteria: buildCriteria(ctx(today, { frozen })),
      refs: buildReferenceSet(today, null, undefined, frozen),
    };
    // still the frozen v1 truth: criterion and reference image unchanged
    expect(byKey(after.criteria, "production_frame")!.title).toBe("Opening image — Production Frame v1");
    expect(after.refs.items.find((i) => i.role === "production_frame")?.assetId).toBe(asset.id);
    expect(after.refs.items.some((i) => i.assetId === v2Asset.id)).toBe(false);
    // ...but the move is recorded, so a run frozen before it is stale, and says exactly why
    const moved = after.refs.items.find((i) => i.role === "selection_change")!;
    expect(moved.text).toMatch(/now selects Production Frame v2; this output was generated from v1/);
    const fp = { subjectFingerprint: "s", packageFingerprint: "p" };
    const s = staleness(
      {
        ...fp,
        criteriaFingerprint: criteriaFingerprint(before.criteria),
        referenceFingerprint: before.refs.fingerprint,
        references: before.refs.items,
      },
      {
        ...fp,
        criteriaFingerprint: criteriaFingerprint(after.criteria),
        referenceFingerprint: after.refs.fingerprint,
        references: after.refs.items,
      },
    );
    expect(s.stale).toBe(true);
    expect(s.reasons.join(" ")).toMatch(/now selects Production Frame v2/);
  });
});

describe("Location View fidelity criterion", () => {
  it("exists only for an attempt generated with a selected Location View, from its frozen facts", () => {
    const { data, view, asset } = seedWithView("2A");
    const pkg = pkgOf(data, "2A");
    expect(byKey(buildCriteria(ctx(pkg)), "location_view")).toBeUndefined();
    const frozen = frozenShotTruth({ packageSnapshot: pkg, request: GENERIC });
    expect(frozen.locationView).toMatchObject({ viewId: view.id, name: "Doorway", assetId: asset.id });
    const c = byKey(buildCriteria(ctx(pkg, { frozen })), "location_view")!;
    expect(c).toMatchObject({
      category: "location_set",
      capability: "scene_match",
      handler: "analyzer",
      referenceRoles: ["location_view"],
      title: "Location View — Doorway",
    });
    expect(["critical", "major"]).toContain(c.severity);
    expect(c.expected).toMatch(/from the revolving doors toward the red carpet/);
    expect(c.expected).toMatch(/not reinvented/);
  });

  it("a later view selection does not rewrite the criterion; it records the move (stale), never today's view as truth", () => {
    const { data, location, asset } = seedWithView("2A");
    const frozen = frozenShotTruth({ packageSnapshot: pkgOf(data, "2A"), request: GENERIC });
    const other = newUploadAsset(data.project.id, { label: "bar", width: 1024, height: 768 });
    data.assets.push(other);
    const bar = viewFor(data, location.id, other, { name: "Bar counter", kind: "zone" });
    attachViews(
      data,
      [...(data.locationViews ?? []), bar],
      [{ shotId: shotByCode(data, "2A").id, view: bar }],
    );
    const today = pkgOf(data, "2A");
    expect(byKey(buildCriteria(ctx(today, { frozen })), "location_view")!.title).toBe(
      "Location View — Doorway",
    );
    const refs = buildReferenceSet(today, null, undefined, frozen);
    expect(refs.items.find((i) => i.role === "location_view")?.assetId).toBe(asset.id);
    expect(refs.items.find((i) => i.role === "selection_change")?.text).toMatch(
      /now selects Location View "Bar counter"; this output was generated from "Doorway"/,
    );
  });
});

describe("Character Continuity Locks stay the authority", () => {
  it("identity / wardrobe criteria cite the Lock, and later library edits never change the frozen reference images", () => {
    const data = seed();
    const { ivory } = yumekoIvory(data, "3A");
    const lock = lockFor(data, "Yumeko", ivory, { name: "Yumeko — evening" });
    attachLocks(data, [lock], [{ code: "3A", lock }]);
    const pkg = pkgOf(data, "3A");
    const cs = buildCriteria(ctx(pkg));
    const yumeko = pkg.characters.find((c) => c.name === "Yumeko")!;
    expect(byKey(cs, `identity:${yumeko.characterId}`)).toMatchObject({ severity: "critical" });
    expect(byKey(cs, `identity:${yumeko.characterId}`)!.sourceRef).toMatch(
      /Character Continuity Lock "Yumeko — evening"/,
    );
    expect(byKey(cs, `wardrobe:${yumeko.characterId}`)!.sourceRef).toMatch(/Lock "Yumeko — evening"/);
    const refsBefore = buildReferenceSet(pkg, null).items.filter(
      (i) => i.role === "identity" || i.role === "look",
    );
    expect(refsBefore.length).toBeGreaterThan(0);

    // a NEWER library identity image: the Lock still governs what QA compares against
    uploadIdentity(data, "Yumeko", "front");
    const refsAfter = buildReferenceSet(pkgOf(data, "3A"), null).items.filter(
      (i) => i.role === "identity" || i.role === "look",
    );
    expect(refsAfter).toEqual(refsBefore);
  });
});

describe("camera semantics: stills judge framing, only temporal analysis judges movement", () => {
  const withCamera = () => {
    const pkg = structuredClone(pkgOf(seed(), "3A"));
    pkg.camera = {
      ...pkg.camera,
      shotSize: "medium close-up",
      framing: "centered",
      movement: "slow dolly in",
    };
    return pkg;
  };

  it("splits the old combined criterion into framing (composition) and movement (video_temporal)", () => {
    const cs = buildCriteria(ctx(withCamera()));
    expect(byKey(cs, "camera")).toBeUndefined();
    expect(byKey(cs, "camera_framing")).toMatchObject({
      capability: "composition",
      expected: "medium close-up, centered",
    });
    expect(byKey(cs, "camera_movement")).toMatchObject({
      capability: "video_temporal",
      expected: "slow dolly in",
    });
  });

  it("an image-set analyzer never judges movement: it stays unchecked (unsupported), framing is analysed", () => {
    const criteria = buildCriteria(ctx(withCamera()));
    const plan = buildAnalysisPlan({ analyzer: mock(), criteria, media: OUTPUT_FRAMES });
    const item = (k: string) => plan.items.find((i) => i.criterionKey === k)!;
    expect(item("camera_framing").status).toBe("planned");
    expect(item("camera_movement")).toMatchObject({ status: "unsupported", mode: "direct_video" });
    expect(item("camera_movement").reason).toMatch(/direct-video analysis, which is not enabled/);
  });

  it("only an analyzer with direct-video enabled and video_temporal declared may plan movement", () => {
    const criteria = buildCriteria(ctx(withCamera()));
    const video = media({ inputId: "video", kind: "video", role: "output", mime: "video/mp4" });
    const plan = buildAnalysisPlan({
      analyzer: { ...mock(), modes: ["image_set", "direct_video"], videoCapabilities: ["video_temporal"] },
      criteria,
      media: [...OUTPUT_FRAMES, video],
    });
    expect(plan.items.find((i) => i.criterionKey === "camera_movement")).toMatchObject({
      status: "planned",
      mode: "direct_video",
    });
  });
});

describe("constraint coverage is honest", () => {
  const withConstraints = () => {
    const pkg = structuredClone(pkgOf(seed(), "3A"));
    pkg.constraints = {
      ...pkg.constraints,
      forbiddenObjects: ["red umbrella"],
      forbiddenPeople: ["a waiter"],
      forbiddenActions: ["running"],
    };
    return pkg;
  };

  it("forbidden objects → object presence; forbidden actions → temporal; forbidden people → a person", () => {
    const cs = buildCriteria(ctx(withConstraints()));
    expect(byKey(cs, "forbiddenObjects:0")).toMatchObject({
      handler: "analyzer",
      capability: "object_presence",
      category: "props",
    });
    expect(byKey(cs, "forbiddenActions:0")).toMatchObject({
      handler: "analyzer",
      capability: "video_temporal",
    });
    expect(byKey(cs, "forbiddenPeople:0")).toMatchObject({ handler: "manual", capability: null });
  });

  it("the image analyzer checks the object; the action and the person stay unchecked, never inferred as pass", () => {
    const pkg = withConstraints();
    const criteria = buildCriteria(ctx(pkg));
    const refs = [media({ inputId: "ref:reference:1", kind: "reference", role: "reference" })];
    const plan = buildAnalysisPlan({ analyzer: mock(), criteria, media: [...OUTPUT_FRAMES, ...refs] });
    const item = (k: string) => plan.items.find((i) => i.criterionKey === k)!;
    expect(item("forbiddenObjects:0").status).toBe("planned");
    expect(item("forbiddenActions:0").status).toBe("unsupported");
    expect(item("forbiddenPeople:0").status).toBe("manual");
  });
});

describe("analysis routing, fingerprints and backward compatibility", () => {
  it("a fidelity criterion is sent ONLY its canonical reference (no Storyboard sketch), and stays unchecked without it", () => {
    const { data } = seedWithFrame("3A");
    const pkg = pkgOf(data, "3A");
    const criteria = buildCriteria(
      ctx(pkg, { frozen: frozenShotTruth({ packageSnapshot: pkg, request: GENERIC }) }),
    );
    const pf = media({ inputId: "ref:production_frame:1", kind: "reference", role: "production_frame" });
    const sb = media({ inputId: "ref:storyboard:1", kind: "reference", role: "storyboard" });
    const plan = buildAnalysisPlan({ analyzer: mock(), criteria, media: [...OUTPUT_FRAMES, pf, sb] });
    const item = plan.items.find((i) => i.criterionKey === "production_frame")!;
    expect(item.status).toBe("planned");
    expect(plan.batches.find((b) => b.id === item.batchId)!.referenceInputIds).toEqual([pf.inputId]);
    const without = buildAnalysisPlan({ analyzer: mock(), criteria, media: [...OUTPUT_FRAMES, sb] });
    expect(without.items.find((i) => i.criterionKey === "production_frame")!.status).toBe("no_media");
  });

  it("the criteria fingerprint changes when newly relevant truth appears, and a criterion without routing hashes as in 2c.1", () => {
    const { data } = seedWithFrame("3A");
    const pkg = pkgOf(data, "3A");
    const none = buildCriteria(ctx(pkg));
    const withPf = buildCriteria(
      ctx(pkg, { frozen: frozenShotTruth({ packageSnapshot: pkg, request: GENERIC }) }),
    );
    expect(criteriaFingerprint(withPf)).not.toBe(criteriaFingerprint(none));
    const legacy = (cs: ContinuityCriterion[]) =>
      fingerprint(
        cs.map((c) => [c.key, c.category, c.severity, c.expected, c.sourceRef, c.handler, c.capability]),
      );
    expect(criteriaFingerprint(none)).toBe(legacy(none));
  });

  it("without frozen truth, criteria and references are exactly what they were (no fidelity criteria, same references)", () => {
    const { data } = seedWithFrame("3A");
    const pkg = pkgOf(data, "3A");
    expect(buildCriteria(ctx(pkg))).toEqual(buildCriteria(ctx(pkg, { frozen: NO_FROZEN_TRUTH })));
    expect(buildReferenceSet(pkg, null)).toEqual(buildReferenceSet(pkg, null, undefined, NO_FROZEN_TRUTH));
    // today's selected frame is still offered as a reference role for the other criteria, as before 3A.1
    expect(buildReferenceSet(pkg, null).items.some((i) => i.role === "production_frame")).toBe(true);
  });

  it("the rules version records the 3A.1 change", () => {
    expect(CONTINUITY_RULES_VERSION).toBe("3a.1");
  });
});
