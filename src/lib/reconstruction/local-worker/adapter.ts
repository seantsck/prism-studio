import { randomBytes } from "node:crypto";
import type { JobErrorCode, ReconstructionJobRecord } from "@/domain/reconstruction/job";
import { assertRunId } from "../local/workspace";
import {
  LocalReconstructionError,
  SUPPORTED_INPUT_MIMES,
  type LocalErrorCode,
  type LocalReconstructionRequest,
  type LocalRunMetadata,
  type QualityProfile,
} from "../local/types";

/**
 * The narrow adapter between a reconstruction JOB (M2D.2 domain) and the M2D.3A local ENGINE (database-free). The
 * engine never sees a job row, a repository or a storage provider; the worker never builds tool arguments.
 */

/** M2D.3B runs the one validated profile; nothing a browser sends can change tool arguments. */
export const LOCAL_QUALITY: QualityProfile = "standard";

export const STOPPED_MESSAGE =
  "Local reconstruction worker stopped before the run completed. Retry creates a new attempt.";

const OPERATION_PREFIX = "local:";

/** A fresh opaque run id for one claim of one job attempt (also the workspace directory name). */
export function newRunId(job: Pick<ReconstructionJobRecord, "id" | "attempt">): string {
  const id = `lr-${job.id.replace(/[^0-9a-f]/gi, "").slice(0, 12)}-a${job.attempt}-${randomBytes(4).toString("hex")}`;
  assertRunId(id);
  return id;
}

/** `local:<run id>`: stable for the attempt, well under the 200-character column, no path, no secret. */
export const operationIdFor = (runId: string) => `${OPERATION_PREFIX}${runId}`;

/** The run id a job's operation id names, or null when it is not a local run id. */
export function runIdOf(job: Pick<ReconstructionJobRecord, "providerOperationId">): string | null {
  const op = job.providerOperationId;
  if (!op?.startsWith(OPERATION_PREFIX)) return null;
  const runId = op.slice(OPERATION_PREFIX.length);
  try {
    assertRunId(runId);
    return runId;
  } catch {
    return null;
  }
}

/** Why the job's frozen input list cannot run locally, or null. (The Assets themselves are checked by the worker.) */
export function sourceListProblem(
  job: Pick<ReconstructionJobRecord, "sources">,
  limits: { minImages: number; maxImages: number },
): string | null {
  const n = job.sources.length;
  if (n < limits.minImages || n > limits.maxImages)
    return `Local capture needs ${limits.minImages}-${limits.maxImages} photographs (this job has ${n}).`;
  for (const [i, s] of job.sources.entries()) {
    if (s.ordinal !== i) return "The photographs are not in a valid order.";
    if (s.kind !== "image") return "Local capture accepts photographs only (no video yet).";
    if (!s.mime || !(s.mime in SUPPORTED_INPUT_MIMES))
      return "Local capture accepts JPEG or PNG photographs only.";
    if (!s.checksum || !/^[0-9a-f]{64}$/.test(s.checksum))
      return "A photograph has no recorded checksum, so its content cannot be verified.";
  }
  return null;
}

/** The engine request for staged (already verified) files, in the job's order. */
export function toEngineRequest(
  runId: string,
  staged: Array<{ ordinal: number; path: string; checksum: string; mime: string }>,
): LocalReconstructionRequest {
  return {
    runId,
    quality: LOCAL_QUALITY,
    inputs: staged.map((s) => ({
      ordinal: s.ordinal,
      source: { kind: "file", path: s.path },
      checksum: s.checksum,
      mime: s.mime,
    })),
  };
}

/** The nearest truthful job error code for an engine failure (no new database enum is needed). */
const JOB_CODE: Record<LocalErrorCode, JobErrorCode> = {
  toolchain_missing: "capability_unavailable",
  unsupported_version: "capability_unavailable",
  gpu_unavailable: "capability_unavailable",
  invalid_inputs: "invalid_sources",
  workspace_failed: "provider_failed",
  colmap_failed: "provider_failed",
  insufficient_camera_registration: "provider_failed",
  brush_failed: "provider_failed",
  out_of_memory: "provider_failed",
  cancelled: "cancelled",
  timeout: "provider_timeout",
  ply_missing: "result_missing",
  ply_invalid: "result_invalid",
  spz_conversion_failed: "result_invalid",
  spz_invalid: "result_invalid",
  result_too_large: "result_too_large",
};

export function jobFailureFor(err: LocalReconstructionError): {
  code: JobErrorCode;
  message: string;
  detail: { localCode: LocalErrorCode; stage: string | null };
} {
  return {
    code: JOB_CODE[err.code],
    // engine messages are user language and path-free; tool diagnostics stay in the local run log only
    message: err.message,
    detail: { localCode: err.code, stage: err.stage },
  };
}

/** The tools that will run, as recorded on the job (provenance, and the identity a resumed import must match). */
export interface RecordedTools {
  colmap: { version: string; sourceCommit: string; binarySha256: string };
  brush: { version: string };
  spzEncoder: string;
}

/**
 * Generated-reconstruction provenance: safe local facts only. Never a workspace or home path, a username, raw tool
 * output, or a database credential.
 */
export function localProvenance(
  metadata: LocalRunMetadata,
  tools: RecordedTools,
  ids: { workerId: string; runId: string },
): Record<string, unknown> {
  const m = metadata.colmap.metrics;
  return {
    engine: "prism-local-reconstruction",
    runner: "local_worker",
    quality: metadata.quality,
    colmap: tools.colmap,
    brush: tools.brush,
    spzEncoder: metadata.tools.spzEncoder,
    inputImages: m.inputImages,
    registeredImages: m.registeredImages,
    registrationRatio: m.registrationRatio,
    sparsePoints: m.sparsePoints,
    shDegree: metadata.spz.shDegreeOut,
    spzVersion: metadata.spz.spzVersion,
    // SPZ is quantized compression, never lossless; values the format clamped are counted
    lossless: false,
    clamped: metadata.spz.clamped,
    workerId: ids.workerId,
    runId: ids.runId,
  };
}
