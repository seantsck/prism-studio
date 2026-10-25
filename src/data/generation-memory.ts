import { randomUUID } from "node:crypto";
import { fingerprint } from "@/domain/hash";
import { assetSchema, type GenerationAttempt, type ProjectData } from "@/domain/schemas";
import {
  assertTransition,
  ACTIVE_STATUSES,
  WORKABLE_STATUSES,
  isTerminal,
} from "@/domain/generation/job-state";
import { attemptStatusForJob } from "@/domain/generation/job-state-mirror";
import { isShotOutputAttempt } from "@/domain/generation/schemas";
import type {
  GenerationCost,
  GenerationEvent,
  GenerationJob,
  GenerationOutput,
} from "@/domain/generation/schemas";
import {
  GenerationSubmitError,
  STALE_ANIMATION_SOURCE_MESSAGE,
  NOT_SHOT_OUTPUT_APPROVAL_MESSAGE,
  LeaseLostError,
  type AttemptView,
  type ClaimedJob,
  type CreateAttemptInput,
  type FinalizeSuccess,
  type GenerationFilters,
  type GenerationRepository,
  type GenerationStore,
  type JobPatch,
  type ProjectGenerationRow,
  type ReviewInput,
} from "./generation-repository";

/** Live access to the memory repository's projects (references, not clones). */
export interface MemoryProjectsAccess {
  all(): ProjectData[];
  ownerUserId(): string;
  /**
   * Phase 2H: the Shot's currently selected Production Frame id (memory keeps selections in the Production Frame
   * service, outside ProjectData). Missing accessor = no selection, so an animation is refused, never accepted.
   */
  selectedProductionFrameId?(projectId: string, shotId: string): string | null;
}

const clone = <T>(v: T): T => structuredClone(v);
const ms = (iso: string) => Date.parse(iso);

/**
 * In-process generation persistence for memory/demo mode and fast worker tests. Semantics intentionally
 * mirror the Postgres implementation (same checks, same transitions, same lease rules).
 */
export class MemoryGenerationService implements GenerationRepository, GenerationStore {
  private jobs = new Map<string, GenerationJob>();
  private outputs: GenerationOutput[] = [];
  private costs: GenerationCost[] = [];
  private events: GenerationEvent[] = [];

  constructor(private readonly access: MemoryProjectsAccess) {}

  // ── lookup helpers ──
  private findAttempt(attemptId: string): { project: ProjectData; attempt: GenerationAttempt } | null {
    for (const project of this.access.all()) {
      const attempt = project.attempts.find((a) => a.id === attemptId);
      if (attempt) return { project, attempt };
    }
    return null;
  }

  private projectOf(projectId: string): ProjectData | undefined {
    return this.access.all().find((p) => p.project.id === projectId);
  }

  private addEvent(job: GenerationJob, from: string | null, to: string, note: string, at: string) {
    this.events.push({
      id: randomUUID(),
      projectId: job.projectId,
      jobId: job.id,
      attemptId: job.attemptId,
      at,
      fromStatus: from,
      toStatus: to,
      note,
    });
  }

  // ───────────────────────── GenerationRepository ─────────────────────────

  /** Package inputs only: generation history and generated outputs are not inputs (mirrors Postgres). */
  private revisionOf(data: ProjectData): string {
    return fingerprint({
      ...data,
      attempts: [],
      continuityChecks: [],
      assets: data.assets.filter((a) => a.purpose !== "generation_output"),
    });
  }

  async projectRevision(slug: string) {
    const found = this.access.all().find((p) => p.project.slug === slug);
    return found ? { projectId: found.project.id, revision: this.revisionOf(found) } : null;
  }

  async createAttemptWithJob(input: CreateAttemptInput) {
    const found = this.projectOf(input.attempt.projectId);
    if (!found) throw new GenerationSubmitError("not_found", "That project no longer exists.");
    const shot = found.shots.find((s) => s.id === input.attempt.shotId);
    if (!shot) throw new GenerationSubmitError("not_found", "That shot no longer exists.");

    // Idempotent replay of the same submit (double click, retried request).
    const replay = [...this.jobs.values()].find(
      (j) => j.projectId === found.project.id && j.idempotencyKey === input.job.idempotencyKey,
    );
    if (replay) {
      const attempt = this.findAttempt(replay.attemptId)!.attempt;
      return { attempt: clone(attempt), job: clone(replay), duplicate: true };
    }

    if (shot.updatedAt !== input.expectedShotUpdatedAt) {
      throw new GenerationSubmitError(
        "stale_shot",
        "This shot changed while you were preparing the generation. Review it and try again.",
      );
    }

    // same acceptance rule as the Postgres row-locked check (memory methods run without interleaving)
    if (
      input.expectedAnimationProductionFrameId &&
      (this.access.selectedProductionFrameId?.(found.project.id, shot.id) ?? null) !==
        input.expectedAnimationProductionFrameId
    ) {
      throw new GenerationSubmitError("stale_animation_source", STALE_ANIMATION_SOURCE_MESSAGE);
    }

    if (input.expectedProjectRevision !== null && this.revisionOf(found) !== input.expectedProjectRevision) {
      throw new GenerationSubmitError(
        "stale_package",
        "Something this shot depends on changed while you were preparing the generation. Review the shot and try again.",
      );
    }

    const shotAttemptIds = new Set(found.attempts.filter((a) => a.shotId === shot.id).map((a) => a.id));
    const active = [...this.jobs.values()].filter(
      (j) => j.projectId === found.project.id && ACTIVE_STATUSES.includes(j.status),
    );
    if (!input.allowConcurrentOnShot && active.some((j) => shotAttemptIds.has(j.attemptId))) {
      throw new GenerationSubmitError(
        "duplicate_active",
        "A generation for this shot is already in progress. Wait for it to finish or cancel it first.",
      );
    }
    if (active.length >= input.limits.maxActivePerProject) {
      throw new GenerationSubmitError(
        "project_busy",
        `This project already has ${active.length} active generations (limit ${input.limits.maxActivePerProject}).`,
      );
    }
    const since = ms(input.now) - 60_000;
    const recent = found.attempts.filter(
      (a) => a.createdBy === input.attempt.createdBy && ms(a.createdAt) >= since,
    ).length;
    if (recent >= input.limits.maxSubmitsPerMinutePerUser) {
      throw new GenerationSubmitError(
        "throttled",
        "You are submitting generations too quickly. Wait a moment and try again.",
      );
    }

    const attemptNumber =
      found.attempts.filter((a) => a.shotId === shot.id).reduce((m, a) => Math.max(m, a.attemptNumber), 0) +
      1;
    const attempt: GenerationAttempt = { ...clone(input.attempt), attemptNumber, status: "queued" };
    found.attempts.push(attempt);

    const job: GenerationJob = {
      id: input.job.id,
      projectId: found.project.id,
      attemptId: attempt.id,
      provider: attempt.provider,
      model: attempt.model,
      status: "queued",
      providerJobId: null,
      providerStatus: "",
      idempotencyKey: input.job.idempotencyKey,
      queuePriority: input.job.queuePriority,
      attemptCount: 0,
      maxAttempts: input.job.maxAttempts,
      pollCount: 0,
      nextRunAt: input.now,
      submittedAt: null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      cancelRequestedAt: null,
      cancelOutcome: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      lastPolledAt: null,
      lastErrorCode: null,
      lastErrorCategory: null,
      lastErrorMessage: "",
      estimatedCost: input.estimate.amount,
      actualCost: null,
      currency: input.job.currency,
      createdBy: attempt.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.jobs.set(job.id, job);
    this.costs.push({
      id: randomUUID(),
      projectId: found.project.id,
      attemptId: attempt.id,
      jobId: job.id,
      provider: attempt.provider,
      model: attempt.model,
      kind: "estimated",
      amount: input.estimate.amount,
      currency: input.estimate.currency,
      basis: input.estimate.basis,
      units: input.estimate.units,
      recordedAt: input.now,
    });
    this.addEvent(job, null, "queued", "Submitted by user", input.now);
    return { attempt: clone(attempt), job: clone(job), duplicate: false };
  }

  async getJob(jobId: string) {
    const j = this.jobs.get(jobId);
    return j ? clone(j) : null;
  }

  private view(project: ProjectData, attempt: GenerationAttempt): AttemptView {
    const jobs = [...this.jobs.values()]
      .filter((j) => j.attemptId === attempt.id)
      .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    const outputs = this.outputs
      .filter((o) => o.attemptId === attempt.id)
      .sort((a, b) => a.position - b.position)
      .flatMap((o) => {
        const asset = project.assets.find((a) => a.id === o.assetId);
        return asset ? [{ output: clone(o), asset: clone(asset) }] : [];
      });
    return {
      attempt: clone(attempt),
      job: jobs[0] ? clone(jobs[0]) : null,
      outputs,
      costs: this.costs.filter((c) => c.attemptId === attempt.id).map(clone),
    };
  }

  async getAttemptView(attemptId: string) {
    const f = this.findAttempt(attemptId);
    return f ? this.view(f.project, f.attempt) : null;
  }

  async listShotAttempts(shotId: string) {
    return this.access
      .all()
      .flatMap((p) => p.attempts.filter((a) => a.shotId === shotId).map((a) => this.view(p, a)))
      .sort((a, b) => a.attempt.attemptNumber - b.attempt.attemptNumber);
  }

  async listActiveProjectJobs(projectId: string) {
    return [...this.jobs.values()]
      .filter((j) => j.projectId === projectId && !isTerminal(j.status))
      .map(clone);
  }

  async listProjectGenerations(projectId: string, filters: GenerationFilters = {}) {
    const project = this.projectOf(projectId);
    if (!project) return [];
    const rows: ProjectGenerationRow[] = [];
    for (const a of project.attempts) {
      const v = this.view(project, a);
      const estimated = v.costs.find((c) => c.kind === "estimated");
      const final = v.costs.find((c) => c.kind !== "estimated");
      const row: ProjectGenerationRow = {
        attempt: {
          id: a.id,
          shotId: a.shotId,
          attemptNumber: a.attemptNumber,
          provider: a.provider,
          model: a.model,
          status: a.status,
          reviewStatus: a.reviewStatus,
          approved: a.approved,
          rejectionCategories: a.rejectionCategories,
          createdAt: a.createdAt,
          requestModality: a.requestModality,
        },
        job: v.job,
        primaryAssetId: v.outputs.find((o) => o.output.role === "primary")?.asset.id ?? null,
        estimated: estimated?.amount ?? null,
        actual: final?.kind === "actual" ? final.amount : null,
        currency: estimated?.currency ?? final?.currency ?? "USD",
      };
      if (filters.statuses && !(row.job && filters.statuses.includes(row.job.status))) continue;
      if (filters.provider && row.attempt.provider !== filters.provider) continue;
      if (filters.model && row.attempt.model !== filters.model) continue;
      if (filters.review && row.attempt.reviewStatus !== filters.review) continue;
      if (filters.shotIds && !filters.shotIds.includes(row.attempt.shotId)) continue;
      rows.push(row);
    }
    rows.sort((a, b) => ms(b.attempt.createdAt) - ms(a.attempt.createdAt));
    return filters.limit ? rows.slice(0, filters.limit) : rows;
  }

  async listJobEvents(jobId: string) {
    return this.events.filter((e) => e.jobId === jobId).map(clone);
  }

  async requestCancel(jobId: string, now: string) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (isTerminal(job.status) || job.status === "cancel_requested") return clone(job);
    const found = this.findAttempt(job.attemptId);
    if (job.status === "queued") {
      // Never reached a provider: cancel locally, nothing remote to undo.
      this.transition(job, "cancelled", now, "Cancelled before submission");
      job.cancelRequestedAt = now;
      job.cancelledAt = now;
      job.cancelOutcome = "local_only";
      job.leaseOwner = job.leaseToken = job.leaseExpiresAt = null;
      if (found) found.attempt.status = "cancelled";
    } else {
      this.transition(job, "cancel_requested", now, "Cancellation requested by user");
      job.cancelRequestedAt = now;
      job.nextRunAt = now;
      if (found) found.attempt.status = attemptStatusForJob("cancel_requested");
    }
    return clone(job);
  }

  async reviewAttempt(attemptId: string, review: ReviewInput) {
    const f = this.findAttempt(attemptId);
    if (!f) return null;
    if (review.status === "approved") {
      if (f.attempt.status !== "succeeded") {
        throw new Error("Only a completed generation can be approved.");
      }
      if (!isShotOutputAttempt(f.attempt)) throw new Error(NOT_SHOT_OUTPUT_APPROVAL_MESSAGE);
      for (const sibling of f.project.attempts) {
        if (sibling.shotId === f.attempt.shotId && sibling.id !== f.attempt.id && sibling.approved) {
          sibling.approved = false;
          // superseded by the new approval; its history (and any rejection categories) stays intact
          sibling.reviewStatus = "unreviewed";
        }
      }
    }
    f.attempt.reviewStatus = review.status;
    f.attempt.approved = review.status === "approved";
    f.attempt.rejectionCategories = review.status === "rejected" ? review.categories : [];
    f.attempt.rejectionReason = review.status === "rejected" ? review.reason : "";
    f.attempt.notes = review.notes;
    f.attempt.reviewedAt = review.status === "unreviewed" ? null : review.now;
    return clone(f.attempt);
  }

  // ───────────────────────── GenerationStore ─────────────────────────

  private transition(job: GenerationJob, to: GenerationJob["status"], now: string, note: string) {
    assertTransition(job.status, to);
    const from = job.status;
    job.status = to;
    job.updatedAt = now;
    this.addEvent(job, from, to, note, now);
  }

  async claim(opts: {
    workerId: string;
    now: string;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedJob[]> {
    const now = ms(opts.now);
    const due = [...this.jobs.values()]
      .filter(
        (j) =>
          WORKABLE_STATUSES.includes(j.status) &&
          ms(j.nextRunAt) <= now &&
          (!j.leaseToken || (j.leaseExpiresAt != null && ms(j.leaseExpiresAt) <= now)),
      )
      .sort((a, b) => b.queuePriority - a.queuePriority || ms(a.nextRunAt) - ms(b.nextRunAt))
      .slice(0, opts.limit);
    const claimed: ClaimedJob[] = [];
    for (const job of due) {
      const found = this.findAttempt(job.attemptId);
      if (!found) continue;
      job.leaseOwner = opts.workerId;
      job.leaseToken = randomUUID();
      job.leaseExpiresAt = new Date(now + opts.leaseMs).toISOString();
      job.heartbeatAt = opts.now;
      claimed.push({
        job: clone(job),
        attempt: clone(found.attempt),
        ownerUserId: found.project.project.userId,
      });
    }
    return claimed;
  }

  async heartbeat(jobId: string, leaseToken: string, now: string, leaseMs: number) {
    const job = this.jobs.get(jobId);
    if (!job || job.leaseToken !== leaseToken) return false;
    job.heartbeatAt = now;
    job.leaseExpiresAt = new Date(ms(now) + leaseMs).toISOString();
    return true;
  }

  async update(jobId: string, leaseToken: string, patch: JobPatch, now: string) {
    const job = this.jobs.get(jobId);
    if (!job || job.leaseToken !== leaseToken) throw new LeaseLostError(jobId);
    if (patch.status && patch.status !== job.status) {
      this.transition(job, patch.status, now, patch.note ?? "");
      const found = this.findAttempt(job.attemptId);
      if (found) found.attempt.status = attemptStatusForJob(patch.status);
    }
    const set = <K extends keyof GenerationJob>(key: K, value: GenerationJob[K] | undefined) => {
      if (value !== undefined) job[key] = value;
    };
    if (!patch.status && patch.note) this.addEvent(job, job.status, job.status, patch.note, now);
    set("providerJobId", patch.providerJobId);
    set("providerStatus", patch.providerStatus);
    set("nextRunAt", patch.nextRunAt);
    set("attemptCount", patch.attemptCount);
    set("pollCount", patch.pollCount);
    set("submittedAt", patch.submittedAt);
    set("startedAt", patch.startedAt);
    set("completedAt", patch.completedAt);
    set("failedAt", patch.failedAt);
    set("cancelledAt", patch.cancelledAt);
    set("cancelOutcome", patch.cancelOutcome);
    set("lastPolledAt", patch.lastPolledAt);
    set("lastErrorCode", patch.lastErrorCode);
    set("lastErrorCategory", patch.lastErrorCategory);
    set("lastErrorMessage", patch.lastErrorMessage);
    set("actualCost", patch.actualCost);
    job.updatedAt = now;
    if (patch.releaseLease || isTerminal(job.status)) {
      job.leaseOwner = job.leaseToken = job.leaseExpiresAt = null;
    }
    return clone(job);
  }

  async finalizeSuccess(input: FinalizeSuccess) {
    const job = this.jobs.get(input.jobId);
    if (!job || job.leaseToken !== input.leaseToken) throw new LeaseLostError(input.jobId);
    const found = this.findAttempt(input.attemptId);
    if (!found) throw new Error("Attempt not found");
    for (const o of input.outputs) {
      const asset = assetSchema.parse(o.asset);
      found.project.assets.push(asset);
      this.outputs.push({
        id: randomUUID(),
        projectId: found.project.project.id,
        attemptId: input.attemptId,
        assetId: asset.id,
        role: o.role,
        position: o.position,
        provenance: o.provenance,
        createdAt: input.now,
      });
    }
    const primary = input.outputs.find((o) => o.role === "primary") ?? input.outputs[0];
    found.attempt.outputAssetId = primary?.asset.id ?? null;
    found.attempt.durationMs = input.durationMs;
    found.attempt.costUsd = input.cost.currency === "USD" ? input.cost.amount : null;
    this.costs.push({
      id: randomUUID(),
      projectId: found.project.project.id,
      attemptId: input.attemptId,
      jobId: job.id,
      provider: job.provider,
      model: job.model,
      kind: input.cost.kind,
      amount: input.cost.amount,
      currency: input.cost.currency,
      basis: input.cost.basis,
      units: input.cost.units,
      recordedAt: input.now,
    });
    this.transition(job, "succeeded", input.now, "Output saved to Prism Storage");
    found.attempt.status = "succeeded";
    job.completedAt = input.now;
    job.providerStatus = input.providerStatus;
    job.actualCost = input.cost.amount;
    job.leaseOwner = job.leaseToken = job.leaseExpiresAt = null;
    return clone(job);
  }

  async findInputAsset(attemptId: string, assetId: string) {
    const found = this.findAttempt(attemptId);
    if (!found || !found.attempt.inputAssetIds.includes(assetId)) return null;
    const a = found.project.assets.find((x) => x.id === assetId);
    if (!a) return null;
    return {
      assetId: a.id,
      objectPath: a.objectPath ?? null,
      bucket: a.bucket ?? null,
      storageProvider: a.storageProvider,
      mime: a.mime ?? null,
      byteSize: a.byteSize ?? null,
      checksum: a.checksum ?? null,
    };
  }

  async countProviderActive(provider: string, model: string) {
    return [...this.jobs.values()].filter(
      (j) =>
        j.provider === provider &&
        j.model === model &&
        (j.status === "submitting" || j.status === "submitted" || j.status === "processing"),
    ).length;
  }

  async recordUnknownCost(args: {
    jobId: string;
    attemptId: string;
    projectId: string;
    provider: string;
    model: string;
    currency: string;
    basis: string;
    now: string;
    amount?: number | null;
  }) {
    if (this.costs.some((c) => c.attemptId === args.attemptId && c.kind !== "estimated")) return;
    const known = args.amount != null;
    this.costs.push({
      id: randomUUID(),
      projectId: args.projectId,
      attemptId: args.attemptId,
      jobId: args.jobId,
      provider: args.provider,
      model: args.model,
      kind: known ? "actual" : "unknown",
      amount: known ? args.amount! : null,
      currency: args.currency,
      basis: args.basis,
      units: null,
      recordedAt: args.now,
    });
  }

  // ── test support ──
  /** Direct read for assertions in unit tests. */
  allJobs(): GenerationJob[] {
    return [...this.jobs.values()].map(clone);
  }
}
