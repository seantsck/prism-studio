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
}

export function buildSpatialReference(src: SpatialSources): SpatialReference {
  return {
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
}

/** True when the Shot's camera was authored against an older state of the set than the live one. */
export function isBookmarkStale(ref: SpatialReference): boolean {
  return !!ref.cameraBookmark && ref.cameraBookmark.sceneFingerprint !== ref.sceneFingerprint;
}
