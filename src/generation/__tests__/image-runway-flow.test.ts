import http from "node:http";
import type { AddressInfo } from "node:net";
import type RunwayML from "@runwayml/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { evaluateCompatibility } from "@/domain/generation/compatibility";
import { buildGenerationRequest } from "@/domain/generation/gate";
import { buildPromptPlan } from "@/domain/generation/prompt-plan";
import { generatedFramePromotion } from "@/domain/generated-production-frame";
import { GeneratedFrameRefused, promoteGeneratedFrame } from "@/server/production-frame-generated";
import {
  CandidateSetBlockedError,
  planCandidateSet,
  submitCandidateSet,
  type CandidateSelection,
} from "../candidate-set";
import { RunwayProvider, type RunwayClientLike, type RunwayTask } from "../providers/runway/adapter";
import { encodeMockPng } from "../providers/mock-image";
import { silentLogger } from "../log";
import { evaluateShotForModel } from "../submission";
import { GenerationWorker } from "../worker";
import { makeHarness, type Harness } from "./helpers";

/**
 * Phase 2G.2: Runway image models through the generic worker, with a fake SDK client (REAL RUNWAY IMAGE CALLS: 0, PAID
 * CALLS: 0). Proves the spend gates, the explicit 2.39:1 → provider-canvas adaptation, one provider call per
 * candidate, and the refinement flow that uses the current Production Frame as an image reference.
 */

type Body = RunwayML.TextToImageCreateParams;

class FakeImageRunway {
  images: Body[] = [];
  nextId = 1;
  tasks = new Map<string, RunwayTask>();
  outputUrl = "http://127.0.0.1:1/never";
  credits = 5;
  client(): RunwayClientLike {
    const noVideo = async (): Promise<{ id: string }> => {
      throw new Error("no video endpoint in the image suite");
    };
    return {
      textToVideo: { create: noVideo },
      imageToVideo: { create: noVideo },
      textToImage: {
        create: async (body) => {
          this.images.push(body);
          const id = `img_${this.nextId++}`;
          this.tasks.set(id, {
            id,
            status: "SUCCEEDED",
            output: [this.outputUrl],
            cost: { credits: this.credits },
          });
          return { id, estimatedCost: { credits: this.credits } };
        },
      },
      tasks: {
        retrieve: async (id) => {
          const t = this.tasks.get(id);
          if (!t) throw Object.assign(new Error("not found"), { status: 404 });
          return t;
        },
        delete: async () => undefined,
      },
    };
  }
}

const ENV = {
  NODE_ENV: "test",
  PRISM_STUDIO_GENERATION_PROVIDERS: "runway",
  RUNWAYML_API_SECRET: "key_test_0123456789abcdef0123456789",
  PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
  PRISM_STUDIO_MAX_GENERATION_USD: "2",
  PRISM_STUDIO_MAX_CANDIDATE_SET_USD: "5",
  PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
};

const SELECTIONS: CandidateSelection[] = [
  { provider: "runway", modelId: "gpt_image_2_5_flare" },
  { provider: "runway", modelId: "muse_image" },
  { provider: "runway", modelId: "seedream5_lite" },
];

describe("Runway image candidates through the worker (fake provider, loopback output server)", () => {
  let server: http.Server;
  let base = "";
  const png = Buffer.from(encodeMockPng(640, 360, 11));

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url?.startsWith("/out.png")) {
        res.writeHead(200, { "content-type": "image/png", "content-length": png.length });
        return res.end(png);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  async function setup(env: Record<string, string> = {}, aspect: string | null = "16:9") {
    const fake = new FakeImageRunway();
    fake.outputUrl = `${base}/out.png`;
    const real = new RunwayProvider({ env: { ...ENV, ...env }, clientFactory: () => fake.client() });
    const h = makeHarness({ ...ENV, ...env }, { extraAdapters: [real], replaceRegistry: true });
    const data = await h.data();
    const shot = data.shots.find((s) => s.shotCode === "1A")!;
    if (aspect) {
      await h.repo.upsert(data.project.id, "shots", {
        ...shot,
        composition: { ...shot.composition, aspectRatio: aspect },
        updatedAt: new Date(h.clock.now.getTime() - 1000).toISOString(),
      });
    }
    const worker = () =>
      new GenerationWorker({
        store: h.repo.generation,
        registry: h.registry,
        sink: h.sink,
        config: h.config,
        logger: silentLogger,
        clock: () => h.clock.now,
        workerId: "image-test",
        retryPolicy: { baseDelayMs: 100, maxDelayMs: 1000, jitter: 0 },
        random: () => 0,
        heartbeatMs: 0,
        unsafeAllowLoopbackHttp: true,
      });
    return { h, fake, worker, shotId: shot.id };
  }

  const submit = (
    h: Harness,
    shotId: string,
    selections: CandidateSelection[],
    over: Record<string, unknown> = {},
  ) =>
    h.data().then((data) =>
      submitCandidateSet({
        data,
        shotId,
        registry: h.registry,
        config: h.config,
        generation: h.repo.generation,
        candidates: h.repo.candidates,
        selections,
        acknowledgeAll: true,
        confirmedTotalUsd: null,
        title: "Runway frames",
        purpose: "first frame",
        userId: null,
        projectRevision: null,
        generationPurpose: "production_frame",
        now: h.clock.now,
        ...over,
      }),
    );

  const drain = async (h: Harness, worker: () => GenerationWorker, rounds = 14) => {
    for (let i = 0; i < rounds; i++) {
      await worker().tick(10);
      h.clock.advance(6000);
    }
  };

  const ctxOf = async (h: Harness, shotId: string) => {
    const loaded = await h.data();
    const { frames, selections } = await h.repo.productionFrames.listForProject(loaded.project.id);
    return buildShotContext(
      { ...loaded, productionFrames: frames, productionFrameSelections: selections },
      shotId,
    );
  };

  it("spend gates stay authoritative: a configured key alone is not permission to spend", async () => {
    const { h, shotId } = await setup({ PRISM_STUDIO_ALLOW_PAID_GENERATION: "false" });
    const plan = planCandidateSet({
      data: await h.data(),
      shotId,
      registry: h.registry,
      config: h.config,
      selections: SELECTIONS,
      outcomes: [],
      purpose: "production_frame",
      now: h.clock.now,
    });
    expect(plan.allowed).toBe(false);
    expect(plan.blockers.join(" ")).toMatch(/PRISM_STUDIO_ALLOW_PAID_GENERATION/);
    await expect(submit(h, shotId, SELECTIONS)).rejects.toBeInstanceOf(CandidateSetBlockedError);
    expect((await h.data()).attempts.filter((a) => a.shotId === shotId)).toHaveLength(0);
  });

  it("a per-attempt limit below one image's price blocks that candidate before anything is queued", async () => {
    const { h, shotId } = await setup({ PRISM_STUDIO_MAX_GENERATION_USD: "0.03" });
    const plan = planCandidateSet({
      data: await h.data(),
      shotId,
      registry: h.registry,
      config: h.config,
      selections: SELECTIONS,
      outcomes: [],
      purpose: "production_frame",
      now: h.clock.now,
    });
    const by = Object.fromEntries(plan.items.map((i) => [i.selection.modelId, i]));
    expect(by.muse_image!.blockers.filter((b) => /limit/i.test(b))).toHaveLength(0); // $0.01
    expect(by.gpt_image_2_5_flare!.blockers.join(" ")).toMatch(/exceeds the per-generation limit/); // $0.05
    expect(by.seedream5_lite!.blockers.join(" ")).toMatch(/exceeds the per-generation limit/); // $0.04
    expect(plan.allowed).toBe(false);
  });

  it("the confirmed total is recomputed on the server; an exact match creates three candidates, nothing is sent yet", async () => {
    const { h, fake, shotId } = await setup();
    const plan = planCandidateSet({
      data: await h.data(),
      shotId,
      registry: h.registry,
      config: h.config,
      selections: SELECTIONS,
      outcomes: [],
      purpose: "production_frame",
      now: h.clock.now,
    });
    // gpt medium $0.05 + muse $0.01 + seedream $0.04 (no references: nothing stored yet)
    expect(plan.spend.totalUsd).toBeCloseTo(0.1, 4);
    expect(plan.items.map((i) => i.estimateUsd)).toEqual([0.05, 0.01, 0.04]);
    await expect(submit(h, shotId, SELECTIONS, { confirmedTotalUsd: 0.05 })).rejects.toThrow(/confirm/i);
    await expect(submit(h, shotId, SELECTIONS, { confirmedTotalUsd: null })).rejects.toThrow(/confirm/i);
    const ok = await submit(h, shotId, SELECTIONS, { confirmedTotalUsd: 0.1 });
    expect(ok.submitted).toBe(3);
    expect(fake.images).toHaveLength(0); // creating attempts is not calling the provider
    // the frozen set carries the machine-readable purpose, the explicit default quality and the pricing version
    const set = (await h.repo.candidates.getSet(ok.view.set.id))!;
    expect((set.set.recommendation as { generationPurpose?: string }).generationPurpose).toBe(
      "production_frame",
    );
    const gpt = set.members.find((m) => m.model === "gpt_image_2_5_flare")!;
    expect(gpt.plan).toMatchObject({ generationPurpose: "production_frame", quality: "medium" });
    expect(gpt.estimateUsd).toBe(0.05);
  });

  it("3 candidates = 3 attempts = 3 jobs = 3 provider requests, each outputCount 1, each a private still", async () => {
    const { h, fake, worker, shotId } = await setup();
    await submit(h, shotId, SELECTIONS, { confirmedTotalUsd: 0.1 });
    await drain(h, worker);
    expect(fake.images).toHaveLength(3);
    for (const body of fake.images) expect((body as { outputCount?: number }).outputCount).toBe(1);
    expect(fake.images.map((b) => b.model).sort()).toEqual([
      "gpt_image_2_5_flare",
      "muse_image",
      "seedream5_lite",
    ]);
    const attempts = (await h.data()).attempts.filter((a) => a.shotId === shotId);
    expect(attempts).toHaveLength(3);
    for (const a of attempts) {
      expect(a.status).toBe("succeeded");
      const view = (await h.repo.generation.getAttemptView(a.id))!;
      expect(view.outputs).toHaveLength(1);
      expect(view.outputs[0]!.asset).toMatchObject({
        type: "image",
        source: "provider_output",
        width: 640,
        height: 360,
      });
      expect(view.costs.map((c) => c.kind)).toEqual(expect.arrayContaining(["estimated", "actual"]));
      // the frozen history holds no image bytes, no URL, no key
      const frozen = JSON.stringify(view.attempt);
      expect(frozen).not.toMatch(/data:image|127\.0\.0\.1|key_test_/);
      expect((view.attempt.request as { purpose?: string }).purpose).toBe("production_frame");
    }
    // the 16:9 Shot is native for GPT Image and Seedream; Muse has no 16:9 canvas, so it is an explicit adaptation
    const ratios = Object.fromEntries(fake.images.map((b) => [b.model, (b as { ratio: string }).ratio]));
    expect(ratios.gpt_image_2_5_flare).toBe("1920:1088");
    expect(ratios.seedream5_lite).toBe("2848:1600");
    expect(ratios.muse_image).toBe("2016:1152"); // 7:4, never silently called 16:9
    const museAttempt = attempts.find((a) => a.model === "muse_image")!;
    expect(museAttempt.adaptationPlan).toBeTruthy();
    expect(museAttempt.acknowledgedIgnored.length).toBeGreaterThan(0);
  });

  it("native aspect: a 16:9 provider original is promoted directly, with no conform", async () => {
    const { h, worker, shotId } = await setup();
    await submit(h, shotId, [SELECTIONS[0]!], { confirmedTotalUsd: 0.05 });
    await drain(h, worker);
    const [a] = (await h.data()).attempts.filter((x) => x.shotId === shotId);
    const out = (await h.repo.generation.getAttemptView(a!.id))!.outputs[0]!.asset;
    const r = await promoteGeneratedFrame(
      { frames: h.repo.productionFrames, generation: h.repo.generation, qa: h.repo.mediaQa },
      await ctxOf(h, shotId),
      { attemptId: a!.id, userId: null },
    );
    expect(r).toMatchObject({ created: true, image: "provider_original" });
    expect(r.frame.assetId).toBe(out.id);
    expect(await h.repo.mediaQa.getDelivery(a!.id)).toBeNull(); // no duplicate conform was needed
  });

  it("refinement: the current Production Frame is the FIRST image reference (image_to_image), and becoming stale once another frame is canonical", async () => {
    const { h, fake, worker, shotId } = await setup();
    // v1 from a first (text-to-image) candidate
    await submit(h, shotId, [SELECTIONS[0]!], { confirmedTotalUsd: 0.05 });
    await drain(h, worker);
    const deps = { frames: h.repo.productionFrames, generation: h.repo.generation, qa: h.repo.mediaQa };
    const first = (await h.data()).attempts.filter((x) => x.shotId === shotId)[0]!;
    const v1 = await promoteGeneratedFrame(deps, await ctxOf(h, shotId), {
      attemptId: first.id,
      userId: null,
    });
    expect(fake.images[0]).not.toHaveProperty("referenceImages"); // no stored reference existed yet: text_to_image

    // alternatives generated from v1: the Production Frame is an image reference, highest priority, tagged
    h.clock.advance(10_000);
    const refined = planCandidateSet({
      data: {
        ...(await h.data()),
        ...(await (async () => {
          const l = await h.repo.productionFrames.listForProject((await h.data()).project.id);
          return { productionFrames: l.frames, productionFrameSelections: l.selections };
        })()),
      },
      shotId,
      registry: h.registry,
      config: h.config,
      selections: [SELECTIONS[0]!],
      outcomes: [],
      purpose: "production_frame",
      now: h.clock.now,
    });
    const used = refined.items[0]!.fit.compatibility.used;
    expect(refined.items[0]!.fit.compatibility.modality).toBe("image_to_image");
    expect(used.references[0]).toMatchObject({ role: "production_frame", assetId: v1.frame.assetId });
    expect(refined.items[0]!.estimateUsd).toBe(0.06); // 5 + 1 credit for the one reference (per generated image)

    const data = await h.data();
    const withFrames = {
      ...data,
      ...(await (async () => {
        const l = await h.repo.productionFrames.listForProject(data.project.id);
        return { productionFrames: l.frames, productionFrameSelections: l.selections };
      })()),
    };
    await submitCandidateSet({
      data: withFrames,
      shotId,
      registry: h.registry,
      config: h.config,
      generation: h.repo.generation,
      candidates: h.repo.candidates,
      selections: [SELECTIONS[0]!],
      acknowledgeAll: true,
      confirmedTotalUsd: 0.06,
      title: "alternatives",
      purpose: "alternatives to v1",
      userId: null,
      projectRevision: null,
      generationPurpose: "production_frame",
      now: h.clock.now,
    });
    await drain(h, worker);
    const body = fake.images.at(-1) as Extract<Body, { model: "gpt_image_2_5_flare" }>;
    expect(body.referenceImages).toHaveLength(1);
    expect(body.referenceImages![0]!.tag).toBe("ProductionFrame");
    expect(body.referenceImages![0]!.uri.startsWith("data:image/png;base64,")).toBe(true);
    expect(body.promptText).toContain("@ProductionFrame is Current Production Frame.");
    const refinedAttempt = (await h.data()).attempts.filter((x) => x.shotId === shotId).at(-1)!;
    expect(refinedAttempt.requestModality).toBe("image_to_image");

    // while v1 is canonical the refinement may become v2...
    expect(
      generatedFramePromotion(await ctxOf(h, shotId), {
        attempt: refinedAttempt,
        original: (await h.repo.generation.getAttemptView(refinedAttempt.id))!.outputs[0]!.asset,
        delivery: null,
      }).available,
    ).toBe(true);
    // the refinement becomes v2 (a new canonical frame; v1 stays immutable history)
    const v2 = await promoteGeneratedFrame(deps, await ctxOf(h, shotId), {
      attemptId: refinedAttempt.id,
      userId: null,
    });
    expect(v2).toMatchObject({ created: true });
    expect(v2.frame.version).toBe(2);
    // using the SAME refinement again is the duplicate-promotion path, not a stale one (it was made from v1, and it
    // now IS the canonical frame): the existing frame is returned and re-selected, nothing is duplicated
    const again = await promoteGeneratedFrame(deps, await ctxOf(h, shotId), {
      attemptId: refinedAttempt.id,
      userId: null,
    });
    expect(again).toMatchObject({ created: false });
    expect(again.frame.id).toBe(v2.frame.id);
    expect((await ctxOf(h, shotId)).productionFrames).toHaveLength(2);
    // switching back to v1 (Shot Prep) makes it canonical again, and the refinement is still usable (its basis, v1, is canonical)
    await h.repo.productionFrames.select({
      projectId: v1.frame.projectId,
      shotId,
      productionFrameId: v1.frame.id,
      userId: null,
      now: h.clock.now.toISOString(),
    });
    expect((await ctxOf(h, shotId)).selectedProductionFrame!.id).toBe(v1.frame.id);
    expect(
      generatedFramePromotion(await ctxOf(h, shotId), {
        attempt: refinedAttempt,
        original: (await h.repo.generation.getAttemptView(refinedAttempt.id))!.outputs[0]!.asset,
        delivery: null,
      }).available,
    ).toBe(true);
    expect(first.id).not.toBe(refinedAttempt.id);
  });

  it("2.39:1 production frame vs a 21:9 provider canvas: explicit adaptation, never silently native", async () => {
    const { h, shotId } = await setup({}, null); // the seed Shot is 2.39:1
    const data = await h.data();
    const ctx = buildShotContext(data, shotId);
    expect(ctx.shot.composition.aspectRatio).toBe("2.39:1");
    const pkg = assembleGenerationPackage(ctx, h.clock.now);
    const flare = h.registry.model("runway", "gpt_image_2_5_flare")!;

    // 1. with no user choice the engine does NOT pick a strategy: the user must choose
    const open = evaluateCompatibility(pkg, flare, { purpose: "production_frame" });
    expect(open.adaptation!.framing.status).toBe("needs_choice");
    expect(open.adaptation!.framing.options.map((o) => o.strategy)).toEqual(
      expect.arrayContaining(["crop_to_production", "overscan_for_crop"]),
    );
    expect(open.compatible).toBe(false);
    const gate = evaluateShotForModel({
      data,
      shotId,
      registry: h.registry,
      provider: "runway",
      modelId: "gpt_image_2_5_flare",
      purpose: "production_frame",
      now: h.clock.now,
    });
    expect(gate.gate.allowed).toBe(false);

    // 2. the user chooses: the provider canvas is the documented 21:9 canvas, recorded in the plan
    const chosen = evaluateCompatibility(pkg, flare, {
      purpose: "production_frame",
      adaptation: { framing: "overscan_for_crop" },
    });
    expect(chosen.compatible).toBe(true);
    expect(chosen.adaptation!.framing).toMatchObject({
      status: "adapted",
      strategy: "overscan_for_crop",
      providerLabel: "21:9",
    });
    expect(chosen.used.aspectRatio).toBe("21:9");
    expect(chosen.ignoredFeatures.some((f) => f.feature === "adaptation")).toBe(true); // acknowledged, not silent
    const plan = buildPromptPlan(pkg, chosen.adaptation?.promptAdaptation);
    const request = buildGenerationRequest({
      pkg,
      model: flare,
      compatibility: chosen,
      plan,
      idempotencyKey: "adaptation-test-key",
    });
    expect(request).toMatchObject({
      purpose: "production_frame",
      modality: "text_to_image",
      aspectRatio: "21:9",
    });
    expect(h.registry.adapter("runway")!.compileRequest(request, plan).fields).toMatchObject({
      ratio: "2048:880",
    });

    // 3. the provider original is NOT 2.39:1, so it is refused as a Production Frame until a conform exists
    const original = {
      ...ctx.assets.values().next().value!,
      id: "11111111-1111-4111-8111-111111111111",
      projectId: ctx.project.id,
      type: "image" as const,
      mime: "image/png",
      objectPath: `${ctx.project.id}/provider/out.png`,
      width: 2048,
      height: 880,
      checksum: "a".repeat(64),
    };
    const attempt = {
      id: "22222222-2222-4222-8222-222222222222",
      projectId: ctx.project.id,
      shotId,
      status: "succeeded" as const,
      request: { ...request },
      packageSnapshot: JSON.parse(JSON.stringify(pkg)),
      packageFingerprint: pkg.provenance.fingerprint,
    };
    expect(
      generatedFramePromotion(ctx, { attempt: attempt as never, original, delivery: null }),
    ).toMatchObject({
      available: false,
      code: "needs_conform",
      reason: "Create the production conform first.",
    });
    // 4. once the conform (2.39:1) exists, it is used
    const conformed = {
      ...original,
      id: "33333333-3333-4333-8333-333333333333",
      width: 2048,
      height: 857,
      checksum: "b".repeat(64),
    };
    expect(
      generatedFramePromotion(ctx, { attempt: attempt as never, original, delivery: conformed }),
    ).toMatchObject({
      available: true,
      image: { role: "delivery_conform" },
    });
    expect(GeneratedFrameRefused).toBeDefined();
  });

  it("a native aspect needs no adaptation: 16:9 is a documented Seedream and GPT Image canvas", async () => {
    const { h, shotId } = await setup();
    const pkg = assembleGenerationPackage(buildShotContext(await h.data(), shotId), h.clock.now);
    for (const id of ["gpt_image_2_5_flare", "seedream5_lite"]) {
      const c = evaluateCompatibility(pkg, h.registry.model("runway", id)!, { purpose: "production_frame" });
      expect(c.adaptation!.framing.status, id).toBe("native");
      expect(c.compatible, id).toBe(true);
    }
    // Muse has no exact 16:9 canvas: an explicit choice, not a silent mislabel
    const muse = evaluateCompatibility(pkg, h.registry.model("runway", "muse_image")!, {
      purpose: "production_frame",
    });
    expect(muse.adaptation!.framing.status).toBe("needs_choice");
  });
});
