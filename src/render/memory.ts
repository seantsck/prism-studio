import { randomUUID } from "node:crypto";
import type { Asset, ProjectData } from "@/domain/schemas";
import {
  ACTIVE_RENDER_STATUSES,
  RenderError,
  type ClaimedRender,
  type EpisodeRender,
  type EpisodeRenderRepository,
  type NewEpisodeRender,
  type RenderOutput,
  type RenderProgress,
  type RenderSourceRef,
  type RenderWorkerStore,
  type SegmentCacheEntry,
} from "./repository";

const clone = <T>(v: T): T => structuredClone(v);

export interface MemoryRenderAccess {
  all(): ProjectData[];
  /** stores a NEW Asset row (the output MP4) */
  insertAsset(projectId: string, asset: Asset): Promise<void>;
}

/**
 * In-process Episode renders for memory/demo mode and tests, with the semantics of migration 0059 / the Postgres
 * implementation: numbered per Episode, frozen inputs, one lease at a time, terminal renders immutable, retry = the
 * same render, the worker reads only Assets of the render's own project. Both sides (owner + worker) in one object.
 */
export class MemoryRenderService implements EpisodeRenderRepository, RenderWorkerStore {
  private renders = new Map<
    string,
    EpisodeRender & { lease: { token: string; owner: string; expiresAt: string } | null }
  >();
  private segments = new Map<string, SegmentCacheEntry>();

  constructor(private readonly access: MemoryRenderAccess) {}

  private require(projectId: string, renderId: string) {
    const r = this.renders.get(renderId);
    if (!r || r.projectId !== projectId) throw new RenderError("not_found", "That render no longer exists.");
    return r;
  }

  private view(r: EpisodeRender & { lease?: unknown }): EpisodeRender {
    const copy = clone(r);
    delete copy.lease;
    return copy;
  }

  async create(input: NewEpisodeRender): Promise<EpisodeRender> {
    const number =
      [...this.renders.values()].filter(
        (r) => r.projectId === input.projectId && r.episodeId === input.episodeId,
      ).length + 1;
    const r: EpisodeRender & { lease: null } = {
      id: randomUUID(),
      projectId: input.projectId,
      episodeId: input.episodeId,
      editId: input.editId,
      number,
      editRevision: input.editRevision,
      savedRevisionId: input.savedRevisionId,
      savedRevisionNumber: input.savedRevisionNumber,
      manifest: clone(input.manifest),
      manifestFingerprint: input.manifestFingerprint,
      stateFingerprint: input.stateFingerprint,
      profile: clone(input.profile),
      outputFilename: input.outputFilename,
      status: "queued",
      segmentsTotal: input.segmentsTotal,
      segmentsDone: 0,
      attemptCount: 1,
      output: null,
      errorCode: null,
      errorMessage: null,
      createdBy: input.userId,
      createdAt: input.now,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      lease: null,
    };
    this.renders.set(r.id, r);
    return this.view(r);
  }

  async listForEpisode(projectId: string, episodeId: string) {
    return [...this.renders.values()]
      .filter((r) => r.projectId === projectId && r.episodeId === episodeId)
      .sort((a, b) => a.number - b.number)
      .map((r) => this.view(r));
  }

  async get(projectId: string, renderId: string) {
    const r = this.renders.get(renderId);
    return r && r.projectId === projectId ? this.view(r) : null;
  }

  async retry(projectId: string, renderId: string, now: string) {
    const r = this.require(projectId, renderId);
    if (r.status !== "failed") throw new RenderError("invalid", "Only a failed render can be retried.");
    Object.assign(r, {
      status: "queued",
      attemptCount: r.attemptCount + 1,
      segmentsDone: 0,
      errorCode: null,
      errorMessage: null,
      failedAt: null,
      lease: null,
    });
    void now;
    return this.view(r);
  }

  async cancel(projectId: string, renderId: string, now: string) {
    const r = this.require(projectId, renderId);
    if (r.status !== "queued") throw new RenderError("invalid", "Only a queued render can be cancelled.");
    Object.assign(r, { status: "cancelled", failedAt: now });
    return this.view(r);
  }

  // ───────────────────────── worker side ─────────────────────────

  async claimNext(workerId: string, now: string, leaseMs: number): Promise<ClaimedRender | null> {
    const t = Date.parse(now);
    const candidate = [...this.renders.values()]
      .filter(
        (r) =>
          (r.status === "queued" ||
            ((ACTIVE_RENDER_STATUSES as readonly string[]).includes(r.status) &&
              r.lease !== null &&
              Date.parse(r.lease.expiresAt) <= t)) &&
          this.access.all().some((p) => p.project.id === r.projectId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!candidate) return null;
    const token = randomUUID();
    candidate.lease = { token, owner: workerId, expiresAt: new Date(t + leaseMs).toISOString() };
    // a reclaimed render (expired lease) restarts from its cached segments
    candidate.status = "rendering_segments";
    candidate.startedAt ??= now;
    return { render: this.view(candidate), leaseToken: token };
  }

  private leased(renderId: string, token: string) {
    const r = this.renders.get(renderId);
    if (!r || r.lease?.token !== token || !(ACTIVE_RENDER_STATUSES as readonly string[]).includes(r.status))
      throw new RenderError("lease_lost", "The render lease was lost.");
    return r;
  }

  async progress(renderId: string, token: string, patch: RenderProgress, now: string) {
    const r = this.leased(renderId, token);
    if (patch.status) r.status = patch.status;
    if (patch.segmentsDone != null) r.segmentsDone = patch.segmentsDone;
    if (r.lease) r.lease.expiresAt = new Date(Date.parse(now) + 10 * 60_000).toISOString();
  }

  async source(projectId: string, assetId: string): Promise<RenderSourceRef | null> {
    const a = this.access
      .all()
      .find((p) => p.project.id === projectId)
      ?.assets.find((x) => x.id === assetId);
    return a
      ? {
          id: a.id,
          projectId: a.projectId,
          objectPath: a.objectPath,
          storageProvider: a.storageProvider,
          checksum: a.checksum,
          mime: a.mime,
          channels: a.channels,
        }
      : null;
  }

  async getSegment(projectId: string, cacheKey: string) {
    const e = this.segments.get(`${projectId}:${cacheKey}`);
    return e ? clone(e) : null;
  }

  async putSegment(entry: SegmentCacheEntry) {
    this.segments.set(`${entry.projectId}:${entry.cacheKey}`, clone(entry));
  }

  async dropSegment(projectId: string, cacheKey: string) {
    this.segments.delete(`${projectId}:${cacheKey}`);
  }

  async complete(renderId: string, token: string, asset: Asset, output: RenderOutput, now: string) {
    const r = this.leased(renderId, token);
    if (r.status !== "verifying")
      throw new RenderError("invalid", "A render completes only after verification.");
    await this.access.insertAsset(r.projectId, asset);
    Object.assign(r, { status: "completed", output: clone(output), completedAt: now, lease: null });
  }

  async fail(renderId: string, token: string, error: { code: string; message: string }, now: string) {
    const r = this.leased(renderId, token);
    Object.assign(r, {
      status: "failed",
      errorCode: error.code.slice(0, 64),
      errorMessage: error.message.slice(0, 1000),
      failedAt: now,
      lease: null,
    });
  }

  /** Test seam: the raw rows (to prove frozen inputs / immutability). */
  snapshot(): EpisodeRender[] {
    return [...this.renders.values()].map((r) => this.view(r));
  }
}
