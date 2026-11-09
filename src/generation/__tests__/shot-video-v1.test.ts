import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newUploadAsset } from "@/domain/__tests__/production-frame-fixtures";
import { buildShotContext } from "@/domain/context";
import { parseAdaptationPlan } from "@/domain/framing/adaptation";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { animationFreshness, animationProvenance, animationSource } from "@/domain/generation/animation";
import { GenerationProviderError } from "@/domain/generation/errors";
import {
  ANIMATION_CONTINUITY_LINE,
  ANIMATION_MOTION_GUARD,
  ANIMATION_MOTION_LINE,
  ANIMATION_PRESERVE_LINE,
  ANIMATION_STATIC_CAMERA_LINE,
} from "@/domain/generation/prompt-plan";
import {
  clipDurationChoices,
  SHOT_CLIP_NO_FRAME,
  SHOT_CLIP_REPLACE_CONFIRM,
  shotClips,
  videoInputs,
} from "@/domain/generation/video-inputs";
import { draftProductionFrame, type ProductionFrame } from "@/domain/production-frame";
import type { ProjectData } from "@/domain/schemas";
import { applyShotDirection, defaultDirectionReview, shotSnapshot } from "@/domain/story/shot-direction";
import { conformAttemptOutput } from "@/media/delivery";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import { promoteGeneratedFrame } from "@/server/production-frame-generated";
import { fakeDirection } from "@/story/providers/fake-director";
import { planCandidateSet, submitCandidateSet, type CandidateSelection } from "../candidate-set";
import { silentLogger } from "../log";
import type { GenerationProviderAdapter } from "../provider";
import { ModelRegistry } from "../registry";
import { GenerationWorker } from "../worker";
import { makeHarness, type Harness } from "./helpers";

/**
 * Phase 5B-V1: canonical Production Frame → Animate → Video Inputs → mock clip → Use as Shot Clip → alternatives →
 * staleness, on the REAL 2H animation workflow (memory, the free mock video models, the in-process generation worker,
 * local Storage) and the real server actions. A network spy proves zero external calls.
 */
const world = vi.hoisted(() => ({ h: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock("@/server/auth", () => ({ requireUser: async () => ({ kind: "memory", id: "tester" }) }));
vi.mock("@/server/repo", async () => {
  const { UserFacingError } = await import("@/server/action-result");
  return {
    getRepo: async () => (world.h as Harness).repo,
    requireProjectFresh: async (slug: string) => {
      const h = world.h as Harness;
      const d = await h.repo.loadProject(slug);
      if (!d) throw new UserFacingError("That project no longer exists.");
      return attachedTo(h, d);
    },
  };
});
vi.mock("@/server/generation", () => ({
  getGenerationRepo: async () => (world.h as Harness).repo.generation,
  getRegistry: () => (world.h as Harness).registry,
  getGenerationConfig: () => (world.h as Harness).config,
}));
vi.mock("@/server/candidates", () => ({
  getCandidateRepo: async () => (world.h as Harness).repo.candidates,
}));
vi.mock("@/server/production-frames", () => ({
  getProductionFrameRepo: async () => (world.h as Harness).repo.productionFrames,
}));

import { promoteCandidate, reviewCandidate } from "@/server/candidate-actions";
import { generateClipAlternative, setShotClipDuration } from "@/server/video-actions";

const processor = new FfmpegMediaProcessor({ limits: { timeoutMs: 60_000 } });
const ffmpegAvailable = await processor.available();
const ANIM = "animate_production_frame" as const;

async function attachedTo(h: Harness, d: ProjectData): Promise<ProjectData> {
  const pf = await h.repo.productionFrames.listForProject(d.project.id);
  const lv = await h.repo.locationViews.listForProject(d.project.id);
  const cc = await h.repo.characterContinuity.listForProject(d.project.id);
  return {
    ...d,
    productionFrames: pf.frames,
    productionFrameSelections: pf.selections,
    locationViews: lv.views,
    shotLocationViewSelections: lv.selections,
    characterContinuityLocks: cc.locks,
    shotCharacterContinuitySelections: cc.selections,
  };
}

let h: Harness;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h = makeHarness();
  world.h = h;
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled(); // zero external provider calls
  fetchSpy.mockRestore();
});

const data = async () => attachedTo(h, (await h.repo.loadProject("ojousama"))!);
const ctxOf = async (shotId: string) => buildShotContext(await data(), shotId);
const pkgOf = async (shotId: string) => assembleGenerationPackage(await ctxOf(shotId), h.clock.now);
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  f.set("projectSlug", "ojousama");
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
async function drain(rounds = 14) {
  for (let i = 0; i < rounds; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
}
const mock = (modelId: string, direction?: string): CandidateSelection => ({
  provider: "mock",
  modelId,
  ...(direction ? { direction: { kind: "motion" as const, text: direction } } : {}),
});
async function animate(
  shotId: string,
  selections: CandidateSelection[],
  confirmedTotalUsd: number | null = null,
) {
  return submitCandidateSet({
    data: await data(),
    shotId,
    registry: h.registry,
    config: h.config,
    generation: h.repo.generation,
    candidates: h.repo.candidates,
    selections,
    acknowledgeAll: true,
    confirmedTotalUsd,
    title: "Animation candidates",
    purpose: "V1",
    userId: null,
    projectRevision: null,
    generationPurpose: ANIM,
    now: h.clock.now,
  });
}
/** Uploads a 16:9 image and makes it the Shot's canonical Production Frame (the real repository path). */
async function frame(shotId: string, label: string): Promise<ProductionFrame> {
  const d = await data();
  const asset = newUploadAsset(d.project.id, { label, width: 1600, height: 900 });
  const drafted = draftProductionFrame(buildShotContext(d, shotId), {
    id: randomUUID(),
    now: h.clock.now.toISOString(),
    userId: null,
    source: "upload",
    asset,
  });
  if (!drafted.ok) throw new Error(drafted.problem.message);
  return (
    await h.repo.productionFrames.create({
      draft: drafted.draft,
      newAsset: asset,
      select: true,
      userId: null,
      now: h.clock.now.toISOString(),
    })
  ).frame;
}
/** Shot `code` at 16:9 with a 5 s target, directed by S5 (the free director, applied into the existing fields). */
async function directedShot(code: string) {
  const d = await data();
  const shot = d.shots.find((s) => s.shotCode === code)!;
  await h.repo.upsert(d.project.id, "shots", {
    ...shot,
    composition: { ...shot.composition, aspectRatio: "16:9" },
    durationMode: "manual",
    targetDurationMs: 5000,
    updatedAt: new Date(h.clock.now.getTime() - 5000).toISOString(),
  });
  const snap = shotSnapshot(await data(), shot.id)!;
  const directed = applyShotDirection({
    shot: (await data()).shots.find((s) => s.id === shot.id)!,
    direction: fakeDirection(snap.context, ""),
    review: defaultDirectionReview(),
    context: snap.context,
    proposalVersion: 1,
    now: new Date(h.clock.now.getTime() - 4000).toISOString(),
  });
  await h.repo.upsert(d.project.id, "shots", directed);
  return directed;
}
const animationsOf = async (shotId: string) =>
  (await data()).attempts
    .filter((a) => a.shotId === shotId)
    .sort((a, b) => a.attemptNumber - b.attemptNumber);
const setOfAttempt = async (attemptId: string) =>
  (await h.repo.candidates.findSetForAttempt(attemptId))!.set.id;
const reqOf = (a: { request: unknown }) =>
  a.request as {
    modality: string;
    startFrameAssetId: string | null;
    durationMs: number | null;
    references: Array<{ assetId: string }>;
  };

describe("5B-V1 canonical Production Frame → Shot Clip (Ojou-sama, mock video)", () => {
  it("no canonical Production Frame: Animate is unavailable and Video Inputs say why", async () => {
    const shot = await directedShot("3A");
    const pkg = await pkgOf(shot.id);
    expect(animationSource(pkg)).toMatchObject({ ok: false, issues: [{ code: "no_production_frame" }] });
    expect(videoInputs(await ctxOf(shot.id), pkg, (await data()).attempts)).toMatchObject({
      ready: false,
      firstFrame: null,
    });
    expect(SHOT_CLIP_NO_FRAME).toBe("Select a Production Frame before animating this Shot.");
    await expect(animate(shot.id, [mock("mock-video-1")])).rejects.toThrow(/Production Frame/);
  });

  it("Shot 3A: Video Inputs, exact first frame, S5 motion + continuity protection, a stored immutable clip with lineage", async () => {
    const shot = await directedShot("3A");
    const pf = await frame(shot.id, "3A canonical");
    const ctx = await ctxOf(shot.id);
    const pkg = await pkgOf(shot.id);
    const vi1 = videoInputs(ctx, pkg, (await data()).attempts);
    expect(vi1).toMatchObject({
      ready: true,
      firstFrame: {
        label: "Production Frame v1 — Shot 3A",
        assetId: pf.assetId,
        image: "original",
        width: 1600,
        height: 900,
      },
      camera: "Static · eye level · 85mm — intimate compression",
      durationMs: 5000,
    });
    expect(vi1.firstFrame!.checksum).toBe((await data()).assets.find((a) => a.id === pf.assetId)!.checksum);
    expect(vi1.continuity).toEqual(
      expect.arrayContaining(["Yumeko — Episode 1 — Formal Black Look", "Grand Celeste Lobby"]),
    );
    expect(vi1.performance.join(" ")).toMatch(/stillness says what she will not/);
    expect(vi1.action.join(" ")).toContain("Yumeko in the midground, frame right");

    const set = await animate(shot.id, [mock("mock-video-1")]);
    expect(set.submitted).toBe(1);
    await drain();
    const [a] = await animationsOf(shot.id);
    // the exact canonical Production Frame is the first frame, never a reference, nothing else substituted
    expect(reqOf(a!)).toMatchObject({ modality: "image_to_video", startFrameAssetId: pf.assetId });
    expect(reqOf(a!).references.map((r) => r.assetId)).not.toContain(pf.assetId);
    expect(animationProvenance(a!)).toMatchObject({
      frameId: pf.id,
      version: 1,
      frameAssetId: pf.assetId,
      firstFrameMatches: true,
    });
    // S5 direction, restrained motion and continuity protection reach the motion prompt automatically
    expect(a!.prompt).toContain(ANIMATION_MOTION_LINE);
    expect(a!.prompt).toContain(ANIMATION_STATIC_CAMERA_LINE);
    expect(a!.prompt).toContain(ANIMATION_PRESERVE_LINE);
    expect(a!.prompt).toContain(ANIMATION_CONTINUITY_LINE);
    expect(a!.prompt).toMatch(/emotional intent: The space dwarfs her.*subtle actor motion/);
    expect(a!.prompt).toContain("Yumeko in the midground, frame right");
    // the clip: a new private video Asset of the Shot, with its lineage
    expect(a!).toMatchObject({ status: "succeeded", provider: "mock", model: "mock-video-1" });
    const view = (await h.repo.generation.getAttemptView(a!.id))!;
    const out = view.outputs[0]!.asset;
    expect(out).toMatchObject({ type: "video", mime: "video/webm", projectId: shot.projectId });
    expect(out.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect((await h.sink.get(out.objectPath!))!.length).toBeGreaterThan(1000);
    expect(view.job?.providerJobId).toMatch(/^mock_/); // provider job identity persisted
    expect(a!.packageFingerprint).toBeTruthy();
    expect(a!.durationMs).toBe(5000);
    expect(view.costs.length).toBeGreaterThan(0);
    // nothing is selected automatically
    expect(a!.approved).toBe(false);
    expect(shotClips(ctx, (await data()).attempts)[0]).toMatchObject({
      selected: false,
      fromEarlierFrame: false,
    });
  });

  it("Use as Shot Clip is explicit; replacing needs confirmation; the old clip stays; an alternative never replaces it", async () => {
    const shot = await directedShot("3A");
    await frame(shot.id, "3A canonical");
    await animate(shot.id, [mock("mock-video-1")]);
    await drain();
    const [first] = await animationsOf(shot.id);
    expect(
      await promoteCandidate(
        form({ attemptId: first!.id, setId: await setOfAttempt(first!.id), confirm: "1" }),
      ),
    ).toMatchObject({ ok: true });
    expect((await animationsOf(shot.id))[0]!.approved).toBe(true);
    // Generate Alternative (the real action): same frame, same model, the creator's motion note; current clip unchanged
    const note = "Less movement. Yumeko only glances toward Sean.";
    const altResult = await generateClipAlternative(form({ attemptId: first!.id, motionNote: note }));
    expect(altResult).toMatchObject({ ok: true });
    h.clock.now = new Date(Date.now() + 1000); // the real action stamps real time; the harness clock follows it
    await drain();
    const [, alt] = await animationsOf(shot.id);
    expect(reqOf(alt!).startFrameAssetId).toBe(reqOf(first!).startFrameAssetId);
    expect(alt!.modelSettings).toMatchObject({ creatorDirection: { kind: "motion", text: note } });
    expect(alt!.prompt).toContain(`Creator motion direction: ${note}`);
    expect(alt!.prompt).toContain(ANIMATION_MOTION_GUARD);
    expect(alt!.prompt).toContain(ANIMATION_CONTINUITY_LINE);
    const afterAlt = await animationsOf(shot.id);
    expect(afterAlt.find((a) => a.id === first!.id)!.approved).toBe(true);
    expect(afterAlt.find((a) => a.id === alt!.id)!.approved).toBe(false);
    // review: reject is a verdict, not a deletion
    expect(
      await reviewCandidate(form({ attemptId: alt!.id, decision: "reject", negative: "camera_motion" })),
    ).toMatchObject({ ok: true });
    // replacing the Shot Clip without the explicit confirmation is refused; with it, the old clip stays in history
    const altSet = await setOfAttempt(alt!.id);
    expect(await promoteCandidate(form({ attemptId: alt!.id, setId: altSet, confirm: "1" }))).toMatchObject({
      ok: false,
      error: SHOT_CLIP_REPLACE_CONFIRM,
    });
    expect(
      await promoteCandidate(form({ attemptId: alt!.id, setId: altSet, confirm: "1", confirmReplace: "1" })),
    ).toMatchObject({ ok: true });
    const final = await animationsOf(shot.id);
    expect(final.map((a) => [a.id, a.approved])).toEqual([
      [first!.id, false],
      [alt!.id, true],
    ]);
    const oldOut = (await h.repo.generation.getAttemptView(first!.id))!.outputs[0]!.asset;
    expect(await h.sink.get(oldOut.objectPath!)).not.toBeNull(); // the previous clip is never deleted
  });

  it("staleness: a new Production Frame marks clips 'earlier frame'; a real input change stales; irrelevant metadata does not", async () => {
    const shot = await directedShot("3A");
    await frame(shot.id, "3A v1");
    await animate(shot.id, [mock("mock-video-1")]);
    await drain();
    const [clip] = await animationsOf(shot.id);
    const fresh = async () => animationFreshness(await ctxOf(shot.id), clip!);
    expect((await fresh()).status).toBe("fresh");
    // irrelevant: another Character's notes and an unused Look's wardrobe were not inputs of this clip
    const d = await data();
    const takumi = d.characters.find((c) => c.name === "Takumi")!;
    await h.repo.upsert(d.project.id, "characters", { ...takumi, personality: "Changed." });
    const otherLook = d.looks.find((l) => l.characterId === takumi.id)!;
    await h.repo.upsert(d.project.id, "looks", { ...otherLook, wardrobe: "A different suit." });
    expect((await fresh()).status).toBe("fresh");
    // a real input: the applied direction's lighting mood
    const s = (await data()).shots.find((x) => x.id === shot.id)!;
    await h.repo.upsert(d.project.id, "shots", {
      ...s,
      lighting: { ...s.lighting, mood: "Tense" },
      updatedAt: h.clock.now.toISOString(),
    });
    expect((await fresh()).status).toBe("stale");
    // a new canonical Production Frame: the old clip is historical, "Generated from an earlier Production Frame"
    h.clock.advance(5000);
    const v2 = await frame(shot.id, "3A v2");
    const clips = shotClips(await ctxOf(shot.id), (await data()).attempts);
    expect(clips[0]).toMatchObject({ fromEarlierFrame: true });
    expect((await h.repo.generation.getAttemptView(clip!.id))!.attempt.status).toBe("succeeded"); // never deleted
    // a new animation starts from the new frame only
    await animate(shot.id, [mock("mock-video-1")]);
    await drain();
    expect(reqOf((await animationsOf(shot.id)).at(-1)!).startFrameAssetId).toBe(v2.assetId);
  });

  it("durations: only supported values; an unsupported Shot duration is refused, never faked", async () => {
    const shot = await directedShot("3A");
    await frame(shot.id, "3A canonical");
    const choices = clipDurationChoices(h.registry.usable());
    expect(choices).toContain(5000);
    expect(choices).not.toContain(4500);
    expect(await setShotClipDuration(form({ shotId: shot.id, durationMs: "10000" }))).toMatchObject({
      ok: true,
      message: "Clip duration set to 10 seconds.",
    });
    expect((await data()).shots.find((s) => s.id === shot.id)).toMatchObject({
      targetDurationMs: 10_000,
      durationMode: "manual",
    });
    expect(await setShotClipDuration(form({ shotId: shot.id, durationMs: "4321" }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^Choose a duration an available video model supports/),
    });
    // 12 s on a 5 s / 10 s model: refused (no rounding, no stitching)
    const s = (await data()).shots.find((x) => x.id === shot.id)!;
    await h.repo.upsert(shot.projectId, "shots", {
      ...s,
      targetDurationMs: 12_000,
      updatedAt: h.clock.now.toISOString(),
    });
    await expect(animate(shot.id, [mock("mock-video-lite")])).rejects.toThrow();
  });

  it("cost: candidates × duration are totalled before submission and a paid set needs the confirmed total", async () => {
    const paid = makeHarness({
      PRISM_STUDIO_GENERATION_PROVIDERS: "runway",
      RUNWAYML_API_SECRET: "test-secret-not-real",
      PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
      PRISM_STUDIO_MAX_GENERATION_USD: "10",
      PRISM_STUDIO_MAX_CANDIDATE_SET_USD: "10",
    });
    h = paid;
    world.h = paid;
    const shot = await directedShot("3A");
    await frame(shot.id, "3A canonical");
    const runway = paid.registry
      .usable()
      .filter((m) => m.provider === "runway" && m.capabilities.modalities.includes("image_to_video"));
    const two = runway.slice(0, 2).map((m) => ({ provider: "runway", modelId: m.modelId }));
    const plan = planCandidateSet({
      data: await data(),
      shotId: shot.id,
      registry: paid.registry,
      config: paid.config,
      selections: two,
      outcomes: [],
      purpose: ANIM,
      now: paid.clock.now,
    });
    const ok = plan.items.filter((i) => i.estimateUsd != null);
    expect(ok.length).toBeGreaterThan(0);
    expect(plan.spend.totalUsd).toBeCloseTo(
      ok.reduce((t, i) => t + i.estimateUsd!, 0),
      4,
    );
    await expect(animate(shot.id, two, null)).rejects.toThrow(/confirm/i); // nothing submitted, nothing called
    expect(await animationsOf(shot.id)).toHaveLength(0);
  });

  it("an uncertain submission is never blindly resubmitted (the worker stops, the provider was called once)", async () => {
    const shot = await directedShot("3A");
    await frame(shot.id, "3A canonical");
    await animate(shot.id, [mock("mock-video-lite")]);
    const [a] = await animationsOf(shot.id);
    const jobId = (await h.repo.generation.getAttemptView(a!.id))!.job!.id;
    const real = h.registry.adapter("mock")!;
    let calls = 0;
    const wrapped: GenerationProviderAdapter = Object.create(real);
    wrapped.submit = async (...args) => {
      calls++;
      if (calls === 1) throw new GenerationProviderError("timeout", "net_timeout", "timed out");
      return real.submit(...args);
    };
    const worker = new GenerationWorker({
      store: h.repo.generation,
      registry: new ModelRegistry([wrapped], h.config, {}),
      sink: h.sink,
      config: h.config,
      logger: silentLogger,
      clock: () => h.clock.now,
      workerId: "v1",
      retryPolicy: { baseDelayMs: 100, maxDelayMs: 1000, jitter: 0 },
      random: () => 0,
      heartbeatMs: 0,
    });
    await worker.tick();
    h.clock.advance(5000);
    await worker.tick();
    const job = (await h.repo.generation.getJob(jobId))!;
    expect(job).toMatchObject({ status: "failed", lastErrorCode: "submission_outcome_unknown" });
    expect(calls).toBe(1);
  });

  it.skipIf(!ffmpegAvailable)(
    "a 2.39:1 Production Frame made from a conform: the video starts from that exact conform",
    async () => {
      const d = await data();
      const shot = d.shots.find((s) => s.shotCode === "3A")!; // 2.39:1 (the bible)
      const cand = await submitCandidateSet({
        data: d,
        shotId: shot.id,
        registry: h.registry,
        config: h.config,
        generation: h.repo.generation,
        candidates: h.repo.candidates,
        selections: [{ provider: "mock", modelId: "mock-image-1" }],
        acknowledgeAll: true,
        confirmedTotalUsd: null,
        title: "PF",
        purpose: "",
        userId: null,
        projectRevision: null,
        generationPurpose: "production_frame",
        now: h.clock.now,
      });
      await drain();
      const still = (await animationsOf(shot.id)).at(-1)!;
      const view = (await h.repo.generation.getAttemptView(still.id))!;
      const conformed = await conformAttemptOutput({
        attemptId: still.id,
        attemptLabel: "3A-pf",
        original: view.outputs[0]!.asset,
        plan: parseAdaptationPlan(view.attempt.adaptationPlan)!.conform,
        deps: { processor, storage: h.sink, qa: h.repo.mediaQa, userId: null },
      });
      await h.repo.candidates.setPreferred(cand.view.set.id, still.id, null, h.clock.now.toISOString());
      const promoted = await promoteGeneratedFrame(
        { frames: h.repo.productionFrames, generation: h.repo.generation, qa: h.repo.mediaQa },
        buildShotContext(await data(), shot.id),
        { attemptId: still.id, userId: null },
      );
      expect(promoted.image).toBe("delivery_conform");
      expect(promoted.frame.assetId).toBe(conformed.deliveryAsset.id);
      expect(promoted.frame.assetId).not.toBe(view.outputs[0]!.asset.id);
      expect(
        videoInputs(await ctxOf(shot.id), await pkgOf(shot.id), (await data()).attempts).firstFrame,
      ).toMatchObject({ image: "production_conform", assetId: conformed.deliveryAsset.id });
      await animate(shot.id, [mock("mock-video-1")]);
      await drain();
      const clip = (await animationsOf(shot.id)).at(-1)!;
      expect(reqOf(clip).startFrameAssetId).toBe(conformed.deliveryAsset.id); // never the unconformed original
    },
  );

  it("refusals: another project's image as a start frame blocks Animate; another project's clip cannot be promoted", async () => {
    const shot = await directedShot("3A");
    await frame(shot.id, "3A canonical");
    const foreign = newUploadAsset(randomUUID(), { label: "foreign", width: 1600, height: 900 });
    const s = (await data()).shots.find((x) => x.id === shot.id)!;
    await h.repo.upsert(shot.projectId, "shots", {
      ...s,
      generation: { ...s.generation, startFrameAssetId: foreign.id },
    });
    expect(animationSource(await pkgOf(shot.id))).toMatchObject({
      ok: false,
      issues: [{ code: "start_override_conflict" }],
    });
    expect(
      await promoteCandidate(form({ attemptId: randomUUID(), setId: randomUUID(), confirm: "1" })),
    ).toMatchObject({ ok: false, error: "That generation no longer exists." });
  });

  it("three Shots keep their own first frame, motion direction, selected clip and lineage", async () => {
    const d0 = await data();
    const base = d0.shots.find((s) => s.shotCode === "3A")!;
    for (const [code, order] of [
      ["3B", 1],
      ["3C", 2],
    ] as const)
      await h.repo.upsert(d0.project.id, "shots", {
        ...structuredClone(base),
        id: randomUUID(),
        shotCode: code,
        order,
        title: `${code} coverage`,
      });
    const out: Record<string, { frame: string; clip: string; start: string | null; prompt: string }> = {};
    for (const [code, motion] of [
      ["3A", ""],
      ["3B", "Yumeko turns her head slowly."],
      ["3C", "A slow push in."],
    ] as const) {
      const shot = await directedShot(code);
      const pf = await frame(shot.id, `${code} canonical`);
      await animate(shot.id, [mock("mock-video-1", motion || undefined)]);
      await drain();
      const [clip] = await animationsOf(shot.id);
      await promoteCandidate(
        form({ attemptId: clip!.id, setId: await setOfAttempt(clip!.id), confirm: "1" }),
      );
      out[code] = {
        frame: pf.assetId,
        clip: clip!.id,
        start: reqOf(clip!).startFrameAssetId,
        prompt: clip!.prompt,
      };
    }
    const d = await data();
    for (const code of ["3A", "3B", "3C"]) {
      const shot = d.shots.find((s) => s.shotCode === code)!;
      const mine = d.attempts.filter((a) => a.shotId === shot.id);
      expect(mine.filter((a) => a.approved).map((a) => a.id)).toEqual([out[code]!.clip]);
      expect(out[code]!.start).toBe(out[code]!.frame);
      expect(animationProvenance(mine[0]!)!.frameAssetId).toBe(out[code]!.frame);
    }
    expect(new Set(Object.values(out).map((o) => o.frame)).size).toBe(3);
    expect(out["3B"]!.prompt).toContain("Creator motion direction: Yumeko turns her head slowly.");
    expect(out["3C"]!.prompt).toContain("Creator motion direction: A slow push in.");
    expect(out["3A"]!.prompt).not.toContain("Creator motion direction");
  });
});
