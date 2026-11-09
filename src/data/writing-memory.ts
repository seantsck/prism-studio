import { randomUUID } from "node:crypto";
import { MAX_STORY_ATTEMPTS } from "./story-repository";
import {
  WritingError,
  type NewRevision,
  type NewWritingProposal,
  type SceneStoryChange,
  type ScriptRevision,
  type WritingProposal,
  type WritingRepository,
  type WritingSession,
  type WritingWorkerStore,
} from "./writing-repository";
import { sourceFingerprint } from "@/domain/story/source";

/**
 * Phase 5B-S2: in-memory writing sessions, proposals, script revisions and story-change markers (memory/demo mode and
 * tests). Same semantics as Postgres (0055): frozen input, result written once by the worker, decisions final,
 * revisions insert-only. Records are cloned in and out.
 */
const clone = <T>(v: T): T => structuredClone(v);

export class MemoryWritingService implements WritingRepository, WritingWorkerStore {
  private sessions: WritingSession[] = [];
  private proposals: WritingProposal[] = [];
  private revisions: ScriptRevision[] = [];
  private changes: SceneStoryChange[] = [];

  constructor(
    private readonly scope: {
      ownsProject: (projectId: string) => boolean;
      episodeInProject: (projectId: string, episodeId: string) => boolean;
    } = { ownsProject: () => true, episodeInProject: () => true },
  ) {}

  // ── sessions ──
  async createSession(s: Omit<WritingSession, "budgetUsd" | "reservedUsd" | "budgetExpiresAt">) {
    if (!this.scope.ownsProject(s.projectId) || !this.scope.episodeInProject(s.projectId, s.episodeId))
      throw new WritingError("not_found", "That Episode is not in this project.");
    const row: WritingSession = { ...clone(s), budgetUsd: 0, reservedUsd: 0, budgetExpiresAt: null };
    this.sessions.push(row);
    return clone(row);
  }

  async getSession(projectId: string, id: string) {
    const r = this.sessions.find((x) => x.id === id && x.projectId === projectId);
    return r ? clone(r) : null;
  }

  async listSessions(projectId: string, episodeId: string) {
    return this.sessions
      .filter((x) => x.projectId === projectId && x.episodeId === episodeId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async authorizeBudget(projectId: string, sessionId: string, amountUsd: number, expiresAt: string) {
    const s = this.sessions.find((x) => x.id === sessionId && x.projectId === projectId);
    if (!s) throw new WritingError("not_found", "That writing session no longer exists.");
    s.budgetUsd = round6(s.reservedUsd + amountUsd);
    s.budgetExpiresAt = expiresAt;
    return clone(s);
  }

  // ── proposals ──
  async createProposal(p: NewWritingProposal, opts: { reserveUsd: number | null; now: string }) {
    const session = this.sessions.find((x) => x.id === p.sessionId && x.projectId === p.projectId);
    if (!session || session.episodeId !== p.episodeId)
      throw new WritingError("not_found", "That writing session is not of this Episode.");
    if (p.parentId && !this.proposals.some((x) => x.id === p.parentId && x.sessionId === p.sessionId))
      throw new WritingError("invalid", "The revised proposal is not in this session.");
    if (opts.reserveUsd != null) {
      const live = session.budgetExpiresAt != null && session.budgetExpiresAt > opts.now;
      if (!live || session.reservedUsd + opts.reserveUsd > session.budgetUsd + 1e-9)
        throw new WritingError("budget", "The writing session's spend allowance is used up or expired.");
      session.reservedUsd = round6(session.reservedUsd + opts.reserveUsd);
    }
    const turn =
      this.proposals.filter((x) => x.sessionId === p.sessionId).reduce((m, x) => Math.max(m, x.turn), 0) + 1;
    const row: WritingProposal = {
      ...clone(p),
      turn,
      status: "queued",
      result: null,
      usage: null,
      actualUsd: null,
      providerCalls: 0,
      error: null,
      attempts: 0,
      nextRunAt: p.createdAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      acceptedAlternative: null,
      acceptedRevisionId: null,
      savedAlternatives: [],
      decidedAt: null,
      completedAt: null,
    };
    this.proposals.push(row);
    return clone(row);
  }

  async getProposal(projectId: string, id: string) {
    const r = this.proposals.find((x) => x.id === id && x.projectId === projectId);
    return r ? clone(r) : null;
  }

  async listProposals(projectId: string, sessionId: string) {
    return this.proposals
      .filter((x) => x.projectId === projectId && x.sessionId === sessionId)
      .sort((a, b) => a.turn - b.turn)
      .map(clone);
  }

  private decidable(projectId: string, id: string) {
    const r = this.proposals.find((x) => x.id === id && x.projectId === projectId);
    if (!r) throw new WritingError("not_found", "That proposal no longer exists.");
    if (r.status === "accepted" || r.status === "rejected")
      throw new WritingError("decided", `This proposal was already ${r.status}.`);
    if (r.status !== "ready" || !r.result)
      throw new WritingError("conflict", "This proposal is not ready yet.");
    return r;
  }

  async rejectProposal(projectId: string, id: string, now: string) {
    const r = this.decidable(projectId, id);
    r.status = "rejected";
    r.decidedAt = now;
  }

  async saveAlternative(projectId: string, id: string, index: number) {
    const r = this.proposals.find((x) => x.id === id && x.projectId === projectId);
    if (!r) throw new WritingError("not_found", "That proposal no longer exists.");
    if (!r.result || !["ready", "accepted", "rejected"].includes(r.status))
      throw new WritingError("conflict", "This proposal is not ready yet.");
    if (!r.result.alternatives[index]) throw new WritingError("invalid", "That version does not exist.");
    if (!r.savedAlternatives.includes(index)) r.savedAlternatives = [...r.savedAlternatives, index].sort();
  }

  async acceptProposal(projectId: string, id: string, alternative: number, revision: NewRevision) {
    const r = this.decidable(projectId, id);
    if (r.mode === "brainstorm") throw new WritingError("invalid", "A brainstorm has no text to accept.");
    if (!r.result!.alternatives[alternative])
      throw new WritingError("invalid", "That version does not exist.");
    if (r.episodeId !== revision.episodeId)
      throw new WritingError("invalid", "The proposal is of another Episode.");
    const rev = this.insertRevision({ ...revision, writingProposalId: id, alternativeIndex: alternative });
    r.status = "accepted";
    r.acceptedAlternative = alternative;
    r.acceptedRevisionId = rev.id;
    r.decidedAt = revision.createdAt;
    return clone(rev);
  }

  // ── revisions ──
  private insertRevision(n: NewRevision): ScriptRevision {
    if (!this.scope.ownsProject(n.projectId) || !this.scope.episodeInProject(n.projectId, n.episodeId))
      throw new WritingError("not_found", "That Episode is not in this project.");
    if (n.origin === "ai_revision" && (n.writingProposalId == null || n.alternativeIndex == null))
      throw new WritingError("invalid", "An AI revision must come from a proposal.");
    if (
      n.origin === "restore" &&
      !this.revisions.some((x) => x.id === n.restoredFromId && x.episodeId === n.episodeId)
    )
      throw new WritingError("invalid", "The restored revision is not of this Episode.");
    const history = this.revisions
      .filter((x) => x.episodeId === n.episodeId)
      .sort((a, b) => a.number - b.number);
    let parent = history.at(-1) ?? null;
    if (!parent && n.previousText != null && n.origin !== "import") {
      parent = {
        id: randomUUID(),
        projectId: n.projectId,
        episodeId: n.episodeId,
        number: 1,
        origin: "baseline",
        text: n.previousText,
        fingerprint: sourceFingerprint(n.previousText),
        parentRevisionId: null,
        writingProposalId: null,
        alternativeIndex: null,
        storyProposalId: null,
        restoredFromId: null,
        changedRange: null,
        changedSceneIds: [],
        createdBy: n.createdBy,
        createdAt: n.createdAt,
      };
      this.revisions.push(parent);
    }
    const rev: ScriptRevision = {
      id: n.id,
      projectId: n.projectId,
      episodeId: n.episodeId,
      number: (parent?.number ?? 0) + 1,
      origin: n.origin,
      text: n.text,
      fingerprint: n.fingerprint,
      parentRevisionId: parent?.id ?? null,
      writingProposalId: n.writingProposalId ?? null,
      alternativeIndex: n.alternativeIndex ?? null,
      storyProposalId: n.storyProposalId ?? null,
      restoredFromId: n.restoredFromId ?? null,
      changedRange: n.changedRange ?? null,
      changedSceneIds: [...(n.changedSceneIds ?? [])],
      createdBy: n.createdBy,
      createdAt: n.createdAt,
    };
    this.revisions.push(rev);
    for (const sceneId of n.flagSceneIds ?? [])
      this.changes.push({
        sceneId,
        revisionId: rev.id,
        projectId: n.projectId,
        createdAt: n.createdAt,
        reviewedAt: null,
      });
    return rev;
  }

  async recordRevision(n: NewRevision) {
    if (n.origin === "ai_revision")
      throw new WritingError("invalid", "An AI revision is recorded by Accept.");
    return clone(this.insertRevision(n));
  }

  async listRevisions(projectId: string, episodeId: string) {
    return this.revisions
      .filter((x) => x.projectId === projectId && x.episodeId === episodeId)
      .sort((a, b) => b.number - a.number)
      .map(clone);
  }

  async getRevision(projectId: string, id: string) {
    const r = this.revisions.find((x) => x.id === id && x.projectId === projectId);
    return r ? clone(r) : null;
  }

  async openSceneChanges(projectId: string) {
    return this.changes.filter((c) => c.projectId === projectId && !c.reviewedAt).map(clone);
  }

  async markSceneReviewed(projectId: string, sceneId: string, now: string) {
    for (const c of this.changes)
      if (c.projectId === projectId && c.sceneId === sceneId && !c.reviewedAt) c.reviewedAt = now;
  }

  // ── worker path ──
  async claim(workerId: string, leaseMs: number, now: string) {
    const due = this.proposals
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
    for (const r of this.proposals)
      if (r.status === "running" && r.leaseExpiresAt && r.leaseExpiresAt < now) {
        r.status = "failed";
        r.error = {
          code: "ambiguous_interrupted",
          message:
            "Prism AI was interrupted and may have reached the provider; it is not re-sent. Ask again.",
        };
        r.completedAt = now;
        n++;
      }
    return n;
  }

  private owned(id: string, workerId: string) {
    const r = this.proposals.find((x) => x.id === id);
    if (!r || r.status !== "running" || r.leaseOwner !== workerId)
      throw new WritingError("conflict", "The proposal is no longer leased by this worker.");
    return r;
  }

  async complete(id: string, workerId: string, res: Parameters<WritingWorkerStore["complete"]>[2]) {
    const r = this.owned(id, workerId);
    Object.assign(r, {
      status: "ready",
      result: clone(res.result),
      usage: clone(res.usage),
      actualUsd: res.actualUsd,
      providerCalls: r.providerCalls + res.providerCalls,
      completedAt: res.now,
    });
  }

  async fail(id: string, workerId: string, res: Parameters<WritingWorkerStore["fail"]>[2]) {
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

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
