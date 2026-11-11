import type { RevisionOrigin } from "@/domain/story/revisions";
import type { WritingMode, WritingResult, WritingScope } from "@/domain/story/writing";
import type { WritingContext } from "@/story/writing-prompt";
import type { StoryUsage } from "@/story/provider";

/**
 * Phase 5B-S2 persistence for the AI writing assistant (migration 0055). Implementations: writing-memory.ts and
 * writing-postgres.ts (same semantics; Postgres also enforces them by trigger).
 *
 *   script_revisions     immutable history of an Episode's accepted script text; insert-only
 *   writing_sessions     a writing conversation on an Episode + its optional capped spend authorization
 *   writing_proposals    one row per Prism AI turn: frozen input, result written ONCE by the Story worker, then the
 *                        creator's decision (accept / reject) and bookmarks ("Save as alternate")
 *   scene_story_changes  "Story changed after production breakdown" markers; only reviewed_at changes
 */
export interface ScriptRevision {
  id: string;
  projectId: string;
  episodeId: string;
  number: number;
  origin: RevisionOrigin;
  text: string;
  fingerprint: string;
  parentRevisionId: string | null;
  writingProposalId: string | null;
  alternativeIndex: number | null;
  storyProposalId: string | null;
  restoredFromId: string | null;
  /** The lines this revision wrote (AI revision), in its own text. */
  changedRange: { startLine: number; endLine: number } | null;
  changedSceneIds: string[];
  createdBy: string | null;
  createdAt: string;
}

export interface WritingSession {
  id: string;
  projectId: string;
  episodeId: string;
  title: string;
  budgetUsd: number;
  reservedUsd: number;
  budgetExpiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export const WRITING_STATUSES = ["queued", "running", "ready", "failed", "accepted", "rejected"] as const;
export type WritingStatus = (typeof WRITING_STATUSES)[number];
export type SpendAuthorization = "free" | "confirmed" | "session";

export interface WritingProposal {
  id: string;
  projectId: string;
  sessionId: string;
  episodeId: string;
  turn: number;
  parentId: string | null;
  parentAlternative: number | null;
  mode: WritingMode;
  scope: WritingScope;
  instruction: string;
  alternativesRequested: number;
  baseFingerprint: string;
  baseRevisionId: string | null;
  targetText: string;
  draftText: string | null;
  context: WritingContext;
  provider: string;
  model: string;
  schemaVersion: string;
  promptVersion: string;
  estimate: { inputTokens: number; maxOutputTokens: number; usd: number };
  confirmedUsd: number | null;
  spendAuthorization: SpendAuthorization;
  status: WritingStatus;
  result: WritingResult | null;
  usage: StoryUsage | null;
  actualUsd: number | null;
  providerCalls: number;
  error: { code: string; message: string } | null;
  attempts: number;
  nextRunAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  acceptedAlternative: number | null;
  acceptedRevisionId: string | null;
  savedAlternatives: number[];
  decidedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type NewWritingProposal = Omit<
  WritingProposal,
  | "turn"
  | "status"
  | "result"
  | "usage"
  | "actualUsd"
  | "providerCalls"
  | "error"
  | "attempts"
  | "nextRunAt"
  | "leaseOwner"
  | "leaseExpiresAt"
  | "acceptedAlternative"
  | "acceptedRevisionId"
  | "savedAlternatives"
  | "decidedAt"
  | "completedAt"
>;

export interface NewRevision {
  id: string;
  projectId: string;
  episodeId: string;
  origin: Exclude<RevisionOrigin, "baseline">;
  text: string;
  fingerprint: string;
  /** The canonical text BEFORE this revision: recorded as the baseline revision when the Episode has no history. */
  previousText: string | null;
  writingProposalId?: string | null;
  alternativeIndex?: number | null;
  storyProposalId?: string | null;
  restoredFromId?: string | null;
  changedRange?: { startLine: number; endLine: number } | null;
  changedSceneIds?: string[];
  /** Scenes to flag "Story changed after production breakdown" (a subset of changedSceneIds). */
  flagSceneIds?: string[];
  createdBy: string | null;
  createdAt: string;
}

export interface SceneStoryChange {
  sceneId: string;
  revisionId: string;
  projectId: string;
  createdAt: string;
  reviewedAt: string | null;
}

export class WritingError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "decided" | "budget" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "WritingError";
  }
}

/** The application path (the signed-in user; RLS applies in Postgres). */
export interface WritingRepository {
  createSession(
    s: Omit<WritingSession, "budgetUsd" | "reservedUsd" | "budgetExpiresAt">,
  ): Promise<WritingSession>;
  /**
   * Phase 5B-S4: reserve `usd` of a session's unexpired allowance for ANOTHER Story request (a Shot List) — atomic,
   * never exceeding the allowance; refuses with code `budget`. A failed later insert leaves the reservation counted
   * (conservative: spend can only be over-counted, never under-counted).
   */
  reserveBudget(projectId: string, sessionId: string, usd: number, now: string): Promise<void>;
  getSession(projectId: string, id: string): Promise<WritingSession | null>;
  listSessions(projectId: string, episodeId: string): Promise<WritingSession[]>;
  /** A new capped authorization: budget = already reserved + amount, until `expiresAt`. */
  authorizeBudget(
    projectId: string,
    sessionId: string,
    amountUsd: number,
    expiresAt: string,
  ): Promise<WritingSession>;

  /**
   * Inserts a queued proposal (turn = the session's next). With `reserveUsd`, atomically reserves that much of the
   * session's unexpired budget first, or refuses with code `budget` (nothing is stored).
   */
  createProposal(
    p: NewWritingProposal,
    opts: { reserveUsd: number | null; now: string },
  ): Promise<WritingProposal>;
  getProposal(projectId: string, id: string): Promise<WritingProposal | null>;
  listProposals(projectId: string, sessionId: string): Promise<WritingProposal[]>;
  /** ready → rejected (no screenplay change). */
  rejectProposal(projectId: string, id: string, now: string): Promise<void>;
  /** "Save as alternate": bookmark an alternative (never canon). */
  saveAlternative(projectId: string, id: string, index: number): Promise<void>;
  /**
   * ACCEPT, in one transaction: the baseline revision when the Episode has none, the new `ai_revision`, the scene
   * markers, and ready → accepted on the proposal (compare-and-set). Returns the new revision.
   */
  acceptProposal(
    projectId: string,
    id: string,
    alternative: number,
    revision: NewRevision,
  ): Promise<ScriptRevision>;

  /** A non-AI revision (creator edit, import, restore), with the baseline when the Episode has no history. */
  recordRevision(revision: NewRevision): Promise<ScriptRevision>;
  listRevisions(projectId: string, episodeId: string): Promise<ScriptRevision[]>;
  getRevision(projectId: string, id: string): Promise<ScriptRevision | null>;

  openSceneChanges(projectId: string): Promise<SceneStoryChange[]>;
  markSceneReviewed(projectId: string, sceneId: string, now: string): Promise<void>;
}

/** The worker path: claim, then write the result ONCE. */
export interface WritingWorkerStore {
  claim(workerId: string, leaseMs: number, now: string): Promise<WritingProposal | null>;
  expireAbandoned(now: string): Promise<number>;
  complete(
    id: string,
    workerId: string,
    r: {
      result: WritingResult;
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
