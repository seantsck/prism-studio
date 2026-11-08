import type { Pool, PoolClient } from "pg";
import type { ProposalReview } from "@/domain/story/review";
import {
  MAX_STORY_ATTEMPTS,
  StoryProposalError,
  type NewStoryProposal,
  type StoryProposalRecord,
  type StoryProposalRepository,
  type StoryWorkerStore,
} from "./story-repository";

/**
 * Phase 5B-S1: Postgres Production Proposals (`story_proposals`, 0054).
 *   PostgresStoryData        the signed-in user (RLS preamble): create, read, review, apply.
 *   PostgresStoryWorkerStore the Story worker role (`prism_story_worker`): claim and write results only.
 * Immutability (frozen input, write-once result, frozen review after apply) is ALSO enforced by a database trigger.
 */
type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));

export function mapStoryRow(r: Row): StoryProposalRecord {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    version: Number(r.version),
    parentId: (r.parent_id as string | null) ?? null,
    status: r.status as StoryProposalRecord["status"],
    scope: r.scope as StoryProposalRecord["scope"],
    sourceKind: r.source_kind as StoryProposalRecord["sourceKind"],
    sourceAssetId: (r.source_asset_id as string | null) ?? null,
    sourceEpisodeId: (r.source_episode_id as string | null) ?? null,
    sourceFingerprint: String(r.source_fingerprint),
    sourceMeta: r.source_meta as StoryProposalRecord["sourceMeta"],
    inputText: String(r.input_text),
    title: (r.title as string | null) ?? null,
    baseProposal: (r.base_proposal as StoryProposalRecord["baseProposal"]) ?? null,
    provider: String(r.provider),
    model: String(r.model),
    schemaVersion: String(r.schema_version),
    promptVersion: String(r.prompt_version),
    estimate: r.estimate as StoryProposalRecord["estimate"],
    confirmedUsd: num(r.confirmed_usd),
    proposal: (r.proposal as StoryProposalRecord["proposal"]) ?? null,
    usage: (r.usage as StoryProposalRecord["usage"]) ?? null,
    actualUsd: num(r.actual_usd),
    providerCalls: Number(r.provider_calls ?? 0),
    error: (r.error as StoryProposalRecord["error"]) ?? null,
    review: (r.review as ProposalReview | null) ?? null,
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

const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

export class PostgresStoryData implements StoryProposalRepository {
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
      if (e.code === "P0001")
        throw new StoryProposalError("invalid", e.message ?? "The proposal was refused.");
      if (e.code === "23503")
        throw new StoryProposalError("invalid", "A referenced row is not in this project.");
      throw err;
    } finally {
      client.release();
    }
  }

  async create(input: NewStoryProposal): Promise<StoryProposalRecord> {
    return this.tx(async (c) => {
      // one version sequence per project, serialised per project
      await c.query("select pg_advisory_xact_lock(hashtext('story_proposals:' || $1::text))", [
        input.projectId,
      ]);
      const r = await c.query(
        `insert into story_proposals (
           id, project_id, version, parent_id, status, scope, source_kind, source_asset_id, source_episode_id,
           source_fingerprint, source_meta, input_text, title, base_proposal, provider, model, schema_version,
           prompt_version, estimate, confirmed_usd, next_run_at, created_by, created_at)
         values ($1, $2, (select coalesce(max(version), 0) + 1 from story_proposals where project_id = $2), $3,
           'queued', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $19)
         returning *`,
        [
          input.id,
          input.projectId,
          input.parentId,
          json(input.scope),
          input.sourceKind,
          input.sourceAssetId,
          input.sourceEpisodeId,
          input.sourceFingerprint,
          json(input.sourceMeta),
          input.inputText,
          input.title,
          json(input.baseProposal),
          input.provider,
          input.model,
          input.schemaVersion,
          input.promptVersion,
          json(input.estimate),
          input.confirmedUsd,
          input.createdAt,
          input.createdBy,
        ],
      );
      return mapStoryRow(r.rows[0] as Row);
    });
  }

  async list(projectId: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from story_proposals where project_id = $1 order by version desc", [
        projectId,
      ]);
      return r.rows.map((x) => mapStoryRow(x as Row));
    });
  }

  async get(projectId: string, id: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from story_proposals where id = $1 and project_id = $2", [
        id,
        projectId,
      ]);
      return r.rows[0] ? mapStoryRow(r.rows[0] as Row) : null;
    });
  }

  async saveReview(projectId: string, id: string, review: ProposalReview) {
    await this.tx(async (c) => {
      const r = await c.query(
        "update story_proposals set review = $3 where id = $1 and project_id = $2 and status = 'ready' returning id",
        [id, projectId, json(review)],
      );
      if (r.rowCount === 0) await this.refuse(c, projectId, id);
    });
  }

  async markApplied(projectId: string, id: string, summary: Record<string, unknown>, now: string) {
    await this.tx(async (c) => {
      const r = await c.query(
        `update story_proposals set status = 'applied', applied_summary = $3, applied_at = $4
          where id = $1 and project_id = $2 and status = 'ready' returning id`,
        [id, projectId, json(summary), now],
      );
      if (r.rowCount === 0) await this.refuse(c, projectId, id);
    });
  }

  private async refuse(c: PoolClient, projectId: string, id: string): Promise<never> {
    const s = await c.query("select status from story_proposals where id = $1 and project_id = $2", [
      id,
      projectId,
    ]);
    const status = s.rows[0]?.status as string | undefined;
    if (!status) throw new StoryProposalError("not_found", "That proposal no longer exists.");
    if (status === "applied") throw new StoryProposalError("applied", "This proposal was already applied.");
    throw new StoryProposalError("conflict", "This proposal is not ready.");
  }

  async usesAsset(assetId: string) {
    return this.tx(async (c) => {
      const r = await c.query("select 1 from story_proposals where source_asset_id = $1 limit 1", [assetId]);
      return (r.rowCount ?? 0) > 0;
    });
  }
}

/** The Story worker (database role `prism_story_worker`): claim, then write each result once. */
export class PostgresStoryWorkerStore implements StoryWorkerStore {
  constructor(private readonly pool: Pool) {}

  async claim(workerId: string, leaseMs: number, now: string) {
    const r = await this.pool.query(
      `update story_proposals set status = 'running', attempts = attempts + 1, lease_owner = $1,
              lease_expires_at = $2::timestamptz
        where id = (select id from story_proposals where status = 'queued' and next_run_at <= $3::timestamptz
                     order by created_at limit 1 for update skip locked)
        returning *`,
      [workerId, new Date(Date.parse(now) + leaseMs).toISOString(), now],
    );
    return r.rows[0] ? mapStoryRow(r.rows[0] as Row) : null;
  }

  async expireAbandoned(now: string) {
    const r = await this.pool.query(
      `update story_proposals set status = 'failed', completed_at = $1::timestamptz,
              lease_expires_at = now() + interval '1 minute',
              error = '{"code":"ambiguous_interrupted","message":"The analysis was interrupted and may have reached the provider; it is not re-sent. Start it again."}'
        where status = 'running' and lease_expires_at < $1::timestamptz`,
      [now],
    );
    return r.rowCount ?? 0;
  }

  private async owned(sql: string, params: unknown[]) {
    const r = await this.pool.query(sql, params);
    if (r.rowCount === 0)
      throw new StoryProposalError("conflict", "The proposal is no longer leased by this worker.");
  }

  async complete(id: string, workerId: string, res: Parameters<StoryWorkerStore["complete"]>[2]) {
    await this.owned(
      `update story_proposals set status = 'ready', proposal = $3, usage = $4, actual_usd = $5,
              provider_calls = provider_calls + $6, completed_at = $7
        where id = $1 and status = 'running' and lease_owner = $2`,
      [id, workerId, json(res.proposal), json(res.usage), res.actualUsd, res.providerCalls, res.now],
    );
  }

  async fail(id: string, workerId: string, res: Parameters<StoryWorkerStore["fail"]>[2]) {
    await this.owned(
      `update story_proposals set status = 'failed', error = $3, usage = $4, actual_usd = $5,
              provider_calls = provider_calls + $6, completed_at = $7
        where id = $1 and status = 'running' and lease_owner = $2`,
      [id, workerId, json(res.error), json(res.usage), res.actualUsd, res.providerCalls, res.now],
    );
  }

  async retryLater(id: string, workerId: string, nextRunAt: string, providerCalls: number) {
    await this.owned(
      `update story_proposals
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
