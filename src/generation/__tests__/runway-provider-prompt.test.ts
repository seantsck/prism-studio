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
import { adaptProviderPrompt, parseFrozenProviderPrompt } from "@/domain/generation/provider-prompt";
import type { GenerationPurpose, GenerationRequest } from "@/domain/generation/schemas";
import { readGenerationConfig } from "../config";
import { encodeMockPng } from "../providers/mock-image";
import { RunwayProvider, type RunwayClientLike } from "../providers/runway/adapter";
import { compileRunwayPrompt } from "../providers/runway/compile";
import { ModelRegistry } from "../registry";
import { evaluateShotForModel, prepareSubmission } from "../submission";

const ENV = {
  NODE_ENV: "test",
  PRISM_STUDIO_GENERATION_PROVIDERS: "runway",
  RUNWAYML_API_SECRET: "key_test_0123456789abcdef0123456789",
  PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
  PRISM_STUDIO_MAX_GENERATION_USD: "5",
};
const ADAPTED = { framing: "overscan_for_crop", duration: "generate_longer_then_trim" } as const;

/** Captures the exact body Runway would receive (no network, no credits). */
function fakeClient(created: Array<Record<string, unknown>>): RunwayClientLike {
  const create = async (body: Record<string, unknown>) => {
    created.push(body);
    return { id: `task_${created.length}` };
  };
  const never = async () => {
    throw new Error("not used");
  };
  return {
    textToVideo: { create },
    imageToVideo: { create },
    textToImage: { create: never },
    tasks: { retrieve: never, delete: never },
  } as unknown as RunwayClientLike;
}

function frozen(modelId = "gen4_turbo", purpose: GenerationPurpose = "animate_production_frame") {
  const { data, frame } = seedWithFrame("3A");
  const shot = shotByCode(data, "3A");
  const pkg = assembleGenerationPackage(buildShotContext(data, shot.id));
  const model = toGenerationModel(catalogModel("runway", modelId)!);
  const compatibility = evaluateCompatibility(pkg, model, { purpose, adaptation: ADAPTED });
  const plan = buildPromptPlan(pkg, compatibility.adaptation?.promptAdaptation, { purpose });
  const request = buildGenerationRequest({
    pkg,
    model,
    compatibility,
    plan,
    idempotencyKey: "k-provider-prompt-01",
  });
  return { data, shot, frame, pkg, model, plan, request };
}

describe("Runway Gen-4 Turbo sends the policy-adapted provider prompt (Phase 5B)", () => {
  it("freezes the adapted prompt with full provenance in the immutable request", () => {
    const { pkg, request } = frozen();
    const p = parseFrozenProviderPrompt(request.providerOptions?.prismProviderPrompt)!;
    expect(p).toEqual(
      adaptProviderPrompt(pkg, {
        provider: "runway",
        modelId: "gen4_turbo",
        purpose: "animate_production_frame",
      }),
    );
    expect(p).toMatchObject({
      schema: "prism.provider-prompt.v1",
      policy: { id: "visible-motion", version: 1 },
      provider: "runway",
      modelId: "gen4_turbo",
      purpose: "animate_production_frame",
      sourceFingerprint: pkg.provenance.fingerprint,
      ok: true,
    });
    expect(p.length).toBe(p.text.length);
    // the production intent (prompt plan) is untouched: the provider prompt is a separate, derived record
    expect(request.prompt.positive).toContain("mask");
    expect(p.text).not.toMatch(/mask|composure/i);
  });

  it("compiles and SUBMITS exactly the frozen text, and the inspector shows its policy and budget", async () => {
    const { request, plan } = frozen();
    const p = parseFrozenProviderPrompt(request.providerOptions?.prismProviderPrompt)!;
    const created: Array<Record<string, unknown>> = [];
    const provider = new RunwayProvider({
      env: ENV,
      clientFactory: () => fakeClient(created),
      startFrameTransport: async (asset, spec) => ({
        asset,
        policy: "contain-pad-v1",
        applied: true,
        source: { width: 1536, height: 642, aspect: 1536 / 642 },
        target: { ...spec.targetCanvas, aspect: spec.targetCanvas.width / spec.targetCanvas.height },
        content: { width: 1584, height: 662, x: 0, y: 5, scaled: true },
      }),
    });
    const compiled = provider.compileRequest(request, plan);
    expect(compiled.fields.promptText).toBe(p.text);
    expect(compiled.fields).toMatchObject({
      promptTextLength: p.length,
      promptPolicy: "visible-motion@v1",
      promptSourceFingerprint: p.sourceFingerprint,
      promptBudget: { limit: 1000, target: 900 },
    });
    expect(compiled.notes.join(" ")).toContain("Provider prompt adapted by visible-motion v1");
    expect(
      provider.validateRequest(request, toGenerationModel(catalogModel("runway", "gen4_turbo")!)),
    ).toEqual({
      ok: true,
      errors: [],
    });

    const png = encodeMockPng(64, 27, 2);
    await provider.submit(request, plan, {
      now: () => new Date("2026-11-10T00:00:00Z"),
      assets: { read: async () => ({ bytes: png, mime: "image/png", filename: "frame.png" }) },
    });
    expect(created).toHaveLength(1);
    expect(created[0]!.promptText).toBe(p.text);
    expect(created[0]).toMatchObject({ model: "gen4_turbo", duration: 5, ratio: "1584:672" });
  });

  it("optional sections the budget dropped surface as one acknowledgeable ignored feature", () => {
    const { request, plan } = frozen();
    const p = parseFrozenProviderPrompt(request.providerOptions?.prismProviderPrompt)!;
    const provider = new RunwayProvider({ env: ENV });
    const extra = provider.additionalIgnoredFeatures(request, plan);
    if (p.omitted.length === 0) expect(extra).toEqual([]);
    else {
      expect(extra).toHaveLength(1);
      expect(extra[0]).toMatchObject({ id: "prompt.budget", feature: "prompt" });
      for (const o of p.omitted) expect(extra[0]!.impact).toContain(o.label.toLowerCase());
    }
  });

  it("refuses a tampered, foreign, over-limit or not-ok frozen prompt instead of sending or truncating it", () => {
    const { request } = frozen();
    const p = parseFrozenProviderPrompt(request.providerOptions?.prismProviderPrompt)!;
    const turbo = toGenerationModel(catalogModel("runway", "gen4_turbo")!);
    const provider = new RunwayProvider({ env: ENV });
    const withPrompt = (x: unknown): GenerationRequest => ({
      ...request,
      providerOptions: { ...request.providerOptions, prismProviderPrompt: x },
    });
    const long = "x".repeat(1200);
    for (const bad of [
      { ...p, text: "edited", length: 99 },
      { ...p, modelId: "gen4.5" },
      { ...p, text: long, length: long.length },
      { ...p, ok: false, problem: "too long" },
      { nope: true },
    ]) {
      expect(provider.validateRequest(withPrompt(bad), turbo).ok).toBe(false);
    }
  });

  it("the adapter invariant binds the frozen prompt to the attempt's own package (worker re-checks it)", () => {
    const { request, pkg } = frozen();
    expect(animationRequestViolations(request, pkg)).toEqual([]);
    const p = parseFrozenProviderPrompt(request.providerOptions?.prismProviderPrompt)!;
    const moved = {
      ...request,
      providerOptions: {
        ...request.providerOptions,
        prismProviderPrompt: { ...p, sourceFingerprint: "other" },
      },
    };
    expect(animationRequestViolations(moved, pkg)).toContain(
      "The frozen provider prompt was derived from a different package.",
    );
  });

  it("models and purposes without a policy behave exactly as before", () => {
    // Gen-4.5 animation: no policy, the plan compilation is sent unchanged
    const g45 = frozen("gen4.5");
    expect(g45.request.providerOptions?.prismProviderPrompt).toBeUndefined();
    const provider = new RunwayProvider({ env: ENV });
    const compiled = provider.compileRequest(g45.request, g45.plan);
    expect(compiled.fields.promptText).toBe(
      compileRunwayPrompt(g45.plan, 1000, {
        modelName: "Runway Gen-4.5",
        negativeSent: false,
        audioReference: false,
      }).text,
    );
    expect(compiled.fields.promptPolicy).toBeUndefined();
    // Gen-4 Turbo for an ordinary Shot output: no policy either
    const out = frozen("gen4_turbo", "shot_output");
    expect(out.request.providerOptions?.prismProviderPrompt).toBeUndefined();
  });

  it("the no-spend evaluation shows the provider prompt and prepareSubmission records it on the attempt", () => {
    const { data, shot, pkg } = frozen();
    const registry = new ModelRegistry([new RunwayProvider({ env: ENV })], readGenerationConfig(ENV), ENV);
    const ev = evaluateShotForModel({
      data,
      shotId: shot.id,
      registry,
      provider: "runway",
      modelId: "gen4_turbo",
      purpose: "animate_production_frame",
      adaptation: ADAPTED,
    });
    expect(ev.providerPrompt?.policy).toEqual({ id: "visible-motion", version: 1 });
    expect(ev.providerPrompt?.sourceFingerprint).toBe(pkg.provenance.fingerprint);
    const prepared = prepareSubmission({
      data,
      shotId: shot.id,
      registry,
      provider: "runway",
      modelId: "gen4_turbo",
      acknowledged: ev.gate.unacknowledged.map((x) => x.id),
      adaptation: ADAPTED,
      purpose: "animate_production_frame",
      userId: null,
      idempotencyKey: "k-provider-prompt-02",
      config: readGenerationConfig(ENV),
    });
    expect(prepared.input).not.toBeNull();
    const recorded = (prepared.input!.attempt.request as { providerOptions?: Record<string, unknown> })
      .providerOptions?.prismProviderPrompt;
    expect(recorded).toEqual(ev.providerPrompt);
    // the immutable attempt also keeps the production intent and the package it came from
    expect(prepared.input!.attempt.packageFingerprint).toBe(
      (recorded as { sourceFingerprint: string }).sourceFingerprint,
    );
    expect(prepared.input!.attempt.promptPlan?.sections.length ?? 0).toBeGreaterThan(0);
  });
});
