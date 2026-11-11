import type { ShotListReview } from "@/domain/story/shot-list-review";
import {
  ShotListError,
  type NewShotListProposal,
  type ShotListProposal,
  type ShotListRepository,
  type ShotListWorkerStore,
} from "./shot-list-repository";
import { MAX_STORY_ATTEMPTS } from "./story-repository";

/**
 * Phase 5B-S4: in-memory Shot List Proposals (memory/demo mode and tests). Same semantics as Postgres (0056).
 */
const clone = <T>(v: T): T => structuredClone(v);

export class MemoryShotListService implements ShotListRepository, ShotListWorkerStore {
  private rows: ShotListProposal[] = [];

  constructor(
    private readonly sceneInProject: (
      projectId: string,
      episodeId: string,
      sceneId: string,
    ) => boolean = () => true,
  ) {}

  async create(input: NewShotListProposal) {
    if (!this.sceneInProject(input.projectId, input.episodeId, input.sceneId))
      throw new ShotListError("not_found", "That Scene is not in this project.");
    if (input.parentId && !this.rows.some((r) => r.id === input.parentId && r.sceneId === input.sceneId))
      throw new ShotListError("invalid", "The revised shot list is not of this Scene.");
    if ((input.scope.kind === "shot") !== (input.basePlan != null && input.parentId != null))
      throw new ShotListError("invalid", "A one-Shot regeneration needs the plan it revises.");
    const version =
      this.rows.filter((r) => r.sceneId === input.sceneId).reduce((m, r) => Math.max(m, r.version), 0) + 1;
    const row: ShotListProposal = {
      ...clone(input),
      version,
      status: "queued",
      plan: null,
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

  async listForScene(projectId: string, sceneId: string) {
    return this.rows
      .filter((r) => r.projectId === projectId && r.sceneId === sceneId)
      .sort((a, b) => b.version - a.version)
      .map(clone);
  }

  async get(projectId: string, id: string) {
    const r = this.rows.find((x) => x.id === id && x.projectId === projectId);
    return r ? clone(r) : null;
  }

  private ready(projectId: string, id: string) {
    const r = this.rows.find((x) => x.id === id && x.projectId === projectId);
    if (!r) throw new ShotListError("not_found", "That shot list no longer exists.");
    if (r.status === "applied") throw new ShotListError("applied", "This shot list was already applied.");
    if (r.status !== "ready") throw new ShotListError("conflict", "This shot list is not ready yet.");
    return r;
  }

  async saveReview(projectId: string, id: string, review: ShotListReview) {
    this.ready(projectId, id).review = clone(review);
  }

  async markApplied(projectId: string, id: string, summary: Record<string, unknown>, now: string) {
    const r = this.ready(projectId, id);
    r.status = "applied";
    r.appliedSummary = clone(summary);
    r.appliedAt = now;
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
            "Shot planning was interrupted and may have reached the provider; it is not re-sent. Plan again.",
        };
        r.completedAt = now;
        n++;
      }
    return n;
  }

  private owned(id: string, workerId: string) {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.status !== "running" || r.leaseOwner !== workerId)
      throw new ShotListError("conflict", "The shot list is no longer leased by this worker.");
    return r;
  }

  async complete(id: string, workerId: string, res: Parameters<ShotListWorkerStore["complete"]>[2]) {
    const r = this.owned(id, workerId);
    Object.assign(r, {
      status: "ready",
      plan: clone(res.plan),
      usage: clone(res.usage),
      actualUsd: res.actualUsd,
      providerCalls: r.providerCalls + res.providerCalls,
      completedAt: res.now,
    });
  }

  async fail(id: string, workerId: string, res: Parameters<ShotListWorkerStore["fail"]>[2]) {
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
