import type { CameraInterpolation, CameraKeyframe } from "./camera-path";
import { characterBlocking } from "./document";
import type { CameraBookmarkValue, PrevisDocument } from "./types";

export const SPATIAL_REFERENCE_SCHEMA_VERSION = 1 as const;

/**
 * The spatial truth frozen into a GenerationPackage when a Shot has a 3D set. Optional: a Shot without a 3D set
 * has no `spatialReference` key at all (never null/empty), so its package fingerprint is byte-identical to before.
 */
export interface SpatialReference {
  schemaVersion: typeof SPATIAL_REFERENCE_SCHEMA_VERSION;
  locationId: string;
  sceneDocumentId: string;
  /** the LIVE set's state at the moment the package was compiled */
  sceneRevision: number;
  sceneFingerprint: string;
  /** the Shot's production camera and the scene state it was authored against (differs from live when stale) */
  cameraBookmark: {
    id: string;
    label: string;
    sceneRevision: number;
    sceneFingerprint: string;
    value: CameraBookmarkValue;
  } | null;
  /** the master frame the user explicitly adopted for this shot (an Asset id; never a URL) */
  masterFrameAssetId: string | null;
  characterBlocking: ReturnType<typeof characterBlocking>;
  productionFrame: { ratio: string; width: number; height: number };
  /** optional and omitted (not null) when the Shot has no camera path, so M1 packages are byte-identical */
  cameraMotion?: CameraMotionReference;
}

export const CAMERA_MOTION_SCHEMA_VERSION = 1 as const;

/**
 * The authored camera motion frozen into a package (by value, so later edits to the live path cannot alter it).
 * The key is absent from `SpatialReference` when the Shot has no saved camera path.
 */
export interface CameraMotionReference {
  schemaVersion: typeof CAMERA_MOTION_SCHEMA_VERSION;
  cameraPathId: string;
  cameraPathRevision: number;
  cameraPathFingerprint: string;
  /** the set state the motion was authored against (differs from live when stale) */
  sceneRevision: number;
  sceneFingerprint: string;
  durationMs: number;
  frameRate: number;
  interpolation: CameraInterpolation;
  focalLengthBasis: "vertical-sensor-24mm";
  keyframes: CameraKeyframe[];
  /** the latest local previs rendered from exactly this path (an Asset id; never a URL), or null */
  previsAssetId: string | null;
  /**
   * Present only when `previsAssetId` is: whether that previs contains the performance audio, and the identity of
   * that mix. Additive and optional, so earlier packages (and silent-era shapes) are unchanged.
   */
  previs?: { assetId: string; hasAudio: boolean; audioMixFingerprint: string | null };
}

export interface SpatialSources {
  locationId: string;
  scene: { id: string; revision: number; sceneFingerprint: string; document: PrevisDocument };
  bookmark: {
    id: string;
    cameraLabel: string;
    sceneRevision: number;
    sceneFingerprint: string;
    value: CameraBookmarkValue;
  } | null;
  adoptedMasterFrameAssetId: string | null;
  cameraMotion?: CameraMotionReference | null;
}

export function buildSpatialReference(src: SpatialSources): SpatialReference {
  const ref: SpatialReference = {
    schemaVersion: SPATIAL_REFERENCE_SCHEMA_VERSION,
    locationId: src.locationId,
    sceneDocumentId: src.scene.id,
    sceneRevision: src.scene.revision,
    sceneFingerprint: src.scene.sceneFingerprint,
    cameraBookmark: src.bookmark
      ? {
          id: src.bookmark.id,
          label: src.bookmark.cameraLabel,
          sceneRevision: src.bookmark.sceneRevision,
          sceneFingerprint: src.bookmark.sceneFingerprint,
          value: src.bookmark.value,
        }
      : null,
    masterFrameAssetId: src.adoptedMasterFrameAssetId,
    characterBlocking: characterBlocking(src.scene.document),
    productionFrame: { ...src.scene.document.productionFrame },
  };
  if (src.cameraMotion) ref.cameraMotion = structuredClone(src.cameraMotion);
  return ref;
}

/** True when the authored motion was made against an older state of the set than the live one. */
export function isCameraMotionStale(ref: SpatialReference): boolean {
  return !!ref.cameraMotion && ref.cameraMotion.sceneFingerprint !== ref.sceneFingerprint;
}

/** True when the Shot's camera was authored against an older state of the set than the live one. */
export function isBookmarkStale(ref: SpatialReference): boolean {
  return !!ref.cameraBookmark && ref.cameraBookmark.sceneFingerprint !== ref.sceneFingerprint;
}
