import type { Pool, PoolClient } from "pg";
import {
  ANALYSIS_ACTIVE,
  assertAnalysisTransition,
  isAnalysisTerminal,
} from "@/domain/continuity/analysis/job-state";
import { mapAnalysisJob } from "./media-qa-postgres";
import {
  AnalysisLeaseLostError,
  type AnalysisJob,
  type AnalysisJobPatch,
  type AnalysisWorkerStore,
  type ClaimedAnalysisJob,
  type FinalizeAnalysisFailure,
  type FinalizeAnalysisSuccess,
  type InputAssetRef,
} from "./media-qa-repository";

const active = ANALYSIS_ACTIVE.map((s) => `'${s}'`).join(", ");

const COLUMNS: Record<string, string> = {
  nextRunAt: "next_run_at",
  attemptCount: "attempt_count",
  providerState: "provider_state",
  providerRef: "provider_ref",
  batchesTotal: "batches_total",
  batchesDone: "batches_done",
  correctionCount: "correction_count",
  actualCostUsd: "actual_cost_usd",
  lastErrorCode: "last_error_code",
  lastErrorCategory: "last_error_category",
  lastErrorMessage: "last_error_message",
  startedAt: "started_at",
};

/**
 * Worker-side persistence for continuity analysis. Connects as `prism_continuity_worker` (no SET ROLE, no admin
 * credential): every statement below is what that role's grants and RLS policies (migrations 0022–0024) allow,
 * and nothing more. It never reads or writes creative content, overrides, approvals or generation tables.
 */
export class PostgresAnalysisWorkerStore implements AnalysisWorkerStore {
  constructor(
    private readonly pool: Pool,
    private readonly preamble = "begin",
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

  async claim(opts: {
    workerId: string;
    now: string;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedAnalysisJob[]> {
    return this.tx(async (c) => {
      const rows = (
        await c.query(
          `with due as (
             select id from continuity_analysis_jobs
             where status in (${active}) and next_run_at <= $2::timestamptz
               and (lease_token is null or lease_expires_at <= $2::timestamptz)
             order by next_run_at asc
             limit $4
             for update skip locked
           )
           update continuity_analysis_jobs j
              set status = case when j.status = 'queued' then 'claimed' else j.status end,
                  lease_owner = $1, lease_token = gen_random_uuid()::text,
                  lease_expires_at = $2::timestamptz + ($3::int * interval '1 millisecond'),
                  heartbeat_at = $2::timestamptz
             from due where j.id = due.id
           returning j.*`,
          [opts.workerId, opts.now, opts.leaseMs, opts.limit],
        )
      ).rows;
      return rows.map((r) => ({ job: mapAnalysisJob(r) }));
    });
  }

  async heartbeat(jobId: string, leaseToken: string, now: string, leaseMs: number) {
    return this.tx(async (c) => {
      const r = await c.query(
        `update continuity_analysis_jobs set heartbeat_at = $3::timestamptz,
           lease_expires_at = $3::timestamptz + ($4::int * interval '1 millisecond')
         where id = $1 and lease_token = $2`,
        [jobId, leaseToken, now, leaseMs],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  async update(
    jobId: string,
    leaseToken: string,
    patch: AnalysisJobPatch,
    now: string,
  ): Promise<AnalysisJob> {
    return this.tx(async (c) => {
      const cur = (await c.query("select * from continuity_analysis_jobs where id = $1 for update", [jobId]))
        .rows[0];
      if (!cur || cur.lease_token !== leaseToken) throw new AnalysisLeaseLostError(jobId);
      const job = mapAnalysisJob(cur);
      const sets: string[] = [];
      const params: unknown[] = [];
      const add = (col: string, val: unknown, cast = "") => {
        params.push(val);
        sets.push(`${col} = $${params.length}${cast}`);
      };
      if (patch.status && patch.status !== job.status) {
        assertAnalysisTransition(job.status, patch.status);
        add("status", patch.status);
        if (patch.status === "failed") add("failed_at", now, "::timestamptz");
        if (patch.status === "succeeded") add("completed_at", now, "::timestamptz");
        if (patch.status === "cancelled") add("cancelled_at", now, "::timestamptz");
      }
      for (const [k, col] of Object.entries(COLUMNS)) {
        const v = (patch as Record<string, unknown>)[k];
        if (v !== undefined)
          add(col, v, col === "next_run_at" || col === "started_at" ? "::timestamptz" : "");
      }
      if (patch.providerFiles !== undefined)
        add("provider_files", JSON.stringify(patch.providerFiles), "::jsonb");
      const terminal = patch.status ? isAnalysisTerminal(patch.status) : false;
      if (patch.releaseLease || terminal) {
        sets.push("lease_owner = null", "lease_token = null", "lease_expires_at = null");
      }
      if (sets.length === 0) return job;
      params.push(jobId);
      const r = await c.query(
        `update continuity_analysis_jobs set ${sets.join(", ")} where id = $${params.length} returning *`,
        params,
      );
      if (patch.status && patch.status !== job.status) {
        await c.query(
          `insert into continuity_analysis_events (project_id, job_id, run_id, at, from_status, to_status, note)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [job.projectId, job.id, job.runId, now, job.status, patch.status, patch.note ?? ""],
        );
      }
      return mapAnalysisJob(r.rows[0]);
    });
  }

  async startRun(runId: string) {
    await this.tx(async (c) => {
      await c.query(
        "update continuity_runs set analysis_status = 'running' where id = $1 and analysis_status = 'queued'",
        [runId],
      );
    });
  }

  async findInputAsset(jobId: string, assetId: string): Promise<InputAssetRef | null> {
    return this.tx(async (c) => {
      const r = await c.query(
        `select a.id, a.object_path, a.bucket, a.storage_provider, a.mime, a.byte_size, a.checksum, a.width, a.height
           from continuity_analysis_jobs j join assets a on a.id = any (j.input_asset_ids) and a.project_id = j.project_id
          where j.id = $1 and a.id = $2`,
        [jobId, assetId],
      );
      const a = r.rows[0];
      return a
        ? {
            assetId: String(a.id),
            objectPath: a.object_path ?? null,
            bucket: a.bucket ?? null,
            storageProvider: String(a.storage_provider),
            mime: a.mime ?? null,
            byteSize: a.byte_size == null ? null : Number(a.byte_size),
            checksum: a.checksum ?? null,
            width: a.width == null ? null : Number(a.width),
            height: a.height == null ? null : Number(a.height),
          }
        : null;
    });
  }

  private async insertCost(
    c: PoolClient,
    job: AnalysisJob,
    cost: FinalizeAnalysisSuccess["cost"],
    now: string,
  ) {
    await c.query(
      `insert into continuity_analysis_costs
         (project_id, run_id, job_id, analyzer, model, kind, amount_usd, usage, pricing_version, recorded_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
        job.projectId,
        job.runId,
        job.id,
        cost.analyzer,
        cost.model,
        cost.kind,
        cost.kind === "actual" ? cost.amountUsd : null,
        JSON.stringify(cost.usage),
        cost.pricingVersion,
        now,
      ],
    );
  }

  async finalizeSuccess(input: FinalizeAnalysisSuccess): Promise<AnalysisJob> {
    return this.tx(async (c) => {
      const cur = (
        await c.query("select * from continuity_analysis_jobs where id = $1 for update", [input.jobId])
      ).rows[0];
      if (!cur || cur.lease_token !== input.leaseToken) throw new AnalysisLeaseLostError(input.jobId);
      const job = mapAnalysisJob(cur);
      if (isAnalysisTerminal(job.status)) return job;
      const final = await c.query(
        "select 1 from continuity_analysis_costs where job_id = $1 and kind in ('actual', 'unknown')",
        [job.id],
      );
      if (final.rowCount) return job; // exactly one final result per job
      for (const f of input.findings) {
        await c.query(
          `update continuity_findings
              set result = $3, actual = $4, confidence = $5, notes = $6, evidence = $7::jsonb, result_source = 'analyzer'
            where run_id = $1 and criterion_key = $2`,
          [
            input.runId,
            f.criterionKey,
            f.result,
            f.summary,
            f.confidence,
            f.limitations.join("; "),
            JSON.stringify({
              items: f.evidence,
              contradictions: f.contradictions,
              limitations: f.limitations,
              analyzer: job.analyzer,
              model: job.model,
            }),
          ],
        );
      }
      await c.query(
        "update continuity_runs set analysis_status = 'complete', completed_at = $2 where id = $1",
        [input.runId, input.now],
      );
      await this.insertCost(c, job, input.cost, input.now);
      const r = await c.query(
        `update continuity_analysis_jobs
            set status = 'succeeded', completed_at = $2, provider_ref = $3, provider_state = 'responded',
                correction_count = $4, actual_cost_usd = $5, batches_done = batches_total,
                lease_owner = null, lease_token = null, lease_expires_at = null
          where id = $1 returning *`,
        [
          job.id,
          input.now,
          input.providerRef,
          input.correctionCount,
          input.cost.kind === "actual" ? input.cost.amountUsd : null,
        ],
      );
      await c.query(
        `insert into continuity_analysis_events (project_id, job_id, run_id, at, from_status, to_status, note)
         values ($1, $2, $3, $4, $5, 'succeeded', $6)`,
        [job.projectId, job.id, job.runId, input.now, job.status, input.note],
      );
      return mapAnalysisJob(r.rows[0]);
    });
  }

  async finalizeFailure(input: FinalizeAnalysisFailure): Promise<AnalysisJob> {
    return this.tx(async (c) => {
      const cur = (
        await c.query("select * from continuity_analysis_jobs where id = $1 for update", [input.jobId])
      ).rows[0];
      if (!cur || cur.lease_token !== input.leaseToken) throw new AnalysisLeaseLostError(input.jobId);
      const job = mapAnalysisJob(cur);
      if (isAnalysisTerminal(job.status)) return job;
      await c.query(
        "update continuity_runs set analysis_status = 'failed', analysis_error = $2, completed_at = $3 where id = $1",
        [input.runId, input.errorMessage.slice(0, 300), input.now],
      );
      let actual: number | null = null;
      if (input.cost) {
        const final = await c.query(
          "select 1 from continuity_analysis_costs where job_id = $1 and kind in ('actual', 'unknown')",
          [job.id],
        );
        if (!final.rowCount) {
          await this.insertCost(c, job, input.cost, input.now);
          actual = input.cost.kind === "actual" ? input.cost.amountUsd : null;
        }
      }
      const to = input.cancelled ? "cancelled" : "failed";
      assertAnalysisTransition(job.status, to);
      const r = await c.query(
        `update continuity_analysis_jobs
            set status = $7, failed_at = case when $7 = 'failed' then $2::timestamptz else failed_at end,
                cancelled_at = case when $7 = 'cancelled' then $2::timestamptz else cancelled_at end,
                last_error_code = $3, last_error_category = $4,
                last_error_message = $5, actual_cost_usd = coalesce($6::numeric, actual_cost_usd),
                lease_owner = null, lease_token = null, lease_expires_at = null
          where id = $1 returning *`,
        [
          job.id,
          input.now,
          input.errorCode,
          input.errorCategory,
          input.errorMessage.slice(0, 300),
          actual,
          to,
        ],
      );
      await c.query(
        `insert into continuity_analysis_events (project_id, job_id, run_id, at, from_status, to_status, note)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [job.projectId, job.id, job.runId, input.now, job.status, to, input.errorMessage.slice(0, 300)],
      );
      return mapAnalysisJob(r.rows[0]);
    });
  }

  async spentSince(sinceIso: string): Promise<number> {
    return this.tx(async (c) => {
      const r = await c.query(
        `select coalesce(sum(case when f.kind = 'actual' then f.amount_usd else e.amount_usd end), 0)::float8 as total
           from continuity_analysis_costs e
           left join continuity_analysis_costs f
             on f.job_id = e.job_id and f.kind in ('actual', 'unknown')
          where e.kind = 'estimated' and e.recorded_at >= $1::timestamptz`,
        [sinceIso],
      );
      return Number(r.rows[0].total);
    });
  }
}
