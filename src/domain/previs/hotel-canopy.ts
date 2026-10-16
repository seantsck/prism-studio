import { emptyCameraPath, keyframeFromCamera, upsertKeyframe, type CameraPath } from "./camera-path";
import { canonicalizeEntry, scaleForHeight, yawQuat, type ShotBlockingEntry } from "./blocking";
import { PRISM_USER_DATA, assetTokenFor } from "./document";
import { neutralPose, presetById, withHeadDirection } from "./pose";

/**
 * The synthetic acceptance set: neutral procedural objects only (no Yumeko image, no paid or third-party
 * assets). Expressed as the engine's own scene JSON so loading it exercises the real load path.
 * Ids are deterministic so the set (and its fingerprint) is reproducible.
 */
export const HOTEL_CANOPY_SET_NAME = "Hotel Canopy Test Set";

type V = { x: number; y: number; z: number };
interface Def {
  id: string;
  name: string;
  shape: string;
  position: V;
  rotation?: V;
  scale: V;
  color: string;
  characterId?: string;
}

const Z: V = { x: 0, y: 0, z: 0 };

export const HOTEL_CANOPY_OBJECTS: Def[] = [
  {
    id: "00000000-0000-4000-8000-0000000c0001",
    name: "Ground plane",
    shape: "Plane",
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: -Math.PI / 2, y: 0, z: 0 },
    scale: { x: 24, y: 24, z: 1 },
    color: "#8a8f98",
  },
  {
    id: "00000000-0000-4000-8000-0000000c0002",
    name: "Hotel wall",
    shape: "Box",
    position: { x: 0, y: 3, z: -6 },
    scale: { x: 14, y: 6, z: 0.4 },
    color: "#c9c2b8",
  },
  {
    id: "00000000-0000-4000-8000-0000000c0003",
    name: "Canopy",
    shape: "Box",
    position: { x: 0, y: 3.6, z: -4.2 },
    scale: { x: 6, y: 0.25, z: 3.4 },
    color: "#3b4a5a",
  },
  {
    id: "00000000-0000-4000-8000-0000000c0004",
    name: "Door opening",
    shape: "Box",
    position: { x: 0, y: 1.2, z: -5.75 },
    scale: { x: 2.2, y: 2.4, z: 0.15 },
    color: "#1d1f24",
  },
  {
    id: "00000000-0000-4000-8000-0000000c0005",
    name: "Vehicle block",
    shape: "Box",
    position: { x: 4.2, y: 0.75, z: -1 },
    scale: { x: 4.6, y: 1.5, z: 1.9 },
    color: "#5b6470",
  },
  {
    id: "00000000-0000-4000-8000-0000000c0006",
    name: "Lamp post",
    shape: "Cylinder",
    position: { x: -3.6, y: 2, z: -2.6 },
    scale: { x: 0.18, y: 2, z: 0.18 },
    color: "#2a2d33",
  },
  {
    id: "00000000-0000-4000-8000-0000000c0007",
    name: "Mannequin",
    shape: "Mannequin",
    position: { x: -0.6, y: 0, z: -2.4 },
    scale: { x: 1, y: 1, z: 1 },
    color: "#d9d9d9",
  },
];

export const HOTEL_CANOPY_CAMERA = {
  id: "cam-a",
  label: "CAM-A",
  focalLength: 35,
  position: { x: 1.2, y: 1.6, z: 5.5 },
  rotation: { x: -0.06, y: 0.12, z: 0 },
  lookAt: { x: 0, y: 1.2, z: -3 },
} as const;

export interface EngineSceneObject {
  version: number;
  position: V;
  rotation: V;
  scale: V;
  object_name: string;
  object_uuid: string;
  object_user_data_name: string;
  media_file_token: string;
  color: string;
  metalness: number;
  shininess: number;
  specular: number;
  locked: boolean;
  visible: boolean;
  rigData: unknown;
  user_data: Record<string, unknown>;
}
export interface EngineSceneCamera {
  id: string;
  label: string;
  focalLength: number;
  position: V;
  rotation: V;
  lookAt: V;
}
export interface EngineSceneJson {
  version: number;
  scene: EngineSceneObject[];
  positivePrompt: string;
  cameraAspectRatio: string;
  timeline: unknown;
  skybox: string;
  camera_data: { position: V; rotation: V };
  cameras: EngineSceneCamera[];
  selectedCameraId: string;
}

/** Engine scene JSON for the set. `characterId` optionally blocks a Prism Character with the mannequin proxy. */
export function buildHotelCanopyEngineScene(opts: { characterId?: string } = {}): EngineSceneJson {
  return {
    version: 2,
    scene: HOTEL_CANOPY_OBJECTS.map((o) => ({
      version: 2,
      position: o.position,
      rotation: o.rotation ?? Z,
      scale: o.scale,
      object_name: o.name,
      object_uuid: o.id,
      object_user_data_name: o.name,
      media_file_token: "Parim",
      color: o.color,
      metalness: 0,
      shininess: 0.5,
      specular: 0,
      locked: false,
      visible: true,
      rigData: undefined,
      user_data: {
        shapeKey: o.shape,
        shapeType: o.shape,
        media_id: "Parim",
        isShape: true,
        color: o.color,
        ...(o.shape === "Mannequin" && opts.characterId
          ? { [PRISM_USER_DATA.characterId]: opts.characterId }
          : {}),
      },
    })),
    positivePrompt: "",
    cameraAspectRatio: "horizontal_2_39_1",
    timeline: null,
    skybox: "m_1",
    camera_data: { position: { x: 6, y: 4, z: 9 }, rotation: { x: -0.25, y: 0.55, z: 0 } },
    cameras: [
      {
        id: "main",
        label: "Main",
        focalLength: 17,
        position: { x: 6, y: 4, z: 9 },
        rotation: { x: -0.25, y: 0.55, z: 0 },
        lookAt: Z,
      },
      { ...HOTEL_CANOPY_CAMERA },
    ],
    selectedCameraId: HOTEL_CANOPY_CAMERA.id,
  };
}

export { assetTokenFor };

/**
 * A synthetic 4 s / 24 fps camera path for the Hotel Canopy Test Set: a slow push toward the doorway that also
 * rides the lens 35 → 50 → 70 mm. Procedural; used by tests and the "sample path" fixture button.
 */
export function buildHotelCanopyCameraPath(): CameraPath {
  let p = emptyCameraPath(4000, 24);
  const key = (
    id: string,
    t: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
    f: number,
    easing: "ease_in_out" | "linear",
  ) =>
    keyframeFromCamera(
      id,
      t,
      { position: { x, y, z }, rotation: { x: 0, y: yaw, z: 0 }, focalLengthMm: f },
      easing,
    );
  p = upsertKeyframe(p, key("hotel-kf-1", 0, 3, 1.7, 9, 0.2, 35, "ease_in_out"));
  p = upsertKeyframe(p, key("hotel-kf-2", 2000, 1.4, 1.6, 4, 0.1, 50, "ease_in_out"));
  p = upsertKeyframe(p, key("hotel-kf-3", 4000, 0, 1.5, 0.5, 0, 70, "linear"));
  return p;
}

/** The Shots whose blocking the synthetic fixture authors. */
export const HOTEL_CANOPY_BLOCKING_SHOTS = ["3A"] as const;

/**
 * Synthetic Shot 3A blocking for the Hotel Canopy set: Yumeko near the doorway, standing, body angled toward Sean
 * with her head turned further toward him; Sean near the vehicle, standing, body facing Yumeko (hands on hips).
 * Neutral proxies only: no likeness, no assets.
 */
export function buildHotelCanopyShotBlocking(ids: { yumekoId: string; seanId: string }): ShotBlockingEntry[] {
  const yumeko = canonicalizeEntry({
    characterId: ids.yumekoId,
    root: { position: { x: -0.8, y: 0, z: -4.6 }, orientation: yawQuat(30), scale: scaleForHeight(1.7) },
    pose: withHeadDirection(neutralPose(), 20, 0),
  });
  const sean = canonicalizeEntry({
    characterId: ids.seanId,
    root: { position: { x: 3.0, y: 0, z: -1.4 }, orientation: yawQuat(-130), scale: scaleForHeight(1.8) },
    pose: presetById("hands_on_hips").pose,
  });
  return [yumeko, sean];
}
