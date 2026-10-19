import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { boundedDiagnostic } from "./brush";
import { readSparseModel, selectSparseModel } from "./colmap-model";
import { runProcess, type ProcessResult, type ToolCommand } from "./process";
import { LocalReconstructionError, type CameraReconstructionMetrics } from "./types";

/**
 * COLMAP camera reconstruction for the VERIFIED operator-built COLMAP 4.2.1 (bd1fcf6) only, through its CLI:
 *
 *   feature_extractor   SIFT on the CPU (VLFeat): --FeatureExtraction.use_gpu 0
 *   exhaustive_matcher  CPU matching: --FeatureMatching.use_gpu 0
 *   mapper              incremental SfM (COLMAP's default, most robust pipeline) into colmap/sparse/N
 *   image_undistorter   the chosen model → PINHOLE cameras + undistorted images (Brush ignores lens distortion)
 *
 * Choices (COLMAP 4.2.1 docs): SIMPLE_RADIAL is the documented default camera model and "a good starting point for
 * most standard cameras"; `single_camera` stays false (phone sets may mix lenses and zoom levels); exhaustive
 * matching is recommended "up to several hundreds" of images. Explicit stages are used (not automatic_reconstructor,
 * which can trigger downloads and dense steps) so progress, cancellation and errors are per stage. Nothing here can
 * reach the network: vocab-tree, loop-detection and learned-feature paths are never invoked, and the approved build
 * has downloads compiled out.
 *
 * COLMAP's exit code is not trusted: feature_extractor exits 0 even when it extracted nothing, so every stage's
 * OUTPUT is validated, and the reconstruction must register enough images to be a real place.
 */

/** Fixed, allow-listed settings (recorded in the run manifest). */
export const COLMAP_SETTINGS = {
  cameraModel: "SIMPLE_RADIAL",
  singleCamera: false,
  matching: "exhaustive",
  mapper: "incremental",
  featureGpu: false,
  matchingGpu: false,
  undistortOutput: "COLMAP",
} as const;

/** A reconstruction below these is a failure, never "a room": ≥3 registered images, ≥40 % of inputs, ≥50 points. */
export const MIN_REGISTERED_IMAGES = 3;
export const MIN_REGISTRATION_RATIO = 0.4;
export const MIN_SPARSE_POINTS = 50;

export interface ColmapPaths {
  imageDir: string;
  colmapDir: string;
  /** undistorted output = Brush's dataset (must not exist yet, or be empty) */
  datasetDir: string;
}

export function colmapCommands(p: ColmapPaths, chosenModelDir = "<chosen>") {
  const db = path.join(p.colmapDir, "database.db");
  const sparse = path.join(p.colmapDir, "sparse");
  return {
    db,
    sparse,
    featureExtractor: [
      "feature_extractor",
      "--database_path",
      db,
      "--image_path",
      p.imageDir,
      "--ImageReader.camera_model",
      COLMAP_SETTINGS.cameraModel,
      "--ImageReader.single_camera",
      "0",
      "--FeatureExtraction.use_gpu",
      "0",
    ],
    matcher: ["exhaustive_matcher", "--database_path", db, "--FeatureMatching.use_gpu", "0"],
    mapper: ["mapper", "--database_path", db, "--image_path", p.imageDir, "--output_path", sparse],
    undistorter: [
      "image_undistorter",
      "--image_path",
      p.imageDir,
      "--input_path",
      chosenModelDir,
      "--output_path",
      p.datasetDir,
      "--output_type",
      COLMAP_SETTINGS.undistortOutput,
    ],
  };
}

const OOM = /out of memory|bad_alloc|std::bad_alloc|not enough memory|failed to allocate/i;

function classify(r: ProcessResult, step: string): LocalReconstructionError | null {
  const text = `${r.stderr}\n${r.stdout}`;
  const diag = boundedDiagnostic(text);
  const err = (code: ConstructorParameters<typeof LocalReconstructionError>[0], m: string) =>
    new LocalReconstructionError(code, m, "camera_reconstruction", diag);
  switch (r.outcome) {
    case "spawn_failed":
      return err("toolchain_missing", "COLMAP could not be started.");
    case "timeout":
      return err("timeout", `Camera reconstruction (${step}) took longer than the configured limit.`);
    case "aborted":
      return err("cancelled", "The reconstruction was cancelled.");
  }
  if (r.exitCode === 0) return null;
  if (OOM.test(text)) return err("out_of_memory", `COLMAP ran out of memory during ${step}.`);
  if (step === "mapper" && /Failed to create any sparse model/i.test(text))
    return err(
      "insufficient_camera_registration",
      "COLMAP could not recover camera poses from these photographs (no sparse model). Use more overlapping photos of one place.",
    );
  return err("colmap_failed", `COLMAP ${step} failed (exit code ${r.exitCode ?? "none"}).`);
}

export interface ColmapRunOptions extends ColmapPaths {
  tool: ToolCommand;
  inputImages: number;
  /** remaining time for the whole camera stage */
  timeoutMs: number;
  signal?: AbortSignal;
  onStep?: (step: "feature_extraction" | "matching" | "mapping" | "undistortion") => void;
  onLine?: (line: string) => void;
}

export async function runColmap(o: ColmapRunOptions): Promise<{
  metrics: CameraReconstructionMetrics;
  datasetDir: string;
}> {
  const deadline = Date.now() + o.timeoutMs;
  const cmds = colmapCommands(o);
  const env = {
    ...o.tool.env,
    // the build's DLLs sit next to colmap.exe (what COLMAP.bat would put on PATH; no Qt is needed with GUI off)
    PATH: `${path.dirname(o.tool.executable)}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`,
  };
  const run = async (args: string[], step: string) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new LocalReconstructionError(
        "timeout",
        "Camera reconstruction took longer than the configured limit.",
        "camera_reconstruction",
      );
    const r = await runProcess({
      executable: o.tool.executable,
      args: [...o.tool.prefixArgs, ...args],
      cwd: o.colmapDir,
      env,
      timeoutMs: remaining,
      signal: o.signal,
      onLine: (_s, l) => o.onLine?.(l),
    });
    const f = classify(r, step);
    if (f) throw f;
    return r;
  };
  const fail = (m: string, r?: ProcessResult) =>
    new LocalReconstructionError(
      "colmap_failed",
      m,
      "camera_reconstruction",
      r ? boundedDiagnostic(`${r.stderr}\n${r.stdout}`) : null,
    );

  o.onStep?.("feature_extraction");
  const fx = await run(cmds.featureExtractor, "feature extraction");
  const db = await stat(cmds.db).catch(() => null);
  // feature_extractor exits 0 even when it fails part-way: its database must exist
  if (!db?.isFile() || db.size === 0) throw fail("COLMAP feature extraction produced no database.", fx);

  o.onStep?.("matching");
  await run(cmds.matcher, "matching");

  o.onStep?.("mapping");
  await mkdir(cmds.sparse, { recursive: true }); // mapper requires its output directory to exist
  await run(cmds.mapper, "mapper");
  const { chosen, discovered } = await selectSparseModel(cmds.sparse);
  // every registered image must be one of OUR inputs, each at most once: a model naming other files (or the same
  // file twice) must not count toward the registration thresholds
  const inputNames = new Set((await readdir(o.imageDir)).map((n) => n.toLowerCase()));
  const modelNames = chosen.images.map((i) => i.name.toLowerCase());
  if (new Set(modelNames).size !== modelNames.length || modelNames.some((n) => !inputNames.has(n)))
    throw fail("COLMAP's sparse model refers to images that are not this run's inputs.");
  const registered = chosen.images.length;
  const ratio = o.inputImages > 0 ? registered / o.inputImages : 0;
  const metrics: CameraReconstructionMetrics = {
    inputImages: o.inputImages,
    registeredImages: registered,
    registrationRatio: Math.round(ratio * 1000) / 1000,
    sparsePoints: chosen.points,
    cameraCount: chosen.cameras.length,
    chosenModel: chosen.name,
    modelsDiscovered: discovered.map(({ name, registeredImages, points }) => ({
      name,
      registeredImages,
      points,
    })),
  };
  if (
    registered < MIN_REGISTERED_IMAGES ||
    ratio < MIN_REGISTRATION_RATIO ||
    chosen.points < MIN_SPARSE_POINTS
  )
    throw new LocalReconstructionError(
      "insufficient_camera_registration",
      `Only ${registered} of ${o.inputImages} photographs could be placed (${chosen.points} 3D points). ` +
        "A location needs many overlapping photos of the same place.",
      "camera_reconstruction",
    );

  o.onStep?.("undistortion");
  await mkdir(o.datasetDir, { recursive: true });
  if ((await readdir(o.datasetDir)).length > 0) throw fail("The undistortion output directory is not empty.");
  const un = colmapCommands(o, chosen.dir).undistorter;
  const ur = await run(un, "undistortion");
  // the undistorted model must be PINHOLE and hold exactly the registered images, all present on disk
  const undist = await readSparseModel(path.join(o.datasetDir, "sparse")).catch((e: Error) => {
    throw fail(`COLMAP undistortion produced no readable model (${e.message.slice(0, 80)}).`, ur);
  });
  if (undist.cameras.some((c) => c.model !== "PINHOLE"))
    throw fail("COLMAP undistortion did not produce PINHOLE cameras.", ur);
  if (undist.images.length !== registered) throw fail("The undistorted model lost registered images.", ur);
  const present = new Set(
    (await readdir(path.join(o.datasetDir, "images")).catch(() => [])).map((n) => n.toLowerCase()),
  );
  if (undist.images.some((i) => !present.has(i.name.toLowerCase())))
    throw fail("COLMAP undistortion did not write every registered image.", ur);
  return { metrics, datasetDir: o.datasetDir };
}
