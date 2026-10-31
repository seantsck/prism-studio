import { describe, expect, it } from "vitest";
import { MemoryMediaQaService } from "../media-qa-memory";
import { mapAnalysisJob, mapAttemptAnalysisJob } from "../media-qa-postgres";
import type { AnalysisJob } from "../media-qa-repository";

/**
 * Phase 3A.4C review: an analysis job's subject is discriminated by `subject_kind` (0046). Generic job bookkeeping
 * (lookup, the Project's active jobs, cancellation) sees both kinds; Shot paths (a Shot's history, the current worker
 * claim) see attempt jobs only. No transition job is created by 3A.4C, so the memory cases place one directly.
 */

const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-10-30T12:00:00.000Z";

function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "job-1",
    project_id: PROJECT,
    run_id: "run-1",
    subject_kind: "attempt",
    attempt_id: ATTEMPT,
    analyzer: "mock",
    model: "mock-1",
    status: "queued",
    input_snapshot: {},
    input_asset_ids: [],
    idempotency_key: "k",
    next_run_at: NOW,
    attempt_count: 0,
    max_attempts: 3,
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    heartbeat_at: null,
    provider_state: "none",
    provider_ref: null,
    batches_total: 0,
    batches_done: 0,
    correction_count: 0,
    transport_calls: 0,
    batch_results: [],
    estimated_cost_usd: null,
    actual_cost_usd: null,
    provider_files: [],
    last_error_code: null,
    last_error_category: null,
    last_error_message: "",
    cancel_requested_at: null,
    started_at: null,
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    created_by: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

describe("mapAnalysisJob: the subject comes from subject_kind and fails closed", () => {
  it("maps an attempt row to an attempt job", () => {
    const j = mapAnalysisJob(row({}));
    expect(j.subjectKind).toBe("attempt");
    expect(j.attemptId).toBe(ATTEMPT);
    expect(mapAttemptAnalysisJob(row({})).attemptId).toBe(ATTEMPT);
  });

  it("maps a transition row to a transition job with a null attempt (never the string 'null')", () => {
    const j = mapAnalysisJob(row({ subject_kind: "transition", attempt_id: null }));
    expect(j.subjectKind).toBe("transition");
    expect(j.attemptId).toBeNull();
  });

  it("refuses an attempt row without an attempt", () => {
    expect(() => mapAnalysisJob(row({ attempt_id: null }))).toThrow(/attempt job without an attempt/);
  });

  it("refuses a transition row that names an attempt", () => {
    expect(() => mapAnalysisJob(row({ subject_kind: "transition" }))).toThrow(
      /transition job with an attempt/,
    );
  });

  it("refuses an unknown or missing subject kind (never inferred from attempt_id)", () => {
    expect(() => mapAnalysisJob(row({ subject_kind: "sequence" }))).toThrow(/unknown subject kind/);
    expect(() => mapAnalysisJob(row({ subject_kind: undefined }))).toThrow(/unknown subject kind/);
  });

  it("a Shot path refuses a transition job", () => {
    expect(() => mapAttemptAnalysisJob(row({ subject_kind: "transition", attempt_id: null }))).toThrow(
      /not an attempt job/,
    );
  });
});

type Internals = {
  jobs: Map<string, AnalysisJob>;
  runs: Array<Record<string, unknown>>;
  transitionRuns: Array<Record<string, unknown>>;
  events: Array<{ jobId: string; toStatus: string }>;
};

function memoryWithBothKinds() {
  const qa = new MemoryMediaQaService({ all: () => [] } as never);
  const inner = qa as unknown as Internals;
  const base = mapAnalysisJob(row({}));
  const attemptJob: AnalysisJob = { ...base, id: "job-a", runId: "run-a", idempotencyKey: "ka" };
  const transitionJob: AnalysisJob = {
    ...base,
    id: "job-t",
    runId: "run-t",
    idempotencyKey: "kt",
    subjectKind: "transition",
    attemptId: null,
  };
  inner.jobs.set(attemptJob.id, attemptJob);
  inner.jobs.set(transitionJob.id, transitionJob);
  inner.runs.push({ id: "run-a", projectId: PROJECT, attemptId: ATTEMPT, analysisStatus: "queued" });
  inner.transitionRuns.push({ id: "run-t", projectId: PROJECT, attemptId: null, analysisStatus: "queued" });
  return { qa, inner };
}

describe("memory analysis jobs: generic bookkeeping vs Shot paths", () => {
  it("the Project's active jobs include BOTH kinds (they share maxActivePerProject)", async () => {
    const { qa } = memoryWithBothKinds();
    const active = await qa.listActiveProjectAnalysisJobs(PROJECT);
    expect(active.map((j) => j.subjectKind).sort()).toEqual(["attempt", "transition"]);
  });

  it("a Shot's job history never includes a transition job", async () => {
    const { qa } = memoryWithBothKinds();
    const jobs = await qa.listAttemptAnalysisJobs(ATTEMPT);
    expect(jobs.map((j) => j.id)).toEqual(["job-a"]);
  });

  it("generic lookup returns either kind with its own identity", async () => {
    const { qa } = memoryWithBothKinds();
    expect(await qa.getAnalysisJob("job-t")).toMatchObject({ subjectKind: "transition", attemptId: null });
    expect(await qa.getAnalysisJob("job-a")).toMatchObject({ subjectKind: "attempt", attemptId: ATTEMPT });
  });

  it("cancelling a queued transition job cancels it, fails its run and records the event", async () => {
    const { qa, inner } = memoryWithBothKinds();
    const j = await qa.requestAnalysisCancel("job-t", NOW);
    expect(j).toMatchObject({ status: "cancelled", subjectKind: "transition", attemptId: null });
    expect(inner.transitionRuns[0]).toMatchObject({ analysisStatus: "failed", completedAt: NOW });
    expect(inner.events.filter((e) => e.jobId === "job-t").map((e) => e.toStatus)).toEqual(["cancelled"]);
  });

  it("cancelling a queued attempt job still fails its Shot run (regression)", async () => {
    const { qa, inner } = memoryWithBothKinds();
    expect(await qa.requestAnalysisCancel("job-a", NOW)).toMatchObject({ status: "cancelled" });
    expect(inner.runs[0]).toMatchObject({ analysisStatus: "failed" });
    expect(inner.transitionRuns[0]).toMatchObject({ analysisStatus: "queued" });
  });

  it("a Shot submission counts an active transition job against the shared Project limit", async () => {
    const { qa, inner } = memoryWithBothKinds();
    inner.jobs.delete("job-a");
    const submit = (maxActivePerProject: number) =>
      qa.createAnalysisRunWithJob({
        run: { projectId: PROJECT },
        job: { idempotencyKey: "new" },
        limits: { maxActivePerProject, maxJobAttempts: 3 },
      } as never);
    await expect(submit(1)).rejects.toThrow(/already has 1 analyses in progress \(limit 1\)/);
  });

  it("3A.4D: the mode-aware worker claims BOTH kinds (one shared queue); each keeps its own subject", async () => {
    const { qa } = memoryWithBothKinds();
    const claimed = await qa.claim({ workerId: "w", now: NOW, leaseMs: 1000, limit: 10 });
    expect(claimed.map((c) => [c.job.id, c.job.subjectKind]).sort()).toEqual([
      ["job-a", "attempt"],
      ["job-t", "transition"],
    ]);
  });
});
