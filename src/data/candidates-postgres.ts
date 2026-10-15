import type { Pool, PoolClient } from "pg";
import type {
  CandidateMember,
  CandidateSet,
  CandidateSetEvent,
  CandidateSetStatus,
} from "@/domain/generation/candidates";
import { buildOutcomeRecords, type RawAttemptOutcome } from "@/domain/generation/outcomes";
import type { OutcomeRecord } from "@/domain/generation/performance";
import type { GenerationReview, NegativeTag, PositiveTag, ReviewDecision } from "@/domain/generation/reviews";
import {
  CandidateError,
  type CandidateRepository,
  type CandidateSetView,
  type NewCandidateSet,
  type NewReview,
} from "./candidates-repository";

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

const mapSet = (r: Row): CandidateSet => ({
  id: String(r.id),
  projectId: String(r.project_id),
  shotId: String(r.shot_id),
  title: String(r.title),
  purpose: String(r.purpose),
  status: String(r.status) as CandidateSetStatus,
  packageFingerprint: String(r.package_fingerprint),
  estimatedTotalUsd: num(r.estimated_total_usd),
  ceilingUsd: num(r.ceiling_usd),
  preferredAttemptId: str(r.preferred_attempt_id),
  preferredBy: str(r.preferred_by),
  preferredAt: isoOrNull(r.preferred_at),
  promotedAttemptId: str(r.promoted_attempt_id),
  promotedBy: str(r.promoted_by),
  promotedAt: isoOrNull(r.promoted_at),
  recommendation: (r.recommendation as Record<string, unknown> | null) ?? null,
  createdBy: str(r.created_by),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const mapMember = (r: Row): CandidateMember => ({
  id: String(r.id),
  candidateSetId: String(r.candidate_set_id),
  projectId: String(r.project_id),
  label: String(r.label),
  position: Number(r.position),
  provider: String(r.provider),
  model: String(r.model),
  attemptId: str(r.attempt_id),
  submitState: String(r.submit_state) as CandidateMember["submitState"],
  submitError: String(r.submit_error),
  inputMode: (r.input_mode as CandidateMember["inputMode"]) ?? null,
  tierId: str(r.tier_id),
  nativeAudio: Boolean(r.native_audio),
  estimateUsd: num(r.estimate_usd),
  plan: (r.plan as Record<string, unknown>) ?? {},
  createdAt: iso(r.created_at),
});

const mapEvent = (r: Row): CandidateSetEvent => ({
  id: String(r.id),
  candidateSetId: String(r.candidate_set_id),
  projectId: String(r.project_id),
  kind: String(r.kind) as CandidateSetEvent["kind"],
  payload: (r.payload as Record<string, unknown>) ?? {},
  actor: str(r.actor),
  at: iso(r.at),
});

const mapReview = (r: Row): GenerationReview => ({
  id: String(r.id),
  projectId: String(r.project_id),
  attemptId: String(r.attempt_id),
  candidateSetId: str(r.candidate_set_id),
  decision: String(r.decision) as ReviewDecision,
  positiveTags: ((r.positive_tags as string[]) ?? []) as PositiveTag[],
  negativeTags: ((r.negative_tags as string[]) ?? []) as NegativeTag[],
  notes: String(r.notes),
  reviewer: str(r.reviewer),
  reviewedAt: iso(r.reviewed_at),
  supersedesId: str(r.supersedes_id),
});

/**
 * Postgres candidate-set and review persistence. `preamble` is the RLS preamble of the signed-in user: Postgres
 * enforces ownership; the worker roles have no grant on these tables at all.
 */
export class PostgresCandidateData implements CandidateRepository {
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

  private async viewOf(c: PoolClient, setId: string): Promise<CandidateSetView | null> {
    const s = await c.query("select * from generation_candidate_sets where id = $1", [setId]);
    if (!s.rows[0]) return null;
    const m = await c.query(
      "select * from generation_candidate_members where candidate_set_id = $1 order by position",
      [setId],
    );
    const e = await c.query(
      "select * from generation_candidate_events where candidate_set_id = $1 order by at, id",
      [setId],
    );
    return { set: mapSet(s.rows[0]), members: m.rows.map(mapMember), events: e.rows.map(mapEvent) };
  }

  private async event(
    c: PoolClient,
    set: { id: string; projectId: string },
    kind: CandidateSetEvent["kind"],
    payload: Record<string, unknown>,
    actor: string | null,
    at: string,
  ) {
    await c.query(
      `insert into generation_candidate_events (project_id, candidate_set_id, kind, payload, actor, at)
       values ($1, $2, $3, $4::jsonb, $5, $6)`,
      [set.projectId, set.id, kind, JSON.stringify(payload), actor, at],
    );
  }

  async createSet(input: NewCandidateSet): Promise<CandidateSetView> {
    return this.tx(async (c) => {
      const shot = await c.query("select 1 from shots where id = $1 and project_id = $2", [
        input.shotId,
        input.projectId,
      ]);
      if (shot.rowCount === 0) throw new CandidateError("not_found", "That shot no longer exists.");
      await c.query(
        `insert into generation_candidate_sets
           (id, project_id, shot_id, title, purpose, package_fingerprint, estimated_total_usd, ceiling_usd,
            recommendation, created_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $11)`,
        [
          input.id,
          input.projectId,
          input.shotId,
          input.title,
          input.purpose,
          input.packageFingerprint,
          input.estimatedTotalUsd,
          input.ceilingUsd,
          input.recommendation ? JSON.stringify(input.recommendation) : null,
          input.createdBy,
          input.now,
        ],
      );
      for (const m of input.members) {
        await c.query(
          `insert into generation_candidate_members
             (candidate_set_id, project_id, label, position, provider, model, input_mode, tier_id, native_audio,
              estimate_usd, plan, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
          [
            input.id,
            input.projectId,
            m.label,
            m.position,
            m.provider,
            m.model,
            m.inputMode,
            m.tierId,
            m.nativeAudio,
            m.estimateUsd,
            JSON.stringify(m.plan),
            input.now,
          ],
        );
      }
      await this.event(
        c,
        { id: input.id, projectId: input.projectId },
        "created",
        { candidates: input.members.length, estimatedTotalUsd: input.estimatedTotalUsd },
        input.createdBy,
        input.now,
      );
      return (await this.viewOf(c, input.id))!;
    });
  }

  async getSet(setId: string) {
    return this.tx((c) => this.viewOf(c, setId));
  }

  async listSets(projectId: string, opts: { shotId?: string; limit?: number } = {}) {
    return this.tx(async (c) => {
      const r = await c.query(
        `select id from generation_candidate_sets
         where project_id = $1 and ($2::uuid is null or shot_id = $2)
         order by created_at desc, id desc limit $3`,
        [projectId, opts.shotId ?? null, opts.limit ?? 200],
      );
      const out: CandidateSetView[] = [];
      for (const row of r.rows) {
        const v = await this.viewOf(c, String(row.id));
        if (v) out.push(v);
      }
      return out;
    });
  }

  async findSetForAttempt(attemptId: string) {
    return this.tx(async (c) => {
      const r = await c.query(
        "select candidate_set_id from generation_candidate_members where attempt_id = $1",
        [attemptId],
      );
      return r.rows[0] ? this.viewOf(c, String(r.rows[0].candidate_set_id)) : null;
    });
  }

  async attachAttempt(memberId: string, attemptId: string) {
    await this.tx(async (c) => {
      const r = await c.query(
        `update generation_candidate_members
            set attempt_id = $2, submit_state = 'submitted', submit_error = ''
          where id = $1 and (attempt_id is null or attempt_id = $2)`,
        [memberId, attemptId],
      );
      if (r.rowCount === 0)
        throw new CandidateError("invalid", "Candidate could not be linked to its attempt.");
    });
  }

  async markSubmitFailed(memberId: string, error: string) {
    await this.tx(async (c) => {
      const r = await c.query(
        `update generation_candidate_members set submit_state = 'failed', submit_error = $2
          where id = $1 and attempt_id is null`,
        [memberId, error.slice(0, 500)],
      );
      if (r.rowCount === 0) throw new CandidateError("invalid", "Candidate already has an attempt.");
    });
  }

  async recordReview(input: NewReview): Promise<GenerationReview> {
    return this.tx(async (c) => {
      const att = await c.query("select status from generation_attempts where id = $1 and project_id = $2", [
        input.attemptId,
        input.projectId,
      ]);
      if (att.rowCount === 0) throw new CandidateError("not_found", "That generation no longer exists.");
      if (att.rows[0].status !== "succeeded")
        throw new CandidateError("not_succeeded", "Only a completed generation has a clip to review.");
      const prev = await c.query(
        "select id from generation_reviews where attempt_id = $1 order by reviewed_at desc, id desc limit 1",
        [input.attemptId],
      );
      const r = await c.query(
        `insert into generation_reviews
           (project_id, attempt_id, candidate_set_id, decision, positive_tags, negative_tags, notes, reviewer,
            reviewed_at, supersedes_id)
         values ($1, $2, $3, $4, $5::text[], $6::text[], $7, $8, $9, $10) returning *`,
        [
          input.projectId,
          input.attemptId,
          input.candidateSetId,
          input.decision,
          input.positiveTags,
          input.negativeTags,
          input.notes,
          input.reviewer,
          input.now,
          prev.rows[0]?.id ?? null,
        ],
      );
      return mapReview(r.rows[0]);
    });
  }

  async listReviews(projectId: string, opts: { attemptIds?: string[] } = {}) {
    return this.tx(async (c) => {
      const r = opts.attemptIds
        ? await c.query(
            `select * from generation_reviews where project_id = $1 and attempt_id = any($2::uuid[])
             order by reviewed_at desc, id desc`,
            [projectId, opts.attemptIds],
          )
        : await c.query(
            "select * from generation_reviews where project_id = $1 order by reviewed_at desc, id desc",
            [projectId],
          );
      return r.rows.map(mapReview);
    });
  }

  private async mustSet(c: PoolClient, setId: string): Promise<CandidateSet> {
    const r = await c.query("select * from generation_candidate_sets where id = $1 for update", [setId]);
    if (!r.rows[0]) throw new CandidateError("not_found", "That candidate set no longer exists.");
    return mapSet(r.rows[0]);
  }

  private async mustMember(c: PoolClient, setId: string, attemptId: string) {
    const r = await c.query(
      "select 1 from generation_candidate_members where candidate_set_id = $1 and attempt_id = $2",
      [setId, attemptId],
    );
    if (r.rowCount === 0)
      throw new CandidateError("not_member", "That generation is not a candidate of this set.");
  }

  async setPreferred(setId: string, attemptId: string | null, actor: string | null, now: string) {
    return this.tx(async (c) => {
      const set = await this.mustSet(c, setId);
      if (attemptId) await this.mustMember(c, setId, attemptId);
      const r = await c.query(
        `update generation_candidate_sets
            set preferred_attempt_id = $2, preferred_by = $3, preferred_at = $4
          where id = $1 returning *`,
        [setId, attemptId, attemptId ? actor : null, attemptId ? now : null],
      );
      await this.event(c, set, attemptId ? "preferred_set" : "preferred_cleared", { attemptId }, actor, now);
      return mapSet(r.rows[0]);
    });
  }

  async recordPromotion(setId: string, attemptId: string, actor: string | null, now: string) {
    return this.tx(async (c) => {
      const set = await this.mustSet(c, setId);
      await this.mustMember(c, setId, attemptId);
      const a = await c.query("select status from generation_attempts where id = $1", [attemptId]);
      if (a.rows[0]?.status !== "succeeded")
        throw new CandidateError("not_succeeded", "Only a succeeded generation can be promoted.");
      const r = await c.query(
        `update generation_candidate_sets
            set promoted_attempt_id = $2, promoted_by = $3, promoted_at = $4, status = 'decided'
          where id = $1 returning *`,
        [setId, attemptId, actor, now],
      );
      await this.event(c, set, "promoted", { attemptId }, actor, now);
      return mapSet(r.rows[0]);
    });
  }

  async setStatus(setId: string, status: CandidateSetStatus, actor: string | null, now: string) {
    return this.tx(async (c) => {
      const set = await this.mustSet(c, setId);
      const r = await c.query("update generation_candidate_sets set status = $2 where id = $1 returning *", [
        setId,
        status,
      ]);
      await this.event(c, set, "status_changed", { from: set.status, to: status }, actor, now);
      return mapSet(r.rows[0]);
    });
  }

  async listOutcomeRecords(projectId: string): Promise<OutcomeRecord[]> {
    return this.tx(async (c) => {
      const attempts = await c.query(
        `select a.id, a.project_id, a.provider, a.model, a.status, a.package_snapshot, a.created_at,
                j.created_at as job_created_at, j.submitted_at, j.completed_at, j.last_error_category,
                j.last_error_code,
                (select amount from generation_costs x where x.attempt_id = a.id and x.kind = 'actual'
                  order by recorded_at desc limit 1) as actual_amount,
                (select amount from generation_costs x where x.attempt_id = a.id and x.kind = 'estimated'
                  order by recorded_at desc limit 1) as estimated_amount
           from generation_attempts a
           left join lateral (
             select created_at, submitted_at, completed_at, last_error_category, last_error_code
               from generation_jobs
              where attempt_id = a.id order by created_at desc limit 1
           ) j on true
          where a.project_id = $1`,
        [projectId],
      );
      const reviews = await c.query("select * from generation_reviews where project_id = $1", [projectId]);
      const benchmark =
        (await c.query("select purpose from projects where id = $1", [projectId])).rows[0]?.purpose !==
        "production";
      const members = await c.query(
        "select attempt_id, candidate_set_id from generation_candidate_members where project_id = $1 and attempt_id is not null",
        [projectId],
      );
      const sets = await c.query(
        "select preferred_attempt_id, promoted_attempt_id from generation_candidate_sets where project_id = $1",
        [projectId],
      );
      const raw: RawAttemptOutcome[] = attempts.rows.map((r) => ({
        attemptId: String(r.id),
        projectId: String(r.project_id),
        provider: String(r.provider),
        model: String(r.model),
        status: String(r.status),
        packageSnapshot: r.package_snapshot,
        createdAt: iso(r.created_at),
        job: r.job_created_at
          ? {
              createdAt: iso(r.job_created_at),
              submittedAt: isoOrNull(r.submitted_at),
              completedAt: isoOrNull(r.completed_at),
              errorCategory: str(r.last_error_category),
              errorCode: str(r.last_error_code),
            }
          : null,
        actualCostUsd: num(r.actual_amount),
        estimatedCostUsd: num(r.estimated_amount),
      }));
      const preferred = new Set<string>();
      for (const s of sets.rows) {
        if (s.preferred_attempt_id) preferred.add(String(s.preferred_attempt_id));
        if (s.promoted_attempt_id) preferred.add(String(s.promoted_attempt_id));
      }
      return buildOutcomeRecords({
        attempts: raw,
        reviews: reviews.rows.map(mapReview),
        memberships: new Map(
          members.rows.map((m) => [String(m.attempt_id), String(m.candidate_set_id)] as const),
        ),
        preferredAttemptIds: preferred,
        benchmark,
      });
    });
  }
}
