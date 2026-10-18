import { fingerprint } from "../hash";
import { focalLengthToFovDegrees } from "./camera";
import {
  evaluateCameraPath,
  eulerToQuaternion,
  type CameraPath,
  type CameraState,
  type QuaternionValue,
} from "./camera-path";
import {
  PREVIS_PRODUCTION_FRAME,
  PREVIS_SENSOR_HEIGHT_MM,
  type CameraBookmarkValue,
  type PrevisDocument,
  type Vec3,
} from "./types";

/**
 * Phase 2F M2C: MACHINE-READABLE spatial control data for one exact rendered Shot frame.
 *
 *   control frame  = Shot + saved Set + rendered blocking + an explicit production-camera source + frame size
 *   pass bundle    = depth + object IDs + object manifest + one exact mask per visible blocked Character
 *
 * These are not beauty renders. They are deterministic pixel-aligned facts about geometry Prism already knows,
 * stored provider-neutral. Nothing here talks to a generation provider.
 *
 * CONVENTIONS (stored once, documented in docs/virtual-set.md):
 *   - every raster is `width × height`, row-major, ROW 0 = TOP of the production frame (the single flip from
 *     WebGL's bottom-left origin happens once, at readback);
 *   - multi-byte values are LITTLE-ENDIAN regardless of host;
 *   - depth is LINEAR VIEW-SPACE DEPTH IN METRES along the camera's forward axis (0 = background);
 *   - object indices are BUNDLE-LOCAL (0 = background, 1..N by sorted semantic key); semantic ids are persistent.
 */

export const SPATIAL_CONTROL_FRAME_SCHEMA = "prism.spatial-control-frame.v1" as const;
export const SPATIAL_PASS_BUNDLE_SCHEMA = "prism.spatial-pass-bundle.v1" as const;
export const SPATIAL_PASS_ALGORITHM = "prism.spatial-pass-algorithm.v1" as const;

export const DEPTH_FORMAT = "prism.depth-f32.v1" as const;
export const OBJECT_ID_FORMAT = "prism.object-id-u32.v1" as const;
export const CHARACTER_MASK_FORMAT = "prism.character-mask-u8.v1" as const;
export const OBJECT_MANIFEST_SCHEMA = "prism.object-id-manifest.v1" as const;
export const CHARACTER_MASKS_SCHEMA = "prism.character-masks.v1" as const;

/** Truthful asset MIME types for raw machine data (never `image/*`). */
export const SPATIAL_MIME = {
  depth: "application/x-prism-depth-f32",
  objectIds: "application/x-prism-object-id-u32",
  characterMask: "application/x-prism-character-mask-u8",
} as const;
export const SPATIAL_MIME_LIST: readonly string[] = Object.values(SPATIAL_MIME);

export const DEPTH_UNITS = "metres" as const;
export const DEPTH_BACKGROUND = 0 as const;
export const ROW_ORDER = "top-to-bottom" as const;
export const ENDIANNESS = "little" as const;
export const CONTROL_NEAR = 0.05;
export const CONTROL_FAR = 2000;
export const MASK_ON = 255;
export const MASK_OFF = 0;

const r6 = (n: number) => Math.round(n * 1e6) / 1e6 + 0; // + 0 normalises -0

// ───────────────────────── control frame + camera source ─────────────────────────

/** The camera of a control frame, BY VALUE: enough to reconstruct every pixel ray later. */
export interface ControlCamera {
  position: Vec3;
  /** unit quaternion, canonical sign (w ≥ 0): the rotation of the camera (looking down its local −Z) */
  quaternion: QuaternionValue;
  focalLengthMm: number;
  /** the lens is defined on this fixed vertical sensor height */
  sensorHeightMm: typeof PREVIS_SENSOR_HEIGHT_MM;
  fovVerticalDegrees: number;
  aspect: number;
  near: number;
  far: number;
  width: number;
  height: number;
}

export type ControlCameraSource =
  | {
      kind: "camera_path";
      cameraPathId: string;
      cameraPathRevision: number;
      cameraPathFingerprint: string;
      timeMs: number;
      camera: ControlCamera;
    }
  | {
      kind: "bookmark";
      bookmarkId: string;
      /** identity of the bookmark's camera (changes when the production camera is re-linked to a different pose) */
      bookmarkFingerprint: string;
      camera: ControlCamera;
    };

function canonQuat(q: QuaternionValue): QuaternionValue {
  const len = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  let { x, y, z, w } = { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
  if (w < 0 || (w === 0 && (x < 0 || (x === 0 && (y < 0 || (y === 0 && z < 0)))))) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  return { x: r6(x), y: r6(y), z: r6(z), w: r6(w) };
}

function controlCamera(position: Vec3, quaternion: QuaternionValue, focalLengthMm: number): ControlCamera {
  const { width, height } = PREVIS_PRODUCTION_FRAME;
  if (!(focalLengthMm > 0)) throw new Error("The production camera has no valid focal length.");
  const f = r6(focalLengthMm);
  return {
    position: { x: r6(position.x), y: r6(position.y), z: r6(position.z) },
    quaternion: canonQuat(quaternion),
    focalLengthMm: f,
    sensorHeightMm: PREVIS_SENSOR_HEIGHT_MM,
    fovVerticalDegrees: r6(focalLengthToFovDegrees(f)),
    aspect: r6(width / height),
    near: CONTROL_NEAR,
    far: CONTROL_FAR,
    width,
    height,
  };
}

/** From the SHARED camera-path evaluator output (the same value timeline playback and previs use). */
export function controlCameraFromState(state: CameraState): ControlCamera {
  return controlCamera(state.position, state.quaternion, state.focalLengthMm);
}

/** From a frozen Production Camera bookmark (the camera a master frame is rendered with). */
export function controlCameraFromBookmark(b: CameraBookmarkValue): ControlCamera {
  if (b.focalLengthBasis !== "vertical-sensor-24mm") throw new Error("Unsupported focal length basis.");
  if (b.projection !== "perspective") throw new Error("Unsupported projection.");
  return controlCamera(b.position, eulerToQuaternion(b.rotation), b.focalLengthMm);
}

/** From an explicit pose (position + Euler XYZ radians + focal length): used by tests and tools, never the editor camera. */
export function controlCameraFromPose(position: Vec3, rotation: Vec3, focalLengthMm: number): ControlCamera {
  return controlCamera(position, eulerToQuaternion(rotation), focalLengthMm);
}

export const bookmarkCameraFingerprint = (b: CameraBookmarkValue) =>
  fingerprint(controlCameraFromBookmark(b));

/** Evaluates a SAVED camera path at an integer millisecond with the one shared evaluator. */
export function cameraSourceFromPath(
  path: CameraPath,
  record: { id: string; revision: number; pathFingerprint: string },
  timeMs: number,
): Extract<ControlCameraSource, { kind: "camera_path" }> {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > path.durationMs)
    throw new Error("The capture time must be a whole millisecond inside the camera path.");
  const state = evaluateCameraPath(path, timeMs);
  if (!state) throw new Error("The camera path has no keyframes.");
  return {
    kind: "camera_path",
    cameraPathId: record.id,
    cameraPathRevision: record.revision,
    cameraPathFingerprint: record.pathFingerprint,
    timeMs,
    camera: controlCameraFromState(state),
  };
}

export function cameraSourceFromBookmark(
  record: { id: string },
  value: CameraBookmarkValue,
): Extract<ControlCameraSource, { kind: "bookmark" }> {
  return {
    kind: "bookmark",
    bookmarkId: record.id,
    bookmarkFingerprint: bookmarkCameraFingerprint(value),
    camera: controlCameraFromBookmark(value),
  };
}

export interface SpatialControlFrame {
  schema: typeof SPATIAL_CONTROL_FRAME_SCHEMA;
  shotId: string;
  scene: { documentId: string; revision: number; fingerprint: string };
  /** identity of the rendered blocking layer (null = no visible character proxies) */
  blockingFingerprint: string | null;
  camera: ControlCameraSource;
  width: number;
  height: number;
  capturedTimeMs: number;
}

export function buildControlFrame(input: {
  shotId: string;
  scene: SpatialControlFrame["scene"];
  blockingFingerprint: string | null;
  camera: ControlCameraSource;
}): SpatialControlFrame {
  return {
    schema: SPATIAL_CONTROL_FRAME_SCHEMA,
    shotId: input.shotId,
    scene: { ...input.scene },
    blockingFingerprint: input.blockingFingerprint,
    camera: structuredClone(input.camera),
    width: PREVIS_PRODUCTION_FRAME.width,
    height: PREVIS_PRODUCTION_FRAME.height,
    capturedTimeMs: input.camera.kind === "camera_path" ? input.camera.timeMs : 0,
  };
}

// ───────────────────────── object manifest ─────────────────────────

export const OBJECT_CATEGORIES = ["set_object", "character_proxy"] as const;
export type ObjectCategory = (typeof OBJECT_CATEGORIES)[number];

export interface ObjectManifestEntry {
  /** BUNDLE-LOCAL index (1..N). 0 is the background. */
  index: number;
  /** PERSISTENT semantic id: `set_object:<scene object uuid>` or `character_proxy:<characterId>` */
  semanticId: string;
  category: ObjectCategory;
  sceneObjectId?: string;
  characterId?: string;
  blockingId?: string;
  label?: string;
  /** pixels this object owns in the object-id raster (a Character enabled but fully occluded has 0) */
  visiblePixelCount?: number;
}

export interface ObjectManifest {
  schema: typeof OBJECT_MANIFEST_SCHEMA;
  objects: ObjectManifestEntry[];
}

export const setObjectSemanticId = (sceneObjectId: string) => `set_object:${sceneObjectId}`;
export const characterProxySemanticId = (characterId: string) => `character_proxy:${characterId}`;

export interface ManifestSources {
  setObjects: Array<{ id: string; name?: string }>;
  /** only VISIBLE blocked Characters belong in a bundle (a hidden proxy is not rendered) */
  characters: Array<{ characterId: string; blockingId: string; name?: string }>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Deterministic: set objects first, then Character proxies, each by semantic key. Indices are 1..N. */
export function buildObjectManifest(src: ManifestSources): ObjectManifest {
  const entries: Array<Omit<ObjectManifestEntry, "index">> = [
    ...src.setObjects.map((o) => ({
      semanticId: setObjectSemanticId(o.id),
      category: "set_object" as const,
      sceneObjectId: o.id,
      ...(o.name ? { label: o.name } : {}),
    })),
    ...src.characters.map((c) => ({
      semanticId: characterProxySemanticId(c.characterId),
      category: "character_proxy" as const,
      characterId: c.characterId,
      blockingId: c.blockingId,
      ...(c.name ? { label: c.name } : {}),
    })),
  ];
  const order = (e: { category: ObjectCategory; semanticId: string }) =>
    `${e.category === "set_object" ? 0 : 1}|${e.semanticId}`;
  entries.sort((a, b) => cmp(order(a), order(b)));
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.semanticId)) throw new Error(`Duplicate production object ${e.semanticId}.`);
    seen.add(e.semanticId);
  }
  return {
    schema: OBJECT_MANIFEST_SCHEMA,
    objects: entries.map((e, i) => ({ index: i + 1, ...e })),
  };
}

/** What the manifest means for identity: labels and pixel counts are descriptive, not identity. */
export function manifestIdentity(m: ObjectManifest) {
  return m.objects.map((o) => ({
    index: o.index,
    semanticId: o.semanticId,
    category: o.category,
    sceneObjectId: o.sceneObjectId ?? null,
    characterId: o.characterId ?? null,
    blockingId: o.blockingId ?? null,
  }));
}

/**
 * The manifest a SAVED Set + SAVED Shot blocking implies. Used by the server to re-derive (never trust) what a
 * client rendered. Lights are not geometry; hidden objects and hidden Character proxies are not rendered.
 */
export function expectedManifest(
  document: Pick<PrevisDocument, "objects">,
  blocking: ReadonlyArray<{ characterId: string; id: string; entry: { visibility: boolean } }>,
  characterNames: Readonly<Record<string, string>> = {},
): ObjectManifest {
  return buildObjectManifest({
    setObjects: document.objects
      .filter((o) => o.kind !== "light" && o.visible)
      .map((o) => ({ id: o.id, name: o.name })),
    characters: blocking
      .filter((b) => b.entry.visibility)
      .map((b) => ({ characterId: b.characterId, blockingId: b.id, name: characterNames[b.characterId] })),
  });
}

// ───────────────────────── raw formats ─────────────────────────

const hostLittle = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Float32 linear depth → bytes, little-endian, row-major. */
export function encodeDepthF32(depth: Float32Array): Uint8Array {
  const out = new Uint8Array(depth.length * 4);
  if (hostLittle) {
    out.set(new Uint8Array(depth.buffer, depth.byteOffset, depth.byteLength));
    return out;
  }
  const dv = new DataView(out.buffer);
  for (let i = 0; i < depth.length; i++) dv.setFloat32(i * 4, depth[i], true);
  return out;
}

export function decodeDepthF32(bytes: Uint8Array, width: number, height: number): Float32Array {
  if (bytes.byteLength !== width * height * 4)
    throw new Error(`Depth data must be ${width * height * 4} bytes (got ${bytes.byteLength}).`);
  const copy = bytes.slice(); // aligned, owned
  if (hostLittle) return new Float32Array(copy.buffer);
  const dv = new DataView(copy.buffer);
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

export function encodeObjectIdsU32(ids: Uint32Array): Uint8Array {
  const out = new Uint8Array(ids.length * 4);
  if (hostLittle) {
    out.set(new Uint8Array(ids.buffer, ids.byteOffset, ids.byteLength));
    return out;
  }
  const dv = new DataView(out.buffer);
  for (let i = 0; i < ids.length; i++) dv.setUint32(i * 4, ids[i], true);
  return out;
}

export function decodeObjectIdsU32(bytes: Uint8Array, width: number, height: number): Uint32Array {
  if (bytes.byteLength !== width * height * 4)
    throw new Error(`Object-id data must be ${width * height * 4} bytes (got ${bytes.byteLength}).`);
  const copy = bytes.slice();
  if (hostLittle) return new Uint32Array(copy.buffer);
  const dv = new DataView(copy.buffer);
  const out = new Uint32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = dv.getUint32(i * 4, true);
  return out;
}

export function encodeMaskU8(mask: Uint8Array): Uint8Array {
  return mask.slice();
}
export function decodeMaskU8(bytes: Uint8Array, width: number, height: number): Uint8Array {
  if (bytes.byteLength !== width * height)
    throw new Error(`Mask data must be ${width * height} bytes (got ${bytes.byteLength}).`);
  return bytes.slice();
}

export const expectedRasterBytes = {
  depth: (w: number, h: number) => w * h * 4,
  objectIds: (w: number, h: number) => w * h * 4,
  mask: (w: number, h: number) => w * h,
};

// ───────────────────────── validation ─────────────────────────

export interface DepthStats {
  validPixelCount: number;
  minDepth: number | null;
  maxDepth: number | null;
}

/** Rejects NaN / Infinity / negative values and anything beyond the far plane. Background (0) is valid. */
export function validateDepth(
  depth: Float32Array,
  far: number = CONTROL_FAR,
): { ok: true; stats: DepthStats } | { ok: false; error: string } {
  let valid = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i];
    if (!Number.isFinite(d)) return { ok: false, error: `Depth pixel ${i} is not finite.` };
    if (d < 0) return { ok: false, error: `Depth pixel ${i} is negative.` };
    if (d === DEPTH_BACKGROUND) continue;
    if (d < CONTROL_NEAR * 0.999 || d > far * 1.001)
      return { ok: false, error: `Depth pixel ${i} is outside the camera's near/far range.` };
    valid++;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return {
    ok: true,
    stats: { validPixelCount: valid, minDepth: valid ? min : null, maxDepth: valid ? max : null },
  };
}

/** Pixels owned by each manifest index (index 0 = background). Rejects any index outside 0..maxIndex. */
export function countObjectPixels(
  ids: Uint32Array,
  maxIndex: number,
): { ok: true; counts: Uint32Array } | { ok: false; error: string } {
  const counts = new Uint32Array(maxIndex + 1);
  for (let i = 0; i < ids.length; i++) {
    const v = ids[i];
    if (v > maxIndex) return { ok: false, error: `Object-id pixel ${i} (${v}) is not in the manifest.` };
    counts[v]++;
  }
  return { ok: true, counts };
}

/** A pixel is covered by depth exactly when it belongs to an object. */
export function depthMatchesIds(depth: Float32Array, ids: Uint32Array): boolean {
  if (depth.length !== ids.length) return false;
  for (let i = 0; i < ids.length; i++) if (depth[i] > 0 !== ids[i] > 0) return false;
  return true;
}

export function validateMaskValues(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i++) if (mask[i] !== MASK_ON && mask[i] !== MASK_OFF) return false;
  return true;
}

// ───────────────────────── character masks ─────────────────────────

export interface DerivedCharacterMask {
  characterId: string;
  objectIndex: number;
  mask: Uint8Array;
  visiblePixelCount: number;
}

/**
 * Exact visible-pixel masks derived from the object-id raster (no re-render, no feathering/blur/dilation/erosion).
 * Only Character proxies in the manifest (= visible blocking) get a mask. A Character that is enabled but fully
 * occluded still gets an all-zero mask and visiblePixelCount 0: that is truthful.
 */
export function deriveCharacterMasks(ids: Uint32Array, manifest: ObjectManifest): DerivedCharacterMask[] {
  return manifest.objects
    .filter((o) => o.category === "character_proxy" && o.characterId)
    .map((o) => {
      const mask = new Uint8Array(ids.length);
      let n = 0;
      for (let i = 0; i < ids.length; i++)
        if (ids[i] === o.index) {
          mask[i] = MASK_ON;
          n++;
        }
      return { characterId: o.characterId!, objectIndex: o.index, mask, visiblePixelCount: n };
    });
}

export function withPixelCounts(manifest: ObjectManifest, counts: Uint32Array): ObjectManifest {
  return {
    ...manifest,
    objects: manifest.objects.map((o) => ({ ...o, visiblePixelCount: counts[o.index] ?? 0 })),
  };
}

export interface CharacterMasksJson {
  schema: typeof CHARACTER_MASKS_SCHEMA;
  masks: Record<
    string,
    {
      blockingId: string;
      blockingRevision: number;
      blockingFingerprint: string;
      objectIndex: number;
      assetId: string;
      encoding: typeof CHARACTER_MASK_FORMAT;
      visiblePixelCount: number;
    }
  >;
}

export interface DepthMetadata {
  schema: typeof DEPTH_FORMAT;
  semantic: "linear-view-space-depth";
  units: typeof DEPTH_UNITS;
  backgroundValue: typeof DEPTH_BACKGROUND;
  near: number;
  far: number;
  rowOrder: typeof ROW_ORDER;
  endianness: typeof ENDIANNESS;
  validPixelCount: number;
  minDepth: number | null;
  maxDepth: number | null;
}

export function depthMetadata(stats: DepthStats): DepthMetadata {
  return {
    schema: DEPTH_FORMAT,
    semantic: "linear-view-space-depth",
    units: DEPTH_UNITS,
    backgroundValue: DEPTH_BACKGROUND,
    near: CONTROL_NEAR,
    far: CONTROL_FAR,
    rowOrder: ROW_ORDER,
    endianness: ENDIANNESS,
    validPixelCount: stats.validPixelCount,
    minDepth: stats.minDepth === null ? null : r6(stats.minDepth),
    maxDepth: stats.maxDepth === null ? null : r6(stats.maxDepth),
  };
}

// ───────────────────────── bundle fingerprint + staleness ─────────────────────────

/**
 * The identity of a bundle: what it was rendered FROM (never the navigation camera, selection, helpers, panel state,
 * playhead UI, or any object URL).
 */
export function spatialBundleFingerprint(input: {
  shotId: string;
  sceneFingerprint: string;
  blockingFingerprint: string | null;
  camera: ControlCameraSource;
  width: number;
  height: number;
  manifest: ObjectManifest;
}): string {
  return fingerprint({
    schema: SPATIAL_PASS_BUNDLE_SCHEMA,
    algorithm: SPATIAL_PASS_ALGORITHM,
    formats: [DEPTH_FORMAT, OBJECT_ID_FORMAT, CHARACTER_MASK_FORMAT],
    shotId: input.shotId,
    sceneFingerprint: input.sceneFingerprint,
    blockingFingerprint: input.blockingFingerprint,
    camera: input.camera,
    width: input.width,
    height: input.height,
    manifest: manifestIdentity(input.manifest),
  });
}

export type SpatialPassStaleReason = "scene" | "camera" | "blocking";

export const SPATIAL_STALE_LABEL: Record<SpatialPassStaleReason, string> = {
  scene: "STALE SCENE",
  camera: "STALE CAMERA",
  blocking: "STALE BLOCKING",
};

export interface SpatialBundleIdentity {
  sceneFingerprint: string;
  blockingFingerprint: string | null;
  camera: ControlCameraSource;
}

export interface SpatialCurrentState {
  /** the saved Set now (null = nothing saved) */
  sceneFingerprint: string | null;
  /** the rendered blocking layer now (null = no visible proxies) */
  blockingFingerprint: string | null;
  /** the saved camera path now (null = none) */
  pathFingerprint: string | null;
  /** the Shot's production camera bookmark now (null = none) */
  bookmarkCameraFingerprint: string | null;
}

/** Audio never appears here: these assets contain no audio. */
export function spatialPassStaleReasons(
  bundle: SpatialBundleIdentity,
  current: SpatialCurrentState,
): SpatialPassStaleReason[] {
  const reasons: SpatialPassStaleReason[] = [];
  if (!current.sceneFingerprint || bundle.sceneFingerprint !== current.sceneFingerprint)
    reasons.push("scene");
  const cameraOk =
    bundle.camera.kind === "camera_path"
      ? current.pathFingerprint === bundle.camera.cameraPathFingerprint
      : current.bookmarkCameraFingerprint === bundle.camera.bookmarkFingerprint;
  if (!cameraOk) reasons.push("camera");
  if ((bundle.blockingFingerprint ?? null) !== (current.blockingFingerprint ?? null))
    reasons.push("blocking");
  return reasons;
}

/** The latest bundle that is exactly current (never merely the newest). */
export function pickCurrentBundle<T extends SpatialBundleIdentity & { createdAt: string; id: string }>(
  bundles: readonly T[],
  current: SpatialCurrentState,
): T | null {
  return (
    [...bundles]
      .filter((b) => spatialPassStaleReasons(b, current).length === 0)
      .sort((a, b) =>
        a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : a.id < b.id ? 1 : -1,
      )[0] ?? null
  );
}

// ───────────────────────── GenerationPackage reference ─────────────────────────

export const CONTROL_PASSES_SCHEMA_VERSION = 1 as const;

/**
 * The CURRENT bundle frozen into a package BY VALUE (asset ids and metadata; never bytes or URLs). Provider
 * adapters decide later HOW to consume it; nothing here is injected into any prompt.
 */
export interface ControlPassesReference {
  schemaVersion: typeof CONTROL_PASSES_SCHEMA_VERSION;
  bundleId: string;
  bundleFingerprint: string;
  width: number;
  height: number;
  cameraSource: ControlCameraSource["kind"];
  camera: ControlCameraSource;
  rowOrder: typeof ROW_ORDER;
  depth: {
    assetId: string;
    encoding: typeof DEPTH_FORMAT;
    units: typeof DEPTH_UNITS;
    backgroundValue: typeof DEPTH_BACKGROUND;
    near: number;
    far: number;
  };
  objectIds: { assetId: string; encoding: typeof OBJECT_ID_FORMAT; manifest: ObjectManifest };
  characterMasks: Array<{
    characterId: string;
    assetId: string;
    encoding: typeof CHARACTER_MASK_FORMAT;
    objectIndex: number;
    blockingFingerprint: string;
    visiblePixelCount: number;
  }>;
}

export interface SpatialBundleLike {
  id: string;
  bundleFingerprint: string;
  width: number;
  height: number;
  camera: ControlCameraSource;
  depth: { assetId: string; encoding: typeof DEPTH_FORMAT; metadata: DepthMetadata };
  objectIds: { assetId: string; encoding: typeof OBJECT_ID_FORMAT; manifest: ObjectManifest };
  characterMasks: CharacterMasksJson;
}

export function buildControlPassesReference(b: SpatialBundleLike): ControlPassesReference {
  return {
    schemaVersion: CONTROL_PASSES_SCHEMA_VERSION,
    bundleId: b.id,
    bundleFingerprint: b.bundleFingerprint,
    width: b.width,
    height: b.height,
    cameraSource: b.camera.kind,
    camera: structuredClone(b.camera),
    rowOrder: ROW_ORDER,
    depth: {
      assetId: b.depth.assetId,
      encoding: b.depth.encoding,
      units: DEPTH_UNITS,
      backgroundValue: DEPTH_BACKGROUND,
      near: b.depth.metadata.near,
      far: b.depth.metadata.far,
    },
    objectIds: {
      assetId: b.objectIds.assetId,
      encoding: b.objectIds.encoding,
      manifest: structuredClone(b.objectIds.manifest),
    },
    characterMasks: Object.entries(b.characterMasks.masks)
      .sort(([a], [c]) => cmp(a, c))
      .map(([characterId, m]) => ({
        characterId,
        assetId: m.assetId,
        encoding: m.encoding,
        objectIndex: m.objectIndex,
        blockingFingerprint: m.blockingFingerprint,
        visiblePixelCount: m.visiblePixelCount,
      })),
  };
}

// ───────────────────────── human previews (display only) ─────────────────────────

/**
 * RGBA display previews generated directly from canonical bytes. They are NEVER canonical data: depth is
 * normalised only for display (nearest → dark, farthest → light); object colours are a visualisation of indices.
 */
export function depthPreviewRgba(depth: Float32Array): Uint8ClampedArray {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i];
    if (d > 0) {
      if (d < min) min = d;
      if (d > max) max = d;
    }
  }
  const span = max > min ? max - min : 1;
  const out = new Uint8ClampedArray(depth.length * 4);
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i];
    const v = d > 0 ? Math.round(32 + 223 * ((d - min) / span)) : 0;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Deterministic false colour for a bundle-local index (0 = black). */
export function objectIndexColor(index: number): [number, number, number] {
  if (index <= 0) return [0, 0, 0];
  const h = (index * 0.61803398875) % 1;
  const s = 0.65;
  const v = 0.95;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export function objectIdPreviewRgba(ids: Uint32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(ids.length * 4);
  const cache = new Map<number, [number, number, number]>();
  for (let i = 0; i < ids.length; i++) {
    let c = cache.get(ids[i]);
    if (!c) {
      c = objectIndexColor(ids[i]);
      cache.set(ids[i], c);
    }
    out[i * 4] = c[0];
    out[i * 4 + 1] = c[1];
    out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function maskPreviewRgba(mask: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.length * 4);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] === MASK_ON ? 255 : 0;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}
