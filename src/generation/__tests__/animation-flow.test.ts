import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GenerationSubmitError, STALE_ANIMATION_SOURCE_MESSAGE } from "@/data/generation-repository";
import { newUploadAsset } from "@/domain/__tests__/production-frame-fixtures";
import { draftCharacterContinuityLock } from "@/domain/character-continuity";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import {
  ANIMATE_NO_PRODUCTION_FRAME,
  animationFreshness,
  animationSource,
  shotAnimationSummary,
} from "@/domain/generation/animation";
import { isProductionFrameAttempt } from "@/domain/generation/schemas";
import { draftLocationView } from "@/domain/location-view";
import { draftProductionFrame, type ProductionFrame } from "@/domain/production-frame";
import type { ProjectData } from "@/domain/schemas";
import {
  ANIMATION_SOURCE_CHANGED_MESSAGE,
  CandidateSetBlockedError,
  planCandidateSet,
  submitCandidateSet,
  type CandidateSelection,
} from "../candidate-set";
import { prepareSubmission } from "../submission";
import { makeHarness, type Harness } from "./helpers";

/**
 * Phase 2H end to end on the memory repository with the FREE mock video models (no provider spend, no 3D, no GPU): a
 * Shot's selected, current Production Frame → an animation candidate set → the worker → video outputs whose frozen
 * requests start from exactly that frame; Best stays separate from final approval; another frame / a Lock switch / a
 * Location View change stales them (history intact); a source change mid-creation never yields a mixed-source set; the
 * worker refuses a tampered request before any provider call.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const ANIM = "animate_production_frame" as const;
const mock = (modelId: string): CandidateSelection => ({ provider: "mock", modelId });

/** ProjectData exactly as the server loaders attach it. */
async function attached(h: Harness): Promise<ProjectData> {
  const data = await h.data();
  const pf = await h.repo.productionFrames.listForProject(data.project.id);
  const lv = await h.repo.locationViews.listForProject(data.project.id);
  const cc = await h.repo.characterContinuity.listForProject(data.project.id);
  return {
    ...data,
    productionFrames: pf.frames,
    productionFrameSelections: pf.selections,
    locationViews: lv.views,
    shotLocationViewSelections: lv.selections,
    characterContinuityLocks: cc.locks,
    shotCharacterContinuitySelections: cc.selections,
  };
}

async function drain(h: Harness, rounds = 14) {
  for (let i = 0; i < rounds; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
}

async function animate(
  h: Harness,
  shotId: string,
  selections: CandidateSelection[],
  currentProductionFrameId?: () => Promise<string | null>,
) {
  return submitCandidateSet({
    data: await attached(h),
    shotId,
    registry: h.registry,
    config: h.config,
    generation: h.repo.generation,
    candidates: h.repo.candidates,
    selections,
    acknowledgeAll: true,
    confirmedTotalUsd: null,
    title: "Animation candidates",
    purpose: "2H",
    userId: null,
    projectRevision: null,
    generationPurpose: ANIM,
    currentProductionFrameId,
    now: h.clock.now,
  });
}

/** Uploads a 16:9 image as the Shot's Production Frame and selects it (the real repository path). */
async function makeFrame(h: Harness, shotId: string, label: string): Promise<ProductionFrame> {
  const data = await attached(h);
  const asset = newUploadAsset(data.project.id, { label, width: 1600, height: 900 });
  const drafted = draftProductionFrame(buildShotContext(data, shotId), {
    id: randomUUID(),
    now: h.clock.now.toISOString(),
    userId: null,
    source: "upload",
    asset,
  });
  if (!drafted.ok) throw new Error(drafted.problem.message);
  const r = await h.repo.productionFrames.create({
    draft: drafted.draft,
    newAsset: asset,
    select: true,
    userId: null,
    now: h.clock.now.toISOString(),
  });
  return r.frame;
}

const selectedId = (h: Harness, shotId: string) => async () => {
  const pf = await h.repo.productionFrames.listForProject((await h.data()).project.id);
  return pf.selections.find((s) => s.shotId === shotId)?.productionFrameId ?? null;
};

/** Shot 3A (Yumeko, 4.5 s from the performance), set to 16:9 so the free mock models are native. */
async function setup() {
  const h = makeHarness();
  const data = await h.data();
  const pid = data.project.id;
  const shot = data.shots.find((s) => s.shotCode === "3A")!;
  await h.repo.upsert(pid, "shots", {
    ...shot,
    composition: { ...shot.composition, aspectRatio: "16:9" },
    updatedAt: new Date(h.clock.now.getTime() - 1000).toISOString(),
  });
  return { h, pid, shotId: shot.id };
}

const attemptsOf = async (h: Harness, shotId: string) =>
  (await h.data()).attempts.filter((a) => a.shotId === shotId);

type Req = {
  purpose?: string;
  modality: string;
  startFrameAssetId: string | null;
  durationMs: number | null;
  references: Array<{ role: string; assetId: string }>;
};
const reqOf = (a: { request: unknown }) => a.request as Req;

describe("Animate Production Frame (memory, free mock video models)", () => {
  it("fresh PF → compare → set → worker → videos from EXACTLY that frame; Best ≠ final approval", async () => {
    const { h, pid, shotId } = await setup();

    // no frame yet: blocked with the exact message, nothing created
    await expect(animate(h, shotId, [mock("mock-video-1")])).rejects.toThrow(ANIMATE_NO_PRODUCTION_FRAME);
    expect(await attemptsOf(h, shotId)).toHaveLength(0);

    const v1 = await makeFrame(h, shotId, "pf-v1");

    // the comparison: a text-to-video-only model is INCOMPATIBLE, never a fallback
    const plan = planCandidateSet({
      data: await attached(h),
      shotId,
      registry: h.registry,
      config: h.config,
      selections: [mock("mock-video-1"), mock("mock-video-t2v")],
      outcomes: [],
      purpose: ANIM,
      now: h.clock.now,
    });
    expect(plan.items[0]!.blockers).toEqual([]);
    expect(plan.items[1]!.fit.status).toBe("unsupported");
    expect(plan.items[1]!.blockers.join(" ")).toMatch(
      /requires image-to-video from the canonical Production Frame/,
    );
    await expect(animate(h, shotId, [mock("mock-video-t2v")])).rejects.toBeInstanceOf(
      CandidateSetBlockedError,
    );

    // a real set: native model + a model that needs generate-longer-then-trim (5 s for a 4.5 s Shot)
    const out = await animate(h, shotId, [mock("mock-video-1"), mock("mock-video-169")]);
    expect(out.submitted).toBe(2);
    expect(out.view.set.recommendation).toMatchObject({
      generationPurpose: ANIM,
      animationSource: { frameId: v1.id, version: 1, assetId: v1.assetId },
    });
    await drain(h);

    const made = await attemptsOf(h, shotId);
    expect(made).toHaveLength(2);
    for (const a of made) {
      expect(a.status).toBe("succeeded");
      const r = reqOf(a);
      expect(r.purpose).toBe(ANIM);
      expect(r.modality).toBe("image_to_video");
      expect(a.requestModality).toBe("image_to_video");
      expect(r.startFrameAssetId).toBe(v1.assetId);
      expect(r.references.some((x) => x.role === "production_frame" || x.assetId === v1.assetId)).toBe(false);
      expect(r.references.some((x) => x.role === "storyboard")).toBe(false);
      expect(a.inputAssetIds).toContain(v1.assetId);
      expect(
        (a.packageSnapshot as { references: { productionFrame: { frameId: string; assetId: string } } })
          .references.productionFrame,
      ).toMatchObject({ frameId: v1.id, assetId: v1.assetId });
      // Shot output, never a Production Frame candidate
      expect(isProductionFrameAttempt(a)).toBe(false);
      const view = (await h.repo.generation.getAttemptView(a.id))!;
      expect(view.outputs.find((o) => o.output.role === "primary")?.asset.type).toBe("video");
    }
    const longer = made.find((a) => a.model === "mock-video-169")!;
    expect(reqOf(longer).durationMs).toBe(5000);
    expect((longer.adaptationPlan as { conform: { trimToMs: number } }).conform.trimToMs).toBe(4500);
    const native = made.find((a) => a.model === "mock-video-1")!;
    expect(reqOf(native).durationMs).toBe(4500);
    // the canonical frame and its Asset are untouched
    const after = await attached(h);
    expect(after.productionFrames?.find((f) => f.id === v1.id)).toEqual(v1);
    expect(after.productionFrameSelections?.find((s) => s.shotId === shotId)?.productionFrameId).toBe(v1.id);

    // ⭐ Best is the experiment's preference: it does NOT approve the Shot's output
    await h.repo.candidates.setPreferred(out.view.set.id, native.id, null, h.clock.now.toISOString());
    const stillUnapproved = (await h.data()).attempts.find((a) => a.id === native.id)!;
    expect(stillUnapproved.approved).toBe(false);
    const ctx = buildShotContext(await attached(h), shotId);
    expect(shotAnimationSummary(ctx, (await h.data()).attempts).state).toBe("candidates");
    // the explicit final approval stays the existing human step
    await h.repo.generation.reviewAttempt(native.id, {
      status: "approved",
      categories: [],
      reason: "",
      notes: "",
      now: h.clock.now.toISOString(),
    });
    const approvedNow = await attached(h);
    expect(shotAnimationSummary(buildShotContext(approvedNow, shotId), approvedNow.attempts)).toMatchObject({
      state: "final_approved",
      approvedAttemptId: native.id,
    });
    void pid;
  });

  it("PF v1 → animations → select PF v2: v1 animations stale (history kept); a new set starts from v2", async () => {
    const { h, shotId } = await setup();
    const v1 = await makeFrame(h, shotId, "pf-v1");
    await animate(h, shotId, [mock("mock-video-1")]);
    await drain(h);
    const [a1] = await attemptsOf(h, shotId);
    expect(animationFreshness(buildShotContext(await attached(h), shotId), a1!).status).toBe("fresh");

    const v2 = await makeFrame(h, shotId, "pf-v2");
    expect(v2.version).toBe(2);
    const data = await attached(h);
    const ctx = buildShotContext(data, shotId);
    const f = animationFreshness(ctx, a1!);
    expect(f.status).toBe("stale");
    expect(f.messages).toContain("The selected Production Frame changed");
    expect(shotAnimationSummary(ctx, data.attempts).state).toBe("stale");
    // historical attempt and its output untouched
    const again = data.attempts.find((a) => a.id === a1!.id)!;
    expect(reqOf(again).startFrameAssetId).toBe(v1.assetId);
    expect((await h.repo.generation.getAttemptView(a1!.id))!.outputs.length).toBeGreaterThan(0);

    await animate(h, shotId, [mock("mock-video-1")]);
    const newest = (await attemptsOf(h, shotId)).sort((x, y) => y.attemptNumber - x.attemptNumber)[0]!;
    expect(reqOf(newest).startFrameAssetId).toBe(v2.assetId);
  });

  it("a Production Frame change during set creation never yields a mixed-source set", async () => {
    const { h, shotId } = await setup();
    const v1 = await makeFrame(h, shotId, "pf-v1");
    const real = selectedId(h, shotId);

    // changed before the set starts: refused, nothing created
    await expect(animate(h, shotId, [mock("mock-video-1")], async () => "some-other-frame")).rejects.toThrow(
      ANIMATION_SOURCE_CHANGED_MESSAGE,
    );
    expect(await attemptsOf(h, shotId)).toHaveLength(0);
    expect(await real()).toBe(v1.id);

    // changed after the first candidate: nothing more is sent; what was sent used v1 only
    let calls = 0;
    const flips = async () => (++calls <= 2 ? v1.id : "v2-selected-elsewhere");
    const out = await animate(h, shotId, [mock("mock-video-1"), mock("mock-video-flaky")], flips);
    expect(out.submitted).toBe(1);
    expect(out.failed).toEqual([expect.objectContaining({ error: ANIMATION_SOURCE_CHANGED_MESSAGE })]);
    const sent = await attemptsOf(h, shotId);
    expect(sent).toHaveLength(1);
    expect(reqOf(sent[0]!).startFrameAssetId).toBe(v1.assetId);
  });

  it("the repository is the final authority: an animation whose frame moved before insertion is refused", async () => {
    const { h, shotId } = await setup();
    const v1 = await makeFrame(h, shotId, "pf-v1");
    const prepare = (data: ProjectData, key: string) =>
      prepareSubmission({
        data,
        shotId,
        registry: h.registry,
        provider: "mock",
        modelId: "mock-video-1",
        acknowledged: [],
        purpose: ANIM,
        userId: null,
        idempotencyKey: key,
        config: h.config,
        now: h.clock.now,
      }).input!;
    const before = await attached(h);
    // the expected source follows the purpose automatically: no caller sets it
    const input = prepare(before, "atomic-key-0001");
    expect(input.expectedAnimationProductionFrameId).toBe(v1.id);
    const replayed = prepare(before, "atomic-key-0002");

    const store = h.repo.generation as unknown as {
      jobs: Map<string, unknown>;
      costs: unknown[];
      events: unknown[];
    };
    const counts = async () => ({
      attempts: (await attemptsOf(h, shotId)).length,
      jobs: store.jobs.size,
      costs: store.costs.length,
      events: store.events.length,
    });

    // replay: accepted from v1, then v2 becomes canonical; the same key returns the accepted attempt, nothing new
    const accepted = await h.repo.generation.createAttemptWithJob(replayed);
    const v2 = await makeFrame(h, shotId, "pf-v2");
    const empty = await counts();
    expect(empty.attempts).toBe(1);
    const again = await h.repo.generation.createAttemptWithJob(replayed);
    expect(again).toMatchObject({ duplicate: true, attempt: { id: accepted.attempt.id } });
    expect(await counts()).toEqual(empty);

    // prepared from v1, v2 selected before insertion: refused, nothing persisted
    const refused = h.repo.generation.createAttemptWithJob(input);
    await expect(refused).rejects.toBeInstanceOf(GenerationSubmitError);
    await expect(h.repo.generation.createAttemptWithJob(input)).rejects.toMatchObject({
      code: "stale_animation_source",
      message: STALE_ANIMATION_SOURCE_MESSAGE,
    });
    expect(await counts()).toEqual(empty);

    // selection cleared before insertion: refused too
    (h.repo.productionFrames as unknown as { selections: Map<string, unknown> }).selections.delete(shotId);
    const fromV2 = { ...input, expectedAnimationProductionFrameId: v2.id };
    await expect(h.repo.generation.createAttemptWithJob(fromV2)).rejects.toMatchObject({
      code: "stale_animation_source",
    });
    expect(await counts()).toEqual(empty);
  });

  it("generic Shot output carries no expected animation frame (its submission is unchanged)", async () => {
    // the untouched seed Shot (its Storyboard is current, so generic Generate is allowed)
    const h = makeHarness();
    const shotId = await h.shotId("3A");
    const data = await attached(h);
    for (const [purpose, modelId] of [["shot_output", "mock-video-1"]] as const) {
      const prepared = prepareSubmission({
        data,
        shotId,
        registry: h.registry,
        provider: "mock",
        modelId,
        acknowledged: [],
        purpose,
        userId: null,
        idempotencyKey: `other-${purpose}-0001`,
        config: h.config,
        now: h.clock.now,
      });
      const acks = prepared.evaluation.compatibility?.ignoredFeatures.map((f) => f.id) ?? [];
      const input =
        prepared.input ??
        prepareSubmission({
          data,
          shotId,
          registry: h.registry,
          provider: "mock",
          modelId,
          acknowledged: acks,
          purpose,
          userId: null,
          idempotencyKey: `other-${purpose}-0001`,
          config: h.config,
          now: h.clock.now,
        }).input;
      expect(input, purpose).not.toBeNull();
      expect(input!.expectedAnimationProductionFrameId).toBeNull();
    }
  });

  it("a frame moved between the outer re-read and insertion: that candidate is refused, later ones stop", async () => {
    const { h, shotId } = await setup();
    const v1 = await makeFrame(h, shotId, "pf-v1");
    const create = h.repo.generation.createAttemptWithJob.bind(h.repo.generation);
    let calls = 0;
    const spy = vi.spyOn(h.repo.generation, "createAttemptWithJob").mockImplementation(async (input) => {
      // candidate B: the outer re-read already saw v1; v2 is selected right before B's insertion
      if (++calls === 2) await makeFrame(h, shotId, "pf-v2");
      return create(input);
    });
    // no outer accessor: the repository refusal alone must stop candidate C
    const out = await animate(h, shotId, [
      mock("mock-video-1"),
      mock("mock-video-169"),
      mock("mock-video-lite"),
    ]);
    spy.mockRestore();
    expect(calls).toBe(2);
    expect(out.submitted).toBe(1);
    expect(out.failed.map((f) => f.error)).toEqual([
      STALE_ANIMATION_SOURCE_MESSAGE,
      ANIMATION_SOURCE_CHANGED_MESSAGE,
    ]);
    const sent = await attemptsOf(h, shotId);
    expect(sent).toHaveLength(1);
    expect(reqOf(sent[0]!).startFrameAssetId).toBe(v1.assetId);
    // the set is truthful: one accepted member, two failed ones
    const members = out.view.members;
    expect(members.filter((m) => m.attemptId)).toHaveLength(1);
    expect(members.filter((m) => !m.attemptId)).toHaveLength(2);
  });

  it("the worker refuses a tampered animation request BEFORE any provider call", async () => {
    const { h, shotId } = await setup();
    await makeFrame(h, shotId, "pf-v1");
    const data = await attached(h);
    const prepared = prepareSubmission({
      data,
      shotId,
      registry: h.registry,
      provider: "mock",
      modelId: "mock-video-1",
      acknowledged: [],
      purpose: ANIM,
      userId: null,
      idempotencyKey: "tamper-key-0001",
      config: h.config,
      now: h.clock.now,
    });
    expect(prepared.input).not.toBeNull();
    const input = prepared.input!;
    // simulate a corrupted frozen request: the start frame is no longer the frozen Production Frame
    const other = data.assets.find(
      (a) => a.type === "image" && a.id !== reqOf(input.attempt).startFrameAssetId,
    )!;
    input.attempt.request = { ...input.attempt.request!, startFrameAssetId: other.id };
    const created = await h.repo.generation.createAttemptWithJob(input);
    const adapter = h.registry.adapter("mock")!;
    const submit = vi.spyOn(adapter, "submit");
    await drain(h, 3);
    expect(submit).not.toHaveBeenCalled();
    const view = (await h.repo.generation.getAttemptView(created.attempt.id))!;
    expect(view.attempt.status).toBe("failed");
    expect(view.job?.lastErrorCode).toBe("animation_source_invalid");
    submit.mockRestore();
  });

  it("Character Lock: a master Look edit keeps the animation fresh; switching the Lock stales it", async () => {
    const { h, pid, shotId } = await setup();
    const lib = await h.data();
    const shot = lib.shots.find((s) => s.id === shotId)!;
    const yumeko = shot.characters[0]!.characterId;
    const lookId = shot.characters[0]!.lookId!;
    const lock = async (name: string) => {
      const d = await attached(h);
      const r = draftCharacterContinuityLock({
        id: randomUUID(),
        now: h.clock.now.toISOString(),
        userId: null,
        projectId: pid,
        name,
        character: d.characters.find((c) => c.id === yumeko)!,
        look: d.looks.find((l) => l.id === lookId)!,
        identityRefs: d.identityRefs.filter((x) => x.characterId === yumeko),
        assets: d.assets,
      });
      if (!r.ok) throw new Error(r.message);
      return (await h.repo.characterContinuity.create(r.draft)).lock;
    };
    const lockA = await lock("Yumeko — A");
    await h.repo.characterContinuity.selectForAssignment({
      projectId: pid,
      shotId,
      characterId: yumeko,
      continuityLockId: lockA.id,
      userId: null,
      now: h.clock.now.toISOString(),
      expectedSelectedLockId: null,
    });
    await makeFrame(h, shotId, "pf-locked");
    await animate(h, shotId, [mock("mock-video-1")]);
    await drain(h);
    const [a] = await attemptsOf(h, shotId);
    expect(a!.status).toBe("succeeded");
    expect(
      (a!.packageSnapshot as { references: { characterContinuity?: Array<{ lockId: string }> } }).references
        .characterContinuity?.[0]?.lockId,
    ).toBe(lockA.id);

    // edit the MASTER Look: the locked Shot's truth is unchanged → still fresh
    const look = (await h.data()).looks.find((l) => l.id === lookId)!;
    await h.repo.upsert(pid, "looks", { ...look, wardrobe: "ivory tailored suit", hair: "loose waves" });
    expect(animationFreshness(buildShotContext(await attached(h), shotId), a!).status).toBe("fresh");

    // switch to Lock B (made from the edited library) → stale; a new animation is blocked until the frame is current
    const lockB = await lock("Yumeko — B");
    await h.repo.characterContinuity.selectForAssignment({
      projectId: pid,
      shotId,
      characterId: yumeko,
      continuityLockId: lockB.id,
      userId: null,
      now: h.clock.now.toISOString(),
      expectedSelectedLockId: lockA.id,
    });
    const ctxB = buildShotContext(await attached(h), shotId);
    expect(animationFreshness(ctxB, a!).status).toBe("stale");
    const src = animationSource(assembleGenerationPackage(ctxB));
    expect(src.ok).toBe(false);
    await expect(animate(h, shotId, [mock("mock-video-1")])).rejects.toThrow(/no longer matches the Shot/);
  });

  it("Location View A → animate → View B: the PF goes stale, new animation blocked, old animation stale", async () => {
    const { h, pid, shotId } = await setup();
    const data = await attached(h);
    const ctx0 = buildShotContext(data, shotId);
    expect(ctx0.location).not.toBeNull();
    const view = async (name: string) => {
      const asset = newUploadAsset(pid, { label: `view-${name}`, width: 1600, height: 900 });
      const d = draftLocationView({
        id: randomUUID(),
        now: h.clock.now.toISOString(),
        userId: null,
        projectId: pid,
        location: ctx0.location!,
        asset,
        source: "upload",
        spec: { name, kind: "establishing", viewpointDescription: `${name} viewpoint` },
      });
      if (!d.ok) throw new Error(d.message);
      return (await h.repo.locationViews.create({ draft: d.draft, newAsset: asset })).view;
    };
    const viewA = await view("Doorway");
    const viewB = await view("Lobby");
    await h.repo.locationViews.selectForShot({
      projectId: pid,
      shotId,
      locationViewId: viewA.id,
      userId: null,
      now: h.clock.now.toISOString(),
    });
    await makeFrame(h, shotId, "pf-view-a");
    await animate(h, shotId, [mock("mock-video-1")]);
    await drain(h);
    const [a] = await attemptsOf(h, shotId);
    expect(a!.status).toBe("succeeded");

    await h.repo.locationViews.selectForShot({
      projectId: pid,
      shotId,
      locationViewId: viewB.id,
      userId: null,
      now: h.clock.now.toISOString(),
      expectedSelectedViewId: viewA.id,
    });
    const ctx = buildShotContext(await attached(h), shotId);
    const src = animationSource(assembleGenerationPackage(ctx));
    expect(src.ok).toBe(false);
    if (!src.ok) expect(src.issues.map((i) => i.code)).toEqual(["production_frame_stale"]);
    expect(animationFreshness(ctx, a!).status).toBe("stale");
    await expect(animate(h, shotId, [mock("mock-video-1")])).rejects.toBeInstanceOf(CandidateSetBlockedError);
  });
});
