import {
  PREVIS_PRODUCTION_FRAME,
  PREVIS_SENSOR_HEIGHT_MM,
  type CameraBookmarkValue,
  type PrevisCamera,
} from "./types";

/** Vertical FOV in degrees for a focal length on the engine's fixed 24 mm sensor height. */
export function focalLengthToFovDegrees(focalLengthMm: number): number {
  return (2 * Math.atan(PREVIS_SENSOR_HEIGHT_MM / (2 * focalLengthMm)) * 180) / Math.PI;
}

/** Point one unit ahead of an Euler-XYZ camera (three.js cameras look down their local -Z). */
export function lookTargetFromEuler(
  position: { x: number; y: number; z: number },
  rotation: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const { x, y } = rotation;
  // third column of R = Rx * Ry * Rz: the camera's local +Z axis in world space
  const zx = Math.sin(y);
  const zy = -Math.sin(x) * Math.cos(y);
  const zz = Math.cos(x) * Math.cos(y);
  return { x: position.x - zx, y: position.y - zy, z: position.z - zz };
}

export function bookmarkFromCamera(camera: PrevisCamera): CameraBookmarkValue {
  return {
    position: { ...camera.position },
    rotation: { ...camera.rotation },
    target: lookTargetFromEuler(camera.position, camera.rotation),
    projection: "perspective",
    fovVerticalDegrees: focalLengthToFovDegrees(camera.focalLengthMm),
    focalLengthMm: camera.focalLengthMm,
    focalLengthBasis: "vertical-sensor-24mm",
    productionAspectRatio: PREVIS_PRODUCTION_FRAME.ratio,
    productionAspectValue: PREVIS_PRODUCTION_FRAME.width / PREVIS_PRODUCTION_FRAME.height,
  };
}

/** The camera pose a bookmark restores (the engine stores position + Euler rotation + focal length). */
export function cameraFromBookmark(id: string, label: string, b: CameraBookmarkValue): PrevisCamera {
  return {
    id,
    label,
    position: { ...b.position },
    rotation: { ...b.rotation },
    focalLengthMm: b.focalLengthMm,
  };
}

/** Everything needed to render the production frame; derived only from a frozen bookmark, never from the editor camera. */
export interface ProductionRenderSpec {
  position: { x: number; y: number; z: number };
  /** Euler XYZ radians, as the engine stores camera rotation. */
  rotation: { x: number; y: number; z: number };
  fovVerticalDegrees: number;
  aspect: number;
  width: number;
  height: number;
  near: number;
  far: number;
}

/**
 * The isolated render camera for a master frame. The lens comes from the bookmark's focal length on the
 * declared sensor basis and the framing from the Production Frame, so neither the operator's navigation
 * camera nor the viewport's aspect can influence the capture.
 */
export function productionRenderSpec(b: CameraBookmarkValue): ProductionRenderSpec {
  if (b.focalLengthBasis !== "vertical-sensor-24mm") {
    throw new Error(`Unsupported focal length basis: ${String(b.focalLengthBasis)}`);
  }
  if (b.projection !== "perspective") throw new Error(`Unsupported projection: ${String(b.projection)}`);
  if (!(b.focalLengthMm > 0)) throw new Error("The production camera has no valid focal length.");
  const { width, height } = PREVIS_PRODUCTION_FRAME;
  return {
    position: { ...b.position },
    rotation: { ...b.rotation },
    fovVerticalDegrees: focalLengthToFovDegrees(b.focalLengthMm),
    aspect: width / height,
    width,
    height,
    near: 0.05,
    far: 2000,
  };
}
