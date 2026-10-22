import { describe, expect, it } from "vitest";
import { describeDims } from "@/components/candidates/output-dims";
import { aggregateByModel, providerReliability } from "@/domain/generation/performance";
import { normalizeReview } from "@/domain/generation/reviews";
import { submitCandidateSet, type CandidateSelection } from "../candidate-set";
import { makeHarness, type Harness } from "./helpers";

async function drain(h: Harness, rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await h.worker().tick(10);
    h.clock.advance(2000);
  }
}
const mock = (modelId: string): CandidateSelection => ({ provider: "mock", modelId });

async function createSet(h: Harness, selections: CandidateSelection[]) {
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
    title: "review paths",
    purpose: "",
    userId: null,
    projectRevision: null,
    now: h.clock.now,
  });
}

const candidateReview = (
  h: Harness,
  projectId: string,
  setId: string,
  attemptId: string,
  decision: "approve" | "reject",
  negativeTags: Parameters<typeof normalizeReview>[0]["negativeTags"] = [],
) =>
  h.repo.candidates.recordReview({
    projectId,
    attemptId,
    candidateSetId: setId,
    ...normalizeReview({ decision, negativeTags, positiveTags: [], notes: "" }),
    reviewer: null,
    now: h.clock.now.toISOString(),
  });

describe("candidate review and final shot approval are different domains", () => {
  it("a final approve/reject of an attempt writes NO candidate review and never sets the preferred candidate", async () => {
    const h = makeHarness();
    const out = await createSet(h, [mock("mock-video-1"), mock("mock-video-lite")]);
    await drain(h);
    const data = await h.data();
    const view = (await h.repo.candidates.getSet(out.view.set.id))!;
    const [a, b] = view.members.map((m) => m.attemptId!);

    // what the operator did by mistake: "Approve" / "Reject" on the attempt card (legacy vocabulary)
    await h.repo.generation.reviewAttempt(a!, {
      status: "approved",
      categories: [],
      reason: "",
      notes: "",
      now: h.clock.now.toISOString(),
    });
    await h.repo.generation.reviewAttempt(b!, {
      status: "rejected",
      categories: ["bad_motion"],
      reason: "",
      notes: "",
      now: h.clock.now.toISOString(),
    });

    expect(await h.repo.candidates.listReviews(data.project.id)).toEqual([]);
    expect((await h.repo.candidates.getSet(view.set.id))!.set.preferredAttemptId).toBeNull();
    const rows = await h.repo.candidates.listOutcomeRecords(data.project.id);
    // no candidate-review signal: a final approval is not model-quality history
    expect(rows.every((r) => r.decision === "unreviewed")).toBe(true);
  });

  it("a candidate review (Good / Reject / Best) never changes the attempt's final shot approval", async () => {
    const h = makeHarness();
    const out = await createSet(h, [mock("mock-video-1"), mock("mock-video-lite")]);
    await drain(h);
    const data = await h.data();
    const view = (await h.repo.candidates.getSet(out.view.set.id))!;
    const [a, b] = view.members.map((m) => m.attemptId!);
    await candidateReview(h, data.project.id, view.set.id, a!, "approve");
    await candidateReview(h, data.project.id, view.set.id, b!, "reject", ["composition", "camera_motion"]);
    await h.repo.candidates.setPreferred(view.set.id, a!, null, h.clock.now.toISOString());

    for (const id of [a!, b!]) {
      const att = (await h.repo.generation.getAttemptView(id))!.attempt;
      expect(att.reviewStatus).toBe("unreviewed");
      expect(att.approved).toBe(false);
    }
    const rows = await h.repo.candidates.listOutcomeRecords(data.project.id);
    expect(rows.find((r) => r.attemptId === b)).toMatchObject({
      decision: "reject",
      negativeTags: ["composition", "camera_motion"],
    });
  });

  it("there is exactly one preferred candidate: choosing another replaces it", async () => {
    const h = makeHarness();
    const out = await createSet(h, [mock("mock-video-1"), mock("mock-video-lite")]);
    await drain(h);
    const view = (await h.repo.candidates.getSet(out.view.set.id))!;
    const [a, b] = view.members.map((m) => m.attemptId!);
    await h.repo.candidates.setPreferred(view.set.id, a!, null, h.clock.now.toISOString());
    await h.repo.candidates.setPreferred(view.set.id, b!, null, h.clock.now.toISOString());
    const after = (await h.repo.candidates.getSet(view.set.id))!;
    expect(after.set.preferredAttemptId).toBe(b);
    const data = await h.data();
    const preferred = (await h.repo.candidates.listOutcomeRecords(data.project.id)).filter(
      (r) => r.preferred,
    );
    expect(preferred.map((r) => r.attemptId)).toEqual([b]);
  });
});

describe("benchmark reviews are kept but never become production history", () => {
  it("rejects with reasons persist and show in benchmark scope; production scope has no reviewed history", async () => {
    const h = makeHarness();
    const base = await h.data();
    await h.repo.updateProject({ ...base.project, purpose: "benchmark" });
    const out = await createSet(h, [mock("mock-video-1"), mock("mock-video-lite")]);
    await drain(h);
    const data = await h.data();
    const view = (await h.repo.candidates.getSet(out.view.set.id))!;
    const [a, b] = view.members.map((m) => m.attemptId!);
    await candidateReview(h, data.project.id, view.set.id, a!, "approve");
    await candidateReview(h, data.project.id, view.set.id, b!, "reject", [
      "visual_artifacts",
      "prompt_adherence",
    ]);
    await h.repo.candidates.setPreferred(view.set.id, a!, null, h.clock.now.toISOString());

    const rows = await h.repo.candidates.listOutcomeRecords(data.project.id);
    expect(rows.every((r) => r.benchmark)).toBe(true);
    expect(aggregateByModel(rows).filter((p) => p.reviewed > 0)).toEqual([]);
    const bench = aggregateByModel(rows, "benchmark");
    expect(bench.reduce((n, p) => n + p.rejected, 0)).toBe(1);
    expect(bench.reduce((n, p) => n + p.preferredWins, 0)).toBe(1);
    // operational reliability is still recorded, in its own scope, and is not creative history
    const mine = rows.filter((r) => r.attemptId === a || r.attemptId === b);
    expect(providerReliability(mine, "benchmark").reduce((n, r) => n + r.succeeded, 0)).toBe(2);
    expect(providerReliability(mine)).toEqual([]);
  });
});

describe("candidate picture-size semantics", () => {
  const base = { deliveryResolution: null, deliveryNote: "provider original", planningCanvas: null };
  const sent = (canvas: string | null, ratioLabel: string | null = null, tier: string | null = null) => ({
    canvas,
    ratioLabel,
    tier,
  });

  it("shows the recorded provider-file size, never the request", () => {
    const t = describeDims({
      ...base,
      recorded: "1280x720",
      measured: "1344x768",
      requested: sent("1280×720"),
    });
    expect(t.actualOutput).toBe("1280x720");
    expect(t.providerCanvas).toBe("1280×720");
  });

  it("Hailuo case: an aspect label and a tier were sent (no pixels), and the size read from the file is shown", () => {
    const t = describeDims({
      ...base,
      recorded: null,
      measured: "1344x768",
      requested: sent(null, "16:9", "768p"),
    });
    expect(t.actualOutput).toBe("1344x768 (read from the file)");
    expect(t.providerCanvas).toBe("16:9 at the 768p tier (aspect sent, no pixel canvas)");
    expect(t.providerCanvas).not.toMatch(/d+×d+/); // no manufactured pixel size
  });

  it("is honest when nothing is known (no invented numbers, no blank dash)", () => {
    const t = describeDims({ ...base, recorded: null, measured: null, requested: null });
    expect(t.actualOutput).toMatch(/^unknown/);
    expect(t.providerCanvas).toMatch(/^unknown/);
  });

  it("delivery is reported separately and only carries a size when it differs from the original", () => {
    const t = describeDims({
      recorded: "1344x768",
      measured: null,
      requested: null,
      planningCanvas: null,
      deliveryResolution: "1280x720",
      deliveryNote: "conformed master",
    });
    expect(t.delivery).toBe("conformed master · 1280x720");
    expect(t.actualOutput).toBe("1344x768");
  });
});
