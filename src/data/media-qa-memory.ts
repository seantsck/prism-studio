import { randomUUID } from "node:crypto";
import { assetSchema, type Asset } from "@/domain/schemas";
import {
  ANALYSIS_ACTIVE,
  assertAnalysisTransition,
  isAnalysisTerminal,
} from "@/domain/continuity/analysis/job-state";
import {
  defaultQaPolicy,
  qaPolicyErrors,
  type ProjectQaPolicy,
  type QaPolicyInput,
} from "@/domain/continuity/automation";
import type { EpisodeEdit } from "@/domain/edit/model";
import type { MemoryProjectsAccess } from "./generation-memory";
import { transitionRunRefusal } from "./transition-runs";
import {
  AnalysisLeaseLostError,
  MediaQaError,
  type AnalysisCost,
  type AnalysisEvent,
  type AnalysisJob,
  type AttemptAnalysisJob,
  type AnalysisJobPatch,
  type AnalysisStatus,
  type AnalysisWorkerStore,
  type ClaimedAnalysisJob,
  type FinalizeAnalysisFailure,
  type FinalizeAnalysisSuccess,
  type InputAssetRef,
  type NewAnalysisRun,
  type AssetDerivation,
  type AttemptDelivery,
  type ContinuityFinding,
  type ContinuityOverride,
  type ContinuityRun,
  type ContinuityRunView,
  type DerivedAsset,
  type MediaQaRepository,
  type NewDerivation,
  type NewFinding,
  type NewRun,
  type NewTransitionAnalysisBatch,
  type NewTransitionAnalysisRun,
  type NewTransitionRun,
  type TransitionAnalysisJob,
  type TransitionContinuityRun,
  type TransitionRunView,
  type TransitionSubject,
} from "./media-qa-repository";

const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-process implementation (memory/demo mode and fast tests). Mirrors the Postgres rules: derivation
 * idempotency by key, append-only overrides, frozen run snapshots, atomic run numbering.
 */
export class MemoryMediaQaService implements MediaQaRepository, AnalysisWorkerStore {
  private jobs = new Map<string, AnalysisJob>();
  private costs: AnalysisCost[] = [];
  private events: AnalysisEvent[] = [];

  private derivations: AssetDerivation[] = [];
  private deliveries = new Map<string, AttemptDelivery>();
  private runs: ContinuityRun[] = [];
  private findings: ContinuityFinding[] = [];
  private overrides: ContinuityOverride[] = [];
  private qaPolicies = new Map<string, ProjectQaPolicy>();
  /**
   * 3A.4C transition runs and their frozen subjects: kept apart from `runs` (the attempt runs), so no Shot path can
   * ever list, number, project or pin from them. Their findings live in `findings`, addressed by run id only.
   */
  private transitionRuns: TransitionContinuityRun[] = [];
  private transitionSubjects: TransitionSubject[] = [];

  constructor(
    private readonly access: MemoryProjectsAccess & {
      /** the live Episode edits (3A.4C: a transition run is validated against the edit it names) */
      edits?: () => { get(projectId: string, editId: string): Promise<EpisodeEdit | null> };
    },
  ) {}

  private assetById(id: string): Asset | null {
    for (const p of this.access.all()) {
      const a = p.assets.find((x) => x.id === id);
      if (a) return clone(a);
    }
    return null;
  }

  private withAsset(d: AssetDerivation): DerivedAsset | null {
    const asset = this.assetById(d.childAssetId);
    return asset ? { derivation: clone(d), asset } : null;
  }

  // ───────────────────────── derivations ─────────────────────────

  async findDerivationByKey(projectId: string, derivationKey: string) {
    const d = this.derivations.find((x) => x.projectId === projectId && x.derivationKey === derivationKey);
    return d ? this.withAsset(d) : null;
  }

  async listAttemptDerivations(attemptId: string) {
    return this.derivations
      .filter((d) => d.attemptId === attemptId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .flatMap((d) => this.withAsset(d) ?? []);
  }

  async listDerivationsByParent(parentAssetId: string) {
    return this.derivations
      .filter((d) => d.parentAssetId === parentAssetId)
      .flatMap((d) => this.withAsset(d) ?? []);
  }

  async getDerivationOfAsset(childAssetId: string) {
    const d = this.derivations.find((x) => x.childAssetId === childAssetId);
    return d ? clone(d) : null;
  }

  async assetPins(assetId: string) {
    const out: string[] = [];
    const kids = this.derivations.filter((d) => d.parentAssetId === assetId).length;
    if (kids > 0)
      out.push(
        `${kids} derived file${kids === 1 ? "" : "s"} (conform, frames, contact sheet) are made from it`,
      );
    for (const d of this.deliveries.values()) {
      if (d.assetId === assetId) out.push("it is the selected delivery master of a generation attempt");
      else if (d.originalAssetId === assetId)
        out.push("it is the provider original behind a delivery master");
    }
    for (const r of this.runs) {
      if (r.subjectAssetId === assetId || r.originalAssetId === assetId) {
        out.push("a continuity review was run against it");
        break;
      }
    }
    return out;
  }

  async recordDerivation(input: NewDerivation) {
    const project = this.access.all().find((p) => p.project.id === input.asset.projectId);
    if (!project) throw new MediaQaError("not_found", "That project no longer exists.");
    const existing = await this.findDerivationByKey(input.asset.projectId, input.derivationKey);
    if (existing) return { ...existing, created: false };
    if (!project.assets.some((a) => a.id === input.parentAssetId)) {
      throw new MediaQaError("not_found", "The parent asset no longer exists.");
    }
    const asset = assetSchema.parse(input.asset);
    project.assets.push(clone(asset));
    const version =
      Math.max(
        0,
        ...this.derivations
          .filter(
            (d) =>
              d.attemptId === input.attemptId && d.operation === input.operation && d.slot === input.slot,
          )
          .map((d) => d.version),
      ) + 1;
    const derivation: AssetDerivation = {
      id: randomUUID(),
      projectId: asset.projectId,
      parentAssetId: input.parentAssetId,
      childAssetId: asset.id,
      operation: input.operation,
      derivationKey: input.derivationKey,
      parameters: clone(input.parameters),
      processor: input.processor,
      processorVersion: input.processorVersion,
      attemptId: input.attemptId,
      slot: input.slot,
      version,
      createdBy: input.createdBy,
      createdAt: input.now,
    };
    this.derivations.push(derivation);
    return { derivation: clone(derivation), asset: clone(asset), created: true };
  }

  async getDelivery(attemptId: string) {
    const d = this.deliveries.get(attemptId);
    return d ? clone(d) : null;
  }

  async listProjectDeliveries(projectId: string) {
    return [...this.deliveries.values()].filter((d) => d.projectId === projectId).map(clone);
  }

  async selectDelivery(input: Parameters<MediaQaRepository["selectDelivery"]>[0]) {
    const d: AttemptDelivery = {
      attemptId: input.attemptId,
      projectId: input.projectId,
      assetId: input.assetId,
      originalAssetId: input.originalAssetId,
      conform: input.conform ? clone(input.conform) : null,
      selectedBy: input.selectedBy,
      selectedAt: input.now,
    };
    this.deliveries.set(input.attemptId, d);
    return clone(d);
  }

  // ───────────────────────── continuity QA ─────────────────────────

  private view(run: ContinuityRun): ContinuityRunView {
    const findings = this.findings
      .filter((f) => f.runId === run.id)
      .sort((a, b) => a.position - b.position)
      .map((finding) => ({
        finding: clone(finding),
        overrides: this.overrides
          .filter((o) => o.findingId === finding.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(clone),
      }));
    return { run: clone(run), findings };
  }

  async createRun(input: NewRun, findings: NewFinding[]) {
    return this.insertRun(input, findings, null);
  }

  async ensureAutomaticRun(input: NewRun, findings: NewFinding[], automationKey: string) {
    // check-and-insert with no await in between: as atomic in this store as the unique index is in Postgres
    const existing = this.runs.find(
      (r) => r.projectId === input.projectId && r.automationKey === automationKey,
    );
    if (existing) return { run: this.view(existing), created: false };
    return { run: this.insertRun(input, findings, automationKey), created: true };
  }

  private insertRun(input: NewRun, findings: NewFinding[], automationKey: string | null): ContinuityRunView {
    const { now, ...withPhase2d } = input;
    const rest: Omit<
      typeof withPhase2d,
      "analysisPlan" | "externalManifest" | "promptVersion" | "rubricVersion" | "model"
    > = withPhase2d;
    const runNumber =
      Math.max(0, ...this.runs.filter((r) => r.attemptId === input.attemptId).map((r) => r.runNumber)) + 1;
    const run: ContinuityRun = {
      ...rest,
      analysisPlan: input.analysisPlan ?? null,
      externalManifest: input.externalManifest ?? null,
      promptVersion: input.promptVersion ?? null,
      rubricVersion: input.rubricVersion ?? null,
      model: input.model ?? null,
      automationKey,
      id: randomUUID(),
      runNumber,
      analysisError: "",
      createdAt: now,
      completedAt: null,
      finalizedAt: null,
      finalizedBy: null,
      finalizeNote: "",
    };
    this.runs.push(run);
    for (const f of findings) {
      this.findings.push({
        ...clone(f),
        id: randomUUID(),
        runId: run.id,
        projectId: run.projectId,
        createdAt: now,
      });
    }
    return this.view(run);
  }

  async getRun(runId: string) {
    const r = this.runs.find((x) => x.id === runId);
    return r ? this.view(r) : null;
  }

  // ───────────────────────── transition runs (3A.4C) ─────────────────────────

  private transitionView(run: TransitionContinuityRun): TransitionRunView {
    const subject = this.transitionSubjects.find((s) => s.runId === run.id);
    if (!subject) throw new Error(`Transition run ${run.id} has no subject (invariant broken).`);
    const findings = this.findings
      .filter((f) => f.runId === run.id)
      .sort((a, b) => a.position - b.position)
      .map((finding) => ({
        finding: clone(finding),
        overrides: this.overrides
          .filter((o) => o.findingId === finding.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(clone),
      }));
    return { run: clone(run), subject: clone(subject), findings };
  }

  async createTransitionRun(input: NewTransitionRun): Promise<TransitionRunView> {
    const edit = (await this.access.edits?.().get(input.projectId, input.subject.editId)) ?? null;
    return this.transitionView(this.insertTransitionRun(input, edit));
  }

  /** 3A.4D: one cut's run + job (a batch of one; the same all-or-none semantics). */
  async createTransitionRunWithJob(input: NewTransitionAnalysisRun) {
    const [out] = await this.createTransitionBatchWithJobs({ entries: [input], limits: input.limits });
    return out!;
  }

  async findTransitionJobsByKeys(projectId: string, keys: string[]) {
    return [...this.jobs.values()]
      .filter(
        (j): j is TransitionAnalysisJob =>
          j.subjectKind === "transition" && j.projectId === projectId && keys.includes(j.idempotencyKey),
      )
      .map(clone);
  }

  /**
   * 3A.4D: ONE confirmed manual batch, all or none. The edits are read first (the only awaits); from there everything is
   * synchronous: replays resolved by key (no slot), the shared limit checked for the NEW jobs only, EVERY new entry's
   * adjacency validated, and only then every run + job written. Results follow the input order.
   */
  async createTransitionBatchWithJobs(input: NewTransitionAnalysisBatch) {
    const edits = new Map<string, EpisodeEdit | null>();
    for (const e of input.entries)
      if (!edits.has(e.run.subject.editId))
        edits.set(
          e.run.subject.editId,
          (await this.access.edits?.().get(e.run.projectId, e.run.subject.editId)) ?? null,
        );
    // ── synchronous from here ──
    const projectId = input.entries[0]?.run.projectId;
    if (!projectId) return [];
    if (input.entries.some((e) => e.run.projectId !== projectId))
      throw new MediaQaError("invalid", "A sequence batch belongs to one Project.");
    const existing = (key: string) =>
      [...this.jobs.values()].find(
        (j): j is TransitionAnalysisJob =>
          j.subjectKind === "transition" && j.projectId === projectId && j.idempotencyKey === key,
      );
    const keys = input.entries.map((e) => e.job.idempotencyKey);
    const fresh = input.entries.filter(
      (e, i) => !existing(e.job.idempotencyKey) && keys.indexOf(e.job.idempotencyKey) === i,
    );
    if (fresh.length > 0) {
      // the SAME shared Project limit as Shot QA, counted across both subject kinds
      const open = [...this.jobs.values()].filter(
        (j) => j.projectId === projectId && ANALYSIS_ACTIVE.includes(j.status),
      ).length;
      if (open + fresh.length > input.limits.maxActivePerProject)
        throw new MediaQaError(
          "invalid",
          `This review needs ${fresh.length} analysis slot(s) but the project has ${Math.max(0, input.limits.maxActivePerProject - open)} free (${open} in progress, limit ${input.limits.maxActivePerProject}). Nothing was queued.`,
        );
    }
    // all or none: every new entry must still be a live cut BEFORE anything is written
    for (const e of fresh) {
      const refusal = this.refusalOf(e.run, edits.get(e.run.subject.editId) ?? null);
      if (refusal) throw refusal;
    }
    const created = new Map<string, TransitionAnalysisJob>();
    for (const e of fresh) {
      const run = this.insertTransitionRun(e.run, edits.get(e.run.subject.editId) ?? null);
      created.set(e.job.idempotencyKey, this.insertTransitionJob(run, e));
    }
    return input.entries.map((e) => {
      const made = created.get(e.job.idempotencyKey);
      const job = made ?? existing(e.job.idempotencyKey)!;
      const run = this.transitionRuns.find((x) => x.id === job.runId)!;
      return { run: this.transitionView(run), job: clone(job), duplicate: !made };
    });
  }

  private refusalOf(input: NewTransitionRun, edit: EpisodeEdit | null) {
    return transitionRunRefusal(
      edit && {
        id: edit.id,
        projectId: edit.projectId,
        episodeId: edit.episodeId,
        revision: edit.revision,
        items: edit.items.map((i) => ({ id: i.id, shotId: i.shotId })),
      },
      input,
    );
  }

  private insertTransitionJob(run: TransitionContinuityRun, input: NewTransitionAnalysisRun) {
    const now = input.run.now;
    const job: TransitionAnalysisJob = {
      id: randomUUID(),
      projectId: run.projectId,
      runId: run.id,
      subjectKind: "transition",
      attemptId: null,
      analyzer: input.job.analyzer,
      model: input.job.model,
      status: "queued",
      inputSnapshot: clone(input.job.snapshot),
      inputAssetIds: [...input.job.inputAssetIds],
      idempotencyKey: input.job.idempotencyKey,
      nextRunAt: now,
      attemptCount: 0,
      maxAttempts: input.job.maxAttempts,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      providerState: "not_sent",
      providerRef: null,
      batchesTotal: input.job.snapshot.plan.batches.length,
      batchesDone: 0,
      correctionCount: 0,
      transportCalls: 0,
      batchResults: [],
      estimatedCostUsd: input.job.estimate.maxUsd,
      actualCostUsd: null,
      providerFiles: [],
      lastErrorCode: null,
      lastErrorCategory: null,
      lastErrorMessage: "",
      cancelRequestedAt: null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      createdBy: input.run.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.costs.push({
      id: randomUUID(),
      projectId: job.projectId,
      runId: job.runId,
      jobId: job.id,
      analyzer: job.analyzer,
      model: job.model,
      kind: "estimated",
      amountUsd: input.job.estimate.maxUsd,
      expectedUsd: input.job.estimate.expectedUsd,
      currency: "USD",
      usage: clone(input.job.estimate.usage),
      pricingVersion: input.job.estimate.pricingVersion,
      recordedAt: now,
    });
    this.addEvent(job, null, "queued", "Sequence review submitted by user", now);
    return job;
  }

  private insertTransitionRun(input: NewTransitionRun, edit: EpisodeEdit | null): TransitionContinuityRun {
    const s = input.subject;
    const refusal = transitionRunRefusal(
      edit && {
        id: edit.id,
        projectId: edit.projectId,
        episodeId: edit.episodeId,
        revision: edit.revision,
        items: edit.items.map((i) => ({ id: i.id, shotId: i.shotId })),
      },
      input,
    );
    if (refusal) throw refusal;
    const runNumber =
      Math.max(
        0,
        ...this.transitionSubjects
          .filter((x) => x.projectId === input.projectId && x.transitionKey === s.transitionKey)
          .map((x) => x.runNumber),
      ) + 1;
    const done = input.analysisStatus === "complete" || input.analysisStatus === "failed";
    const run: TransitionContinuityRun = {
      id: randomUUID(),
      projectId: input.projectId,
      subjectKind: "transition",
      attemptId: null,
      subjectAssetId: null,
      originalAssetId: null,
      runNumber,
      analyzer: input.analyzer,
      analyzerVersion: input.analyzerVersion,
      analyzerKind: input.analyzerKind,
      rulesVersion: input.rulesVersion,
      analysisStatus: input.analysisStatus,
      analysisError: "",
      // a cut has no generation package: its package identity is its address
      packageFingerprint: s.transitionKey,
      subjectFingerprint: input.subjectFingerprint,
      criteriaFingerprint: input.criteriaFingerprint,
      referenceFingerprint: input.referenceFingerprint,
      referenceSet: clone(input.referenceSet),
      analysisPlan: input.analysisPlan ? clone(input.analysisPlan) : null,
      externalManifest: input.externalManifest ? clone(input.externalManifest) : null,
      promptVersion: input.promptVersion ?? null,
      rubricVersion: input.rubricVersion ?? null,
      model: input.model ?? null,
      automationKey: null,
      createdBy: input.createdBy,
      createdAt: input.now,
      completedAt: done ? input.now : null,
      finalizedAt: null,
      finalizedBy: null,
      finalizeNote: "",
    };
    this.transitionRuns.push(run);
    this.transitionSubjects.push({
      ...clone(s),
      runId: run.id,
      projectId: input.projectId,
      runNumber,
      createdBy: input.createdBy,
      createdAt: input.now,
    });
    for (const f of input.findings)
      this.findings.push({
        ...clone(f),
        id: randomUUID(),
        runId: run.id,
        projectId: run.projectId,
        createdAt: input.now,
      });
    return run;
  }

  async getTransitionRun(runId: string) {
    const r = this.transitionRuns.find((x) => x.id === runId);
    return r ? this.transitionView(r) : null;
  }

  async listTransitionRuns(projectId: string, transitionKey: string) {
    const ids = new Set(
      this.transitionSubjects
        .filter((s) => s.projectId === projectId && s.transitionKey === transitionKey)
        .map((s) => s.runId),
    );
    return this.transitionRuns
      .filter((r) => ids.has(r.id))
      .sort((a, b) => b.runNumber - a.runNumber)
      .map((r) => this.transitionView(r));
  }

  async listLatestEditTransitionRuns(projectId: string, editId: string) {
    const latest = new Map<string, TransitionSubject>();
    for (const s of this.transitionSubjects.filter((x) => x.projectId === projectId && x.editId === editId)) {
      const cur = latest.get(s.transitionKey);
      if (!cur || s.runNumber > cur.runNumber) latest.set(s.transitionKey, s);
    }
    return [...latest.values()]
      .sort((a, b) => (a.transitionKey < b.transitionKey ? -1 : 1))
      .map((s) => this.transitionView(this.transitionRuns.find((r) => r.id === s.runId)!));
  }

  async listAttemptRuns(attemptId: string) {
    return this.runs
      .filter((r) => r.attemptId === attemptId)
      .sort((a, b) => b.runNumber - a.runNumber)
      .map((r) => this.view(r));
  }

  async listLatestProjectRuns(projectId: string) {
    const latest = new Map<string, ContinuityRun>();
    for (const r of this.runs.filter((x) => x.projectId === projectId)) {
      const cur = latest.get(r.attemptId);
      if (!cur || cur.runNumber < r.runNumber) latest.set(r.attemptId, r);
    }
    return [...latest.values()].map((r) => this.view(r));
  }

  async setAnalysisStatus(runId: string, status: AnalysisStatus, now: string, error = "") {
    const r = this.runs.find((x) => x.id === runId);
    if (!r) return null;
    r.analysisStatus = status;
    r.analysisError = error;
    if (status === "complete" || status === "failed") r.completedAt = now;
    return clone(r);
  }

  async applyAnalysis(runId: string, results: Parameters<MediaQaRepository["applyAnalysis"]>[1]) {
    const run = this.runs.find((x) => x.id === runId);
    if (!run) throw new MediaQaError("not_found", "That QA run no longer exists.");
    this.applyResults(run, results);
  }

  /**
   * 3A.4D: the worker executes jobs of EITHER subject kind, so its run lookups (start / apply / finish) find the job's
   * run by id among attempt and transition runs, exactly as the Postgres worker store updates a run by id. The public
   * Shot APIs above stay attempt-only.
   */
  private workerRun(runId: string) {
    return this.runs.find((x) => x.id === runId) ?? this.transitionRuns.find((x) => x.id === runId) ?? null;
  }

  private applyResults(
    run: { id: string; analysisStatus: AnalysisStatus },
    results: Parameters<MediaQaRepository["applyAnalysis"]>[1],
  ) {
    const runId = run.id;
    if (run.analysisStatus === "complete") {
      throw new MediaQaError("run_closed", "A completed run is a frozen snapshot; start a new run instead.");
    }
    for (const r of results) {
      const f = this.findings.find((x) => x.runId === runId && x.criterionKey === r.criterionKey);
      if (!f) continue;
      f.result = r.result;
      f.actual = r.actual;
      f.confidence = r.confidence;
      f.notes = r.notes;
      f.evidence = clone(r.evidence);
      f.resultSource = "analyzer";
    }
  }

  async addOverride(input: Parameters<MediaQaRepository["addOverride"]>[0]) {
    const f = this.findings.find((x) => x.id === input.findingId && x.runId === input.runId);
    if (!f) throw new MediaQaError("not_found", "That finding no longer exists.");
    const o: ContinuityOverride = {
      id: randomUUID(),
      projectId: f.projectId,
      runId: input.runId,
      findingId: input.findingId,
      result: input.result,
      notes: input.notes,
      createdBy: input.createdBy,
      createdAt: input.now,
    };
    this.overrides.push(o);
    return clone(o);
  }

  async finalizeRun(runId: string, input: { by: string | null; note: string; now: string }) {
    const r = this.runs.find((x) => x.id === runId);
    if (!r) return null;
    if (r.analysisStatus !== "complete" && r.analysisStatus !== "failed") {
      throw new MediaQaError("run_in_progress", "Wait for the analysis to finish before closing the review.");
    }
    r.finalizedAt = input.now;
    r.finalizedBy = input.by;
    r.finalizeNote = input.note;
    return clone(r);
  }

  // ───────────────────────── analysis jobs (user path) ─────────────────────────

  private addEvent(job: AnalysisJob, from: string | null, to: string, note: string, at: string) {
    this.events.push({
      id: randomUUID(),
      jobId: job.id,
      runId: job.runId,
      at,
      fromStatus: from,
      toStatus: to,
      note,
    });
  }

  async createAnalysisRunWithJob(input: NewAnalysisRun) {
    const replay = [...this.jobs.values()].find(
      (j): j is AttemptAnalysisJob =>
        j.subjectKind === "attempt" &&
        j.projectId === input.run.projectId &&
        j.idempotencyKey === input.job.idempotencyKey,
    );
    if (replay) {
      const view = await this.getRun(replay.runId);
      return { run: view!, job: clone(replay), duplicate: true };
    }
    // every subject kind counts: an active transition job takes one of the same Project slots (3A.4 architecture)
    const active = [...this.jobs.values()].filter(
      (j) => j.projectId === input.run.projectId && ANALYSIS_ACTIVE.includes(j.status),
    ).length;
    if (active >= input.limits.maxActivePerProject) {
      throw new MediaQaError(
        "invalid",
        `This project already has ${active} analyses in progress (limit ${input.limits.maxActivePerProject}).`,
      );
    }
    const run = await this.createRun(input.run, input.findings);
    const now = input.run.now;
    const job: AttemptAnalysisJob = {
      id: randomUUID(),
      projectId: run.run.projectId,
      runId: run.run.id,
      subjectKind: "attempt",
      attemptId: run.run.attemptId,
      analyzer: input.job.analyzer,
      model: input.job.model,
      status: "queued",
      inputSnapshot: clone(input.job.snapshot),
      inputAssetIds: [...input.job.inputAssetIds],
      idempotencyKey: input.job.idempotencyKey,
      nextRunAt: now,
      attemptCount: 0,
      maxAttempts: input.job.maxAttempts,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      providerState: "not_sent",
      providerRef: null,
      batchesTotal: input.job.snapshot.plan.batches.length,
      batchesDone: 0,
      correctionCount: 0,
      transportCalls: 0,
      batchResults: [],
      estimatedCostUsd: input.job.estimate.maxUsd,
      actualCostUsd: null,
      providerFiles: [],
      lastErrorCode: null,
      lastErrorCategory: null,
      lastErrorMessage: "",
      cancelRequestedAt: null,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      createdBy: input.run.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.costs.push({
      id: randomUUID(),
      projectId: job.projectId,
      runId: job.runId,
      jobId: job.id,
      analyzer: job.analyzer,
      model: job.model,
      kind: "estimated",
      amountUsd: input.job.estimate.maxUsd,
      expectedUsd: input.job.estimate.expectedUsd,
      currency: "USD",
      usage: clone(input.job.estimate.usage),
      pricingVersion: input.job.estimate.pricingVersion,
      recordedAt: now,
    });
    this.addEvent(job, null, "queued", "Submitted by user", now);
    return { run, job: clone(job), duplicate: false };
  }

  async getAnalysisJob(jobId: string) {
    // generic: either subject kind
    const j = this.jobs.get(jobId);
    return j ? clone(j) : null;
  }

  async listAttemptAnalysisJobs(attemptId: string) {
    return [...this.jobs.values()]
      .filter((j): j is AttemptAnalysisJob => j.subjectKind === "attempt" && j.attemptId === attemptId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async listActiveProjectAnalysisJobs(projectId: string) {
    // every subject kind: Shot and sequence QA share the Project's active-job limit
    return [...this.jobs.values()]
      .filter((j) => j.projectId === projectId && ANALYSIS_ACTIVE.includes(j.status))
      .map(clone);
  }

  async listAnalysisCosts(runId: string) {
    return this.costs.filter((c) => c.runId === runId).map(clone);
  }

  async listAnalysisEvents(jobId: string) {
    return this.events.filter((e) => e.jobId === jobId).map(clone);
  }

  async requestAnalysisCancel(jobId: string, now: string) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (isAnalysisTerminal(job.status) || job.status === "cancel_requested") return clone(job);
    const from = job.status;
    if (job.status === "queued") {
      assertAnalysisTransition("queued", "cancelled");
      job.status = "cancelled";
      job.cancelledAt = now;
      job.cancelRequestedAt = now;
      job.leaseToken = null;
      this.failRun(job.runId, now, "Analysis cancelled before it started.");
      this.addEvent(job, from, "cancelled", "Cancelled before it started", now);
    } else {
      assertAnalysisTransition(job.status, "cancel_requested");
      job.status = "cancel_requested";
      job.cancelRequestedAt = now;
      this.addEvent(job, from, "cancel_requested", "Cancellation requested", now);
    }
    job.updatedAt = now;
    return clone(job);
  }

  /** a queued job's run of EITHER subject kind fails when the job is cancelled (Postgres updates it by id) */
  private failRun(runId: string, now: string, error: string) {
    const r = this.runs.find((x) => x.id === runId) ?? this.transitionRuns.find((x) => x.id === runId);
    if (!r) return;
    r.analysisStatus = "failed";
    r.analysisError = error;
    r.completedAt = now;
  }

  async automationReady() {
    return true;
  }

  async getQaPolicy(projectId: string) {
    return clone(this.qaPolicies.get(projectId) ?? defaultQaPolicy(projectId));
  }

  async saveQaPolicy(input: Parameters<MediaQaRepository["saveQaPolicy"]>[0]) {
    const errors = qaPolicyErrors(input.policy);
    if (errors.length > 0) throw new MediaQaError("invalid", errors.join(" "));
    const current = this.qaPolicies.get(input.projectId)?.revision ?? 0;
    if (current !== input.expectedRevision)
      throw new MediaQaError(
        "conflict",
        "The Shot QA policy was changed elsewhere since this page loaded. Reload to see it, then try again.",
      );
    const next: ProjectQaPolicy = {
      projectId: input.projectId,
      ...normalisePolicy(input.policy),
      revision: current + 1,
      updatedBy: input.by,
      updatedAt: input.now,
    };
    this.qaPolicies.set(input.projectId, next);
    return clone(next);
  }

  async analysisSpentSince(projectId: string | null, sinceIso: string) {
    const jobs = [...this.jobs.values()].filter((j) => projectId == null || j.projectId === projectId);
    let total = 0;
    for (const j of jobs) {
      const cs = this.costs.filter((c) => c.jobId === j.id && c.recordedAt >= sinceIso);
      const fin = cs.find((c) => c.kind !== "estimated");
      const est = cs.find((c) => c.kind === "estimated");
      total += fin?.kind === "actual" ? (fin.amountUsd ?? 0) : (est?.amountUsd ?? 0);
    }
    return total;
  }

  // ───────────────────────── worker path ─────────────────────────

  async claim(opts: {
    workerId: string;
    now: string;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedAnalysisJob[]> {
    const nowMs = Date.parse(opts.now);
    const due = [...this.jobs.values()]
      .filter(
        (j) =>
          // 3A.4D: both subject kinds; the worker is mode-aware
          ANALYSIS_ACTIVE.includes(j.status) &&
          Date.parse(j.nextRunAt) <= nowMs &&
          (j.leaseToken == null || (j.leaseExpiresAt != null && Date.parse(j.leaseExpiresAt) <= nowMs)),
      )
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
      .slice(0, opts.limit);
    return due.map((j) => {
      if (j.status === "queued") {
        assertAnalysisTransition("queued", "claimed");
        j.status = "claimed";
      }
      j.leaseOwner = opts.workerId;
      j.leaseToken = randomUUID();
      j.leaseExpiresAt = new Date(nowMs + opts.leaseMs).toISOString();
      j.heartbeatAt = opts.now;
      return { job: clone(j) };
    });
  }

  private leased(jobId: string, token: string): AnalysisJob {
    const j = this.jobs.get(jobId);
    if (!j || j.leaseToken !== token) throw new AnalysisLeaseLostError(jobId);
    return j;
  }

  async heartbeat(jobId: string, leaseToken: string, now: string, leaseMs: number) {
    const j = this.jobs.get(jobId);
    if (!j || j.leaseToken !== leaseToken) return false;
    j.heartbeatAt = now;
    j.leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    return true;
  }

  async update(jobId: string, leaseToken: string, patch: AnalysisJobPatch, now: string) {
    const j = this.leased(jobId, leaseToken);
    const from = j.status;
    if (patch.status && patch.status !== j.status) {
      assertAnalysisTransition(j.status, patch.status);
      j.status = patch.status;
      if (patch.status === "failed") j.failedAt = now;
      if (patch.status === "succeeded") j.completedAt = now;
      if (patch.status === "cancelled") j.cancelledAt = now;
      this.addEvent(j, from, patch.status, patch.note ?? "", now);
    } else if (patch.event) {
      this.addEvent(j, from, from, patch.event, now);
    }
    const set = <K extends keyof AnalysisJob>(k: K, v: AnalysisJob[K] | undefined) => {
      if (v !== undefined) j[k] = v;
    };
    set("nextRunAt", patch.nextRunAt);
    set("attemptCount", patch.attemptCount);
    set("providerState", patch.providerState);
    set("providerRef", patch.providerRef);
    set("batchesTotal", patch.batchesTotal);
    set("batchesDone", patch.batchesDone);
    set("correctionCount", patch.correctionCount);
    set("transportCalls", patch.transportCalls);
    set("batchResults", patch.batchResults === undefined ? undefined : clone(patch.batchResults));
    set("actualCostUsd", patch.actualCostUsd);
    set("providerFiles", patch.providerFiles);
    set("lastErrorCode", patch.lastErrorCode);
    set("lastErrorCategory", patch.lastErrorCategory);
    set("lastErrorMessage", patch.lastErrorMessage);
    set("startedAt", patch.startedAt);
    if (patch.releaseLease || isAnalysisTerminal(j.status)) {
      j.leaseOwner = null;
      j.leaseToken = null;
      j.leaseExpiresAt = null;
    }
    j.updatedAt = now;
    return clone(j);
  }

  async startRun(runId: string, now: string) {
    const r = this.workerRun(runId);
    if (r && r.analysisStatus === "queued") {
      r.analysisStatus = "running";
      void now;
    }
  }

  async findInputAsset(jobId: string, assetId: string): Promise<InputAssetRef | null> {
    const j = this.jobs.get(jobId);
    if (!j || !j.inputAssetIds.includes(assetId)) return null;
    const a = this.assetById(assetId);
    if (!a) return null;
    return {
      assetId: a.id,
      objectPath: a.objectPath,
      bucket: a.bucket,
      storageProvider: a.storageProvider,
      mime: a.mime,
      byteSize: a.byteSize,
      checksum: a.checksum,
      width: a.width,
      height: a.height,
    };
  }

  private writeCost(job: AnalysisJob, c: FinalizeAnalysisSuccess["cost"], now: string) {
    this.costs.push({
      id: randomUUID(),
      projectId: job.projectId,
      runId: job.runId,
      jobId: job.id,
      analyzer: c.analyzer,
      model: c.model,
      kind: c.kind,
      amountUsd: c.kind === "actual" ? c.amountUsd : null,
      expectedUsd: null,
      currency: "USD",
      usage: clone(c.usage) as unknown as Record<string, unknown>,
      pricingVersion: c.pricingVersion,
      recordedAt: now,
    });
  }

  async finalizeSuccess(input: FinalizeAnalysisSuccess) {
    const job = this.leased(input.jobId, input.leaseToken);
    if (this.costs.some((c) => c.jobId === job.id && c.kind !== "estimated")) {
      // exactly one final result per job: a duplicate worker finishing late changes nothing
      return clone(job);
    }
    const run = this.workerRun(input.runId);
    if (!run || run.analysisStatus === "complete")
      throw new MediaQaError("run_closed", "The run is already complete.");
    this.applyResults(
      run,
      input.findings.map((f) => ({
        criterionKey: f.criterionKey,
        result: f.result,
        actual: f.summary,
        confidence: f.confidence,
        notes: f.limitations.join("; "),
        evidence: {
          items: f.evidence,
          contradictions: f.contradictions,
          limitations: f.limitations,
          analyzer: job.analyzer,
          model: job.model,
        },
      })),
    );
    run.analysisStatus = "complete";
    run.analysisError = "";
    run.completedAt = input.now;
    this.writeCost(job, input.cost, input.now);
    const from = job.status;
    assertAnalysisTransition(job.status, "succeeded");
    job.status = "succeeded";
    job.completedAt = input.now;
    job.providerRef = input.providerRef;
    job.providerState = "responded";
    job.correctionCount = input.correctionCount;
    job.actualCostUsd = input.cost.kind === "actual" ? input.cost.amountUsd : null;
    job.batchesDone = job.batchesTotal;
    job.leaseOwner = null;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.updatedAt = input.now;
    this.addEvent(job, from, "succeeded", input.note, input.now);
    return clone(job);
  }

  async finalizeFailure(input: FinalizeAnalysisFailure) {
    const job = this.leased(input.jobId, input.leaseToken);
    const from = job.status;
    const to = input.cancelled ? "cancelled" : "failed";
    assertAnalysisTransition(job.status, to);
    this.failRun(input.runId, input.now, input.errorMessage);
    if (input.cost && !this.costs.some((c) => c.jobId === job.id && c.kind !== "estimated")) {
      this.writeCost(job, input.cost, input.now);
      job.actualCostUsd = input.cost.kind === "actual" ? input.cost.amountUsd : null;
    }
    job.status = to;
    if (input.cancelled) job.cancelledAt = input.now;
    else job.failedAt = input.now;
    job.lastErrorCode = input.errorCode;
    job.lastErrorCategory = input.errorCategory;
    job.lastErrorMessage = input.errorMessage;
    job.leaseOwner = null;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.updatedAt = input.now;
    this.addEvent(job, from, to, input.errorMessage, input.now);
    return clone(job);
  }

  async spentSince(sinceIso: string) {
    return this.analysisSpentSince(null, sinceIso);
  }
}

/** Stores exactly what the owner entered (an empty analyzer becomes null); nothing is inferred or promoted. */
function normalisePolicy(p: QaPolicyInput): QaPolicyInput & { directVideoAllowed: boolean } {
  return {
    semanticMode: p.semanticMode,
    analyzer: p.analyzer || null,
    externalMediaAllowed: p.externalMediaAllowed,
    maxCostPerRunUsd: p.maxCostPerRunUsd,
    maxCostPerDayUsd: p.maxCostPerDayUsd,
    // 3A.3: never implied; a caller that does not set it (3A.2) saves false
    directVideoAllowed: p.directVideoAllowed === true,
  };
}
