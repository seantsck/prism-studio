import type { ShotListReview } from "@/domain/story/shot-list-review";
import type { ShotPlan, ShotPlanningContext, ShotPlanScope } from "@/domain/story/shot-list";
import type { StoryUsage } from "@/story/provider";
import type { SpendAuthorization } from "./writing-repository";

/**
 * Phase 5B-S4 persistence for Shot List Proposals (`shot_list_proposals`, migration 0056). One row per IMMUTABLE
 * version per Scene, exactly the S1 rules: frozen input, result written once by the Story worker, review only while
 * ready, applied once. Implementations: shot-list-memory.ts and shot-list-postgres.ts.
 */
export const SHOT_LIST_STATUSES = ["queued", "running", "ready", "failed", "applied"] as const;
export type ShotListStatus = (typeof SHOT_LIST_STATUSES)[number];

export interface ShotListProposal {
  id: string;
  projectId: string;
  episodeId: string;
  sceneId: string;
  version: number;
  parentId: string | null;
  status: ShotListStatus;
  scope: ShotPlanScope;
  basePlan: ShotPlan | null;
  episodeFingerprint: string;
  sceneFingerprint: string;
  baseRevisionId: string | null;
  sceneText: string;
  context: ShotPlanningContext;
  provider: string;
  model: string;
  schemaVersion: string;
  promptVersion: string;
  estimate: { inputTokens: number; maxOutputTokens: number; usd: number };
  confirmedUsd: number | null;
  spendAuthorization: SpendAuthorization;
  plan: ShotPlan | null;
  usage: StoryUsage | null;
  actualUsd: number | null;
  providerCalls: number;
  error: { code: string; message: string } | null;
  review: ShotListReview | null;
  appliedSummary: Record<string, unknown> | null;
  attempts: number;
  nextRunAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
  completedAt: string | null;
  appliedAt: string | null;
}

export type NewShotListProposal = Omit<
  ShotListProposal,
  | "version"
  | "status"
  | "plan"
  | "usage"
  | "actualUsd"
  | "providerCalls"
  | "error"
  | "review"
  | "appliedSummary"
  | "attempts"
  | "nextRunAt"
  | "leaseOwner"
  | "leaseExpiresAt"
  | "completedAt"
  | "appliedAt"
>;

export class ShotListError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "applied" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "ShotListError";
  }
}

export interface ShotListRepository {
  /** Inserts a queued proposal; the version is the Scene's next one. */
  create(input: NewShotListProposal): Promise<ShotListProposal>;
  listForScene(projectId: string, sceneId: string): Promise<ShotListProposal[]>;
  get(projectId: string, id: string): Promise<ShotListProposal | null>;
  saveReview(projectId: string, id: string, review: ShotListReview): Promise<void>;
  markApplied(projectId: string, id: string, summary: Record<string, unknown>, now: string): Promise<void>;
}

export interface ShotListWorkerStore {
  claim(workerId: string, leaseMs: number, now: string): Promise<ShotListProposal | null>;
  expireAbandoned(now: string): Promise<number>;
  complete(
    id: string,
    workerId: string,
    r: { plan: ShotPlan; usage: StoryUsage; actualUsd: number | null; providerCalls: number; now: string },
  ): Promise<void>;
  fail(
    id: string,
    workerId: string,
    r: {
      error: { code: string; message: string };
      usage: StoryUsage | null;
      actualUsd: number | null;
      providerCalls: number;
      now: string;
    },
  ): Promise<void>;
  retryLater(id: string, workerId: string, nextRunAt: string, providerCalls: number): Promise<void>;
}
