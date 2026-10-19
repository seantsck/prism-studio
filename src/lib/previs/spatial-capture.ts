import {
  buildControlFrame,
  buildObjectManifest,
  countObjectPixels,
  deriveCharacterMasks,
  depthMatchesIds,
  encodeDepthF32,
  encodeMaskU8,
  encodeObjectIdsU32,
  spatialBundleFingerprint,
  SPATIAL_MIME,
  validateDepth,
  withPixelCounts,
  type ControlCameraSource,
  type DerivedCharacterMask,
  type ObjectManifest,
} from "@/domain/previs/spatial-passes";
import { SPLAT_PASSES_BLOCKED_MESSAGE } from "@/domain/previs/splat";
import type { SpatialSceneAdapter } from "./scene-adapter";

/**
 * Client side of a spatial control-pass capture: render the passes with the adapter, validate them, derive the
 * per-Character masks from the object-id raster, and compute the bundle fingerprint the server will re-derive.
 * No server call happens here; the caller sends `toFormData()`.
 */

export interface CapturedPasses {
  width: number;
  height: number;
  manifest: ObjectManifest;
  depth: Float32Array;
  ids: Uint32Array;
  masks: DerivedCharacterMask[];
  bundleFingerprint: string;
  blockingFingerprint: string | null;
}

export interface CaptureRequest {
  adapter: SpatialSceneAdapter;
  shotId: string;
  scene: { documentId: string; revision: number; fingerprint: string };
  /** the SAVED rendered-blocking layer the passes will show (null = none) */
  blockingFingerprint: string | null;
  /** the explicit camera source (a camera-path time or the Production Camera bookmark), camera by value */
  source: ControlCameraSource;
  /** the saved blocking identity of each Character figure (a proxy that was never saved cannot be captured) */
  savedFigures: Array<{ characterId: string; blockingId: string }>;
}

export class SpatialCaptureError extends Error {}

export function renderSpatialCapture(req: CaptureRequest): CapturedPasses {
  const entities = req.adapter.productionEntities();
  // exact depth / ids / masks cannot include a Gaussian splat yet: refuse instead of silently omitting the environment
  if (entities.splats.length > 0) throw new SpatialCaptureError(SPLAT_PASSES_BLOCKED_MESSAGE);
  const characters = entities.characterIds.map((characterId) => {
    const saved = req.savedFigures.find((f) => f.characterId === characterId);
    if (!saved) throw new SpatialCaptureError("Save the character blocking before capturing control passes.");
    return { characterId, blockingId: saved.blockingId };
  });
  const manifest = buildObjectManifest({ setObjects: entities.setObjects, characters });
  const frame = buildControlFrame({
    shotId: req.shotId,
    scene: req.scene,
    blockingFingerprint: req.blockingFingerprint,
    camera: req.source,
  });
  const passes = req.adapter.captureSpatialPasses(req.source.camera, manifest);
  if (passes.width !== frame.width || passes.height !== frame.height)
    throw new SpatialCaptureError("The control passes were not rendered at the Production Frame size.");

  const depthOk = validateDepth(passes.depth);
  if (!depthOk.ok) throw new SpatialCaptureError(depthOk.error);
  const counted = countObjectPixels(passes.ids, manifest.objects.length);
  if (!counted.ok) throw new SpatialCaptureError(counted.error);
  if (!depthMatchesIds(passes.depth, passes.ids))
    throw new SpatialCaptureError("The depth and object-id passes do not cover the same pixels.");

  const counted2 = withPixelCounts(manifest, counted.counts);
  return {
    width: passes.width,
    height: passes.height,
    manifest: counted2,
    depth: passes.depth,
    ids: passes.ids,
    masks: deriveCharacterMasks(passes.ids, manifest),
    blockingFingerprint: req.blockingFingerprint,
    bundleFingerprint: spatialBundleFingerprint({
      shotId: req.shotId,
      sceneFingerprint: frame.scene.fingerprint,
      blockingFingerprint: frame.blockingFingerprint,
      camera: frame.camera,
      width: frame.width,
      height: frame.height,
      manifest,
    }),
  };
}

/** The multipart body `captureSpatialPassBundle` expects. Machine data goes up as typed files, never as images. */
export function spatialCaptureForm(
  c: CapturedPasses,
  ctx: { projectSlug: string; shotId: string; locationId: string; source: ControlCameraSource },
): FormData {
  const fd = new FormData();
  fd.set("projectSlug", ctx.projectSlug);
  fd.set("shotId", ctx.shotId);
  fd.set("locationId", ctx.locationId);
  fd.set("cameraSource", ctx.source.kind);
  if (ctx.source.kind === "camera_path") fd.set("timeMs", String(ctx.source.timeMs));
  fd.set("blockingFingerprint", c.blockingFingerprint ?? "");
  fd.set("bundleFingerprint", c.bundleFingerprint);
  fd.set("manifest", JSON.stringify(c.manifest));
  const file = (bytes: Uint8Array, name: string, type: string) =>
    new File([bytes as BlobPart], name, { type });
  fd.set("depth", file(encodeDepthF32(c.depth), "depth.f32", SPATIAL_MIME.depth));
  fd.set("objectIds", file(encodeObjectIdsU32(c.ids), "object-ids.u32", SPATIAL_MIME.objectIds));
  for (const m of c.masks)
    fd.set(
      `mask:${m.characterId}`,
      file(encodeMaskU8(m.mask), `mask-${m.characterId.slice(0, 8)}.u8`, SPATIAL_MIME.characterMask),
    );
  return fd;
}
