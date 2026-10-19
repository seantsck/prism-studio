import { z } from "zod";
import { fingerprint } from "../hash";
import { quatFromEuler, type Quat } from "./quat";
import type { PrevisObject } from "./types";

/**
 * Gaussian-splat spatial environments (Phase 2F M2D.1). A splat is SPATIAL ENVIRONMENT DATA that belongs to a
 * Location: it is a persistent Set object, never a Shot object, a reference image or a video.
 *
 * Two deliberately separate records:
 *   - the RECONSTRUCTION (immutable, `location_spatial_reconstructions`): the raw result and where it came from;
 *   - the SCENE OBJECT (mutable, in the Set document): placement and calibration (transform, scale provenance).
 * Editing the placement never rewrites the origin truth.
 */

/** Largest splat file M2D.1 accepts: the existing practical upload architecture (see previs 50 MB cap). */
export const MAX_SPLAT_BYTES = 50 * 1024 * 1024;
/** Upper bound on Gaussians in one imported file (bounds decompression and GPU memory). */
export const MAX_SPLAT_GAUSSIANS = 8_000_000;

export const SPLAT_FORMATS = ["splat", "spz", "ply"] as const;
export type SplatFormat = (typeof SPLAT_FORMATS)[number];

export interface SplatFormatInfo {
  format: SplatFormat;
  extension: string;
  /** truthful machine MIME for the stored Asset */
  mime: string;
  label: string;
}

export const SPLAT_FORMAT_INFO: Record<SplatFormat, SplatFormatInfo> = {
  splat: {
    format: "splat",
    extension: ".splat",
    mime: "application/x-gaussian-splat",
    label: "Gaussian .splat (32-byte records)",
  },
  spz: {
    format: "spz",
    extension: ".spz",
    mime: "application/x-spz",
    label: "SPZ (gzip-compressed Gaussians)",
  },
  ply: {
    format: "ply",
    extension: ".ply",
    mime: "application/x-ply",
    label: "Gaussian PLY (binary little-endian, 3DGS attributes)",
  },
};

export const SPLAT_MIMES: readonly string[] = SPLAT_FORMATS.map((f) => SPLAT_FORMAT_INFO[f].mime);
export const isSplatMime = (mime: string | null | undefined) => !!mime && SPLAT_MIMES.includes(mime);
export const splatFormatFromMime = (mime: string | null | undefined): SplatFormat | null =>
  SPLAT_FORMATS.find((f) => SPLAT_FORMAT_INFO[f].mime === mime) ?? null;
export const splatFormatFromFilename = (name: string): SplatFormat | null => {
  const lower = name.toLowerCase();
  return SPLAT_FORMATS.find((f) => lower.endsWith(SPLAT_FORMAT_INFO[f].extension)) ?? null;
};

// ───────────────────────── calibration (the SCENE OBJECT's placement truth) ─────────────────────────

/**
 * Scale provenance. A reconstruction from another tool has arbitrary units: "1 splat unit = 1 metre" is NEVER
 * assumed. `metres` is reachable only by an explicit human numeric entry (`manual`) or by a provider that documents
 * a metric scale ESTIMATE for its output (`provider_estimated`, M2D.2). An estimate is never called exact.
 */
export const SCALE_METHODS = ["unknown", "manual", "provider_estimated"] as const;
export const calibrationSchema = z
  .object({
    units: z.enum(["unknown", "metres"]),
    metresPerSourceUnit: z.number().finite().positive().nullable(),
    scaleMethod: z.enum(SCALE_METHODS),
    /** ground-level offset along the Set's up axis, in Set metres (0 = unset). Applied by the user, not detected. */
    groundOffsetMetres: z.number().finite().default(0),
  })
  .refine((c) => (c.scaleMethod === "unknown") === (c.metresPerSourceUnit === null), {
    message: "metresPerSourceUnit is set exactly when the scale is known (manual or provider-estimated)",
  })
  .refine((c) => (c.units === "metres") === (c.scaleMethod !== "unknown"), {
    message: "units are metres exactly when the scale was set manually or estimated by the provider",
  });
export type SplatCalibration = z.infer<typeof calibrationSchema>;

export const UNKNOWN_CALIBRATION: SplatCalibration = Object.freeze({
  units: "unknown",
  metresPerSourceUnit: null,
  scaleMethod: "unknown",
  groundOffsetMetres: 0,
}) as SplatCalibration;

export function manualCalibration(metresPerSourceUnit: number, groundOffsetMetres = 0): SplatCalibration {
  return calibrationSchema.parse({
    units: "metres",
    metresPerSourceUnit,
    scaleMethod: "manual",
    groundOffsetMetres,
  });
}

/**
 * A provider's documented metric-scale ESTIMATE (e.g. World Labs `semantics_metadata.metric_scale_factor`). A factor
 * of exactly 1 is documented as "not inferred", so it is NOT an estimate; null / invalid is unknown.
 */
export function providerEstimatedCalibration(
  metricScaleFactor: number | null | undefined,
  groundOffsetMetres: number | null | undefined = 0,
): SplatCalibration {
  if (typeof metricScaleFactor !== "number" || !Number.isFinite(metricScaleFactor) || metricScaleFactor <= 0)
    return { ...UNKNOWN_CALIBRATION };
  if (metricScaleFactor === 1) return { ...UNKNOWN_CALIBRATION };
  return calibrationSchema.parse({
    units: "metres",
    metresPerSourceUnit: metricScaleFactor,
    scaleMethod: "provider_estimated",
    groundOffsetMetres:
      typeof groundOffsetMetres === "number" && Number.isFinite(groundOffsetMetres) ? groundOffsetMetres : 0,
  });
}

/** Parse a stored calibration; anything malformed is treated as unknown scale (never as metric). */
export function parseCalibration(value: unknown): SplatCalibration {
  const parsed = calibrationSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...UNKNOWN_CALIBRATION };
}

/** The uniform scale a user must give the object so that 1 source unit == `metresPerSourceUnit` metres. */
export const scaleFromMetresPerUnit = (metresPerSourceUnit: number) => metresPerSourceUnit;

// ───────────────────────── reconstruction provenance (IMMUTABLE) ─────────────────────────

export const RECONSTRUCTION_SCHEMA = "prism.spatial-reconstruction.v1" as const;
/** `imported` (M2D.1): a file the user brought. `generated` (M2D.2): produced by a reconstruction job + provider. */
export const RECONSTRUCTION_METHODS = ["imported", "generated"] as const;
export const RECONSTRUCTION_RESULT_KINDS = ["gaussian_splat"] as const;

export const sourceAssetSchema = z.object({
  assetId: z.string().min(1),
  checksum: z.string().nullable(),
});
export type ReconstructionSource = z.infer<typeof sourceAssetSchema>;

/** Provider provenance of a GENERATED reconstruction (never a URL, a key or a temporary grant). */
export const generationProvenanceSchema = z.object({
  jobId: z.string().min(1),
  attempt: z.number().int().positive(),
  provider: z.string().min(1),
  capability: z.string().min(1),
  model: z.string().nullable(),
  operationId: z.string().nullable(),
  /** sanitised, bounded provider metadata (e.g. world id, chosen resolution, scale estimate) */
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type GenerationProvenance = z.infer<typeof generationProvenanceSchema>;

export interface ReconstructionIdentity {
  locationId: string;
  method: (typeof RECONSTRUCTION_METHODS)[number];
  resultKind: (typeof RECONSTRUCTION_RESULT_KINDS)[number];
  result: ReconstructionSource;
  sources: ReconstructionSource[];
  /** the calibration the SOURCE claimed on arrival (units unknown for an import), immutable provenance */
  calibration: SplatCalibration;
  /** generated only: which job / provider / model / operation produced it */
  generation?: GenerationProvenance | null;
}

const byAsset = (a: ReconstructionSource, b: ReconstructionSource) =>
  a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0;

/** Imported sources are a SET: duplicates collapse, order never matters. */
export function canonicalSources(sources: ReconstructionSource[]): ReconstructionSource[] {
  const seen = new Map<string, ReconstructionSource>();
  for (const s of sources) if (!seen.has(s.assetId)) seen.set(s.assetId, { ...s });
  return [...seen.values()].sort(byAsset);
}

/**
 * Identity of a reconstruction. Excludes panel state, selection, navigation camera, temporary URLs, names and
 * timestamps; includes the result Asset's CONTENT checksum and the canonicalised source images' checksums.
 */
export function reconstructionFingerprint(id: ReconstructionIdentity): string {
  return fingerprint({
    schema: RECONSTRUCTION_SCHEMA,
    locationId: id.locationId,
    method: id.method,
    resultKind: id.resultKind,
    result: { assetId: id.result.assetId, checksum: id.result.checksum },
    sources: sourcesFor(id.method, id.sources).map((s) => ({ assetId: s.assetId, checksum: s.checksum })),
    // generated only (absent for imports, so M2D.1 fingerprints are unchanged)
    ...(id.method === "generated" && id.generation
      ? {
          generation: {
            jobId: id.generation.jobId,
            attempt: id.generation.attempt,
            provider: id.generation.provider,
            capability: id.generation.capability,
            model: id.generation.model,
            operationId: id.generation.operationId,
          },
        }
      : {}),
    calibration: {
      units: id.calibration.units,
      metresPerSourceUnit: id.calibration.metresPerSourceUnit,
      scaleMethod: id.calibration.scaleMethod,
      groundOffsetMetres: id.calibration.groundOffsetMetres,
    },
  });
}

/**
 * Imported sources are an unordered set; GENERATED sources keep the job's order (the first image is the primary one
 * and provider semantics may depend on it), de-duplicated but never sorted.
 */
export function sourcesFor(method: ReconstructionIdentity["method"], sources: ReconstructionSource[]) {
  if (method !== "generated") return canonicalSources(sources);
  const seen = new Set<string>();
  return sources
    .filter((s) => (seen.has(s.assetId) ? false : (seen.add(s.assetId), true)))
    .map((s) => ({ ...s }));
}

export interface SpatialReconstructionRecord {
  id: string;
  projectId: string;
  locationId: string;
  schemaVersion: typeof RECONSTRUCTION_SCHEMA;
  method: ReconstructionIdentity["method"];
  resultKind: ReconstructionIdentity["resultKind"];
  resultAssetId: string;
  resultChecksum: string | null;
  /** truthful facts about the result file, measured at import */
  resultFormat: SplatFormat;
  gaussianCount: number | null;
  sources: ReconstructionSource[];
  calibration: SplatCalibration;
  /** generated only; null for imports */
  generation: GenerationProvenance | null;
  fingerprint: string;
  createdBy: string | null;
  createdAt: string;
}

export interface NewSpatialReconstruction {
  id: string;
  projectId: string;
  locationId: string;
  method: ReconstructionIdentity["method"];
  resultKind: ReconstructionIdentity["resultKind"];
  resultAssetId: string;
  resultChecksum: string | null;
  resultFormat: SplatFormat;
  gaussianCount: number | null;
  sources: ReconstructionSource[];
  calibration: SplatCalibration;
  generation?: GenerationProvenance | null;
  userId: string | null;
  now: string;
}

export function reconstructionFingerprintOf(r: {
  locationId: string;
  method: ReconstructionIdentity["method"];
  resultKind: ReconstructionIdentity["resultKind"];
  resultAssetId: string;
  resultChecksum: string | null;
  sources: ReconstructionSource[];
  calibration: SplatCalibration;
  generation?: GenerationProvenance | null;
}): string {
  return reconstructionFingerprint({
    locationId: r.locationId,
    method: r.method,
    resultKind: r.resultKind,
    result: { assetId: r.resultAssetId, checksum: r.resultChecksum },
    sources: r.sources,
    calibration: r.calibration,
    generation: r.generation ?? null,
  });
}

// ───────────────────────── the scene object's splat facts ─────────────────────────

/** user_data keys Prism writes on a splat object in the engine scene (carried by the engine's own save JSON). */
export const SPLAT_USER_DATA = {
  reconstructionId: "prismReconstructionId",
  calibration: "prismSplatCalibration",
  format: "prismSplatFormat",
  gaussianCount: "prismSplatGaussians",
} as const;

export const isSplatObject = (o: Pick<PrevisObject, "kind">) => o.kind === "splat";

// ───────────────────────── GenerationPackage freeze ─────────────────────────

export const SPATIAL_ENVIRONMENT_SCHEMA_VERSION = 1 as const;

/**
 * The Location's Gaussian-splat environment frozen BY VALUE into a package. Optional: a Shot whose Set has no splat
 * has no `spatialEnvironment` key at all, so earlier packages are byte-identical. No bytes, no URLs.
 */
export interface SpatialEnvironmentReference {
  schemaVersion: typeof SPATIAL_ENVIRONMENT_SCHEMA_VERSION;
  kind: "gaussian_splat";
  sceneObjectId: string;
  reconstructionId: string;
  reconstructionFingerprint: string;
  assetId: string;
  assetChecksum: string | null;
  format: SplatFormat;
  gaussianCount: number | null;
  visible: boolean;
  transform: {
    position: { x: number; y: number; z: number };
    /** Euler XYZ radians (engine convention) */
    rotation: { x: number; y: number; z: number };
    /** the same rotation as a unit quaternion */
    orientation: Quat;
    scale: { x: number; y: number; z: number };
  };
  calibration: SplatCalibration;
  /** reconstruction provenance: the images the splat was reconstructed from (NOT shot references) */
  sourceReferenceAssetIds: string[];
  sourceReferences: ReconstructionSource[];
  /**
   * Present only for a GENERATED reconstruction (M2D.2): job / provider / model / operation identity. Additive:
   * imported environments have no `generation` key, so their packages are unchanged.
   */
  generation?: {
    method: "generated";
    jobId: string;
    attempt: number;
    provider: string;
    capability: string;
    model: string | null;
    operationId: string | null;
  };
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5 + 0;
const rv = (v: { x: number; y: number; z: number }) => ({ x: r5(v.x), y: r5(v.y), z: r5(v.z) });

export function buildSpatialEnvironment(
  object: PrevisObject,
  reconstruction: SpatialReconstructionRecord,
): SpatialEnvironmentReference {
  const q = quatFromEuler(object.rotation.x, object.rotation.y, object.rotation.z);
  return {
    schemaVersion: SPATIAL_ENVIRONMENT_SCHEMA_VERSION,
    kind: "gaussian_splat",
    sceneObjectId: object.id,
    reconstructionId: reconstruction.id,
    reconstructionFingerprint: reconstruction.fingerprint,
    assetId: reconstruction.resultAssetId,
    assetChecksum: object.assetChecksum ?? reconstruction.resultChecksum,
    format: reconstruction.resultFormat,
    gaussianCount: reconstruction.gaussianCount,
    visible: object.visible,
    transform: {
      position: rv(object.position),
      rotation: rv(object.rotation),
      orientation: { x: r5(q.x), y: r5(q.y), z: r5(q.z), w: r5(q.w) },
      scale: rv(object.scale),
    },
    calibration: parseCalibration(object.calibration ?? null),
    sourceReferenceAssetIds: sourcesFor(reconstruction.method, reconstruction.sources).map((s) => s.assetId),
    sourceReferences: sourcesFor(reconstruction.method, reconstruction.sources),
    ...(reconstruction.method === "generated" && reconstruction.generation
      ? {
          generation: {
            method: "generated" as const,
            jobId: reconstruction.generation.jobId,
            attempt: reconstruction.generation.attempt,
            provider: reconstruction.generation.provider,
            capability: reconstruction.generation.capability,
            model: reconstruction.generation.model,
            operationId: reconstruction.generation.operationId,
          },
        }
      : {}),
  };
}

/** M2C interop: a visible splat has no exact depth/id path yet, so control-pass capture must be blocked. */
export const SPLAT_PASSES_BLOCKED_MESSAGE =
  "Spatial control passes for Gaussian splat environments are not supported yet. Hide the splat or use mesh geometry to capture exact depth and object masks.";

export const hasVisibleSplat = (objects: Array<Pick<PrevisObject, "kind" | "visible">>) =>
  objects.some((o) => o.kind === "splat" && o.visible);
