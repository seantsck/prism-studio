import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ZodType } from "zod";
import { assetSchema, generationAttemptSchema, type GenerationAttempt } from "@/domain/schemas";
import {
  ACTIVE_STATUSES,
  WORKABLE_STATUSES,
  assertTransition,
  isTerminal,
} from "@/domain/generation/job-state";
import { attemptStatusForJob } from "@/domain/generation/job-state-mirror";
import {
  generationCostSchema,
  generationEventSchema,
  generationJobSchema,
  generationOutputSchema,
  type GenerationCost,
  type GenerationEvent,
  type GenerationJob,
  type GenerationOutput,
} from "@/domain/generation/schemas";
import {
  GenerationSubmitError,
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
import { COLLECTIONS, flatFromRow, flatToRow, type CollectionSpec, type Row } from "./postgres-mapping";
import { upsertRow } from "./postgres-repository";

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

const jobSpec = (table: string, schema: ZodType, numeric: string[] = []): CollectionSpec => ({
  table,
  schema,
  json: [],
  numeric,
  projectScoped: true,
  virtual: [],
});
const JOB = jobSpec("generation_jobs", generationJobSchema, ["estimatedCost", "actualCost"]);
const OUTPUT = { ...jobSpec("generation_outputs", generationOutputSchema), json: ["provenance"] };
const COST = jobSpec("generation_costs", generationCostSchema, ["amount", "units"]);
const EVENT = jobSpec("generation_job_events", generationEventSchema);

const active = ACTIVE_STATUSES.map((s) => `'${s}'`).join(", ");
const workable = WORKABLE_STATUSES.map((s) => `'${s}'`).join(", ");

const parseJob = (r: Row): GenerationJob => generationJobSchema.parse(flatFromRow(r, JOB));
const parseOutput = (r: Row): GenerationOutput => generationOutputSchema.parse(flatFromRow(r, OUTPUT));
const parseCost = (r: Row): GenerationCost => generationCostSchema.parse(flatFromRow(r, COST));
const parseEvent = (r: Row): GenerationEvent => generationEventSchema.parse(flatFromRow(r, EVENT));
const parseAttempt = (r: Row): GenerationAttempt =>
  generationAttemptSchema.parse(flatFromRow(r, COLLECTIONS.attempts));

/** camelCase JobPatch key → column. Only these are ever written by the worker. */
const PATCH_COLUMNS: Record<string, string> = {
  providerJobId: "provider_job_id",
  providerStatus: "provider_status",
  nextRunAt: "next_run_at",
  attemptCount: "attempt_count",
  pollCount: "poll_count",
  submittedAt: "submitted_at",
  startedAt: "started_at",
  completedAt: "completed_at",
  failedAt: "failed_at",
  cancelledAt: "cancelled_at",
  cancelOutcome: "cancel_outcome",
  lastPolledAt: "last_polled_at",
  lastErrorCode: "last_error_code",
  lastErrorCategory: "last_error_category",
  lastErrorMessage: "last_error_message",
  actualCost: "actual_cost",
};

/**
 * Everything `loadProject` feeds into a generation package (see buildShotContext). Generation history
 * (attempts, jobs, costs, outputs) and continuity checks are deliberately absent: they are not package inputs,
 * and including them would make concurrent generations invalidate each other.
 */
const REVISION_SOURCES: Array<{ name: string; sql: string }> = [
  { name: "projects", sql: "select * from projects where id = $1" },
  ...[
    "project_bibles",
    "characters",
    "character_identity_refs",
    "character_looks",
    "voice_profiles",
    "locations",
    "props",
    "episodes",
    "scenes",
    "shots",
    "dialogue_lines",
    "action_blocks",
    "performance_directions",
    "performance_takes",
    "storyboard_frames",
  ].map((t) => ({ name: t, sql: `select * from ${q(t)} where project_id = $1` })),
  // Generated outputs are new assets created by the worker, not inputs of any package.
  { name: "assets", sql: "select * from assets where project_id = $1 and purpose <> 'generation_output'" },
  ...[
    ["scene_characters", "scenes", "scene_id"],
    ["scene_props", "scenes", "scene_id"],
    ["shot_characters", "shots", "shot_id"],
    ["shot_props", "shots", "shot_id"],
    ["shot_dialogue_lines", "shots", "shot_id"],
    ["shot_reference_assets", "shots", "shot_id"],
    ["shot_script_sources", "shots", "shot_id"],
  ].map(([t, parent, col]) => ({
    name: t!,
    sql: `select j.* from ${q(t!)} j join ${q(parent!)} p on p.id = j.${col} where p.project_id = $1`,
  })),
];

/** Row-content digest of all package inputs of one project, computed on `c`. */
async function readProjectRevision(c: PoolClient, projectId: string): Promise<string> {
  const h = createHash("sha256");
  for (const src of REVISION_SOURCES) {
    const r = await c.query(
      `select coalesce(md5(string_agg(x::text, E'\\n' order by x::text)), '') as d, count(*)::int as n
       from (${src.sql}) x`,
      [projectId],
    );
    h.update(`${src.name}:${r.rows[0].n}:${r.rows[0].d}|`);
  }
  return h.digest("hex");
}

/**
 * Postgres generation persistence. `preamble` decides the security context, exactly like the project
 * repositories: an RLS preamble for the application path, a plain `begin` for the worker.
 */
export class PostgresGenerationData implements GenerationRepository, GenerationStore {
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

  // ───────────────────────── GenerationRepository ─────────────────────────

  async projectRevision(slug: string) {
    return this.tx(async (c) => {
      // RLS limits this to the signed-in user's projects.
      const p = await c.query("select id from projects where slug = $1", [slug]);
      if (p.rowCount === 0) return null;
      const projectId = String(p.rows[0].id);
      return { projectId, revision: await readProjectRevision(c, projectId) };
    });
  }

  async createAttemptWithJob(input: CreateAttemptInput) {
    const a = input.attempt;
    return this.tx(async (c) => {
      // Serialises concurrent submits for this project: duplicate/limit checks below are race-free.
      const project = await c.query("select id from projects where id = $1 for update", [a.projectId]);
      if (project.rowCount === 0)
        throw new GenerationSubmitError("not_found", "That project no longer exists.");

      const replay = await c.query(
        "select * from generation_jobs where project_id = $1 and idempotency_key = $2",
        [a.projectId, input.job.idempotencyKey],
      );
      if (replay.rows[0]) {
        const job = parseJob(replay.rows[0]);
        const att = await c.query("select * from generation_attempts where id = $1", [job.attemptId]);
        return { attempt: parseAttempt(att.rows[0]), job, duplicate: true };
      }

      const shot = await c.query(
        "select date_trunc('milliseconds', updated_at) = $3::timestamptz as same from shots where id = $1 and project_id = $2",
        [a.shotId, a.projectId, input.expectedShotUpdatedAt],
      );
      if (shot.rowCount === 0) throw new GenerationSubmitError("not_found", "That shot no longer exists.");
      if (!shot.rows[0].same) {
        throw new GenerationSubmitError(
          "stale_shot",
          "This shot changed while you were preparing the generation. Review it and try again.",
        );
      }

      if (input.expectedProjectRevision !== null) {
        // Optimistic concurrency over EVERY package input (looks, takes, locations, assets, neighbours...).
        // The revision was read before the data the package was built from, so equality proves the frozen
        // package is exactly what is committed now.
        const current = await readProjectRevision(c, a.projectId);
        if (current !== input.expectedProjectRevision) {
          throw new GenerationSubmitError(
            "stale_package",
            "Something this shot depends on changed while you were preparing the generation. Review the shot and try again.",
          );
        }
      }

      const onShot = await c.query(
        `select 1 from generation_jobs j join generation_attempts t on t.id = j.attempt_id
         where t.shot_id = $1 and j.status in (${active}) limit 1`,
        [a.shotId],
      );
      if (onShot.rowCount) {
        throw new GenerationSubmitError(
          "duplicate_active",
          "A generation for this shot is already in progress. Wait for it to finish or cancel it first.",
        );
      }
      const open = await c.query(
        `select count(*)::int as n from generation_jobs where project_id = $1 and status in (${active})`,
        [a.projectId],
      );
      if (open.rows[0].n >= input.limits.maxActivePerProject) {
        throw new GenerationSubmitError(
          "project_busy",
          `This project already has ${open.rows[0].n} active generations (limit ${input.limits.maxActivePerProject}).`,
        );
      }
      const recent = await c.query(
        `select count(*)::int as n from generation_attempts
         where project_id = $1 and created_by is not distinct from $2::uuid
           and created_at > $3::timestamptz - interval '60 seconds'`,
        [a.projectId, a.createdBy, input.now],
      );
      if (recent.rows[0].n >= input.limits.maxSubmitsPerMinutePerUser) {
        throw new GenerationSubmitError(
          "throttled",
          "You are submitting generations too quickly. Wait a moment and try again.",
        );
      }

      const num = await c.query(
        "select coalesce(max(attempt_number), 0) + 1 as n from generation_attempts where shot_id = $1",
        [a.shotId],
      );
      const attempt: GenerationAttempt = generationAttemptSchema.parse({
        ...a,
        attemptNumber: Number(num.rows[0].n),
        status: "queued",
      });
      await upsertRow(c, "generation_attempts", {
        ...flatToRow(attempt, COLLECTIONS.attempts),
        project_id: a.projectId,
      });

      const jobRow: Row = {
        id: input.job.id,
        project_id: a.projectId,
        attempt_id: attempt.id,
        provider: attempt.provider,
        model: attempt.model,
        status: "queued",
        idempotency_key: input.job.idempotencyKey,
        queue_priority: input.job.queuePriority,
        max_attempts: input.job.maxAttempts,
        next_run_at: input.now,
        estimated_cost: input.estimate.amount,
        currency: input.job.currency,
        created_by: attempt.createdBy,
      };
      const cols = Object.keys(jobRow);
      const inserted = await c.query(
        `insert into generation_jobs (${cols.map(q).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
        cols.map((k) => jobRow[k]),
      );
      const job = parseJob(inserted.rows[0]);

      await c.query(
        `insert into generation_costs (project_id, attempt_id, job_id, provider, model, kind, amount, currency, basis, units, recorded_at)
         values ($1, $2, $3, $4, $5, 'estimated', $6, $7, $8, $9, $10)`,
        [
          a.projectId,
          attempt.id,
          job.id,
          attempt.provider,
          attempt.model,
          input.estimate.amount,
          input.estimate.currency,
          input.estimate.basis,
          input.estimate.units,
          input.now,
        ],
      );
      await c.query(
        `insert into generation_job_events (project_id, job_id, attempt_id, at, from_status, to_status, note)
         values ($1, $2, $3, $4, null, 'queued', 'Submitted by user')`,
        [a.projectId, job.id, attempt.id, input.now],
      );
      return { attempt, job, duplicate: false };
    });
  }

  async getJob(jobId: string) {
    const r = await this.tx(
      async (c) => (await c.query("select * from generation_jobs where id = $1", [jobId])).rows,
    );
    return r[0] ? parseJob(r[0]) : null;
  }

  private async views(c: PoolClient, attemptRows: Row[]): Promise<AttemptView[]> {
    if (attemptRows.length === 0) return [];
    const ids = attemptRows.map((r) => String(r.id));
    // One client, one query at a time (pg does not support overlapping queries on a connection).
    const jobs = await c.query(
      "select * from generation_jobs where attempt_id = any($1::uuid[]) order by created_at desc",
      [ids],
    );
    const outputs = await c.query(
      `select o.*, row_to_json(a.*) as asset_json from generation_outputs o
       join assets a on a.id = o.asset_id where o.attempt_id = any($1::uuid[]) order by o.position`,
      [ids],
    );
    const costs = await c.query(
      "select * from generation_costs where attempt_id = any($1::uuid[]) order by recorded_at",
      [ids],
    );
    return attemptRows.map((r) => {
      const id = String(r.id);
      return {
        attempt: parseAttempt(r),
        job: jobs.rows.filter((j) => j.attempt_id === id).map(parseJob)[0] ?? null,
        outputs: outputs.rows
          .filter((o) => o.attempt_id === id)
          .map((o) => {
            const { asset_json, ...outRow } = o as Row & { asset_json: Row };
            return {
              output: parseOutput(outRow),
              asset: assetSchema.parse(flatFromRow(asset_json, COLLECTIONS.assets)),
            };
          }),
        costs: costs.rows.filter((k) => k.attempt_id === id).map(parseCost),
      };
    });
  }

  async getAttemptView(attemptId: string) {
    return this.tx(async (c) => {
      const rows = (await c.query("select * from generation_attempts where id = $1", [attemptId])).rows;
      return (await this.views(c, rows))[0] ?? null;
    });
  }

  async listShotAttempts(shotId: string) {
    return this.tx(async (c) => {
      const rows = (
        await c.query("select * from generation_attempts where shot_id = $1 order by attempt_number", [
          shotId,
        ])
      ).rows;
      return this.views(c, rows);
    });
  }

  async listActiveProjectJobs(projectId: string) {
    return this.tx(async (c) =>
      (
        await c.query(
          `select * from generation_jobs where project_id = $1 and status in (${active}) order by created_at`,
          [projectId],
        )
      ).rows.map(parseJob),
    );
  }

  async listProjectGenerations(
    projectId: string,
    f: GenerationFilters = {},
  ): Promise<ProjectGenerationRow[]> {
    return this.tx(async (c) => {
      const where = ["a.project_id = $1"];
      const params: unknown[] = [projectId];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace("?", `$${params.length}`));
      };
      if (f.provider) add("a.provider = ?", f.provider);
      if (f.model) add("a.model = ?", f.model);
      if (f.review) add("a.review_status = ?", f.review);
      if (f.shotIds?.length) add("a.shot_id = any(?::uuid[])", f.shotIds);
      if (f.statuses?.length) add("j.status = any(?::text[])", f.statuses);
      const rows = (
        await c.query(
          `select a.id, a.shot_id, a.attempt_number, a.provider, a.model, a.status, a.review_status, a.approved,
                  a.rejection_categories, a.created_at, a.request_modality, a.output_asset_id,
                  to_json(j.*) as job_json,
                  (select amount from generation_costs k where k.attempt_id = a.id and k.kind = 'estimated') as est,
                  (select amount from generation_costs k where k.attempt_id = a.id and k.kind = 'actual') as act,
                  coalesce((select currency from generation_costs k where k.attempt_id = a.id limit 1), 'USD') as cur
           from generation_attempts a
           left join lateral (select * from generation_jobs x where x.attempt_id = a.id order by x.created_at desc limit 1) j on true
           where ${where.join(" and ")}
           order by a.created_at desc ${f.limit ? `limit ${Math.max(1, Math.floor(f.limit))}` : ""}`,
          params,
        )
      ).rows;
      return rows.map((r) => ({
        attempt: {
          id: String(r.id),
          shotId: String(r.shot_id),
          attemptNumber: r.attempt_number,
          provider: r.provider,
          model: r.model,
          status: r.status,
          reviewStatus: r.review_status,
          approved: r.approved,
          rejectionCategories: r.rejection_categories ?? [],
          createdAt: (r.created_at as Date).toISOString(),
          requestModality: r.request_modality,
        },
        job: r.job_json && r.job_json.id ? generationJobSchema.parse(jobFromJson(r.job_json)) : null,
        primaryAssetId: r.output_asset_id ? String(r.output_asset_id) : null,
        estimated: r.est == null ? null : Number(r.est),
        actual: r.act == null ? null : Number(r.act),
        currency: r.cur,
      }));
    });
  }

  async listJobEvents(jobId: string) {
    return this.tx(async (c) =>
      (
        await c.query("select * from generation_job_events where job_id = $1 order by at, id", [jobId])
      ).rows.map(parseEvent),
    );
  }

  async requestCancel(jobId: string, now: string) {
    return this.tx(async (c) => {
      const cur = (await c.query("select * from generation_jobs where id = $1 for update", [jobId])).rows[0];
      if (!cur) return null;
      const job = parseJob(cur);
      if (isTerminal(job.status) || job.status === "cancel_requested") return job;
      if (job.status === "queued") {
        const r = await c.query(
          `update generation_jobs set status = 'cancelled', cancel_requested_at = $2, cancelled_at = $2,
             cancel_outcome = 'local_only', lease_owner = null, lease_token = null, lease_expires_at = null
           where id = $1 returning *`,
          [jobId, now],
        );
        await c.query("update generation_attempts set status = 'cancelled' where id = $1", [job.attemptId]);
        await this.event(c, job, "queued", "cancelled", "Cancelled before submission", now);
        return parseJob(r.rows[0]);
      }
      const r = await c.query(
        `update generation_jobs set status = 'cancel_requested', cancel_requested_at = $2, next_run_at = $2
         where id = $1 returning *`,
        [jobId, now],
      );
      await this.event(c, job, job.status, "cancel_requested", "Cancellation requested by user", now);
      return parseJob(r.rows[0]);
    });
  }

  async reviewAttempt(attemptId: string, review: ReviewInput) {
    return this.tx(async (c) => {
      const cur = (await c.query("select * from generation_attempts where id = $1 for update", [attemptId]))
        .rows[0];
      if (!cur) return null;
      const attempt = parseAttempt(cur);
      if (review.status === "approved") {
        if (attempt.status !== "succeeded") throw new Error("Only a completed generation can be approved.");
        // Supersede the previously approved attempt of this shot (its history is untouched).
        await c.query(
          `update generation_attempts set approved = false, review_status = 'unreviewed', reviewed_at = null
           where shot_id = $1 and id <> $2 and approved`,
          [attempt.shotId, attemptId],
        );
      }
      const r = await c.query(
        `update generation_attempts set review_status = $2, approved = $3, rejection_categories = $4,
           rejection_reason = $5, notes = $6, reviewed_at = $7 where id = $1 returning *`,
        [
          attemptId,
          review.status,
          review.status === "approved",
          review.status === "rejected" ? review.categories : [],
          review.status === "rejected" ? review.reason : "",
          review.notes,
          review.status === "unreviewed" ? null : review.now,
        ],
      );
      return parseAttempt(r.rows[0]);
    });
  }

  // ───────────────────────── GenerationStore (worker) ─────────────────────────

  private async event(
    c: PoolClient,
    job: Pick<GenerationJob, "id" | "projectId" | "attemptId">,
    from: string | null,
    to: string,
    note: string,
    at: string,
  ) {
    await c.query(
      `insert into generation_job_events (project_id, job_id, attempt_id, at, from_status, to_status, note)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [job.projectId, job.id, job.attemptId, at, from, to, note],
    );
  }

  async claim(opts: {
    workerId: string;
    now: string;
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedJob[]> {
    return this.tx(async (c) => {
      const claimed = (
        await c.query(
          `with due as (
             select id from generation_jobs
             where status in (${workable}) and next_run_at <= $2::timestamptz
               and (lease_token is null or lease_expires_at <= $2::timestamptz)
             order by queue_priority desc, next_run_at asc
             limit $4
             for update skip locked
           )
           update generation_jobs j
              set lease_owner = $1, lease_token = gen_random_uuid()::text,
                  lease_expires_at = $2::timestamptz + ($3::int * interval '1 millisecond'), heartbeat_at = $2::timestamptz
             from due where j.id = due.id
           returning j.*`,
          [opts.workerId, opts.now, opts.leaseMs, opts.limit],
        )
      ).rows;
      if (claimed.length === 0) return [];
      const attempts = (
        await c.query(
          `select a.*, p.user_id as owner_user_id from generation_attempts a
           join projects p on p.id = a.project_id where a.id = any($1::uuid[])`,
          [claimed.map((r) => String(r.attempt_id))],
        )
      ).rows;
      return claimed.flatMap((r) => {
        const a = attempts.find((x) => String(x.id) === String(r.attempt_id));
        if (!a) return [];
        const { owner_user_id, ...attemptRow } = a as Row & { owner_user_id: string };
        return [{ job: parseJob(r), attempt: parseAttempt(attemptRow), ownerUserId: String(owner_user_id) }];
      });
    });
  }

  async heartbeat(jobId: string, leaseToken: string, now: string, leaseMs: number) {
    return this.tx(async (c) => {
      const r = await c.query(
        `update generation_jobs set heartbeat_at = $3::timestamptz,
           lease_expires_at = $3::timestamptz + ($4::int * interval '1 millisecond')
         where id = $1 and lease_token = $2`,
        [jobId, leaseToken, now, leaseMs],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  async update(jobId: string, leaseToken: string, patch: JobPatch, now: string) {
    return this.tx(async (c) => {
      const cur = (await c.query("select * from generation_jobs where id = $1 for update", [jobId])).rows[0];
      if (!cur || cur.lease_token !== leaseToken) throw new LeaseLostError(jobId);
      const job = parseJob(cur);
      const sets: string[] = [];
      const params: unknown[] = [];
      const put = (col: string, value: unknown) => {
        params.push(value);
        sets.push(`${q(col)} = $${params.length}`);
      };
      const nextStatus = patch.status && patch.status !== job.status ? patch.status : null;
      if (nextStatus) {
        assertTransition(job.status, nextStatus);
        put("status", nextStatus);
      }
      for (const [key, col] of Object.entries(PATCH_COLUMNS)) {
        const value = (patch as Record<string, unknown>)[key];
        if (value !== undefined) put(col, value);
      }
      const terminal = isTerminal(nextStatus ?? job.status);
      if (patch.releaseLease || terminal) {
        sets.push("lease_owner = null", "lease_token = null", "lease_expires_at = null");
      }
      params.push(jobId);
      const r = await c.query(
        `update generation_jobs set ${sets.length ? sets.join(", ") : "updated_at = now()"} where id = $${params.length} returning *`,
        params,
      );
      if (nextStatus) {
        await c.query("update generation_attempts set status = $2 where id = $1", [
          job.attemptId,
          attemptStatusForJob(nextStatus),
        ]);
        await this.event(c, job, job.status, nextStatus, patch.note ?? "", now);
      } else if (patch.note) {
        await this.event(c, job, job.status, job.status, patch.note, now);
      }
      return parseJob(r.rows[0]);
    });
  }

  async finalizeSuccess(input: FinalizeSuccess) {
    return this.tx(async (c) => {
      const cur = (await c.query("select * from generation_jobs where id = $1 for update", [input.jobId]))
        .rows[0];
      if (!cur || cur.lease_token !== input.leaseToken) throw new LeaseLostError(input.jobId);
      const job = parseJob(cur);
      assertTransition(job.status, "succeeded");

      for (const o of input.outputs) {
        const asset = assetSchema.parse(o.asset);
        await upsertRow(c, "assets", {
          ...flatToRow(asset, COLLECTIONS.assets),
          project_id: job.projectId,
        });
        await c.query(
          `insert into generation_outputs (project_id, attempt_id, asset_id, role, position, provenance, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            job.projectId,
            input.attemptId,
            asset.id,
            o.role,
            o.position,
            JSON.stringify(o.provenance),
            input.now,
          ],
        );
      }
      const primary = input.outputs.find((o) => o.role === "primary") ?? input.outputs[0];
      await c.query(
        `update generation_attempts set status = 'succeeded', output_asset_id = $2, duration_ms = $3, cost_usd = $4
         where id = $1`,
        [
          input.attemptId,
          primary?.asset.id ?? null,
          input.durationMs,
          input.cost.currency === "USD" ? input.cost.amount : null,
        ],
      );
      await c.query(
        `insert into generation_costs (project_id, attempt_id, job_id, provider, model, kind, amount, currency, basis, units, recorded_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict do nothing`,
        [
          job.projectId,
          input.attemptId,
          job.id,
          job.provider,
          job.model,
          input.cost.kind,
          input.cost.amount,
          input.cost.currency,
          input.cost.basis,
          input.cost.units,
          input.now,
        ],
      );
      const r = await c.query(
        `update generation_jobs set status = 'succeeded', completed_at = $2, provider_status = $3, actual_cost = $4,
           lease_owner = null, lease_token = null, lease_expires_at = null where id = $1 returning *`,
        [job.id, input.now, input.providerStatus, input.cost.amount],
      );
      await this.event(c, job, job.status, "succeeded", "Output saved to Prism Storage", input.now);
      return parseJob(r.rows[0]);
    });
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
  }) {
    await this.tx(async (c) => {
      await c.query(
        `insert into generation_costs (id, project_id, attempt_id, job_id, provider, model, kind, amount, currency, basis, recorded_at)
         values ($1, $2, $3, $4, $5, $6, 'unknown', null, $7, $8, $9) on conflict do nothing`,
        [
          randomUUID(),
          args.projectId,
          args.attemptId,
          args.jobId,
          args.provider,
          args.model,
          args.currency,
          args.basis,
          args.now,
        ],
      );
    });
  }
}

/** row_to_json() yields snake_case keys with ISO strings and numeric-as-string; normalise like flatFromRow. */
function jobFromJson(json: Record<string, unknown>): Record<string, unknown> {
  const row: Row = {};
  for (const [k, v] of Object.entries(json)) row[k] = v;
  const out = flatFromRow(row, JOB);
  for (const key of ["estimatedCost", "actualCost"]) if (out[key] != null) out[key] = Number(out[key]);
  return out;
}
