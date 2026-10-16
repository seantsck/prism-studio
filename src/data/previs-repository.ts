import type { SpatialReference } from "@/domain/previs/spatial";
import type { CameraBookmarkValue, PrevisDocument } from "@/domain/previs/types";

/** One current editable 3D scene per Location (prism.previs.v1 wrapper). */
export interface SceneDocumentRecord {
  id: string;
  projectId: string;
  locationId: string;
  engine: string;
  engineVersion: string;
  upstreamCommit: string;
  schemaVersion: string;
  revision: number;
  document: PrevisDocument;
  sceneFingerprint: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The Shot's production camera, tied to the scene revision and fingerprint it was authored against. */
export interface CameraBookmarkRecord {
  id: string;
  projectId: string;
  shotId: string;
  locationId: string;
  sceneDocumentId: string;
  sceneRevision: number;
  sceneFingerprint: string;
  cameraLabel: string;
  value: CameraBookmarkValue;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MasterFrameRecord {
  id: string;
  projectId: string;
  shotId: string;
  locationId: string;
  sceneDocumentId: string;
  sceneRevision: number;
  sceneFingerprint: string;
  cameraBookmarkId: string | null;
  assetId: string;
  source: "scene_render";
  renderWidth: number;
  renderHeight: number;
  productionAspectRatio: string;
  capturedAt: string;
  adoptedAt: string | null;
  adoptedFrameId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export class PrevisError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid" | "no_camera",
    message: string,
  ) {
    super(message);
    this.name = "PrevisError";
  }
}

export interface SaveSceneInput {
  id: string;
  projectId: string;
  locationId: string;
  document: PrevisDocument;
  /** null = this is the first save for the location; otherwise the revision the editor loaded */
  expectedRevision: number | null;
  engineVersion: string;
  userId: string | null;
  now: string;
}

export interface SetBookmarkInput {
  id: string;
  projectId: string;
  shotId: string;
  locationId: string;
  sceneDocumentId: string;
  userId: string | null;
  now: string;
}

export interface NewMasterFrame {
  id: string;
  projectId: string;
  shotId: string;
  locationId: string;
  sceneDocumentId: string;
  sceneRevision: number;
  sceneFingerprint: string;
  cameraBookmarkId: string | null;
  assetId: string;
  renderWidth: number;
  renderHeight: number;
  productionAspectRatio: string;
  capturedAt: string;
  userId: string | null;
}

export interface PrevisRepository {
  getSceneForLocation(locationId: string): Promise<SceneDocumentRecord | null>;
  getScene(sceneDocumentId: string): Promise<SceneDocumentRecord | null>;
  /** Insert or compare-and-set update; throws PrevisError("conflict") on a stale expectedRevision. */
  saveScene(input: SaveSceneInput): Promise<SceneDocumentRecord>;

  getBookmarkForShot(shotId: string): Promise<CameraBookmarkRecord | null>;
  /** Per-shot spatial snapshot for every shot of the project that has a production camera bookmark. */
  listSpatialReferences(projectId: string): Promise<Record<string, SpatialReference>>;
  /** Freezes the scene's CURRENT production camera for the shot. Throws "no_camera" when the scene has none. */
  setBookmark(input: SetBookmarkInput): Promise<CameraBookmarkRecord>;

  listMasterFrames(shotId: string): Promise<MasterFrameRecord[]>;
  getMasterFrame(id: string): Promise<MasterFrameRecord | null>;
  recordMasterFrame(input: NewMasterFrame): Promise<MasterFrameRecord>;
  /** The explicit "Use as Master Frame" decision. Never called automatically. */
  adoptMasterFrame(id: string, storyboardFrameId: string, now: string): Promise<MasterFrameRecord>;
}
