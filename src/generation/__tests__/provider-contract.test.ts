import { describe, expect, it } from "vitest";
import {
  generationModelSchema,
  generationProviderInfoSchema,
  type GenerationModel,
  type GenerationRequest,
  type PromptPlan,
} from "@/domain/generation/schemas";
import type { GenerationProviderAdapter } from "../provider";
import { MockProvider } from "../providers/mock";
import { RunwayProvider } from "../providers/runway/adapter";

/**
 * One contract, every adapter. A new provider is added by appending one entry here: the generic worker,
 * queue, ingestion and UI only ever see this surface.
 */
const SECRET = "key_contract_SUPER_SECRET_0123456789";

const plan: PromptPlan = {
  version: 1,
  sections: [
    { key: "subject", title: "Subject", lines: ["Shot 1A — doorway"] },
    { key: "action", title: "Action", lines: ["begins: hand on the handle", "ends: door opens"] },
  ],
};

const base = (model: GenerationModel): GenerationRequest => {
  const video = model.capabilities.modalities.find((m) => m.endsWith("video"));
  const modality = video ?? model.capabilities.modalities[0]!;
  const v = model.capabilities.video;
  const durationMs = v ? (v.allowedDurationsMs?.[0] ?? Math.max(v.minDurationMs, 4000)) : null;
  return {
    schemaVersion: 1,
    modality,
    provider: model.provider,
    modelId: model.modelId,
    prompt: { positive: "Subject: Shot 1A — doorway", negative: "" },
    durationMs: video ? durationMs : null,
    resolution: null,
    // a still-image model offers its own ratio list (Muse has no exact 16:9): use one the model offers
    aspectRatio: video || !model.capabilities.image ? "16:9" : (model.capabilities.image.aspectRatios[0] ?? null),
    fps: null,
    seed: null,
    references: [],
    startFrameAssetId: modality === "image_to_video" ? "11111111-1111-4111-8111-111111111111" : null,
    endFrameAssetId: null,
    audioAssetIds: [],
    providerOptions: {},
    idempotencyKey: "contract-test-key-0001",
  };
};

const adapters: Array<{ name: string; make: () => GenerationProviderAdapter }> = [
  { name: "mock", make: () => new MockProvider() },
  { name: "runway", make: () => new RunwayProvider({ env: { RUNWAYML_API_SECRET: SECRET } }) },
];

describe.each(adapters)("provider contract: $name", ({ make }) => {
  const adapter = make();

  it("declares valid provider info and models that belong to it", () => {
    const info = generationProviderInfoSchema.parse(adapter.info());
    const models = adapter.listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(generationModelSchema.safeParse(m).success).toBe(true);
      expect(m.provider).toBe(info.provider);
      // idempotency is a declared fact, never implied
      expect(typeof m.capabilities.operational.idempotency).toBe("boolean");
      expect(m.capabilities.operational.recommendedPollIntervalMs).toBeGreaterThan(0);
    }
    // credentials are declared by NAME only
    for (const name of info.requiredConfig) expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  it("compiles a deterministic, secret-free, URL-free request summary", () => {
    for (const m of adapter.listModels()) {
      const req = base(m);
      const a = adapter.compileRequest(req, plan);
      const b = adapter.compileRequest(req, plan);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      const text = JSON.stringify(a);
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(/data:[a-z]+\/[a-z0-9.+-]+;base64/i);
      expect(typeof a.endpoint).toBe("string");
    }
  });

  it("validates its own supported request and rejects a modality it cannot do", () => {
    for (const m of adapter.listModels()) {
      expect(adapter.validateRequest(base(m), m).ok).toBe(true);
      const bad = adapter.validateRequest({ ...base(m), modality: "upscale" }, m);
      expect(bad.ok).toBe(false);
      expect(bad.errors.length).toBeGreaterThan(0);
    }
  });

  it("estimates cost as a non-negative number or an explicit null, in a 3-letter currency", () => {
    for (const m of adapter.listModels()) {
      const e = adapter.estimateCost(base(m), m);
      expect(e.currency).toMatch(/^[A-Z]{3}$/);
      if (e.amount != null) expect(e.amount).toBeGreaterThanOrEqual(0);
      expect(typeof e.basis).toBe("string");
    }
  });

  it("exposes an output host allow-list (possibly empty) and never allows everything", () => {
    const hosts = adapter.allowedOutputHosts?.() ?? [];
    expect(Array.isArray(hosts)).toBe(true);
    for (const h of hosts) expect(h).not.toBe("*");
  });
});
