import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { runProcess, type ProcessResult, type ToolCommand } from "./process";
import { LocalReconstructionError, type QualityProfile } from "./types";

/**
 * Brush Gaussian-splat training (ArthurBrussee/brush v0.3.0 @ 3edecbb, Apache-2.0), CLI contract audited from
 * `crates/brush-cli/src/lib.rs`, `brush-train`, `brush-dataset`, `brush-process` and `brush-serde` at that tag:
 *
 *   brush_app <DATASET_DIR> --total-steps N --max-splats N --sh-degree N --seed N
 *             --export-every N --export-path <ABS DIR> --export-name <NAME_{iter}.ply>
 *
 *   - headless: `--with-viewer` defaults to false once a source path is given (never passed)
 *   - the source must be a LOCAL directory (Brush also accepts URLs; Prism never passes one)
 *   - Brush scans the dataset tree recursively: it takes the FIRST cameras.bin it finds, uses any single .ply (or
 *     init.ply) as its initial point cloud, and asserts on case-colliding paths. So the dataset is checked to hold
 *     exactly one model, an images/ folder and no .ply, and exports go OUTSIDE it.
 *   - Brush ignores lens distortion: the dataset MUST be COLMAP's undistorted (PINHOLE) output.
 *   - Exit code 0 is not trusted: a failed export is only a warning in Brush. The expected PLY must exist and pass
 *     production PLY validation afterwards.
 *   - `{iter}` in the export name is zero-padded to the digit count of total steps; exporting every `total` steps
 *     yields exactly one file, `…_<total>.ply`.
 *   - No GPU adapter (Vulkan on Windows) panics with exit code 101.
 */

export const SUPPORTED_BRUSH = { major: 0, minor: 3 } as const;

/** Fixed, allow-listed training settings. Only `standard` is defined until other profiles are validated. */
export const BRUSH_PROFILES: Partial<Record<QualityProfile, Readonly<Record<string, number>>>> = {
  standard: {
    // Brush's documented default schedule
    "total-steps": 30_000,
    // Brush's default cap is 10 M; Prism caps lower so the SPZ can fit the 50 MB splat limit (≈65 B/Gaussian raw)
    "max-splats": 1_000_000,
    "sh-degree": 3,
    seed: 42,
  },
};

/**
 * REAL_SMOKE acceptance only (M2D.3D1): a tiny training run that proves Brush launches, initialises Vulkan and writes a
 * valid PLY on this machine. Brush v0.3.0 has no device probe that does not train, so the smallest training run IS the
 * GPU smoke test. It is NOT a quality profile: no job, worker or agent can select it, and its result is never a
 * production reconstruction.
 */
export const ACCEPTANCE_SMOKE_BRUSH: Readonly<Record<string, number>> = {
  "total-steps": 500,
  "max-splats": 100_000,
  "sh-degree": 3,
  seed: 42,
};

export function brushSettings(quality: QualityProfile): Readonly<Record<string, number>> {
  const s = BRUSH_PROFILES[quality];
  if (!s)
    throw new LocalReconstructionError(
      "invalid_inputs",
      `The "${quality}" quality profile is not available yet; use "standard".`,
      "splat_training",
    );
  return s;
}

export const EXPORT_PREFIX = "prism_export_";

/** The argv for one training run (no free-form option ever reaches Brush). */
export function brushArgs(
  datasetDir: string,
  exportDir: string,
  quality: QualityProfile,
  settings: Readonly<Record<string, number>> = brushSettings(quality),
): string[] {
  if (!path.isAbsolute(datasetDir) || !path.isAbsolute(exportDir))
    throw new LocalReconstructionError("workspace_failed", "Brush paths must be absolute.", "splat_training");
  const s = settings;
  const total = s["total-steps"]!;
  return [
    datasetDir,
    "--total-steps",
    String(total),
    "--max-splats",
    String(s["max-splats"]),
    "--sh-degree",
    String(s["sh-degree"]),
    "--seed",
    String(s.seed),
    "--export-every",
    String(total),
    "--export-path",
    exportDir,
    "--export-name",
    `${EXPORT_PREFIX}{iter}.ply`,
  ];
}

/** The PLY Brush writes at the final step. */
export const expectedExportName = (
  quality: QualityProfile,
  settings: Readonly<Record<string, number>> = brushSettings(quality),
) => `${EXPORT_PREFIX}${settings["total-steps"]}.ply`;

/** Checks the dataset directory before Brush sees it (Brush's discovery would otherwise guess). */
export async function verifyBrushDataset(datasetDir: string): Promise<{ images: number }> {
  const files: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 6) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink())
        throw new LocalReconstructionError(
          "workspace_failed",
          "The Brush dataset contains a link.",
          "splat_training",
        );
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) files.push(path.relative(datasetDir, p));
    }
  };
  await walk(datasetDir, 0);
  const lower = files.map((f) => f.toLowerCase());
  const fail = (m: string) => new LocalReconstructionError("brush_failed", m, "splat_training");
  if (new Set(lower).size !== lower.length)
    throw fail("The Brush dataset has paths that differ only by case.");
  const count = (suffix: string) => lower.filter((f) => f.endsWith(suffix)).length;
  if (count("cameras.bin") !== 1 || count("images.bin") !== 1)
    throw fail("The Brush dataset must contain exactly one COLMAP model.");
  if (count("cameras.txt") + count("images.txt") > 0)
    throw fail("The Brush dataset contains a second (text) model.");
  if (lower.some((f) => f.endsWith(".ply")))
    throw fail("The Brush dataset contains a .ply file, which Brush would use instead of COLMAP's points.");
  if (lower.some((f) => f.endsWith("transforms.json")))
    throw fail("The Brush dataset contains a transforms.json.");
  const images = lower.filter((f) => f.startsWith(`images${path.sep}`) && /\.(jpe?g|png)$/.test(f)).length;
  if (images === 0) throw fail("The Brush dataset has no images/ folder with photographs.");
  return { images };
}

const OOM =
  /out of memory|outofmemory|not enough memory|failed to allocate|allocation failed|memory allocation/i;
const NO_ADAPTER =
  /no possible adapter|no suitable adapter|no adapter|failed to find.*adapter|vulkan.*(not|unavailable)/i;

/** Maps a finished Brush process to a normalized failure (or null when it exited cleanly). */
export function classifyBrushExit(r: ProcessResult): LocalReconstructionError | null {
  const text = `${r.stderr}\n${r.stdout}`;
  const diag = boundedDiagnostic(text);
  const err = (code: ConstructorParameters<typeof LocalReconstructionError>[0], message: string) =>
    new LocalReconstructionError(code, message, "splat_training", diag);
  switch (r.outcome) {
    case "spawn_failed":
      return err("toolchain_missing", "Brush could not be started.");
    case "timeout":
      return err("timeout", "Splat training took longer than the configured limit.");
    case "aborted":
      return err("cancelled", "The reconstruction was cancelled.");
  }
  if (r.exitCode === 0) return null;
  if (NO_ADAPTER.test(text))
    return err("gpu_unavailable", "Brush found no usable GPU (a Vulkan-capable GPU is required).");
  if (OOM.test(text)) return err("out_of_memory", "Splat training ran out of memory.");
  return err("brush_failed", `Brush failed (exit code ${r.exitCode ?? "none"}).`);
}

/** The last few output lines, bounded, with absolute paths and user names redacted. */
export function boundedDiagnostic(text: string, maxLines = 12, maxChars = 1200): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-maxLines)
    .map((l) =>
      l
        .replace(/[A-Za-z]:\\[^\s"']*/g, "[path]")
        .replace(/(?:\/[^\s"'/]+){2,}/g, "[path]")
        .slice(0, 300),
    );
  return lines.join("\n").slice(-maxChars);
}

/** Parses Brush's "Refine iter N" log lines (RUST_LOG=info) into an exact training iteration. */
export function brushIteration(line: string): number | null {
  const m = /\b(?:Refine|Eval) iter (\d+)/.exec(line);
  return m ? Number(m[1]) : null;
}

export interface BrushRunOptions {
  tool: ToolCommand;
  datasetDir: string;
  exportDir: string;
  quality: QualityProfile;
  /** REAL_SMOKE acceptance only: ACCEPTANCE_SMOKE_BRUSH instead of the quality profile's settings */
  settings?: Readonly<Record<string, number>>;
  timeoutMs: number;
  signal?: AbortSignal;
  onIteration?: (iter: number, total: number) => void;
  onLine?: (line: string) => void;
}

/** Runs Brush and returns the validated-to-exist PLY path. Throws a normalized LocalReconstructionError. */
export async function runBrush(o: BrushRunOptions): Promise<{ plyPath: string; result: ProcessResult }> {
  await verifyBrushDataset(o.datasetDir);
  // the export directory is Brush's working directory, so it must exist before the process starts
  await mkdir(o.exportDir, { recursive: true });
  const settings = o.settings ?? brushSettings(o.quality);
  const total = settings["total-steps"]!;
  const result = await runProcess({
    executable: o.tool.executable,
    args: [...o.tool.prefixArgs, ...brushArgs(o.datasetDir, o.exportDir, o.quality, settings)],
    cwd: o.exportDir,
    // info-level logs carry the refine/eval iteration lines; nothing else is configured
    env: { ...o.tool.env, RUST_LOG: "info" },
    timeoutMs: o.timeoutMs,
    signal: o.signal,
    onLine: (_s, line) => {
      o.onLine?.(line);
      const it = brushIteration(line);
      if (it !== null) o.onIteration?.(Math.min(it, total), total);
    },
  });
  const failure = classifyBrushExit(result);
  if (failure) throw failure;
  const plyPath = path.join(o.exportDir, expectedExportName(o.quality, settings));
  const s = await stat(plyPath).catch(() => null);
  if (!s || !s.isFile() || s.size === 0)
    throw new LocalReconstructionError(
      "ply_missing",
      "Brush finished but did not write the expected Gaussian PLY.",
      "splat_training",
      boundedDiagnostic(`${result.stderr}\n${result.stdout}`),
    );
  return { plyPath, result };
}
