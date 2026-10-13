import { describe, expect, it, vi } from "vitest";
import {
  CLOSED,
  PAID,
  makeWorker,
  processor,
  setup,
  submit,
  type QueueCtx,
} from "../analysis/__tests__/queue-harness";
import type { ContinuityAnalysisProvider } from "../analysis/provider";
import { OpenAIContinuityAnalyzer } from "../providers/openai/analyzer";
import { OPENAI_PRICING, readOpenAIConfig } from "../providers/openai/config";
import { FakeOpenAITransport, openaiAnswerAll } from "../providers/openai/fake-transport";
import { OpenAITransportError } from "../providers/openai/transport";

const hasFfmpeg = await processor.available();
const media = hasFfmpeg ? describe : describe.skip;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const cfg = readOpenAIConfig({
  PRISM_STUDIO_CONTINUITY_ANALYZERS: "openai",
  OPENAI_API_KEY: "sk-test-key-not-real-0000000000",
});

const openai = (script: ConstructorParameters<typeof FakeOpenAITransport>[0]) => {
  const transport = new FakeOpenAITransport(script);
  return {
    transport,
    provider: new OpenAIContinuityAnalyzer({ config: cfg, transport }) as ContinuityAnalysisProvider,
  };
};
const err = (
  cat: ConstructorParameters<typeof OpenAITransportError>[0],
  status: number | null,
  ...rest: [number?, string?]
) =>
  ({
    kind: "error",
    error: new OpenAITransportError(cat, status, String(status), rest[0] ?? null, rest[1] ?? null),
  }) as const;

media(
  "OpenAI continuity provider through the shared queue (memory store, real ffmpeg, fake transport)",
  () => {
    const live = { retryDelayMs: undefined } as const;

    it("runs the same job pipeline: provider/model on the run, own prompt version, findings, separate cost ledger", async () => {
      const ctx = await setup();
      const g = openai(openaiAnswerAll("pass"));
      const { run, job } = await submit(ctx, g.provider);
      expect(job.analyzer).toBe("openai");
      expect(job.model).toBe("gpt-6-luna");
      expect(run.run.analyzer).toBe("openai");
      expect(run.run.model).toBe("gpt-6-luna");
      expect(run.run.promptVersion).toBe("continuity-openai-image-v1");
      expect(job.providerState).toBe("not_sent");
      expect(g.transport.calls).toBe(0); // submission never calls the analyzer
      const snap = JSON.stringify(job.inputSnapshot);
      expect(snap).not.toMatch(/https?:\/\/|sk-test-key|data:image|base64/i); // no URL, key or bytes in history

      const { w, logger } = makeWorker(ctx.h, g.provider);
      await w.tick();
      const done = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
      expect(done.status).toBe("succeeded");
      expect(done.providerState).toBe("responded");
      expect(done.transportCalls).toBe(g.transport.calls);
      expect(done.actualCostUsd).not.toBeNull();
      const view = (await ctx.h.repo.mediaQa.getRun(run.run.id))!;
      expect(view.run.analysisStatus).toBe("complete");
      const analysed = view.findings.filter((f) => f.finding.resultSource === "analyzer");
      expect(analysed.length).toBeGreaterThan(0);
      for (const f of analysed) expect(["pass", "unchecked"]).toContain(f.finding.result);
      // identical normalized evidence shape to every other provider: asset id + source, no provider fields
      const wardrobe = view.findings.find((f) => f.finding.category === "wardrobe");
      if (wardrobe && wardrobe.finding.resultSource === "analyzer") {
        const ev = wardrobe.finding.evidence as { items: Array<{ source: string; assetId: string | null }> };
        expect(ev.items[0]!.assetId).toBeTruthy();
      }
      const costs = await ctx.h.repo.mediaQa.listAnalysisCosts(run.run.id);
      expect(costs.map((c) => c.kind).sort()).toEqual(["actual", "estimated"]);
      expect(costs.every((c) => c.analyzer === "openai" && c.model === "gpt-6-luna")).toBe(true);
      expect(costs.find((c) => c.kind === "actual")!.pricingVersion).toBe(OPENAI_PRICING.version);
      // the manifest records what was sent and to which provider/model, with no URL / key / bytes
      const manifest = view.run.externalManifest!;
      expect(manifest.entries.some((e) => e.sent)).toBe(true);
      expect(JSON.stringify(manifest)).not.toMatch(/https?:\/\/|sk-|base64/i);
      expect(view.run.analyzer).toBe("openai");
      // creative state untouched; key and DATA never logged
      expect((await ctx.h.repo.generation.getAttemptView(ctx.attemptId))!.attempt.reviewStatus).toBe(
        "unreviewed",
      );
      expect(logger.lines.join("\n")).not.toMatch(/sk-test-key|DATA \(untrusted/);
      expect(await w.tick()).toBe(0);
    });

    it("only the planned references/frames are sent, as bounded data-URL images", async () => {
      const ctx = await setup();
      const g = openai(openaiAnswerAll("pass"));
      const { job } = await submit(ctx, g.provider);
      await makeWorker(ctx.h, g.provider).w.tick();
      const sentCount = job.inputSnapshot.plan.batches.reduce(
        (n, b) => n + b.referenceInputIds.length + b.outputInputIds.length,
        0,
      );
      expect(g.transport.requests.reduce((n, r) => n + r.images, 0)).toBe(sentCount);
      for (const r of g.transport.requests) {
        expect(r.instructions).toMatch(/untrusted/i);
        expect(r.imageDetails.every((d) => d === "high")).toBe(true);
      }
    });

    it("the same Phase 2D batch planner groups requests: OpenAI and Gemini plans are identical apart from provider", async () => {
      const ctx = await setup();
      const g = openai(openaiAnswerAll("pass"));
      const { job } = await submit(ctx, g.provider);
      const { GeminiAnalysisProvider } = await import("../providers/gemini/analyzer");
      const { readGeminiConfig } = await import("../providers/gemini/config");
      const { FakeGeminiTransport } = await import("../providers/gemini/fake-transport");
      const gem = new GeminiAnalysisProvider({
        config: readGeminiConfig({
          PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
          GEMINI_API_KEY: "x".repeat(10),
        }),
        transport: new FakeGeminiTransport([]),
      }) as ContinuityAnalysisProvider;
      const { job: gj } = await submit(ctx, gem, { nonce: "g1" });
      const shape = (j: typeof job) =>
        j.inputSnapshot.plan.batches.map((b) => ({
          criterionKeys: b.criterionKeys,
          referenceInputIds: b.referenceInputIds,
          outputInputIds: b.outputInputIds,
          omitted: b.omittedReferenceInputIds,
        }));
      expect(shape(job)).toEqual(shape(gj));
      expect(job.inputSnapshot.plan.budget).toEqual(gj.inputSnapshot.plan.budget);
    });

    it("503: ONE call per claim, persisted next_run_at, no early claim, then ONE more request", async () => {
      const ctx = await setup();
      const g = openai((req, n) => (n < 1 ? err("overloaded", 503) : openaiAnswerAll("pass")(req)));
      const { job } = await submit(ctx, g.provider);
      const { w } = makeWorker(ctx.h, g.provider, PAID, live);
      const t0 = ctx.h.clock.now.getTime();
      await w.tick();
      expect(g.transport.calls).toBe(1);
      const after = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
      expect(after.status).toBe("queued");
      expect(after.providerState).toBe("responded");
      expect(after.lastErrorCategory).toBe("overloaded");
      expect(after.transportCalls).toBe(1);
      const wait = Date.parse(after.nextRunAt) - t0;
      expect(wait).toBeGreaterThanOrEqual(13_500);
      expect(wait).toBeLessThanOrEqual(16_500);
      const other = makeWorker(ctx.h, g.provider, PAID, { ...live, workerId: "other" }).w;
      ctx.h.clock.advance(5_000);
      expect(await other.tick()).toBe(0);
      expect(g.transport.calls).toBe(1);
      ctx.h.clock.advance(15_000);
      await other.tick();
      expect(g.transport.calls).toBe(1 + job.inputSnapshot.plan.batches.length);
      expect((await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!.status).toBe("succeeded");
    });

    it("429 honours a longer Retry-After", async () => {
      const ctx = await setup();
      const g = openai((req, n) =>
        n < 1 ? err("rate_limit", 429, 90_000, "rate_limit_exceeded") : openaiAnswerAll("pass")(req),
      );
      const { job } = await submit(ctx, g.provider);
      const { w } = makeWorker(ctx.h, g.provider, PAID, live);
      const t0 = ctx.h.clock.now.getTime();
      await w.tick();
      const after = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
      expect(after.status).toBe("queued");
      expect(Date.parse(after.nextRunAt) - t0).toBe(90_000);
      expect(g.transport.calls).toBe(1);
    });

    it("quota / spend-limit exhaustion (429 insufficient_quota) is terminal: never retried", async () => {
      const ctx = await setup();
      const g = openai([err("config", 429, undefined, "insufficient_quota")]);
      const { job } = await submit(ctx, g.provider);
      const { w } = makeWorker(ctx.h, g.provider, PAID, live);
      await w.tick();
      ctx.h.clock.advance(60 * 60_000);
      await w.tick();
      const end = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
      expect(end.status).toBe("failed");
      expect(end.lastErrorCategory).toBe("config");
      expect(end.providerState).toBe("responded");
      expect(g.transport.calls).toBe(1);
    });

    it("auth failure is terminal and confirmed (provider_state responded)", async () => {
      const ctx = await setup();
      const g = openai([err("auth", 401)]);
      const { job } = await submit(ctx, g.provider);
      await makeWorker(ctx.h, g.provider).w.tick();
      const end = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
      expect(end.status).toBe("failed");
      expect(end.lastErrorCategory).toBe("auth");
      expect(end.providerState).toBe("responded");
      expect(g.transport.calls).toBe(1);
    });

    it("exhaustion at the transport ceiling (4, as proposed for the smoke) is terminal and never outcome_unknown", async () => {
      const ctx = await setup();
      const g = openai([err("overloaded", 503)]);
      const { job } = await submit(ctx, g.provider, {
        limits: { maxActivePerProject: 3, maxJobAttempts: 6 },
      });
      const { w } = makeWorker(ctx.h, g.provider, PAID, { ...live, maxTransportCalls: 4 });
      for (let i = 0; i < 8; i++) {
        await w.tick();
        ctx.h.clock.advance(20 * 60_000);
      }
      const end = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
      expect(end.status).toBe("failed");
      expect(end.lastErrorCategory).toBe("provider_overloaded_retry_exhausted");
      expect(end.providerState).toBe("responded");
      expect(end.transportCalls).toBe(4);
      expect(g.transport.calls).toBe(4);
      const fin = (await ctx.h.repo.mediaQa.listAnalysisCosts(job.runId)).filter(
        (c) => c.kind !== "estimated",
      );
      expect(fin).toHaveLength(1);
      expect(fin[0]!.kind).toBe("unknown");
      expect(fin[0]!.usage).toMatchObject({ unknownReason: "provider_overloaded", transportCalls: 4 });
    });

    it("an ambiguous timeout is outcome_unknown, never re-sent, provider_state stays sending", async () => {
      const ctx = await setup();
      const g = openai([err("timeout", null)]);
      const { job } = await submit(ctx, g.provider);
      const { w } = makeWorker(ctx.h, g.provider, PAID, live);
      await w.tick();
      ctx.h.clock.advance(60 * 60_000);
      await w.tick();
      const end = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
      expect(end.status).toBe("failed");
      expect(end.lastErrorCategory).toBe("outcome_unknown");
      expect(end.providerState).toBe("sending");
      expect(g.transport.calls).toBe(1);
      const fin = (await ctx.h.repo.mediaQa.listAnalysisCosts(job.runId)).find(
        (c) => c.kind !== "estimated",
      )!;
      expect(fin.kind).toBe("unknown");
      expect(fin.usage).toMatchObject({ unknownReason: "ambiguous_submission" });
    });

    it("a provider refusal finishes the job with UNCHECKED findings (never fail) and records the spend", async () => {
      const ctx = await setup();
      const g = openai([{ kind: "refusal" }]);
      const { run, job } = await submit(ctx, g.provider);
      await makeWorker(ctx.h, g.provider).w.tick();
      expect((await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!.status).toBe("succeeded");
      const view = (await ctx.h.repo.mediaQa.getRun(run.run.id))!;
      const analysed = view.findings.filter((f) => f.finding.resultSource === "analyzer");
      expect(analysed.length).toBeGreaterThan(0);
      expect(analysed.every((f) => f.finding.result === "unchecked")).toBe(true);
      expect(view.findings.some((f) => f.finding.result === "fail")).toBe(false);
    });

    it("schema correction is allowed once per RUN and counts against the transport ceiling", async () => {
      const ctx = await setup();
      const g = openai((req, n) =>
        n % 2 === 0 ? { kind: "text", text: "nope" } : openaiAnswerAll("pass")(req),
      );
      const { job } = await submit(ctx, g.provider);
      await makeWorker(ctx.h, g.provider).w.tick();
      const end = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
      expect(end.status).toBe("failed");
      expect(end.lastErrorCode).toBe("correction_budget_exhausted");
      expect(end.transportCalls).toBe(3);
      expect(end.correctionCount).toBe(1);
    });

    it("the shared spend gate applies unchanged: closed policy, missing ack and a tiny ceiling all block", async () => {
      const ctx = await setup();
      const g = openai(openaiAnswerAll("pass"));
      await expect(submit(ctx, g.provider, { policy: CLOSED })).rejects.toMatchObject({
        code: "spend_blocked",
      });
      await expect(submit(ctx, g.provider, { acknowledged: false })).rejects.toMatchObject({
        code: "needs_ack",
      });
      await expect(
        submit(ctx, g.provider, { policy: { enabled: true, maxUsdPerRun: 0.0000001, maxUsdPerDay: null } }),
      ).rejects.toMatchObject({ code: "spend_blocked" });
      // the worker re-checks: nothing is sent when its own gate is closed
      const { job } = await submit(ctx, g.provider, { nonce: "late" });
      await makeWorker(ctx.h, g.provider, CLOSED).w.tick();
      const failed = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
      expect(failed.lastErrorCategory).toBe("budget");
      expect(g.transport.calls).toBe(0);
    });

    it("the smoke-shaped estimate stays well under the $0.10 ceiling at the default policy", async () => {
      const ctx: QueueCtx = await setup();
      const g = openai(openaiAnswerAll("pass"));
      const { job } = await submit(ctx, g.provider, {
        policy: { enabled: true, maxUsdPerRun: 0.1, maxUsdPerDay: null },
      });
      expect(job.estimatedCostUsd).not.toBeNull();
      expect(job.estimatedCostUsd!).toBeLessThan(0.1);
    });
  },
);
