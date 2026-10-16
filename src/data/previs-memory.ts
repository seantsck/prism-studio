import { bookmarkFromCamera } from "@/domain/previs/camera";
import { sceneFingerprint } from "@/domain/previs/document";
import { buildSpatialReference, type SpatialReference } from "@/domain/previs/spatial";
import type { MemoryProjectsAccess } from "./generation-memory";
import {
  PrevisError,
  type CameraBookmarkRecord,
  type MasterFrameRecord,
  type NewMasterFrame,
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

  async listSpatialReferences(projectId: string) {
    const out: Record<string, SpatialReference> = {};
    for (const [shotId, b] of this.bookmarks) {
      if (b.projectId !== projectId) continue;
      const scene = [...this.scenes.values()].find((s) => s.id === b.sceneDocumentId);
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
        bookmark: {
          id: b.id,
          cameraLabel: b.cameraLabel,
          sceneRevision: b.sceneRevision,
          sceneFingerprint: b.sceneFingerprint,
          value: b.value,
        },
        adoptedMasterFrameAssetId: adopted?.assetId ?? null,
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
}
