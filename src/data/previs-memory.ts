import { pickCurrentClip } from "@/domain/previs/audio-mix";
import {
  blockingFingerprint,
  buildShotBlockingReference,
  parseBlockingEntry,
  renderedBlockingFingerprint,
} from "@/domain/previs/blocking";
import { poseFingerprint } from "@/domain/previs/pose";
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
