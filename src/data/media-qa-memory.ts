import { randomUUID } from "node:crypto";
import { assetSchema, type Asset } from "@/domain/schemas";
import type { MemoryProjectsAccess } from "./generation-memory";
import {
  MediaQaError,
  type AnalysisStatus,
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
} from "./media-qa-repository";

const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-process implementation (memory/demo mode and fast tests). Mirrors the Postgres rules: derivation
 * idempotency by key, append-only overrides, frozen run snapshots, atomic run numbering.
 */
export class MemoryMediaQaService implements MediaQaRepository {
  private derivations: AssetDerivation[] = [];
  private deliveries = new Map<string, AttemptDelivery>();
  private runs: ContinuityRun[] = [];
  private findings: ContinuityFinding[] = [];
  private overrides: ContinuityOverride[] = [];

  constructor(private readonly access: MemoryProjectsAccess) {}

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
    const { now, ...rest } = input;
    const runNumber =
      Math.max(0, ...this.runs.filter((r) => r.attemptId === input.attemptId).map((r) => r.runNumber)) + 1;
    const run: ContinuityRun = {
      ...rest,
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
}
