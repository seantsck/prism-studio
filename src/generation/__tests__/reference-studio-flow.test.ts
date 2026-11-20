import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GenerationRequest, PromptPlan } from "@/domain/generation/schemas";
import { SUBJECT_IMAGE_POLICY } from "@/domain/generation/subject-image";
import { MockProvider } from "../providers/mock";
import {
  OPENAI_IMAGE_EDIT_NOTE,
  OPENAI_IMAGE_REFERENCE_NOTE,
  OPENAI_IMAGE_SECRET_ENV,
  OpenAIImageProvider,
} from "../providers/openai-image/adapter";
import { FakeOpenAIImageTransport } from "../providers/openai-image/fake-transport";
import { prepareSubjectImage } from "../subject-submission";
import { makeHarness, type Harness } from "./helpers";

/**
 * The Reference Studio's requests through the EXISTING queue and worker, with GPT Image on the FAKE transport: nothing
 * here reaches OpenAI and nothing is billed. What matters is what the transport is handed: which images, in which
 * order, and a prompt that says what they are for.
 */
const KEY = "sk-proj-TESTKEYDONOTUSE1234567890abcdefABCDEF";
const PAID = {
  PRISM_STUDIO_GENERATION_PROVIDERS: "openai-image",
  PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
  PRISM_STUDIO_MAX_GENERATION_USD: "2",
};

function world() {
  const fake = new FakeOpenAIImageTransport();
  const provider = new OpenAIImageProvider({
    env: { ...PAID, [OPENAI_IMAGE_SECRET_ENV]: KEY },
    transportFactory: () => fake,
  });
  const h = makeHarness(
    { ...PAID, [OPENAI_IMAGE_SECRET_ENV]: KEY },
    { extraAdapters: [new MockProvider({ stageDelayMs: 0 }), provider], replaceRegistry: true },
  );
  return { h, fake, provider };
}

async function run(h: Harness, ticks = 2) {
  for (let i = 0; i < ticks; i++) {
    await h.worker().tick(5);
    h.clock.advance(2000);
  }
}

const yumekoOf = async (h: Harness) => (await h.data()).characters.find((c) => c.name === "Yumeko")!;

/** A real stored image of Yumeko to stand for "the photograph the creator added" (bytes exist in the sink). */
async function photo(h: Harness): Promise<string> {
  const yumeko = await yumekoOf(h);
  const p = prepareSubjectImage({
    data: await h.data(),
    input: { subject: { kind: "character", characterId: yumeko.id, intent: "portrait" }, direction: "" },
    registry: h.registry,
    provider: "mock",
    modelId: "mock-image-1",
    aspectRatio: "1:1",
    userId: null,
    idempotencyKey: `photo-${randomUUID()}`,
    config: h.config,
    now: h.clock.now,
  });
  if (!p.ok) throw new Error(p.reasons.join(" "));
  const { attempt } = await h.repo.generation.createSubjectImageAttempt(p.input);
  await run(h, 4);
  const view = (await h.repo.generation.getSubjectImageAttempt(attempt.id))!;
  const asset = view.outputs[0]!.asset;
  // it is the creator's upload in this story, in the Character's front slot
  const data = await h.data();
  await h.repo.upsert(data.project.id, "assets", { ...asset, source: "upload", name: "yumeko-front.jpg" });
  const front = data.identityRefs.find((r) => r.characterId === yumeko.id && r.slot === "front")!;
  await h.repo.upsert(data.project.id, "identityRefs", { ...front, assetId: asset.id, locked: false });
  return asset.id;
}

async function prepare(h: Harness, extra: Partial<Parameters<typeof prepareSubjectImage>[0]>) {
  const yumeko = await yumekoOf(h);
  return prepareSubjectImage({
    data: await h.data(),
    input: { subject: { kind: "character", characterId: yumeko.id, intent: "three_quarter" }, direction: "" },
    registry: h.registry,
    provider: "openai-image",
    modelId: "gpt-image-2.5-flare",
    aspectRatio: "2:3",
    userId: null,
    idempotencyKey: `studio-${randomUUID()}`,
    config: h.config,
    now: h.clock.now,
    ...extra,
  });
}

describe("Reference Studio: a new angle FROM the creator's photograph", () => {
  it("sends that photograph, and tells the model to reproduce the person in a NEW picture (never to edit the photo)", async () => {
    const { h, fake } = world();
    const source = await photo(h);
    const yumeko = await yumekoOf(h);
    const p = await prepare(h, {
      input: {
        subject: { kind: "character", characterId: yumeko.id, intent: "three_quarter" },
        direction: "",
        sourceAssetIds: [source],
      },
      composer: { direction: "", presetValue: "" },
    });
    if (!p.ok) throw new Error(p.reasons.join(" "));
    expect(p.operation).toBe("reference");
    expect(p.referencesSent).toBe(1);
    expect(p.input.attempt.modelSettings).toMatchObject({
      intent: "three_quarter",
      operation: "reference",
      promptPolicy: SUBJECT_IMAGE_POLICY,
      sourceAssetIds: [source],
      providerOptions: { prismImageOperation: "reference" },
    });
    expect(p.input.attempt.inputAssetIds).toEqual([source]);

    const { attempt } = await h.repo.generation.createSubjectImageAttempt(p.input);
    await run(h);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    // OpenAI's edit endpoint is the one that takes input images; the WORDS say this is a new picture
    expect(call.operation).toBe("edit");
    expect(call.images).toHaveLength(1);
    expect(call.prompt.startsWith(`${OPENAI_IMAGE_REFERENCE_NOTE}\n`)).toBe(true);
    expect(call.prompt).not.toContain(OPENAI_IMAGE_EDIT_NOTE);
    expect(call.prompt).toMatch(/The same person as in the identity reference image/);
    expect(call.prompt).toMatch(/Three-quarter view/);
    expect(call.prompt).toMatch(/Reference image 1 is Yumeko reference photo \(front\)\.$/);
    expect(call.prompt).not.toMatch(/Guardrails|vehicle door|Canon:/);

    const view = (await h.repo.generation.getSubjectImageAttempt(attempt.id))!;
    expect(view.attempt.status).toBe("succeeded");
    // a new Asset with its own provenance; the photograph is untouched and still the front reference
    expect(view.outputs[0]!.asset.id).not.toBe(source);
    expect(view.outputs[0]!.asset.source).toBe("provider_output");
    const after = await h.data();
    expect(after.assets.find((a) => a.id === source)).toMatchObject({ source: "upload" });
    expect(after.identityRefs.find((r) => r.characterId === yumeko.id && r.slot === "front")!.assetId).toBe(
      source,
    );
  });

  it("the request summary a creator sees before spending names each image as a reference, not as the edit source", async () => {
    const { h, provider } = world();
    const source = await photo(h);
    const yumeko = await yumekoOf(h);
    const p = await prepare(h, {
      input: {
        subject: { kind: "character", characterId: yumeko.id, intent: "profile_left" },
        direction: "",
        sourceAssetIds: [source],
      },
    });
    if (!p.ok) throw new Error(p.reasons.join(" "));
    const compiled = provider.compileRequest(
      p.input.attempt.request as unknown as GenerationRequest,
      p.input.attempt.promptPlan as PromptPlan,
    );
    expect(compiled.endpoint).toBe("POST /v1/images/edits (gpt-image-2.5-flare)");
    expect(compiled.attachments).toEqual([{ role: "reference:identity:#1", assetId: source }]);
    expect(compiled.notes).toContain(
      "The reference images are reproduced in a new picture; none of them is changed or overwritten.",
    );
    expect(String(compiled.fields.prompt)).toMatch(/faces the LEFT edge of the picture/);
  });

  it("a model that cannot take an image is refused: the creator's starting image is never dropped silently", async () => {
    // a free test model that only makes pictures from words
    class WordsOnlyMock extends MockProvider {
      override listModels() {
        return super
          .listModels()
          .map((m) =>
            m.modelId === "mock-image-lite"
              ? { ...m, capabilities: { ...m.capabilities, modalities: ["text_to_image" as const] } }
              : m,
          );
      }
    }
    const h = makeHarness(
      { PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1" },
      { extraAdapters: [new WordsOnlyMock({ stageDelayMs: 0 })], replaceRegistry: true },
    );
    const source = await photo(h);
    const yumeko = await yumekoOf(h);
    const subject = { kind: "character" as const, characterId: yumeko.id, intent: "portrait" as const };
    const base = { provider: "mock", modelId: "mock-image-lite", aspectRatio: "1:1" };
    expect(
      await prepare(h, { ...base, input: { subject, direction: "", sourceAssetIds: [source] } }),
    ).toEqual({
      ok: false,
      reasons: ["Mock Image Lite cannot use a starting image. Choose a model that can, or remove the image."],
    });
    expect(
      await prepare(h, {
        ...base,
        input: { subject, direction: "" },
        edit: { sourceAssetId: source, instruction: "x" },
      }),
    ).toEqual({ ok: false, reasons: ["Mock Image Lite cannot edit images."] });
    // the same model is fine from words alone, and then nothing is sent
    const words = await prepare(h, { ...base, input: { subject, direction: "", sourceAssetIds: [] } });
    expect(words).toMatchObject({ ok: true, operation: "text", referencesSent: 0 });
  });
});

describe("Reference Studio: changing one image", () => {
  it("sends ONLY that image and the change; the words keep the original edit wording", async () => {
    const { h, fake } = world();
    const source = await photo(h);
    const yumeko = await yumekoOf(h);
    const p = await prepare(h, {
      input: { subject: { kind: "character", characterId: yumeko.id, intent: "portrait" }, direction: "" },
      edit: {
        sourceAssetId: source,
        instruction: "Change the hair colour to auburn. Keep the same hairstyle, length and hairline.",
      },
      composer: { editPreset: "hair_color", editValue: "auburn" },
    });
    if (!p.ok) throw new Error(p.reasons.join(" "));
    expect(p.operation).toBe("edit");
    expect(p.input.attempt.modelSettings).toMatchObject({
      editSourceAssetId: source,
      operation: "edit",
      composer: { editPreset: "hair_color", editValue: "auburn" },
      providerOptions: { prismImageOperation: "edit" },
    });
    await h.repo.generation.createSubjectImageAttempt(p.input);
    await run(h);
    const call = fake.calls.at(-1)!;
    expect(call.images).toHaveLength(1);
    expect(call.prompt.startsWith(`${OPENAI_IMAGE_EDIT_NOTE}\n`)).toBe(true);
    expect(call.prompt).toMatch(
      /Change only this in the image being edited: Change the hair colour to auburn/,
    );
    expect(call.prompt).toMatch(/Keep everything else exactly as it is/);
    // nothing that would re-compose the picture or contradict the change
    expect(call.prompt).not.toMatch(/Front portrait|studio background|black hair/);
  });
});

describe("requests frozen before the Studio existed are sent exactly as before", () => {
  it("an image-to-image request with no stated operation keeps the original first line", () => {
    const { provider } = world();
    const request = {
      schemaVersion: 1,
      modality: "image_to_image",
      purpose: "production_frame",
      provider: "openai-image",
      modelId: "gpt-image-2.5-flare",
      prompt: { positive: "x", negative: "" },
      durationMs: null,
      resolution: null,
      aspectRatio: "16:9",
      fps: null,
      seed: null,
      references: [{ assetId: "a1", role: "identity", order: 0, label: "Yumeko canonical identity" }],
      startFrameAssetId: null,
      endFrameAssetId: null,
      audioAssetIds: [],
      providerOptions: { quality: "medium" },
      idempotencyKey: "k",
    } as unknown as GenerationRequest;
    const plan: PromptPlan = {
      version: 1,
      sections: [{ key: "subject", title: "Subject", lines: ["Yumeko in the lobby"] }],
    };
    const compiled = provider.compileRequest(request, plan);
    expect(String(compiled.fields.prompt).startsWith(`${OPENAI_IMAGE_EDIT_NOTE}\n`)).toBe(true);
    expect(compiled.attachments[0]!.role).toBe("edit_source:identity:#1");
  });
});
