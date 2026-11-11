import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { RenderManifest } from "@/domain/edit/render-manifest";
import type { Asset } from "@/domain/schemas";
import { COLLECTIONS, flatToRow } from "@/data/postgres-mapping";
import type { RenderProfile } from "./profile";
import {
  RenderError,
  type ClaimedRender,
  type EpisodeRender,
  type EpisodeRenderRepository,
  type NewEpisodeRender,
  type RenderOutput,
  type RenderProgress,
  type RenderSourceRef,
  type RenderStatus,
  type RenderWorkerStore,
  type SegmentCacheEntry,
} from "./repository";

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());
const num = (v: unknown) => Number(v);

const mapRender = (r: Row): EpisodeRender => ({
  id: String(r.id),
  projectId: String(r.project_id),
  episodeId: String(r.episode_id),
  editId: String(r.edit_id),
  number: num(r.number),
  editRevision: num(r.edit_revision),
  savedRevisionId: r.saved_revision_id ? String(r.saved_revision_id) : null,
  savedRevisionNumber: r.saved_revision_number == null ? null : num(r.saved_revision_number),
  manifest: r.manifest as RenderManifest,
  manifestFingerprint: String(r.manifest_fingerprint),
  stateFingerprint: String(r.state_fingerprint),
  profile: r.profile as RenderProfile,
  outputFilename: String(r.output_filename),
  status: r.status as RenderStatus,
  segmentsTotal: num(r.segments_total),
  segmentsDone: num(r.segments_done),
  attemptCount: num(r.attempt_count),
  output: (r.output as RenderOutput | null) ?? null,
  errorCode: r.error_code ? String(r.error_code) : null,
  errorMessage: r.error_message ? String(r.error_message) : null,
  createdBy: r.created_by ? String(r.created_by) : null,
  createdAt: iso(r.created_at)!,
  startedAt: iso(r.started_at),
  completedAt: iso(r.completed_at),
  failedAt: iso(r.failed_at),
});

async function tx<T>(pool: Pool, preamble: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(preamble);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (err) {
    await c.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Phase 5B-V4 owner side (migration 0059), under the signed-in user's RLS preamble: request, list, retry, cancel.
 * The database guards everything else (frozen inputs, transitions, the owner's narrow rights).
 */
export class PostgresEpisodeRenderData implements EpisodeRenderRepository {
  constructor(
    private readonly pool: Pool,
    private readonly preamble: string,
  ) {}

  async create(input: NewEpisodeRender): Promise<EpisodeRender> {
    return tx(this.pool, this.preamble, async (c) => {
      // one number per Episode, under a lock on the Episode row (concurrent requests get 1, 2, …)
      await c.query("select 1 from episodes where id = $1 for update", [input.episodeId]);
      const n = await c.query(
        "select coalesce(max(number), 0) + 1 as n from episode_renders where episode_id = $1",
        [input.episodeId],
      );
      const r = await c.query(
        `insert into episode_renders
           (project_id, episode_id, edit_id, number, edit_revision, saved_revision_id, saved_revision_number, manifest,
            manifest_fingerprint, state_fingerprint, profile, profile_id, output_filename, segments_total, created_by,
            created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12,$13,$14,$15,$16) returning *`,
        [
          input.projectId,
          input.episodeId,
          input.editId,
          num(n.rows[0].n),
          input.editRevision,
          input.savedRevisionId,
          input.savedRevisionNumber,
          JSON.stringify(input.manifest),
          input.manifestFingerprint,
          input.stateFingerprint,
          JSON.stringify(input.profile),
          input.profile.id,
          input.outputFilename,
          input.segmentsTotal,
          input.userId,
          input.now,
        ],
      );
      return mapRender(r.rows[0]);
    });
  }

  async listForEpisode(projectId: string, episodeId: string) {
    return tx(this.pool, this.preamble, async (c) =>
      (
        await c.query(
          "select * from episode_renders where project_id = $1 and episode_id = $2 order by number",
          [projectId, episodeId],
        )
      ).rows.map(mapRender),
    );
  }

  async get(projectId: string, renderId: string) {
    return tx(this.pool, this.preamble, async (c) => {
      const r = await c.query("select * from episode_renders where id = $1 and project_id = $2", [
        renderId,
        projectId,
      ]);
      return r.rows[0] ? mapRender(r.rows[0]) : null;
    });
  }

  private async transition(
    projectId: string,
    renderId: string,
    from: RenderStatus,
    set: string,
    message: string,
  ) {
    return tx(this.pool, this.preamble, async (c) => {
      const r = await c.query(
        `update episode_renders set ${set} where id = $1 and project_id = $2 and status = '${from}' returning *`,
        [renderId, projectId],
      );
      if (!r.rows[0]) {
        const exists = await c.query("select 1 from episode_renders where id = $1 and project_id = $2", [
          renderId,
          projectId,
        ]);
        throw new RenderError(
          exists.rows[0] ? "invalid" : "not_found",
          exists.rows[0] ? message : "That render no longer exists.",
        );
      }
      return mapRender(r.rows[0]);
    });
  }

  async retry(projectId: string, renderId: string, now: string) {
    void now;
    return this.transition(
      projectId,
      renderId,
      "failed",
      `status = 'queued', attempt_count = attempt_count + 1, segments_done = 0, error_code = null,
       error_message = null, failed_at = null, lease_owner = null, lease_token = null, lease_expires_at = null`,
      "Only a failed render can be retried.",
    );
  }

  async cancel(projectId: string, renderId: string, now: string) {
    void now;
    return this.transition(
      projectId,
      renderId,
      "queued",
      `status = 'cancelled', failed_at = now()`,
      "Only a queued render can be cancelled.",
    );
  }
}

/**
 * Phase 5B-V4 render WORKER side, as the least-privilege `prism_render_worker` role (`preamble` sets it: a login role
 * provisioned per environment, or `begin; set local role prism_render_worker` on the local disposable database).
 * Claims with `for update skip locked` under a lease token; every write is conditioned on that token.
 */
export class PostgresRenderWorkerStore implements RenderWorkerStore {
  constructor(
    private readonly pool: Pool,
    private readonly preamble: string,
  ) {}

  private q<T>(fn: (c: PoolClient) => Promise<T>) {
    return tx(this.pool, this.preamble, fn);
  }

  async claimNext(workerId: string, now: string, leaseMs: number): Promise<ClaimedRender | null> {
    return this.q(async (c) => {
      const pick = await c.query(
        `select id from episode_renders
          where status = 'queued'
             or (status in ('rendering_segments', 'assembling', 'verifying') and lease_expires_at <= $1)
          order by created_at limit 1 for update skip locked`,
        [now],
      );
      if (!pick.rows[0]) return null;
      const token = randomUUID();
      const r = await c.query(
        `update episode_renders set status = 'rendering_segments', lease_owner = $2, lease_token = $3,
           lease_expires_at = $4, heartbeat_at = $5, started_at = coalesce(started_at, $5)
         where id = $1 returning *`,
        [pick.rows[0].id, workerId, token, new Date(Date.parse(now) + leaseMs).toISOString(), now],
      );
      return { render: mapRender(r.rows[0]), leaseToken: token };
    });
  }

  private async leased(c: PoolClient, renderId: string, token: string, set: string, params: unknown[]) {
    // no RETURNING: the worker's UPDATE policy covers ACTIVE renders only, so a row just made completed / failed is
    // checked against it no longer; rowCount alone says whether the leased write landed
    const r = await c.query(`update episode_renders set ${set} where id = $1 and lease_token = $2`, [
      renderId,
      token,
      ...params,
    ]);
    if (r.rowCount !== 1) throw new RenderError("lease_lost", "The render lease was lost.");
  }

  async progress(renderId: string, token: string, patch: RenderProgress, now: string) {
    await this.q((c) =>
      this.leased(
        c,
        renderId,
        token,
        `status = coalesce($3, status), segments_done = coalesce($4, segments_done), heartbeat_at = $5,
         lease_expires_at = ($5::timestamptz + interval '10 minutes')`,
        [patch.status ?? null, patch.segmentsDone ?? null, now],
      ),
    );
  }

  async source(projectId: string, assetId: string): Promise<RenderSourceRef | null> {
    return this.q(async (c) => {
      const r = await c.query(
        `select id, project_id, storage_provider, object_path, checksum, mime, channels from assets
          where id = $1 and project_id = $2`,
        [assetId, projectId],
      );
      const a = r.rows[0];
      return a
        ? {
            id: String(a.id),
            projectId: String(a.project_id),
            objectPath: a.object_path ? String(a.object_path) : null,
            storageProvider: a.storage_provider as Asset["storageProvider"],
            checksum: a.checksum ? String(a.checksum) : null,
            mime: a.mime ? String(a.mime) : null,
            channels: a.channels == null ? null : num(a.channels),
          }
        : null;
    });
  }

  async getSegment(projectId: string, cacheKey: string) {
    return this.q(async (c) => {
      const r = await c.query("select * from render_segment_cache where project_id = $1 and cache_key = $2", [
        projectId,
        cacheKey,
      ]);
      const e = r.rows[0];
      return e
        ? {
            projectId: String(e.project_id),
            cacheKey: String(e.cache_key),
            videoPath: String(e.video_path),
            videoChecksum: String(e.video_checksum),
            audioPath: e.audio_path ? String(e.audio_path) : null,
            audioChecksum: e.audio_checksum ? String(e.audio_checksum) : null,
            frames: num(e.frames),
            samples: num(e.samples),
          }
        : null;
    });
  }

  async putSegment(e: SegmentCacheEntry, now: string) {
    await this.q((c) =>
      c.query(
        `insert into render_segment_cache
           (project_id, cache_key, video_path, video_checksum, audio_path, audio_checksum, frames, samples, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (project_id, cache_key) do nothing`,
        [
          e.projectId,
          e.cacheKey,
          e.videoPath,
          e.videoChecksum,
          e.audioPath,
          e.audioChecksum,
          e.frames,
          e.samples,
          now,
        ],
      ),
    );
  }

  async dropSegment(projectId: string, cacheKey: string) {
    await this.q((c) =>
      c.query("delete from render_segment_cache where project_id = $1 and cache_key = $2", [
        projectId,
        cacheKey,
      ]),
    );
  }

  async complete(renderId: string, token: string, asset: Asset, output: RenderOutput, now: string) {
    await this.q(async (c) => {
      const row = flatToRow(asset, COLLECTIONS.assets);
      const cols = Object.keys(row);
      await c.query(
        `insert into assets (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})
         on conflict (id) do nothing`,
        cols.map((k) => {
          const v = row[k];
          return v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)
            ? JSON.stringify(v)
            : v;
        }),
      );
      await this.leased(
        c,
        renderId,
        token,
        `status = 'completed', output_asset_id = $3, output = $4::jsonb, completed_at = $5, lease_token = null,
         lease_owner = null, lease_expires_at = null`,
        [asset.id, JSON.stringify(output), now],
      );
    });
  }

  async fail(renderId: string, token: string, error: { code: string; message: string }, now: string) {
    await this.q((c) =>
      this.leased(
        c,
        renderId,
        token,
        `status = 'failed', error_code = $3, error_message = $4, failed_at = $5, lease_token = null,
         lease_owner = null, lease_expires_at = null`,
        [error.code.slice(0, 64), error.message.slice(0, 1000), now],
      ),
    );
  }
}
