import { appendFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectSplat } from "@/lib/splat/inspect";
import { BRUSH_PROFILES, brushSettings, runBrush } from "./brush";
import { COLMAP_SETTINGS, runColmap } from "./colmap";
import { materializeInputs, sha256File, type InputLimits, type MaterializedInput } from "./inputs";
import { inspectGaussianPlyFile } from "./ply";
import type { ToolCommand } from "./process";
import { convertPlyToSpz, DEFAULT_MAX_RAW_BYTES, SPZ_ENCODER } from "./spz";
import {
  LOCAL_RUN_SCHEMA,
  LocalReconstructionError,
  progressAtStageStart,
  STAGE_WEIGHTS,
  type LocalReconstructionProgress,
  type LocalReconstructionRequest,
  type LocalReconstructionResult,
  type LocalRunMetadata,
  type LocalStage,
} from "./types";
import { cleanupWorkspace, createWorkspace, directoryBytes, inWorkspace, type Workspace } from "./workspace";

/**
 * runLocalReconstruction: ordered photographs → COLMAP → Brush → validated PLY → SPZ → validated SPZ.
 *
 * No database, storage, network or server action is touched: this is the engine M2D.3B's worker will call. It
 * writes only inside its own run workspace, and returns paths, checksums and provenance.
 *
 * Retention: success keeps output/ (the SPZ and the PLY it came from), logs/ and manifest.json for ingestion and
 * removes the intermediates; a failure keeps the bounded logs and a failure manifest; a cancellation removes the
 * intermediates and any partial output. `retention: "none"` (tests) removes the whole run directory in every case.
 * Source Assets are never touched: the workspace only holds copies.
 */

export interface LocalEngineLimits extends InputLimits {
  maxRunMs: number;
  maxCameraStageMs: number;
  maxTrainingMs: number;
  maxWorkspaceBytes: number;
  maxRawSpzBytes: number;
}

export const DEFAULT_ENGINE_LIMITS: LocalEngineLimits = {
  minImages: 3,
  maxImages: 300,
  maxImageBytes: 64 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxRunMs: 4 * 60 * 60 * 1000,
  maxCameraStageMs: 2 * 60 * 60 * 1000,
  maxTrainingMs: 3 * 60 * 60 * 1000,
  maxWorkspaceBytes: 40 * 1024 * 1024 * 1024,
  maxRawSpzBytes: DEFAULT_MAX_RAW_BYTES,
};

/** Reads the configurable guards (falls back to the defaults on anything invalid). */
export function readEngineLimits(env: Record<string, string | undefined> = process.env): LocalEngineLimits {
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  const d = DEFAULT_ENGINE_LIMITS;
  return {
    ...d,
    maxImages: Math.min(300, n("PRISM_LOCAL_RECONSTRUCTION_MAX_IMAGES", d.maxImages)),
    maxTotalBytes: n("PRISM_LOCAL_RECONSTRUCTION_MAX_INPUT_BYTES", d.maxTotalBytes),
    maxRunMs: n("PRISM_LOCAL_RECONSTRUCTION_MAX_RUN_MS", d.maxRunMs),
    maxWorkspaceBytes: n("PRISM_LOCAL_RECONSTRUCTION_MAX_WORKSPACE_BYTES", d.maxWorkspaceBytes),
  };
}

export interface ToolchainForRun {
  colmap: ToolCommand;
  brush: ToolCommand;
  versions: { colmap: string; brush: string };
}

export interface RunOptions {
  toolchain: ToolchainForRun;
  workRoot: string;
  limits?: LocalEngineLimits;
  onProgress?: (p: LocalReconstructionProgress) => void;
  signal?: AbortSignal;
  retention?: "default" | "none";
  now?: () => string;
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** Bounded run log: stage, timestamp, tool, one safe line each; stops writing beyond the cap. */
class RunLog {
  private bytes = 0;
  private dropped = 0;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly now: () => string,
  ) {}
  write(stage: LocalStage, tool: string, line: string) {
    const entry = `${this.now()}\t${stage}\t${tool}\t${line.replace(/[\r\n\t]+/g, " ").slice(0, 500)}\n`;
    if (this.bytes + entry.length > MAX_LOG_BYTES) {
      this.dropped++;
      return;
    }
    this.bytes += entry.length;
    this.queue = this.queue.then(() => appendFile(this.file, entry)).catch(() => undefined);
  }
  async flush() {
    if (this.dropped) {
      const note = `${this.now()}\t-\tprism\t(${this.dropped} further log lines dropped at the ${MAX_LOG_BYTES} byte cap)\n`;
      this.queue = this.queue.then(() => appendFile(this.file, note)).catch(() => undefined);
    }
    await this.queue;
  }
}

const cancelled = (stage: LocalStage) =>
  new LocalReconstructionError("cancelled", "The reconstruction was cancelled.", stage);

export async function runLocalReconstruction(
  request: LocalReconstructionRequest,
  opts: RunOptions,
): Promise<LocalReconstructionResult> {
  const limits = opts.limits ?? DEFAULT_ENGINE_LIMITS;
  const now = opts.now ?? (() => new Date().toISOString());
  const started = Date.now();
  const deadline = started + limits.maxRunMs;
  const remaining = (cap: number) => Math.min(cap, deadline - Date.now());
  const brushProfile = brushSettings(request.quality); // refuses an undefined profile before any work
  if (opts.signal?.aborted) throw cancelled("preparing");

  let stage: LocalStage = "preparing";
  const enter = (s: LocalStage, message: string) => {
    stage = s;
    opts.onProgress?.({ stage: s, progress: progressAtStageStart(s), message });
  };
  const ws: Workspace = await createWorkspace(opts.workRoot, request.runId);
  const log = new RunLog(path.join(ws.paths.logs, "run.log"), now);
  const startedAt = now();
  const checkDisk = async () => {
    if ((await directoryBytes(ws.dir)) > limits.maxWorkspaceBytes)
      throw new LocalReconstructionError(
        "workspace_failed",
        `The run workspace exceeded its ${limits.maxWorkspaceBytes} byte limit.`,
        stage,
      );
  };
  const guard = () => {
    if (opts.signal?.aborted) throw cancelled(stage);
    if (Date.now() > deadline)
      throw new LocalReconstructionError(
        "timeout",
        "The reconstruction exceeded its total time limit.",
        stage,
      );
  };
  let inputs: MaterializedInput[] = [];
  try {
    // ── preparing ──
    enter("preparing", "Copying photographs into the run workspace");
    inputs = await materializeInputs(ws, request.inputs, limits, opts.signal);
    log.write("preparing", "prism", `${inputs.length} photographs materialized`);
    guard();

    // ── camera reconstruction (COLMAP) ──
    enter("camera_reconstruction", "Recovering camera positions (COLMAP)");
    const datasetDir = inWorkspace(ws, "brush", "dataset");
    const camera = await runColmap({
      tool: opts.toolchain.colmap,
      imageDir: ws.paths.input,
      colmapDir: ws.paths.colmap,
      datasetDir,
      inputImages: inputs.length,
      timeoutMs: remaining(limits.maxCameraStageMs),
      signal: opts.signal,
      onStep: (s) => log.write("camera_reconstruction", "colmap", `step ${s}`),
      onLine: (l) => log.write("camera_reconstruction", "colmap", l),
    });
    log.write(
      "camera_reconstruction",
      "prism",
      `registered ${camera.metrics.registeredImages}/${camera.metrics.inputImages}, ${camera.metrics.sparsePoints} points, model ${camera.metrics.chosenModel}`,
    );
    await checkDisk();
    guard();

    // ── splat training (Brush) ──
    enter("splat_training", "Training the Gaussian splat (Brush)");
    const trainStart = progressAtStageStart("splat_training");
    const { plyPath: exported } = await runBrush({
      tool: opts.toolchain.brush,
      datasetDir: camera.datasetDir,
      exportDir: inWorkspace(ws, "brush", "exports"),
      quality: request.quality,
      timeoutMs: remaining(limits.maxTrainingMs),
      signal: opts.signal,
      onLine: (l) => log.write("splat_training", "brush", l),
      // an exact iteration count from Brush's own log, so this in-stage figure is not invented
      onIteration: (it, total) =>
        opts.onProgress?.({
          stage: "splat_training",
          progress: Math.round((trainStart + STAGE_WEIGHTS.splat_training * (it / total)) * 100) / 100,
          message: `Training the Gaussian splat (iteration ${it} of ${total})`,
        }),
    });
    await checkDisk();
    guard();

    // ── validate the raw PLY ──
    enter("validating_ply", "Validating the trained splat");
    const plyPath = inWorkspace(ws, "output", "splat.ply");
    await rename(exported, plyPath);
    const ply = await inspectGaussianPlyFile(plyPath, { signal: opts.signal });
    const plyChecksum = await sha256File(plyPath);
    guard();

    // ── convert ──
    enter("converting_spz", "Compressing to SPZ");
    const spzPath = inWorkspace(ws, "output", "splat.spz");
    const { report } = await convertPlyToSpz({
      plyPath,
      spzPath,
      antialiased: false, // Brush v0.3.0 trains standard (not mip/anti-aliased) 3DGS
      maxRawBytes: limits.maxRawSpzBytes,
      signal: opts.signal,
    });
    guard();

    // ── validate the SPZ (again, from disk, with the M2D.1 validator) ──
    enter("validating_spz", "Validating the SPZ");
    const spzBytes = await readFile(spzPath);
    const inspected = inspectSplat(spzBytes, "splat.spz");
    if (!inspected.ok || inspected.gaussianCount !== ply.vertexCount)
      throw new LocalReconstructionError(
        "spz_invalid",
        `The SPZ did not validate: ${inspected.ok ? "Gaussian count differs" : inspected.error}`,
        "validating_spz",
      );
    // cancellation that won the race is never reported as success
    guard();

    const metadata: LocalRunMetadata = {
      schema: LOCAL_RUN_SCHEMA,
      quality: request.quality,
      tools: {
        colmap: opts.toolchain.versions.colmap,
        brush: opts.toolchain.versions.brush,
        spzEncoder: SPZ_ENCODER,
      },
      colmap: { settings: { ...COLMAP_SETTINGS }, metrics: camera.metrics },
      brush: { settings: { ...brushProfile } },
      ply: {
        gaussianCount: ply.vertexCount,
        shDegree: ply.shDegree,
        byteSize: ply.fileBytes,
        checksum: plyChecksum,
      },
      spz: report,
    };
    await writeManifest(ws, {
      status: "succeeded",
      runId: request.runId,
      startedAt,
      finishedAt: now(),
      inputs,
      metadata,
      outputs: { ply: "output/splat.ply", spz: "output/splat.spz" },
    });
    enter("complete", "Reconstruction complete");
    opts.onProgress?.({ stage: "complete", progress: 1, message: "Reconstruction complete" });
    await log.flush();
    if (opts.retention === "none") await cleanupWorkspace(ws, "all");
    else await cleanupWorkspace(ws, "intermediates");
    return {
      runId: request.runId,
      plyPath,
      spzPath,
      format: "spz",
      gaussianCount: report.gaussianCount,
      byteSize: report.byteSize,
      checksum: report.checksum,
      manifestPath: ws.manifestPath,
      metadata,
    };
  } catch (e) {
    const err =
      e instanceof LocalReconstructionError
        ? e
        : new LocalReconstructionError(
            "workspace_failed",
            `Unexpected failure: ${(e as Error).message.slice(0, 200)}`,
            stage,
          );
    log.write(err.stage ?? stage, "prism", `failed: ${err.code}: ${err.message}`);
    await log.flush();
    if (opts.retention === "none") await cleanupWorkspace(ws, "all").catch(() => undefined);
    else {
      await writeManifest(ws, {
        status: err.code === "cancelled" ? "cancelled" : "failed",
        runId: request.runId,
        startedAt,
        finishedAt: now(),
        inputs,
        error: { code: err.code, stage: err.stage ?? stage, message: err.message },
      }).catch(() => undefined);
      await cleanupWorkspace(ws, "intermediates").catch(() => undefined);
      // a cancelled or failed run leaves no partial result behind
      await rm(ws.paths.output, { recursive: true, force: true }).catch(() => undefined);
    }
    throw err;
  }
}

/** The local execution provenance: non-secret, relative names only (no source paths, no URLs, no keys). */
async function writeManifest(
  ws: Workspace,
  m: {
    status: "succeeded" | "failed" | "cancelled";
    runId: string;
    startedAt: string;
    finishedAt: string;
    inputs: MaterializedInput[];
    metadata?: LocalRunMetadata;
    outputs?: Record<string, string>;
    error?: { code: string; stage: string; message: string };
  },
) {
  const body = {
    schema: LOCAL_RUN_SCHEMA,
    status: m.status,
    runId: m.runId,
    startedAt: m.startedAt,
    finishedAt: m.finishedAt,
    inputs: m.inputs.map((i) => ({
      ordinal: i.ordinal,
      fileName: i.fileName,
      mime: i.mime,
      byteSize: i.byteSize,
      checksum: i.checksum,
    })),
    ...(m.metadata ? { metadata: m.metadata } : {}),
    ...(m.outputs ? { outputs: m.outputs } : {}),
    ...(m.error ? { error: m.error } : {}),
  };
  await writeFile(ws.manifestPath, `${JSON.stringify(body, null, 2)}\n`);
}

/** The profiles the engine accepts today (only those with validated Brush settings). */
export const AVAILABLE_QUALITY_PROFILES = Object.keys(BRUSH_PROFILES);
