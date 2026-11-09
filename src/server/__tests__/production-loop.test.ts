import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildShotContext } from "@/domain/context";
import { parseAdaptationPlan } from "@/domain/framing/adaptation";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { productionFrameInputs } from "@/domain/generation/production-frame-inputs";
import { draftLocationView } from "@/domain/location-view";
import type { Asset, ProjectData } from "@/domain/schemas";
import { shotSnapshot } from "@/domain/story/shot-direction";
import { sceneSnapshot } from "@/domain/story/shot-list";
import { canonical, lineRangeOffsets } from "@/domain/story/writing";
import { submitCandidateSet } from "@/generation/candidate-set";
import { portraitFixturePng } from "@/generation/matting/fixture";
import { decodePng } from "@/generation/matting/png";
import { makeHarness, type Harness } from "@/generation/__tests__/helpers";
import { conformAttemptOutput } from "@/media/delivery";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import { GeneratedFrameRefused, promoteGeneratedFrame } from "@/server/production-frame-generated";
import { FakeStoryProvider } from "@/story/providers/fake";
import { createStoryRegistry } from "@/story/registry";
import { StoryWorker } from "@/story/worker";

/**
 * Phase 5B convergence: ONE local / mock path through the whole pre-video loop on Ojou-sama —
 *   screenplay → S1 Production Proposal → S2 AI writing (accepted) → S4 Shot List → I4/I5 Visual Bibles + Location View
 *   → S5 Storyboard Direction → I6 Production Frame Inputs → mock candidate → production conform → canonical Production
 *   Frame — then a screenplay change, to prove the staleness chain marks everything for review and deletes nothing.
 * Free fake Story providers and the free mock image model only; a network spy proves zero external calls.
 */
vi.hoisted(() => {
  process.env.PRISM_STUDIO_INLINE_WORKER = "0";
  process.env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER = "1";
  process.env.PRISM_STUDIO_STORY_AI_PROVIDERS = "openai";
  delete process.env.PRISM_STUDIO_ALLOW_PAID_STORY_AI;
});
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
      return attachedData(h, d);
    },
  };
});
vi.mock("@/server/storage", () => ({
  getUploadStorage: async () => null,
  storageForAsset: async () => null,
  checksum: (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
}));

import { saveScript } from "../actions";
import { planShotsWithPrism, submitShotListReview } from "../shot-list-actions";
import { directShotWithPrism, submitDirectionReview } from "../shot-direction-actions";
import { analyzeStory, submitProposalReview } from "../story-actions";
import { openStoryChangeFor } from "../story";
import { acceptWritingProposal, askPrism } from "../writing-actions";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const processor = new FfmpegMediaProcessor({ limits: { timeoutMs: 60_000 } });
const ffmpegAvailable = await processor.available();

async function attachedData(h: Harness, d: ProjectData): Promise<ProjectData> {
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
let fake: FakeStoryProvider;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h = makeHarness();
  world.h = h;
  fake = new FakeStoryProvider();
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled(); // zero external / paid calls anywhere in the loop
  fetchSpy.mockRestore();
});

const FREE = "prism-test/screenplay-parser-v1";
const data = async () => attachedData(h, (await h.repo.loadProject("ojousama"))!);
const form = (fields: Record<string, string>, slug = "ojousama") => {
  const f = new FormData();
  f.set("projectSlug", slug);
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const storyWork = () =>
  new StoryWorker({
    store: h.repo.story,
    writing: h.repo.writing,
    shotLists: h.repo.shotLists,
    directions: h.repo.shotDirections,
    registry: createStoryRegistry({ PRISM_STUDIO_STORY_AI_PROVIDERS: "" }, [fake]),
    workerId: "loop-story-worker",
  }).tick(5);
async function drain(rounds = 16) {
  for (let i = 0; i < rounds; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
}

/** A stored fixture image of this project (no provider). */
async function img(label: string): Promise<Asset> {
  const d = await data();
  const bytes = portraitFixturePng(128, 96);
  const id = randomUUID();
  const objectPath = `${d.project.id}/fixtures/${id}.png`;
  await h.sink.put(objectPath, bytes);
  const png = decodePng(bytes);
  const asset = {
    ...d.assets[0]!,
    id,
    projectId: d.project.id,
    type: "image",
    purpose: "identity_ref",
    source: "upload",
    name: `${label}.png`,
    originalFilename: `${label}.png`,
    storageProvider: "local",
    bucket: null,
    objectPath,
    mime: "image/png",
    byteSize: bytes.length,
    checksum: sha(bytes),
    width: png.width,
    height: png.height,
    durationMs: null,
    metadata: {},
  } as Asset;
  await h.repo.upsert(d.project.id, "assets", asset);
  return asset;
}

/** S2: select 1-based lines [a, b] of Episode 1, ask Prism, run the worker, accept version A. */
async function acceptedRevision(a: number, b: number, instruction: string) {
  const d = await data();
  const ep = d.episodes[0]!;
  const text = canonical(ep.scriptText);
  const r = lineRangeOffsets(text, a, b);
  const sessions = await h.repo.writing.listSessions(d.project.id, ep.id);
  expect(
    await askPrism(
      form({
        episodeId: ep.id,
        ...(sessions[0] ? { sessionId: sessions[0].id } : {}),
        scopeKind: "selection",
        selStart: String(r.start),
        selEnd: String(r.end),
        selText: text.slice(r.start, r.end),
        instruction,
        preset: "ask",
        model: FREE,
      }),
    ),
  ).toMatchObject({ ok: true });
  await storyWork();
  const sid = (await h.repo.writing.listSessions(d.project.id, ep.id))[0]!.id;
  const p = (await h.repo.writing.listProposals(d.project.id, sid)).at(-1)!;
  expect(p.status).toBe("ready");
  expect(await acceptWritingProposal(form({ proposalId: p.id, alternative: "0" }))).toMatchObject({
    ok: true,
  });
  return p;
}

describe("Phase 5B pre-video production loop (Ojou-sama, local / mock)", () => {
  it("screenplay → AI writing → Shot List → Visual Bibles → Storyboard Direction → canonical Production Frame; then the staleness chain", async () => {
    const d0 = await data();
    const scene3 = d0.scenes.find((s) => s.episodeId === d0.episodes[0]!.id && s.sceneNumber === "3")!;
    const shot3A = d0.shots.find((s) => s.shotCode === "3A")!;

    // ── STEP 1 · STORY: the screenplay → a Production Proposal → the production skeleton (a fresh project) ──
    expect(
      await analyzeStory(
        form({ model: FREE, sourceMode: "paste", text: d0.episodes[0]!.scriptText, title: "Ojou-sama" }),
      ),
    ).toMatchObject({ ok: true });
    await storyWork();
    const proposal = (await h.repo.story.list(d0.project.id))[0]!;
    expect(proposal.status).toBe("ready");
    expect(proposal.proposal!.characters.map((c) => c.name)).toEqual(
      expect.arrayContaining(["Yumeko", "Sean", "Takumi"]),
    );
    expect(proposal.proposal!.locations.map((l) => l.name)).toEqual(
      expect.arrayContaining([
        "Grand Celeste Lobby",
        "Sky-View Restaurant",
        "Hotel Hallway",
        "Tokyo Night Streets",
      ]),
    );
    expect(proposal.proposal!.scenes).toHaveLength(6);
    const skeletonId = randomUUID();
    await h.repo.createProject(
      { ...d0.project, id: skeletonId, slug: "loop-skeleton", title: "Loop skeleton" },
      { ...d0.bible, projectId: skeletonId },
    );
    expect(
      await analyzeStory(
        form(
          { model: FREE, sourceMode: "paste", text: d0.episodes[0]!.scriptText, title: "Ojou-sama" },
          "loop-skeleton",
        ),
      ),
    ).toMatchObject({ ok: true });
    await storyWork();
    const sk = (await h.repo.story.list(skeletonId))[0]!;
    const apply = form({ proposalId: sk.id, intent: "apply", targetKind: "new_episode" }, "loop-skeleton");
    for (const kind of ["character", "location", "scene", "shot"] as const)
      for (const item of sk.proposal![`${kind}s`] as Array<{ key: string }>)
        apply.set(`include:${kind}:${item.key}`, "1");
    expect(await submitProposalReview(apply)).toMatchObject({ ok: true });
    const skeleton = (await h.repo.loadProject("loop-skeleton"))!;
    expect(skeleton.characters.length).toBeGreaterThanOrEqual(3);
    expect(skeleton.locations.length).toBe(5);
    expect(skeleton.scenes).toHaveLength(6);
    expect(skeleton.shots.length).toBeGreaterThan(0);
    expect((await h.repo.writing.listRevisions(skeletonId, skeleton.episodes[0]!.id))[0]).toMatchObject({
      origin: "import",
    });

    // ── STEP 2 · WRITING: an accepted Prism revision of Scene 3 ──
    const scriptBefore = d0.episodes[0]!.scriptText;
    await acceptedRevision(21, 21, "Make the lobby feel tense.");
    const d2 = await data();
    expect(d2.episodes[0]!.scriptText).not.toBe(scriptBefore);
    expect(
      (await h.repo.writing.listRevisions(d0.project.id, d0.episodes[0]!.id)).map((r) => r.origin),
    ).toEqual(["ai_revision", "baseline"]);
    expect(await openStoryChangeFor(d0.project.id, scene3.id)).toBe(true); // Scene 3 has Shots → story-changed

    // ── STEP 3 · SHOT PLANNING: a Shot List for the accepted Scene; the master replaces 3A (approved), a single is added ──
    expect(await planShotsWithPrism(form({ sceneId: scene3.id, model: FREE }))).toMatchObject({ ok: true });
    await storyWork();
    const plan = (await h.repo.shotLists.listForScene(d0.project.id, scene3.id))[0]!;
    expect(plan.sceneText).toContain("(tightly)"); // planned against the ACCEPTED canon
    const planForm = form({ proposalId: plan.id, reviewPresent: "1", intent: "apply", confirmReplace: "on" });
    for (const s of plan.plan!.shots) {
      planForm.set(`include:${s.key}`, "on");
      planForm.set(`decision:${s.key}`, s.key === "sh1" ? shot3A.id : "create");
    }
    expect(await submitShotListReview(planForm)).toMatchObject({
      ok: true,
      message: "Applied: 1 Shot created, 1 replaced in place.",
    });
    const planned3A = (await data()).shots.find((s) => s.id === shot3A.id)!;
    expect(planned3A).toMatchObject({ shotCode: "3A", title: "Lobby master" });
    expect(planned3A.composition.notes).toMatch(/Source: lines 19–\d+ \(Shot List v1\)/);

    // ── STEP 5 (before direction, so S5 sees it) · VISUAL BIBLES: Yumeko canonical + Formal Black Look; Lobby canonical + View ──
    const d3 = await data();
    const yumeko = d3.characters.find((c) => c.name === "Yumeko")!;
    const lookId = planned3A.characters[0]!.lookId!;
    expect(d3.looks.find((l) => l.id === lookId)!.name).toBe("Episode 1 — Formal Black");
    const yCanon = await img("Yumeko canonical");
    await h.repo.upsert(d3.project.id, "identityRefs", {
      id: randomUUID(),
      characterId: yumeko.id,
      slot: "additional",
      assetId: yCanon.id,
      label: "Canonical identity",
      metadata: { visualRole: "canonical", source: "visual_bible" },
      locked: false,
    });
    const lookRef = await img("Yumeko Formal Black");
    const look = (await data()).looks.find((l) => l.id === lookId)!;
    await h.repo.upsert(d3.project.id, "looks", {
      ...look,
      referenceAssetIds: [...look.referenceAssetIds, lookRef.id],
    });
    const lobby = (await data()).locations.find((l) => l.name === "Grand Celeste Lobby")!;
    const lobbyCanon = await img("Grand Celeste Lobby canonical");
    await h.repo.upsert(d3.project.id, "locations", {
      ...lobby,
      visualBible: { canonicalAssetId: lobbyCanon.id, entries: [] },
    });
    const viewAsset = await img("Entrance to elevators");
    const drafted = draftLocationView({
      id: randomUUID(),
      now: h.clock.now.toISOString(),
      userId: null,
      projectId: d3.project.id,
      location: lobby,
      asset: viewAsset,
      source: "upload",
      spec: {
        name: "Entrance → elevators",
        kind: "entrance",
        viewpointDescription: "From the entrance toward the elevator bank",
        cameraPosition: "Just inside the revolving doors, looking north",
        cameraHeight: "eye level",
        lens: "35mm",
      },
    });
    if (!drafted.ok) throw new Error(drafted.message);
    const view = (await h.repo.locationViews.create({ draft: drafted.draft, newAsset: null })).view;
    await h.repo.locationViews.selectForShot({
      projectId: d3.project.id,
      shotId: shot3A.id,
      locationViewId: view.id,
      userId: null,
      now: h.clock.now.toISOString(),
    });

    // ── STEP 4 · DIRECTION: S5 on Shot 3A (the View is a hard constraint); every section applied ──
    expect(await directShotWithPrism(form({ shotId: shot3A.id, model: FREE }))).toMatchObject({ ok: true });
    await storyWork();
    const dir = (await h.repo.shotDirections.listForShot(d0.project.id, shot3A.id))[0]!;
    expect(dir.status).toBe("ready");
    expect(dir.direction!.locationView.usesSelectedView).toBe(true);
    const dirForm = form({ proposalId: dir.id, reviewPresent: "1", intent: "apply" });
    for (const s of ["camera", "blocking", "lighting", "composition", "continuity", "storyboard"])
      dirForm.set(`section:${s}`, "on");
    expect(await submitDirectionReview(dirForm)).toMatchObject({
      ok: true,
      message: "Direction v1 applied to Shot 3A.",
    });
    const directed = (await data()).shots.find((s) => s.id === shot3A.id)!;
    expect(directed.composition.cameraPosition).toMatch(/^Just inside the revolving doors, looking north/);
    expect(directed.composition.notes).toMatch(/Source: lines 19–\d+ \(Shot List v1\)/); // S4 traceability survives

    // ── STEP 6 · PRODUCTION FRAME INPUTS: everything arrives automatically ──
    const inputs = productionFrameInputs(
      assembleGenerationPackage(buildShotContext(await data(), shot3A.id), h.clock.now),
    );
    writeFileSync(`${process.env.TEMP ?? "/tmp"}/prism-loop-3A-inputs.json`, JSON.stringify(inputs, null, 1));
    expect(inputs.characters[0]!.lines).toEqual([
      "Yumeko — Canonical Identity",
      "Yumeko — Episode 1 — Formal Black Look",
      expect.stringMatching(/^Yumeko — screen right, midground/),
    ]);
    expect(inputs.location).toEqual(
      expect.arrayContaining([
        "Grand Celeste Lobby — Entrance → elevators",
        "Grand Celeste Lobby — Canonical",
      ]),
    );
    expect(inputs.direction[0]).toMatch(/^wide · 24–28mm — wide environmental · /);
    expect(inputs.direction.join(" ")).toContain("Yumeko in the midground, frame right");
    expect(inputs.story).toEqual(
      expect.arrayContaining(["3A — Lobby master", "Scene 3: INT. GRAND CELESTE LOBBY - NIGHT"]),
    );
    expect(inputs.ready).toEqual({ characters: true, location: true, direction: true, story: true });
    const refIds = inputs.references.map((r) => r.assetId);
    for (const a of [yCanon, lookRef, viewAsset, lobbyCanon]) expect(refIds).toContain(a.id);

    // ── STEP 7 · CANDIDATE → conform → canonical Production Frame ──
    h.clock.now = new Date(Date.now() + 1000); // the harness clock follows the real clock the Story actions wrote with
    const set = await submitCandidateSet({
      data: await data(),
      shotId: shot3A.id,
      registry: h.registry,
      config: h.config,
      generation: h.repo.generation,
      candidates: h.repo.candidates,
      selections: [{ provider: "mock", modelId: "mock-image-1" }],
      acknowledgeAll: true,
      confirmedTotalUsd: null,
      title: "Production Frame candidate",
      purpose: "",
      userId: null,
      projectRevision: null,
      generationPurpose: "production_frame",
      now: h.clock.now,
    });
    expect(set.submitted).toBe(1);
    await drain();
    const attempt = (await data()).attempts.filter((a) => a.shotId === shot3A.id).at(-1)!;
    expect(attempt.status).toBe("succeeded");
    const sent = (attempt.request as { references: Array<{ assetId: string }> }).references.map(
      (r) => r.assetId,
    );
    for (const a of [yCanon, lookRef, viewAsset, lobbyCanon]) expect(sent).toContain(a.id); // no manual attachment
    expect(attempt.prompt).toContain("Yumeko");
    await h.repo.candidates.setPreferred(set.view.set.id, attempt.id, null, h.clock.now.toISOString());
    const deps = { frames: h.repo.productionFrames, generation: h.repo.generation, qa: h.repo.mediaQa };
    let promoted;
    try {
      promoted = await promoteGeneratedFrame(deps, buildShotContext(await data(), shot3A.id), {
        attemptId: attempt.id,
        userId: null,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(GeneratedFrameRefused);
      expect((err as GeneratedFrameRefused).code).toBe("needs_conform");
      if (!ffmpegAvailable) return; // the conform needs ffmpeg (as the existing 2C tests do)
      const v = (await h.repo.generation.getAttemptView(attempt.id))!;
      await conformAttemptOutput({
        attemptId: attempt.id,
        attemptLabel: "3A-loop",
        original: v.outputs[0]!.asset,
        plan: parseAdaptationPlan(v.attempt.adaptationPlan)!.conform,
        deps: { processor, storage: h.sink, qa: h.repo.mediaQa, userId: null },
      });
      promoted = await promoteGeneratedFrame(deps, buildShotContext(await data(), shot3A.id), {
        attemptId: attempt.id,
        userId: null,
      });
    }
    expect(promoted.frame.sourceGenerationAttemptId).toBe(attempt.id);
    writeFileSync(
      `${process.env.TEMP ?? "/tmp"}/prism-loop-3A-frame.json`,
      JSON.stringify({
        image: promoted.image,
        width: promoted.frame.width,
        height: promoted.frame.height,
        references: sent.length,
      }),
    );
    // refresh: the canonical Production Frame stays selected
    expect(buildShotContext(await data(), shot3A.id).selectedProductionFrame?.id).toBe(promoted.frame.id);

    // ── STALENESS CHAIN: an accepted screenplay change to Scene 3 ──
    const before = await data();
    const directionsBefore = (await h.repo.shotDirections.listForProject(d0.project.id)).length;
    const listsBefore = (await h.repo.shotLists.listForScene(d0.project.id, scene3.id)).length;
    const shotsBefore = before.shots;
    await saveScript(
      form({
        episodeId: before.episodes[0]!.id,
        scriptText: before.episodes[0]!.scriptText.replace(
          "Yumeko stands alone at the elevators.",
          "Yumeko stands alone at the elevators, counting the floors.",
        ),
      }),
    );
    const after = await data();
    // story changed → breakdown needs review
    expect(await openStoryChangeFor(d0.project.id, scene3.id)).toBe(true);
    // the applied Shot plan is stale for the new canon (Re-plan offered, never automatic)
    expect(sceneSnapshot(after, after.episodes[0]!, scene3)!.sceneFingerprint).not.toBe(
      plan.sceneFingerprint,
    );
    // the applied direction needs review (its Scene fingerprint no longer matches)
    const applied = (await h.repo.shotDirections.listForShot(d0.project.id, shot3A.id)).find(
      (v) => v.status === "applied",
    )!;
    expect(shotSnapshot(after, shot3A.id)!.sceneFingerprint).not.toBe(applied.sceneFingerprint);
    // the Production Frame candidate is stale against the changed story context, but stays historical media
    const ctx = buildShotContext(after, shot3A.id);
    expect(ctx.selectedProductionFrame?.id).toBe(promoted.frame.id);
    expect(after.assets.some((a) => a.id === promoted.frame.assetId)).toBe(true);
    expect(after.attempts.find((a) => a.id === attempt.id)).toMatchObject({ status: "succeeded" });
    // nothing silently deleted, re-planned, re-directed or regenerated
    expect(after.shots.map((s) => s.id).sort()).toEqual(shotsBefore.map((s) => s.id).sort());
    expect(after.shots.find((s) => s.id === shot3A.id)!.composition).toEqual(directed.composition);
    expect((await h.repo.shotDirections.listForProject(d0.project.id)).length).toBe(directionsBefore);
    expect((await h.repo.shotLists.listForScene(d0.project.id, scene3.id)).length).toBe(listsBefore);
    expect(after.attempts.length).toBe(before.attempts.length);
    expect(fake.directCalls).toHaveLength(1);
    expect(fake.planCalls).toHaveLength(1);
  });
});
