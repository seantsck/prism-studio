import type { Pool, PoolClient } from "pg";
import { assetSchema } from "@/domain/schemas";
import { COLLECTIONS, flatFromRow, flatToRow, type Row } from "./postgres-mapping";
import { upsertRow } from "./postgres-repository";
import { ANALYSIS_ACTIVE, assertAnalysisTransition } from "@/domain/continuity/analysis/job-state";
import {
  defaultQaPolicy,
  qaPolicyErrors,
  type ProjectQaPolicy,
  type SemanticMode,
} from "@/domain/continuity/automation";
import {
  MediaQaError,
  type AnalysisCost,
  type AnalysisEvent,
  type AnalysisJob,
  type NewAnalysisRun,
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
  type NewTransitionRun,
  type TransitionContinuityRun,
  type TransitionRunView,
  type TransitionSubject,
} from "./media-qa-repository";
import type { PersistedCutSide } from "@/domain/continuity/sequence";
import { transitionRunRefusal } from "./transition-runs";

const NOT_MIGRATED =
  "Automatic Shot QA needs database migration 0044, which is not applied to this database yet.";
const NOT_MIGRATED_0045 =
  "Full-video (temporal) Shot QA permission needs database migration 0045, which is not applied to this database yet.";

const mapQaPolicy = (r: Row): ProjectQaPolicy => ({
  projectId: String(r.project_id),
  semanticMode: r.semantic_mode as SemanticMode,
  analyzer: r.analyzer ? String(r.analyzer) : null,
  externalMediaAllowed: Boolean(r.external_media_allowed),
  maxCostPerRunUsd: r.max_cost_per_run_usd == null ? null : Number(r.max_cost_per_run_usd),
  maxCostPerDayUsd: r.max_cost_per_day_usd == null ? null : Number(r.max_cost_per_day_usd),
  // absent before migration 0045: full-video analysis is simply not allowed
  directVideoAllowed: r.direct_video_allowed === true,
  revision: Number(r.revision),
  updatedBy: r.updated_by ? String(r.updated_by) : null,
  updatedAt:
    r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at ? String(r.updated_at) : null,
});

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
  analysisPlan: (r.analysis_plan as ContinuityRun["analysisPlan"]) ?? null,
  externalManifest: (r.external_manifest as ContinuityRun["externalManifest"]) ?? null,
  promptVersion: r.prompt_version ? String(r.prompt_version) : null,
  rubricVersion: r.rubric_version ? String(r.rubric_version) : null,
  model: r.model ? String(r.model) : null,
  // absent before migration 0044 is applied: every such run is manual
  automationKey: r.automation_key ? String(r.automation_key) : null,
  createdBy: r.created_by ? String(r.created_by) : null,
  createdAt: iso(r.created_at)!,
  completedAt: iso(r.completed_at),
  finalizedAt: iso(r.finalized_at),
  finalizedBy: r.finalized_by ? String(r.finalized_by) : null,
  finalizeNote: String(r.finalize_note ?? ""),
});

const mapTransitionRun = (r: Row): TransitionContinuityRun => ({
  ...mapRun(r),
  subjectKind: "transition",
  attemptId: null,
  subjectAssetId: null,
  originalAssetId: null,
});

const persistedSide = (v: unknown, which: "left" | "right"): PersistedCutSide => {
  const side = v as PersistedCutSide | null;
  if (!side || typeof side !== "object" || side.version !== "cut-side-snapshot-v1" || side.side !== which)
    throw new Error(`Malformed persisted ${which} cut side.`);
  return side;
};

const mapTransitionSubject = (r: Row): TransitionSubject => ({
  runId: String(r.run_id),
  projectId: String(r.project_id),
  editId: String(r.edit_id),
  episodeId: String(r.episode_id),
  editRevision: Number(r.edit_revision),
  transitionKey: String(r.transition_key),
  runNumber: Number(r.run_number),
  leftItemId: String(r.left_item_id),
  rightItemId: String(r.right_item_id),
  leftShotId: String(r.left_shot_id),
  rightShotId: String(r.right_shot_id),
  leftSide: persistedSide(r.left_side, "left"),
  rightSide: persistedSide(r.right_side, "right"),
  crossesScene: Boolean(r.crosses_scene),
  createdBy: r.created_by ? String(r.created_by) : null,
  createdAt: iso(r.created_at)!,
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

export const mapAnalysisJob = (r: Row): AnalysisJob => ({
  id: String(r.id),
  projectId: String(r.project_id),
  runId: String(r.run_id),
  attemptId: String(r.attempt_id),
  analyzer: String(r.analyzer),
  model: String(r.model),
  status: r.status as AnalysisJob["status"],
  inputSnapshot: r.input_snapshot as AnalysisJob["inputSnapshot"],
  inputAssetIds: ((r.input_asset_ids as string[] | null) ?? []).map(String),
  idempotencyKey: String(r.idempotency_key),
  nextRunAt: iso(r.next_run_at)!,
  attemptCount: Number(r.attempt_count),
  maxAttempts: Number(r.max_attempts),
  leaseOwner: r.lease_owner ? String(r.lease_owner) : null,
  leaseToken: r.lease_token ? String(r.lease_token) : null,
  leaseExpiresAt: iso(r.lease_expires_at),
  heartbeatAt: iso(r.heartbeat_at),
  providerState: r.provider_state as AnalysisJob["providerState"],
  providerRef: r.provider_ref ? String(r.provider_ref) : null,
  batchesTotal: Number(r.batches_total),
  batchesDone: Number(r.batches_done),
  correctionCount: Number(r.correction_count),
  transportCalls: Number(r.transport_calls ?? 0),
  batchResults: ((r.batch_results as AnalysisJob["batchResults"] | null) ?? []).map((b) => ({ ...b })),
  estimatedCostUsd: num(r.estimated_cost_usd),
  actualCostUsd: num(r.actual_cost_usd),
  providerFiles: ((r.provider_files as AnalysisJob["providerFiles"] | null) ?? []).map((f) => ({ ...f })),
  lastErrorCode: r.last_error_code ? String(r.last_error_code) : null,
  lastErrorCategory: (r.last_error_category as AnalysisJob["lastErrorCategory"]) ?? null,
  lastErrorMessage: String(r.last_error_message ?? ""),
  cancelRequestedAt: iso(r.cancel_requested_at),
  startedAt: iso(r.started_at),
  completedAt: iso(r.completed_at),
  failedAt: iso(r.failed_at),
  cancelledAt: iso(r.cancelled_at),
  createdBy: r.created_by ? String(r.created_by) : null,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

export const mapAnalysisCost = (r: Row): AnalysisCost => ({
  id: String(r.id),
  projectId: String(r.project_id),
  runId: String(r.run_id),
  jobId: String(r.job_id),
  analyzer: String(r.analyzer),
  model: String(r.model),
  kind: r.kind as AnalysisCost["kind"],
  amountUsd: num(r.amount_usd),
  expectedUsd: num(r.expected_usd),
  currency: String(r.currency),
  usage: json(r.usage),
  pricingVersion: String(r.pricing_version ?? ""),
  recordedAt: iso(r.recorded_at)!,
});

const activeList = ANALYSIS_ACTIVE.map((s) => `'${s}'`).join(", ");

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
      // 3A.4C: a transition run has no single subject Asset; its analysis job names its inputs
      const transitionJobs = await c.query(
        "select 1 from continuity_analysis_jobs where subject_kind = 'transition' and $1 = any (input_asset_ids) limit 1",
        [assetId],
      );
      if (transitionJobs.rowCount) out.push("a sequence continuity analysis of a cut reads it");
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
    return this.tx((c) => this.insertRun(c, input, findings, null));
  }

  async ensureAutomaticRun(input: NewRun, findings: NewFinding[], automationKey: string) {
    try {
      return await this.tx(async (c) => {
        // the attempt row lock (taken in insertRun) serialises same-attempt callers; the partial unique index
        // continuity_runs_automation_key is the authority across every process
        const lock = await c.query("select id from generation_attempts where id = $1 for update", [
          input.attemptId,
        ]);
        if (lock.rowCount === 0) throw new MediaQaError("not_found", "That attempt no longer exists.");
        const existing = await c.query(
          "select * from continuity_runs where project_id = $1 and subject_kind = 'attempt' and automation_key = $2",
          [input.projectId, automationKey],
        );
        if (existing.rows[0]) return { run: (await this.views(c, existing.rows))[0]!, created: false };
        return { run: await this.insertRun(c, input, findings, automationKey), created: true };
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "23505") {
        // a concurrent caller committed the same automatic run first: return it
        const again = await this.tx(async (c) => {
          const r = await c.query(
            "select * from continuity_runs where project_id = $1 and subject_kind = 'attempt' and automation_key = $2",
            [input.projectId, automationKey],
          );
          return (await this.views(c, r.rows))[0] ?? null;
        });
        if (again) return { run: again, created: false };
      }
      if (code === "42703") throw new MediaQaError("not_migrated", NOT_MIGRATED);
      throw err;
    }
  }

  private async insertRun(
    c: PoolClient,
    input: NewRun,
    findings: NewFinding[],
    automationKey: string | null,
  ): Promise<ContinuityRunView> {
    // Serialises run numbering for the attempt.
    const lock = await c.query("select id from generation_attempts where id = $1 for update", [
      input.attemptId,
    ]);
    if (lock.rowCount === 0) throw new MediaQaError("not_found", "That attempt no longer exists.");
    const n = await c.query(
      "select coalesce(max(run_number), 0) + 1 as n from continuity_runs where subject_kind = 'attempt' and attempt_id = $1",
      [input.attemptId],
    );
    const r = await c.query(
      `insert into continuity_runs
           (project_id, subject_kind, attempt_id, run_number, subject_asset_id, original_asset_id, analyzer, analyzer_version,
            analyzer_kind, rules_version, analysis_status, package_fingerprint, subject_fingerprint,
            criteria_fingerprint, reference_fingerprint, reference_set, created_by, created_at,
            analysis_plan, external_manifest, prompt_version, rubric_version, model${automationKey ? ", automation_key" : ""})
         values ($1, 'attempt', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17,
                 $18::jsonb, $19::jsonb, $20, $21, $22${automationKey ? ", $23" : ""})
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
        input.analysisPlan ? JSON.stringify(input.analysisPlan) : null,
        input.externalManifest ? JSON.stringify(input.externalManifest) : null,
        input.promptVersion ?? null,
        input.rubricVersion ?? null,
        input.model ?? null,
        ...(automationKey ? [automationKey] : []),
      ],
    );
    const run = r.rows[0] as Row;
    await this.insertFindings(c, input.projectId, String(run.id), findings, input.now);
    return (await this.views(c, [run]))[0]!;
  }

  private async insertFindings(
    c: PoolClient,
    projectId: string,
    runId: string,
    findings: NewFinding[],
    now: string,
  ) {
    for (const f of findings) {
      await c.query(
        `insert into continuity_findings
             (project_id, run_id, criterion_key, category, severity, title, source_ref, expected, actual, result,
              result_source, confidence, notes, evidence, position, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16)`,
        [
          projectId,
          runId,
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
          now,
        ],
      );
    }
  }

  // ───────────────────────── transition runs (3A.4C) ─────────────────────────

  private async transitionViews(c: PoolClient, runRows: Row[]): Promise<TransitionRunView[]> {
    if (runRows.length === 0) return [];
    const views = await this.views(c, runRows);
    const subjects = await c.query(
      "select * from continuity_transition_subjects where run_id = any($1::uuid[])",
      [runRows.map((r) => String(r.id))],
    );
    return views.map((v, i) => {
      const subject = subjects.rows.find((x) => String(x.run_id) === v.run.id);
      if (!subject) throw new Error(`Transition run ${v.run.id} has no subject (database invariant broken).`);
      return {
        run: mapTransitionRun(runRows[i]!),
        subject: mapTransitionSubject(subject),
        findings: v.findings,
      };
    });
  }

  async createTransitionRun(input: NewTransitionRun): Promise<TransitionRunView> {
    return this.tx(async (c) => {
      const s = input.subject;
      // the live cut: the edit row is held FOR SHARE (an edit mutation takes it FOR UPDATE), so the adjacency
      // validated here is the adjacency at commit
      const edit = await c.query(
        "select id, project_id, episode_id, revision from episode_edits where id = $1 for share",
        [s.editId],
      );
      const items = edit.rows[0]
        ? (
            await c.query("select id, shot_id from episode_edit_items where edit_id = $1 order by position", [
              s.editId,
            ])
          ).rows
        : [];
      const refusal = transitionRunRefusal(
        edit.rows[0]
          ? {
              id: String(edit.rows[0].id),
              projectId: String(edit.rows[0].project_id),
              episodeId: String(edit.rows[0].episode_id),
              revision: Number(edit.rows[0].revision),
              items: items.map((r) => ({ id: String(r.id), shotId: String(r.shot_id) })),
            }
          : null,
        input,
      );
      if (refusal) throw refusal;
      // numbering per (project, transition key): serialised by a transaction-scoped advisory lock on that key
      await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `prism:transition-run:${input.projectId}:${s.transitionKey}`,
      ]);
      const n = Number(
        (
          await c.query(
            `select coalesce(max(run_number), 0) + 1 as n from continuity_transition_subjects
             where project_id = $1 and transition_key = $2`,
            [input.projectId, s.transitionKey],
          )
        ).rows[0].n,
      );
      const run = (
        await c.query(
          `insert into continuity_runs
             (project_id, subject_kind, attempt_id, run_number, subject_asset_id, original_asset_id, analyzer,
              analyzer_version, analyzer_kind, rules_version, analysis_status, package_fingerprint,
              subject_fingerprint, criteria_fingerprint, reference_fingerprint, reference_set, created_by, created_at,
              completed_at)
           values ($1, 'transition', null, $2, null, null, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13,
                   $14, case when $7 in ('complete', 'failed') then $14::timestamptz end)
           returning *`,
          [
            input.projectId,
            n,
            input.analyzer,
            input.analyzerVersion,
            input.analyzerKind,
            input.rulesVersion,
            input.analysisStatus,
            // a cut has no generation package: its package identity is its address
            s.transitionKey,
            input.subjectFingerprint,
            input.criteriaFingerprint,
            input.referenceFingerprint,
            JSON.stringify(input.referenceSet),
            input.createdBy,
            input.now,
          ],
        )
      ).rows[0] as Row;
      await c.query(
        `insert into continuity_transition_subjects
           (run_id, project_id, edit_id, episode_id, edit_revision, transition_key, run_number, left_item_id,
            right_item_id, left_shot_id, right_shot_id, left_side, right_side, crosses_scene, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16)`,
        [
          run.id,
          input.projectId,
          s.editId,
          s.episodeId,
          s.editRevision,
          s.transitionKey,
          n,
          s.leftItemId,
          s.rightItemId,
          s.leftShotId,
          s.rightShotId,
          JSON.stringify(s.leftSide),
          JSON.stringify(s.rightSide),
          s.crossesScene,
          input.createdBy,
          input.now,
        ],
      );
      await this.insertFindings(c, input.projectId, String(run.id), input.findings, input.now);
      return (await this.transitionViews(c, [run]))[0]!;
    });
  }

  async getTransitionRun(runId: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from continuity_runs where id = $1 and subject_kind = 'transition'", [
        runId,
      ]);
      return (await this.transitionViews(c, r.rows))[0] ?? null;
    });
  }

  async listTransitionRuns(projectId: string, transitionKey: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `select r.* from continuity_runs r
           join continuity_transition_subjects s on s.run_id = r.id
         where r.project_id = $1 and r.subject_kind = 'transition' and s.transition_key = $2
         order by s.run_number desc`,
        [projectId, transitionKey],
      );
      return this.transitionViews(c, r.rows);
    });
  }

  async listLatestEditTransitionRuns(projectId: string, editId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `select distinct on (s.transition_key) r.* from continuity_runs r
           join continuity_transition_subjects s on s.run_id = r.id
         where r.project_id = $1 and r.subject_kind = 'transition' and s.edit_id = $2
         order by s.transition_key, s.run_number desc`,
        [projectId, editId],
      );
      return this.transitionViews(c, r.rows);
    });
  }

  async getRun(runId: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from continuity_runs where id = $1 and subject_kind = 'attempt'", [
        runId,
      ]);
      return (await this.views(c, r.rows))[0] ?? null;
    });
  }

  async listAttemptRuns(attemptId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from continuity_runs where subject_kind = 'attempt' and attempt_id = $1 order by run_number desc",
        [attemptId],
      );
      return this.views(c, r.rows);
    });
  }

  async listLatestProjectRuns(projectId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `select distinct on (attempt_id) * from continuity_runs
         where project_id = $1 and subject_kind = 'attempt' order by attempt_id, run_number desc`,
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
         where id = $1 and subject_kind = 'attempt' returning *`,
        [runId, status, error, now],
      );
      return r.rows[0] ? mapRun(r.rows[0]) : null;
    });
  }

  async applyAnalysis(runId: string, results: Parameters<MediaQaRepository["applyAnalysis"]>[1]) {
    await this.tx(async (c) => {
      const run = await c.query(
        "select analysis_status from continuity_runs where id = $1 and subject_kind = 'attempt' for update",
        [runId],
      );
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
      const cur = await c.query(
        "select analysis_status from continuity_runs where id = $1 and subject_kind = 'attempt' for update",
        [runId],
      );
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

  // ───────────────────────── analysis jobs (user path) ─────────────────────────

  async createAnalysisRunWithJob(input: NewAnalysisRun) {
    return this.tx(async (c) => {
      const r = input.run;
      const project = await c.query("select id from projects where id = $1 for update", [r.projectId]);
      if (project.rowCount === 0) throw new MediaQaError("not_found", "That project no longer exists.");

      const replay = await c.query(
        "select * from continuity_analysis_jobs where project_id = $1 and subject_kind = 'attempt' and idempotency_key = $2",
        [r.projectId, input.job.idempotencyKey],
      );
      if (replay.rows[0]) {
        const run = await c.query(
          "select * from continuity_runs where id = $1 and subject_kind = 'attempt'",
          [replay.rows[0].run_id],
        );
        return {
          run: (await this.views(c, run.rows))[0]!,
          job: mapAnalysisJob(replay.rows[0]),
          duplicate: true,
        };
      }
      const open = await c.query(
        `select count(*)::int as n from continuity_analysis_jobs where project_id = $1 and status in (${activeList})`,
        [r.projectId],
      );
      if (open.rows[0].n >= input.limits.maxActivePerProject) {
        throw new MediaQaError(
          "invalid",
          `This project already has ${open.rows[0].n} analyses in progress (limit ${input.limits.maxActivePerProject}).`,
        );
      }

      const lock = await c.query("select id from generation_attempts where id = $1 for update", [
        r.attemptId,
      ]);
      if (lock.rowCount === 0) throw new MediaQaError("not_found", "That attempt no longer exists.");
      const n = await c.query(
        "select coalesce(max(run_number), 0) + 1 as n from continuity_runs where subject_kind = 'attempt' and attempt_id = $1",
        [r.attemptId],
      );
      const run = (
        await c.query(
          `insert into continuity_runs
             (project_id, subject_kind, attempt_id, run_number, subject_asset_id, original_asset_id, analyzer, analyzer_version,
              analyzer_kind, rules_version, analysis_status, package_fingerprint, subject_fingerprint,
              criteria_fingerprint, reference_fingerprint, reference_set, created_by, created_at,
              analysis_plan, external_manifest, prompt_version, rubric_version, model)
           values ($1, 'attempt', $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11, $12, $13, $14::jsonb, $15, $16,
                   $17::jsonb, $18::jsonb, $19, $20, $21)
           returning *`,
          [
            r.projectId,
            r.attemptId,
            Number(n.rows[0].n),
            r.subjectAssetId,
            r.originalAssetId,
            r.analyzer,
            r.analyzerVersion,
            r.analyzerKind,
            r.rulesVersion,
            r.packageFingerprint,
            r.subjectFingerprint,
            r.criteriaFingerprint,
            r.referenceFingerprint,
            JSON.stringify(r.referenceSet),
            r.createdBy,
            r.now,
            r.analysisPlan ? JSON.stringify(r.analysisPlan) : null,
            r.externalManifest ? JSON.stringify(r.externalManifest) : null,
            r.promptVersion ?? null,
            r.rubricVersion ?? null,
            r.model ?? null,
          ],
        )
      ).rows[0] as Row;
      for (const f of input.findings) {
        await c.query(
          `insert into continuity_findings
             (project_id, run_id, criterion_key, category, severity, title, source_ref, expected, actual, result,
              result_source, confidence, notes, evidence, position, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16)`,
          [
            r.projectId,
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
            r.now,
          ],
        );
      }
      const job = (
        await c.query(
          `insert into continuity_analysis_jobs
             (project_id, subject_kind, run_id, attempt_id, analyzer, model, status, input_snapshot, input_asset_ids,
              idempotency_key, next_run_at, max_attempts, batches_total, estimated_cost_usd, created_by, created_at)
           values ($1, 'attempt', $2, $3, $4, $5, 'queued', $6::jsonb, $7::uuid[], $8, $9, $10, $11, $12, $13, $9)
           returning *`,
          [
            r.projectId,
            run.id,
            r.attemptId,
            input.job.analyzer,
            input.job.model,
            JSON.stringify(input.job.snapshot),
            input.job.inputAssetIds,
            input.job.idempotencyKey,
            r.now,
            input.job.maxAttempts,
            input.job.snapshot.plan.batches.length,
            input.job.estimate.maxUsd,
            r.createdBy,
          ],
        )
      ).rows[0] as Row;
      await c.query(
        `insert into continuity_analysis_costs
           (project_id, run_id, job_id, analyzer, model, kind, amount_usd, expected_usd, usage, pricing_version, recorded_at)
         values ($1, $2, $3, $4, $5, 'estimated', $6, $7, $8::jsonb, $9, $10)`,
        [
          r.projectId,
          run.id,
          job.id,
          input.job.analyzer,
          input.job.model,
          input.job.estimate.maxUsd,
          input.job.estimate.expectedUsd,
          JSON.stringify(input.job.estimate.usage),
          input.job.estimate.pricingVersion,
          r.now,
        ],
      );
      await c.query(
        `insert into continuity_analysis_events (project_id, job_id, run_id, at, from_status, to_status, note)
         values ($1, $2, $3, $4, null, 'queued', 'Submitted by user')`,
        [r.projectId, job.id, run.id, r.now],
      );
      return { run: (await this.views(c, [run]))[0]!, job: mapAnalysisJob(job), duplicate: false };
    });
  }

  async getAnalysisJob(jobId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from continuity_analysis_jobs where id = $1 and subject_kind = 'attempt'",
        [jobId],
      );
      return r.rows[0] ? mapAnalysisJob(r.rows[0]) : null;
    });
  }

  async listAttemptAnalysisJobs(attemptId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from continuity_analysis_jobs where subject_kind = 'attempt' and attempt_id = $1 order by created_at desc",
        [attemptId],
      );
      return r.rows.map(mapAnalysisJob);
    });
  }

  async listActiveProjectAnalysisJobs(projectId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `select * from continuity_analysis_jobs where project_id = $1 and subject_kind = 'attempt' and status in (${activeList})`,
        [projectId],
      );
      return r.rows.map(mapAnalysisJob);
    });
  }

  async listAnalysisCosts(runId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from continuity_analysis_costs where run_id = $1 order by recorded_at",
        [runId],
      );
      return r.rows.map(mapAnalysisCost);
    });
  }

  async listAnalysisEvents(jobId: string): Promise<AnalysisEvent[]> {
    return this.tx(async (c) => {
      const r = await c.query("select * from continuity_analysis_events where job_id = $1 order by at, id", [
        jobId,
      ]);
      return r.rows.map((e) => ({
        id: String(e.id),
        jobId: String(e.job_id),
        runId: String(e.run_id),
        at: iso(e.at)!,
        fromStatus: e.from_status ? String(e.from_status) : null,
        toStatus: String(e.to_status),
        note: String(e.note ?? ""),
      }));
    });
  }

  async requestAnalysisCancel(jobId: string, now: string) {
    return this.tx(async (c) => {
      const cur = (
        await c.query(
          "select * from continuity_analysis_jobs where id = $1 and subject_kind = 'attempt' for update",
          [jobId],
        )
      ).rows[0];
      if (!cur) return null;
      const job = mapAnalysisJob(cur);
      if (["succeeded", "failed", "cancelled", "cancel_requested"].includes(job.status)) return job;
      if (job.status === "queued") {
        assertAnalysisTransition("queued", "cancelled");
        const r = await c.query(
          `update continuity_analysis_jobs set status = 'cancelled', cancelled_at = $2, cancel_requested_at = $2,
             lease_token = null, lease_owner = null, lease_expires_at = null where id = $1 returning *`,
          [jobId, now],
        );
        await c.query(
          `update continuity_runs set analysis_status = 'failed', analysis_error = 'Analysis cancelled before it started.',
             completed_at = $2 where id = $1`,
          [job.runId, now],
        );
        await c.query(
          `insert into continuity_analysis_events (project_id, job_id, run_id, at, from_status, to_status, note)
           values ($1, $2, $3, $4, 'queued', 'cancelled', 'Cancelled before it started')`,
          [job.projectId, job.id, job.runId, now],
        );
        return mapAnalysisJob(r.rows[0]);
      }
      assertAnalysisTransition(job.status, "cancel_requested");
      const r = await c.query(
        "update continuity_analysis_jobs set status = 'cancel_requested', cancel_requested_at = $2 where id = $1 returning *",
        [jobId, now],
      );
      await c.query(
        `insert into continuity_analysis_events (project_id, job_id, run_id, at, from_status, to_status, note)
         values ($1, $2, $3, $4, $5, 'cancel_requested', 'Cancellation requested')`,
        [job.projectId, job.id, job.runId, now, job.status],
      );
      return mapAnalysisJob(r.rows[0]);
    });
  }

  // ───────────────────────── Project QA policy ─────────────────────────

  /** Migrations are forward-only: once 0044 is seen applied it stays applied (re-checked until then). */
  private automationApplied = false;

  async automationReady() {
    if (this.automationApplied) return true;
    // catalog lookups need no table privilege and never raise when the table / column is absent
    this.automationApplied = await this.tx(async (c) => {
      const r = await c.query(
        `select to_regclass('public.project_qa_policies') is not null
                and exists (select 1 from pg_attribute
                             where attrelid = 'public.continuity_runs'::regclass
                               and attname = 'automation_key' and not attisdropped) as ready`,
      );
      return Boolean(r.rows[0]?.ready);
    });
    return this.automationApplied;
  }

  async getQaPolicy(projectId: string) {
    try {
      return await this.tx(async (c) => {
        const r = await c.query("select * from project_qa_policies where project_id = $1", [projectId]);
        return r.rows[0] ? mapQaPolicy(r.rows[0]) : defaultQaPolicy(projectId);
      });
    } catch (err) {
      // before migration 0044 is applied there is no policy table: semantic automation is simply off
      if ((err as { code?: string }).code === "42P01") return defaultQaPolicy(projectId);
      throw err;
    }
  }

  async saveQaPolicy(input: Parameters<MediaQaRepository["saveQaPolicy"]>[0]) {
    const errors = qaPolicyErrors(input.policy);
    if (errors.length > 0) throw new MediaQaError("invalid", errors.join(" "));
    const p = input.policy;
    const directVideo = p.directVideoAllowed === true;
    const values = [
      input.projectId,
      p.semanticMode,
      p.analyzer || null,
      p.externalMediaAllowed,
      p.maxCostPerRunUsd,
      p.maxCostPerDayUsd,
      input.by,
      input.now,
    ];
    // 0045 adds direct_video_allowed; `withColumn: false` is the 0044-only shape (it can only ever write "false")
    const write = (withColumn: boolean) =>
      this.tx(async (c) => {
        const r =
          input.expectedRevision === 0
            ? await c.query(
                `insert into project_qa_policies
                   (project_id, semantic_mode, analyzer, external_media_allowed, max_cost_per_run_usd,
                    max_cost_per_day_usd, revision, updated_by, updated_at${withColumn ? ", direct_video_allowed" : ""})
                 values ($1, $2, $3, $4, $5, $6, 1, $7, $8${withColumn ? ", $9" : ""})
                 on conflict (project_id) do nothing
                 returning *`,
                withColumn ? [...values, directVideo] : values,
              )
            : await c.query(
                `update project_qa_policies set
                   semantic_mode = $2, analyzer = $3, external_media_allowed = $4, max_cost_per_run_usd = $5,
                   max_cost_per_day_usd = $6, revision = revision + 1, updated_by = $7, updated_at = $8${
                     withColumn ? ", direct_video_allowed = $10" : ""
                   }
                 where project_id = $1 and revision = $9
                 returning *`,
                withColumn
                  ? [...values, input.expectedRevision, directVideo]
                  : [...values, input.expectedRevision],
              );
        return r.rows[0] ? mapQaPolicy(r.rows[0]) : null;
      });
    try {
      let saved: ProjectQaPolicy | null;
      try {
        saved = await write(true);
      } catch (err) {
        // before 0045 the column does not exist: "false" needs no column; "true" cannot be stored honestly
        if ((err as { code?: string }).code !== "42703") throw err;
        if (directVideo) throw new MediaQaError("not_migrated", NOT_MIGRATED_0045);
        saved = await write(false);
      }
      if (!saved)
        throw new MediaQaError(
          "conflict",
          "The Shot QA policy was changed elsewhere since this page loaded. Reload to see it, then try again.",
        );
      return saved;
    } catch (err) {
      if ((err as { code?: string }).code === "42P01") throw new MediaQaError("not_migrated", NOT_MIGRATED);
      throw err;
    }
  }

  async analysisSpentSince(projectId: string | null, sinceIso: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `select coalesce(sum(case
                  when f.kind = 'actual' then f.amount_usd
                  else e.amount_usd end), 0)::float8 as total
           from continuity_analysis_costs e
           left join continuity_analysis_costs f
             on f.job_id = e.job_id and f.kind in ('actual', 'unknown')
          where e.kind = 'estimated' and e.recorded_at >= $1::timestamptz
            and ($2::uuid is null or e.project_id = $2::uuid)`,
        [sinceIso, projectId],
      );
      return Number(r.rows[0].total);
    });
  }
}
