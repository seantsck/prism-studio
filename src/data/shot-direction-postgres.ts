import type { Pool, PoolClient } from "pg";
import type { DirectionReview } from "@/domain/story/shot-direction";
import {
  ShotDirectionError,
  type NewShotDirectionProposal,
  type ShotDirectionProposal,
  type ShotDirectionRepository,
  type ShotDirectionWorkerStore,
} from "./shot-direction-repository";
import { MAX_STORY_ATTEMPTS } from "./story-repository";

/**
 * Phase 5B-S5: Postgres Storyboard Direction Proposals (`shot_direction_proposals`, 0057).
 *   PostgresShotDirectionData         the signed-in user (RLS preamble): create, read, review, apply.
 *   PostgresShotDirectionWorkerStore  the Story worker role: claim and write results only.
 */
type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));
const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

export function mapShotDirection(r: Row): ShotDirectionProposal {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    episodeId: String(r.episode_id),
    sceneId: String(r.scene_id),
    shotId: String(r.shot_id),
    version: Number(r.version),
    parentId: (r.parent_id as string | null) ?? null,
    status: r.status as ShotDirectionProposal["status"],
    instruction: String(r.instruction ?? ""),
    sceneFingerprint: String(r.scene_fingerprint),
    shotFingerprint: String(r.shot_fingerprint),
    context: r.context as ShotDirectionProposal["context"],
    provider: String(r.provider),
    model: String(r.model),
    schemaVersion: String(r.schema_version),
    promptVersion: String(r.prompt_version),
    estimate: r.estimate as ShotDirectionProposal["estimate"],
    confirmedUsd: num(r.confirmed_usd),
    spendAuthorization: r.spend_authorization as ShotDirectionProposal["spendAuthorization"],
    direction: (r.direction as ShotDirectionProposal["direction"]) ?? null,
    usage: (r.usage as ShotDirectionProposal["usage"]) ?? null,
    actualUsd: num(r.actual_usd),
    providerCalls: Number(r.provider_calls ?? 0),
    error: (r.error as ShotDirectionProposal["error"]) ?? null,
    review: (r.review as DirectionReview | null) ?? null,
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

export class PostgresShotDirectionData implements ShotDirectionRepository {
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
      if (err instanceof ShotDirectionError) throw err;
      if (e.code === "P0001") throw new ShotDirectionError("invalid", e.message ?? "Refused.");
      if (e.code === "23503")
        throw new ShotDirectionError("invalid", "A referenced row is not in this project.");
      if (e.code === "42501")
        throw new ShotDirectionError("not_found", "That is not in one of your projects.");
      throw err;
    } finally {
      client.release();
    }
  }

  async create(p: NewShotDirectionProposal) {
    return this.tx(async (c) => {
      await c.query("select pg_advisory_xact_lock(hashtext('shot_direction_proposals:' || $1::text))", [
        p.shotId,
      ]);
      const r = await c.query(
        `insert into shot_direction_proposals (
           id, project_id, episode_id, scene_id, shot_id, version, parent_id, status, instruction, scene_fingerprint,
           shot_fingerprint, context, provider, model, schema_version, prompt_version, estimate, confirmed_usd,
           spend_authorization, next_run_at, created_by, created_at)
         values ($1, $2, $3, $4, $5, (select coalesce(max(version), 0) + 1 from shot_direction_proposals where shot_id = $5),
           $6, 'queued', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $19, $18, $19)
         returning *`,
        [
          p.id,
          p.projectId,
          p.episodeId,
          p.sceneId,
          p.shotId,
          p.parentId,
          p.instruction,
          p.sceneFingerprint,
          p.shotFingerprint,
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
      return mapShotDirection(r.rows[0] as Row);
    });
  }

  async listForShot(projectId: string, shotId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from shot_direction_proposals where project_id = $1 and shot_id = $2 order by version desc",
        [projectId, shotId],
      );
      return r.rows.map((x) => mapShotDirection(x as Row));
    });
  }

  async listForProject(projectId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from shot_direction_proposals where project_id = $1 order by version desc",
        [projectId],
      );
      return r.rows.map((x) => mapShotDirection(x as Row));
    });
  }

  async get(projectId: string, id: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from shot_direction_proposals where id = $1 and project_id = $2", [
        id,
        projectId,
      ]);
      return r.rows[0] ? mapShotDirection(r.rows[0] as Row) : null;
    });
  }

  private async refuse(c: PoolClient, projectId: string, id: string): Promise<never> {
    const s = await c.query("select status from shot_direction_proposals where id = $1 and project_id = $2", [
      id,
      projectId,
    ]);
    const status = s.rows[0]?.status as string | undefined;
    if (!status) throw new ShotDirectionError("not_found", "That direction no longer exists.");
    if (status === "applied") throw new ShotDirectionError("applied", "This direction was already applied.");
    throw new ShotDirectionError("conflict", "This direction is not ready yet.");
  }

  async saveReview(projectId: string, id: string, review: DirectionReview) {
    await this.tx(async (c) => {
      const r = await c.query(
        "update shot_direction_proposals set review = $3 where id = $1 and project_id = $2 and status = 'ready' returning id",
        [id, projectId, json(review)],
      );
      if (r.rowCount === 0) await this.refuse(c, projectId, id);
    });
  }

  async markApplied(projectId: string, id: string, summary: Record<string, unknown>, now: string) {
    await this.tx(async (c) => {
      const r = await c.query(
        `update shot_direction_proposals set status = 'applied', applied_summary = $3, applied_at = $4
          where id = $1 and project_id = $2 and status = 'ready' returning id`,
        [id, projectId, json(summary), now],
      );
      if (r.rowCount === 0) await this.refuse(c, projectId, id);
    });
  }
}

export class PostgresShotDirectionWorkerStore implements ShotDirectionWorkerStore {
  constructor(private readonly pool: Pool) {}

  async claim(workerId: string, leaseMs: number, now: string) {
    const r = await this.pool.query(
      `update shot_direction_proposals set status = 'running', attempts = attempts + 1, lease_owner = $1,
              lease_expires_at = $2::timestamptz
        where id = (select id from shot_direction_proposals where status = 'queued' and next_run_at <= $3::timestamptz
                     order by created_at limit 1 for update skip locked)
        returning *`,
      [workerId, new Date(Date.parse(now) + leaseMs).toISOString(), now],
    );
    return r.rows[0] ? mapShotDirection(r.rows[0] as Row) : null;
  }

  async expireAbandoned(now: string) {
    const r = await this.pool.query(
      `update shot_direction_proposals set status = 'failed', completed_at = $1::timestamptz,
              lease_expires_at = now() + interval '1 minute',
              error = '{"code":"ambiguous_interrupted","message":"Shot direction was interrupted and may have reached the provider; it is not re-sent. Direct again."}'
        where status = 'running' and lease_expires_at < $1::timestamptz`,
      [now],
    );
    return r.rowCount ?? 0;
  }

  private async owned(sql: string, params: unknown[]) {
    const r = await this.pool.query(sql, params);
    if (r.rowCount === 0)
      throw new ShotDirectionError("conflict", "The direction is no longer leased by this worker.");
  }

  async complete(id: string, workerId: string, res: Parameters<ShotDirectionWorkerStore["complete"]>[2]) {
    await this.owned(
      `update shot_direction_proposals set status = 'ready', direction = $3, usage = $4, actual_usd = $5,
              provider_calls = provider_calls + $6, completed_at = $7
        where id = $1 and status = 'running' and lease_owner = $2`,
      [id, workerId, json(res.direction), json(res.usage), res.actualUsd, res.providerCalls, res.now],
    );
  }

  async fail(id: string, workerId: string, res: Parameters<ShotDirectionWorkerStore["fail"]>[2]) {
    await this.owned(
      `update shot_direction_proposals set status = 'failed', error = $3, usage = $4, actual_usd = $5,
              provider_calls = provider_calls + $6, completed_at = $7
        where id = $1 and status = 'running' and lease_owner = $2`,
      [id, workerId, json(res.error), json(res.usage), res.actualUsd, res.providerCalls, res.now],
    );
  }

  async retryLater(id: string, workerId: string, nextRunAt: string, providerCalls: number) {
    await this.owned(
      `update shot_direction_proposals
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
