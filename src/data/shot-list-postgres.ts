import type { Pool, PoolClient } from "pg";
import type { ShotListReview } from "@/domain/story/shot-list-review";
import {
  ShotListError,
  type NewShotListProposal,
  type ShotListProposal,
  type ShotListRepository,
  type ShotListWorkerStore,
} from "./shot-list-repository";
import { MAX_STORY_ATTEMPTS } from "./story-repository";

/**
 * Phase 5B-S4: Postgres Shot List Proposals (`shot_list_proposals`, 0056).
 *   PostgresShotListData         the signed-in user (RLS preamble): create, read, review, apply.
 *   PostgresShotListWorkerStore  the Story worker role: claim and write results only.
 */
type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));
const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

export function mapShotList(r: Row): ShotListProposal {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    episodeId: String(r.episode_id),
    sceneId: String(r.scene_id),
    version: Number(r.version),
    parentId: (r.parent_id as string | null) ?? null,
    status: r.status as ShotListProposal["status"],
    scope: r.scope as ShotListProposal["scope"],
    basePlan: (r.base_plan as ShotListProposal["basePlan"]) ?? null,
    episodeFingerprint: String(r.episode_fingerprint),
    sceneFingerprint: String(r.scene_fingerprint),
    baseRevisionId: (r.base_revision_id as string | null) ?? null,
    sceneText: String(r.scene_text),
    context: r.context as ShotListProposal["context"],
    provider: String(r.provider),
    model: String(r.model),
    schemaVersion: String(r.schema_version),
    promptVersion: String(r.prompt_version),
    estimate: r.estimate as ShotListProposal["estimate"],
    confirmedUsd: num(r.confirmed_usd),
    spendAuthorization: r.spend_authorization as ShotListProposal["spendAuthorization"],
    plan: (r.plan as ShotListProposal["plan"]) ?? null,
    usage: (r.usage as ShotListProposal["usage"]) ?? null,
    actualUsd: num(r.actual_usd),
    providerCalls: Number(r.provider_calls ?? 0),
    error: (r.error as ShotListProposal["error"]) ?? null,
    review: (r.review as ShotListReview | null) ?? null,
    appliedSummary: (r.applied_summary as Record<string, unknown> | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    nextRunAt: iso(r.next_run_at)!,
    leaseOwner: (r.lease_owner as string | null) ?? null,
    leaseExpiresAt: iso(r.lease_expires_at),
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: iso(r.created_at)!,
    completedAt: iso(r.completed_at),
    appliedAt: iso(r.applied_at),
  };
}

export class PostgresShotListData implements ShotListRepository {
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
      const e = err as { code?: string; message?: string };
      if (err instanceof ShotListError) throw err;
      if (e.code === "P0001") throw new ShotListError("invalid", e.message ?? "Refused.");
      if (e.code === "23503") throw new ShotListError("invalid", "A referenced row is not in this project.");
      if (e.code === "42501") throw new ShotListError("not_found", "That is not in one of your projects.");
      throw err;
    } finally {
      client.release();
    }
  }

  async create(p: NewShotListProposal) {
    return this.tx(async (c) => {
      await c.query("select pg_advisory_xact_lock(hashtext('shot_list_proposals:' || $1::text))", [
        p.sceneId,
      ]);
      const r = await c.query(
        `insert into shot_list_proposals (
           id, project_id, episode_id, scene_id, version, parent_id, status, scope, base_plan, episode_fingerprint,
           scene_fingerprint, base_revision_id, scene_text, context, provider, model, schema_version, prompt_version,
           estimate, confirmed_usd, spend_authorization, next_run_at, created_by, created_at)
         values ($1, $2, $3, $4, (select coalesce(max(version), 0) + 1 from shot_list_proposals where scene_id = $4),
           $5, 'queued', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $21, $20, $21)
         returning *`,
        [
          p.id,
          p.projectId,
          p.episodeId,
          p.sceneId,
          p.parentId,
          json(p.scope),
          json(p.basePlan),
          p.episodeFingerprint,
          p.sceneFingerprint,
          p.baseRevisionId,
          p.sceneText,
          json(p.context),
          p.provider,
          p.model,
          p.schemaVersion,
          p.promptVersion,
          json(p.estimate),
          p.confirmedUsd,
          p.spendAuthorization,
          p.createdBy,
          p.createdAt,
        ],
      );
      return mapShotList(r.rows[0] as Row);
    });
  }

  async listForScene(projectId: string, sceneId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from shot_list_proposals where project_id = $1 and scene_id = $2 order by version desc",
        [projectId, sceneId],
      );
      return r.rows.map((x) => mapShotList(x as Row));
    });
  }

  async get(projectId: string, id: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from shot_list_proposals where id = $1 and project_id = $2", [
        id,
        projectId,
      ]);
      return r.rows[0] ? mapShotList(r.rows[0] as Row) : null;
    });
  }

  private async refuse(c: PoolClient, projectId: string, id: string): Promise<never> {
    const s = await c.query("select status from shot_list_proposals where id = $1 and project_id = $2", [
      id,
      projectId,
    ]);
    const status = s.rows[0]?.status as string | undefined;
    if (!status) throw new ShotListError("not_found", "That shot list no longer exists.");
    if (status === "applied") throw new ShotListError("applied", "This shot list was already applied.");
    throw new ShotListError("conflict", "This shot list is not ready yet.");
  }

  async saveReview(projectId: string, id: string, review: ShotListReview) {
    await this.tx(async (c) => {
      const r = await c.query(
        "update shot_list_proposals set review = $3 where id = $1 and project_id = $2 and status = 'ready' returning id",
        [id, projectId, json(review)],
      );
      if (r.rowCount === 0) await this.refuse(c, projectId, id);
    });
  }

  async markApplied(projectId: string, id: string, summary: Record<string, unknown>, now: string) {
    await this.tx(async (c) => {
      const r = await c.query(
        `update shot_list_proposals set status = 'applied', applied_summary = $3, applied_at = $4
          where id = $1 and project_id = $2 and status = 'ready' returning id`,
        [id, projectId, json(summary), now],
      );
      if (r.rowCount === 0) await this.refuse(c, projectId, id);
    });
  }
}

export class PostgresShotListWorkerStore implements ShotListWorkerStore {
  constructor(private readonly pool: Pool) {}

  async claim(workerId: string, leaseMs: number, now: string) {
    const r = await this.pool.query(
      `update shot_list_proposals set status = 'running', attempts = attempts + 1, lease_owner = $1,
              lease_expires_at = $2::timestamptz
        where id = (select id from shot_list_proposals where status = 'queued' and next_run_at <= $3::timestamptz
                     order by created_at limit 1 for update skip locked)
        returning *`,
      [workerId, new Date(Date.parse(now) + leaseMs).toISOString(), now],
    );
    return r.rows[0] ? mapShotList(r.rows[0] as Row) : null;
  }

  async expireAbandoned(now: string) {
    const r = await this.pool.query(
      `update shot_list_proposals set status = 'failed', completed_at = $1::timestamptz,
              lease_expires_at = now() + interval '1 minute',
              error = '{"code":"ambiguous_interrupted","message":"Shot planning was interrupted and may have reached the provider; it is not re-sent. Plan again."}'
        where status = 'running' and lease_expires_at < $1::timestamptz`,
      [now],
    );
    return r.rowCount ?? 0;
  }

  private async owned(sql: string, params: unknown[]) {
    const r = await this.pool.query(sql, params);
    if (r.rowCount === 0)
      throw new ShotListError("conflict", "The shot list is no longer leased by this worker.");
  }

  async complete(id: string, workerId: string, res: Parameters<ShotListWorkerStore["complete"]>[2]) {
    await this.owned(
      `update shot_list_proposals set status = 'ready', plan = $3, usage = $4, actual_usd = $5,
              provider_calls = provider_calls + $6, completed_at = $7
        where id = $1 and status = 'running' and lease_owner = $2`,
      [id, workerId, json(res.plan), json(res.usage), res.actualUsd, res.providerCalls, res.now],
    );
  }

  async fail(id: string, workerId: string, res: Parameters<ShotListWorkerStore["fail"]>[2]) {
    await this.owned(
      `update shot_list_proposals set status = 'failed', error = $3, usage = $4, actual_usd = $5,
              provider_calls = provider_calls + $6, completed_at = $7
        where id = $1 and status = 'running' and lease_owner = $2`,
      [id, workerId, json(res.error), json(res.usage), res.actualUsd, res.providerCalls, res.now],
    );
  }

  async retryLater(id: string, workerId: string, nextRunAt: string, providerCalls: number) {
    await this.owned(
      `update shot_list_proposals
          set status = case when attempts >= ${MAX_STORY_ATTEMPTS} then 'failed' else 'queued' end,
              error = case when attempts >= ${MAX_STORY_ATTEMPTS}
                then '{"code":"provider_busy","message":"The provider stayed busy; try again later."}'::jsonb else null end,
              completed_at = case when attempts >= ${MAX_STORY_ATTEMPTS} then $3::timestamptz else null end,
              next_run_at = $3::timestamptz, provider_calls = provider_calls + $4,
              lease_owner = case when attempts >= ${MAX_STORY_ATTEMPTS} then lease_owner else null end,
              lease_expires_at = case when attempts >= ${MAX_STORY_ATTEMPTS} then lease_expires_at else null end
        where id = $1 and status = 'running' and lease_owner = $2`,
      [id, workerId, nextRunAt, providerCalls],
    );
  }
}
