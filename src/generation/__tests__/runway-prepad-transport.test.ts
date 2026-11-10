import { describe, expect, it } from "vitest";
import { seedWithFrame } from "@/domain/__tests__/production-frame-fixtures";
import { shotByCode } from "@/domain/__tests__/helpers";
import { buildShotContext } from "@/domain/context";
import { assembleGenerationPackage } from "@/domain/generation-package";
import { animationRequestViolations } from "@/domain/generation/animation";
import { evaluateCompatibility } from "@/domain/generation/compatibility";
import { buildGenerationRequest } from "@/domain/generation/gate";
import { catalogModel, toGenerationModel } from "@/domain/generation/models/catalog";
import { buildPromptPlan } from "@/domain/generation/prompt-plan";
import { attemptTransportGeometry, parseFrozenStartFrameTransport } from "@/domain/framing/transport";
import type { GenerationRequest } from "@/domain/generation/schemas";
import { encodeMockPng } from "../providers/mock-image";
import { RunwayProvider, type RunwayClientLike } from "../providers/runway/adapter";
import type { RunwayStartFrameTransportSpec } from "../providers/runway/start-frame-transport";

const ENV = {
  NODE_ENV: "test",
  PRISM_STUDIO_GENERATION_PROVIDERS: "runway",
  RUNWAYML_API_SECRET: "key_test_0123456789abcdef0123456789",
  PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
  PRISM_STUDIO_MAX_GENERATION_USD: "5",
};
const ADAPTED = { framing: "overscan_for_crop", duration: "generate_longer_then_trim" } as const;

function frozen(modelId: string) {
  const { data, frame, asset } = seedWithFrame("3A");
  const pkg = assembleGenerationPackage(buildShotContext(data, shotByCode(data, "3A").id));
  const model = toGenerationModel(catalogModel("runway", modelId)!);
  const compatibility = evaluateCompatibility(pkg, model, {
    purpose: "animate_production_frame",
    adaptation: ADAPTED,
  });
  const plan = buildPromptPlan(pkg, compatibility.adaptation?.promptAdaptation, {
    purpose: "animate_production_frame",
  });
  const request = buildGenerationRequest({
    pkg,
    model,
    compatibility,
    plan,
    idempotencyKey: "k-prepad-000001",
  });
  return { data, frame, asset, pkg, model, plan, request };
}
const withTransport = (r: GenerationRequest, t: unknown): GenerationRequest => ({
  ...r,
  providerOptions: { ...r.providerOptions, prismStartFrameTransport: t },
});

describe("Runway Gen-4.5 pre-pad start-frame transport (Phase 5B)", () => {
  it("Gen-4.5 freezes the explicit contain-prepad-center-crop-v1 record, bound to the canonical frame", () => {
    const { request, frame, asset } = frozen("gen4.5");
    expect(asset.width! / asset.height!).toBeGreaterThan(2.3); // a wide (≈2.39:1) Production Frame
    expect(request.providerOptions?.prismStartFrameTransport).toEqual({
      version: 1,
      policy: "contain-prepad-center-crop-v1",
      sourceAssetId: frame.assetId,
      background: "black",
      source: { width: asset.width, height: asset.height },
      content: { width: 1584, height: 662 },
      submittedCanvas: { width: 1584, height: 792 },
      submittedOffset: { x: 0, y: 65 },
      providerCrop: {
        behavior: "center",
        source: "https://docs.dev.runwayml.com/assets/inputs/",
        verifiedAt: "2026-11-10",
      },
      outputCanvas: { width: 1584, height: 672 },
      expectedCrop: { x: 0, y: 60, width: 1584, height: 672 },
      effectiveContent: { x: 0, y: 5, width: 1584, height: 662 },
    });
    expect(request.startFrameAssetId).toBe(frame.assetId);
  });

  it("Gen-4 Turbo keeps its existing contain-pad-v1 transport (its range already covers 21:9)", () => {
    const { request, frame } = frozen("gen4_turbo");
    expect(request.providerOptions?.prismStartFrameTransport).toEqual({
      version: 1,
      policy: "contain-pad-v1",
      sourceAssetId: frame.assetId,
      targetCanvas: { width: 1584, height: 672 },
      background: "black",
    });
  });

  it("the adapter validates it, shows every number, and delivery gets the same effective rect as Turbo", () => {
    const { request, plan, asset, frame } = frozen("gen4.5");
    const provider = new RunwayProvider({ env: ENV });
    const g45 = toGenerationModel(catalogModel("runway", "gen4.5")!);
    expect(provider.validateRequest(request, g45)).toEqual({ ok: true, errors: [] });
    const compiled = provider.compileRequest(request, plan);
    expect(compiled.fields.startFrameTransport).toMatchObject({
      policy: "contain-prepad-center-crop-v1",
      submittedCanvas: { width: 1584, height: 792 },
      expectedCrop: { x: 0, y: 60, width: 1584, height: 672 },
      effectiveContent: { x: 0, y: 5, width: 1584, height: 662 },
    });
    expect(compiled.notes.join(" ")).toMatch(/removes padding only/);
    const size = (id: string) =>
      id === frame.assetId ? { width: asset.width!, height: asset.height! } : null;
    const g = (opts: unknown) =>
      attemptTransportGeometry({ providerOptions: opts, inputAssetIds: [frame.assetId], sourceSize: size });
    const turbo = frozen("gen4_turbo");
    const turboGeometry = attemptTransportGeometry({
      providerOptions: turbo.request.providerOptions,
      inputAssetIds: [turbo.frame.assetId],
      sourceSize: () => ({ width: turbo.asset.width!, height: turbo.asset.height! }),
    });
    expect(g(request.providerOptions)?.content).toEqual({ x: 0, y: 5, width: 1584, height: 662 });
    expect(g(request.providerOptions)?.content).toEqual(turboGeometry?.content);
    expect(g(request.providerOptions)?.canvas).toEqual({ width: 1584, height: 672 });
  });

  it("refuses tampered records, a model without a documented centre crop, and an out-of-range submission", () => {
    const { request } = frozen("gen4.5");
    const t = parseFrozenStartFrameTransport(request.providerOptions?.prismStartFrameTransport)!;
    if (t.policy !== "contain-prepad-center-crop-v1") throw new Error("expected pre-pad");
    const provider = new RunwayProvider({ env: ENV });
    const g45 = toGenerationModel(catalogModel("runway", "gen4.5")!);
    const turbo = toGenerationModel(catalogModel("runway", "gen4_turbo")!);
    for (const bad of [
      { ...t, submittedOffset: { x: 0, y: 64 } },
      { ...t, expectedCrop: { x: 0, y: 59, width: 1584, height: 672 } },
      { ...t, effectiveContent: { x: 0, y: 4, width: 1584, height: 662 } },
      { ...t, submittedCanvas: { width: 1584, height: 672 } },
      { ...t, outputCanvas: { width: 1280, height: 720 } },
      { ...t, sourceAssetId: "another-asset" },
      { ...t, providerCrop: { ...t.providerCrop, verifiedAt: "2020-01-01" } },
      { ...t, policy: "unknown-policy" },
    ]) {
      expect(provider.validateRequest(withTransport(request, bad), g45).ok).toBe(false);
    }
    // Gen-4 Turbo's catalog documents no centre crop: it can never run the pre-pad policy
    const asTurbo = { ...withTransport(request, t), modelId: "gen4_turbo" };
    const check = provider.validateRequest(asTurbo, turbo);
    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toMatch(/documents no centre crop/);
  });

  it("the animation invariant (re-checked by the worker) binds the transport to the frozen Production Frame", () => {
    const { request, pkg } = frozen("gen4.5");
    expect(animationRequestViolations(request, pkg)).toEqual([]);
    const t = request.providerOptions?.prismStartFrameTransport as Record<string, unknown>;
    expect(
      animationRequestViolations(withTransport(request, { ...t, sourceAssetId: "other" }), pkg),
    ).toContain("The provider start-frame transport does not wrap the frozen Production Frame.");
  });

  it("submit asks the transport for the frozen 1584×792 placement and sends a 1584:672 request", async () => {
    const { request, plan, asset } = frozen("gen4.5");
    const specs: RunwayStartFrameTransportSpec[] = [];
    const created: Array<Record<string, unknown>> = [];
    const client = {
      imageToVideo: { create: async (b: Record<string, unknown>) => (created.push(b), { id: "task_1" }) },
      textToVideo: { create: async () => ({ id: "x" }) },
      textToImage: { create: async () => ({ id: "x" }) },
      tasks: { retrieve: async () => ({}), delete: async () => undefined },
    } as unknown as RunwayClientLike;
    const provider = new RunwayProvider({
      env: ENV,
      clientFactory: () => client,
      startFrameTransport: async (a, spec) => {
        specs.push(spec);
        return {
          asset: a,
          policy: "contain-pad-v1",
          applied: true,
          source: { width: asset.width!, height: asset.height!, aspect: asset.width! / asset.height! },
          target: { ...spec.targetCanvas, aspect: spec.targetCanvas.width / spec.targetCanvas.height },
          content: { ...spec.placement!, scaled: true },
        };
      },
    });
    const png = encodeMockPng(64, 27, 2);
    await provider.submit(request, plan, {
      now: () => new Date("2026-11-10T00:00:00Z"),
      assets: { read: async () => ({ bytes: png, mime: "image/png", filename: "frame.png" }) },
    });
    expect(specs).toEqual([
      {
        targetCanvas: { width: 1584, height: 792 },
        aspectRange: { min: 0.5, max: 2 },
        placement: { width: 1584, height: 662, x: 0, y: 65 },
        expectedSource: { width: asset.width, height: asset.height },
      },
    ]);
    expect(created[0]).toMatchObject({ model: "gen4.5", ratio: "1584:672", duration: 5 });
  });
});
