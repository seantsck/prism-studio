import os from "node:os";
import path from "node:path";
import { LocalReconstructionError } from "./types";

/**
 * Where local reconstruction runs (the work root): path arithmetic only, no filesystem access. Kept apart from the
 * workspace module so the Prism SERVER can locate the worker's heartbeat without bundling any of the engine's
 * filesystem code. (`turbopackIgnore`: these paths are runtime configuration, never build inputs to trace.)
 */

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
  const root = path.resolve(/*turbopackIgnore: true*/ configured || defaultWorkRoot(env));
  if (isWithin(path.resolve(/*turbopackIgnore: true*/ repoRoot), root))
    throw new LocalReconstructionError(
      "workspace_failed",
      "The local reconstruction work root must be outside the Prism repository.",
    );
  return root;
}
