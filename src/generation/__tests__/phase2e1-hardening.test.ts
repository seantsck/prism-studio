import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildSeedProject } from "@/data/seed";
import { CandidateError } from "@/data/candidates-repository";
import { buildShotContext } from "@/domain/context";
import { evaluateCompatibility } from "@/domain/generation/compatibility";
import { assembleGenerationPackage, type GenerationPackage } from "@/domain/generation-package";
import {
  RUNWAY_VIDEO_MODELS,
  SDK_BLOCKED_MODELS,
  catalogModel,
  estimateCredits,
  toGenerationModel,
} from "@/domain/generation/models/catalog";
import { evaluateModelFit } from "@/domain/generation/models/matrix";
import { deriveShotFeatureProfile, deriveShotRequirements } from "@/domain/generation/models/requirements";
import { aggregateByModel, inScope, type OutcomeRecord } from "@/domain/generation/performance";
import { recommendModels } from "@/domain/generation/recommendation";
import { normalizeReview } from "@/domain/generation/reviews";
import { rollupSet } from "@/domain/generation/candidates";
import { submitCandidateSet, type CandidateSelection } from "../candidate-set";
import { makeHarness, type Harness } from "./helpers";

const cat = (id: string) => catalogModel("runway", id)!;
const gm = (id: string) => toGenerationModel(cat(id));

/** Duration is judged on its own: other blockers (storyboard, audio) are unrelated to the duration rule. */
const durationOk = (r: ReturnType<typeof evaluateCompatibility>) =>
  r.duration?.ok === true &&
  !r.errors.some((e) => e.id === "duration.unsupported" || e.id === "duration.unset");

function pkgWithSeconds(seconds: number): GenerationPackage {
  const data = buildSeedProject();
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  const pkg = structuredClone(
    assembleGenerationPackage(buildShotContext(data, shot.id), new Date("2026-01-01T00:00:00Z")),
  );
  pkg.timing.durationMs = Math.round(seconds * 1000);
  return pkg;
}

describe("Phase 2E.1: documented duration ranges are in the catalog", () => {
  const range = (id: string) => {
    const d = cat(id).duration;
    return [d.minSeconds, d.maxSeconds, d.verified] as const;
  };

  it("Gen-4.5 is 2–10 s (verified)", () => expect(range("gen4.5")).toEqual([2, 10, true]));
  it("Gen-4 Turbo is 2–10 s (verified)", () => expect(range("gen4_turbo")).toEqual([2, 10, true]));
  it("Hailuo 3 is 5–15 s (verified)", () => expect(range("hailuo3")).toEqual([5, 15, true]));
  it("Veo 3.1 / Fast accept exactly 4, 6 or 8 s", () => {
    for (const id of ["veo3.1", "veo3.1_fast"]) expect(cat(id).duration.allowedSeconds).toEqual([4, 6, 8]);
  });
  it("Seedance 2.5: 4–30 s, and the lower bound is explicitly NOT verified (the API reference states none)", () => {
    expect(range("seedance2_5")).toEqual([4, 30, false]);
    expect(cat("seedance2_5").verification.unstated.join(" ")).toMatch(/minimum duration/);
  });
  it("every entry still carries verifiedAt, sources, SDK and API version", () => {
    for (const m of RUNWAY_VIDEO_MODELS) {
      expect(m.verification.verifiedAt).toBe("2026-10-14");
      expect(m.verification.sources.join(" ")).toMatch(/api\.md/);
      expect(m.verification.sdkVersion).toMatch(/^@runwayml\/sdk@/);
      expect(m.verification.providerApiVersion).toBe("2024-11-06");
    }
  });
});

describe("Phase 2E.1: planner and compatibility", () => {
  it("a 2 s Gen-4 Turbo request is duration-compatible (the historical failure was provider_unavailable)", () => {
    const r = evaluateCompatibility(pkgWithSeconds(2), gm("gen4_turbo"));
    expect(r.duration).toMatchObject({ ok: true });
    expect(r.errors.map((e) => e.id)).not.toContain("duration.unsupported");
    expect(r.used.durationMs).toBe(2000);
  });

  it("a 2 s Hailuo 3 request is NOT a native request: blocked, and the duration is never changed silently", () => {
    const r = evaluateCompatibility(pkgWithSeconds(2), gm("hailuo3"));
    expect(durationOk(r)).toBe(false);
    expect(r.errors.map((e) => e.id)).toContain("duration.unsupported");
    expect(r.used.durationMs).toBeNull();
    expect(r.adaptation?.duration.status).toBe("needs_choice");
    expect(r.adaptation?.duration.providerMs).toBeNull();
  });

  it("with the explicit strategy, Hailuo generates 5 s, trims to 2 s, and production duration is untouched", () => {
    const r = evaluateCompatibility(pkgWithSeconds(2), gm("hailuo3"), {
      adaptation: { framing: null, duration: "generate_longer_then_trim" },
    });
    expect(r.errors.map((e) => e.id)).not.toContain("duration.unsupported");
    expect(r.used.durationMs).toBe(5000);
    expect(r.adaptation?.duration).toMatchObject({
      status: "adapted",
      productionMs: 2000,
      providerMs: 5000,
      trimToMs: 2000,
    });
  });

  it("the matrix classifies 2 s Hailuo as ADAPTATION REQUIRED and shows production / provider / trim", () => {
    const fit = evaluateModelFit({
      pkg: pkgWithSeconds(2),
      model: gm("hailuo3"),
      catalog: cat("hailuo3"),
      availability: null,
    });
    expect(fit.status).toBe("adaptation_required");
    expect(fit.adaptations.join(" ")).toMatch(/generate 5 s, trim to 2 s/);
    expect(fit.adaptationChoice.duration).toBe("generate_longer_then_trim");
  });

  it("5 s Hailuo is accepted natively; 15 s too; 16 s needs a choice that cannot lengthen", () => {
    const five = evaluateCompatibility(pkgWithSeconds(5), gm("hailuo3"));
    expect(durationOk(five)).toBe(true);
    expect(five.used.durationMs).toBe(5000);
    expect(durationOk(evaluateCompatibility(pkgWithSeconds(15), gm("hailuo3")))).toBe(true);
    const over = evaluateCompatibility(pkgWithSeconds(16), gm("hailuo3"));
    expect(durationOk(over)).toBe(false);
    expect(over.used.durationMs).toBeNull();
  });

  it("Seedance 2.5 lower bound: 3 s is not native, 4 s is", () => {
    expect(durationOk(evaluateCompatibility(pkgWithSeconds(3), gm("seedance2_5")))).toBe(false);
    expect(durationOk(evaluateCompatibility(pkgWithSeconds(4), gm("seedance2_5")))).toBe(true);
  });

  it("Gen-4.5 range: 1 s blocked, 2 s and 10 s native, 11 s blocked", () => {
    const ok = (s: number) => durationOk(evaluateCompatibility(pkgWithSeconds(s), gm("gen4.5")));
    expect([ok(1), ok(2), ok(10), ok(11)]).toEqual([false, true, true, false]);
  });

  it("cost is recomputed on the PROVIDER duration after adaptation, never the production duration", () => {
    const adapted = evaluateModelFit({
      pkg: pkgWithSeconds(2),
      model: gm("hailuo3"),
      catalog: cat("hailuo3"),
      availability: null,
    });
    const native5 = evaluateModelFit({
      pkg: pkgWithSeconds(5),
      model: gm("hailuo3"),
      catalog: cat("hailuo3"),
      availability: null,
    });
    expect(adapted.estimate!.amountUsd).toBe(native5.estimate!.amountUsd);
    const naive2s = estimateCredits(cat("hailuo3"), {
      seconds: 2,
      tierId: "768p",
      nativeAudio: false,
      referenceImages: 0,
      referenceVideoSeconds: 0,
      startFrame: false,
      endFrame: false,
    });
    expect(adapted.estimate!.amountUsd!).toBeGreaterThan((naive2s.credits ?? 0) * 0.01);
    expect(adapted.estimate!.amountUsd!).toBeGreaterThanOrEqual(0.5);
  });

  it("the 5 s next-experiment prices: Turbo 25 cr, Hailuo 768p 50 cr (+2/start frame), Seedance 720p 150 cr", () => {
    const credits = (id: string, tierId: string, startFrame: boolean) =>
      estimateCredits(cat(id), {
        seconds: 5,
        tierId,
        nativeAudio: false,
        referenceImages: 0,
        referenceVideoSeconds: 0,
        startFrame,
        endFrame: false,
      }).credits;
    expect(credits("gen4_turbo", "default", true)).toBe(25);
    expect(credits("hailuo3", "768p", true)).toBe(52);
    expect(credits("seedance2_5", "720p", true)).toBe(150);
    expect(credits("seedance2_5", "480p", true)).toBe(100);
  });
});

describe("Phase 2E.1: Kling 3.0 is documented but blocked by the SDK, and never forced in", () => {
  it("records the documented facts and the blocker for Kling 3.0 Standard / Pro / 4K", () => {
    const byId = Object.fromEntries(SDK_BLOCKED_MODELS.map((m) => [m.modelId, m]));
    expect(Object.keys(byId).sort()).toEqual(["kling3.0_4k", "kling3.0_pro", "kling3.0_standard"]);
    expect(byId["kling3.0_pro"]).toMatchObject({
      durationSeconds: { min: 3, max: 15 },
      creditsPerSecond: { silent: 12, audio: 17 },
      endpoint: "image_to_video",
    });
    expect(byId["kling3.0_pro"]!.blocker).toMatch(/4\.21\.0 or 4\.22\.0/);
  });

  it("is not offered while the installed SDK does not type it (this test fails when an upgrade adds it)", () => {
    const types = readFileSync("node_modules/@runwayml/sdk/resources/image-to-video.d.ts", "utf8");
    for (const m of SDK_BLOCKED_MODELS) expect(types.includes(`'${m.modelId}'`)).toBe(false);
    expect(RUNWAY_VIDEO_MODELS.map((m) => m.modelId).some((id) => id.startsWith("kling"))).toBe(false);
  });
});

const record = (over: Partial<OutcomeRecord>): OutcomeRecord => ({
  attemptId: Math.random().toString(36).slice(2),
  projectId: "p",
  provider: "runway",
  model: "gen4.5",
  decision: "approve",
  negativeTags: [],
  positiveTags: [],
  preferred: false,
  inCandidateSet: true,
  actualCostUsd: 0.24,
  estimatedCostUsd: 0.24,
  generationMs: 60_000,
  totalMs: 70_000,
  profile: null,
  benchmark: false,
  status: "succeeded",
  createdAt: "2026-10-14T00:00:00Z",
  ...over,
});

describe("Phase 2E.1: benchmark / fixture data is excluded from production intelligence", () => {
  const mixed = [
    record({ decision: "approve" }),
    record({ decision: "reject", negativeTags: ["character_identity"] }),
    record({ decision: "approve", benchmark: true, preferred: true }),
    record({ decision: "approve", benchmark: true }),
    record({ decision: "approve", benchmark: true }),
  ];

  it("production aggregates ignore benchmark records; the benchmark scope is explicit and separate", () => {
    const prod = aggregateByModel(mixed)[0]!;
    expect(prod).toMatchObject({ generated: 2, reviewed: 2, approved: 1, rejected: 1, preferredWins: 0 });
    const bench = aggregateByModel(mixed, "benchmark")[0]!;
    expect(bench).toMatchObject({ generated: 3, approved: 3, preferredWins: 1 });
    expect(inScope(mixed)).toHaveLength(2);
    expect(inScope(mixed, "benchmark")).toHaveLength(3);
  });

  it("routing recommendations never read benchmark reviews (still cold start)", () => {
    const onlyBench = mixed.filter((r) => r.benchmark);
    const pkg = pkgWithSeconds(5);
    const fit = evaluateModelFit({ pkg, model: gm("gen4.5"), catalog: cat("gen4.5"), availability: null });
    const rec = recommendModels({
      fits: [fit],
      outcomes: onlyBench,
      profile: deriveShotFeatureProfile(pkg),
      requirements: deriveShotRequirements(pkg),
    });
    expect(rec.coldStart).toBe(true);
    const m = rec.models[0]!;
    expect(m.sample.similar + m.sample.other).toBe(0);
  });
});

async function drain(h: Harness, rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
}

const mock = (modelId: string): CandidateSelection => ({ provider: "mock", modelId });

async function createSet(h: Harness, selections: CandidateSelection[]) {
  const data = await h.data();
  const shotId = data.shots.find((s) => s.shotCode === "3A")!.id;
  return submitCandidateSet({
    data,
    shotId,
    registry: h.registry,
    config: h.config,
    generation: h.repo.generation,
    candidates: h.repo.candidates,
    selections,
    acknowledgeAll: true,
    confirmedTotalUsd: null,
    title: "hardening",
    purpose: "",
    userId: null,
    projectRevision: null,
    now: h.clock.now,
  });
}

const review = (
  h: Harness,
  projectId: string,
  setId: string,
  attemptId: string,
  decision: "approve" | "reject",
) =>
  h.repo.candidates.recordReview({
    projectId,
    attemptId,
    candidateSetId: setId,
    ...normalizeReview({
      decision,
      negativeTags: decision === "reject" ? ["body_motion" as const] : [],
      positiveTags: [],
      notes: "",
    }),
    reviewer: null,
    now: h.clock.now.toISOString(),
  });

describe("Phase 2E.1: partial sets, failed candidates and benchmark persistence", () => {
  it("a failed candidate cannot be reviewed as a clip; the succeeded one remains reviewable", async () => {
    const h = makeHarness();
    const out = await createSet(h, [mock("mock-video-1"), mock("mock-video-rejects")]);
    await drain(h);
    const data = await h.data();
    const view = (await h.repo.candidates.getSet(out.view.set.id))!;
    const states = await Promise.all(
      view.members.map(async (m) => ({
        model: m.model,
        attemptId: m.attemptId!,
        status: (await h.repo.generation.getAttemptView(m.attemptId!))!.attempt.status,
      })),
    );
    const good = states.find((s) => s.status === "succeeded")!;
    const bad = states.find((s) => s.status === "failed")!;
    expect(good).toBeTruthy();
    expect(bad).toBeTruthy();

    // the rollup says what happened, and nothing is hidden
    const roll = rollupSet(
      view.members.map((m) => ({
        submitState: m.submitState,
        attemptStatus: states.find((s) => s.attemptId === m.attemptId)?.status ?? null,
      })),
    );
    expect(roll.label).toMatch(/1\/2 completed, 1 failed/);

    await expect(review(h, data.project.id, view.set.id, bad.attemptId, "reject")).rejects.toMatchObject({
      code: "not_succeeded",
    });
    await expect(review(h, data.project.id, view.set.id, bad.attemptId, "reject")).rejects.toBeInstanceOf(
      CandidateError,
    );
    // the good clip is reviewable and can be marked Best
    await review(h, data.project.id, view.set.id, good.attemptId, "approve");
    await h.repo.candidates.setPreferred(view.set.id, good.attemptId, null, h.clock.now.toISOString());
    const reviews = await h.repo.candidates.listReviews(data.project.id, { attemptIds: [good.attemptId] });
    expect(reviews).toHaveLength(1);
    // the failed attempt has no review at all (the historical failure stays its own status)
    expect(await h.repo.candidates.listReviews(data.project.id, { attemptIds: [bad.attemptId] })).toEqual([]);
  });

  it("a benchmark project still persists reviews and winners, flagged benchmark and out of production scope", async () => {
    const h = makeHarness();
    const base = await h.data();
    await h.repo.updateProject({ ...base.project, isBenchmark: true });
    const out = await createSet(h, [mock("mock-video-1"), mock("mock-video-lite")]);
    await drain(h);
    const data = await h.data();
    expect(data.project.isBenchmark).toBe(true);
    const view = (await h.repo.candidates.getSet(out.view.set.id))!;
    const first = view.members[0]!.attemptId!;
    await review(h, data.project.id, view.set.id, first, "approve");
    await h.repo.candidates.setPreferred(view.set.id, first, null, h.clock.now.toISOString());

    const rows = await h.repo.candidates.listOutcomeRecords(data.project.id);
    const mine = rows.filter((r) => r.attemptId === first);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ decision: "approve", preferred: true, benchmark: true });
    expect(aggregateByModel(rows).filter((p) => p.reviewed > 0)).toEqual([]);
    expect(aggregateByModel(rows, "benchmark").some((p) => p.approved === 1)).toBe(true);
  });

  it("a normal project's records are production data (the classification defaults to false)", async () => {
    const h = makeHarness();
    const out = await createSet(h, [mock("mock-video-1")]);
    await drain(h);
    const data = await h.data();
    expect(data.project.isBenchmark).toBe(false);
    const attemptId = (await h.repo.candidates.getSet(out.view.set.id))!.members[0]!.attemptId!;
    await review(h, data.project.id, out.view.set.id, attemptId, "approve");
    const rows = await h.repo.candidates.listOutcomeRecords(data.project.id);
    expect(rows.find((r) => r.attemptId === attemptId)).toMatchObject({ benchmark: false });
    expect(aggregateByModel(rows).some((p) => p.approved === 1)).toBe(true);
  });
});
