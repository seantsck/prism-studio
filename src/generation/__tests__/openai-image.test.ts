import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GenerationProviderError } from "@/domain/generation/errors";
import type { GenerationRequest } from "@/domain/generation/schemas";
import { OPENAI_IMAGE_UPSTREAM_NOT_DEFAULT } from "@/domain/generation/models/openai-image-catalog";
import { readGenerationConfig } from "../config";
import { MockProvider } from "../providers/mock";
import { OPENAI_IMAGE_SECRET_ENV, OpenAIImageProvider } from "../providers/openai-image/adapter";
import { FakeOpenAIImageTransport } from "../providers/openai-image/fake-transport";
import { OpenAIImageTransportError } from "../providers/openai-image/transport";
import { createRegistry, ModelRegistry } from "../registry";
import { prepareSubjectImage } from "../subject-submission";
import { makeHarness, type Harness } from "./helpers";

/**
 * Phase 5B-I2: GPT Image directly through OpenAI (`openai-image`). Every test runs on the FAKE transport: nothing here
 * reaches OpenAI and nothing is billed.
 */
const KEY = "sk-proj-TESTKEYDONOTUSE1234567890abcdefABCDEF";
const PAID = {
  PRISM_STUDIO_GENERATION_PROVIDERS: "openai-image",
  PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
  PRISM_STUDIO_MAX_GENERATION_USD: "2",
};

function world(env: Record<string, string> = {}) {
  const fake = new FakeOpenAIImageTransport();
  const provider = new OpenAIImageProvider({
    env: { ...PAID, [OPENAI_IMAGE_SECRET_ENV]: KEY, ...env },
    transportFactory: () => fake,
  });
  const h = makeHarness(
    { ...PAID, [OPENAI_IMAGE_SECRET_ENV]: KEY, ...env },
    { extraAdapters: [new MockProvider({ stageDelayMs: 0 }), provider], replaceRegistry: true },
  );
  return { h, fake, provider };
}

async function subject(
  h: Harness,
  kind: "character" | "location",
  extra: Partial<Parameters<typeof prepareSubjectImage>[0]> = {},
  modelId = "gpt-image-2.5-flare",
) {
  const data = await h.data();
  const s =
    kind === "character"
      ? {
          kind: "character" as const,
          characterId: data.characters.find((c) => c.name === "Yumeko")!.id,
          intent: "portrait" as const,
        }
      : {
          kind: "location" as const,
          locationId: data.locations[0]!.id,
          intent: "establishing_view" as const,
        };
  return prepareSubjectImage({
    data,
    input: { subject: s, direction: "" },
    registry: h.registry,
    provider: "openai-image",
    modelId,
    aspectRatio: "1:1",
    userId: null,
    idempotencyKey: `oai-${randomUUID()}`,
    config: h.config,
    now: h.clock.now,
    ...extra,
  });
}

/** The frozen request a prepared subject attempt will send (stored on the attempt). */
const reqOf = (p: { ok: true; input: { attempt: { request: unknown } } } | { ok: boolean }) =>
  (p as { input: { attempt: { request: unknown } } }).input.attempt.request as GenerationRequest;

async function run(h: Harness, ticks = 3) {
  for (let i = 0; i < ticks; i++) {
    await h.worker().tick(5);
    h.clock.advance(2000);
  }
}

describe("openai-image: registry, credentials and the worker-only secret", () => {
  it("is registered with the two GPT Image 2.5 models as paid, real, image models", () => {
    const r = createRegistry({ NODE_ENV: "test" });
    const models = r.models().filter((m) => m.provider === "openai-image");
    expect(models.map((m) => m.modelId)).toEqual(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
    for (const m of models) {
      expect(m.kind).toBe("real");
      expect(r.billsMoney(m)).toBe(true);
      expect(m.capabilities.image).toMatchObject({ transparency: true, editing: true });
      expect(m.capabilities.operational).toMatchObject({
        mode: "sync",
        idempotency: false,
        cancellation: false,
      });
      expect(m.capabilities.references.maxReferences).toBe(16);
    }
    // not enabled by default: nothing is usable without an explicit deployment decision
    expect(r.usable().some((m) => m.provider === "openai-image")).toBe(false);
    // GPT Image 2.6 is known upstream but NOT offered (not SDK-typed, not ZDR-listed)
    for (const u of OPENAI_IMAGE_UPSTREAM_NOT_DEFAULT) {
      expect(u.status).toBe("available upstream, not yet default");
      expect(r.model("openai-image", u.modelId)).toBeNull();
    }
  });

  it("the web queues it as worker-backed WITHOUT the key; the worker without the key fails closed", () => {
    const cfgWeb = readGenerationConfig({ ...PAID, PRISM_STUDIO_WORKER_BACKED_PROVIDERS: "openai-image" });
    const web = new ModelRegistry([new OpenAIImageProvider({ env: {} })], cfgWeb, {});
    expect(web.availability().every((a) => a.available && a.missingConfig.length === 0)).toBe(true);
    const worker = new ModelRegistry([new OpenAIImageProvider({ env: {} })], readGenerationConfig(PAID), {});
    for (const a of worker.availability()) {
      expect(a.available).toBe(false);
      expect(a.missingConfig).toEqual(["PRISM_STUDIO_PROVIDER_OPENAI_IMAGE_API_KEY"]);
    }
  });

  it("a paid model is refused while paid generation is off (no call can happen)", async () => {
    const { h, fake } = world({ PRISM_STUDIO_ALLOW_PAID_GENERATION: "false" });
    const p = await subject(h, "location");
    expect(p).toMatchObject({ ok: false });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("openai-image: compile, validate, estimate (pure)", () => {
  it("text-to-image goes to /images/generations; image-to-image to /images/edits with the source FIRST", async () => {
    const { h, provider } = world();
    const loc = await subject(h, "location");
    if (!loc.ok) throw new Error(loc.reasons.join(" "));
    const req = reqOf(loc);
    const plan = loc.input.attempt.promptPlan!;
    const c = provider.compileRequest(req, plan);
    expect(c.endpoint).toBe(
      `POST /v1/images/${req.modality === "image_to_image" ? "edits" : "generations"} (gpt-image-2.5-flare)`,
    );
    expect(c.fields).toMatchObject({
      size: "1024x1024",
      quality: "medium",
      background: "opaque",
      outputFormat: "png",
      n: 1,
    });
  });

  it("refuses what the model does not offer instead of emulating it", () => {
    const { provider } = world();
    const model = provider.listModels()[0]!;
    const base = {
      schemaVersion: 1 as const,
      modality: "text_to_image" as const,
      purpose: "character_image" as const,
      provider: "openai-image",
      modelId: model.modelId,
      prompt: { positive: "a portrait", negative: "" },
      durationMs: null,
      resolution: null,
      aspectRatio: "1:1",
      fps: null,
      seed: null,
      references: [],
      startFrameAssetId: null,
      endFrameAssetId: null,
      audioAssetIds: [],
      providerOptions: {},
      idempotencyKey: "k",
    };
    expect(provider.validateRequest(base, model).ok).toBe(true);
    expect(provider.validateRequest({ ...base, aspectRatio: "21:9" }, model).errors[0]).toMatch(
      /21:9 is not available/,
    );
    expect(
      provider.validateRequest({ ...base, providerOptions: { quality: "max" } }, model).errors[0],
    ).toMatch(/no max quality/);
    expect(
      provider.validateRequest({ ...base, providerOptions: { background: "auto" } }, model).errors[0],
    ).toMatch(/background must be/);
  });

  it("the pre-submit estimate is a deterministic upper bound that grows with quality and references", () => {
    const { provider } = world();
    const model = provider.listModels()[0]!;
    const req = (q: string, refs = 0) =>
      ({
        schemaVersion: 1,
        modality: refs ? "image_to_image" : "text_to_image",
        purpose: "character_image",
        provider: "openai-image",
        modelId: model.modelId,
        prompt: { positive: "a portrait of a fictional character", negative: "" },
        durationMs: null,
        resolution: null,
        aspectRatio: "1:1",
        fps: null,
        seed: null,
        references: Array.from({ length: refs }, (_, i) => ({
          assetId: `a${i}`,
          role: "identity",
          order: i,
          label: "x",
        })),
        startFrameAssetId: null,
        endFrameAssetId: null,
        audioAssetIds: [],
        providerOptions: { quality: q },
        idempotencyKey: "k",
      }) as Parameters<OpenAIImageProvider["estimateCost"]>[0];
    const low = provider.estimateCost(req("low"), model).amount!;
    const med = provider.estimateCost(req("medium"), model).amount!;
    const high = provider.estimateCost(req("high"), model).amount!;
    expect(low).toBeGreaterThan(0);
    expect(med).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(med);
    expect(provider.estimateCost(req("medium", 2), model).amount!).toBeGreaterThan(med);
    expect(provider.estimateCost(req("medium"), model)).toEqual(provider.estimateCost(req("medium"), model));
    // high, 1536 px, at the published count × 1.5 at $30/1M is about $0.28: the bound must cover it
    expect(high).toBeGreaterThanOrEqual(0.28);
  });
});

describe("openai-image: through the existing queue and worker (fake transport)", () => {
  it("generates ONE image in one tick: one call, stored PNG Asset with checksum, actual cost from reported usage", async () => {
    const { h, fake } = world();
    const p = await subject(h, "location");
    if (!p.ok) throw new Error(p.reasons.join(" "));
    const { attempt } = await h.repo.generation.createSubjectImageAttempt(p.input);
    await run(h, 1);
    expect(fake.calls).toHaveLength(1);
    const view = (await h.repo.generation.getSubjectImageAttempt(attempt.id))!;
    expect(view.attempt.status).toBe("succeeded");
    const out = view.outputs[0]!;
    expect(out.asset).toMatchObject({ type: "image", mime: "image/png", source: "provider_output" });
    expect(out.asset.checksum).toMatch(/^[0-9a-f]{64}$/);
    const actual = view.costs.find((c) => c.kind === "actual")!;
    // fake usage: 100 text-in, 20 image-in, 1500 image-out tokens
    expect(actual.amount).toBeCloseTo((100 * 5 + 20 * 8 + 1500 * 30) / 1_000_000, 6);
    const estimated = view.costs.find((c) => c.kind === "estimated")!;
    expect(estimated.amount!).toBeGreaterThanOrEqual(actual.amount!);
    // the worker-only key never reaches anything Prism persists or shows
    const persisted = JSON.stringify({
      view,
      job: await h.repo.generation.getJob(view.job!.id),
      data: await h.data(),
    });
    expect(persisted).not.toContain(KEY);
  });

  it("edits an existing image into a NEW Asset; the source is unchanged and recorded as the attempt's first input", async () => {
    const { h, fake } = world();
    const first = await subject(h, "location");
    if (!first.ok) throw new Error(first.reasons.join(" "));
    const a1 = await h.repo.generation.createSubjectImageAttempt(first.input);
    await run(h, 1);
    const source = (await h.repo.generation.getSubjectImageAttempt(a1.attempt.id))!.outputs[0]!.asset;
    const before = structuredClone((await h.data()).assets.find((a) => a.id === source.id));

    const p = await subject(
      h,
      "location",
      { edit: { sourceAssetId: source.id, instruction: "make it night, rain" } },
      "gpt-image-2.5-sunburst",
    );
    if (!p.ok) throw new Error(p.reasons.join(" "));
    expect(reqOf(p).modality).toBe("image_to_image");
    expect(reqOf(p).references[0]).toMatchObject({ assetId: source.id, order: 0 });
    expect(p.input.attempt.modelSettings).toMatchObject({ editSourceAssetId: source.id });
    const a2 = await h.repo.generation.createSubjectImageAttempt(p.input);
    await run(h, 1);
    const call = fake.calls.at(-1)!;
    expect(call.operation).toBe("edit");
    expect(call.images.length).toBe(reqOf(p).references.length);
    expect(call.prompt).toMatch(/make it night, rain/);
    const v2 = (await h.repo.generation.getSubjectImageAttempt(a2.attempt.id))!;
    expect(v2.attempt.status).toBe("succeeded");
    expect(v2.attempt.inputAssetIds).toContain(source.id);
    expect(v2.outputs[0]!.asset.id).not.toBe(source.id);
    expect((await h.data()).assets.find((a) => a.id === source.id)).toEqual(before);
  });

  it("transparent background is an explicit option, sent natively and stored as an RGBA PNG", async () => {
    const { h, fake } = world();
    const p = await subject(h, "location", { options: { background: "transparent" } });
    if (!p.ok) throw new Error(p.reasons.join(" "));
    const { attempt } = await h.repo.generation.createSubjectImageAttempt(p.input);
    await run(h, 1);
    expect(fake.calls[0]).toMatchObject({ background: "transparent", outputFormat: "png" });
    const view = (await h.repo.generation.getSubjectImageAttempt(attempt.id))!;
    expect(view.attempt.status).toBe("succeeded");
    const asset = view.outputs[0]!.asset;
    expect(asset.mime).toBe("image/png");
    const bytes = (await h.sink.get(asset.objectPath!))!;
    expect(bytes[25]).toBe(6); // IHDR colour type 6 = RGBA: the alpha channel survived ingestion
  });

  it("a model without native transparency is refused, never emulated", async () => {
    const h = makeHarness({ PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1" });
    const data = await h.data();
    const p = prepareSubjectImage({
      data,
      input: {
        subject: { kind: "location", locationId: data.locations[0]!.id, intent: "background" },
        direction: "",
      },
      registry: h.registry,
      provider: "mock",
      modelId: "mock-image-1",
      aspectRatio: "1:1",
      userId: null,
      idempotencyKey: "k-transparent",
      config: h.config,
      options: { background: "transparent" },
    });
    expect(p).toEqual({ ok: false, reasons: [expect.stringMatching(/cannot make transparent backgrounds/)] });
  });

  it("an ambiguous failure (timeout) is NEVER re-sent: one call, then the attempt stops with a clear reason", async () => {
    const { h, fake } = world();
    fake.failures.push(new OpenAIImageTransportError(null, "timeout", "timeout", true));
    const p = await subject(h, "location");
    if (!p.ok) throw new Error(p.reasons.join(" "));
    const { attempt } = await h.repo.generation.createSubjectImageAttempt(p.input);
    await run(h, 6);
    expect(fake.calls).toHaveLength(1);
    const view = (await h.repo.generation.getSubjectImageAttempt(attempt.id))!;
    expect(view.attempt.status).toBe("failed");
    expect(view.job?.lastErrorCode).toBe("submission_outcome_unknown");
  });

  it("a moderation refusal is final (content_rejected) and not retried", async () => {
    const { h, fake } = world();
    fake.failures.push(new OpenAIImageTransportError(400, "moderation_blocked", "blocked", false));
    const p = await subject(h, "location");
    if (!p.ok) throw new Error(p.reasons.join(" "));
    const { attempt } = await h.repo.generation.createSubjectImageAttempt(p.input);
    await run(h, 4);
    expect(fake.calls).toHaveLength(1);
    const view = (await h.repo.generation.getSubjectImageAttempt(attempt.id))!;
    expect(view.attempt.status).toBe("failed");
    expect(view.job?.lastErrorCode).toBe("openai_image_moderation_blocked");
  });

  it("a result held by a process that died is reported honestly, never fetched again from OpenAI", async () => {
    const other = new OpenAIImageProvider({
      env: { [OPENAI_IMAGE_SECRET_ENV]: KEY },
      transportFactory: () => new FakeOpenAIImageTransport(),
    });
    const status = await other.poll({
      providerJobId: "oai-img-gone",
      model: "gpt-image-2.5-flare",
      pollCount: 0,
      submittedAt: null,
      idempotencyKey: "k",
    });
    expect(status).toMatchObject({ state: "failed", failure: { code: "openai_image_result_not_retained" } });
    await expect(
      other.fetchResult(
        {
          providerJobId: "oai-img-gone",
          model: "gpt-image-2.5-flare",
          pollCount: 0,
          submittedAt: null,
          idempotencyKey: "k",
        },
        {} as never,
      ),
    ).rejects.toBeInstanceOf(GenerationProviderError);
  });

  it("without the key the adapter refuses before any call", async () => {
    const fake = new FakeOpenAIImageTransport();
    const p = new OpenAIImageProvider({ env: {}, transportFactory: () => fake });
    const { h } = world();
    const s = await subject(h, "location");
    if (!s.ok) throw new Error(s.reasons.join(" "));
    await expect(
      p.submit(reqOf(s), s.input.attempt.promptPlan!, {
        now: () => new Date(),
        assets: { read: async () => null },
      }),
    ).rejects.toMatchObject({ code: "openai_image_not_configured" });
    expect(fake.calls).toHaveLength(0);
  });
});
