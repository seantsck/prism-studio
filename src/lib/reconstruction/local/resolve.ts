import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./process";

/**
 * Locating operator-installed tools and reading their versions, without ever running something the operator did not
 * point at:
 *
 *   - an explicit path (PRISM_COLMAP_PATH, PRISM_BRUSH_PATH) must be ABSOLUTE and an existing FILE;
 *   - otherwise PATH is searched, but only its ABSOLUTE entries: a relative entry (".", "bin", empty) is skipped, so
 *     a similarly named binary in the current working directory is never picked up;
 *   - on Windows only `.exe` is accepted: Prism starts tools without a shell, and a `.bat` / `.cmd` launcher (such
 *     as the official COLMAP.bat) cannot be started that way;
 *   - the result is the real path (symlinks resolved).
 * Nothing is downloaded or installed, ever.
 */

export type Resolution =
  | { status: "found"; path: string; source: "configured" | "path" }
  | { status: "missing"; reason: string }
  | { status: "invalid"; reason: string };

export async function resolveExecutable(opts: {
  configured: string | undefined;
  envVar: string;
  /** base names to look for on PATH, without extension (e.g. "colmap") */
  names: string[];
  pathEnv: string | undefined;
  platform?: NodeJS.Platform;
}): Promise<Resolution> {
  const platform = opts.platform ?? process.platform;
  const sep = platform === "win32" ? ";" : ":";
  const isAbs = platform === "win32" ? path.win32.isAbsolute : path.posix.isAbsolute;
  const okExt = (p: string) => platform !== "win32" || p.toLowerCase().endsWith(".exe");
  const configured = opts.configured?.trim();
  if (configured) {
    if (!isAbs(configured)) return { status: "invalid", reason: `${opts.envVar} must be an absolute path.` };
    if (!okExt(configured))
      return {
        status: "invalid",
        reason: `${opts.envVar} must point at the program itself (.exe), not a script or launcher.`,
      };
    const s = await stat(configured).catch(() => null);
    if (!s || !s.isFile()) return { status: "invalid", reason: `${opts.envVar} does not point at a file.` };
    return { status: "found", path: await realpath(configured), source: "configured" };
  }
  const exts = platform === "win32" ? [".exe"] : [""];
  for (const dir of (opts.pathEnv ?? "").split(sep)) {
    if (!dir || !isAbs(dir)) continue;
    for (const name of opts.names)
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        const s = await stat(candidate).catch(() => null);
        if (s?.isFile()) return { status: "found", path: await realpath(candidate), source: "path" };
      }
  }
  return { status: "missing", reason: `Not configured (${opts.envVar}) and not found on PATH.` };
}

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  text: string;
}

/** The LAST x.y.z in a version line (tool names may contain digits). */
export function parseSemver(text: string): SemVer | null {
  const all = [...text.matchAll(/(\d+)\.(\d+)\.(\d+)/g)];
  const m = all.at(-1);
  return m ? { major: +m[1]!, minor: +m[2]!, patch: +m[3]!, text: m[0] } : null;
}

/** Runs `<tool> <args>` with a short timeout and returns its combined output (bounded). Never throws. */
export async function probeOutput(
  executable: string,
  prefixArgs: readonly string[],
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<{ ok: boolean; text: string; reason: string | null }> {
  const r = await runProcess({
    executable,
    args: [...prefixArgs, ...args],
    cwd: path.dirname(executable),
    env,
    timeoutMs,
    maxOutputBytes: 16 * 1024,
  });
  const text = `${r.stdout}\n${r.stderr}`.trim().slice(0, 2000);
  if (r.outcome === "timeout") return { ok: false, text, reason: "The version probe timed out." };
  if (r.outcome !== "exited") return { ok: false, text, reason: "The program could not be started." };
  if (r.exitCode !== 0)
    return { ok: false, text, reason: `The version probe exited with code ${r.exitCode}.` };
  return { ok: true, text, reason: null };
}

/**
 * Whether a Vulkan loader is installed (Brush's only GPU backend on Windows and Linux). This proves the loader
 * exists, NOT that a capable device is present: that is only known when Brush starts (no adapter → gpu_unavailable).
 */
export async function vulkanLoaderPresent(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean | null> {
  const candidates =
    platform === "win32"
      ? [path.join(env.SystemRoot ?? "C:\\Windows", "System32", "vulkan-1.dll")]
      : platform === "linux"
        ? ["/usr/lib/x86_64-linux-gnu/libvulkan.so.1", "/usr/lib/libvulkan.so.1", "/usr/lib64/libvulkan.so.1"]
        : [];
  if (candidates.length === 0) return null;
  for (const c of candidates) if ((await stat(c).catch(() => null))?.isFile()) return true;
  return false;
}
