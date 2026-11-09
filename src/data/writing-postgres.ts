import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { sourceFingerprint } from "@/domain/story/source";
import { MAX_STORY_ATTEMPTS } from "./story-repository";
import {
  WritingError,
  type NewRevision,
  type NewWritingProposal,
  type SceneStoryChange,
  type ScriptRevision,
  type WritingProposal,
  type WritingRepository,
  type WritingSession,
  type WritingWorkerStore,
} from "./writing-repository";

/**
 * Phase 5B-S2: Postgres writing sessions, proposals, script revisions and story-change markers (migration 0055).
 *   PostgresWritingData         the signed-in user (RLS preamble).
 *   PostgresWritingWorkerStore  the Story worker role (`prism_story_worker`): claim and write results only.
 * Immutability (frozen input, write-once result, final decisions, insert-only revisions) is ALSO enforced by trigger.
 */
type Row = Record<string, unknown>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));
const json = (v: unknown) => (v == null ? null : JSON.stringify(v));

export function mapRevision(r: Row): ScriptRevision {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    episodeId: String(r.episode_id),
    number: Number(r.number),
    origin: r.origin as ScriptRevision["origin"],
    text: String(r.text),
    fingerprint: String(r.fingerprint),
    parentRevisionId: (r.parent_revision_id as string | null) ?? null,
    writingProposalId: (r.writing_proposal_id as string | null) ?? null,
    alternativeIndex: num(r.alternative_index),
    storyProposalId: (r.story_proposal_id as string | null) ?? null,
    restoredFromId: (r.restored_from_id as string | null) ?? null,
    changedRange: (r.changed_range as ScriptRevision["changedRange"]) ?? null,
    changedSceneIds: ((r.changed_scene_ids as string[] | null) ?? []).map(String),
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: iso(r.created_at)!,
  };
}

export function mapSession(r: Row): WritingSession {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    episodeId: String(r.episode_id),
    title: String(r.title ?? ""),
    budgetUsd: Number(r.budget_usd ?? 0),
    reservedUsd: Number(r.reserved_usd ?? 0),
    budgetExpiresAt: iso(r.budget_expires_at),
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: iso(r.created_at)!,
  };
}

export function mapProposal(r: Row): WritingProposal {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    sessionId: String(r.session_id),
    episodeId: String(r.episode_id),
    turn: Number(r.turn),
    parentId: (r.parent_id as string | null) ?? null,
    parentAlternative: num(r.parent_alternative),
    mode: r.mode as WritingProposal["mode"],
    scope: r.scope as WritingProposal["scope"],
    instruction: String(r.instruction),
    alternativesRequested: Number(r.alternatives_requested),
    baseFingerprint: String(r.base_fingerprint),
    baseRevisionId: (r.base_revision_id as string | null) ?? null,
    targetText: String(r.target_text),
    draftText: (r.draft_text as string | null) ?? null,
    context: r.context as WritingProposal["context"],
    provider: String(r.provider),
    model: String(r.model),
    schemaVersion: String(r.schema_version),
    promptVersion: String(r.prompt_version),
    estimate: r.estimate as WritingProposal["estimate"],
    confirmedUsd: num(r.confirmed_usd),
    spendAuthorization: r.spend_authorization as WritingProposal["spendAuthorization"],
    status: r.status as WritingProposal["status"],
    result: (r.result as WritingProposal["result"]) ?? null,
    usage: (r.usage as WritingProposal["usage"]) ?? null,
    actualUsd: num(r.actual_usd),
    providerCalls: Number(r.provider_calls ?? 0),
    error: (r.error as WritingProposal["error"]) ?? null,
    attempts: Number(r.attempts ?? 0),
    nextRunAt: iso(r.next_run_at)!,
    leaseOwner: (r.lease_owner as string | null) ?? null,
    leaseExpiresAt: iso(r.lease_expires_at),
    acceptedAlternative: num(r.accepted_alternative),
    acceptedRevisionId: (r.accepted_revision_id as string | null) ?? null,
    savedAlternatives: ((r.saved_alternatives as number[] | null) ?? []).map(Number),
    decidedAt: iso(r.decided_at),
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: iso(r.created_at)!,
    completedAt: iso(r.completed_at),
  };
}

export class PostgresWritingData implements WritingRepository {
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
      if (err instanceof WritingError) throw err;
      if (e.code === "P0001") throw new WritingError("invalid", e.message ?? "Refused.");
      if (e.code === "23503") throw new WritingError("invalid", "A referenced row is not in this project.");
      if (e.code === "42501") throw new WritingError("not_found", "That is not in one of your projects.");
      throw err;
    } finally {
      client.release();
    }
  }

  async createSession(s: Omit<WritingSession, "budgetUsd" | "reservedUsd" | "budgetExpiresAt">) {
    return this.tx(async (c) => {
      const r = await c.query(
        `insert into writing_sessions (id, project_id, episode_id, title, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [s.id, s.projectId, s.episodeId, s.title, s.createdBy, s.createdAt],
      );
      return mapSession(r.rows[0] as Row);
    });
  }

  async getSession(projectId: string, id: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from writing_sessions where id = $1 and project_id = $2", [
        id,
        projectId,
      ]);
      return r.rows[0] ? mapSession(r.rows[0] as Row) : null;
    });
  }

  async listSessions(projectId: string, episodeId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from writing_sessions where project_id = $1 and episode_id = $2 order by created_at desc",
        [projectId, episodeId],
      );
      return r.rows.map((x) => mapSession(x as Row));
    });
  }

  async authorizeBudget(projectId: string, sessionId: string, amountUsd: number, expiresAt: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        `update writing_sessions set budget_usd = reserved_usd + $3, budget_expires_at = $4
          where id = $1 and project_id = $2 returning *`,
        [sessionId, projectId, amountUsd, expiresAt],
      );
      if (!r.rows[0]) throw new WritingError("not_found", "That writing session no longer exists.");
      return mapSession(r.rows[0] as Row);
    });
  }

  async createProposal(p: NewWritingProposal, opts: { reserveUsd: number | null; now: string }) {
    return this.tx(async (c) => {
      await c.query("select pg_advisory_xact_lock(hashtext('writing_proposals:' || $1::text))", [
        p.sessionId,
      ]);
      if (opts.reserveUsd != null) {
        const reserved = await c.query(
          `update writing_sessions set reserved_usd = reserved_usd + $3
            where id = $1 and project_id = $2 and budget_expires_at > $4::timestamptz
              and reserved_usd + $3 <= budget_usd
            returning id`,
          [p.sessionId, p.projectId, opts.reserveUsd, opts.now],
        );
        if (reserved.rowCount === 0)
          throw new WritingError("budget", "The writing session's spend allowance is used up or expired.");
      }
      const r = await c.query(
        `insert into writing_proposals (
           id, project_id, session_id, episode_id, turn, parent_id, parent_alternative, mode, scope, instruction,
           alternatives_requested, base_fingerprint, base_revision_id, target_text, draft_text, context, provider, model,
           schema_version, prompt_version, estimate, confirmed_usd, spend_authorization, status, next_run_at, created_by,
           created_at)
         values ($1, $2, $3, $4, (select coalesce(max(turn), 0) + 1 from writing_proposals where session_id = $3),
           $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, 'queued', $24, $23, $24)
         returning *`,
        [
          p.id,
          p.projectId,
          p.sessionId,
          p.episodeId,
          p.parentId,
          p.parentAlternative,
          p.mode,
          json(p.scope),
          p.instruction,
          p.alternativesRequested,
          p.baseFingerprint,
          p.baseRevisionId,
          p.targetText,
          p.draftText,
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
      return mapProposal(r.rows[0] as Row);
    });
  }

  async getProposal(projectId: string, id: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from writing_proposals where id = $1 and project_id = $2", [
        id,
        projectId,
      ]);
      return r.rows[0] ? mapProposal(r.rows[0] as Row) : null;
    });
  }

  async listProposals(projectId: string, sessionId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from writing_proposals where project_id = $1 and session_id = $2 order by turn",
        [projectId, sessionId],
      );
      return r.rows.map((x) => mapProposal(x as Row));
    });
  }

  private async refuse(c: PoolClient, projectId: string, id: string): Promise<never> {
    const s = await c.query(
      "select status, result is not null as has from writing_proposals where id = $1 and project_id = $2",
      [id, projectId],
    );
    const status = s.rows[0]?.status as string | undefined;
    if (!status) throw new WritingError("not_found", "That proposal no longer exists.");
    if (status === "accepted" || status === "rejected")
      throw new WritingError("decided", `This proposal was already ${status}.`);
    throw new WritingError("conflict", "This proposal is not ready yet.");
  }

  async rejectProposal(projectId: string, id: string, now: string) {
    await this.tx(async (c) => {
      const r = await c.query(
        `update writing_proposals set status = 'rejected', decided_at = $3
          where id = $1 and project_id = $2 and status = 'ready' returning id`,
        [id, projectId, now],
      );
      if (r.rowCount === 0) await this.refuse(c, projectId, id);
    });
  }

  async saveAlternative(projectId: string, id: string, index: number) {
    await this.tx(async (c) => {
      const r = await c.query(
        `update writing_proposals
            set saved_alternatives = (select array_agg(distinct x order by x) from unnest(saved_alternatives || $3::int) x)
          where id = $1 and project_id = $2 and status in ('ready', 'accepted', 'rejected')
            and $3 < jsonb_array_length(result -> 'alternatives') returning id`,
        [id, projectId, index],
      );
      if (r.rowCount === 0) {
        const exists = await c.query(
          "select status from writing_proposals where id = $1 and project_id = $2",
          [id, projectId],
        );
        if (!exists.rows[0]) throw new WritingError("not_found", "That proposal no longer exists.");
        throw new WritingError("invalid", "That version cannot be saved.");
      }
    });
  }

  private async insertRevision(c: PoolClient, n: NewRevision): Promise<ScriptRevision> {
    await c.query("select pg_advisory_xact_lock(hashtext('script_revisions:' || $1::text))", [n.episodeId]);
    const last = await c.query(
      "select id, number from script_revisions where episode_id = $1 order by number desc limit 1",
      [n.episodeId],
    );
    let parent = last.rows[0] as { id: string; number: number } | undefined;
    if (!parent && n.previousText != null && n.origin !== "import") {
      const b = await c.query(
        `insert into script_revisions (id, project_id, episode_id, number, origin, text, fingerprint, created_by, created_at)
         values ($1, $2, $3, 1, 'baseline', $4, $5, $6, $7) returning id, number`,
        [
          randomUUID(),
          n.projectId,
          n.episodeId,
          n.previousText,
          sourceFingerprint(n.previousText),
          n.createdBy,
          n.createdAt,
        ],
      );
      parent = b.rows[0] as { id: string; number: number };
    }
    const r = await c.query(
      `insert into script_revisions (id, project_id, episode_id, number, origin, text, fingerprint, parent_revision_id,
         writing_proposal_id, alternative_index, story_proposal_id, restored_from_id, changed_range, changed_scene_ids,
         created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::uuid[], $15, $16) returning *`,
      [
        n.id,
        n.projectId,
        n.episodeId,
        (parent ? Number(parent.number) : 0) + 1,
        n.origin,
        n.text,
        n.fingerprint,
        parent?.id ?? null,
        n.writingProposalId ?? null,
        n.alternativeIndex ?? null,
        n.storyProposalId ?? null,
        n.restoredFromId ?? null,
        json(n.changedRange ?? null),
        n.changedSceneIds ?? [],
        n.createdBy,
        n.createdAt,
      ],
    );
    for (const sceneId of n.flagSceneIds ?? [])
      await c.query(
        "insert into scene_story_changes (scene_id, revision_id, project_id, created_at) values ($1, $2, $3, $4)",
        [sceneId, n.id, n.projectId, n.createdAt],
      );
    return mapRevision(r.rows[0] as Row);
  }

  async acceptProposal(projectId: string, id: string, alternative: number, revision: NewRevision) {
    return this.tx(async (c) => {
      const p = await c.query(
        "select status, mode, episode_id from writing_proposals where id = $1 and project_id = $2 for update",
        [id, projectId],
      );
      const row = p.rows[0] as { status: string; mode: string; episode_id: string } | undefined;
      if (!row || row.status !== "ready") await this.refuse(c, projectId, id);
      if (row!.mode === "brainstorm")
        throw new WritingError("invalid", "A brainstorm has no text to accept.");
      const rev = await this.insertRevision(c, {
        ...revision,
        writingProposalId: id,
        alternativeIndex: alternative,
      });
      await c.query(
        `update writing_proposals set status = 'accepted', accepted_alternative = $3, accepted_revision_id = $4,
                decided_at = $5 where id = $1 and project_id = $2`,
        [id, projectId, alternative, rev.id, revision.createdAt],
      );
      return rev;
    });
  }

  async recordRevision(n: NewRevision) {
    if (n.origin === "ai_revision")
      throw new WritingError("invalid", "An AI revision is recorded by Accept.");
    return this.tx((c) => this.insertRevision(c, n));
  }

  async listRevisions(projectId: string, episodeId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from script_revisions where project_id = $1 and episode_id = $2 order by number desc",
        [projectId, episodeId],
      );
      return r.rows.map((x) => mapRevision(x as Row));
    });
  }

  async getRevision(projectId: string, id: string) {
    return this.tx(async (c) => {
      const r = await c.query("select * from script_revisions where id = $1 and project_id = $2", [
        id,
        projectId,
      ]);
      return r.rows[0] ? mapRevision(r.rows[0] as Row) : null;
    });
  }

  async openSceneChanges(projectId: string): Promise<SceneStoryChange[]> {
    return this.tx(async (c) => {
      const r = await c.query(
        "select * from scene_story_changes where project_id = $1 and reviewed_at is null order by created_at",
        [projectId],
      );
      return r.rows.map((x) => {
        const o = x as Row;
        return {
          sceneId: String(o.scene_id),
          revisionId: String(o.revision_id),
          projectId: String(o.project_id),
          createdAt: iso(o.created_at)!,
          reviewedAt: iso(o.reviewed_at),
        };
      });
    });
  }

  async markSceneReviewed(projectId: string, sceneId: string, now: string) {
    await this.tx(async (c) => {
      await c.query(
        "update scene_story_changes set reviewed_at = $3 where project_id = $1 and scene_id = $2 and reviewed_at is null",
        [projectId, sceneId, now],
      );
    });
  }
}

/** The Story worker (database role `prism_story_worker`): claim writing proposals, then write each result once. */
export class PostgresWritingWorkerStore implements WritingWorkerStore {
  constructor(private readonly pool: Pool) {}

  async claim(workerId: string, leaseMs: number, now: string) {
    const r = await this.pool.query(
      `update writing_proposals set status = 'running', attempts = attempts + 1, lease_owner = $1,
              lease_expires_at = $2::timestamptz
        where id = (select id from writing_proposals where status = 'queued' and next_run_at <= $3::timestamptz
                     order by created_at limit 1 for update skip locked)
        returning *`,
      [workerId, new Date(Date.parse(now) + leaseMs).toISOString(), now],
    );
    return r.rows[0] ? mapProposal(r.rows[0] as Row) : null;
  }

  async expireAbandoned(now: string) {
    const r = await this.pool.query(
      `update writing_proposals set status = 'failed', completed_at = $1::timestamptz,
              lease_expires_at = now() + interval '1 minute',
              error = '{"code":"ambiguous_interrupted","message":"Prism AI was interrupted and may have reached the provider; it is not re-sent. Ask again."}'
        where status = 'running' and lease_expires_at < $1::timestamptz`,
      [now],
    );
    return r.rowCount ?? 0;
  }

  private async owned(sql: string, params: unknown[]) {
    const r = await this.pool.query(sql, params);
    if (r.rowCount === 0)
      throw new WritingError("conflict", "The proposal is no longer leased by this worker.");
  }

  async complete(id: string, workerId: string, res: Parameters<WritingWorkerStore["complete"]>[2]) {
    await this.owned(
      `update writing_proposals set status = 'ready', result = $3, usage = $4, actual_usd = $5,
              provider_calls = provider_calls + $6, completed_at = $7
        where id = $1 and status = 'running' and lease_owner = $2`,
      [id, workerId, json(res.result), json(res.usage), res.actualUsd, res.providerCalls, res.now],
    );
  }

  async fail(id: string, workerId: string, res: Parameters<WritingWorkerStore["fail"]>[2]) {
    await this.owned(
      `update writing_proposals set status = 'failed', error = $3, usage = $4, actual_usd = $5,
              provider_calls = provider_calls + $6, completed_at = $7
        where id = $1 and status = 'running' and lease_owner = $2`,
      [id, workerId, json(res.error), json(res.usage), res.actualUsd, res.providerCalls, res.now],
    );
  }

  async retryLater(id: string, workerId: string, nextRunAt: string, providerCalls: number) {
    await this.owned(
      `update writing_proposals
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
