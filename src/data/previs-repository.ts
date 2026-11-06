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
import type { RenderCamera } from "@/domain/previs/camera-provenance";
import type { AuthoredLightingIntent, RenderLighting, ShotLightingRig } from "@/domain/previs/lighting";
import type { SetupComponent, SetupCopyPlan } from "@/domain/previs/setup-copy";
import type { SetupTemplateContent } from "@/domain/previs/setup-template";
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

export const LIGHTING_RIG_ELSEWHERE =
  "This Shot's lighting rig was authored for another 3D set. Clear it before lighting the Shot here.";

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
  /** the rig the picture was lit by (null = no Shot Lighting Rig was recorded for this render) */
  lightingFingerprint: string | null;
  lighting: RenderLighting | null;
  /**
   * Phase 4C (migration 0049): the canonical camera the picture was rendered with, derived server-side from the Shot's
   * bookmark at capture (`prism.render-camera.v1`). null/null = camera provenance was NOT frozen at capture (every
   * frame before 4C, and every frame captured while the database was still at 0048): UNKNOWN, never fresh.
   */
  cameraFingerprint: string | null;
  camera: RenderCamera | null;
  /**
   * Phase 4C (migration 0049): `baseEnvironmentFingerprint` of the engine base environment (skybox + engine commit)
   * the picture was rendered on, derived server-side at capture, rig or no rig. null = not frozen (every earlier frame,
   * and every frame captured while the database was still at 0048).
   */
  baseEnvironmentFingerprint: string | null;
  createdBy: string | null;
  createdAt: string;
}

/**
 * The Shot's current spatial lighting (Phase 4B): an overlay on the set, tied to the scene state it was authored
 * against. It is never part of the Location's scene document or scene fingerprint.
 */
export interface ShotLightingRigRecord {
  id: string;
  projectId: string;
  shotId: string;
  locationId: string;
  sceneDocumentId: string;
  sceneRevision: number;
  sceneFingerprint: string;
  schemaVersion: string;
  revision: number;
  rig: ShotLightingRig;
  lightingFingerprint: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveLightingRigInput {
  id: string;
  projectId: string;
  shotId: string;
  locationId: string;
  sceneDocumentId: string;
  /** the LIVE set state the rig is being authored against (looked up server-side, never trusted from a client) */
  sceneRevision: number;
  sceneFingerprint: string;
  /** complete, with the authored intent the server read from the Shot; the fingerprint is derived from it here */
  rig: ShotLightingRig;
  /** null = first save for this Shot; otherwise the revision the editor loaded */
  expectedRevision: number | null;
  userId: string | null;
  now: string;
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
  /** the rig the frames were lit by (null = no Shot Lighting Rig was recorded for this render) */
  lightingFingerprint: string | null;
  lighting: RenderLighting | null;
  renderedAt: string;
  createdBy: string | null;
  createdAt: string;
}

export type NewPrevisClip = Omit<
  PrevisClipRecord,
  | "source"
  | "createdAt"
  | "createdBy"
  | "blockingFingerprint"
  | "blocking"
  | "lightingFingerprint"
  | "lighting"
> & {
  blockingFingerprint?: string | null;
  blocking?: RenderedBlockingFigure[] | null;
  lightingFingerprint?: string | null;
  lighting?: RenderLighting | null;
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
  lightingFingerprint?: string | null;
  lighting?: RenderLighting | null;
  /** server-derived render camera (both or neither); dropped, not refused, by a database before 0049 */
  cameraFingerprint?: string | null;
  camera?: RenderCamera | null;
  /** server-derived base environment identity; dropped, not refused, by a database before 0049 */
  baseEnvironmentFingerprint?: string | null;
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

/**
 * Phase 4D "Copy setup from…": copies VALUES from the source Shot's current camera / lighting / blocking rows into the
 * destination Shot's OWN rows, in ONE transaction. The plan is recomputed from the locked rows and must carry the token
 * the person reviewed. Nothing on the destination refers to the source afterwards.
 */
export interface CopyShotSetupInput {
  projectId: string;
  sourceShotId: string;
  destinationShotId: string;
  /** the destination's (and source's) current Location and its current saved set, looked up server-side */
  locationId: string;
  sceneDocumentId: string;
  components: SetupComponent[];
  /** `SetupCopyPlan.token` from the reviewed preview; a different recomputed plan refuses the copy */
  expectedToken: string;
  /** the DESTINATION Shot's authored lighting text (read from the destination Shot, never copied from the source) */
  destinationIntent: AuthoredLightingIntent;
  userId: string | null;
  now: string;
}
export interface CopyShotSetupResult {
  plan: SetupCopyPlan;
  /** the destination's rows after the copy, for each copied part (null when that part was not copied) */
  camera: CameraBookmarkRecord | null;
  lighting: ShotLightingRigRecord | null;
  blocking: ShotBlockingRecord[] | null;
}

/**
 * Phase 4D-I2 (migration 0050): a named, Project- and Location-scoped SNAPSHOT of reusable setup values. Nothing that
 * renders, captures, promotes or packages a Shot ever reads it: applying it copies its values into the Shot's own rows.
 */
export interface SetupTemplateRecord {
  id: string;
  projectId: string;
  locationId: string;
  /** the one set the template's positions belong to */
  sceneDocumentId: string;
  schemaVersion: string;
  name: string;
  description: string;
  revision: number;
  content: SetupTemplateContent;
  contentFingerprint: string;
  /** display-only provenance of the last snapshot (null once that Shot is deleted; the code survives) */
  sourceShotId: string | null;
  sourceShotCode: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Phase 4D-I2: append-only provenance of one explicit copy INTO a Shot. History, never state. */
export interface SetupCopyRecord {
  id: string;
  projectId: string;
  shotId: string;
  locationId: string;
  sceneDocumentId: string;
  sourceKind: "shot" | "template";
  /** null once the source Shot / template is deleted; the code / name snapshot survives */
  sourceShotId: string | null;
  sourceShotCode: string | null;
  templateId: string | null;
  templateName: string | null;
  templateRevision: number | null;
  templateContentFingerprint: string | null;
  components: SetupComponent[];
  planToken: string;
  copiedAt: string;
  createdBy: string | null;
}

export interface CreateSetupTemplateInput {
  projectId: string;
  /** the Shot whose CURRENT-set values are snapshotted, inside the repository's transaction */
  shotId: string;
  locationId: string;
  sceneDocumentId: string;
  name: string;
  description: string;
  components: SetupComponent[];
  userId: string | null;
  now: string;
}

export interface UpdateSetupTemplateInput {
  projectId: string;
  templateId: string;
  expectedRevision: number;
  name?: string;
  description?: string;
  /** replace the values with a fresh snapshot of this Shot (same Location and set as the template) */
  contentFrom?: { shotId: string; components: SetupComponent[] };
  now: string;
}

export interface CopyTemplateSetupInput {
  projectId: string;
  templateId: string;
  destinationShotId: string;
  locationId: string;
  sceneDocumentId: string;
  components: SetupComponent[];
  expectedToken: string;
  destinationIntent: AuthoredLightingIntent;
  userId: string | null;
  now: string;
}

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

  /**
   * Whether this store persists Phase 4C spatial provenance (migration 0049: Master Frame camera, Production Frame
   * source fingerprints). Memory: always. Postgres: only once 0049 is applied (probed, never assumed).
   */
  spatialProvenancePersisted(): Promise<boolean>;
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

  getLightingRigForShot(shotId: string): Promise<ShotLightingRigRecord | null>;
  listLightingRigsForProject(projectId: string): Promise<ShotLightingRigRecord[]>;
  /** Insert or compare-and-set update of the Shot's one rig. A rig never moves to another Location or set. */
  saveLightingRig(input: SaveLightingRigInput): Promise<ShotLightingRigRecord>;
  /** Removes the Shot's current rig (CAS on revision). Renders keep the lighting they recorded. */
  clearLightingRig(input: { projectId: string; shotId: string; expectedRevision: number }): Promise<void>;

  /**
   * Phase 4D: the atomic explicit copy (see CopyShotSetupInput). Throws PrevisError("conflict") when the recomputed plan
   * differs from the reviewed one, PrevisError("invalid") for a refused copy; on any failure nothing is written.
   */
  copyShotSetup(input: CopyShotSetupInput): Promise<CopyShotSetupResult>;

  // ── Phase 4D-I2: named setup templates and copy provenance (migration 0050) ──
  /** Memory: always. Postgres: only once 0050 is applied (probed, never assumed). */
  setupTemplatesReady(): Promise<boolean>;
  /** The templates saved on one Location's set, by name. */
  listSetupTemplates(projectId: string, locationId: string): Promise<SetupTemplateRecord[]>;
  getSetupTemplate(id: string): Promise<SetupTemplateRecord | null>;
  /** Snapshots the Shot's current-set values in one transaction. PrevisError("conflict") on a duplicate name. */
  createSetupTemplate(input: CreateSetupTemplateInput): Promise<SetupTemplateRecord>;
  /** Rename, re-describe and/or replace the values (compare-and-set on revision). Never touches any Shot. */
  updateSetupTemplate(input: UpdateSetupTemplateInput): Promise<SetupTemplateRecord>;
  /** Deletes the template (CAS on revision). Shots that copied it keep their values; provenance keeps the name. */
  deleteSetupTemplate(input: {
    projectId: string;
    templateId: string;
    expectedRevision: number;
  }): Promise<void>;
  /** The atomic explicit copy FROM a template (same contract as copyShotSetup), plus its provenance record. */
  copyTemplateSetup(input: CopyTemplateSetupInput): Promise<CopyShotSetupResult>;
  /** Newest first: the copies made INTO this Shot. Empty before 0050. */
  listSetupCopies(projectId: string, shotId: string): Promise<SetupCopyRecord[]>;

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
