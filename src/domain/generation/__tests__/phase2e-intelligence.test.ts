import { describe, expect, it } from "vitest";
import { describeComparison, planSetSpend, rollupSet } from "../candidates";
import type { ModelFit } from "../models/matrix";
import type { ShotFeatureProfile, ShotGenerationRequirements } from "../models/requirements";
import {
  aggregateByModel,
  aggregateByModelAndBucket,
  aggregateByProvider,
  reliabilityOf,
  type OutcomeRecord,
} from "../performance";
import {
  COLD_START_N,
  PRIOR_RATE,
  PRIOR_STRENGTH,
  RECOMMENDATION_ENGINE_VERSION,
  capabilityFit,
  freezeRecommendation,
  recommendModels,
} from "../recommendation";
import {
  ReviewValidationError,
  latestReviews,
  normalizeReview,
  primaryReason,
  type GenerationReview,
} from "../reviews";

// ───────────────────────── fixtures ─────────────────────────

const profile = (over: Partial<ShotFeatureProfile> = {}): ShotFeatureProfile => ({
  version: 1,
  characterCount: "1",
  hasDialogue: false,
  hasPerformanceAudio: false,
  durationBucket: "3to6",
  shotSize: "close-up",
  cameraMovement: "static",
  interiorExterior: "interior",
  dayNight: "night",
  hasRecurringCharacter: true,
  referenceCount: 3,
  needsWardrobeContinuity: true,
  needsLocationContinuity: true,
  productionRatio: "2.39:1",
  nonStandardRatio: true,
  ...over,
});

const requirements = (
  over: Partial<ShotGenerationRequirements["needs"]> = {},
): ShotGenerationRequirements => {
  const n = (needed: boolean) => ({ needed, because: needed ? "yes" : "no" });
  return {
    production: { aspectRatio: "2.39:1", durationMs: 4500, resolution: "1920x804", fps: 24 },
    characterCount: 1,
    identityReferenceCount: 2,
    lookReferenceCount: 1,
    locationReferenceCount: 1,
    referenceImageCount: 4,
    hasStartFrame: true,
    hasEndFrame: false,
    hasApprovedStoryboard: true,
    hasReferenceVideo: false,
    hasPerformanceAudio: false,
    performanceAudioCount: 0,
    hasDialogue: false,
    protectedComposition: [],
    needs: {
      startFrame: n(true),
      multipleImageReferences: n(true),
      audio: n(false),
      videoReference: n(false),
      longDuration: n(false),
      multiCharacter: n(false),
      nativeProductionRatio: n(true),
      ...over,
    },
  };
};

const fit = (id: string, over: Partial<ModelFit> = {}): ModelFit =>
  ({
    provider: "runway",
    modelId: id,
    displayName: id,
    kind: "real",
    status: "supported",
    blockers: [],
    adaptations: [],
    limitations: [],
    unknowns: [],
    inputMode: null,
    tierId: null,
    nativeAudio: false,
    packaging: [],
    referencesUsed: { used: 3, total: 3 },
    duration: { text: "", ok: true, unverified: false },
    framing: { text: "native", status: "native" },
    audio: { text: "" },
    estimate: { amountUsd: 0.5, credits: 50, basis: "", currency: "USD" },
    available: true,
    availabilityNote: "",
    compatibility: {
      used: {
        durationMs: 4500,
        aspectRatio: "16:9",
        audioAssetIds: [],
        startFrameAssetId: "s",
        references: [],
        endFrameAssetId: null,
        fps: null,
        resolution: null,
      },
      adaptation: null,
    },
    ...over,
  }) as unknown as ModelFit;

let n = 0;
const outcome = (
  model: string,
  decision: OutcomeRecord["decision"],
  over: Partial<OutcomeRecord> = {},
): OutcomeRecord => ({
  attemptId: `a${++n}`,
  projectId: "p",
  provider: "runway",
  model,
  decision,
  negativeTags: [],
  positiveTags: [],
  preferred: false,
  inCandidateSet: true,
  actualCostUsd: 0.5,
  estimatedCostUsd: 0.5,
  generationMs: 60_000,
  totalMs: 70_000,
  profile: profile(),
  benchmark: false,
  status: "succeeded",
  createdAt: "2026-10-14T00:00:00Z",
  ...over,
});
const many = (model: string, good: number, bad: number, over: Partial<OutcomeRecord> = {}) => [
  ...Array.from({ length: good }, () => outcome(model, "approve", over)),
  ...Array.from({ length: bad }, () =>
    outcome(model, "reject", { negativeTags: ["character_identity"], ...over }),
  ),
];

// ───────────────────────── human review ─────────────────────────

describe("human generation review", () => {
  it("rejection needs a reason; no free-text note is ever required", () => {
    expect(() =>
      normalizeReview({ decision: "reject", negativeTags: [], positiveTags: [], notes: "" }),
    ).toThrow(ReviewValidationError);
    const r = normalizeReview({
      decision: "reject",
      negativeTags: ["character_identity", "bogus", "character_identity", "wardrobe"],
      positiveTags: ["identity_good"],
      notes: "  ",
    });
    expect(r).toEqual({
      decision: "reject",
      negativeTags: ["character_identity", "wardrobe"],
      positiveTags: [],
      notes: "",
    });
    expect(primaryReason(r)).toBe("character_identity");
  });

  it("approval keeps optional strengths and drops failure reasons; shortlist may keep both", () => {
    const a = normalizeReview({
      decision: "approve",
      negativeTags: ["wardrobe"],
      positiveTags: ["motion_good", "x"],
      notes: "",
    });
    expect(a).toMatchObject({ positiveTags: ["motion_good"], negativeTags: [] });
    const s = normalizeReview({
      decision: "shortlist",
      negativeTags: ["lighting"],
      positiveTags: ["identity_good"],
      notes: "ok",
    });
    expect(s).toMatchObject({ negativeTags: ["lighting"], positiveTags: ["identity_good"] });
    expect(() =>
      normalizeReview({ decision: "maybe" as never, negativeTags: [], positiveTags: [], notes: "" }),
    ).toThrow();
  });

  it("history is append-only: the newest review is current and older ones remain", () => {
    const base = {
      projectId: "p",
      candidateSetId: "s",
      positiveTags: [] as never[],
      negativeTags: [] as never[],
      notes: "",
      reviewer: "u",
    };
    const rows: GenerationReview[] = [
      {
        ...base,
        id: "r1",
        attemptId: "a",
        decision: "reject",
        reviewedAt: "2026-10-14T01:00:00Z",
        supersedesId: null,
      },
      {
        ...base,
        id: "r2",
        attemptId: "a",
        decision: "approve",
        reviewedAt: "2026-10-14T02:00:00Z",
        supersedesId: "r1",
      },
      {
        ...base,
        id: "r3",
        attemptId: "b",
        decision: "shortlist",
        reviewedAt: "2026-10-14T01:30:00Z",
        supersedesId: null,
      },
    ];
    const cur = latestReviews(rows);
    expect(cur.get("a")?.id).toBe("r2");
    expect(cur.get("b")?.id).toBe("r3");
    expect(rows).toHaveLength(3);
  });
});

// ───────────────────────── candidate sets ─────────────────────────

describe("candidate sets", () => {
  it("isolates failures: one failed candidate never fails the set", () => {
    const r = rollupSet([
      { submitState: "submitted", attemptStatus: "succeeded" },
      { submitState: "submitted", attemptStatus: "succeeded" },
      { submitState: "submitted", attemptStatus: "failed" },
    ]);
    expect(r).toMatchObject({ total: 3, succeeded: 2, failed: 1, settled: true });
    expect(r.label).toBe("2/3 completed, 1 failed");
    const running = rollupSet([
      { submitState: "submitted", attemptStatus: "running" },
      { submitState: "submitted", attemptStatus: "succeeded" },
      { submitState: "failed", attemptStatus: null },
    ]);
    expect(running).toMatchObject({ succeeded: 1, active: 1, notSubmitted: 1, settled: false });
  });

  it("totals the maximum estimated spend and enforces the SERVER set ceiling", () => {
    const cand = (usd: number | null, bills = true) => ({
      billsMoney: bills,
      estimateUsd: usd,
      displayName: "m",
    });
    const ok = planSetSpend({
      candidates: [cand(0.6), cand(0.8), cand(0.5)],
      paidEnabled: true,
      maxSetUsd: 2,
      maxPerGenerationUsd: 1,
      maxCandidates: 6,
    });
    expect(ok.totalUsd).toBe(1.9);
    expect(ok.blockers).toEqual([]);
    const codes = (args: Partial<Parameters<typeof planSetSpend>[0]>) =>
      planSetSpend({
        candidates: [cand(0.6), cand(0.8)],
        paidEnabled: true,
        maxSetUsd: 5,
        maxPerGenerationUsd: 1,
        maxCandidates: 6,
        ...args,
      }).blockers.map((b) => b.code);
    expect(codes({ maxSetUsd: 1 })).toEqual(["set.over_limit"]);
    expect(codes({ maxSetUsd: null })).toEqual(["set.no_limit"]);
    expect(codes({ paidEnabled: false })).toEqual(["set.paid_disabled"]);
    expect(codes({ candidates: [cand(0.6), cand(null)] })).toEqual(["set.unknown_cost"]);
    expect(codes({ maxCandidates: 1 })).toEqual(["set.too_many"]);
    expect(codes({ candidates: [] })).toEqual(["set.empty"]);
  });

  it("free (mock) candidates need no paid gate and no ceiling", () => {
    const free = planSetSpend({
      candidates: [
        { billsMoney: false, estimateUsd: 0.2, displayName: "mock" },
        { billsMoney: false, estimateUsd: 0.1, displayName: "mock2" },
      ],
      paidEnabled: false,
      maxSetUsd: null,
      maxPerGenerationUsd: null,
      maxCandidates: 6,
    });
    expect(free.blockers).toEqual([]);
    expect(free.paidCount).toBe(0);
    expect(free.totalUsd).toBe(0);
  });

  it("discloses what is the same and what differs (never claims identical when providers force differences)", () => {
    const pkg = {
      characters: [{ name: "Yumeko", look: { name: "Formal Black" } }],
      set: { name: "Hotel" },
      references: { approvedStoryboardFrame: { assetId: "a" } },
      performance: [{ selectedTake: { takeId: "t" } }],
      camera: { shotSize: "close-up", movement: "" },
      style: { aspectRatio: "2.39:1" },
      timing: { durationMs: 4500 },
    } as never;
    const mk = (label: string, ratio: string, ms: number, used: number) =>
      ({
        label,
        displayName: label,
        fit: {
          packaging: [],
          tierId: null,
          nativeAudio: false,
          inputMode: null,
          referencesUsed: { used, total: 3 },
          compatibility: {
            used: { aspectRatio: ratio, durationMs: ms, startFrameAssetId: "s", audioAssetIds: [] },
            adaptation: null,
          },
        },
      }) as never;
    const d = describeComparison(pkg, [mk("A", "16:9", 5000, 0), mk("B", "21:9", 4000, 3)]);
    expect(d.same.join(" ")).toMatch(/Yumeko/);
    expect(d.same.join(" ")).toMatch(/Formal Black/);
    expect(d.different.join(" ")).toMatch(/Provider ratio: A 16:9 · B 21:9/);
    expect(d.different.join(" ")).toMatch(/Generated duration/);
    expect(d.different.join(" ")).toMatch(/Reference images used: A 0 · B 3/);
    expect(d.identical).toBe(false);
  });
});

// ───────────────────────── performance ─────────────────────────

describe("model performance (from human reviews)", () => {
  const records = [
    ...many("seedance2_5", 6, 2),
    ...many("gen4.5", 3, 4),
    outcome("gen4.5", "unreviewed"),
    outcome("seedance2_5", "shortlist", { preferred: true, actualCostUsd: 1 }),
    outcome("hailuo3", "approve", { inCandidateSet: false, actualCostUsd: null, status: "succeeded" }),
  ];

  it("counts reviewed / approved / shortlisted / rejected / wins per model", () => {
    const m = Object.fromEntries(aggregateByModel(records).map((p) => [p.model, p]));
    expect(m.seedance2_5).toMatchObject({
      reviewed: 9,
      approved: 6,
      shortlisted: 1,
      rejected: 2,
      preferredWins: 1,
    });
    expect(m["gen4.5"]).toMatchObject({ reviewed: 7, approved: 3, rejected: 4, generated: 8 });
    expect(m["gen4.5"]!.topRejectionReasons[0]).toEqual({ tag: "character_identity", count: 4 });
  });

  it("derives cost, latency and quality-per-dollar from known spend only", () => {
    const m = aggregateByModel(records).find((p) => p.model === "seedance2_5")!;
    expect(m.spendUsd).toBe(5);
    expect(m.medianGenerationMs).toBe(60_000);
    expect(m.positivePer10Usd).toBe(14);
    expect(m.rejectedSpendUsd).toBe(1);
    const h = aggregateByModel(records).find((p) => p.model === "hailuo3")!;
    expect(h.avgActualCostUsd).toBeNull();
    expect(h.unknownCostCount).toBe(1);
    expect(h.positivePer10Usd).toBeNull();
    expect(h.standalone).toBe(1);
  });

  it("labels small samples honestly", () => {
    expect(reliabilityOf(0)).toBe("none");
    expect(reliabilityOf(2)).toBe("very_low");
    expect(reliabilityOf(9)).toBe("low");
    expect(reliabilityOf(10)).toBe("moderate");
  });

  it("groups by shot type and by provider", () => {
    const two = outcome("gen4.5", "approve", {
      profile: profile({ characterCount: "2", hasDialogue: true }),
    });
    const by = aggregateByModelAndBucket([...records, two]);
    const keys = new Set(by.map((b) => b.bucket));
    expect(keys.has("single character · close-up")).toBe(true);
    expect(keys.has("2 characters · close-up · dialogue")).toBe(true);
    expect(aggregateByProvider(records)[0]!.provider).toBe("runway");
  });
});

// ───────────────────────── recommendation ─────────────────────────

describe("model recommendation v1", () => {
  const prof = profile();
  const req = requirements();
  const rec = (
    fits: ModelFit[],
    outcomes: OutcomeRecord[],
    pref?: "quality_first" | "balanced" | "cost_first",
  ) => recommendModels({ fits, outcomes, profile: prof, requirements: req, preference: pref });

  it("cold start says so and ranks on capability and cost only", () => {
    const r = rec(
      [
        fit("a", { referencesUsed: { used: 3, total: 3 } }),
        fit("b", { referencesUsed: { used: 0, total: 3 } }),
      ],
      [],
    );
    expect(r.coldStart).toBe(true);
    expect(r.historyNote).toMatch(/Not enough Prism history yet/);
    expect(r.engineVersion).toBe(RECOMMENDATION_ENGINE_VERSION);
    expect(r.topModelId).toBe("a");
    expect(r.models.find((m) => m.modelId === "a")!.label).toBe("recommended");
    expect(r.models.find((m) => m.modelId === "a")!.confidence).toBe("low");
  });

  it("one lucky 1/1 never outranks a real 20/25 record (shrinkage)", () => {
    const lucky = many("lucky", 1, 0);
    const proven = many("proven", 20, 5);
    const r = rec([fit("lucky"), fit("proven")], [...lucky, ...proven]);
    const byId = Object.fromEntries(r.models.map((m) => [m.modelId, m]));
    expect(byId.proven!.historicalRate!).toBeGreaterThan(byId.lucky!.historicalRate!);
    // exact math: (1 + 4*0.5) / (1 + 4) = 0.6 ; (20 + 2) / (25 + 4) = 0.7586
    expect(byId.lucky!.historicalRate).toBe(0.6);
    expect(byId.proven!.historicalRate).toBeCloseTo(0.759, 3);
    expect(r.topModelId).toBe("proven");
    expect(PRIOR_RATE).toBe(0.5);
    expect(PRIOR_STRENGTH).toBe(4);
  });

  it("history on a different kind of shot counts for much less than similar shots", () => {
    const sim = many("m", 4, 0);
    const other = many("m", 4, 0, {
      profile: profile({
        characterCount: "3+",
        hasDialogue: true,
        shotSize: "wide",
        cameraMovement: "moving",
      }),
    });
    const a = rec([fit("m")], sim).models[0]!;
    const b = rec([fit("m")], other).models[0]!;
    expect(a.historicalRate!).toBeGreaterThan(b.historicalRate!);
    expect(a.sample.similar).toBe(4);
    expect(b.sample.other).toBe(4);
  });

  it("poor historical fit is flagged only once there is enough evidence, and never recommended", () => {
    const bad = many("bad", 0, 8);
    const r = rec([fit("bad"), fit("ok")], [...bad, ...many("ok", 3, 1)]);
    expect(r.models.find((m) => m.modelId === "bad")!.label).toBe("poor_historical_fit");
    expect(r.topModelId).toBe("ok");
    const few = rec([fit("x")], many("x", 0, 2));
    expect(few.models[0]!.label).not.toBe("poor_historical_fit");
  });

  it("incompatible and unavailable models are labelled and carry no score", () => {
    const r = rec(
      [
        fit("a"),
        fit("b", { status: "unsupported", blockers: ["Duration unsupported"] }),
        fit("c", { available: false }),
      ],
      [],
    );
    const b = r.models.find((x) => x.modelId === "b")!;
    const c = r.models.find((x) => x.modelId === "c")!;
    expect(b.label).toBe("incompatible");
    expect(c.label).toBe("unavailable");
    for (const m of [b, c]) {
      expect(m.score).toBeNull();
      expect(m.rank).toBeNull();
    }
  });

  it("rejection reasons that matter for THIS shot lower the score", () => {
    const a = [...many("ident", 4, 4, { negativeTags: ["character_identity"] })];
    const b = [...many("noident", 4, 4, { negativeTags: ["lighting"] })];
    const r = rec([fit("ident"), fit("noident")], [...a, ...b]);
    const p = Object.fromEntries(r.models.map((m) => [m.modelId, m]));
    expect(p.ident!.parts.reasonPenalty).toBeGreaterThan(0);
    expect(p.noident!.parts.reasonPenalty).toBe(0);
    expect(p.noident!.score!).toBeGreaterThan(p.ident!.score!);
  });

  it("preference shifts the weights: cost first prefers the cheaper model, quality first the better record", () => {
    const cheap = fit("cheap", { estimate: { amountUsd: 0.2, credits: 20, basis: "", currency: "USD" } });
    const dear = fit("dear", { estimate: { amountUsd: 1.2, credits: 120, basis: "", currency: "USD" } });
    const history = [...many("cheap", 3, 5), ...many("dear", 7, 1)];
    expect(rec([cheap, dear], history, "cost_first").topModelId).toBe("cheap");
    expect(rec([cheap, dear], history, "quality_first").topModelId).toBe("dear");
  });

  it("capability fit penalises lost references and unusable audio, with exact arithmetic", () => {
    expect(capabilityFit(fit("a"), req)).toBe(1);
    // 0 of 3 references used, shot needs multiple refs: 1 - 0.25
    expect(capabilityFit(fit("b", { referencesUsed: { used: 0, total: 3 } }), req)).toBeCloseTo(0.75, 5);
    // one adaptation (0.12) + one limitation (0.04)
    expect(capabilityFit(fit("c", { adaptations: ["x"], limitations: ["y"] }), req)).toBeCloseTo(0.84, 5);
    const needAudio = requirements({ audio: { needed: true, because: "x" } });
    expect(capabilityFit(fit("d"), needAudio)).toBeCloseTo(0.85, 5);
  });

  it("explains itself and can be frozen for a paid selection", () => {
    const r = rec([fit("a"), fit("b")], [...many("a", 5, 1)]);
    const a = r.models.find((m) => m.modelId === "a")!;
    expect(a.why.join(" ")).toMatch(/liked on similar reviewed shots/);
    expect(a.sample.similar).toBe(6);
    expect(r.coldStart).toBe(false);
    const frozen = freezeRecommendation(r);
    expect(frozen.engineVersion).toBe("model-routing-v1");
    expect(JSON.stringify(frozen)).not.toMatch(/data:|https?:\/\//);
    expect(COLD_START_N).toBe(3);
  });
});
