import type { RenderManifest } from "@/domain/edit/render-manifest";
import type { Asset } from "@/domain/schemas";
import type { RenderProfile } from "./profile";

/**
 * Phase 5B-V4 persistence contract of Episode renders (migration 0059). A render is a DURABLE job that freezes exactly
 * what it renders when it is requested: the Edit revision, the saved revision, the V3 render manifest (with every source
 * Asset id + checksum) and the delivery profile. Nothing a later edit does reaches a render; a completed render (and
 * its output Asset) is history and never changes. Renders are numbered 1, 2, … per Episode and never deleted by a newer
 * render.
 *
 *   queued → rendering_segments → assembling → verifying → completed
 *                 ↘ failed (retry → queued, the same render: no duplicate)      queued → cancelled
 *
 * The app side (owner, RLS) creates, lists, retries and cancels; the render WORKER claims under a lease, advances the
 * state, records the segment cache and the output. Implementations: src/render/memory.ts, src/render/postgres.ts.
 */

export const RENDER_STATUSES = [
  "queued",
  "rendering_segments",
  "assembling",
  "verifying",
  "completed",
  "failed",
  "cancelled",
] as const;
export type RenderStatus = (typeof RENDER_STATUSES)[number];
export const ACTIVE_RENDER_STATUSES: readonly RenderStatus[] = [
  "queued",
  "rendering_segments",
  "assembling",
  "verifying",
];
export const RENDER_STATUS_LABEL: Record<RenderStatus, string> = {
  queued: "Queued",
  rendering_segments: "Rendering",
  assembling: "Assembling",
  verifying: "Verifying",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** What the final MP4 is, as verified by ffprobe (plus its bytes' identity). */
export interface RenderOutput {
  assetId: string;
  filename: string;
  checksum: string;
  byteSize: number;
  durationMs: number;
  frames: number;
  width: number;
  height: number;
  frameRate: string;
  videoCodec: string;
  audioCodec: string | null;
  /** segments taken from the cache vs rendered, in the run that completed */
  segmentsReused: number;
  segmentsRendered: number;
  toolVersion: string;
  fonts: Array<{ style: string; family: string; checksum: string }>;
}

export interface EpisodeRender {
  id: string;
  projectId: string;
  episodeId: string;
  editId: string;
  /** 1, 2, … per Episode */
  number: number;
  /** the edit's working revision rendered, and the saved revision it equals */
  editRevision: number;
  savedRevisionId: string | null;
  savedRevisionNumber: number | null;
  manifest: RenderManifest;
  manifestFingerprint: string;
  stateFingerprint: string;
  profile: RenderProfile;
  /** the creator-friendly download name, frozen at request (e.g. ojousama-episode-1-the-arrangement.mp4) */
  outputFilename: string;
  status: RenderStatus;
  segmentsTotal: number;
  segmentsDone: number;
  attemptCount: number;
  output: RenderOutput | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
}

export interface NewEpisodeRender {
  projectId: string;
  episodeId: string;
  editId: string;
  editRevision: number;
  savedRevisionId: string | null;
  savedRevisionNumber: number | null;
  manifest: RenderManifest;
  manifestFingerprint: string;
  stateFingerprint: string;
  profile: RenderProfile;
  outputFilename: string;
  segmentsTotal: number;
  userId: string | null;
  now: string;
}

export class RenderError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid" | "lease_lost",
    message: string,
  ) {
    super(message);
    this.name = "RenderError";
  }
}

/** The owner's side (RLS-bound). */
export interface EpisodeRenderRepository {
  create(input: NewEpisodeRender): Promise<EpisodeRender>;
  listForEpisode(projectId: string, episodeId: string): Promise<EpisodeRender[]>;
  get(projectId: string, renderId: string): Promise<EpisodeRender | null>;
  /** failed → queued (the SAME render; its frozen manifest unchanged; attempt + 1). */
  retry(projectId: string, renderId: string, now: string): Promise<EpisodeRender>;
  /** queued → cancelled (a render already being processed finishes or fails on its own). */
  cancel(projectId: string, renderId: string, now: string): Promise<EpisodeRender>;
}

/** A cached normalized segment: deterministic key → private object + checksum. */
export interface SegmentCacheEntry {
  projectId: string;
  cacheKey: string;
  videoPath: string;
  videoChecksum: string;
  audioPath: string | null;
  audioChecksum: string | null;
  frames: number;
  samples: number;
}

/** A source the worker may read: only Assets of the render's own project. */
export interface RenderSourceRef {
  id: string;
  projectId: string;
  objectPath: string | null;
  storageProvider: Asset["storageProvider"];
  checksum: string | null;
  mime: string | null;
  channels: number | null;
}

export interface ClaimedRender {
  render: EpisodeRender;
  leaseToken: string;
}

export interface RenderProgress {
  status?: Extract<RenderStatus, "rendering_segments" | "assembling" | "verifying">;
  segmentsDone?: number;
}

/** The render worker's side: claim, advance, cache, finish. Never creates a render; never touches another table. */
export interface RenderWorkerStore {
  claimNext(workerId: string, now: string, leaseMs: number): Promise<ClaimedRender | null>;
  progress(renderId: string, leaseToken: string, patch: RenderProgress, now: string): Promise<void>;
  source(projectId: string, assetId: string): Promise<RenderSourceRef | null>;
  getSegment(projectId: string, cacheKey: string): Promise<SegmentCacheEntry | null>;
  putSegment(entry: SegmentCacheEntry, now: string): Promise<void>;
  dropSegment(projectId: string, cacheKey: string): Promise<void>;
  /** completed: records the output Asset (a NEW immutable Asset) and the verified metadata, in one unit */
  complete(
    renderId: string,
    leaseToken: string,
    asset: Asset,
    output: RenderOutput,
    now: string,
  ): Promise<void>;
  fail(
    renderId: string,
    leaseToken: string,
    error: { code: string; message: string },
    now: string,
  ): Promise<void>;
}

/** Private object storage as the renderer sees it (the app's provider: local disk or the private bucket). */
export interface RenderStorage {
  get(objectPath: string): Promise<Uint8Array | null>;
  put(objectPath: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(objectPath: string): Promise<void>;
}

export const RENDER_LEASE_MS = 10 * 60_000;
