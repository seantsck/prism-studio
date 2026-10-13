import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AnalysisSpendPolicy } from "@/domain/continuity/analysis/cost";
import { parseAdaptationPlan } from "@/domain/framing/adaptation";
import { makeHarness, type Harness } from "@/generation/__tests__/helpers";
import { memoryLogger } from "@/generation/log";
import { encodeMockPng } from "@/generation/providers/mock-image";
import { conformAttemptOutput } from "@/media/delivery";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import { projectRun, computeQaInputs } from "../service";
import { MockAnalysisProvider } from "../analysis/mock-provider";
import { submitAnalysis, AnalysisSubmitError } from "../analysis/submit";
import { ContinuityAnalysisWorker } from "../analysis/worker";
import type { ContinuityAnalysisProvider } from "../analysis/provider";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { readGeminiConfig } from "../providers/gemini/config";
import { FakeGeminiTransport, answerAll } from "../providers/gemini/fake-transport";
import { GeminiTransportError } from "../providers/gemini/transport";

const processor = new FfmpegMediaProcessor({ limits: { timeoutMs: 90_000 } });
const hasFfmpeg = await processor.available();
const media = hasFfmpeg ? describe : describe.skip;
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PAID: AnalysisSpendPolicy = { enabled: true, maxUsdPerRun: 0.5, maxUsdPerDay: 5 };
const CLOSED: AnalysisSpendPolicy = { enabled: false, maxUsdPerRun: null, maxUsdPerDay: null };
const cfg = readGeminiConfig({
  PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
  GEMINI_API_KEY: "test-key-not-real",
});
const LIMITS = { maxActivePerProject: 3, maxJobAttempts: 3 };

async function adaptedAttempt(h: Harness) {
  const { attemptId, jobId } = await h.submit("3A", "mock-video-169", {
    adaptation: { framing: "overscan_for_crop", duration: "generate_longer_then_trim" },
  });
  const w = h.worker();
  for (let i = 0; i < 30; i++) {
    const j = (await h.repo.generation.getJob(jobId!))!;
    if (j.status === "succeeded" || j.status === "failed") break;
    await w.tick();
    h.clock.advance(1500);
  }
  const view = (await h.repo.generation.getAttemptView(attemptId!))!;
  const original = view.outputs.find((o) => o.output.role === "primary")!.asset;
  const plan = parseAdaptationPlan(view.attempt.adaptationPlan)!;
  const deps = { processor, storage: h.sink, qa: h.repo.mediaQa, userId: null, now: () => h.clock.now };
  await conformAttemptOutput({
    attemptId: attemptId!,
    attemptLabel: "3A-a1",
    original,
    plan: plan.conform,
    deps,
  });
  return { attemptId: attemptId!, deps };
}

/** Gives every reference in the frozen set a real (synthetic) image so the plan has something to send. */
async function stockReferences(h: Harness, attemptId: string) {
  const data = await h.data();
  const view = (await h.repo.generation.getAttemptView(attemptId))!;
  const delivery = await h.repo.mediaQa.getDelivery(attemptId);
  const inputs = computeQaInputs({ data, view, delivery, now: h.clock.now })!;
  let seed = 1;
  for (const item of inputs.references.items) {
    if (!item.assetId) continue;
    const a = data.assets.find((x) => x.id === item.assetId);
    if (!a || a.type !== "image") continue;
    const bytes = encodeMockPng(64, 36, seed++);
    const path = `${a.projectId}/${a.id}/ref.png`;
    await h.sink.put(path, bytes);
    await h.repo.upsert(a.projectId, "assets", {
      ...a,
      storageProvider: "local",
      bucket: null,
      objectPath: path,
      mime: "image/png",
      byteSize: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      width: 64,
      height: 36,
    });
  }
  const data2 = await h.data();
  const delivery2 = await h.repo.mediaQa.getDelivery(attemptId);
  return {
    data: data2,
    view,
    inputs: computeQaInputs({ data: data2, view, delivery: delivery2, now: h.clock.now })!,
  };
}

const reader = (h: Harness) => ({
  read: async (ref: { objectPath: string | null }) => (ref.objectPath ? h.sink.get(ref.objectPath) : null),
});

function makeWorker(
  h: Harness,
  provider: ContinuityAnalysisProvider,
  paid = PAID,
  extra: Partial<ConstructorParameters<typeof ContinuityAnalysisWorker>[0]> = {},
) {
  const logger = memoryLogger();
  const w = new ContinuityAnalysisWorker({
    store: h.repo.mediaQa,
    providers: new Map([[provider.id, provider]]),
    media: reader(h),
    processor,
    logger,
    paid,
    clock: () => h.clock.now,
    workerId: "test-worker",
    heartbeatMs: 0,
    leaseMs: 5000,
    sleep: async () => undefined,
    retryDelayMs: 100,
    ...extra,
  });
  return { w, logger };
}

media("continuity analysis jobs (memory store, real ffmpeg, fake provider transport)", () => {
  async function setup() {
    const h = makeHarness();
    const { attemptId, deps } = await adaptedAttempt(h);
    const s = await stockReferences(h, attemptId);
    return { h, attemptId, deps, ...s };
  }
  const submit = async (
    ctx: Awaited<ReturnType<typeof setup>>,
    provider: ContinuityAnalysisProvider,
    over: { policy?: AnalysisSpendPolicy; acknowledged?: boolean; nonce?: string } = {},
  ) =>
    submitAnalysis({
      inputs: ctx.inputs,
      view: ctx.view,
      assets: ctx.data.assets,
      provider,
      policy: over.policy ?? PAID,
      deps: ctx.deps,
      acknowledged: over.acknowledged ?? true,
      nonce: over.nonce ?? "n1",
      limits: LIMITS,
      now: ctx.h.clock.now,
    });

  const gemini = (script: ConstructorParameters<typeof FakeGeminiTransport>[0]) => {
    const transport = new FakeGeminiTransport(script);
    return {
      transport,
      provider: new GeminiAnalysisProvider({ config: cfg, transport }) as ContinuityAnalysisProvider,
    };
  };

  it("queues a frozen job; nothing is analysed until a worker claims it; the run is immutable history", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    const { run, job } = await submit(ctx, g.provider);
    expect(job.status).toBe("queued");
    expect(job.providerState).toBe("not_sent");
    expect(run.run.analysisStatus).toBe("queued");
    expect(run.run.analysisPlan!.batches.length).toBeGreaterThan(0);
    expect(run.run.externalManifest!.entries.some((e) => e.sent)).toBe(true);
    expect(run.run.promptVersion).toBe("continuity-gemini-image-v1");
    expect(g.transport.calls).toBe(0); // submission never calls the analyzer
    // no signed URLs / secrets in the frozen snapshot
    const snap = JSON.stringify(job.inputSnapshot);
    expect(snap).not.toMatch(/https?:\/\/|test-key-not-real|signedUrl|token=/i);
    expect(job.inputAssetIds.length).toBeGreaterThan(0);
    // estimate recorded separately from generation costs
    const costs = await ctx.h.repo.mediaQa.listAnalysisCosts(run.run.id);
    expect(costs.map((c) => c.kind)).toEqual(["estimated"]);
    expect(
      (await ctx.h.repo.generation.getAttemptView(ctx.attemptId))!.costs.every(
        (c) => c.kind !== "estimated" || c.provider !== "gemini",
      ),
    ).toBe(true);
  });

  it("worker runs the job: findings with evidence land on the run, cost is recorded, exactly one final result", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    const { run, job } = await submit(ctx, g.provider);
    const { w, logger } = makeWorker(ctx.h, g.provider);
    await w.tick();
    const done = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
    expect(done.status).toBe("succeeded");
    expect(done.providerState).toBe("responded");
    expect(done.actualCostUsd).not.toBeNull();
    const view = (await ctx.h.repo.mediaQa.getRun(run.run.id))!;
    expect(view.run.analysisStatus).toBe("complete");
    const analysed = view.findings.filter((f) => f.finding.resultSource === "analyzer");
    expect(analysed.length).toBeGreaterThan(0);
    const wardrobe = view.findings.find((f) => f.finding.category === "wardrobe");
    if (wardrobe && wardrobe.finding.resultSource === "analyzer") {
      expect(wardrobe.finding.result).toBe("pass");
      const ev = wardrobe.finding.evidence as { items: Array<{ source: string; assetId: string | null }> };
      expect(ev.items[0]!.assetId).toBeTruthy();
    }
    // criteria the analyzer cannot judge stay UNCHECKED with the reason (never an inferred pass)
    const lip = view.findings.find((f) => f.finding.criterionKey === "lip_sync");
    if (lip) expect(lip.finding.result).toBe("unchecked");
    const costs = await ctx.h.repo.mediaQa.listAnalysisCosts(run.run.id);
    expect(costs.map((c) => c.kind).sort()).toEqual(["actual", "estimated"]);
    const events = await ctx.h.repo.mediaQa.listAnalysisEvents(job.id);
    expect(events.map((e) => e.toStatus)).toEqual(
      expect.arrayContaining(["queued", "processing", "succeeded"]),
    );
    // creative state untouched; secrets and prompts not logged
    expect((await ctx.h.repo.generation.getAttemptView(ctx.attemptId))!.attempt.reviewStatus).toBe(
      "unreviewed",
    );
    expect(logger.lines.join("\n")).not.toMatch(/test-key-not-real|DATA \(untrusted/);
    // a second tick finds nothing to do (no duplicate final result)
    expect(await w.tick()).toBe(0);
  });

  it("human override is appended; the analyzer finding stays; a re-run is a separate run with separate history", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("fail"));
    const first = await submit(ctx, g.provider);
    await makeWorker(ctx.h, g.provider).w.tick();
    const v1 = (await ctx.h.repo.mediaQa.getRun(first.run.run.id))!;
    const target = v1.findings.find(
      (f) => f.finding.resultSource === "analyzer" && f.finding.result === "fail",
    )!;
    await ctx.h.repo.mediaQa.addOverride({
      runId: v1.run.id,
      findingId: target.finding.id,
      result: "pass",
      notes: "Warm lobby light; footage confirms black.",
      createdBy: "reviewer",
      now: ctx.h.clock.now.toISOString(),
    });
    const after = (await ctx.h.repo.mediaQa.getRun(v1.run.id))!;
    const f = after.findings.find((x) => x.finding.id === target.finding.id)!;
    expect(f.finding.result).toBe("fail");
    expect(f.overrides[0]!.result).toBe("pass");
    // re-run
    const g2 = gemini(answerAll("pass"));
    const second = await submit(ctx, g2.provider, { nonce: "n2" });
    await makeWorker(ctx.h, g2.provider).w.tick();
    expect(second.run.run.runNumber).toBe(first.run.run.runNumber + 1);
    const runs = await ctx.h.repo.mediaQa.listAttemptRuns(ctx.attemptId);
    expect(runs.length).toBe(2);
    expect(
      JSON.stringify(
        (await ctx.h.repo.mediaQa.getRun(first.run.run.id))!.findings.map((x) => x.finding.result),
      ),
    ).toBe(JSON.stringify(v1.findings.map((x) => x.finding.result)));
    const p = projectRun((await ctx.h.repo.mediaQa.getRun(first.run.run.id))!, null);
    expect(p.findings.find((x) => x.id === target.finding.id)).toMatchObject({
      systemResult: "fail",
      result: "pass",
    });
  });

  it("the paid spend gate: closed policy refuses submission; ack is required; the worker re-checks", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    await expect(submit(ctx, g.provider, { policy: CLOSED })).rejects.toMatchObject({
      code: "spend_blocked",
    });
    await expect(submit(ctx, g.provider, { acknowledged: false })).rejects.toMatchObject({
      code: "needs_ack",
    });
    // queue under an open policy, then run a worker whose gate is closed: nothing is sent
    const { job } = await submit(ctx, g.provider, { nonce: "late" });
    const { w } = makeWorker(ctx.h, g.provider, CLOSED);
    await w.tick();
    const failed = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.lastErrorCategory).toBe("budget");
    expect(g.transport.calls).toBe(0);
    expect((await ctx.h.repo.mediaQa.getRun(job.runId))!.run.analysisStatus).toBe("failed");
  });

  it("over the per-run ceiling is refused at submission", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    await expect(
      submit(ctx, g.provider, { policy: { enabled: true, maxUsdPerRun: 0.0000001, maxUsdPerDay: null } }),
    ).rejects.toMatchObject({
      code: "spend_blocked",
    });
  });

  it("the free mock analyzer needs no gate and no acknowledgement and costs nothing", async () => {
    const ctx = await setup();
    const mock = new MockAnalysisProvider();
    const { run, job } = await submit(ctx, mock, { policy: CLOSED, acknowledged: false });
    await makeWorker(ctx.h, mock, CLOSED).w.tick();
    expect((await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!.status).toBe("succeeded");
    const costs = await ctx.h.repo.mediaQa.listAnalysisCosts(run.run.id);
    expect(costs.find((c) => c.kind === "actual")!.amountUsd).toBe(0);
    const v = (await ctx.h.repo.mediaQa.getRun(run.run.id))!;
    expect(v.findings.some((f) => /MOCK ANALYSIS/.test(f.finding.actual))).toBe(true);
  });

  it("an ambiguous failure (timeout) is NOT re-sent: failed, outcome_unknown, cost unknown", async () => {
    const ctx = await setup();
    const g = gemini([{ kind: "error", error: new GeminiTransportError("timeout", null, "t") }]);
    const { job } = await submit(ctx, g.provider);
    await makeWorker(ctx.h, g.provider).w.tick();
    const failed = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.lastErrorCategory).toBe("outcome_unknown");
    expect(g.transport.calls).toBe(1);
    const costs = await ctx.h.repo.mediaQa.listAnalysisCosts(job.runId);
    expect(costs.find((c) => c.kind !== "estimated")!.kind).toBe("unknown");
    ctx.h.clock.advance(60_000);
    await makeWorker(ctx.h, g.provider).w.tick();
    expect(g.transport.calls).toBe(1); // terminal: no further spend
  });

  it("a safe provider rate limit before anything was processed is requeued (bounded), then succeeds", async () => {
    const ctx = await setup();
    const g = gemini((req, n) =>
      n < 3
        ? { kind: "error", error: new GeminiTransportError("rate_limit", 429, "429") }
        : answerAll("pass")(req),
    );
    const { job } = await submit(ctx, g.provider);
    const { w } = makeWorker(ctx.h, g.provider);
    await w.tick();
    const requeued = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
    expect(requeued.status).toBe("queued");
    expect(requeued.providerState).toBe("not_sent");
    ctx.h.clock.advance(5000);
    await w.tick();
    expect((await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!.status).toBe("succeeded");
  });

  it("schema-invalid twice fails visibly; usage of both calls is accounted", async () => {
    const ctx = await setup();
    const g = gemini([
      { kind: "text", text: "nope" },
      { kind: "text", text: "still nope" },
    ]);
    const { job } = await submit(ctx, g.provider);
    await makeWorker(ctx.h, g.provider).w.tick();
    const failed = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.lastErrorCategory).toBe("schema_invalid");
    expect(g.transport.calls).toBe(2);
    const fin = (await ctx.h.repo.mediaQa.listAnalysisCosts(job.runId)).find((c) => c.kind !== "estimated")!;
    expect(fin.kind).toBe("actual");
    expect((fin.usage as { calls: unknown[] }).calls).toHaveLength(2);
  });

  it("cancel: queued → cancelled without any request; cancel_requested stops before the next request", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    const { job } = await submit(ctx, g.provider);
    const cancelled = (await ctx.h.repo.mediaQa.requestAnalysisCancel(
      job.id,
      ctx.h.clock.now.toISOString(),
    ))!;
    expect(cancelled.status).toBe("cancelled");
    await makeWorker(ctx.h, g.provider).w.tick();
    expect(g.transport.calls).toBe(0);
    expect((await ctx.h.repo.mediaQa.getRun(job.runId))!.run.analysisStatus).toBe("failed");
  });

  it("lease fencing + reclaim: a worker that lost its lease changes nothing; a reclaimed job that may have sent fails instead of re-sending", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    const { job } = await submit(ctx, g.provider);
    const store = ctx.h.repo.mediaQa;
    const first = (
      await store.claim({ workerId: "a", now: ctx.h.clock.now.toISOString(), leaseMs: 1000, limit: 1 })
    )[0]!;
    expect(first.job.status).toBe("claimed");
    // a second worker cannot claim a live lease
    expect(
      await store.claim({ workerId: "b", now: ctx.h.clock.now.toISOString(), leaseMs: 1000, limit: 1 }),
    ).toHaveLength(0);
    // worker a starts, marks "sending", then dies
    await store.update(
      job.id,
      first.job.leaseToken!,
      { status: "processing", attemptCount: 1, providerState: "sending" },
      ctx.h.clock.now.toISOString(),
    );
    ctx.h.clock.advance(2000); // lease expires
    const second = (
      await store.claim({ workerId: "b", now: ctx.h.clock.now.toISOString(), leaseMs: 1000, limit: 1 })
    )[0]!;
    expect(second.job.leaseToken).not.toBe(first.job.leaseToken);
    // the stale worker is fenced out
    await expect(
      store.update(job.id, first.job.leaseToken!, { batchesDone: 1 }, ctx.h.clock.now.toISOString()),
    ).rejects.toThrow(/lease/i);
    expect(await store.heartbeat(job.id, first.job.leaseToken!, ctx.h.clock.now.toISOString(), 1000)).toBe(
      false,
    );
    // a worker picks it up: provider_state != not_sent ⇒ failed outcome_unknown, never re-sent
    ctx.h.clock.advance(2000);
    await makeWorker(ctx.h, g.provider).w.tick();
    const end = (await store.getAnalysisJob(job.id))!;
    expect(end.status).toBe("failed");
    expect(end.lastErrorCategory).toBe("outcome_unknown");
    expect(g.transport.calls).toBe(0);
  });

  it("a reclaim BEFORE anything was sent is safe to run again (bounded by max attempts)", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    const { job } = await submit(ctx, g.provider);
    const store = ctx.h.repo.mediaQa;
    const first = (
      await store.claim({ workerId: "a", now: ctx.h.clock.now.toISOString(), leaseMs: 1000, limit: 1 })
    )[0]!;
    await store.update(
      job.id,
      first.job.leaseToken!,
      { status: "processing", attemptCount: 1 },
      ctx.h.clock.now.toISOString(),
    );
    ctx.h.clock.advance(2000);
    await makeWorker(ctx.h, g.provider).w.tick();
    expect((await store.getAnalysisJob(job.id))!.status).toBe("succeeded");
    expect(g.transport.calls).toBeGreaterThan(0);
  });

  it("two workers racing: exactly one executes the job", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    const { job } = await submit(ctx, g.provider);
    const a = makeWorker(ctx.h, g.provider, PAID, { workerId: "a" }).w;
    const b = makeWorker(ctx.h, g.provider, PAID, { workerId: "b" }).w;
    await Promise.all([a.tick(), b.tick()]);
    expect((await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!.status).toBe("succeeded");
    const finals = (await ctx.h.repo.mediaQa.listAnalysisCosts(job.runId)).filter(
      (c) => c.kind !== "estimated",
    );
    expect(finals).toHaveLength(1);
    expect(g.transport.calls).toBe(job.inputSnapshot.plan.batches.length);
  });

  it("only the references and frames in the plan are sent, bounded; hostile production text stays data", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    const { job } = await submit(ctx, g.provider);
    await makeWorker(ctx.h, g.provider).w.tick();
    const sent = new Set(job.inputSnapshot.plan.manifest.entries.filter((e) => e.sent).map((e) => e.inputId));
    const sentCount = job.inputSnapshot.plan.batches.reduce(
      (n, b) => n + b.referenceInputIds.length + b.outputInputIds.length,
      0,
    );
    expect(g.transport.requests.reduce((n, r) => n + r.inlineMedia, 0)).toBe(sentCount);
    expect(sent.size).toBeGreaterThan(0);
    for (const r of g.transport.requests) expect(r.systemInstruction).toMatch(/untrusted/i);
  });

  it("temporary provider files are cleaned up; a failed delete is recorded but never fails the analysis", async () => {
    const ctx = await setup();
    const base = new MockAnalysisProvider();
    let deleted = 0;
    const withFiles: ContinuityAnalysisProvider = Object.create(base);
    withFiles.analyzeBatch = async (a) => {
      a.ctx.onProviderFile?.("files/one");
      a.ctx.onProviderFile?.("files/two");
      return base.analyzeBatch(a);
    };
    withFiles.cleanupFiles = async (refs) =>
      refs.map((ref) => {
        if (ref === "files/two") return { ref, state: "cleanup_failed" as const };
        deleted += 1;
        return { ref, state: "deleted" as const };
      });
    const { job } = await submit(ctx, base, { policy: CLOSED, acknowledged: false });
    const { w } = makeWorker(ctx.h, withFiles, CLOSED);
    await w.tick();
    const done = (await ctx.h.repo.mediaQa.getAnalysisJob(job.id))!;
    expect(done.status).toBe("succeeded");
    expect(deleted).toBe(1);
    expect(done.providerFiles).toEqual([
      { ref: "files/one", state: "deleted" },
      { ref: "files/two", state: "cleanup_failed" },
    ]);
  });

  it("limits concurrent analyses per project", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    const mk = (n: string) => submit(ctx, g.provider, { nonce: n });
    await mk("a");
    await mk("b");
    await mk("c");
    await expect(mk("d")).rejects.toBeInstanceOf(AnalysisSubmitError);
  });

  it("idempotent: the same submission key replays instead of queueing a second paid job", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    const a = await submit(ctx, g.provider, { nonce: "same" });
    const b = await submit(ctx, g.provider, { nonce: "same" });
    expect(b.duplicate).toBe(true);
    expect(b.job.id).toBe(a.job.id);
    expect((await ctx.h.repo.mediaQa.listAttemptRuns(ctx.attemptId)).length).toBe(1);
  });

  it("goes stale like any run when production truth or the output changes; the stored run is untouched", async () => {
    const ctx = await setup();
    const g = gemini(answerAll("pass"));
    const { run } = await submit(ctx, g.provider);
    await makeWorker(ctx.h, g.provider).w.tick();
    const stored = JSON.stringify(await ctx.h.repo.mediaQa.getRun(run.run.id));
    const shot = ctx.data.shots.find((s) => s.id === ctx.view.attempt.shotId)!;
    const changed = {
      ...ctx.data,
      shots: ctx.data.shots.map((s) =>
        s.id === shot.id ? { ...s, continuity: { ...s.continuity, weather: "heavy snow" } } : s,
      ),
    };
    const truth = computeQaInputs({
      data: changed,
      view: ctx.view,
      delivery: await ctx.h.repo.mediaQa.getDelivery(ctx.attemptId),
      now: ctx.h.clock.now,
    })!;
    expect(projectRun((await ctx.h.repo.mediaQa.getRun(run.run.id))!, truth).freshness!.stale).toBe(true);
    expect(JSON.stringify(await ctx.h.repo.mediaQa.getRun(run.run.id))).toBe(stored);
  });
});
