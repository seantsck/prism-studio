import { UNVERIFIED_MESSAGE } from "../local/policy";
import { resolveWorkRoot } from "../local/work-root";
import {
  TOOLCHAIN_LABEL,
  type LocalRuntimeView,
  type LocalToolchain,
  type LocalToolchainState,
  type LocalToolchainStatus,
} from "../local-capture";
import { readHeartbeat } from "./runtime";

/**
 * The Prism SERVER's view of local execution (M2D.3B), used by the `local_capture` provider's status. It only READS
 * the worker's heartbeat file in the work root: it never probes tools, spawns processes, or starts the worker (page
 * loads never start local compute). Local Capture is available only when BOTH:
 *
 *   A. the worker's M2D.3A toolchain probe says ready (verified COLMAP build, supported Brush, Vulkan loader), and
 *   B. that worker's heartbeat is fresh and comes from THIS work root.
 *
 * Same-host only: the server and the worker share one machine, one work root and one persistence configuration.
 */

export const WORKER_ENABLED_ENV = "PRISM_LOCAL_RECONSTRUCTION_WORKER_ENABLED";

export const isLocalWorkerEnabled = (env: Record<string, string | undefined>) =>
  ["1", "true"].includes((env[WORKER_ENABLED_ENV] ?? "").trim().toLowerCase());

const NOT_READY: Record<Exclude<LocalToolchainState, "ready">, string> = {
  colmap_missing: "COLMAP is not installed for Local Capture (PRISM_COLMAP_PATH).",
  colmap_unverified: UNVERIFIED_MESSAGE,
  colmap_incompatible: "This COLMAP build is not the supported Prism-verified COLMAP 4.2.1 build.",
  brush_missing: "Brush is not installed for Local Capture (PRISM_BRUSH_PATH).",
  brush_incompatible: "This Brush version is not supported (Prism Local Capture supports Brush 0.3.x).",
  gpu_unavailable: "No usable GPU: Brush needs a Vulkan-capable GPU and driver.",
};

const view = (
  worker: LocalRuntimeView["worker"],
  toolchain: LocalRuntimeView["toolchain"],
  busy = false,
  lastReported = false,
): LocalRuntimeView => ({
  worker,
  toolchain,
  toolchainLabel: `${TOOLCHAIN_LABEL[toolchain]}${lastReported && toolchain !== "unknown" ? " (last reported)" : ""}`,
  busy,
});

export function localExecutionStatus(opts: {
  env: Record<string, string | undefined>;
  persistence: "memory" | "supabase";
  nowMs: number;
  /** the server's working directory (the work root must be outside the repository) */
  repoRoot?: string;
}): LocalToolchainStatus {
  if (opts.persistence !== "supabase")
    return {
      installed: false,
      reason:
        "Local Capture needs Supabase persistence: the local worker is a separate process and cannot share this server's in-memory data.",
      runtime: view("not_enabled", "unknown"),
    };
  if (!isLocalWorkerEnabled(opts.env))
    return {
      installed: false,
      reason: `Local reconstruction is not enabled on this server (${WORKER_ENABLED_ENV}).`,
      runtime: view("not_enabled", "unknown"),
    };
  let root: string;
  try {
    root = resolveWorkRoot(opts.env, opts.repoRoot);
  } catch {
    return {
      installed: false,
      reason: "The local reconstruction work root is not valid (PRISM_LOCAL_RECONSTRUCTION_ROOT).",
      runtime: view("not_enabled", "unknown"),
    };
  }
  const r = readHeartbeat(root, opts.nowMs);
  if (r.state === "offline")
    return {
      installed: false,
      reason:
        "The local reconstruction worker is not running on this machine (start it with npm run local:reconstruction-worker).",
      runtime: view("offline", r.last?.toolchain.state ?? "unknown", false, r.last !== null),
    };
  const t = r.heartbeat.toolchain.state;
  return {
    installed: t === "ready",
    reason: t === "ready" ? null : NOT_READY[t],
    runtime: view("online", t, r.heartbeat.busy),
  };
}

/** The `LocalToolchain` the web server gives the local_capture provider: re-read on every status (cheap). */
export function workerBackedToolchain(opts: {
  env: Record<string, string | undefined>;
  persistence: "memory" | "supabase";
  now?: () => number;
  repoRoot?: string;
}): LocalToolchain {
  return {
    probe: () =>
      localExecutionStatus({
        env: opts.env,
        persistence: opts.persistence,
        nowMs: (opts.now ?? Date.now)(),
        repoRoot: opts.repoRoot,
      }),
  };
}
