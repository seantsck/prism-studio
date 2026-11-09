import type { DirectionReview } from "@/domain/story/shot-direction";
import {
  ShotDirectionError,
  type NewShotDirectionProposal,
  type ShotDirectionProposal,
  type ShotDirectionRepository,
  type ShotDirectionWorkerStore,
} from "./shot-direction-repository";
import { MAX_STORY_ATTEMPTS } from "./story-repository";

/**
 * Phase 5B-S5: in-memory Storyboard Direction Proposals (memory/demo mode and tests). Same semantics as Postgres (0057).
 */
const clone = <T>(v: T): T => structuredClone(v);

export class MemoryShotDirectionService implements ShotDirectionRepository, ShotDirectionWorkerStore {
  private rows: ShotDirectionProposal[] = [];

  constructor(
    private readonly shotInProject: (projectId: string, sceneId: string, shotId: string) => boolean = () =>
      true,
  ) {}

  async create(input: NewShotDirectionProposal) {
    if (!this.shotInProject(input.projectId, input.sceneId, input.shotId))
      throw new ShotDirectionError("not_found", "That Shot is not in this project.");
    if (input.parentId && !this.rows.some((r) => r.id === input.parentId && r.shotId === input.shotId))
      throw new ShotDirectionError("invalid", "The revised direction is not of this Shot.");
    const version =
      this.rows.filter((r) => r.shotId === input.shotId).reduce((m, r) => Math.max(m, r.version), 0) + 1;
    const row: ShotDirectionProposal = {
      ...clone(input),
      version,
      status: "queued",
      direction: null,
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

  async listForShot(projectId: string, shotId: string) {
    return this.rows
      .filter((r) => r.projectId === projectId && r.shotId === shotId)
      .sort((a, b) => b.version - a.version)
      .map(clone);
  }

  async listForProject(projectId: string) {
    return this.rows
      .filter((r) => r.projectId === projectId)
      .sort((a, b) => b.version - a.version)
      .map(clone);
  }

  async get(projectId: string, id: string) {
    const r = this.rows.find((x) => x.id === id && x.projectId === projectId);
    return r ? clone(r) : null;
  }

  private ready(projectId: string, id: string) {
    const r = this.rows.find((x) => x.id === id && x.projectId === projectId);
    if (!r) throw new ShotDirectionError("not_found", "That direction no longer exists.");
    if (r.status === "applied")
      throw new ShotDirectionError("applied", "This direction was already applied.");
    if (r.status !== "ready") throw new ShotDirectionError("conflict", "This direction is not ready yet.");
    return r;
  }

  async saveReview(projectId: string, id: string, review: DirectionReview) {
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
            "Shot direction was interrupted and may have reached the provider; it is not re-sent. Direct again.",
        };
        r.completedAt = now;
        n++;
      }
    return n;
  }

  private owned(id: string, workerId: string) {
    const r = this.rows.find((x) => x.id === id);
    if (!r || r.status !== "running" || r.leaseOwner !== workerId)
      throw new ShotDirectionError("conflict", "The direction is no longer leased by this worker.");
    return r;
  }

  async complete(id: string, workerId: string, res: Parameters<ShotDirectionWorkerStore["complete"]>[2]) {
    const r = this.owned(id, workerId);
    Object.assign(r, {
      status: "ready",
      direction: clone(res.direction),
      usage: clone(res.usage),
      actualUsd: res.actualUsd,
      providerCalls: r.providerCalls + res.providerCalls,
      completedAt: res.now,
    });
  }

  async fail(id: string, workerId: string, res: Parameters<ShotDirectionWorkerStore["fail"]>[2]) {
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
