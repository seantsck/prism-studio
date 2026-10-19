/**
 * Phase 2F M2D.3A: the FREE, LOCAL reconstruction engine's own types. Provider-neutral and database-free: nothing
 * here knows about reconstruction_jobs, repositories or server actions. M2D.3B adapts these types to the job system.
 *
 *   ordered photographs → local workspace → COLMAP (camera poses) → Brush (Gaussian-splat training)
 *     → validated Gaussian PLY → production SPZ → validated SPZ
 *
 * Source photographs never leave the machine: the engine makes no network call of any kind.
 */

export const LOCAL_RUN_SCHEMA = "prism.local-reconstruction-run.v1" as const;

/** The explicit pipeline stages, in order. */
export const LOCAL_STAGES = [
  "preparing",
  "camera_reconstruction",
  "splat_training",
  "validating_ply",
  "converting_spz",
  "validating_spz",
  "complete",
] as const;
export type LocalStage = (typeof LOCAL_STAGES)[number];

/**
 * Coarse stage weights for an overall progress figure. Only stage boundaries are reported (no percentage is
 * invented from noisy CLI logs), so the overall number is honest about its precision.
 */
export const STAGE_WEIGHTS: Readonly<Record<LocalStage, number>> = {
  preparing: 0.02,
  camera_reconstruction: 0.28,
  splat_training: 0.6,
  validating_ply: 0.03,
  converting_spz: 0.04,
  validating_spz: 0.03,
  complete: 0,
};

/** Overall progress at the START of a stage (0..1), from the coarse weights. */
export function progressAtStageStart(stage: LocalStage): number {
  let p = 0;
  for (const s of LOCAL_STAGES) {
    if (s === stage) break;
    p += STAGE_WEIGHTS[s];
  }
  return Math.min(1, Math.round(p * 100) / 100);
}

export const LOCAL_ERROR_CODES = [
  "toolchain_missing",
  "unsupported_version",
  "invalid_inputs",
  "workspace_failed",
  "colmap_failed",
  "insufficient_camera_registration",
  "brush_failed",
  "gpu_unavailable",
  "out_of_memory",
  "cancelled",
  "timeout",
  "ply_missing",
  "ply_invalid",
  "spz_conversion_failed",
  "spz_invalid",
  "result_too_large",
] as const;
export type LocalErrorCode = (typeof LOCAL_ERROR_CODES)[number];

/** A normalized engine failure. `diagnostic` is bounded, path-redacted text safe to show; never a full CLI log. */
export class LocalReconstructionError extends Error {
  constructor(
    readonly code: LocalErrorCode,
    message: string,
    readonly stage: LocalStage | null = null,
    readonly diagnostic: string | null = null,
  ) {
    super(message);
    this.name = "LocalReconstructionError";
  }
}

/** Quality profiles map to FIXED, allow-listed tool arguments (never free-form options from a user). */
export const QUALITY_PROFILES = ["draft", "standard", "high"] as const;
export type QualityProfile = (typeof QUALITY_PROFILES)[number];

export const SUPPORTED_INPUT_MIMES = {
  "image/jpeg": "jpg",
  "image/png": "png",
} as const;
export type SupportedInputMime = keyof typeof SUPPORTED_INPUT_MIMES;

/** One ordered input photograph. The bytes come from a local file or an in-memory buffer; never a URL. */
export interface LocalReconstructionInput {
  /** 0-based position in the request; the materialized file name follows it (000001.jpg is ordinal 0) */
  ordinal: number;
  source: { kind: "file"; path: string } | { kind: "bytes"; bytes: Uint8Array };
  /** sha256 hex the caller expects; the engine re-hashes and refuses a mismatch */
  checksum: string | null;
  mime: string;
}

export interface LocalReconstructionRequest {
  /** caller-chosen id; becomes the workspace directory name, so it must be a safe identifier */
  runId: string;
  inputs: LocalReconstructionInput[];
  quality: QualityProfile;
}

export interface LocalReconstructionProgress {
  stage: LocalStage;
  /** coarse overall 0..1 from stage weights (never finer than the stage boundary it reflects) */
  progress: number;
  message: string;
}

export interface ToolVersions {
  colmap: string;
  brush: string;
  spzEncoder: string;
}

export interface CameraReconstructionMetrics {
  inputImages: number;
  registeredImages: number;
  registrationRatio: number;
  sparsePoints: number;
  cameraCount: number;
  /** the sparse model directory chosen (e.g. "0") and every model discovered */
  chosenModel: string;
  modelsDiscovered: Array<{ name: string; registeredImages: number; points: number }>;
}

export interface LocalReconstructionResult {
  runId: string;
  plyPath: string;
  spzPath: string;
  format: "spz";
  gaussianCount: number;
  /** SPZ bytes */
  byteSize: number;
  /** sha256 of the final SPZ */
  checksum: string;
  manifestPath: string;
  metadata: LocalRunMetadata;
}

export interface LocalRunMetadata {
  schema: typeof LOCAL_RUN_SCHEMA;
  quality: QualityProfile;
  tools: ToolVersions;
  colmap: { settings: Record<string, string | number | boolean>; metrics: CameraReconstructionMetrics };
  brush: { settings: Record<string, string | number | boolean> };
  ply: { gaussianCount: number; shDegree: number; byteSize: number; checksum: string };
  spz: SpzConversionReport;
}

/** What the PLY → SPZ conversion did. SPZ is QUANTIZED compression: it is never lossless. */
export interface SpzConversionReport {
  encoder: string;
  spzVersion: number;
  lossless: false;
  fractionalBits: number;
  shDegreeIn: number;
  shDegreeOut: number;
  /** true when the SH degree was reduced by an explicit setting (never silently) */
  shReduced: boolean;
  antialiased: boolean;
  /** how many values fell outside SPZ's representable range and were clamped by the format */
  clamped: { positions: number; colors: number; scales: number; sh: number };
  gaussianCount: number;
  rawBytes: number;
  byteSize: number;
  checksum: string;
}
