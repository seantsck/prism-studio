import { lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalReconstructionError } from "./types";

/**
 * Isolated per-run workspaces for the local engine.
 *
 *   <work root>/
 *     <runId>/
 *       input/    the ordered photographs, materialized as 000001.<ext>, 000002.<ext>, …
 *       colmap/   COLMAP database + sparse models
 *       brush/    Brush's dataset view and training exports
 *       output/   the final SPZ (and the validated PLY it came from)
 *       logs/     bounded tool logs
 *       manifest.json
 *
 * The work root is configured (`PRISM_LOCAL_RECONSTRUCTION_ROOT`, absolute) or a per-user application-data
 * directory. It is never inside the repository (so never under public/, src/ or supabase/). Every path the engine
 * writes is checked to stay inside the run directory, including through symlinks.
 */

export const WORKSPACE_DIRS = ["input", "colmap", "brush", "output", "logs"] as const;
export type WorkspaceDir = (typeof WORKSPACE_DIRS)[number];

export interface Workspace {
  root: string;
  runId: string;
  dir: string;
  paths: Record<WorkspaceDir, string>;
  manifestPath: string;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function defaultWorkRoot(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32" && env.LOCALAPPDATA)
    return path.join(env.LOCALAPPDATA, "PrismStudio", "local-reconstruction");
  if (platform === "darwin" && env.HOME)
    return path.join(env.HOME, "Library", "Caches", "PrismStudio", "local-reconstruction");
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, "prism-studio", "local-reconstruction");
  if (env.HOME) return path.join(env.HOME, ".cache", "prism-studio", "local-reconstruction");
  return path.join(os.tmpdir(), "prism-studio-local-reconstruction");
}

/** True when `child` is `parent` or inside it (both absolute, already resolved). */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The work root: an explicit absolute PRISM_LOCAL_RECONSTRUCTION_ROOT, else the per-user default. Refused when it is
 * relative or inside the repository (`repoRoot`, default the current working directory).
 */
export function resolveWorkRoot(
  env: Record<string, string | undefined> = process.env,
  repoRoot: string = process.cwd(),
): string {
  const configured = env.PRISM_LOCAL_RECONSTRUCTION_ROOT?.trim();
  if (configured && !path.isAbsolute(configured))
    throw new LocalReconstructionError(
      "workspace_failed",
      "PRISM_LOCAL_RECONSTRUCTION_ROOT must be an absolute path.",
    );
  const root = path.resolve(configured || defaultWorkRoot(env));
  if (isWithin(path.resolve(repoRoot), root))
    throw new LocalReconstructionError(
      "workspace_failed",
      "The local reconstruction work root must be outside the Prism repository.",
    );
  return root;
}

export function assertRunId(runId: string) {
  if (!RUN_ID.test(runId))
    throw new LocalReconstructionError(
      "invalid_inputs",
      "A run id must be 1-64 letters, digits, '-' or '_' (starting with a letter or digit).",
    );
}

/** A path inside the workspace; refuses anything that would leave it. */
export function inWorkspace(ws: Workspace, ...segments: string[]): string {
  const p = path.resolve(ws.dir, ...segments);
  if (!isWithin(ws.dir, p) || p === ws.dir)
    throw new LocalReconstructionError("workspace_failed", "A workspace path escaped its run directory.");
  return p;
}

/** Creates a FRESH run directory (an existing one is refused, never reused or merged). */
export async function createWorkspace(root: string, runId: string): Promise<Workspace> {
  assertRunId(runId);
  if (!path.isAbsolute(root))
    throw new LocalReconstructionError("workspace_failed", "The work root must be an absolute path.");
  try {
    await mkdir(root, { recursive: true });
  } catch {
    throw new LocalReconstructionError(
      "workspace_failed",
      "The local reconstruction work root cannot be created.",
    );
  }
  const realRoot = await realpath(root);
  const dir = path.join(realRoot, runId);
  const exists = await lstat(dir).then(
    () => true,
    () => false,
  );
  if (exists)
    throw new LocalReconstructionError("workspace_failed", `A workspace for run "${runId}" already exists.`);
  try {
    await mkdir(dir);
    for (const d of WORKSPACE_DIRS) await mkdir(path.join(dir, d));
  } catch {
    throw new LocalReconstructionError("workspace_failed", "The run workspace could not be created.");
  }
  // the directory we made must really be inside the (real) root: no symlink trickery in between
  if (!isWithin(realRoot, await realpath(dir)))
    throw new LocalReconstructionError(
      "workspace_failed",
      "The run workspace resolved outside the work root.",
    );
  const paths = Object.fromEntries(WORKSPACE_DIRS.map((d) => [d, path.join(dir, d)])) as Record<
    WorkspaceDir,
    string
  >;
  return { root: realRoot, runId, dir, paths, manifestPath: path.join(dir, "manifest.json") };
}

/** Refuses a path inside the workspace that is (or passes through) a symlink leading outside it. */
export async function assertContained(ws: Workspace, p: string) {
  const real = await realpath(p).catch(() => null);
  if (real === null || !isWithin(ws.dir, real))
    throw new LocalReconstructionError(
      "workspace_failed",
      "A workspace path resolved outside its run directory.",
    );
}

/** Total bytes under a directory (symlinks are not followed). */
export async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) total += await directoryBytes(p);
    else if (e.isFile()) total += (await stat(p)).size;
  }
  return total;
}

/**
 * Retention policy:
 *   "all"            remove the whole run directory (tests; a cancelled run once diagnostics are not wanted)
 *   "intermediates"  keep output/, logs/ and manifest.json (a finished run waiting for M2D.3B to ingest it, or a
 *                    failed run whose bounded logs are kept for diagnosis); remove inputs, COLMAP and Brush work
 * Source Prism Assets are never touched: the workspace only ever holds copies.
 */
export async function cleanupWorkspace(ws: Workspace, mode: "all" | "intermediates") {
  if (!isWithin(ws.root, ws.dir) || ws.dir === ws.root) return;
  if (mode === "all") {
    await rm(ws.dir, { recursive: true, force: true, maxRetries: 3 });
    return;
  }
  for (const d of ["input", "colmap", "brush"] as const)
    await rm(ws.paths[d], { recursive: true, force: true, maxRetries: 3 });
}
