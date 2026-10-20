import {
  applyJobPatch,
  JobTransitionError,
  newJobRecord,
  sanitizeProviderPayload,
  type JobEvent,
  type JobEventRecord,
  type JobPatch,
  type NewReconstructionJob,
  type ReconstructionJobRecord,
} from "@/domain/reconstruction/job";
import {
  calibrationSchema,
  generationProvenanceSchema,
  sourcesFor,
  reconstructionFingerprintOf,
  RECONSTRUCTION_SCHEMA,
  type NewSpatialReconstruction,
  type SpatialReconstructionRecord,
} from "@/domain/previs/splat";
import { pickCurrentClip } from "@/domain/previs/audio-mix";
import {
  blockingFingerprint,
  buildShotBlockingReference,
  parseBlockingEntry,
  renderedBlockingFingerprint,
} from "@/domain/previs/blocking";
import { poseFingerprint } from "@/domain/previs/pose";
import {
  bookmarkCameraFingerprint,
  buildControlPassesReference,
  pickCurrentBundle,
  SPATIAL_PASS_BUNDLE_SCHEMA,
} from "@/domain/previs/spatial-passes";
import { bookmarkFromCamera } from "@/domain/previs/camera";
import { cameraPathFingerprint, validateCameraPath } from "@/domain/previs/camera-path";
import { sceneFingerprint } from "@/domain/previs/document";
import {
  buildSpatialReference,
  CAMERA_MOTION_SCHEMA_VERSION,
  type CameraMotionReference,
  type SpatialReference,
} from "@/domain/previs/spatial";
import type { MemoryProjectsAccess } from "./generation-memory";
import {
  PrevisError,
  type AudioMixResolver,
  type CameraBookmarkRecord,
  type CameraPathRecord,
  type MasterFrameRecord,
  type NewMasterFrame,
  type NewPrevisClip,
  type NewSpatialPassBundle,
  type SpatialPassBundleRecord,
  type PrevisClipRecord,
  type SaveCameraPathInput,
  type SaveShotBlockingInput,
  type ShotBlockingRecord,
  type PrevisRepository,
  type SaveSceneInput,
  type SceneDocumentRecord,
  type SetBookmarkInput,
} from "./previs-repository";

const clone = <T>(v: T): T => structuredClone(v);

/** In-process previs store with the same semantics as the Postgres implementation (and its triggers). */
export class MemoryPrevisService implements PrevisRepository {
  private scenes = new Map<string, SceneDocumentRecord>(); // by location id
  private bookmarks = new Map<string, CameraBookmarkRecord>(); // by shot id
  private frames = new Map<string, MasterFrameRecord>();
  private paths = new Map<string, CameraPathRecord>(); // by shot id
  private clips = new Map<string, PrevisClipRecord>();
  private blocking = new Map<string, ShotBlockingRecord>(); // by `${shotId}:${characterId}`
  private bundles = new Map<string, SpatialPassBundleRecord>();
  private reconstructions = new Map<string, SpatialReconstructionRecord>();
  private jobs = new Map<string, ReconstructionJobRecord>();
  private jobEvents: JobEventRecord[] = [];

  constructor(private readonly access: MemoryProjectsAccess) {}

  private project(projectId: string) {
    const p = this.access.all().find((x) => x.project.id === projectId);
    if (!p) throw new PrevisError("not_found", "That project no longer exists.");
    return p;
  }
  private requireLocation(projectId: string, locationId: string) {
    if (!this.project(projectId).locations.some((l) => l.id === locationId))
      throw new PrevisError("not_found", "That location is not in this project.");
  }
  private requireShot(projectId: string, shotId: string) {
    if (!this.project(projectId).shots.some((s) => s.id === shotId))
      throw new PrevisError("not_found", "That shot is not in this project.");
  }

  private requireCharacter(projectId: string, characterId: string) {
    if (!this.project(projectId).characters.some((c) => c.id === characterId))
      throw new PrevisError("not_found", "That character is not in this project.");
  }

  private blockingFor(shotId: string): ShotBlockingRecord[] {
    return [...this.blocking.values()]
      .filter((b) => b.shotId === shotId)
      .sort((a, b) => (a.characterId < b.characterId ? -1 : 1));
  }

  /** What the Shot's picture shows of its blocking right now (visible figures only; null = none). */
  private currentBlockingFingerprint(shotId: string): string | null {
    const recs = this.blockingFor(shotId);
    if (recs.length === 0) return null;
    return renderedBlockingFingerprint(
      recs.map((r) => r.entry),
      { locationId: recs[0].locationId },
    );
  }

  async getSceneForLocation(locationId: string) {
    const s = this.scenes.get(locationId);
    return s ? clone(s) : null;
  }

  async getScene(sceneDocumentId: string) {
    for (const s of this.scenes.values()) if (s.id === sceneDocumentId) return clone(s);
    return null;
  }

  async saveScene(input: SaveSceneInput) {
    this.requireLocation(input.projectId, input.locationId);
    const existing = this.scenes.get(input.locationId);
    const fp = sceneFingerprint(input.document);
    if (!existing) {
      if (input.expectedRevision !== null)
        throw new PrevisError("conflict", "This set was changed elsewhere. Reload before saving.");
      const rec: SceneDocumentRecord = {
        id: input.id,
        projectId: input.projectId,
        locationId: input.locationId,
        engine: input.document.engine,
        engineVersion: input.engineVersion,
        upstreamCommit: input.document.upstreamCommit,
        schemaVersion: input.document.schema,
        revision: 1,
        document: clone(input.document),
        sceneFingerprint: fp,
        createdBy: input.userId,
        createdAt: input.now,
        updatedAt: input.now,
      };
      this.scenes.set(input.locationId, rec);
      return clone(rec);
    }
    if (existing.projectId !== input.projectId) throw new PrevisError("not_found", "Scene not found.");
    if (input.expectedRevision !== existing.revision)
      throw new PrevisError("conflict", "This set was changed elsewhere. Reload before saving.");
    const next: SceneDocumentRecord = {
      ...existing,
      engineVersion: input.engineVersion,
      upstreamCommit: input.document.upstreamCommit,
      revision: existing.revision + 1,
      document: clone(input.document),
      sceneFingerprint: fp,
      updatedAt: input.now,
    };
    this.scenes.set(input.locationId, next);
    return clone(next);
  }

  async getBookmarkForShot(shotId: string) {
    const b = this.bookmarks.get(shotId);
    return b ? clone(b) : null;
  }

  async setBookmark(input: SetBookmarkInput) {
    this.requireShot(input.projectId, input.shotId);
    this.requireLocation(input.projectId, input.locationId);
    const scene = await this.getScene(input.sceneDocumentId);
    if (!scene || scene.projectId !== input.projectId || scene.locationId !== input.locationId)
      throw new PrevisError("not_found", "That 3D set was not found for this location.");
    if (!scene.document.productionCamera)
      throw new PrevisError("no_camera", "This set has no production camera yet.");
    const existing = this.bookmarks.get(input.shotId);
    const rec: CameraBookmarkRecord = {
      id: existing?.id ?? input.id,
      projectId: input.projectId,
      shotId: input.shotId,
      locationId: input.locationId,
      sceneDocumentId: scene.id,
      sceneRevision: scene.revision,
      sceneFingerprint: scene.sceneFingerprint,
      cameraLabel: scene.document.productionCamera.label,
      value: bookmarkFromCamera(scene.document.productionCamera),
      createdBy: existing?.createdBy ?? input.userId,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    this.bookmarks.set(input.shotId, rec);
    return clone(rec);
  }

  private cameraMotionFor(shotId: string, currentAudioMix?: AudioMixResolver): CameraMotionReference | null {
    const p = this.paths.get(shotId);
    if (!p) return null;
    const clip = pickCurrentClip(
      [...this.clips.values()].filter((c) => c.shotId === shotId),
      p.pathFingerprint,
      currentAudioMix?.(shotId, p.durationMs) ?? null,
      this.currentBlockingFingerprint(shotId),
    );
    return {
      schemaVersion: CAMERA_MOTION_SCHEMA_VERSION,
      cameraPathId: p.id,
      cameraPathRevision: p.revision,
      cameraPathFingerprint: p.pathFingerprint,
      sceneRevision: p.sceneRevision,
      sceneFingerprint: p.sceneFingerprint,
      durationMs: p.durationMs,
      frameRate: p.frameRate,
      interpolation: p.path.interpolation,
      focalLengthBasis: "vertical-sensor-24mm",
      keyframes: structuredClone(p.path.keyframes),
      previsAssetId: clip?.assetId ?? null,
      ...(clip
        ? {
            previs: {
              assetId: clip.assetId,
              hasAudio: clip.hasAudio,
              audioMixFingerprint: clip.audioMixFingerprint,
            },
          }
        : {}),
    };
  }

  /** The Shot's latest bundle that is exactly current for the saved scene, camera and rendered blocking. */
  private currentControlPasses(
    shotId: string,
    sceneFingerprint: string,
    path: CameraPathRecord | null,
    bookmark: CameraBookmarkRecord | null,
  ) {
    const cur = pickCurrentBundle(
      [...this.bundles.values()].filter((x) => x.shotId === shotId),
      {
        sceneFingerprint,
        blockingFingerprint: this.currentBlockingFingerprint(shotId),
        pathFingerprint: path?.pathFingerprint ?? null,
        bookmarkCameraFingerprint: bookmark ? bookmarkCameraFingerprint(bookmark.value) : null,
      },
    );
    return cur ? buildControlPassesReference(cur) : null;
  }

  async listSpatialReferences(projectId: string, currentAudioMix?: AudioMixResolver) {
    const out: Record<string, SpatialReference> = {};
    const shotIds = new Set<string>();
    for (const [shotId, b] of this.bookmarks) if (b.projectId === projectId) shotIds.add(shotId);
    for (const [shotId, p] of this.paths) if (p.projectId === projectId) shotIds.add(shotId);
    for (const b of this.blocking.values()) if (b.projectId === projectId) shotIds.add(b.shotId);
    for (const shotId of shotIds) {
      const b = this.bookmarks.get(shotId) ?? null;
      const p = this.paths.get(shotId) ?? null;
      const blockRecs = this.blockingFor(shotId);
      const sceneId = b?.sceneDocumentId ?? p?.sceneDocumentId ?? blockRecs[0]?.sceneDocumentId;
      const scene = [...this.scenes.values()].find((x) => x.id === sceneId);
      if (!scene) continue;
      const adopted = [...this.frames.values()]
        .filter((f) => f.shotId === shotId && f.adoptedAt)
        .sort((x, y) => ((x.adoptedAt ?? "") < (y.adoptedAt ?? "") ? 1 : -1))[0];
      out[shotId] = buildSpatialReference({
        locationId: scene.locationId,
        scene: {
          id: scene.id,
          revision: scene.revision,
          sceneFingerprint: scene.sceneFingerprint,
          document: scene.document,
        },
        bookmark: b
          ? {
              id: b.id,
              cameraLabel: b.cameraLabel,
              sceneRevision: b.sceneRevision,
              sceneFingerprint: b.sceneFingerprint,
              value: b.value,
            }
          : null,
        adoptedMasterFrameAssetId: adopted?.assetId ?? null,
        cameraMotion: this.cameraMotionFor(shotId, currentAudioMix),
        shotBlocking: buildShotBlockingReference(
          blockRecs,
          Object.fromEntries(this.project(projectId).characters.map((c) => [c.id, c.name])),
          { locationId: scene.locationId },
        ),
        controlPasses: this.currentControlPasses(shotId, scene.sceneFingerprint, p, b),
        reconstructions: [...this.reconstructions.values()].filter((r) => r.locationId === scene.locationId),
      });
    }
    return structuredClone(out);
  }

  async listMasterFrames(shotId: string) {
    return [...this.frames.values()]
      .filter((f) => f.shotId === shotId)
      .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1))
      .map(clone);
  }

  async getMasterFrame(id: string) {
    const f = this.frames.get(id);
    return f ? clone(f) : null;
  }

  async recordMasterFrame(input: NewMasterFrame) {
    this.requireShot(input.projectId, input.shotId);
    this.requireLocation(input.projectId, input.locationId);
    const rec: MasterFrameRecord = {
      id: input.id,
      projectId: input.projectId,
      shotId: input.shotId,
      locationId: input.locationId,
      sceneDocumentId: input.sceneDocumentId,
      sceneRevision: input.sceneRevision,
      sceneFingerprint: input.sceneFingerprint,
      cameraBookmarkId: input.cameraBookmarkId,
      assetId: input.assetId,
      source: "scene_render",
      renderWidth: input.renderWidth,
      renderHeight: input.renderHeight,
      productionAspectRatio: input.productionAspectRatio,
      capturedAt: input.capturedAt,
      adoptedAt: null,
      adoptedFrameId: null,
      blockingFingerprint: input.blockingFingerprint ?? null,
      blocking: input.blocking ? clone(input.blocking) : null,
      createdBy: input.userId,
      createdAt: input.capturedAt,
    };
    this.frames.set(rec.id, rec);
    return clone(rec);
  }

  async adoptMasterFrame(id: string, storyboardFrameId: string, now: string) {
    const f = this.frames.get(id);
    if (!f) throw new PrevisError("not_found", "That master frame was not found.");
    const next = { ...f, adoptedAt: now, adoptedFrameId: storyboardFrameId };
    this.frames.set(id, next);
    return clone(next);
  }

  async getCameraPathForShot(shotId: string) {
    const p = this.paths.get(shotId);
    return p ? clone(p) : null;
  }

  async saveCameraPath(input: SaveCameraPathInput) {
    this.requireShot(input.projectId, input.shotId);
    this.requireLocation(input.projectId, input.locationId);
    const problems = validateCameraPath(input.path);
    if (problems.length > 0) throw new PrevisError("invalid", problems.join("; "));
    const scene = await this.getScene(input.sceneDocumentId);
    if (!scene || scene.projectId !== input.projectId || scene.locationId !== input.locationId)
      throw new PrevisError("not_found", "That 3D set was not found for this location.");
    const existing = this.paths.get(input.shotId);
    const base = {
      projectId: input.projectId,
      shotId: input.shotId,
      locationId: input.locationId,
      sceneDocumentId: scene.id,
      sceneRevision: input.sceneRevision,
      sceneFingerprint: input.sceneFingerprint,
      schemaVersion: input.path.schema,
      durationMs: input.path.durationMs,
      frameRate: input.path.frameRate,
      path: clone(input.path),
      pathFingerprint: cameraPathFingerprint(input.path),
      updatedAt: input.now,
    };
    if (!existing) {
      if (input.expectedRevision !== null)
        throw new PrevisError("conflict", "This camera path was changed elsewhere. Reload before saving.");
      const rec: CameraPathRecord = {
        id: input.id,
        revision: 1,
        createdBy: input.userId,
        createdAt: input.now,
        ...base,
      };
      this.paths.set(input.shotId, rec);
      return clone(rec);
    }
    if (input.expectedRevision !== existing.revision)
      throw new PrevisError("conflict", "This camera path was changed elsewhere. Reload before saving.");
    const next: CameraPathRecord = { ...existing, ...base, revision: existing.revision + 1 };
    this.paths.set(input.shotId, next);
    return clone(next);
  }

  async listShotBlocking(shotId: string) {
    return this.blockingFor(shotId).map(clone);
  }

  async saveShotBlocking(input: SaveShotBlockingInput) {
    this.requireShot(input.projectId, input.shotId);
    this.requireLocation(input.projectId, input.locationId);
    this.requireCharacter(input.projectId, input.characterId);
    const scene = await this.getScene(input.sceneDocumentId);
    if (!scene || scene.projectId !== input.projectId || scene.locationId !== input.locationId)
      throw new PrevisError("not_found", "That 3D set was not found for this location.");
    let entry;
    try {
      entry = parseBlockingEntry(input.entry);
    } catch (err) {
      throw new PrevisError("invalid", `Invalid character blocking: ${(err as Error).message}`);
    }
    if (entry.characterId !== input.characterId)
      throw new PrevisError("invalid", "The blocking is for a different character.");
    const key = `${input.shotId}:${input.characterId}`;
    const existing = this.blocking.get(key);
    const base = {
      projectId: input.projectId,
      shotId: input.shotId,
      characterId: input.characterId,
      locationId: input.locationId,
      sceneDocumentId: scene.id,
      sceneRevision: input.sceneRevision,
      sceneFingerprint: input.sceneFingerprint,
      schemaVersion: entry.schema,
      rigVersion: entry.pose.rig,
      entry: clone(entry),
      poseFingerprint: poseFingerprint(entry.pose),
      blockingFingerprint: blockingFingerprint(entry, { locationId: input.locationId }),
      updatedAt: input.now,
    };
    const conflict = new PrevisError(
      "conflict",
      "This character's blocking was changed elsewhere. Reload before saving.",
    );
    if (!existing) {
      if (input.expectedRevision !== null) throw conflict;
      const rec: ShotBlockingRecord = {
        id: input.id,
        revision: 1,
        createdBy: input.userId,
        createdAt: input.now,
        ...base,
      };
      this.blocking.set(key, rec);
      return clone(rec);
    }
    if (input.expectedRevision !== existing.revision) throw conflict;
    const next: ShotBlockingRecord = { ...existing, ...base, revision: existing.revision + 1 };
    this.blocking.set(key, next);
    return clone(next);
  }

  async removeShotBlocking(input: {
    projectId: string;
    shotId: string;
    characterId: string;
    expectedRevision: number;
  }) {
    const key = `${input.shotId}:${input.characterId}`;
    const existing = this.blocking.get(key);
    if (!existing || existing.projectId !== input.projectId)
      throw new PrevisError("not_found", "That character has no blocking in this shot.");
    if (existing.revision !== input.expectedRevision)
      throw new PrevisError("conflict", "This character's blocking was changed elsewhere. Reload first.");
    this.blocking.delete(key);
  }

  async reanchorShotBlocking(input: {
    projectId: string;
    shotId: string;
    sceneDocumentId: string;
    userId: string | null;
    now: string;
  }) {
    const scene = await this.getScene(input.sceneDocumentId);
    if (!scene || scene.projectId !== input.projectId)
      throw new PrevisError("not_found", "That 3D set was not found.");
    const out: ShotBlockingRecord[] = [];
    for (const rec of this.blockingFor(input.shotId)) {
      if (rec.projectId !== input.projectId || rec.sceneDocumentId !== scene.id) continue;
      const next: ShotBlockingRecord = {
        ...rec,
        sceneRevision: scene.revision,
        sceneFingerprint: scene.sceneFingerprint,
        revision: rec.revision + 1,
        updatedAt: input.now,
      };
      this.blocking.set(`${rec.shotId}:${rec.characterId}`, next);
      out.push(clone(next));
    }
    return out;
  }

  async listPrevisClips(shotId: string) {
    return [...this.clips.values()]
      .filter((c) => c.shotId === shotId)
      .sort((a, b) => (a.renderedAt < b.renderedAt ? 1 : -1))
      .map(clone);
  }

  async listReconstructions(locationId: string) {
    return [...this.reconstructions.values()]
      .filter((r) => r.locationId === locationId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1))
      .map(clone);
  }

  async getReconstruction(id: string) {
    const r = this.reconstructions.get(id);
    return r ? clone(r) : null;
  }

  async reconstructionUsesAsset(assetId: string) {
    return [...this.reconstructions.values()].some(
      (r) => r.resultAssetId === assetId || r.sources.some((s) => s.assetId === assetId),
    );
  }

  async recordReconstruction(input: NewSpatialReconstruction) {
    this.requireLocation(input.projectId, input.locationId);
    const calibration = calibrationSchema.parse(input.calibration);
    const sources = sourcesFor(input.method, input.sources);
    const generation =
      input.method === "generated" ? generationProvenanceSchema.parse(input.generation) : null;
    if (input.method !== "generated" && input.generation)
      throw new PrevisError("invalid", "Only a generated reconstruction carries provider provenance.");
    if (
      generation &&
      [...this.reconstructions.values()].some((r) => r.generation?.jobId === generation.jobId)
    )
      throw new PrevisError("conflict", "That reconstruction job already produced its reconstruction.");
    const rec: SpatialReconstructionRecord = {
      id: input.id,
      projectId: input.projectId,
      locationId: input.locationId,
      schemaVersion: RECONSTRUCTION_SCHEMA,
      method: input.method,
      resultKind: input.resultKind,
      resultAssetId: input.resultAssetId,
      resultChecksum: input.resultChecksum,
      resultFormat: input.resultFormat,
      gaussianCount: input.gaussianCount,
      sources,
      calibration,
      generation,
      fingerprint: reconstructionFingerprintOf({
        locationId: input.locationId,
        method: input.method,
        resultKind: input.resultKind,
        resultAssetId: input.resultAssetId,
        resultChecksum: input.resultChecksum,
        sources,
        calibration,
        generation,
      }),
      createdBy: input.userId,
      createdAt: input.now,
    };
    if (
      [...this.reconstructions.values()].some(
        (r) => r.locationId === rec.locationId && r.fingerprint === rec.fingerprint,
      )
    )
      throw new PrevisError("conflict", "That exact reconstruction is already recorded for this location.");
    this.reconstructions.set(rec.id, rec);
    return clone(rec);
  }

  async createReconstructionJob(input: NewReconstructionJob) {
    this.requireLocation(input.projectId, input.locationId);
    const rec = newJobRecord(input);
    const dup = [...this.jobs.values()].some(
      (j) =>
        j.projectId === rec.projectId && j.jobFingerprint === rec.jobFingerprint && j.attempt === rec.attempt,
    );
    if (dup) throw new PrevisError("conflict", "That reconstruction attempt already exists.");
    if (input.previousJobId) {
      const prev = this.jobs.get(input.previousJobId);
      if (!prev || prev.projectId !== input.projectId)
        throw new PrevisError("invalid", "The job being retried is not in this project.");
    }
    this.jobs.set(rec.id, rec);
    return clone(rec);
  }

  async getReconstructionJob(id: string) {
    const j = this.jobs.get(id);
    return j ? clone(j) : null;
  }

  /**
   * Memory counterpart of a narrow privileged discovery query: id, project, owner, status and creation time of ONE
   * provider's jobs in one project and the given states, oldest first. No job content.
   */
  discoverReconstructionJobs(filter: { provider: string; projectId: string; statuses: readonly string[] }) {
    return [...this.jobs.values()]
      .filter(
        (j) =>
          j.provider === filter.provider &&
          j.projectId === filter.projectId &&
          filter.statuses.includes(j.status),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .map((j) => ({
        id: j.id,
        projectId: j.projectId,
        ownerId: j.createdBy,
        status: j.status,
        createdAt: j.createdAt,
      }));
  }

  async listReconstructionJobs(locationId: string) {
    return [...this.jobs.values()]
      .filter((j) => j.locationId === locationId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1))
      .map(clone);
  }

  async updateReconstructionJob(id: string, expectedRevision: number, patch: JobPatch, now: string) {
    const job = this.jobs.get(id);
    if (!job) throw new PrevisError("not_found", "That reconstruction job no longer exists.");
    if (job.revision !== expectedRevision)
      throw new PrevisError("conflict", "The reconstruction job changed in the meantime.");
    let next: ReconstructionJobRecord;
    try {
      next = applyJobPatch(job, patch, now);
    } catch (e) {
      if (e instanceof JobTransitionError) throw new PrevisError("invalid", e.message);
      throw e;
    }
    this.jobs.set(id, next);
    return clone(next);
  }

  async completeReconstructionJob(input: {
    jobId: string;
    expectedRevision: number;
    reconstruction: NewSpatialReconstruction;
    providerResult: Record<string, unknown> | null;
    now: string;
  }) {
    const job = this.jobs.get(input.jobId);
    if (!job) throw new PrevisError("not_found", "That reconstruction job no longer exists.");
    if (job.revision !== input.expectedRevision || job.status !== "ingesting")
      throw new PrevisError("conflict", "The reconstruction job changed in the meantime.");
    if (input.reconstruction.generation?.jobId !== job.id)
      throw new PrevisError("invalid", "The reconstruction does not belong to this job.");
    // both writes or neither: the reconstruction is validated first, then the job moves
    const reconstruction = await this.recordReconstruction(input.reconstruction);
    const next: ReconstructionJobRecord = {
      ...job,
      status: "succeeded",
      progress: 1,
      providerResult:
        (sanitizeProviderPayload(input.providerResult) as Record<string, unknown> | null) ?? null,
      resultReconstructionId: reconstruction.id,
      revision: job.revision + 1,
      updatedAt: input.now,
      completedAt: input.now,
    };
    this.jobs.set(job.id, next);
    return { job: clone(next), reconstruction };
  }

  async appendReconstructionJobEvent(input: {
    projectId: string;
    jobId: string;
    event: JobEvent;
    detail: Record<string, unknown>;
    now: string;
  }) {
    const job = this.jobs.get(input.jobId);
    if (!job || job.projectId !== input.projectId)
      throw new PrevisError("not_found", "No such reconstruction job.");
    this.jobEvents.push({
      id: `${input.jobId}:${this.jobEvents.length + 1}`,
      jobId: input.jobId,
      event: input.event,
      detail: (sanitizeProviderPayload(input.detail) as Record<string, unknown>) ?? {},
      createdAt: input.now,
    });
  }

  async listReconstructionJobEvents(jobId: string) {
    return this.jobEvents.filter((e) => e.jobId === jobId).map(clone);
  }

  async listSpatialPassBundles(shotId: string) {
    return [...this.bundles.values()]
      .filter((b) => b.shotId === shotId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1))
      .map(clone);
  }

  async getSpatialPassBundle(id: string) {
    const b = this.bundles.get(id);
    return b ? clone(b) : null;
  }

  async spatialPassUsesAsset(assetId: string) {
    return [...this.bundles.values()].some(
      (b) =>
        b.depth.assetId === assetId ||
        b.objectIds.assetId === assetId ||
        Object.values(b.characterMasks.masks).some((m) => m.assetId === assetId),
    );
  }

  async recordSpatialPassBundle(input: NewSpatialPassBundle) {
    this.requireShot(input.projectId, input.shotId);
    this.requireLocation(input.projectId, input.locationId);
    const dup = [...this.bundles.values()].find(
      (b) => b.shotId === input.shotId && b.bundleFingerprint === input.bundleFingerprint,
    );
    if (dup) return { record: clone(dup), existing: true };
    const { userId, ...rest } = input;
    const rec: SpatialPassBundleRecord = {
      ...clone(rest),
      schemaVersion: SPATIAL_PASS_BUNDLE_SCHEMA,
      createdBy: userId,
    };
    this.bundles.set(rec.id, rec);
    return { record: clone(rec), existing: false };
  }

  async getPrevisClip(id: string) {
    const c = this.clips.get(id);
    return c ? clone(c) : null;
  }

  async recordPrevisClip(input: NewPrevisClip) {
    this.requireShot(input.projectId, input.shotId);
    this.requireLocation(input.projectId, input.locationId);
    const { userId, ...rest } = input;
    if (
      input.hasAudio !== (input.audioMix !== null) ||
      input.hasAudio !== (input.audioMixFingerprint !== null)
    )
      throw new PrevisError("invalid", "A previs with audio needs its audio mix provenance (and only then).");
    if (input.audioAssetId !== null)
      throw new PrevisError("invalid", "A performance-audio mix is not a single audio asset.");
    const rec: PrevisClipRecord = {
      ...rest,
      blockingFingerprint: input.blockingFingerprint ?? null,
      blocking: input.blocking ? clone(input.blocking) : null,
      source: "local_previs",
      createdBy: userId,
      createdAt: input.renderedAt,
    };
    this.clips.set(rec.id, rec);
    return clone(rec);
  }
}
