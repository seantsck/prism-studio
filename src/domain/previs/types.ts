import { z } from "zod";
import { calibrationSchema } from "./splat";

/**
 * Prism-owned 3D set ("previs") document. The ArtCraft-derived engine owns the runtime scene graph; Prism owns
 * this wrapper, which is what is persisted, fingerprinted and frozen into generation packages.
 *
 * Nothing in here may carry a signed URL, blob URL, provider account id or any other ephemeral value.
 */

export const PREVIS_SCHEMA = "prism.previs.v1" as const;
export const PREVIS_ENGINE = "artcraft-derived" as const;
/** The pinned upstream commit the vendored scene engine was taken from. */
export const PREVIS_UPSTREAM_COMMIT = "d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373" as const;

/** The 3D set is authored in the PRODUCTION frame (not a provider canvas). */
export const PREVIS_PRODUCTION_FRAME = { ratio: "2.39:1", width: 1912, height: 800 } as const;
/** The engine's lens model derives vertical field of view from focal length on a fixed 24 mm sensor height. */
export const PREVIS_SENSOR_HEIGHT_MM = 24 as const;

const num = z.number().finite();
export const vec3Schema = z.object({ x: num, y: num, z: num });
export type Vec3 = z.infer<typeof vec3Schema>;

export const PREVIS_OBJECT_KINDS = ["primitive", "mannequin", "glb", "light", "splat"] as const;
export const PREVIS_PRIMITIVES = ["Box", "Plane", "Cylinder", "Cone", "Sphere", "Donut"] as const;
export type PrevisObjectKind = (typeof PREVIS_OBJECT_KINDS)[number];

/** One production-relevant object, normalised from the engine scene (the engine uuid is the stable id). */
export const previsObjectSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(PREVIS_OBJECT_KINDS),
  /** primitive shape key (Box/Plane/...) for kind=primitive; absent otherwise */
  shape: z.string().nullable(),
  name: z.string(),
  /** Prism Asset id for kind=glb or kind=splat. Never a URL. */
  assetId: z.string().nullable(),
  /** content checksum of that asset when known (so an asset replaced in place changes the fingerprint) */
  assetChecksum: z.string().nullable(),
  /** Prism Character this proxy blocks (kind=mannequin). The mannequin is NOT visual identity. */
  characterId: z.string().nullable(),
  position: vec3Schema,
  /** Euler XYZ, radians (engine convention) */
  rotation: vec3Schema,
  scale: vec3Schema,
  color: z.string().nullable(),
  visible: z.boolean(),
  locked: z.boolean(),
  /** kind=splat: the immutable reconstruction record this environment came from (M2D.1). Null for every other kind. */
  reconstructionId: z.string().nullable().default(null),
  /** kind=splat: mutable placement/scale provenance. Null for every other kind. */
  calibration: calibrationSchema.nullable().default(null),
});
export type PrevisObject = z.infer<typeof previsObjectSchema>;

/** The production camera: the Shot's camera, never the editor navigation camera. */
export const previsCameraSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  position: vec3Schema,
  /** Euler XYZ, radians */
  rotation: vec3Schema,
  /** millimetres, on the engine's 24 mm sensor-height lens model */
  focalLengthMm: num.positive(),
});
export type PrevisCamera = z.infer<typeof previsCameraSchema>;

export const previsDocumentSchema = z.object({
  schema: z.literal(PREVIS_SCHEMA),
  engine: z.literal(PREVIS_ENGINE),
  upstreamCommit: z.string().min(7),
  productionFrame: z.object({
    ratio: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  /** Prism-normalised, fingerprinted production state. */
  objects: z.array(previsObjectSchema),
  productionCamera: previsCameraSchema.nullable(),
  /** assetId -> stable metadata. Resolved to a short-lived authorised URL at runtime, never persisted. */
  assetBindings: z.record(z.string(), z.object({ checksum: z.string().nullable() })),
  /** The engine's own serialised scene JSON (opaque round-trip payload). Contains no URLs. */
  scene: z.record(z.string(), z.unknown()),
  /** Editor-only state. Excluded from the fingerprint and never used as a Shot camera. */
  editor: z.object({
    navigationCamera: z.object({ position: vec3Schema, rotation: vec3Schema }).nullable(),
  }),
});
export type PrevisDocument = z.infer<typeof previsDocumentSchema>;

/** A normalised Shot camera bookmark (persisted per shot; see shot_camera_bookmarks). */
export const cameraBookmarkSchema = z.object({
  position: vec3Schema,
  rotation: vec3Schema,
  /** point one unit ahead of the camera along its view direction */
  target: vec3Schema,
  projection: z.literal("perspective"),
  fovVerticalDegrees: num.positive(),
  focalLengthMm: num.positive(),
  /** how focalLengthMm relates to the FOV: the engine's lens convention, stated rather than assumed */
  focalLengthBasis: z.literal("vertical-sensor-24mm"),
  productionAspectRatio: z.string(),
  productionAspectValue: num.positive(),
});
export type CameraBookmarkValue = z.infer<typeof cameraBookmarkSchema>;
