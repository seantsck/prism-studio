import type {
  CandidateMember,
  CandidateSet,
  CandidateSetEvent,
  CandidateSetStatus,
} from "@/domain/generation/candidates";
import type { OutcomeRecord } from "@/domain/generation/performance";
import type { GenerationReview, NegativeTag, PositiveTag, ReviewDecision } from "@/domain/generation/reviews";

/**
 * Persistence contract for Phase 2E candidate sets and HUMAN generation reviews. The application path only
 * (acts as the signed-in user; RLS applies in Postgres). Neither worker role has any access: a provider or
 * worker can never write a review, a rejection reason or a winner.
 *
 * Implementations: src/data/candidates-memory.ts and src/data/candidates-postgres.ts.
 */
export class CandidateError extends Error {
  constructor(
    readonly code:
      "not_found" | "not_member" | "not_succeeded" | "already_promoted" | "wrong_project" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "CandidateError";
  }
}

export interface NewCandidateMember {
  label: string;
  position: number;
  provider: string;
  model: string;
  inputMode: "keyframes" | "references" | null;
  tierId: string | null;
  nativeAudio: boolean;
  estimateUsd: number | null;
  plan: Record<string, unknown>;
}

export interface NewCandidateSet {
  id: string;
  projectId: string;
  shotId: string;
  title: string;
  purpose: string;
  packageFingerprint: string;
  estimatedTotalUsd: number | null;
  ceilingUsd: number | null;
  recommendation: Record<string, unknown> | null;
  createdBy: string | null;
  now: string;
  members: NewCandidateMember[];
}

export interface CandidateSetView {
  set: CandidateSet;
  members: CandidateMember[];
  events: CandidateSetEvent[];
}

export interface NewReview {
  projectId: string;
  attemptId: string;
  candidateSetId: string | null;
  decision: ReviewDecision;
  positiveTags: PositiveTag[];
  negativeTags: NegativeTag[];
  notes: string;
  reviewer: string | null;
  now: string;
}

export interface CandidateRepository {
  /** Creates the set and its PLANNED members atomically (no attempt exists yet). */
  createSet(input: NewCandidateSet): Promise<CandidateSetView>;
  getSet(setId: string): Promise<CandidateSetView | null>;
  listSets(projectId: string, opts?: { shotId?: string; limit?: number }): Promise<CandidateSetView[]>;
  /** The set (if any) an attempt belongs to. */
  findSetForAttempt(attemptId: string): Promise<CandidateSetView | null>;
  /** Links a member to the attempt it produced. Once only. */
  attachAttempt(memberId: string, attemptId: string): Promise<void>;
  /** Records that submitting this candidate failed (the set and the other candidates are unaffected). */
  markSubmitFailed(memberId: string, error: string): Promise<void>;
  /** Append-only; supersedes the attempt's current review. */
  recordReview(input: NewReview): Promise<GenerationReview>;
  /** Full history (newest first), optionally for specific attempts. */
  listReviews(projectId: string, opts?: { attemptIds?: string[] }): Promise<GenerationReview[]>;
  /** Marks (or clears, with null) the set's preferred candidate. Does NOT promote anything. */
  setPreferred(
    setId: string,
    attemptId: string | null,
    actor: string | null,
    now: string,
  ): Promise<CandidateSet>;
  /** Records that this member was promoted to the shot (the attempt approval itself is the caller's step). */
  recordPromotion(setId: string, attemptId: string, actor: string | null, now: string): Promise<CandidateSet>;
  setStatus(
    setId: string,
    status: CandidateSetStatus,
    actor: string | null,
    now: string,
  ): Promise<CandidateSet>;
  /** Human outcomes for statistics and recommendations (derived; nothing aggregated is persisted). */
  listOutcomeRecords(projectId: string): Promise<OutcomeRecord[]>;
}
