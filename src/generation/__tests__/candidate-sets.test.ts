import { describe, expect, it } from "vitest";
import { rollupSet } from "@/domain/generation/candidates";
import { latestReviews, normalizeReview } from "@/domain/generation/reviews";
import { aggregateByModel } from "@/domain/generation/performance";
import { recommendModels } from "@/domain/generation/recommendation";
import { CandidateError } from "@/data/candidates-repository";
import {
  CandidateSetBlockedError,
  planCandidateSet,
  submitCandidateSet,
  type CandidateSelection,
} from "../candidate-set";
import { makeHarness, type Harness } from "./helpers";

const mock = (modelId: string): CandidateSelection => ({ provider: "mock", modelId });
const FREE = [mock("mock-video-1"), mock("mock-video-lite"), mock("mock-video-169")];

async function drain(h: Harness, rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
}

async function create(h: Harness, selections: CandidateSelection[], over: Record<string, unknown> = {}) {
  const data = await h.data();
  const shotId = data.shots.find((s) => s.shotCode === "3A")!.id;
  return submitCandidateSet({
    data,
    shotId,
    registry: h.registry,
    config: h.config,
    generation: h.repo.generation,
    candidates: h.repo.candidates,
    selections,
    acknowledgeAll: true,
    confirmedTotalUsd: null,
    title: "3A comparison",
    purpose: "model comparison",
    userId: null,
    projectRevision: null,
    now: h.clock.now,
    ...over,
  });
}

describe("candidate set planning", () => {
  it("one shared package, per-model adaptation, a fair-comparison disclosure, no spend for free models", async () => {
    const h = makeHarness();
    const data = await h.data();
    const shotId = data.shots.find((s) => s.shotCode === "3A")!.id;
    const plan = planCandidateSet({
      data,
      shotId,
      registry: h.registry,
      config: h.config,
      selections: FREE,
      outcomes: [],
      now: h.clock.now,
    });
    expect(plan.items.map((i) => i.label)).toEqual(["A", "B", "C"]);
    expect(plan.spend.totalUsd).toBe(0);
    expect(plan.spend.paidCount).toBe(0);
    expect(plan.packageFingerprint).toBeTruthy();
    // the SAME package fingerprint for every candidate
    expect(new Set(plan.items.map((i) => i.evaluation.pkg.provenance.fingerprint)).size).toBe(1);
    // the 5 s-only models need duration adaptation: disclosed, not hidden
    expect(plan.disclosure.same.join(" ")).toMatch(/Production/);
    expect(plan.disclosure.different.join(" ")).toMatch(/Generated duration|Provider ratio/);
    expect(plan.recommendation.engineVersion).toBe("model-routing-v1");
    expect(plan.recommendation.coldStart).toBe(true);
  });

  it("paid candidates need the paid gate, a set ceiling and exact confirmation (server values only)", async () => {
    const paid = {
      PRISM_STUDIO_GENERATION_PROVIDERS: "runway",
      RUNWAYML_API_SECRET: "test-secret-not-real",
      PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
      PRISM_STUDIO_MAX_GENERATION_USD: "5",
      PRISM_STUDIO_MAX_CANDIDATE_SET_USD: "4",
    };
    const h = makeHarness(paid);
    const data = await h.data();
    const shotId = data.shots.find((s) => s.shotCode === "3A")!.id;
    const sel: CandidateSelection[] = [
      { provider: "runway", modelId: "gen4.5" },
      { provider: "runway", modelId: "veo3.1_fast" },
      { provider: "runway", modelId: "seedance2_5" },
    ];
    const plan = planCandidateSet({
      data,
      shotId,
      registry: h.registry,
      config: h.config,
      selections: sel,
      outcomes: [],
      now: h.clock.now,
    });
    expect(plan.spend.paidCount).toBe(3);
    const total = plan.items.reduce((a, i) => a + (i.estimateUsd ?? 0), 0);
    expect(plan.spend.totalUsd).toBeCloseTo(total, 4);
    expect(plan.items.every((i) => i.estimateUsd != null && i.estimateUsd > 0)).toBe(true);

    // no confirmation → refused, nothing created
    await expect(create(h, sel, { confirmedTotalUsd: null })).rejects.toBeInstanceOf(
      CandidateSetBlockedError,
    );
    expect(await h.repo.candidates.listSets((await h.data()).project.id)).toHaveLength(0);
    // wrong confirmation → refused
    await expect(create(h, sel, { confirmedTotalUsd: 0.01 })).rejects.toThrow(/confirm/i);
    // exact confirmation → created; jobs are only QUEUED (no provider is called by submission)
    const ok = await create(h, sel, { confirmedTotalUsd: plan.spend.totalUsd });
    expect(ok.submitted).toBe(3);
    const jobs = await h.repo.generation.listActiveProjectJobs((await h.data()).project.id);
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.status === "queued" && j.providerJobId === null)).toBe(true);
  });

  it("refuses over-ceiling, ceiling-less and gate-closed paid sets before creating anything", async () => {
    const base = {
      PRISM_STUDIO_GENERATION_PROVIDERS: "runway",
      RUNWAYML_API_SECRET: "test-secret-not-real",
      PRISM_STUDIO_ALLOW_PAID_GENERATION: "true",
      PRISM_STUDIO_MAX_GENERATION_USD: "5",
    };
    const sel: CandidateSelection[] = [
      { provider: "runway", modelId: "gen4.5" },
      { provider: "runway", modelId: "veo3.1" },
    ];
    const blockersFor = async (env: Record<string, string>) => {
      const h = makeHarness(env);
      const data = await h.data();
      const shotId = data.shots.find((s) => s.shotCode === "3A")!.id;
      return planCandidateSet({
        data,
        shotId,
        registry: h.registry,
        config: h.config,
        selections: sel,
        outcomes: [],
        now: h.clock.now,
      }).blockers.join(" | ");
    };
    expect(await blockersFor({ ...base, PRISM_STUDIO_MAX_CANDIDATE_SET_USD: "0.5" })).toMatch(
      /exceeds the candidate-set ceiling/,
    );
    expect(await blockersFor({ ...base })).toMatch(/PRISM_STUDIO_MAX_CANDIDATE_SET_USD/);
    expect(
      await blockersFor({
        ...base,
        PRISM_STUDIO_ALLOW_PAID_GENERATION: "false",
        PRISM_STUDIO_MAX_CANDIDATE_SET_USD: "9",
      }),
    ).toMatch(/switched off/);
  });
});

describe("candidate set execution and human review", () => {
  it("each candidate is its own attempt + job and the set survives one failure", async () => {
    const h = makeHarness();
    const out = await create(h, [mock("mock-video-1"), mock("mock-video-169"), mock("mock-video-rejects")]);
    expect(out.submitted).toBe(3);
    const attemptIds = out.view.members.map((m) => m.attemptId!);
    expect(new Set(attemptIds).size).toBe(3);
    await drain(h);
    const statuses = await Promise.all(
      out.view.members.map(
        async (m) => (await h.repo.generation.getAttemptView(m.attemptId!))!.attempt.status,
      ),
    );
    expect(statuses.filter((s) => s === "succeeded")).toHaveLength(2);
    expect(statuses).toContain("failed");
    const roll = rollupSet(
      out.view.members.map((m, i) => ({ submitState: m.submitState, attemptStatus: statuses[i]! })),
    );
    expect(roll.label).toBe("2/3 completed, 1 failed");
    // comparison still works for the successful outputs: a review on a succeeded candidate is accepted
    const ok = out.view.members.find((_, i) => statuses[i] === "succeeded")!;
    const data = await h.data();
    const r = await h.repo.candidates.recordReview({
      projectId: data.project.id,
      attemptId: ok.attemptId!,
      candidateSetId: out.view.set.id,
      ...normalizeReview({
        decision: "approve",
        positiveTags: ["identity_good"],
        negativeTags: [],
        notes: "",
      }),
      reviewer: null,
      now: h.clock.now.toISOString(),
    });
    expect(r.decision).toBe("approve");
  });

  it("reviews are append-only history; the winner must be a member; promotion needs a succeeded attempt and an explicit step", async () => {
    const h = makeHarness();
    const out = await create(h, FREE);
    await drain(h);
    const data = await h.data();
    const [a, b, c] = out.view.members.map((m) => m.attemptId!) as [string, string, string];
    const repo = h.repo.candidates;
    const review = (attemptId: string, decision: "approve" | "shortlist" | "reject", tags: string[] = []) =>
      repo.recordReview({
        projectId: data.project.id,
        attemptId,
        candidateSetId: out.view.set.id,
        ...normalizeReview({
          decision,
          negativeTags: decision === "reject" ? tags : [],
          positiveTags: [],
          notes: "",
        }),
        reviewer: null,
        now: new Date(h.clock.now.getTime() + Math.random() * 1000).toISOString(),
      });
    await review(a, "reject", ["character_identity"]);
    h.clock.advance(5000);
    await review(a, "approve"); // changed mind: a NEW row supersedes, the first stays
    await review(b, "shortlist");
    await review(c, "reject", ["body_motion", "composition"]);
    const hist = await repo.listReviews(data.project.id, { attemptIds: [a] });
    expect(hist).toHaveLength(2);
    expect(latestReviews(hist).get(a)!.decision).toBe("approve");
    expect(hist.find((x) => x.decision === "approve")!.supersedesId).toBe(
      hist.find((x) => x.decision === "reject")!.id,
    );

    // winner: must be a member of THIS set
    await expect(
      repo.setPreferred(
        out.view.set.id,
        "00000000-0000-4000-8000-000000000000",
        null,
        h.clock.now.toISOString(),
      ),
    ).rejects.toBeInstanceOf(CandidateError);
    const marked = await repo.setPreferred(out.view.set.id, a, null, h.clock.now.toISOString());
    expect(marked.preferredAttemptId).toBe(a);
    expect(marked.promotedAttemptId).toBeNull(); // best ≠ promoted
    // the shot has NO approved output until the explicit promote step
    const before = (await h.repo.generation.getAttemptView(a))!.attempt;
    expect(before.approved).toBe(false);

    // promote = existing creative approval + recording; losers are preserved
    await h.repo.generation.reviewAttempt(a, {
      status: "approved",
      categories: [],
      reason: "",
      notes: "",
      now: h.clock.now.toISOString(),
    });
    const promoted = await repo.recordPromotion(out.view.set.id, a, null, h.clock.now.toISOString());
    expect(promoted).toMatchObject({ promotedAttemptId: a, status: "decided" });
    const losers = await Promise.all([b, c].map((id) => h.repo.generation.getAttemptView(id)));
    expect(losers.every((v) => v !== null && v.attempt.status === "succeeded")).toBe(true);
    expect((await repo.getSet(out.view.set.id))!.events.map((e) => e.kind)).toEqual([
      "created",
      "preferred_set",
      "promoted",
    ]);
  });

  it("builds model performance and a data-backed recommendation from real review outcomes", async () => {
    const h = makeHarness();
    const out = await create(h, FREE);
    await drain(h);
    const data = await h.data();
    const repo = h.repo.candidates;
    const byModel = Object.fromEntries(out.view.members.map((m) => [m.model, m.attemptId!]));
    const rec = (attemptId: string, decision: "approve" | "reject") =>
      repo.recordReview({
        projectId: data.project.id,
        attemptId,
        candidateSetId: out.view.set.id,
        ...normalizeReview({
          decision,
          negativeTags: decision === "reject" ? ["character_identity"] : [],
          positiveTags: [],
          notes: "",
        }),
        reviewer: null,
        now: h.clock.now.toISOString(),
      });
    await rec(byModel["mock-video-1"]!, "approve");
    await rec(byModel["mock-video-lite"]!, "reject");
    await rec(byModel["mock-video-169"]!, "reject");
    await repo.setPreferred(out.view.set.id, byModel["mock-video-1"]!, null, h.clock.now.toISOString());

    const all = await repo.listOutcomeRecords(data.project.id);
    const mine = new Set(Object.values(byModel));
    // the seeded project already holds standalone attempts: they stay in history, unreviewed
    expect(all.length).toBeGreaterThan(3);
    const outcomes = all.filter((o) => mine.has(o.attemptId));
    expect(outcomes).toHaveLength(3);
    const perf = Object.fromEntries(aggregateByModel(outcomes).map((p) => [p.model, p]));
    expect(perf["mock-video-1"]).toMatchObject({
      reviewed: 1,
      approved: 1,
      preferredWins: 1,
      inCandidateSets: 1,
    });
    expect(perf["mock-video-lite"]).toMatchObject({ rejected: 1 });
    expect(perf["mock-video-lite"]!.topRejectionReasons[0]).toEqual({ tag: "character_identity", count: 1 });
    expect(outcomes.every((o) => o.profile !== null)).toBe(true);

    // a fresh plan now has human history behind it (still small: honest about it)
    const shotId = data.shots.find((s) => s.shotCode === "3A")!.id;
    const plan = planCandidateSet({
      data,
      shotId,
      registry: h.registry,
      config: h.config,
      selections: FREE,
      outcomes,
      now: h.clock.now,
    });
    const top = plan.recommendation.models.find((m) => m.modelId === "mock-video-1")!;
    expect(top.sample.similar).toBeGreaterThan(0);
    expect(top.why.join(" ")).toMatch(/liked on similar/);
    // three similar reviews are right at the cold-start threshold: the note says how much history there is
    expect(plan.recommendation.historyNote).toMatch(/human-reviewed|Not enough Prism history/);
    expect(recommendModels).toBeTypeOf("function");
  });

  it("existing generations stay valid: an attempt outside any set is simply standalone", async () => {
    const h = makeHarness();
    const solo = await h.submit("3A", "mock-video-1");
    expect(solo.attemptId).toBeTruthy();
    expect(await h.repo.candidates.findSetForAttempt(solo.attemptId!)).toBeNull();
    const data = await h.data();
    const rows = await h.repo.candidates.listOutcomeRecords(data.project.id);
    expect(rows.find((r) => r.attemptId === solo.attemptId)).toMatchObject({
      inCandidateSet: false,
      decision: "unreviewed",
      preferred: false,
    });
  });

  it("a candidate that cannot be submitted is recorded on its member and the others still run", async () => {
    const h = makeHarness();
    const data = await h.data();
    const shotId = data.shots.find((s) => s.shotCode === "3A")!.id;
    const base = {
      data,
      shotId,
      registry: h.registry,
      config: h.config,
      candidates: h.repo.candidates,
      selections: [mock("mock-video-1"), mock("mock-video-169")],
      acknowledgeAll: true,
      confirmedTotalUsd: null,
      title: "",
      purpose: "",
      userId: null,
      projectRevision: null,
      now: h.clock.now,
    };
    // the second submission is made to fail at the repository, mid-set
    let calls = 0;
    const flaky = new Proxy(h.repo.generation, {
      get(target, prop, receiver) {
        if (prop === "createAttemptWithJob") {
          return async (input: Parameters<typeof target.createAttemptWithJob>[0]) => {
            calls += 1;
            if (calls === 2) throw new Error("simulated storage outage");
            return target.createAttemptWithJob(input);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const out = await submitCandidateSet({ ...base, generation: flaky });
    expect(out.submitted).toBe(1);
    expect(out.failed).toEqual([{ label: "B", model: "Mock Video 16:9", error: "simulated storage outage" }]);
    const members = out.view.members;
    expect(members[0]).toMatchObject({ submitState: "submitted" });
    expect(members[1]).toMatchObject({ submitState: "failed", attemptId: null });
    expect(
      rollupSet(
        members.map((m) => ({ submitState: m.submitState, attemptStatus: m.attemptId ? "queued" : null })),
      ).notSubmitted,
    ).toBe(1);
  });
});
