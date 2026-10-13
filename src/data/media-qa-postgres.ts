import type { Pool, PoolClient } from "pg";
import { assetSchema } from "@/domain/schemas";
import { COLLECTIONS, flatFromRow, flatToRow, type Row } from "./postgres-mapping";
import { upsertRow } from "./postgres-repository";
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

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));
const json = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

const mapDerivation = (r: Row): AssetDerivation => ({
  id: String(r.id),
  projectId: String(r.project_id),
  parentAssetId: String(r.parent_asset_id),
  childAssetId: String(r.child_asset_id),
  operation: r.operation as AssetDerivation["operation"],
  derivationKey: String(r.derivation_key),
  parameters: json(r.parameters),
  processor: String(r.processor),
  processorVersion: String(r.processor_version),
  attemptId: r.attempt_id ? String(r.attempt_id) : null,
  slot: String(r.slot ?? ""),
  version: Number(r.version),
  createdBy: r.created_by ? String(r.created_by) : null,
  createdAt: iso(r.created_at)!,
});

const mapDelivery = (r: Row): AttemptDelivery => ({
  attemptId: String(r.attempt_id),
  projectId: String(r.project_id),
  assetId: String(r.asset_id),
  originalAssetId: String(r.original_asset_id),
  conform: r.conform ? json(r.conform) : null,
  selectedBy: r.selected_by ? String(r.selected_by) : null,
  selectedAt: iso(r.selected_at)!,
});

const mapRun = (r: Row): ContinuityRun => ({
  id: String(r.id),
  projectId: String(r.project_id),
  attemptId: String(r.attempt_id),
  runNumber: Number(r.run_number),
  subjectAssetId: String(r.subject_asset_id),
  originalAssetId: r.original_asset_id ? String(r.original_asset_id) : null,
  analyzer: String(r.analyzer),
  analyzerVersion: String(r.analyzer_version),
  analyzerKind: r.analyzer_kind as ContinuityRun["analyzerKind"],
  rulesVersion: String(r.rules_version),
  analysisStatus: r.analysis_status as AnalysisStatus,
  analysisError: String(r.analysis_error ?? ""),
  packageFingerprint: String(r.package_fingerprint),
  subjectFingerprint: String(r.subject_fingerprint),
  criteriaFingerprint: String(r.criteria_fingerprint),
  referenceFingerprint: String(r.reference_fingerprint),
  referenceSet: json(r.reference_set),
  createdBy: r.created_by ? String(r.created_by) : null,
  createdAt: iso(r.created_at)!,
  completedAt: iso(r.completed_at),
  finalizedAt: iso(r.finalized_at),
  finalizedBy: r.finalized_by ? String(r.finalized_by) : null,
  finalizeNote: String(r.finalize_note ?? ""),
});

const mapFinding = (r: Row): ContinuityFinding => ({
  id: String(r.id),
  projectId: String(r.project_id),
  runId: String(r.run_id),
  criterionKey: String(r.criterion_key),
  category: r.category as ContinuityFinding["category"],
  severity: r.severity as ContinuityFinding["severity"],
  title: String(r.title),
  sourceRef: String(r.source_ref ?? ""),
  expected: String(r.expected ?? ""),
  actual: String(r.actual ?? ""),
  result: r.result as ContinuityFinding["result"],
  resultSource: r.result_source as ContinuityFinding["resultSource"],
  confidence: num(r.confidence),
  notes: String(r.notes ?? ""),
  evidence: json(r.evidence),
  position: Number(r.position),
  createdAt: iso(r.created_at)!,
});

const mapOverride = (r: Row): ContinuityOverride => ({
  id: String(r.id),
  projectId: String(r.project_id),
  runId: String(r.run_id),
  findingId: String(r.finding_id),
  result: r.result as ContinuityOverride["result"],
  notes: String(r.notes ?? ""),
  createdBy: r.created_by ? String(r.created_by) : null,
  createdAt: iso(r.created_at)!,
});

const parseAsset = (r: Row) => assetSchema.parse(flatFromRow(r, COLLECTIONS.assets));

/**
 * Postgres persistence for derivations and continuity QA. `preamble` decides the security context (an RLS
 * preamble for the application path), so ownership is enforced by Postgres, never by this class.
 */
export class PostgresMediaQaData implements MediaQaRepository {
  constructor(
    private readonly pool: Pool,
    private readonly preamble: string,
  ) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(this.preamble);
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ───────────────────────── derivations ─────────────────────────

  private async withAssets(c: PoolClient, rows: Row[]): Promise<DerivedAsset[]> {
    if (rows.length === 0) return [];
    const assets = await c.query("select * from assets where id = any($1::uuid[])", [
      rows.map((r) => String(r.child_asset_id)),
    ]);
    const byId = new Map(assets.rows.map((a) => [String(a.id), a]));
    return rows.flatMap((r) => {
      const a = byId.get(String(r.child_asset_id));
      return a ? [{ derivation: mapDerivation(r), asset: parseAsset(a) }] : [];
    });
  }

  async findDerivationByKey(projectId: string, derivationKey: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from asset_derivations where project_id = $1 and derivation_key = $2",
        [projectId, derivationKey],
      );
      return (await this.withAssets(c, r.rows))[0] ?? null;
    });
  }

  async listAttemptDerivations(attemptId: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from asset_derivations where attempt_id = $1 order by created_at", [
        attemptId,
      ]);
      return this.withAssets(c, r.rows);
    });
  }

  async listDerivationsByParent(parentAssetId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from asset_derivations where parent_asset_id = $1 order by created_at",
        [parentAssetId],
      );
      return this.withAssets(c, r.rows);
    });
  }

  async getDerivationOfAsset(childAssetId: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from asset_derivations where child_asset_id = $1", [childAssetId]);
      return r.rows[0] ? mapDerivation(r.rows[0]) : null;
    });
  }

  async assetPins(assetId: string) {
    return this.tx(async (c) => {
      const out: string[] = [];
      const kids = await c.query(
        "select count(*)::int as n from asset_derivations where parent_asset_id = $1",
        [assetId],
      );
      const n = Number(kids.rows[0].n);
      if (n > 0)
        out.push(`${n} derived file${n === 1 ? "" : "s"} (conform, frames, contact sheet) are made from it`);
      const del = await c.query(
        "select asset_id = $1 as is_master from attempt_deliveries where asset_id = $1 or original_asset_id = $1",
        [assetId],
      );
      for (const d of del.rows) {
        out.push(
          d.is_master
            ? "it is the selected delivery master of a generation attempt"
            : "it is the provider original behind a delivery master",
        );
      }
      const runs = await c.query(
        "select 1 from continuity_runs where subject_asset_id = $1 or original_asset_id = $1 limit 1",
        [assetId],
      );
      if (runs.rowCount) out.push("a continuity review was run against it");
      return out;
    });
  }

  async recordDerivation(input: NewDerivation) {
    return this.tx(async (c) => {
      const projectId = input.asset.projectId;
      // Serialise concurrent identical derivations for this project (double click, retry after a crash).
      const lock = await c.query("select id from projects where id = $1 for update", [projectId]);
      if (lock.rowCount === 0) throw new MediaQaError("not_found", "That project no longer exists.");
      const existing = await c.query(
        "select * from asset_derivations where project_id = $1 and derivation_key = $2",
        [projectId, input.derivationKey],
      );
      if (existing.rows[0]) {
        const found = (await this.withAssets(c, existing.rows))[0];
        if (found) return { ...found, created: false };
      }
      const asset = assetSchema.parse(input.asset);
      await upsertRow(c, "assets", { ...flatToRow(asset, COLLECTIONS.assets), project_id: projectId });
      const version = await c.query(
        `select coalesce(max(version), 0) + 1 as v from asset_derivations
         where attempt_id is not distinct from $1::uuid and operation = $2 and slot = $3`,
        [input.attemptId, input.operation, input.slot],
      );
      const ins = await c.query(
        `insert into asset_derivations
           (project_id, parent_asset_id, child_asset_id, operation, derivation_key, parameters, processor,
            processor_version, attempt_id, slot, version, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13) returning *`,
        [
          projectId,
          input.parentAssetId,
          asset.id,
          input.operation,
          input.derivationKey,
          JSON.stringify(input.parameters),
          input.processor,
          input.processorVersion,
          input.attemptId,
          input.slot,
          Number(version.rows[0].v),
          input.createdBy,
          input.now,
        ],
      );
      return { derivation: mapDerivation(ins.rows[0]), asset, created: true };
    });
  }

  async getDelivery(attemptId: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from attempt_deliveries where attempt_id = $1", [attemptId]);
      return r.rows[0] ? mapDelivery(r.rows[0]) : null;
    });
  }

  async listProjectDeliveries(projectId: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from attempt_deliveries where project_id = $1", [projectId]);
      return r.rows.map(mapDelivery);
    });
  }

  async selectDelivery(input: Parameters<MediaQaRepository["selectDelivery"]>[0]) {
    return this.tx(async (c) => {
      const r = await c.query(
        `insert into attempt_deliveries
           (attempt_id, project_id, asset_id, original_asset_id, conform, selected_by, selected_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7)
         on conflict (attempt_id) do update set
           asset_id = excluded.asset_id, original_asset_id = excluded.original_asset_id,
           conform = excluded.conform, selected_by = excluded.selected_by, selected_at = excluded.selected_at
         returning *`,
        [
          input.attemptId,
          input.projectId,
          input.assetId,
          input.originalAssetId,
          input.conform ? JSON.stringify(input.conform) : null,
          input.selectedBy,
          input.now,
        ],
      );
      return mapDelivery(r.rows[0]);
    });
  }

  // ───────────────────────── continuity QA ─────────────────────────

  private async views(c: PoolClient, runRows: Row[]): Promise<ContinuityRunView[]> {
    if (runRows.length === 0) return [];
    const ids = runRows.map((r) => String(r.id));
    const findings = await c.query(
      "select * from continuity_findings where run_id = any($1::uuid[]) order by position",
      [ids],
    );
    const overrides = await c.query(
      "select * from continuity_overrides where run_id = any($1::uuid[]) order by created_at desc",
      [ids],
    );
    return runRows.map((r) => ({
      run: mapRun(r),
      findings: findings.rows
        .filter((f) => String(f.run_id) === String(r.id))
        .map((f) => ({
          finding: mapFinding(f),
          overrides: overrides.rows.filter((o) => String(o.finding_id) === String(f.id)).map(mapOverride),
        })),
    }));
  }

  async createRun(input: NewRun, findings: NewFinding[]) {
    return this.tx(async (c) => {
      // Serialises run numbering for the attempt.
      const lock = await c.query("select id from generation_attempts where id = $1 for update", [
        input.attemptId,
      ]);
      if (lock.rowCount === 0) throw new MediaQaError("not_found", "That attempt no longer exists.");
      const n = await c.query(
        "select coalesce(max(run_number), 0) + 1 as n from continuity_runs where attempt_id = $1",
        [input.attemptId],
      );
      const r = await c.query(
        `insert into continuity_runs
           (project_id, attempt_id, run_number, subject_asset_id, original_asset_id, analyzer, analyzer_version,
            analyzer_kind, rules_version, analysis_status, package_fingerprint, subject_fingerprint,
            criteria_fingerprint, reference_fingerprint, reference_set, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17)
         returning *`,
        [
          input.projectId,
          input.attemptId,
          Number(n.rows[0].n),
          input.subjectAssetId,
          input.originalAssetId,
          input.analyzer,
          input.analyzerVersion,
          input.analyzerKind,
          input.rulesVersion,
          input.analysisStatus,
          input.packageFingerprint,
          input.subjectFingerprint,
          input.criteriaFingerprint,
          input.referenceFingerprint,
          JSON.stringify(input.referenceSet),
          input.createdBy,
          input.now,
        ],
      );
      const run = r.rows[0] as Row;
      for (const f of findings) {
        await c.query(
          `insert into continuity_findings
             (project_id, run_id, criterion_key, category, severity, title, source_ref, expected, actual, result,
              result_source, confidence, notes, evidence, position, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16)`,
          [
            input.projectId,
            run.id,
            f.criterionKey,
            f.category,
            f.severity,
            f.title,
            f.sourceRef,
            f.expected,
            f.actual,
            f.result,
            f.resultSource,
            f.confidence,
            f.notes,
            JSON.stringify(f.evidence),
            f.position,
            input.now,
          ],
        );
      }
      return (await this.views(c, [run]))[0]!;
    });
  }

  async getRun(runId: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from continuity_runs where id = $1", [runId]);
      return (await this.views(c, r.rows))[0] ?? null;
    });
  }

  async listAttemptRuns(attemptId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from continuity_runs where attempt_id = $1 order by run_number desc",
        [attemptId],
      );
      return this.views(c, r.rows);
    });
  }

  async listLatestProjectRuns(projectId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `select distinct on (attempt_id) * from continuity_runs
         where project_id = $1 order by attempt_id, run_number desc`,
        [projectId],
      );
      return this.views(c, r.rows);
    });
  }

  async setAnalysisStatus(runId: string, status: AnalysisStatus, now: string, error = "") {
    return this.tx(async (c) => {
      const r = await c.query(
        `update continuity_runs set analysis_status = $2, analysis_error = $3,
           completed_at = case when $2 in ('complete', 'failed') then $4::timestamptz else completed_at end
         where id = $1 returning *`,
        [runId, status, error, now],
      );
      return r.rows[0] ? mapRun(r.rows[0]) : null;
    });
  }

  async applyAnalysis(runId: string, results: Parameters<MediaQaRepository["applyAnalysis"]>[1]) {
    await this.tx(async (c) => {
      const run = await c.query("select analysis_status from continuity_runs where id = $1 for update", [
        runId,
      ]);
      if (run.rowCount === 0) throw new MediaQaError("not_found", "That QA run no longer exists.");
      if (run.rows[0].analysis_status === "complete") {
        throw new MediaQaError(
          "run_closed",
          "A completed run is a frozen snapshot; start a new run instead.",
        );
      }
      for (const r of results) {
        await c.query(
          `update continuity_findings set result = $3, actual = $4, confidence = $5, notes = $6,
             evidence = $7::jsonb, result_source = 'analyzer'
           where run_id = $1 and criterion_key = $2`,
          [runId, r.criterionKey, r.result, r.actual, r.confidence, r.notes, JSON.stringify(r.evidence)],
        );
      }
    });
  }

  async addOverride(input: Parameters<MediaQaRepository["addOverride"]>[0]) {
    return this.tx(async (c) => {
      const f = await c.query("select project_id from continuity_findings where id = $1 and run_id = $2", [
        input.findingId,
        input.runId,
      ]);
      if (f.rowCount === 0) throw new MediaQaError("not_found", "That finding no longer exists.");
      const r = await c.query(
        `insert into continuity_overrides (project_id, run_id, finding_id, result, notes, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [
          f.rows[0].project_id,
          input.runId,
          input.findingId,
          input.result,
          input.notes,
          input.createdBy,
          input.now,
        ],
      );
      return mapOverride(r.rows[0]);
    });
  }

  async finalizeRun(runId: string, input: { by: string | null; note: string; now: string }) {
    return this.tx(async (c) => {
      const cur = await c.query("select analysis_status from continuity_runs where id = $1 for update", [
        runId,
      ]);
      if (cur.rowCount === 0) return null;
      if (!["complete", "failed"].includes(cur.rows[0].analysis_status)) {
        throw new MediaQaError(
          "run_in_progress",
          "Wait for the analysis to finish before closing the review.",
        );
      }
      const r = await c.query(
        `update continuity_runs set finalized_at = $2, finalized_by = $3, finalize_note = $4
         where id = $1 returning *`,
        [runId, input.now, input.by, input.note],
      );
      return mapRun(r.rows[0]);
    });
  }
}
