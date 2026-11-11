import {
  MAX_STORY_ATTEMPTS,
  StoryProposalError,
  type NewStoryProposal,
  type StoryProposalRecord,
  type StoryProposalRepository,
  type StoryWorkerStore,
} from "./story-repository";

/**
 * Phase 5B-S1: in-memory Production Proposals (memory/demo mode and tests). Same semantics as Postgres: immutable
 * input and result, review only while ready, applied once, never a rewrite in place. Records are cloned in and out.
 */
const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStoryService implements StoryProposalRepository, StoryWorkerStore {
  private rows: StoryProposalRecord[] = [];

  constructor(private readonly ownsProject: (projectId: string) => boolean = () => true) {}

  async create(input: NewStoryProposal): Promise<StoryProposalRecord> {
    if (!this.ownsProject(input.projectId))
      throw new StoryProposalError("not_found", "That project no longer exists.");
    if (input.parentId && !this.rows.some((r) => r.id === input.parentId && r.projectId === input.projectId))
      throw new StoryProposalError("invalid", "The revised proposal is not in this project.");
    const version =
      this.rows.filter((r) => r.projectId === input.projectId).reduce((m, r) => Math.max(m, r.version), 0) +
      1;
    const row: StoryProposalRecord = {
      ...clone(input),
      version,
      status: "queued",
      proposal: null,
      usage: null,
      actualUsd: null,
      providerCalls: 0,
      error: null,
      review: null,
      appliedSummary: null,
      attempts: 0,
      nextRunAt: input.createdAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: null,
      appliedAt: null,
    };
    this.rows.push(row);
    return clone(row);
  }

  async list(projectId: string) {
    return this.rows
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.version - a.version)
      .map(clone);
  }

  async get(projectId: string, id: string) {
    const r = this.rows.find((x) => x.id === id && x.projectId === projectId);
    return r ? clone(r) : null;
  }

  async saveReview(projectId: string, id: string, review: StoryProposalRecord["review"]) {
    const r = this.rows.find((x) => x.id === id && x.projectId === projectId);
    if (!r) throw new StoryProposalError("not_found", "That proposal no longer exists.");
    if (r.status === "applied") throw new StoryProposalError("applied", "This proposal was already applied.");
    if (r.status !== "ready")
      throw new StoryProposalError("conflict", "This proposal is not ready for review.");
    r.review = clone(review);
  }

  async markApplied(projectId: string, id: string, summary: Record<string, unknown>, now: string) {
    const r = this.rows.find((x) => x.id === id && x.projectId === projectId);
    if (!r) throw new StoryProposalError("not_found", "That proposal no longer exists.");
    if (r.status === "applied") throw new StoryProposalError("applied", "This proposal was already applied.");
    if (r.status !== "ready")
      throw new StoryProposalError("conflict", "This proposal is not ready to apply.");
    r.status = "applied";
    r.appliedSummary = clone(summary);
    r.appliedAt = now;
  }

  async usesAsset(assetId: string) {
    return this.rows.some((r) => r.sourceAssetId === assetId);
  }

  // ── worker path ──
  async claim(workerId: string, leaseMs: number, now: string) {
    const due = this.rows
      .filter((r) => r.status === "queued" && r.nextRunAt <= now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!due) return null;
    due.status = "running";
    due.attempts += 1;
    due.leaseOwner = workerId;
    due.leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    return clone(due);
  }

  async expireAbandoned(now: string) {
    let n = 0;
    for (const r of this.rows)
      if (r.status === "running" && r.leaseExpiresAt && r.leaseExpiresAt < now) {
        r.status = "failed";
        r.error = {
          code: "ambiguous_interrupted",
          message:
            "The analysis was interrupted and may have reached the provider; it is not re-sent. Start it again.",
        };
        r.completedAt = now;
        n++;
      }
    return n;
  }

  private owned(id: string, workerId: string) {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.status !== "running" || r.leaseOwner !== workerId)
      throw new StoryProposalError("conflict", "The proposal is no longer leased by this worker.");
    return r;
  }

  async complete(id: string, workerId: string, res: Parameters<StoryWorkerStore["complete"]>[2]) {
    const r = this.owned(id, workerId);
    Object.assign(r, {
      status: "ready",
      proposal: clone(res.proposal),
      usage: clone(res.usage),
      actualUsd: res.actualUsd,
      providerCalls: r.providerCalls + res.providerCalls,
      completedAt: res.now,
    });
  }

  async fail(id: string, workerId: string, res: Parameters<StoryWorkerStore["fail"]>[2]) {
    const r = this.owned(id, workerId);
    Object.assign(r, {
      status: "failed",
      error: clone(res.error),
      usage: clone(res.usage),
      actualUsd: res.actualUsd,
      providerCalls: r.providerCalls + res.providerCalls,
      completedAt: res.now,
    });
  }

  async retryLater(id: string, workerId: string, nextRunAt: string, providerCalls: number) {
    const r = this.owned(id, workerId);
    r.providerCalls += providerCalls;
    if (r.attempts >= MAX_STORY_ATTEMPTS) {
      r.status = "failed";
      r.error = { code: "provider_busy", message: "The provider stayed busy; try again later." };
      r.completedAt = nextRunAt;
    } else {
      r.status = "queued";
      r.nextRunAt = nextRunAt;
    }
    r.leaseOwner = null;
    r.leaseExpiresAt = null;
  }
}
