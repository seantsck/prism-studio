import { randomUUID } from "node:crypto";
import type {
  CandidateMember,
  CandidateSet,
  CandidateSetEvent,
  CandidateSetStatus,
} from "@/domain/generation/candidates";
import { buildOutcomeRecords, type RawAttemptOutcome } from "@/domain/generation/outcomes";
import type { OutcomeRecord } from "@/domain/generation/performance";
import type { GenerationReview } from "@/domain/generation/reviews";
import type { ProjectData } from "@/domain/schemas";
import {
  CandidateError,
  type CandidateRepository,
  type CandidateSetView,
  type NewCandidateSet,
  type NewReview,
} from "./candidates-repository";
import type { GenerationRepository } from "./generation-repository";
import type { MemoryProjectsAccess } from "./generation-memory";

const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-process candidate-set and review persistence for memory/demo mode and fast tests. Semantics mirror the
 * Postgres implementation and its triggers (winner must be a member, promotion needs a succeeded attempt,
 * reviews append-only, members frozen apart from their attempt link).
 */
export class MemoryCandidateService implements CandidateRepository {
  private sets = new Map<string, CandidateSet>();
  private members = new Map<string, CandidateMember>();
  private events: CandidateSetEvent[] = [];
  private reviews: GenerationReview[] = [];

  constructor(
    private readonly access: MemoryProjectsAccess,
    private readonly generation: GenerationRepository,
  ) {}

  private projectOf(projectId: string): ProjectData | undefined {
    return this.access.all().find((p) => p.project.id === projectId);
  }

  private view(setId: string): CandidateSetView | null {
    const set = this.sets.get(setId);
    if (!set) return null;
    return {
      set: clone(set),
      members: [...this.members.values()]
        .filter((m) => m.candidateSetId === setId)
        .sort((a, b) => a.position - b.position)
        .map(clone),
      events: this.events.filter((e) => e.candidateSetId === setId).map(clone),
    };
  }

  private event(
    set: CandidateSet,
    kind: CandidateSetEvent["kind"],
    payload: Record<string, unknown>,
    actor: string | null,
    at: string,
  ) {
    this.events.push({
      id: randomUUID(),
      candidateSetId: set.id,
      projectId: set.projectId,
      kind,
      payload,
      actor,
      at,
    });
  }

  async createSet(input: NewCandidateSet): Promise<CandidateSetView> {
    if (!this.projectOf(input.projectId))
      throw new CandidateError("not_found", "That project no longer exists.");
    const set: CandidateSet = {
      id: input.id,
      projectId: input.projectId,
      shotId: input.shotId,
      title: input.title,
      purpose: input.purpose,
      status: "open",
      packageFingerprint: input.packageFingerprint,
      estimatedTotalUsd: input.estimatedTotalUsd,
      ceilingUsd: input.ceilingUsd,
      preferredAttemptId: null,
      preferredBy: null,
      preferredAt: null,
      promotedAttemptId: null,
      promotedBy: null,
      promotedAt: null,
      recommendation: input.recommendation ? clone(input.recommendation) : null,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.sets.set(set.id, set);
    for (const m of input.members) {
      const member: CandidateMember = {
        id: randomUUID(),
        candidateSetId: set.id,
        projectId: set.projectId,
        label: m.label,
        position: m.position,
        provider: m.provider,
        model: m.model,
        attemptId: null,
        submitState: "planned",
        submitError: "",
        inputMode: m.inputMode,
        tierId: m.tierId,
        nativeAudio: m.nativeAudio,
        estimateUsd: m.estimateUsd,
        plan: clone(m.plan),
        createdAt: input.now,
      };
      this.members.set(member.id, member);
    }
    this.event(
      set,
      "created",
      { candidates: input.members.length, estimatedTotalUsd: input.estimatedTotalUsd },
      input.createdBy,
      input.now,
    );
    return this.view(set.id)!;
  }

  async getSet(setId: string) {
    return this.view(setId);
  }

  async listSets(projectId: string, opts: { shotId?: string; limit?: number } = {}) {
    return [...this.sets.values()]
      .filter((s) => s.projectId === projectId && (!opts.shotId || s.shotId === opts.shotId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, opts.limit ?? 200)
      .map((s) => this.view(s.id)!);
  }

  async findSetForAttempt(attemptId: string) {
    const m = [...this.members.values()].find((x) => x.attemptId === attemptId);
    return m ? this.view(m.candidateSetId) : null;
  }

  async attachAttempt(memberId: string, attemptId: string) {
    const m = this.members.get(memberId);
    if (!m) throw new CandidateError("not_found", "That candidate no longer exists.");
    if (m.attemptId && m.attemptId !== attemptId)
      throw new CandidateError("invalid", "Candidate already has an attempt.");
    m.attemptId = attemptId;
    m.submitState = "submitted";
    m.submitError = "";
  }

  async markSubmitFailed(memberId: string, error: string) {
    const m = this.members.get(memberId);
    if (!m) throw new CandidateError("not_found", "That candidate no longer exists.");
    if (m.attemptId) throw new CandidateError("invalid", "Candidate already has an attempt.");
    m.submitState = "failed";
    m.submitError = error.slice(0, 500);
  }

  async recordReview(input: NewReview): Promise<GenerationReview> {
    const data = this.projectOf(input.projectId);
    if (!data?.attempts.some((a) => a.id === input.attemptId))
      throw new CandidateError("not_found", "That generation no longer exists.");
    const current = this.reviews
      .filter((r) => r.attemptId === input.attemptId)
      .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))[0];
    const row: GenerationReview = {
      id: randomUUID(),
      projectId: input.projectId,
      attemptId: input.attemptId,
      candidateSetId: input.candidateSetId,
      decision: input.decision,
      positiveTags: [...input.positiveTags],
      negativeTags: [...input.negativeTags],
      notes: input.notes,
      reviewer: input.reviewer,
      reviewedAt: input.now,
      supersedesId: current?.id ?? null,
    };
    this.reviews.push(row);
    return clone(row);
  }

  async listReviews(projectId: string, opts: { attemptIds?: string[] } = {}) {
    const ids = opts.attemptIds ? new Set(opts.attemptIds) : null;
    return this.reviews
      .filter((r) => r.projectId === projectId && (!ids || ids.has(r.attemptId)))
      .sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt) || b.id.localeCompare(a.id))
      .map(clone);
  }

  private mustSet(setId: string): CandidateSet {
    const s = this.sets.get(setId);
    if (!s) throw new CandidateError("not_found", "That candidate set no longer exists.");
    return s;
  }

  private mustMember(setId: string, attemptId: string): CandidateMember {
    const m = [...this.members.values()].find((x) => x.candidateSetId === setId && x.attemptId === attemptId);
    if (!m) throw new CandidateError("not_member", "That generation is not a candidate of this set.");
    return m;
  }

  async setPreferred(setId: string, attemptId: string | null, actor: string | null, now: string) {
    const s = this.mustSet(setId);
    if (attemptId) this.mustMember(setId, attemptId);
    s.preferredAttemptId = attemptId;
    s.preferredBy = attemptId ? actor : null;
    s.preferredAt = attemptId ? now : null;
    s.updatedAt = now;
    this.event(s, attemptId ? "preferred_set" : "preferred_cleared", { attemptId }, actor, now);
    return clone(s);
  }

  async recordPromotion(setId: string, attemptId: string, actor: string | null, now: string) {
    const s = this.mustSet(setId);
    this.mustMember(setId, attemptId);
    const view = await this.generation.getAttemptView(attemptId);
    if (!view || view.attempt.status !== "succeeded")
      throw new CandidateError("not_succeeded", "Only a succeeded generation can be promoted.");
    s.promotedAttemptId = attemptId;
    s.promotedBy = actor;
    s.promotedAt = now;
    s.status = "decided";
    s.updatedAt = now;
    this.event(s, "promoted", { attemptId }, actor, now);
    return clone(s);
  }

  async setStatus(setId: string, status: CandidateSetStatus, actor: string | null, now: string) {
    const s = this.mustSet(setId);
    const from = s.status;
    s.status = status;
    s.updatedAt = now;
    this.event(s, "status_changed", { from, to: status }, actor, now);
    return clone(s);
  }

  async listOutcomeRecords(projectId: string): Promise<OutcomeRecord[]> {
    const data = this.projectOf(projectId);
    if (!data) return [];
    const raw: RawAttemptOutcome[] = [];
    for (const a of data.attempts) {
      const v = await this.generation.getAttemptView(a.id);
      const actual = v?.costs.find((c) => c.kind === "actual");
      const estimate = v?.costs.find((c) => c.kind === "estimated");
      raw.push({
        attemptId: a.id,
        projectId,
        provider: a.provider,
        model: a.model,
        status: a.status,
        packageSnapshot: a.packageSnapshot,
        createdAt: a.createdAt,
        job: v?.job
          ? {
              createdAt: v.job.createdAt,
              submittedAt: v.job.submittedAt,
              completedAt: v.job.completedAt,
              errorCategory: v.job.lastErrorCategory,
            }
          : null,
        actualCostUsd: actual?.amount ?? null,
        estimatedCostUsd: estimate?.amount ?? null,
      });
    }
    const mine = [...this.members.values()].filter((m) => m.projectId === projectId && m.attemptId);
    const memberships = new Map(mine.map((m) => [m.attemptId!, m.candidateSetId] as const));
    const preferred = new Set<string>();
    for (const s of this.sets.values()) {
      if (s.projectId !== projectId) continue;
      if (s.preferredAttemptId) preferred.add(s.preferredAttemptId);
      if (s.promotedAttemptId) preferred.add(s.promotedAttemptId);
    }
    return buildOutcomeRecords({
      attempts: raw,
      reviews: this.reviews.filter((r) => r.projectId === projectId),
      memberships,
      preferredAttemptIds: preferred,
    });
  }
}
