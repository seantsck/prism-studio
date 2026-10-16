import type { CameraPath } from "@/domain/previs/camera-path";
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

/** The Shot's current editable camera motion, tied to the scene state it was authored against. */
export interface CameraPathRecord {
  id: string;
  projectId: string;
  shotId: string;
  locationId: string;
  sceneDocumentId: string;
  sceneRevision: number;
  sceneFingerprint: string;
  schemaVersion: string;
  revision: number;
  durationMs: number;
  frameRate: number;
  path: CameraPath;
  pathFingerprint: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveCameraPathInput {
  id: string;
  projectId: string;
  shotId: string;
  locationId: string;
  sceneDocumentId: string;
  /** the LIVE set state the path is being authored against (looked up server-side, never trusted from the client) */
  sceneRevision: number;
  sceneFingerprint: string;
  path: CameraPath;
  /** null = first save for the shot; otherwise the revision the editor loaded */
  expectedRevision: number | null;
  userId: string | null;
  now: string;
}

/** A locally rendered previs video and the exact path + scene state it was rendered from. */
export interface PrevisClipRecord {
  id: string;
  projectId: string;
  shotId: string;
  locationId: string;
  cameraPathId: string | null;
  pathRevision: number;
  pathFingerprint: string;
  sceneDocumentId: string;
  sceneRevision: number;
  sceneFingerprint: string;
  assetId: string;
  source: "local_previs";
  frameRate: number;
  durationMs: number;
  renderWidth: number;
  renderHeight: number;
  container: "mp4" | "webm";
  codec: string;
  hasAudio: boolean;
  audioAssetId: string | null;
  renderedAt: string;
  createdBy: string | null;
  createdAt: string;
}

export type NewPrevisClip = Omit<PrevisClipRecord, "source" | "createdAt" | "createdBy"> & {
  userId: string | null;
};

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

  getCameraPathForShot(shotId: string): Promise<CameraPathRecord | null>;
  /** Insert or compare-and-set update; throws PrevisError("conflict") on a stale expectedRevision. */
  saveCameraPath(input: SaveCameraPathInput): Promise<CameraPathRecord>;

  listPrevisClips(shotId: string): Promise<PrevisClipRecord[]>;
  getPrevisClip(id: string): Promise<PrevisClipRecord | null>;
  recordPrevisClip(input: NewPrevisClip): Promise<PrevisClipRecord>;
}
