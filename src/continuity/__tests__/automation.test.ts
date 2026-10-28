import { describe, expect, it, vi } from "vitest";
import {
  AUTO_SEMANTIC_NONCE,
  defaultQaPolicy,
  deterministicAutomationKey,
  planReconcile,
  projectBudgetBlockers,
  qaPolicyErrors,
  semanticPolicyBlockers,
  type AnalyzerAvailability,
  type ProjectQaPolicy,
} from "@/domain/continuity/automation";
import { parseAdaptationPlan } from "@/domain/framing/adaptation";
import { makeHarness, type Harness } from "@/generation/__tests__/helpers";
import { conformAttemptOutput } from "@/media/delivery";
import { PAID, CLOSED, LIMITS, processor } from "../analysis/__tests__/queue-harness";
import { MockAnalysisProvider } from "../analysis/mock-provider";
import type { ContinuityAnalysisProvider } from "../analysis/provider";
import { analysisIdempotencyKey, submitAnalysis } from "../analysis/submit";
import { OpenAIContinuityAnalyzer } from "../providers/openai/analyzer";
import { readOpenAIConfig } from "../providers/openai/config";
import { FakeOpenAITransport, openaiAnswerAll } from "../providers/openai/fake-transport";
import { autoQaState, autoQaView, reconcileAttemptQa, type AutoQaDeps } from "../automation";
import { computeQaInputs, projectRun, runContinuityReview } from "../service";

/**
 * Phase 3A.2 automatic QA orchestration. Pure decisions first, then the real service over the memory repositories
 * (ffmpeg probe, Mock analyzer, OpenAI FAKE transport). No real analyzer, generation or paid call.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const hasFfmpeg = await processor.available();
const media = hasFfmpeg ? describe : describe.skip;

const P = (o: Partial<ProjectQaPolicy> = {}): ProjectQaPolicy => ({ ...defaultQaPolicy("p1"), ...o });
const AUTO = (o: Partial<ProjectQaPolicy> = {}) =>
  P({
    semanticMode: "automatic",
    analyzer: "mock-continuity",
    externalMediaAllowed: true,
    maxCostPerRunUsd: 0.1,
    maxCostPerDayUsd: 1,
    revision: 1,
    ...o,
  });
const MOCK_OK: AnalyzerAvailability = {
  id: "mock-continuity",
  usable: true,
  kind: "mock",
  missingConfig: [],
};

describe("policy validation (standing consent is never implied)", () => {
  it("off and suggest need nothing; automatic needs analyzer, consent and two finite ceilings", () => {
    expect(qaPolicyErrors(P())).toEqual([]);
    expect(qaPolicyErrors(P({ semanticMode: "suggest", analyzer: "openai" }))).toEqual([]);
    expect(qaPolicyErrors(AUTO())).toEqual([]);
    const missing = qaPolicyErrors(P({ semanticMode: "automatic" })).join(" ");
    expect(missing).toMatch(/needs an analyzer/);
    expect(missing).toMatch(/standing consent/);
    expect(missing).toMatch(/finite per-run ceiling/);
    expect(missing).toMatch(/finite 24-hour Project ceiling/);
    expect(qaPolicyErrors(AUTO({ maxCostPerRunUsd: 2, maxCostPerDayUsd: 1 })).join(" ")).toMatch(
      /cannot exceed/,
    );
    expect(qaPolicyErrors(AUTO({ maxCostPerDayUsd: Number.POSITIVE_INFINITY })).length).toBeGreaterThan(0);
    expect(qaPolicyErrors(AUTO({ maxCostPerRunUsd: -1 })).length).toBeGreaterThan(0);
  });

  it("every Project defaults to semantic automation OFF", () => {
    expect(defaultQaPolicy("x")).toMatchObject({
      semanticMode: "off",
      externalMediaAllowed: false,
      revision: 0,
    });
  });
});

describe("reconciliation decisions", () => {
  const base = { eligibility: null, deterministicCovered: false, semanticCovered: false, policyBlockers: [] };

  it("not eligible → nothing; already covered → nothing", () => {
    expect(planReconcile({ ...base, eligibility: "not_succeeded", policy: P() })).toMatchObject({
      action: "none",
      outcome: "not_eligible",
    });
    expect(planReconcile({ ...base, eligibility: "no_output", policy: P() }).action).toBe("none");
    expect(planReconcile({ ...base, deterministicCovered: true, policy: P() })).toMatchObject({
      outcome: "already_current",
    });
    expect(planReconcile({ ...base, semanticCovered: true, policy: AUTO() })).toMatchObject({
      outcome: "semantic_already_queued",
    });
  });

  it("off → deterministic only; suggest → deterministic + suggestion (no job)", () => {
    expect(planReconcile({ ...base, policy: P() })).toEqual({
      action: "deterministic",
      semantic: "off",
      blockers: [],
    });
    expect(planReconcile({ ...base, policy: P({ semanticMode: "suggest" }) })).toMatchObject({
      action: "deterministic",
      semantic: "suggest",
    });
  });

  it("automatic with every gate passing → ONE semantic run (it carries the deterministic findings)", () => {
    expect(planReconcile({ ...base, policy: AUTO() })).toEqual({
      action: "semantic",
      fallbackDeterministic: true,
    });
    expect(planReconcile({ ...base, deterministicCovered: true, policy: AUTO() })).toEqual({
      action: "semantic",
      fallbackDeterministic: false,
    });
  });

  it("automatic but blocked → deterministic, with the reasons", () => {
    const blockers = semanticPolicyBlockers(AUTO({ externalMediaAllowed: false }), MOCK_OK);
    expect(blockers.map((b) => b.message).join(" ")).toMatch(/standing consent/);
    expect(planReconcile({ ...base, policy: AUTO(), policyBlockers: blockers })).toMatchObject({
      action: "deterministic",
      semantic: "blocked",
    });
  });

  it("analyzer gates: absent, not runnable (missing credential), runnable", () => {
    expect(semanticPolicyBlockers(AUTO(), null)[0]!.message).toMatch(/not enabled on this server/);
    expect(
      semanticPolicyBlockers(AUTO({ analyzer: "openai" }), {
        id: "openai",
        usable: false,
        kind: "model",
        missingConfig: ["OPENAI_API_KEY"],
      })[0]!.message,
    ).toMatch(/cannot run here \(missing OPENAI_API_KEY\)/);
    expect(semanticPolicyBlockers(AUTO(), MOCK_OK)).toEqual([]);
    expect(semanticPolicyBlockers(P({ semanticMode: "suggest" }), null)).toEqual([]);
  });

  it("Project budget: per-run, 24-hour and unknown cost all block; within both passes", () => {
    const policy = AUTO({ maxCostPerRunUsd: 0.05, maxCostPerDayUsd: 0.2 });
    expect(projectBudgetBlockers({ policy, maxEstimateUsd: 0.04, projectSpentLast24hUsd: 0.1 })).toEqual([]);
    expect(projectBudgetBlockers({ policy, maxEstimateUsd: 0.06, projectSpentLast24hUsd: 0 })[0]!.code).toBe(
      "project_budget.over_run_limit",
    );
    expect(
      projectBudgetBlockers({ policy, maxEstimateUsd: 0.04, projectSpentLast24hUsd: 0.18 })[0]!.message,
    ).toMatch(/Project daily budget reached/);
    expect(projectBudgetBlockers({ policy, maxEstimateUsd: null, projectSpentLast24hUsd: 0 })[0]!.code).toBe(
      "project_budget.unknown_cost",
    );
  });

  it("the automatic deterministic identity is stable, time-free, and changes with any truth", () => {
    const t = {
      attemptId: "a",
      subjectFingerprint: "s",
      criteriaFingerprint: "c",
      referenceFingerprint: "r",
      packageFingerprint: "p",
      rulesVersion: "3a.1",
    };
    const k = deterministicAutomationKey(t);
    expect(k).toHaveLength(64);
    expect(deterministicAutomationKey({ ...t })).toBe(k);
    for (const field of Object.keys(t) as Array<keyof typeof t>)
      expect(deterministicAutomationKey({ ...t, [field]: `${t[field]}-changed` })).not.toBe(k);
  });
});

media("automatic QA over the real service (memory repositories, no provider network)", () => {
  const mock = new MockAnalysisProvider() as ContinuityAnalysisProvider;
  const openaiTransport = new FakeOpenAITransport(openaiAnswerAll("pass"));
  const openai = new OpenAIContinuityAnalyzer({
    config: readOpenAIConfig({
      PRISM_STUDIO_CONTINUITY_ANALYZERS: "openai",
      OPENAI_API_KEY: "sk-test-key-not-real-0000000000",
    }),
    transport: openaiTransport,
  }) as ContinuityAnalysisProvider;
  const availability: AnalyzerAvailability[] = [
    MOCK_OK,
    { id: "openai", usable: true, kind: "model", missingConfig: [] },
  ];

  async function generated(h: Harness) {
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
    return attemptId!;
  }

  const depsOf = (h: Harness, over: Partial<AutoQaDeps> = {}): AutoQaDeps => ({
    processor,
    storage: h.sink,
    qa: h.repo.mediaQa,
    userId: null,
    now: () => h.clock.now,
    providers: new Map([
      [mock.id, mock],
      [openai.id, openai],
    ]),
    availability,
    paid: PAID,
    limits: LIMITS,
    ...over,
  });
  const reconcile = async (
    h: Harness,
    attemptId: string,
    policy: ProjectQaPolicy,
    over: Partial<AutoQaDeps> = {},
  ) =>
    reconcileAttemptQa({
      data: await h.data(),
      view: (await h.repo.generation.getAttemptView(attemptId))!,
      policy,
      deps: depsOf(h, over),
    });
  const runsOf = (h: Harness, attemptId: string) => h.repo.mediaQa.listAttemptRuns(attemptId);
  const jobsOf = (h: Harness, attemptId: string) => h.repo.mediaQa.listAttemptAnalysisJobs(attemptId);

  it("a succeeded attempt gets ONE automatic deterministic run: no analyzer, no cost, no review frames, review untouched", async () => {
    const h = makeHarness();
    const attemptId = await generated(h);
    const before = (await h.data()).assets.length;
    const r = await reconcile(h, attemptId, P());
    expect(r.outcomes).toEqual(["deterministic_created"]);
    const runs = await runsOf(h, attemptId);
    expect(runs).toHaveLength(1);
    const run = runs[0]!.run;
    expect(run).toMatchObject({
      analyzerKind: "deterministic",
      analyzer: "deterministic",
      analysisStatus: "complete",
    });
    expect(run.automationKey).toHaveLength(64);
    expect(run.analysisPlan).toBeNull();
    expect(await h.repo.mediaQa.listAnalysisCosts(run.id)).toEqual([]);
    expect(await jobsOf(h, attemptId)).toEqual([]);
    // no frames / contact sheet were derived just to answer metadata questions
    expect((await h.data()).assets.length).toBe(before);
    expect(
      (await h.repo.mediaQa.listAttemptDerivations(attemptId)).filter(
        (d) => d.derivation.operation !== "conform",
      ),
    ).toEqual([]);
    // semantic criteria are honestly unchecked; Shot QA reads the run
    const inputs = computeQaInputs({
      data: await h.data(),
      view: (await h.repo.generation.getAttemptView(attemptId))!,
      delivery: null,
      now: h.clock.now,
    });
    const projected = projectRun(runs[0]!, inputs);
    expect(projected.freshness?.stale).toBe(false);
    expect(projected.assessment.state).not.toBe("no_qa");
    const attempt = (await h.repo.generation.getAttemptView(attemptId))!.attempt;
    expect(attempt).toMatchObject({ reviewStatus: "unreviewed", approved: false });

    // repeated reconciliation of the same truth: nothing new
    expect((await reconcile(h, attemptId, P())).outcomes).toEqual(["already_current"]);
    expect(await runsOf(h, attemptId)).toHaveLength(1);
  });

  it("concurrent reconciliations of the same truth create exactly one automatic run", async () => {
    const h = makeHarness();
    const attemptId = await generated(h);
    const results = await Promise.all([1, 2, 3].map(() => reconcile(h, attemptId, P())));
    expect(await runsOf(h, attemptId)).toHaveLength(1);
    expect(results.filter((r) => r.outcomes.includes("deterministic_created"))).toHaveLength(1);
    expect(
      results.every(
        (r) => r.outcomes.includes("deterministic_created") || r.outcomes.includes("already_current"),
      ),
    ).toBe(true);
  });

  it("a person can still re-run manually for the same truth (manual runs carry no automation key)", async () => {
    const h = makeHarness();
    const attemptId = await generated(h);
    await reconcile(h, attemptId, P());
    const data = await h.data();
    const view = (await h.repo.generation.getAttemptView(attemptId))!;
    const inputs = computeQaInputs({ data, view, delivery: null, now: h.clock.now })!;
    const manual = await runContinuityReview({ inputs, view, deps: { ...depsOf(h), analyzer: null } });
    expect(manual.run.automationKey).toBeNull();
    expect(await runsOf(h, attemptId)).toHaveLength(2);
    // and the automatic identity is still satisfied
    expect((await reconcile(h, attemptId, P())).outcomes).toEqual(["already_current"]);
  });

  it("a new delivery master stales the old run and reconciliation establishes QA for the new subject, once", async () => {
    const h = makeHarness();
    const attemptId = await generated(h);
    await reconcile(h, attemptId, P());
    const view = (await h.repo.generation.getAttemptView(attemptId))!;
    const original = view.outputs.find((o) => o.output.role === "primary")!.asset;
    await conformAttemptOutput({
      attemptId,
      attemptLabel: "3A-a1",
      original,
      plan: parseAdaptationPlan(view.attempt.adaptationPlan)!.conform,
      deps: depsOf(h),
    });
    const data = await h.data();
    const delivery = await h.repo.mediaQa.getDelivery(attemptId);
    const now = computeQaInputs({ data, view, delivery, now: h.clock.now });
    const [oldRun] = await runsOf(h, attemptId);
    expect(projectRun(oldRun!, now).freshness!.reasons.join(" ")).toMatch(/delivery conform changed/);

    expect((await reconcile(h, attemptId, P())).outcomes).toEqual(["deterministic_created"]);
    expect((await reconcile(h, attemptId, P())).outcomes).toEqual(["already_current"]);
    const runs = await runsOf(h, attemptId);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.run.subjectAssetId).toBe(delivery!.assetId);
    expect(projectRun(runs[0]!, now).freshness!.stale).toBe(false);
    // the old run is history, untouched
    expect(runs[1]!.run.subjectAssetId).toBe(original.id);
  });

  it("not eligible: a running / failed generation gets no QA run", async () => {
    const h = makeHarness();
    const { attemptId } = await h.submit("3A", "mock-video-169", {
      adaptation: { framing: "overscan_for_crop", duration: "generate_longer_then_trim" },
    });
    const r = await reconcile(h, attemptId!, P());
    expect(r.outcomes).toEqual(["not_eligible"]);
    expect(r.reasons[0]).toMatch(/Only a completed generation/);
    expect(await runsOf(h, attemptId!)).toEqual([]);
  });

  it("suggest: deterministic QA plus a suggestion; zero jobs, zero cost, zero transport calls", async () => {
    const h = makeHarness();
    const attemptId = await generated(h);
    const calls = openaiTransport.calls;
    const r = await reconcile(h, attemptId, P({ semanticMode: "suggest", analyzer: "openai" }));
    expect(r.outcomes).toEqual(["semantic_suggested", "deterministic_created"]);
    expect(await jobsOf(h, attemptId)).toEqual([]);
    expect(openaiTransport.calls).toBe(calls);
  });

  it("automatic (Mock, explicit test policy): ONE semantic job carrying the deterministic findings and a manifest", async () => {
    const h = makeHarness();
    const attemptId = await generated(h);
    const r = await reconcile(h, attemptId, AUTO());
    expect(r.outcomes).toEqual(["semantic_queued"]);
    const jobs = await jobsOf(h, attemptId);
    expect(jobs).toHaveLength(1);
    const runs = await runsOf(h, attemptId);
    expect(runs).toHaveLength(1); // no separate deterministic run for the same truth
    expect(runs[0]!.run.externalManifest).toBeTruthy();
    expect(runs[0]!.findings.some((f) => f.finding.resultSource === "deterministic")).toBe(true);
    // the job's identity is the existing idempotency key with the stable automatic nonce
    const data = await h.data();
    const view = (await h.repo.generation.getAttemptView(attemptId))!;
    const inputs = computeQaInputs({ data, view, delivery: null, now: h.clock.now })!;
    expect(jobs[0]!.idempotencyKey).toBe(analysisIdempotencyKey(inputs, mock, AUTO_SEMANTIC_NONCE));

    // repeated reconciliation: still one job, one run
    expect((await reconcile(h, attemptId, AUTO())).outcomes).toEqual(["semantic_already_queued"]);
    expect(await jobsOf(h, attemptId)).toHaveLength(1);
    expect(await runsOf(h, attemptId)).toHaveLength(1);
    // the read side agrees: nothing is due
    const state = autoQaState({
      data,
      view,
      delivery: null,
      runs: await runsOf(h, attemptId),
      jobs: await jobsOf(h, attemptId),
      policy: AUTO(),
      providers: depsOf(h).providers,
      availability,
    });
    expect(autoQaView(state, AUTO())).toMatchObject({ due: false, deterministic: "covered_by_semantic" });
    expect(autoQaView(state, AUTO()).semantic.state).toBe("queued");

    // a person may still run a manual semantic analysis of the same truth (fresh nonce)
    const manual = await submitAnalysis({
      inputs,
      view,
      assets: data.assets,
      provider: mock,
      policy: PAID,
      deps: depsOf(h),
      acknowledged: true,
      nonce: "manual-1",
      limits: LIMITS,
    });
    expect(manual.duplicate).toBe(false);
    expect(await jobsOf(h, attemptId)).toHaveLength(2);
  });

  it("automatic: changed truth (new delivery master) gets exactly one new semantic job", async () => {
    const h = makeHarness();
    const attemptId = await generated(h);
    await reconcile(h, attemptId, AUTO());
    const view = (await h.repo.generation.getAttemptView(attemptId))!;
    await conformAttemptOutput({
      attemptId,
      attemptLabel: "3A-a1",
      original: view.outputs.find((o) => o.output.role === "primary")!.asset,
      plan: parseAdaptationPlan(view.attempt.adaptationPlan)!.conform,
      deps: depsOf(h),
    });
    expect((await reconcile(h, attemptId, AUTO())).outcomes).toEqual(["semantic_queued"]);
    expect((await reconcile(h, attemptId, AUTO())).outcomes).toEqual(["semantic_already_queued"]);
    expect(await jobsOf(h, attemptId)).toHaveLength(2);
  });

  it("automatic blocked by policy gates → deterministic QA still runs, with the reason; no job, no cost row", async () => {
    for (const [policy, deps, reason] of [
      [AUTO({ externalMediaAllowed: false }), {}, /standing consent/],
      [AUTO({ analyzer: "gemini" }), {}, /not enabled on this server/],
      [
        AUTO({ analyzer: "openai" }),
        { availability: [{ id: "openai", usable: false, kind: "model", missingConfig: ["OPENAI_API_KEY"] }] },
        /missing OPENAI_API_KEY/,
      ],
    ] as Array<[ProjectQaPolicy, Partial<AutoQaDeps>, RegExp]>) {
      const h = makeHarness();
      const attemptId = await generated(h);
      const r = await reconcile(h, attemptId, policy, deps as Partial<AutoQaDeps>);
      expect(r.outcomes).toEqual(["semantic_blocked", "deterministic_created"]);
      expect(r.reasons.join(" ")).toMatch(reason);
      expect(await jobsOf(h, attemptId)).toEqual([]);
    }
  });

  it("automatic paid (OpenAI fake transport): Project per-run / daily ceilings and the global gate all block before any job", async () => {
    const paidPolicy = AUTO({ analyzer: "openai", maxCostPerRunUsd: 0.000001, maxCostPerDayUsd: 1 });
    {
      const h = makeHarness();
      const attemptId = await generated(h);
      const r = await reconcile(h, attemptId, paidPolicy);
      expect(r.outcomes).toEqual(["semantic_blocked", "deterministic_created"]);
      expect(r.reasons.join(" ")).toMatch(/exceeds the Project per-run ceiling/);
      expect(await jobsOf(h, attemptId)).toEqual([]);
    }
    {
      const h = makeHarness();
      const attemptId = await generated(h);
      const r = await reconcile(
        h,
        attemptId,
        AUTO({ analyzer: "openai", maxCostPerRunUsd: 0.5, maxCostPerDayUsd: 0.5 }),
        {
          paid: CLOSED,
        },
      );
      expect(r.outcomes).toEqual(["semantic_blocked", "deterministic_created"]);
      expect(r.reasons.join(" ")).toMatch(/switched off on this server/);
    }
    {
      // a Project ceiling higher than the server's per-run limit never raises it
      const h = makeHarness();
      const attemptId = await generated(h);
      const r = await reconcile(
        h,
        attemptId,
        AUTO({ analyzer: "openai", maxCostPerRunUsd: 5, maxCostPerDayUsd: 10 }),
        {
          paid: { enabled: true, maxUsdPerRun: 0.000001, maxUsdPerDay: 5 },
        },
      );
      expect(r.outcomes).toEqual(["semantic_blocked", "deterministic_created"]);
      expect(r.reasons.join(" ")).toMatch(/per-run analysis limit/);
    }
    {
      // Project daily budget already used
      const h = makeHarness();
      const first = await generated(h);
      const ok = await reconcile(
        h,
        first,
        AUTO({ analyzer: "openai", maxCostPerRunUsd: 0.5, maxCostPerDayUsd: 0.5 }),
      );
      expect(ok.outcomes).toEqual(["semantic_queued"]);
      const spent = await h.repo.mediaQa.analysisSpentSince(null, new Date(0).toISOString());
      expect(spent).toBeGreaterThan(0);
      const second = await generated(h);
      const r = await reconcile(
        h,
        second,
        AUTO({ analyzer: "openai", maxCostPerRunUsd: spent, maxCostPerDayUsd: spent }),
      );
      expect(r.outcomes).toEqual(["semantic_blocked", "deterministic_created"]);
      expect(r.reasons.join(" ")).toMatch(/Project daily budget reached/);
    }
  });

  it("an automatic paid submission records the existing estimate; reconciling never calls the provider itself", async () => {
    const h = makeHarness();
    const attemptId = await generated(h);
    const calls = openaiTransport.calls;
    const r = await reconcile(
      h,
      attemptId,
      AUTO({ analyzer: "openai", maxCostPerRunUsd: 0.5, maxCostPerDayUsd: 1 }),
    );
    expect(r.outcomes).toEqual(["semantic_queued"]);
    const costs = await h.repo.mediaQa.listAnalysisCosts(r.runId!);
    expect(costs.map((c) => c.kind)).toEqual(["estimated"]);
    // execution belongs to the continuity worker: the reconciliation sent nothing
    expect(openaiTransport.calls).toBe(calls);
  });

  it("a QA infrastructure failure is reported, and generation / review stay as they were", async () => {
    const h = makeHarness();
    const attemptId = await generated(h);
    const broken = { ...processor, probe: async () => Promise.reject(new Error("ffmpeg is not installed")) };
    const r = await reconcile(h, attemptId, P(), { processor: broken as unknown as AutoQaDeps["processor"] });
    expect(r.outcomes).toEqual(["failed"]);
    expect(r.reasons[0]).toMatch(/Automatic QA could not run: ffmpeg is not installed/);
    const attempt = (await h.repo.generation.getAttemptView(attemptId))!.attempt;
    expect(attempt).toMatchObject({ status: "succeeded", reviewStatus: "unreviewed" });
    expect(await runsOf(h, attemptId)).toEqual([]);
  });
});
