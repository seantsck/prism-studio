import type { ProductionProposal } from "@/domain/story/proposal";
import type { ProposalReview } from "@/domain/story/review";
import type { PageMap, StorySourceKind } from "@/domain/story/source";
import type { ProposalSection } from "@/story/prompt";
import type { StoryUsage } from "@/story/provider";

/**
 * Phase 5B-S1 persistence for Production Proposals (`story_proposals`, migration 0054). One row per IMMUTABLE proposal
 * version:
 *   - the frozen input (source kind / asset / Episode, fingerprint, the exact analysed text, page map), the provider,
 *     model, schema and prompt versions and the estimate never change after insert;
 *   - the worker writes the result once (proposal, usage, cost, error);
 *   - the creator's review changes only while the proposal is `ready`, and freezes when it is `applied`;
 *   - a revision is a NEW row (version + 1, `parentId` = the revised proposal); nothing is rewritten in place.
 * Implementations: story-memory.ts and story-postgres.ts (same semantics; Postgres also enforces them by trigger).
 */
export const STORY_PROPOSAL_STATUSES = ["queued", "running", "ready", "failed", "applied"] as const;
export type StoryProposalStatus = (typeof STORY_PROPOSAL_STATUSES)[number];

export type ProposalScope = { kind: "full" } | { kind: "section"; section: ProposalSection; note: string };

export interface StorySourceMeta {
  filename: string | null;
  mime: string | null;
  byteSize: number | null;
  checksum: string | null;
  fileKind: string | null;
  pages: PageMap | null;
  lineCount: number;
  chars: number;
}

export interface StoryProposalRecord {
  id: string;
  projectId: string;
  version: number;
  parentId: string | null;
  status: StoryProposalStatus;
  scope: ProposalScope;
  sourceKind: StorySourceKind;
  sourceAssetId: string | null;
  sourceEpisodeId: string | null;
  sourceFingerprint: string;
  sourceMeta: StorySourceMeta;
  inputText: string;
  title: string | null;
  /** A section revision freezes the proposal it revises (the worker reads only this row). Null for a full analysis. */
  baseProposal: ProductionProposal | null;
  provider: string;
  model: string;
  schemaVersion: string;
  promptVersion: string;
  estimate: { inputTokens: number; maxOutputTokens: number; usd: number };
  confirmedUsd: number | null;
  proposal: ProductionProposal | null;
  usage: StoryUsage | null;
  actualUsd: number | null;
  providerCalls: number;
  error: { code: string; message: string } | null;
  review: ProposalReview | null;
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

export type NewStoryProposal = Omit<
  StoryProposalRecord,
  | "version"
  | "status"
  | "proposal"
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

export class StoryProposalError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "applied" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "StoryProposalError";
  }
}

/** The application path (acts as the signed-in user; RLS applies in Postgres). */
export interface StoryProposalRepository {
  /** Inserts a queued proposal; the version is the project's next one. */
  create(input: NewStoryProposal): Promise<StoryProposalRecord>;
  list(projectId: string): Promise<StoryProposalRecord[]>;
  get(projectId: string, id: string): Promise<StoryProposalRecord | null>;
  /** Replaces the review of a READY proposal (compare-and-set on status). */
  saveReview(projectId: string, id: string, review: ProposalReview): Promise<void>;
  /** ready → applied, once; freezes the review. */
  markApplied(projectId: string, id: string, summary: Record<string, unknown>, now: string): Promise<void>;
  /** Whether any proposal (of any project the caller owns) uses this Asset as its source. */
  usesAsset(assetId: string): Promise<boolean>;
}

/** The worker path: claim, then write the result ONCE. No access to anything else. */
export interface StoryWorkerStore {
  /** Claims the oldest due queued proposal (status → running, lease). */
  claim(workerId: string, leaseMs: number, now: string): Promise<StoryProposalRecord | null>;
  /**
   * A running proposal whose lease expired: the worker may have called the provider. Never re-sent (ambiguous): these
   * are failed with `ambiguous_interrupted`.
   */
  expireAbandoned(now: string): Promise<number>;
  complete(
    id: string,
    workerId: string,
    result: {
      proposal: ProductionProposal;
      usage: StoryUsage;
      actualUsd: number | null;
      providerCalls: number;
      now: string;
    },
  ): Promise<void>;
  fail(
    id: string,
    workerId: string,
    result: {
      error: { code: string; message: string };
      usage: StoryUsage | null;
      actualUsd: number | null;
      providerCalls: number;
      now: string;
    },
  ): Promise<void>;
  /** A retryable provider error (rate limit / overload): back to queued later; bounded by attempts. */
  retryLater(id: string, workerId: string, nextRunAt: string, providerCalls: number): Promise<void>;
}

export const MAX_STORY_ATTEMPTS = 3;
