import type { DirectionContext, DirectionReview, ShotDirection } from "@/domain/story/shot-direction";
import type { StoryUsage } from "@/story/provider";
import type { SpendAuthorization } from "./writing-repository";

/**
 * Phase 5B-S5 persistence for Storyboard Direction Proposals (`shot_direction_proposals`, migration 0057). One row per
 * IMMUTABLE version per Shot, exactly the S1 / S4 rules: frozen input, result written once by the Story worker, review
 * only while ready, applied once. Implementations: shot-direction-memory.ts and shot-direction-postgres.ts.
 */
export const SHOT_DIRECTION_STATUSES = ["queued", "running", "ready", "failed", "applied"] as const;
export type ShotDirectionStatus = (typeof SHOT_DIRECTION_STATUSES)[number];

export interface ShotDirectionProposal {
  id: string;
  projectId: string;
  episodeId: string;
  sceneId: string;
  shotId: string;
  version: number;
  parentId: string | null;
  status: ShotDirectionStatus;
  /** The creator's variant note ("more intimate", "make Yumeko feel isolated"); empty for a plain proposal. */
  instruction: string;
  sceneFingerprint: string;
  shotFingerprint: string;
  context: DirectionContext;
  provider: string;
  model: string;
  schemaVersion: string;
  promptVersion: string;
  estimate: { inputTokens: number; maxOutputTokens: number; usd: number };
  confirmedUsd: number | null;
  spendAuthorization: SpendAuthorization;
  direction: ShotDirection | null;
  usage: StoryUsage | null;
  actualUsd: number | null;
  providerCalls: number;
  error: { code: string; message: string } | null;
  review: DirectionReview | null;
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

export type NewShotDirectionProposal = Omit<
  ShotDirectionProposal,
  | "version"
  | "status"
  | "direction"
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

export class ShotDirectionError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "applied" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "ShotDirectionError";
  }
}

export interface ShotDirectionRepository {
  /** Inserts a queued proposal; the version is the Shot's next one. */
  create(input: NewShotDirectionProposal): Promise<ShotDirectionProposal>;
  listForShot(projectId: string, shotId: string): Promise<ShotDirectionProposal[]>;
  /** Every direction of the project (newest version per Shot first) — for "needs review" badges. */
  listForProject(projectId: string): Promise<ShotDirectionProposal[]>;
  get(projectId: string, id: string): Promise<ShotDirectionProposal | null>;
  saveReview(projectId: string, id: string, review: DirectionReview): Promise<void>;
  markApplied(projectId: string, id: string, summary: Record<string, unknown>, now: string): Promise<void>;
}

export interface ShotDirectionWorkerStore {
  claim(workerId: string, leaseMs: number, now: string): Promise<ShotDirectionProposal | null>;
  expireAbandoned(now: string): Promise<number>;
  complete(
    id: string,
    workerId: string,
    r: {
      direction: ShotDirection;
      usage: StoryUsage;
      actualUsd: number | null;
      providerCalls: number;
      now: string;
    },
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
