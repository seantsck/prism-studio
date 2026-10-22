import { describe, expect, it } from "vitest";
import type { GenerationRequest } from "@/domain/generation/schemas";
import {
  RunwayProvider,
  type RunwayClientLike,
  type RunwayTask,
} from "@/generation/providers/runway/adapter";
import { candidateCanvasFacts, describeDims, frozenProviderRequest } from "../output-dims";

/**
 * Phase 2G.2.1 (live image smoke finding): a candidate card must never show the adaptation PLAN's canvas as the canvas
 * Prism requested from the provider. The requested canvas comes only from the stored output's frozen provider
 * provenance. No network: the Runway provenance below is produced by the real adapter against a fake SDK client.
 */

/** The output provenance shape the worker stores: the output's own facts plus `provider` = the result provenance. */
const stored = (providerProvenance: Record<string, unknown>) => ({
  role: "primary",
  sha256: "a".repeat(64),
  mime: "image/png",
  provider: providerProvenance,
});

describe("LIVE SMOKE REGRESSION: the planning canvas is never shown as the requested provider canvas", () => {
  it("2.39:1 frame · plan 1920×822 · Runway request 2048×880 · output 2048×880 · delivery 2048×856", () => {
    // what the 2G.2 live smoke stored for gpt_image_2_5_flare
    const provenance = stored({
      provider: "runway",
      model: "gpt_image_2_5_flare",
      settings: {
        model: "gpt_image_2_5_flare",
        purpose: "production_frame",
        modality: "text_to_image",
        ratio: "2048:880",
        providerCanvas: { width: 2048, height: 880 },
        quality: "medium",
        outputCount: 1,
      },
    });
    const facts = candidateCanvasFacts(provenance, { width: 1920, height: 822 });
    const t = describeDims({
      recorded: "2048×880",
      measured: null,
      ...facts,
      requested: facts.requestedProvider,
      deliveryResolution: "2048×856",
      deliveryNote: "conformed master",
    });
    expect(t.providerCanvas).toBe("2048×880");
    expect(t.providerCanvas).not.toContain("1920×822"); // the pre-fix card showed "1920×822 (requested)"
    expect(t.planningCanvas).toBeNull(); // the exact request is known: the plan adds nothing
    expect(t.actualOutput).toBe("2048×880");
    expect(t.delivery).toBe("conformed master · 2048×856");
  });

  it("before a request exists, the plan is shown as PLANNING geometry and the request as unknown", () => {
    const facts = candidateCanvasFacts(null, { width: 1920, height: 822 });
    const t = describeDims({
      recorded: null,
      measured: null,
      requested: facts.requestedProvider,
      planningCanvas: facts.planningCanvas,
      deliveryResolution: null,
      deliveryNote: "provider original",
    });
    expect(t.providerCanvas).toMatch(/^unknown/);
    expect(t.planningCanvas).toBe("1920×822 (plan, not a request)");
  });

  it("an older attempt without request geometry stays unknown; the plan is never substituted", () => {
    const old = { role: "primary", sha256: "b".repeat(64), mime: "video/mp4" }; // no provider settings recorded
    expect(frozenProviderRequest(old)).toBeNull();
    const t = describeDims({
      recorded: "1280×720",
      measured: null,
      requested: frozenProviderRequest(old),
      planningCanvas: "1584×672",
      deliveryResolution: null,
      deliveryNote: "provider original",
    });
    expect(t.providerCanvas).toBe("unknown (no request geometry was recorded)");
    expect(t.planningCanvas).toBe("1584×672 (plan, not a request)");
  });
});

describe("the requested canvas of each registered image model comes from the frozen result provenance", () => {
  const fake = (): RunwayClientLike => ({
    textToVideo: { create: async () => ({ id: "x" }) },
    imageToVideo: { create: async () => ({ id: "x" }) },
    textToImage: { create: async () => ({ id: "x" }) },
    tasks: {
      retrieve: async (id): Promise<RunwayTask> => ({
        id,
        status: "SUCCEEDED",
        output: ["https://dnznrvs05pmza.cloudfront.net/o.png"],
        cost: { credits: 1 },
      }),
      delete: async () => undefined,
    },
  });
  const provider = new RunwayProvider({
    env: { RUNWAYML_API_SECRET: "key_test_0123456789" },
    clientFactory: fake,
  });
  const request = (modelId: string): GenerationRequest => ({
    schemaVersion: 1,
    modality: "text_to_image",
    purpose: "production_frame",
    provider: "runway",
    modelId,
    prompt: { positive: "x", negative: "" },
    durationMs: null,
    resolution: { width: 1920, height: 822 }, // the plan's canvas: must NOT be what is reported as requested
    aspectRatio: "21:9",
    fps: null,
    seed: null,
    references: [],
    startFrameAssetId: null,
    endFrameAssetId: null,
    audioAssetIds: [],
    providerOptions: {},
    idempotencyKey: "canvas-truth-key",
  });

  it.each([
    ["gpt_image_2_5_flare", "2048×880"],
    ["muse_image", "2352×1008"],
    ["seedream5_lite", "3136×1344"],
  ])(
    "%s: requested %s (the live-smoke canvases)",
    async (modelId: string, expected: string): Promise<void> => {
      const ref = {
        providerJobId: "t1",
        model: modelId,
        pollCount: 0,
        submittedAt: null,
        idempotencyKey: "k",
      };
      const result = await provider.fetchResult(ref, request(modelId), {
        now: () => new Date(),
        assets: { read: async () => null },
      });
      const t = describeDims({
        recorded: expected,
        measured: null,
        requested: frozenProviderRequest(stored(result.provenance as unknown as Record<string, unknown>)),
        planningCanvas: "1920×822",
        deliveryResolution: null,
        deliveryNote: "provider original",
      });
      expect(t.providerCanvas).toBe(expected);
      expect(t.planningCanvas).toBeNull();
    },
  );
});

describe("video candidates stay truthful", () => {
  it("a Runway video request that sent a pixel ratio shows that canvas", () => {
    const r = frozenProviderRequest(
      stored({ settings: { ratio: "1280:720", resolutionTier: null, modality: "image_to_video" } }),
    );
    expect(r).toEqual({ canvas: "1280×720", ratioLabel: null, tier: null });
    expect(
      describeDims({
        recorded: "1280×720",
        measured: null,
        requested: r,
        planningCanvas: "1280×720",
        deliveryResolution: null,
        deliveryNote: "provider original",
      }).providerCanvas,
    ).toBe("1280×720");
  });

  it("a tier-based video model (aspect label + resolution tier) never gets a manufactured pixel size", () => {
    const r = frozenProviderRequest(stored({ settings: { ratio: "16:9", resolutionTier: "768p" } }));
    expect(r).toEqual({ canvas: null, ratioLabel: "16:9", tier: "768p" });
    const t = describeDims({
      recorded: null,
      measured: "1366×768",
      requested: r,
      planningCanvas: "1280×720",
      deliveryResolution: null,
      deliveryNote: "provider original",
    });
    expect(t.providerCanvas).toBe("16:9 at the 768p tier (aspect sent, no pixel canvas)");
    expect(t.providerCanvas).not.toMatch(/\d+×\d+/);
    expect(t.planningCanvas).toBe("1280×720 (plan, not a request)");
  });

  it("the mock provider records only an aspect label: shown as such, the plan stays labelled as planning", () => {
    const r = frozenProviderRequest(stored({ settings: { modality: "text_to_image", aspectRatio: "21:9" } }));
    expect(r).toEqual({ canvas: null, ratioLabel: "21:9", tier: null });
  });
});
