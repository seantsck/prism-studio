import { describe, expect, it } from "vitest";
import type { GenerationRequest, PromptPlan } from "@/domain/generation/schemas";
import { submitCandidateSet } from "../candidate-set";
import { readGenerationConfig } from "../config";
import { silentLogger } from "../log";
import type { ProviderContext, ProviderJobRef } from "../provider";
import { MockProvider } from "../providers/mock";
import { RunwayProvider, type RunwayClientLike } from "../providers/runway/adapter";
import { providerDisclosure } from "../registry";
import { GenerationWorker } from "../worker";
import { makeHarness } from "./helpers";

/**
 * Phase 2G.2.1 (live image smoke finding): the free MockProvider is registered in local development, including during
 * a live paid run. Being registered must never make it a fallback: every job names its own provider. No network.
 */

/** The real MockProvider, counting every call that would do work for a job. */
class CountingMock extends MockProvider {
  calls = 0;
  override async submit(request: GenerationRequest, plan: PromptPlan, ctx: ProviderContext) {
    this.calls += 1;
    return super.submit(request, plan, ctx);
  }
  override async poll(ref: ProviderJobRef, ctx: ProviderContext) {
    this.calls += 1;
    return super.poll(ref, ctx);
  }
  override async fetchResult(ref: ProviderJobRef, request: GenerationRequest, ctx: ProviderContext) {
    this.calls += 1;
    return super.fetchResult(ref, request, ctx);
  }
}

/** A Runway SDK double whose image create call is REJECTED (a definitive 400: no retry, no spend). */
const failingRunway = (): RunwayClientLike => {
  const reject = async (): Promise<{ id: string }> => {
    throw Object.assign(new Error('{"error":"invalid ratio"}'), { status: 400 });
  };
  return {
    textToVideo: { create: reject },
    imageToVideo: { create: reject },
    textToImage: { create: reject },
    tasks: { retrieve: async () => Promise.reject(new Error("no task")), delete: async () => undefined },
  };
};

const ENV = {
  NODE_ENV: "test",
  PRISM_STUDIO_GENERATION_PROVIDERS: "runway",
  RUNWAYML_API_SECRET: "key_test_0123456789abcdef0123456789",
  PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
  PRISM_STUDIO_MAX_GENERATION_USD: "1",
  PRISM_STUDIO_MAX_CANDIDATE_SET_USD: "1",
  PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "0",
};

describe("no provider fallback", () => {
  it("a failed Runway job stays a failed Runway job: the registered mock gets 0 calls, nothing is re-routed", async () => {
    const mock = new CountingMock({ stageDelayMs: 0 });
    const runway = new RunwayProvider({ env: ENV, clientFactory: failingRunway });
    const h = makeHarness(ENV, { extraAdapters: [mock, runway], replaceRegistry: true });
    expect(h.config.enabledProviders).toEqual(expect.arrayContaining(["runway", "mock"])); // both registered
    const data = await h.data();
    const shot = data.shots.find((s) => s.shotCode === "1A")!;
    await h.repo.upsert(data.project.id, "shots", {
      ...shot,
      composition: { ...shot.composition, aspectRatio: "16:9" },
      updatedAt: new Date(h.clock.now.getTime() - 1000).toISOString(),
    });
    const out = await submitCandidateSet({
      data: await h.data(),
      shotId: shot.id,
      registry: h.registry,
      config: h.config,
      generation: h.repo.generation,
      candidates: h.repo.candidates,
      selections: [{ provider: "runway", modelId: "gpt_image_2_5_flare" }],
      acknowledgeAll: true,
      confirmedTotalUsd: 0.05,
      title: "no fallback",
      purpose: "test",
      userId: null,
      projectRevision: null,
      generationPurpose: "production_frame",
      now: h.clock.now,
    });
    expect(out.submitted).toBe(1);
    const attemptId = out.view.members[0]!.attemptId!;

    const worker = new GenerationWorker({
      store: h.repo.generation,
      registry: h.registry,
      sink: h.sink,
      config: h.config,
      logger: silentLogger,
      clock: () => h.clock.now,
      workerId: "no-fallback",
      retryPolicy: { baseDelayMs: 100, maxDelayMs: 1000, jitter: 0 },
      random: () => 0,
      heartbeatMs: 0,
    });
    for (let i = 0; i < 10; i++) {
      await worker.tick(10);
      h.clock.advance(5000);
    }

    const view = (await h.repo.generation.getAttemptView(attemptId))!;
    expect(view.attempt.status).toBe("failed");
    expect(view.attempt.provider).toBe("runway");
    expect(view.job!.provider).toBe("runway");
    expect(view.outputs).toHaveLength(0);
    expect(mock.calls).toBe(0); // the mock was never asked to do this job's work
    // no replacement attempt or job was created for any other provider
    const all = (await h.data()).attempts.filter((a) => a.shotId === shot.id);
    expect(all.map((a) => a.provider)).toEqual(["runway"]);
  });
});

describe("provider disclosure (worker banner) and the per-process mock opt-out", () => {
  it("separates REAL providers from LOCAL TEST providers", () => {
    const infos = [new RunwayProvider({ env: ENV }).info(), new MockProvider().info()];
    expect(providerDisclosure(infos, ["runway", "mock"])).toEqual({ real: ["runway"], localTest: ["mock"] });
    expect(providerDisclosure(infos, ["runway"])).toEqual({ real: ["runway"], localTest: [] });
  });

  it("the mock stays on by default in local development; PRISM_STUDIO_DISABLE_MOCK_PROVIDER=1 removes it for one process", () => {
    expect(readGenerationConfig({ NODE_ENV: "development" }).enabledProviders).toContain("mock");
    expect(
      readGenerationConfig({ NODE_ENV: "test", PRISM_STUDIO_GENERATION_PROVIDERS: "runway" })
        .enabledProviders,
    ).toEqual(["runway", "mock"]);
    expect(
      readGenerationConfig({
        NODE_ENV: "test",
        PRISM_STUDIO_GENERATION_PROVIDERS: "runway",
        PRISM_STUDIO_DISABLE_MOCK_PROVIDER: "1",
      }).enabledProviders,
    ).toEqual(["runway"]);
    // production defaults are unchanged: the mock stays off unless explicitly enabled
    expect(readGenerationConfig({ NODE_ENV: "production" }).enabledProviders).not.toContain("mock");
  });
});
