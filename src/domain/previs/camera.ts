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
