import { z } from "zod";
import { bookmarkCameraFingerprint, controlCameraFromBookmark, type ControlCamera } from "./spatial-passes";
import { PREVIS_PRODUCTION_FRAME, PREVIS_SENSOR_HEIGHT_MM, type CameraBookmarkValue } from "./types";

/**
 * RENDER CAMERA PROVENANCE (Phase 4C, decision P5). What camera a Master Frame was really rendered with, frozen BY
 * VALUE on the Master Frame row (`camera_fingerprint` + `camera_json`).
 *
 * There is ONE camera identity: `bookmarkCameraFingerprint` = fingerprint(controlCameraFromBookmark(bookmark)), the
 * canonical `ControlCamera` the spatial control passes already use. The ControlCamera holds every pixel-affecting fact
 * of the production render (position, canonical-sign quaternion, focal length, sensor height, vertical FOV, aspect,
 * production width/height, near, far) and is exactly what `productionRenderSpec` renders: the same lens formula, the
 * same Production Frame and the same CONTROL_NEAR/CONTROL_FAR. So no second camera fingerprint is introduced.
 *
 * The snapshot is built SERVER-SIDE from the Shot's reloaded bookmark. The browser only claims "I rendered bookmark
 * camera fingerprint X"; it never supplies camera JSON. Pure domain code: no Three.js, no viewport, no navigation
 * camera, no URL.
 */
export const RENDER_CAMERA_SCHEMA = "prism.render-camera.v1" as const;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const vec3 = z.strictObject({ x: z.number(), y: z.number(), z: z.number() });

export const controlCameraSchema = z.strictObject({
  position: vec3,
  quaternion: z.strictObject({ x: z.number(), y: z.number(), z: z.number(), w: z.number() }),
  focalLengthMm: z.number().positive(),
  sensorHeightMm: z.literal(PREVIS_SENSOR_HEIGHT_MM),
  fovVerticalDegrees: z.number().positive(),
  aspect: z.number().positive(),
  near: z.number().positive(),
  far: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const renderCameraSchema = z.strictObject({
  schema: z.literal(RENDER_CAMERA_SCHEMA),
  cameraFingerprint: hex64,
  bookmarkId: z.string().min(1),
  bookmarkLabel: z.string(),
  projection: z.literal("perspective"),
  focalLengthBasis: z.literal("vertical-sensor-24mm"),
  productionAspectRatio: z.string().min(1),
  camera: controlCameraSchema,
});
export type RenderCamera = z.infer<typeof renderCameraSchema>;

/** The canonical camera identity of a production camera bookmark (re-exported: there is exactly one). */
export const renderCameraFingerprint = (value: CameraBookmarkValue): string =>
  bookmarkCameraFingerprint(value);

/** Builds the `prism.render-camera.v1` snapshot from a SERVER-loaded bookmark. */
export function buildRenderCamera(bookmark: {
  id: string;
  cameraLabel: string;
  value: CameraBookmarkValue;
}): RenderCamera {
  const camera: ControlCamera = controlCameraFromBookmark(bookmark.value);
  return renderCameraSchema.parse({
    schema: RENDER_CAMERA_SCHEMA,
    cameraFingerprint: bookmarkCameraFingerprint(bookmark.value),
    bookmarkId: bookmark.id,
    bookmarkLabel: bookmark.cameraLabel,
    projection: bookmark.value.projection,
    focalLengthBasis: bookmark.value.focalLengthBasis,
    productionAspectRatio: PREVIS_PRODUCTION_FRAME.ratio,
    camera,
  });
}

/** Reads a stored snapshot; a malformed value (never written by Prism) reads as null rather than as provenance. */
export function parseRenderCamera(value: unknown): RenderCamera | null {
  const r = renderCameraSchema.safeParse(value);
  return r.success ? r.data : null;
}

/** The message for a render whose claimed camera is not the Shot's production camera. */
export const WRONG_CAMERA_MESSAGE =
  "This frame was rendered with a different camera than this Shot's production camera. Restore the Shot's production camera and capture again.";
