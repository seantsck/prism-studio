import { describe, expect, it, vi } from "vitest";
import { buildShotContext, type ShotContext } from "@/domain/context";
import { parseAdaptationPlan } from "@/domain/framing/adaptation";
import { candidateSetPurpose } from "@/domain/generation/candidates";
import { ofPurpose } from "@/domain/generation/performance";
import { recommendModels } from "@/domain/generation/recommendation";
import type { ProjectData } from "@/domain/schemas";
import { conformAttemptOutput } from "@/media/delivery";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import { GeneratedFrameRefused, promoteGeneratedFrame } from "@/server/production-frame-generated";
import { remappedSeed } from "@/domain/__tests__/production-frame-fixtures";
import { planCandidateSet, submitCandidateSet, type CandidateSelection } from "../candidate-set";
import { makeHarness, type Harness } from "./helpers";

/**
 * Phase 2G.2 end to end on the memory repository: a Production Frame candidate set of still images (the FREE mock image
 * models, no provider, no GPU, no 3D set) → review → "Use as Production Frame". The same flow runs against Supabase in
 * scripts/db-production-frames.mts and e2e/supabase-image-shot-generator.spec.ts.
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const processor = new FfmpegMediaProcessor({ limits: { timeoutMs: 60_000 } });
const ffmpegAvailable = await processor.available();

const mock = (modelId: string): CandidateSelection => ({ provider: "mock", modelId });
const THREE_NATIVE = [mock("mock-image-1"), mock("mock-image-lite")];

async function setup(code = "1A", aspect = "16:9") {
  const h = makeHarness();
  const data = await h.data();
  const shot = data.shots.find((s) => s.shotCode === code)!;
  // a 16:9 production frame so the free image models are native (the seed Shots are 2.39:1)
  await h.repo.upsert(data.project.id, "shots", {
    ...shot,
    composition: { ...shot.composition, aspectRatio: aspect },
    updatedAt: new Date(h.clock.now.getTime() - 1000).toISOString(),
  });
  return { h, shotId: shot.id };
}

async function ctxOf(h: Harness, shotId: string): Promise<{ data: ProjectData; ctx: ShotContext }> {
  const loaded = await h.data();
  const { frames, selections } = await h.repo.productionFrames.listForProject(loaded.project.id);
  const data = { ...loaded, productionFrames: frames, productionFrameSelections: selections };
  return { data, ctx: buildShotContext(data, shotId) };
}

async function generate(
  h: Harness,
  shotId: string,
  selections: CandidateSelection[],
  over: Record<string, unknown> = {},
) {
  const data = await h.data();
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
    title: "Frame candidates",
    purpose: "find the first frame",
    userId: null,
    projectRevision: null,
    generationPurpose: "production_frame",
    now: h.clock.now,
    ...over,
  });
}

async function drain(h: Harness, rounds = 14) {
  for (let i = 0; i < rounds; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
}

const deps = (h: Harness) => ({
  frames: h.repo.productionFrames,
  generation: h.repo.generation,
  qa: h.repo.mediaQa,
});

const attemptsOf = async (h: Harness, shotId: string) =>
  (await h.data()).attempts
    .filter((a) => a.shotId === shotId)
    .sort((a, b) => a.attemptNumber - b.attemptNumber);

describe("Production Frame candidates: the purpose is frozen, the Shot is untouched", () => {
  it("three candidates = three attempts, three jobs, three still images; the Shot's own modality never changes", async () => {
    const { h, shotId } = await setup();
    const before = (await h.data()).shots.find((s) => s.id === shotId)!;
    const result = await generate(h, shotId, [...THREE_NATIVE, mock("mock-image-1")]);
    expect(result.submitted).toBe(3);
    expect(candidateSetPurpose(result.view.set)).toBe("production_frame");
    await drain(h);

    const attempts = await attemptsOf(h, shotId);
    expect(attempts).toHaveLength(3); // one attempt per candidate, not one attempt with three provider images
    for (const a of attempts) {
      expect(a.status).toBe("succeeded");
      expect(a.requestModality).toBe("text_to_image"); // no stored references: text-to-image
      expect((a.request as { purpose?: string }).purpose).toBe("production_frame");
      expect((a.modelSettings as { purpose?: string }).purpose).toBe("production_frame");
      expect(a.approved).toBe(false);
      // the Shot's final modality is NOT the request modality
      expect(a.modality).toBe(before.generation.modality);
      const view = (await h.repo.generation.getAttemptView(a.id))!;
      expect(view.outputs).toHaveLength(1);
      expect(view.outputs[0]!.asset).toMatchObject({
        type: "image",
        source: "provider_output",
        purpose: "generation_output",
      });
    }
    // jobs: one each
    const jobs = await Promise.all(
      attempts.map((a) => h.repo.generation.getAttemptView(a.id).then((v) => v!.job)),
    );
    expect(new Set(jobs.map((j) => j!.id)).size).toBe(3);

    // generating candidates never mutates the Shot
    const after = (await h.data()).shots.find((s) => s.id === shotId)!;
    expect(after.generation).toEqual(before.generation);
    expect(after.generation.startFrameAssetId ?? null).toBe(before.generation.startFrameAssetId ?? null);
    expect(after.approval).toEqual(before.approval);
    const { ctx } = await ctxOf(h, shotId);
    expect(ctx.selectedProductionFrame).toBeNull();
  });

  it("a Shot with no performance take, approval or storyboard can still generate stills (exploration precedes them)", async () => {
    const { h, shotId } = await setup();
    const data = await h.data();
    const plan = planCandidateSet({
      data,
      shotId,
      registry: h.registry,
      config: h.config,
      selections: THREE_NATIVE,
      outcomes: [],
      purpose: "production_frame",
      now: h.clock.now,
    });
    expect(plan.purpose).toBe("production_frame");
    expect(plan.blockers).toEqual([]);
    expect(plan.spend.totalUsd).toBe(0); // free mock models
    // the same Shot judged as a VIDEO output is blocked by the output-readiness rules
    const video = planCandidateSet({
      data,
      shotId,
      registry: h.registry,
      config: h.config,
      selections: [mock("mock-video-1")],
      outcomes: [],
      now: h.clock.now,
    });
    expect(video.items[0]!.blockers.length).toBeGreaterThan(0);
    // still-image criteria only: no audio/duration/start-frame requirement, so nothing penalises an image model
    expect(plan.recommendation.profile).not.toBeNull();
    expect(plan.disclosure.same.join(" ")).toMatch(/one still image per candidate/);
    expect(plan.disclosure.same.join(" ")).not.toMatch(/\d s\b/);
  });

  it("human reviews of image candidates never feed the video models' history (and vice versa)", async () => {
    const { h, shotId } = await setup();
    await generate(h, shotId, THREE_NATIVE);
    await drain(h);
    const [first] = await attemptsOf(h, shotId);
    await h.repo.candidates.recordReview({
      projectId: first!.projectId,
      attemptId: first!.id,
      candidateSetId: null,
      decision: "approve",
      positiveTags: [],
      negativeTags: [],
      notes: "",
      reviewer: null,
      now: h.clock.now.toISOString(),
    });
    const outcomes = await h.repo.candidates.listOutcomeRecords(first!.projectId);
    const mine = outcomes.find((o) => o.attemptId === first!.id)!;
    expect(mine.purpose).toBe("production_frame");
    // (the seed project already has video attempts of its own: only the image candidates are production_frame)
    const candidateIds = new Set((await attemptsOf(h, shotId)).map((x) => x.id));
    expect(candidateIds.size).toBe(2);
    expect(
      ofPurpose(outcomes, "production_frame")
        .map((o) => o.attemptId)
        .sort(),
    ).toEqual([...candidateIds].sort());
    expect(ofPurpose(outcomes, "shot_output").some((o) => candidateIds.has(o.attemptId))).toBe(false);

    const data = await h.data();
    const fitsFor = (purpose: "shot_output" | "production_frame", modelId: string) =>
      planCandidateSet({
        data,
        shotId,
        registry: h.registry,
        config: h.config,
        selections: [mock(modelId)],
        outcomes,
        purpose,
        now: h.clock.now,
      });
    const img = recommendModels({
      fits: fitsFor("production_frame", first!.model).items.map((i) => i.fit),
      outcomes,
      profile: null,
      requirements: null,
      purpose: "production_frame",
    });
    const asVideo = recommendModels({
      fits: fitsFor("production_frame", first!.model).items.map((i) => i.fit),
      outcomes,
      profile: null,
      requirements: null,
    });
    // counted for the image purpose, invisible to the (default) video purpose
    expect(img.models[0]!.sample.other + img.models[0]!.sample.similar).toBe(1);
    expect(asVideo.models[0]!.sample.other + asVideo.models[0]!.sample.similar).toBe(0);
  });
});

describe("Use as Production Frame (memory): canonical selection, history, dedupe", () => {
  it("A → v1, B → v2, back to v1: immutable history, no new Asset, no startFrame, no attempt mutation", async () => {
    const { h, shotId } = await setup();
    await generate(h, shotId, THREE_NATIVE);
    await drain(h);
    const [a, b] = await attemptsOf(h, shotId);
    const assetsBefore = (await h.data()).assets.length;
    const attemptsBefore = JSON.stringify(await attemptsOf(h, shotId));
    const startBefore =
      (await h.data()).shots.find((s) => s.id === shotId)!.generation.startFrameAssetId ?? null;

    const r1 = await promoteGeneratedFrame(deps(h), (await ctxOf(h, shotId)).ctx, {
      attemptId: a!.id,
      userId: null,
    });
    expect(r1).toMatchObject({ created: true, image: "provider_original" });
    expect(r1.frame).toMatchObject({
      version: 1,
      source: "generation_output",
      sourceGenerationAttemptId: a!.id,
      sourceStoryboardFrameId: null,
      sourceMasterFrameId: null,
      width: 512,
      height: 288,
    });
    // the attempt's existing private Asset is reused: no copy, no new Asset row
    const aView = (await h.repo.generation.getAttemptView(a!.id))!;
    expect(r1.frame.assetId).toBe(aView.outputs[0]!.asset.id);
    expect((await h.data()).assets.length).toBe(assetsBefore);
    let c = await ctxOf(h, shotId);
    expect(c.ctx.selectedProductionFrame!.id).toBe(r1.frame.id);

    const r2 = await promoteGeneratedFrame(deps(h), c.ctx, { attemptId: b!.id, userId: null });
    expect(r2).toMatchObject({ created: true });
    expect(r2.frame.version).toBe(2);
    c = await ctxOf(h, shotId);
    expect(c.ctx.selectedProductionFrame!.id).toBe(r2.frame.id);
    expect(c.ctx.productionFrames.map((f) => f.version)).toEqual(expect.arrayContaining([1, 2]));

    // v1 is immutable history and can be re-selected in Shot Prep (no GenerationAttempt mutation needed)
    const v1 = c.ctx.productionFrames.find((f) => f.version === 1)!;
    expect(v1).toEqual(r1.frame);
    await h.repo.productionFrames.select({
      projectId: v1.projectId,
      shotId,
      productionFrameId: v1.id,
      userId: null,
      now: h.clock.now.toISOString(),
    });
    c = await ctxOf(h, shotId);
    expect(c.ctx.selectedProductionFrame!.id).toBe(v1.id);

    // the Shot's explicit start-frame override was never written; attempts were never touched; approved stays false
    expect(c.data.shots.find((s) => s.id === shotId)!.generation.startFrameAssetId ?? null).toBe(startBefore);
    expect(JSON.stringify(await attemptsOf(h, shotId))).toBe(attemptsBefore);
    for (const at of await attemptsOf(h, shotId)) expect(at.approved).toBe(false);
  });

  it("using the same candidate twice returns the existing frame: no duplicate version, no duplicate Asset", async () => {
    const { h, shotId } = await setup();
    await generate(h, shotId, THREE_NATIVE);
    await drain(h);
    const [a] = await attemptsOf(h, shotId);
    const first = await promoteGeneratedFrame(deps(h), (await ctxOf(h, shotId)).ctx, {
      attemptId: a!.id,
      userId: null,
    });
    const assets = (await h.data()).assets.length;
    const again = await promoteGeneratedFrame(deps(h), (await ctxOf(h, shotId)).ctx, {
      attemptId: a!.id,
      userId: null,
    });
    expect(again.created).toBe(false);
    expect(again.frame.id).toBe(first.frame.id);
    expect((await h.data()).assets.length).toBe(assets);
    expect((await ctxOf(h, shotId)).ctx.productionFrames).toHaveLength(1);
  });

  it("Best and the current Production Frame are independent: mark A Best, use B", async () => {
    const { h, shotId } = await setup();
    const result = await generate(h, shotId, THREE_NATIVE);
    await drain(h);
    const [a, b] = await attemptsOf(h, shotId);
    await h.repo.candidates.setPreferred(result.view.set.id, a!.id, null, h.clock.now.toISOString());
    await promoteGeneratedFrame(deps(h), (await ctxOf(h, shotId)).ctx, { attemptId: b!.id, userId: null });
    const set = (await h.repo.candidates.getSet(result.view.set.id))!.set;
    expect(set.preferredAttemptId).toBe(a!.id); // Best is an experiment preference: untouched by promotion
    const { ctx } = await ctxOf(h, shotId);
    expect(ctx.selectedProductionFrame!.sourceGenerationAttemptId).toBe(b!.id); // the canonical frame came from B
    expect(set.promotedAttemptId).toBeNull(); // not a video "Promote to Shot"
    expect((await attemptsOf(h, shotId)).every((x) => !x.approved)).toBe(true);
  });

  it("Best never selects a Production Frame by itself", async () => {
    const { h, shotId } = await setup();
    const result = await generate(h, shotId, THREE_NATIVE);
    await drain(h);
    const [a] = await attemptsOf(h, shotId);
    await h.repo.candidates.setPreferred(result.view.set.id, a!.id, null, h.clock.now.toISOString());
    expect((await ctxOf(h, shotId)).ctx.selectedProductionFrame).toBeNull();
    expect((await ctxOf(h, shotId)).ctx.productionFrames).toHaveLength(0);
  });
});

describe("Use as Production Frame (memory): the stale-candidate rule", () => {
  it("changing the camera after generation refuses promotion; the attempt stays intact; regenerating works", async () => {
    const { h, shotId } = await setup();
    await generate(h, shotId, THREE_NATIVE);
    await drain(h);
    const [a] = await attemptsOf(h, shotId);
    const snapshot = JSON.stringify(a);

    const data = await h.data();
    const shot = data.shots.find((s) => s.id === shotId)!;
    await h.repo.upsert(data.project.id, "shots", {
      ...shot,
      composition: { ...shot.composition, lens: "135mm" },
      updatedAt: h.clock.now.toISOString(),
    });
    const { ctx } = await ctxOf(h, shotId);
    await expect(
      promoteGeneratedFrame(deps(h), ctx, { attemptId: a!.id, userId: null }),
    ).rejects.toMatchObject({
      name: "GeneratedFrameRefused",
      code: "stale",
      message: expect.stringContaining("The Shot changed after this candidate was generated."),
    });
    expect((await ctxOf(h, shotId)).ctx.productionFrames).toHaveLength(0);
    expect(JSON.stringify((await attemptsOf(h, shotId))[0])).toBe(snapshot); // history is never rewritten

    // regenerate from the CURRENT Shot: the new candidate works
    h.clock.advance(5000);
    await generate(h, shotId, [mock("mock-image-1")], { now: h.clock.now });
    await drain(h);
    const fresh = (await attemptsOf(h, shotId)).at(-1)!;
    const ok = await promoteGeneratedFrame(deps(h), (await ctxOf(h, shotId)).ctx, {
      attemptId: fresh.id,
      userId: null,
    });
    expect(ok.created).toBe(true);
  });

  it("an attempt of another Project can never become this Project's frame", async () => {
    const { h, shotId } = await setup();
    await generate(h, shotId, THREE_NATIVE);
    await drain(h);
    const [a] = await attemptsOf(h, shotId);
    const other = remappedSeed("someone-elses");
    const otherShot = other.shots.find((s) => s.shotCode === "1A")!;
    const foreign = buildShotContext(other, otherShot.id);
    await expect(
      promoteGeneratedFrame(deps(h), foreign, { attemptId: a!.id, userId: null }),
    ).rejects.toBeInstanceOf(GeneratedFrameRefused);
    await expect(
      promoteGeneratedFrame(deps(h), foreign, { attemptId: a!.id, userId: null }),
    ).rejects.toMatchObject({
      code: "no_attempt",
    });
    // and a candidate of another SHOT in the same project is refused too
    const { ctx } = await ctxOf(h, shotId);
    const otherShotCtx = buildShotContext(
      await h.data(),
      (await h.data()).shots.find((s) => s.shotCode === "2A")!.id,
    );
    await expect(
      promoteGeneratedFrame(deps(h), otherShotCtx, { attemptId: a!.id, userId: null }),
    ).rejects.toMatchObject({
      code: "other_shot",
    });
    expect(ctx.productionFrames).toHaveLength(0);
  });

  it("a video attempt, a failed attempt or a missing attempt cannot be used", async () => {
    const { h, shotId } = await setup();
    await expect(
      promoteGeneratedFrame(deps(h), (await ctxOf(h, shotId)).ctx, { attemptId: "nope", userId: null }),
    ).rejects.toMatchObject({ code: "no_attempt" });
  });
});

describe.skipIf(!ffmpegAvailable)(
  "Use as Production Frame (memory): provider canvas vs production frame",
  () => {
    it("a wide-canvas candidate is refused until the production conform exists, then promoted from the conform", async () => {
      const { h, shotId } = await setup();
      // mock-image-wide only offers 21:9; the production frame is 16:9: an explicit adaptation (never silent)
      const plan = planCandidateSet({
        data: await h.data(),
        shotId,
        registry: h.registry,
        config: h.config,
        selections: [mock("mock-image-wide")],
        outcomes: [],
        purpose: "production_frame",
        now: h.clock.now,
      });
      expect(plan.items[0]!.fit.compatibility.adaptation!.framing.status).toBe("adapted");
      expect(plan.items[0]!.fit.compatibility.used.aspectRatio).toBe("21:9"); // the explicit provider canvas
      expect(plan.items[0]!.ignored.map((f) => f.feature)).toContain("adaptation"); // acknowledged, not silent

      await generate(h, shotId, [mock("mock-image-wide")]);
      await drain(h);
      const [a] = await attemptsOf(h, shotId);
      const view = (await h.repo.generation.getAttemptView(a!.id))!;
      const original = view.outputs[0]!.asset;
      expect(original).toMatchObject({ width: 672, height: 288 }); // provider original: 21:9, stored as is

      // 1. refused: the provider original is the wrong shape and no conform exists yet
      await expect(
        promoteGeneratedFrame(deps(h), (await ctxOf(h, shotId)).ctx, { attemptId: a!.id, userId: null }),
      ).rejects.toMatchObject({ code: "needs_conform", message: "Create the production conform first." });
      expect((await ctxOf(h, shotId)).ctx.productionFrames).toHaveLength(0);

      // 2. the deterministic delivery conform (the existing 2C pipeline)
      const framing = parseAdaptationPlan(view.attempt.adaptationPlan)!;
      const conformed = await conformAttemptOutput({
        attemptId: a!.id,
        attemptLabel: "1A-a1",
        original,
        plan: framing.conform,
        deps: { processor, storage: h.sink, qa: h.repo.mediaQa, userId: null },
      });
      expect(conformed.derived).not.toBeNull();
      expect(conformed.deliveryAsset.id).not.toBe(original.id);
      const w = conformed.deliveryAsset.width!;
      const hgt = conformed.deliveryAsset.height!;
      expect(Math.abs(w / hgt / (16 / 9) - 1)).toBeLessThan(0.01); // production-shaped

      // 3. now it can become the Production Frame: from the CONFORM; the provider original is untouched history
      const result = await promoteGeneratedFrame(deps(h), (await ctxOf(h, shotId)).ctx, {
        attemptId: a!.id,
        userId: null,
      });
      expect(result).toMatchObject({ created: true, image: "delivery_conform" });
      expect(result.frame.assetId).toBe(conformed.deliveryAsset.id);
      expect(result.frame.sourceGenerationAttemptId).toBe(a!.id);
      expect(Math.abs(result.frame.width / result.frame.height / (16 / 9) - 1)).toBeLessThan(0.01);
      const originalAfter = (await h.repo.generation.getAttemptView(a!.id))!.outputs[0]!.asset;
      expect(originalAfter).toEqual(original);
    });
  },
);
