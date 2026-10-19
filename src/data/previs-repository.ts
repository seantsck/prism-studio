import type {
  JobEvent,
  JobEventRecord,
  JobPatch,
  NewReconstructionJob,
  ReconstructionJobRecord,
} from "@/domain/reconstruction/job";
import type { NewSpatialReconstruction, SpatialReconstructionRecord } from "@/domain/previs/splat";
import type { StoredAudioMix } from "@/domain/previs/audio-mix";
import type { RenderedBlockingFigure, ShotBlockingEntry } from "@/domain/previs/blocking";
import type { CameraPath } from "@/domain/previs/camera-path";
import type { SpatialReference } from "@/domain/previs/spatial";
import type {
  CharacterMasksJson,
  ControlCameraSource,
  DepthMetadata,
  ObjectManifest,
  OBJECT_ID_FORMAT,
  DEPTH_FORMAT,
} from "@/domain/previs/spatial-passes";
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
  /** identity of the character-blocking layer the picture showed (null = no character proxies) */
  blockingFingerprint: string | null;
  /** which stored blocking each figure was rendered from (by value; never a URL) */
  blocking: RenderedBlockingFigure[] | null;
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
  /** true when the file contains the performance audio described by `audioMix` */
  hasAudio: boolean;
  /** legacy single-asset field: always null (a mix of several takes is not one asset) */
  audioAssetId: string | null;
  /** the frozen mix provenance (ids + checksums, never URLs); null for a silent previs */
  audioMix: StoredAudioMix | null;
  audioMixFingerprint: string | null;
  /** identity of the character-blocking layer the previs showed (null = no character proxies) */
  blockingFingerprint: string | null;
  blocking: RenderedBlockingFigure[] | null;
  renderedAt: string;
  createdBy: string | null;
  createdAt: string;
}

export type NewPrevisClip = Omit<
  PrevisClipRecord,
  "source" | "createdAt" | "createdBy" | "blockingFingerprint" | "blocking"
> & {
  blockingFingerprint?: string | null;
  blocking?: RenderedBlockingFigure[] | null;
  userId: string | null;
};

/** The Shot's CURRENT performance-audio mix fingerprint at a render duration (null = no selected audio). */
export type AudioMixResolver = (shotId: string, renderDurationMs: number) => string | null;

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
  blockingFingerprint?: string | null;
  blocking?: RenderedBlockingFigure[] | null;
  userId: string | null;
}

/**
 * One Character's blocking in ONE Shot: root placement + skeletal pose, tied to the Set state it was authored
 * against. CAS on `revision`. The proxy carries no identity.
 */
export interface ShotBlockingRecord {
  id: string;
  projectId: string;
  shotId: string;
  characterId: string;
  locationId: string;
  sceneDocumentId: string;
  sceneRevision: number;
  sceneFingerprint: string;
  schemaVersion: string;
  rigVersion: string;
  revision: number;
  entry: ShotBlockingEntry;
  poseFingerprint: string;
  blockingFingerprint: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveShotBlockingInput {
  id: string;
  projectId: string;
  shotId: string;
  characterId: string;
  locationId: string;
  sceneDocumentId: string;
  /** the LIVE set state the blocking is authored against (looked up server-side, never trusted from the client) */
  sceneRevision: number;
  sceneFingerprint: string;
  entry: ShotBlockingEntry;
  /** null = first save for this (shot, character); otherwise the revision the editor loaded */
  expectedRevision: number | null;
  userId: string | null;
  now: string;
}

/**
 * One immutable spatial control-pass capture (M2C): depth + object ids + Character masks for ONE exact control
 * frame. Historical truth: never updated in place. Assets are private machine data; nothing here is a URL.
 */
export interface SpatialPassBundleRecord {
  id: string;
  projectId: string;
  shotId: string;
  locationId: string;
  sceneDocumentId: string;
  sceneRevision: number;
  sceneFingerprint: string;
  /** identity of the rendered blocking layer (null = no visible proxies) */
  blockingFingerprint: string | null;
  camera: ControlCameraSource;
  schemaVersion: string;
  bundleFingerprint: string;
  width: number;
  height: number;
  depth: { assetId: string; encoding: typeof DEPTH_FORMAT; metadata: DepthMetadata };
  objectIds: { assetId: string; encoding: typeof OBJECT_ID_FORMAT; manifest: ObjectManifest };
  characterMasks: CharacterMasksJson;
  createdBy: string | null;
  createdAt: string;
}

export type NewSpatialPassBundle = Omit<SpatialPassBundleRecord, "createdBy" | "schemaVersion"> & {
  userId: string | null;
};

export interface PrevisRepository {
  /** Newest first. Immutable origin records of the Location's spatial reconstructions (M2D.1). */
  listReconstructions(locationId: string): Promise<SpatialReconstructionRecord[]>;
  getReconstruction(id: string): Promise<SpatialReconstructionRecord | null>;
  /** True when a reconstruction depends on this asset (as its result or as a source image). */
  reconstructionUsesAsset(assetId: string): Promise<boolean>;
  /** Records an immutable reconstruction; the fingerprint is computed here from the identity fields. */
  recordReconstruction(input: NewSpatialReconstruction): Promise<SpatialReconstructionRecord>;

  // ── reconstruction jobs (M2D.2) ──
  createReconstructionJob(input: NewReconstructionJob): Promise<ReconstructionJobRecord>;
  getReconstructionJob(id: string): Promise<ReconstructionJobRecord | null>;
  /** Newest first, every attempt (history is retained). */
  listReconstructionJobs(locationId: string): Promise<ReconstructionJobRecord[]>;
  /**
   * Compare-and-set on `revision`: applies one server-derived change only if nobody else changed the job since it was
   * read. Throws PrevisError("conflict") when another request won, PrevisError("invalid") on a forbidden transition.
   */
  updateReconstructionJob(
    id: string,
    expectedRevision: number,
    patch: JobPatch,
    now: string,
  ): Promise<ReconstructionJobRecord>;
  /**
   * The ONLY way a job succeeds: atomically records the generated reconstruction AND moves the job ingesting ->
   * succeeded with its result link (CAS on revision). Exactly one caller can win; the loser gets a conflict and no row.
   */
  completeReconstructionJob(input: {
    jobId: string;
    expectedRevision: number;
    reconstruction: NewSpatialReconstruction;
    providerResult: Record<string, unknown> | null;
    now: string;
  }): Promise<{ job: ReconstructionJobRecord; reconstruction: SpatialReconstructionRecord }>;
  appendReconstructionJobEvent(input: {
    projectId: string;
    jobId: string;
    event: JobEvent;
    detail: Record<string, unknown>;
    now: string;
  }): Promise<void>;
  listReconstructionJobEvents(jobId: string): Promise<JobEventRecord[]>;

  getSceneForLocation(locationId: string): Promise<SceneDocumentRecord | null>;
  getScene(sceneDocumentId: string): Promise<SceneDocumentRecord | null>;
  /** Insert or compare-and-set update; throws PrevisError("conflict") on a stale expectedRevision. */
  saveScene(input: SaveSceneInput): Promise<SceneDocumentRecord>;

  getBookmarkForShot(shotId: string): Promise<CameraBookmarkRecord | null>;
  /** Per-shot spatial snapshot for every shot of the project that has a production camera bookmark. */
  listSpatialReferences(
    projectId: string,
    currentAudioMix?: AudioMixResolver,
  ): Promise<Record<string, SpatialReference>>;
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

  listShotBlocking(shotId: string): Promise<ShotBlockingRecord[]>;
  /** Insert or compare-and-set update of ONE Character's blocking in ONE Shot. Other Shots are never touched. */
  saveShotBlocking(input: SaveShotBlockingInput): Promise<ShotBlockingRecord>;
  /** Removes one Character's blocking from one Shot (CAS on revision). */
  removeShotBlocking(input: {
    projectId: string;
    shotId: string;
    characterId: string;
    expectedRevision: number;
  }): Promise<void>;
  /**
   * The explicit "Re-anchor to current set": records the CURRENT set revision/fingerprint on the Shot's blocking
   * WITHOUT changing any root transform or pose. Never automatic.
   */
  reanchorShotBlocking(input: {
    projectId: string;
    shotId: string;
    sceneDocumentId: string;
    userId: string | null;
    now: string;
  }): Promise<ShotBlockingRecord[]>;

  listPrevisClips(shotId: string): Promise<PrevisClipRecord[]>;
  getPrevisClip(id: string): Promise<PrevisClipRecord | null>;
  recordPrevisClip(input: NewPrevisClip): Promise<PrevisClipRecord>;

  /** Newest first. */
  listSpatialPassBundles(shotId: string): Promise<SpatialPassBundleRecord[]>;
  getSpatialPassBundle(id: string): Promise<SpatialPassBundleRecord | null>;
  /** True when a stored bundle references this asset (depth, object ids or a Character mask). */
  spatialPassUsesAsset(assetId: string): Promise<boolean>;
  /**
   * Records a bundle. The same exact control frame (same Shot + bundleFingerprint) is captured once: a repeat returns
   * the existing record with existing = true and nothing is inserted.
   */
  recordSpatialPassBundle(
    input: NewSpatialPassBundle,
  ): Promise<{ record: SpatialPassBundleRecord; existing: boolean }>;
}
