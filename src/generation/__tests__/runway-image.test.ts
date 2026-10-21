import { readFileSync } from "node:fs";
import path from "node:path";
import type RunwayML from "@runwayml/sdk";
import { describe, expect, it } from "vitest";
import {
  catalogModel,
  estimateImageCredits,
  isImageCatalogModel,
  RUNWAY_IMAGE_MODELS,
  RUNWAY_MODELS,
  RUNWAY_VIDEO_MODELS,
  toGenerationModel,
} from "@/domain/generation/models/catalog";
import { IMAGE_SDK_BLOCKED_MODELS } from "@/domain/generation/models/image-catalog";
import { generationModelSchema, type GenerationRequest, type PromptPlan } from "@/domain/generation/schemas";
import { RunwayProvider, type RunwayClientLike, type RunwayTask } from "../providers/runway/adapter";
import { compileRunwayImagePrompt } from "../providers/runway/compile";
import {
  GPT_IMAGE_RATIOS,
  GPT_IMAGE_QUALITIES,
  IMAGE_OUTPUT_COUNT,
  MUSE_IMAGE_RATIOS,
  runwayImageTags,
} from "../providers/runway/image-families";
import { encodeMockPng } from "../providers/mock-image";
import type { ProviderContext } from "../provider";

/**
 * Phase 2G.2: the Runway still-image models (GPT Image 2.5 Flare, Muse Image, Seedream 5 Lite) at the SDK boundary.
 * A fake client captures the EXACT request object `client.textToImage.create` would receive. No network, no credits,
 * no real Runway call.
 */

type Body = RunwayML.TextToImageCreateParams;

// ───────────────────────── a fake Runway image client ─────────────────────────

class FakeImageRunway {
  images: Body[] = [];
  nextId = 1;
  tasks = new Map<string, RunwayTask>();
  client(): RunwayClientLike {
    const noVideo = async (): Promise<{ id: string }> => {
      throw new Error("the image suite never calls a video endpoint");
    };
    return {
      textToVideo: { create: noVideo },
      imageToVideo: { create: noVideo },
      textToImage: {
        create: async (body) => {
          this.images.push(body);
          const id = `img_${this.nextId++}`;
          this.tasks.set(id, { id, status: "PENDING" });
          return { id, estimatedCost: { credits: 5 } };
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

const SECRET = "key_test_0123456789abcdef0123456789";
const ENV = { NODE_ENV: "test", RUNWAYML_API_SECRET: SECRET };
const make = () => {
  const fake = new FakeImageRunway();
  return { fake, provider: new RunwayProvider({ env: ENV, clientFactory: () => fake.client() }) };
};

const png = encodeMockPng(640, 360, 7);
const ctx = (over: Partial<ProviderContext> = {}): ProviderContext => ({
  now: () => new Date("2026-10-21T00:00:00Z"),
  assets: { read: async () => ({ bytes: png, mime: "image/png", filename: "r.png" }) },
  ...over,
});

const plan = (): PromptPlan => ({
  version: 1,
  sections: [
    { key: "subject", title: "Subject", lines: ["1A — Doorway", "Yumeko hesitates at the door"] },
    { key: "composition", title: "Composition", lines: ["medium shot", "aspect ratio 2.39:1"] },
    {
      key: "action",
      title: "Action",
      lines: [
        "begins: hand on the handle",
        "0.5s: she exhales",
        "ends: door opens",
        "Yumeko expression: afraid",
      ],
    },
    { key: "timing", title: "Timing", lines: ["duration 4s (manual)"] },
    { key: "performance", title: "Performance", lines: ['Yumeko: "I will not go."', "emotion: fear (7/10)"] },
    { key: "negative_constraints", title: "Negative constraints", lines: ["no text overlays"] },
  ],
});

const ref = (
  assetId: string,
  role: GenerationRequest["references"][number]["role"],
  label: string,
  order = 0,
) => ({
  assetId,
  role,
  label,
  order,
});

const request = (modelId: string, over: Partial<GenerationRequest> = {}): GenerationRequest => ({
  schemaVersion: 1,
  modality: "text_to_image",
  purpose: "production_frame",
  provider: "runway",
  modelId,
  prompt: { positive: "x", negative: "" },
  durationMs: null,
  resolution: null,
  aspectRatio: "16:9",
  fps: null,
  seed: null,
  references: [],
  startFrameAssetId: null,
  endFrameAssetId: null,
  audioAssetIds: [],
  providerOptions: {},
  idempotencyKey: "runway-image-test-key",
  ...over,
});

const model = (id: string) => toGenerationModel(catalogModel("runway", id)!);

// ───────────────────────── catalog ─────────────────────────

describe("Runway image catalog (SDK 4.22.0)", () => {
  it("is pinned to the installed SDK and registers three verified image models", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "node_modules/@runwayml/sdk/package.json"), "utf8"),
    ) as { version: string };
    expect(pkg.version).toBe("4.22.0");
    const lock = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(lock.dependencies["@runwayml/sdk"]).toBe("4.22.0");
    expect(RUNWAY_IMAGE_MODELS.map((m) => m.modelId)).toEqual([
      "gpt_image_2_5_flare",
      "muse_image",
      "seedream5_lite",
    ]);
    for (const m of RUNWAY_IMAGE_MODELS) {
      expect(m.verification).toMatchObject({
        sdkVersion: "@runwayml/sdk@4.22.0",
        verifiedAt: "2026-10-21",
        providerApiVersion: "2024-11-06",
      });
      expect(m.verification.sources.length).toBeGreaterThanOrEqual(3);
      expect(m.pricing.version).toBe("runway-image-2026-10-21");
      expect(m.pricing.usdPerCredit).toBe(0.01);
      expect(m.modalities).toEqual(["text_to_image", "image_to_image"]);
      expect(isImageCatalogModel(m)).toBe(true);
      expect(generationModelSchema.safeParse(toGenerationModel(m)).success).toBe(true);
    }
    // the video set is unchanged by the SDK bump (and keeps its pins)
    expect(RUNWAY_VIDEO_MODELS.map((m) => m.modelId)).toEqual([
      "gen4.5",
      "gen4_turbo",
      "seedance2_5",
      "hailuo3",
      "veo3.1_fast",
      "veo3.1",
    ]);
    expect(RUNWAY_MODELS).toHaveLength(9);
  });

  it("offers a reference-rich quality model, an inexpensive model and an alternative model family", () => {
    expect(RUNWAY_IMAGE_MODELS.map((m) => m.role)).toEqual([
      "reference_rich",
      "fast_low_cost",
      "alternative_family",
    ]);
    expect(new Set(RUNWAY_IMAGE_MODELS.map((m) => m.family)).size).toBe(3);
    // nothing is called "best"
    for (const m of RUNWAY_IMAGE_MODELS) expect(JSON.stringify(m)).not.toMatch(/\bbest\b/i);
  });

  it("every offered canvas is a ratio the SDK types for that model", () => {
    const sets = {
      gpt_image_2_5_flare: new Set<string>(GPT_IMAGE_RATIOS),
      muse_image: new Set<string>(MUSE_IMAGE_RATIOS),
      // seedream5_lite's `ratio` type also accepts freeform sizes; the typed canvases Prism uses are these
      seedream5_lite: new Set([
        "2048:2048",
        "2304:1728",
        "1728:2304",
        "2848:1600",
        "1600:2848",
        "2496:1664",
        "1664:2496",
        "3136:1344",
        "3072:3072",
        "3456:2592",
        "2592:3456",
        "4096:2304",
        "2304:4096",
        "3744:2496",
        "2496:3744",
        "4704:2016",
      ]),
    };
    for (const m of RUNWAY_IMAGE_MODELS) {
      const allowed = sets[m.modelId as keyof typeof sets];
      for (const t of m.tiers)
        for (const [label, px] of Object.entries(t.ratios)) {
          expect(allowed.has(px), `${m.modelId} ${label} → ${px}`).toBe(true);
          // the label is the true aspect of the canvas (within 1%): Prism never mislabels a canvas
          const [w, h] = px.split(":").map(Number) as [number, number];
          const [lw, lh] = label.split(":").map(Number) as [number, number];
          expect(Math.abs(w / h / (lw / lh) - 1), `${m.modelId} ${label}`).toBeLessThan(0.01);
        }
      expect(m.aspectRatios).toEqual(Object.keys(m.tiers[0]!.ratios));
    }
  });

  it("states reference limits, prompt limits and addressing from the documentation", () => {
    const by = Object.fromEntries(RUNWAY_IMAGE_MODELS.map((m) => [m.modelId, m]));
    expect(by.gpt_image_2_5_flare!.inputs.maxReferenceImages).toBe(16);
    expect(by.muse_image!.inputs.maxReferenceImages).toBe(10);
    expect(by.seedream5_lite!.inputs.maxReferenceImages).toBe(14);
    expect(by.gpt_image_2_5_flare!.promptMaxChars).toBe(32_000);
    expect(by.muse_image!.promptMaxChars).toBe(4000);
    expect(by.seedream5_lite!.promptMaxChars).toBe(4000);
    expect(by.gpt_image_2_5_flare!.image!.referenceAddressing).toBe("tags");
    expect(by.muse_image!.image!.referenceAddressing).toBe("order");
    expect(by.seedream5_lite!.image!.referenceAddressing).toBe("order");
    // capability honesty: what the sources do not state is recorded, not guessed
    expect(by.gpt_image_2_5_flare!.verification.unstated.join(" ")).toMatch(/1K\/2K/);
    const caps = model("gpt_image_2_5_flare").capabilities;
    expect(caps.video).toBeNull();
    expect(caps.image).toMatchObject({ editing: true, transparency: false });
    expect(caps.references).toMatchObject({
      referenceImages: true,
      maxReferences: 16,
      orderedReferences: true,
    });
  });

  it("nano_banana_2.1 is priced by Runway but NOT typed by the SDK: recorded as SDK-blocked, not offered", () => {
    expect(IMAGE_SDK_BLOCKED_MODELS.map((m) => m.modelId)).toContain("nano_banana_2.1");
    expect(catalogModel("runway", "nano_banana_2.1")).toBeNull();
    // a type-level tripwire: when an SDK upgrade starts typing it, this line stops compiling
    type Typed = Extract<Body, { model: "nano_banana_2.1" }>;
    const notTyped: [Typed] extends [never] ? true : false = true;
    expect(notTyped).toBe(true);
  });
});

// ───────────────────────── pricing ─────────────────────────

describe("Runway image pricing (versioned, $0.01 per credit)", () => {
  const price = (id: string, o: { quality?: string | null; refs?: number }) =>
    estimateImageCredits(catalogModel("runway", id)!, {
      tierId: catalogModel("runway", id)!.tiers[0]!.id,
      quality: o.quality ?? null,
      referenceImages: o.refs ?? 0,
      outputCount: 1,
    });

  it("prices one image by model, quality and references", () => {
    expect(price("muse_image", {}).credits).toBe(1);
    expect(price("seedream5_lite", {}).credits).toBe(4);
    expect(price("gpt_image_2_5_flare", { quality: "low" }).credits).toBe(1);
    expect(price("gpt_image_2_5_flare", { quality: "medium" }).credits).toBe(5);
    expect(price("gpt_image_2_5_flare", { quality: "high" }).credits).toBe(16);
    expect(price("gpt_image_2_5_flare", { quality: "xhigh" }).credits).toBe(28);
    expect(price("gpt_image_2_5_flare", { quality: "max" }).credits).toBe(63);
    // 1 credit per reference per generated image (documented for this model), none for the others
    expect(price("gpt_image_2_5_flare", { quality: "medium", refs: 3 }).credits).toBe(8);
    expect(price("muse_image", { refs: 5 }).credits).toBe(1);
    expect(price("seedream5_lite", { refs: 5 }).credits).toBe(4);
    expect(price("gpt_image_2_5_flare", { quality: "medium", refs: 3 }).amountUsd).toBe(0.08);
  });

  it("the default quality is EXPLICIT and cheaper than the provider's hidden default", () => {
    const m = catalogModel("runway", "gpt_image_2_5_flare")!;
    expect(m.image!.defaultQuality).toBe("medium");
    expect(price("gpt_image_2_5_flare", {}).credits).toBe(5); // not the provider default (high = 16)
    expect(m.image!.qualities.find((q) => q.id === "high")!.note).toMatch(/provider default/);
  });

  it("the adapter estimates through the same catalog, for the exact request", () => {
    const { provider } = make();
    const flare = model("gpt_image_2_5_flare");
    expect(provider.estimateCost(request("gpt_image_2_5_flare"), flare)).toMatchObject({
      amount: 0.05,
      currency: "USD",
      units: 5,
    });
    const refs = [ref("a1", "production_frame", "Current Production Frame"), ref("a2", "storyboard", "SB")];
    expect(
      provider.estimateCost(
        request("gpt_image_2_5_flare", {
          modality: "image_to_image",
          references: refs,
          providerOptions: { quality: "high" },
        }),
        flare,
      ).units,
    ).toBe(18);
    expect(
      provider.estimateCost(request("muse_image", { aspectRatio: "21:9" }), model("muse_image")).amount,
    ).toBe(0.01);
    expect(provider.estimateCost(request("seedream5_lite"), model("seedream5_lite")).basis).toContain(
      "runway-image-2026-10-21",
    );
  });
});

// ───────────────────────── the exact SDK request ─────────────────────────

describe("Runway textToImage requests (the exact SDK body)", () => {
  it("text_to_image: no references → no referenceImages, outputCount 1, explicit quality, typed canvas", async () => {
    const { fake, provider } = make();
    const sub = await provider.submit(request("gpt_image_2_5_flare"), plan(), ctx());
    expect(sub).toMatchObject({ providerJobId: "img_1", state: "queued", providerStatus: "PENDING" });
    expect(fake.images).toHaveLength(1);
    const body = fake.images[0]!;
    expect(body).toMatchObject({
      model: "gpt_image_2_5_flare",
      ratio: "1920:1088",
      quality: "medium",
      outputCount: 1,
    });
    expect("referenceImages" in body).toBe(false);
    expect(String(body.promptText)).toContain("Subject:");
    expect(IMAGE_OUTPUT_COUNT).toBe(1);
  });

  it("outputCount is ALWAYS 1: a request for more is never forwarded (one attempt = one image)", async () => {
    for (const id of ["gpt_image_2_5_flare", "muse_image", "seedream5_lite"]) {
      const { fake, provider } = make();
      await provider.submit(
        request(id, { aspectRatio: "21:9", providerOptions: { outputCount: 4, n: 4, quality: undefined } }),
        plan(),
        ctx(),
      );
      expect((fake.images[0] as { outputCount?: number }).outputCount, id).toBe(1);
    }
  });

  it("image_to_image: references go out in priority order, each tagged, as data URIs", async () => {
    const { fake, provider } = make();
    const refs = [
      ref("asset-pf", "production_frame", "Current Production Frame", 0),
      ref("asset-sb", "storyboard", "Approved storyboard frame", 1),
      ref("asset-yi", "identity", "Yumeko identity", 2),
      ref("asset-yl", "character_look", 'Yumeko Look "Rain Coat"', 3),
      ref("asset-si", "identity", "Sean identity", 4),
      ref("asset-loc", "location", "Garden gate reference", 5),
    ];
    await provider.submit(
      request("gpt_image_2_5_flare", { modality: "image_to_image", references: refs }),
      plan(),
      ctx(),
    );
    const body = fake.images[0] as Extract<Body, { model: "gpt_image_2_5_flare" }>;
    const sent = body.referenceImages!;
    expect(sent).toHaveLength(6);
    expect(sent.map((r) => r.tag)).toEqual([
      "ProductionFrame",
      "Storyboard",
      "YumekoIdentity",
      "YumekoLook",
      "SeanIdentity",
      "Location",
    ]);
    for (const r of sent) {
      expect(r.uri.startsWith("data:image/png;base64,")).toBe(true);
      expect(r.tag).toMatch(/^[A-Za-z][A-Za-z0-9_]{2,15}$/);
    }
    // the model is never asked to infer which image is which: a legend names every tag
    expect(body.promptText).toContain("@ProductionFrame is Current Production Frame.");
    expect(body.promptText).toContain("@YumekoLook is Yumeko Look");
  });

  it("tags are deterministic, provider-safe, unique and keep provider syntax inside the adapter", () => {
    const refs = [
      { role: "identity" as const, label: "Yumeko identity" },
      { role: "identity" as const, label: "Yumeko identity" },
      { role: "character_look" as const, label: 'Bartholomew-Alexander Look "x"' },
      { role: "identity" as const, label: "Bartholomew-Alexander identity" },
      { role: "identity" as const, label: "李 identity" },
      { role: "other" as const, label: "Shot reference" },
      { role: "other" as const, label: "Shot reference" },
    ];
    const tags = runwayImageTags(refs);
    expect(new Set(tags).size).toBe(tags.length);
    for (const t of tags) expect(t).toMatch(/^[A-Za-z][A-Za-z0-9_]{2,15}$/);
    expect(runwayImageTags(refs)).toEqual(tags); // deterministic
    expect(tags[0]).toBe("YumekoIdentity");
    expect(tags[1]).toBe("YumekoIdentity2");
    expect(tags[5]).toBe("ShotRef");
    expect(tags[6]).toBe("ShotRef2");
  });

  it("Seedream 5 Lite and Muse take no tags: references are ordered and the legend says which is which", async () => {
    for (const [id, word] of [
      ["seedream5_lite", "Figure"],
      ["muse_image", "Reference image"],
    ] as const) {
      const { fake, provider } = make();
      await provider.submit(
        request(id, {
          modality: "image_to_image",
          aspectRatio: id === "muse_image" ? "21:9" : "16:9",
          references: [
            ref("a1", "production_frame", "Current Production Frame", 0),
            ref("a2", "identity", "Yumeko identity", 1),
          ],
        }),
        plan(),
        ctx(),
      );
      const body = fake.images[0] as Extract<Body, { model: "muse_image" | "seedream5_lite" }>;
      expect(body.referenceImages!.map((r) => Object.keys(r))).toEqual([["uri"], ["uri"]]);
      expect(body.promptText).toContain(`${word} 1 is Current Production Frame.`);
      expect(body.promptText).toContain(`${word} 2 is Yumeko identity.`);
      expect(body.outputFormat).toBe("png");
    }
  });

  it("model-specific options: quality is typed, explicit and validated; models without one refuse it", async () => {
    const { fake, provider } = make();
    await provider.submit(
      request("gpt_image_2_5_flare", { providerOptions: { quality: "high" } }),
      plan(),
      ctx(),
    );
    expect((fake.images[0] as { quality: string }).quality).toBe("high");
    for (const q of GPT_IMAGE_QUALITIES) {
      expect(
        provider.validateRequest(
          request("gpt_image_2_5_flare", { providerOptions: { quality: q } }),
          model("gpt_image_2_5_flare"),
        ).ok,
      ).toBe(true);
    }
    const bad = provider.validateRequest(
      request("gpt_image_2_5_flare", { providerOptions: { quality: "ultra" } }),
      model("gpt_image_2_5_flare"),
    );
    expect(bad.errors.join(" ")).toMatch(/no ultra quality/);
    const none = provider.validateRequest(
      request("seedream5_lite", { providerOptions: { quality: "high" } }),
      model("seedream5_lite"),
    );
    expect(none.errors.join(" ")).toMatch(/no quality option/);
  });

  it("reference limits are enforced, never silently truncated", () => {
    const { provider } = make();
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ref(`a${i}`, "other", `Shot reference ${i}`, i));
    const check = (id: string, n: number) =>
      provider.validateRequest(
        request(id, { modality: "image_to_image", aspectRatio: "21:9", references: many(n) }),
        model(id),
      );
    expect(check("gpt_image_2_5_flare", 16).ok).toBe(true);
    expect(check("gpt_image_2_5_flare", 17).errors.join(" ")).toMatch(/at most 16/);
    expect(check("muse_image", 10).ok).toBe(true);
    expect(check("muse_image", 11).errors.join(" ")).toMatch(/at most 10/);
    expect(check("seedream5_lite", 14).ok).toBe(true);
    expect(check("seedream5_lite", 15).errors.join(" ")).toMatch(/at most 14/);
  });

  it("modality, ratio, frames and audio are validated before any call", async () => {
    const { fake, provider } = make();
    const flare = model("gpt_image_2_5_flare");
    expect(
      provider
        .validateRequest(request("gpt_image_2_5_flare", { modality: "image_to_image" }), flare)
        .errors.join(" "),
    ).toMatch(/at least one reference/);
    expect(
      provider
        .validateRequest(request("gpt_image_2_5_flare", { references: [ref("a", "other", "x")] }), flare)
        .errors.join(" "),
    ).toMatch(/need image-to-image/);
    expect(
      provider.validateRequest(request("gpt_image_2_5_flare", { modality: "text_to_video" }), flare).ok,
    ).toBe(false);
    expect(
      provider
        .validateRequest(request("muse_image", { aspectRatio: "16:9" }), model("muse_image"))
        .errors.join(" "),
    ).toMatch(/Aspect ratio 16:9 is not available for Muse Image/);
    expect(
      provider.validateRequest(request("gpt_image_2_5_flare", { startFrameAssetId: "x" }), flare).ok,
    ).toBe(false);
    expect(provider.validateRequest(request("gpt_image_2_5_flare", { audioAssetIds: ["x"] }), flare).ok).toBe(
      false,
    );
    // an invalid request never reaches the SDK
    await expect(
      provider.submit(request("muse_image", { aspectRatio: "16:9" }), plan(), ctx()),
    ).rejects.toMatchObject({ code: "runway_invalid_request" });
    expect(fake.images).toHaveLength(0);
  });

  it("a stored reference that cannot be read is refused before Runway is called", async () => {
    const { fake, provider } = make();
    await expect(
      provider.submit(
        request("gpt_image_2_5_flare", {
          modality: "image_to_image",
          references: [ref("gone", "other", "x")],
        }),
        plan(),
        ctx({ assets: { read: async () => null } }),
      ),
    ).rejects.toMatchObject({ code: "runway_input_unavailable" });
    expect(fake.images).toHaveLength(0);
  });
});

// ───────────────────────── prompt ─────────────────────────

describe("image prompt: the same PromptPlan, rendered for a still", () => {
  it("keeps the opening pose and expressions, drops motion-over-time, dialogue, timing and negatives", () => {
    const c = compileRunwayImagePrompt(plan(), 4000, { modelName: "Muse Image" });
    expect(c.text).toContain("pose at the frame: hand on the handle");
    expect(c.text).toContain("Yumeko expression: afraid");
    expect(c.text).not.toMatch(/0\.5s|she exhales|door opens/);
    expect(c.text).not.toContain("I will not go");
    expect(c.text).not.toContain("duration 4s");
    expect(c.text).not.toContain("no text overlays");
    expect(c.text).toContain("emotion: fear");
    expect(c.notes.join(" ")).toMatch(/dialogue and performed audio are not sent/i);
    expect(c.notes.join(" ")).toMatch(/negative constraints are not sent/i);
    // never claims audio conditioning
    expect(c.text.toLowerCase()).not.toContain("audio");
  });

  it("reserves room for the reference legend and reports (never drops silently) what did not fit", () => {
    const long = plan();
    long.sections.push({
      key: "lighting",
      title: "Lighting",
      lines: Array.from({ length: 60 }, (_, i) => `Lighting detail number ${i} with some extra wording`),
    });
    const legend = "References: @ProductionFrame is Current Production Frame.";
    const c = compileRunwayImagePrompt(long, 600, { modelName: "Muse Image", legend });
    expect(c.text.length).toBeLessThanOrEqual(600);
    expect(c.text.endsWith(legend)).toBe(true);
    expect(c.omissions.find((o) => o.section === "lighting")?.omittedLines).toBeGreaterThan(0);
  });

  it("the compiled summary carries no secrets, no image data and no URLs", () => {
    const { provider } = make();
    const s = provider.compileRequest(
      request("gpt_image_2_5_flare", {
        modality: "image_to_image",
        references: [
          ref("11111111-1111-1111-1111-111111111111", "production_frame", "Current Production Frame"),
        ],
      }),
      plan(),
    );
    const text = JSON.stringify(s);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("data:image");
    expect(text).not.toMatch(/https?:\/\//);
    expect(s.endpoint).toBe("POST /v1/text_to_image (gpt_image_2_5_flare)");
    expect(s.fields).toMatchObject({
      purpose: "production_frame",
      requestModality: "image_to_image",
      ratio: "1920:1088",
      quality: "medium",
      outputCount: 1,
      referenceCount: 1,
      referenceTags: ["ProductionFrame"],
      estimatedCredits: 6,
    });
    expect(s.attachments).toEqual([
      {
        role: "reference:production_frame:@ProductionFrame",
        assetId: "11111111-1111-1111-1111-111111111111",
      },
    ]);
  });
});

// ───────────────────────── poll / result / errors ─────────────────────────

describe("Runway image tasks: poll, result and failures", () => {
  const refFor = (n = 0) => ({
    providerJobId: "img_1",
    model: "x",
    pollCount: n,
    submittedAt: null,
    idempotencyKey: "k",
  });

  it("a succeeded task yields ONE still image with safe provenance and the provider-reported cost", async () => {
    const { fake, provider } = make();
    const req = request("gpt_image_2_5_flare", {
      modality: "image_to_image",
      references: [ref("asset-pf", "production_frame", "Current Production Frame")],
      providerOptions: { quality: "medium" },
    });
    await provider.submit(req, plan(), ctx());
    fake.tasks.set("img_1", {
      id: "img_1",
      status: "SUCCEEDED",
      output: ["https://dnznrvs05pmza.cloudfront.net/out.png?_jwt=secret-signature"],
      cost: { credits: 6 },
      estimatedCost: { credits: 6 },
      createdAt: "2026-10-21T00:00:00Z",
    });
    expect(await provider.poll(refFor(3), ctx())).toMatchObject({ state: "succeeded", retryAfterMs: null });
    const result = await provider.fetchResult(refFor(3), req, ctx());
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({ role: "primary", position: 0, kind: "image" });
    expect(result.outputs[0]!.reported).toMatchObject({ width: 1920, height: 1088 });
    expect(result.cost).toMatchObject({ amount: 0.06, units: 6, currency: "USD" });
    expect(result.provenance.settings).toMatchObject({
      purpose: "production_frame",
      modality: "image_to_image",
      ratio: "1920:1088",
      providerCanvas: { width: 1920, height: 1088 },
      quality: "medium",
      outputCount: 1,
      outputPosition: 0,
      references: [{ assetId: "asset-pf", role: "production_frame", tag: "ProductionFrame" }],
    });
    expect(result.provenance.metadata).toMatchObject({
      credits: 6,
      estimatedCredits: 6,
      pricingVersion: "runway-image-2026-10-21",
    });
    // the provider URL is transport only: it is not in the provenance, and no key/auth ever appears
    const prov = JSON.stringify(result.provenance);
    expect(prov).not.toMatch(/https?:\/\/|_jwt|secret-signature/);
    expect(prov).not.toContain(SECRET);
    expect(prov).not.toMatch(/authorization|bearer/i);
  });

  it("a succeeded task with no output is an error; an unfinished task is not ready", async () => {
    const { fake, provider } = make();
    const req = request("muse_image", { aspectRatio: "21:9" });
    await provider.submit(req, plan(), ctx());
    fake.tasks.set("img_1", { id: "img_1", status: "RUNNING", progress: 0.4 });
    await expect(provider.fetchResult(refFor(), req, ctx())).rejects.toMatchObject({
      code: "runway_not_ready",
    });
    fake.tasks.set("img_1", { id: "img_1", status: "SUCCEEDED", output: [] });
    await expect(provider.fetchResult(refFor(), req, ctx())).rejects.toMatchObject({
      code: "runway_no_output",
    });
  });

  it("task states and failures use the shared taxonomy (no provider payload leaks)", async () => {
    const { fake, provider } = make();
    await provider.submit(request("seedream5_lite"), plan(), ctx());
    fake.tasks.set("img_1", { id: "img_1", status: "THROTTLED" });
    expect(await provider.poll(refFor(), ctx())).toMatchObject({
      state: "queued",
      providerStatus: "THROTTLED",
    });
    fake.tasks.set("img_1", {
      id: "img_1",
      status: "FAILED",
      failure: "a private moderation detail",
      failureCode: "SAFETY.INPUT.TEXT",
    });
    const failed = await provider.poll(refFor(), ctx());
    expect(failed.state).toBe("failed");
    expect(failed.failure).toMatchObject({ category: "content_rejected" });
    expect(JSON.stringify(failed)).not.toContain("private moderation detail");
  });
});
