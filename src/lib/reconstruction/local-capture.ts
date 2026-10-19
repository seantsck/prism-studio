import { FREE_COST_ESTIMATE, MAX_JOB_SOURCES, type JobCostEstimate } from "@/domain/reconstruction/job";
import {
  ProviderError,
  type ExtractedResult,
  type InputMode,
  type OperationSnapshot,
  type PreparedInput,
  type ProviderCapabilities,
  type ProviderStatus,
  type ReconstructionProvider,
} from "./provider";

/**
 * `local_capture`: Prism's FREE, LOCAL reconstruction path (Phase 2F M2D.3).
 *
 *   ordered photographs (3-300 JPEG/PNG)
 *     → camera poses (COLMAP)                 M2D.3A engine
 *     → Gaussian-splat training (Brush)       M2D.3A engine
 *     → Gaussian PLY → validate → SPZ         M2D.3A engine
 *     → the shared M2D.2 atomic ingestion    (private Asset + immutable reconstruction)
 *
 * Execution boundary (`runner: "local_worker"`): the SAME-HOST local reconstruction worker (M2D.3B,
 * `npm run local:reconstruction-worker`), a separate long-lived process, claims QUEUED local jobs, runs the engine and
 * writes progress/results through the same job repository (compare-and-set). Web requests never run or poll it, so a
 * 10-30 minute reconstruction survives a closed browser. This adapter is only the web side: capabilities, cost,
 * availability (toolchain ready AND worker online) and cancellation. Its execution methods refuse to run.
 *
 * Nothing here is downloaded, installed or executed. There is no hosted fallback: if local capture is unavailable or
 * fails, Prism does not switch to a paid provider; changing provider is always the user's explicit choice.
 */

/** Why the local toolchain is or is not ready, as the worker last probed it (M2D.3A toolchain rules). */
export const LOCAL_TOOLCHAIN_STATES = [
  "ready",
  "colmap_missing",
  "colmap_unverified",
  "colmap_incompatible",
  "brush_missing",
  "brush_incompatible",
  "gpu_unavailable",
] as const;
export type LocalToolchainState = (typeof LOCAL_TOOLCHAIN_STATES)[number];

export const TOOLCHAIN_LABEL: Record<LocalToolchainState | "unknown", string> = {
  ready: "Ready",
  colmap_missing: "COLMAP missing",
  colmap_unverified: "COLMAP unverified",
  colmap_incompatible: "COLMAP incompatible",
  brush_missing: "Brush missing",
  brush_incompatible: "Brush incompatible",
  gpu_unavailable: "GPU unavailable",
  unknown: "Unknown (the worker reports it while running)",
};

/** Safe, user-facing runtime facts about local execution (no path, pid, environment or connection detail). */
export interface LocalRuntimeView {
  /** online: a fresh heartbeat from a worker on THIS work root · offline: none · not_enabled: switched off here */
  worker: "online" | "offline" | "not_enabled";
  toolchain: LocalToolchainState | "unknown";
  toolchainLabel: string;
  /** the worker is running a reconstruction now (queued jobs wait: one at a time) */
  busy: boolean;
}

export interface LocalToolchainStatus {
  /** true only when local jobs can run: the toolchain is ready AND a worker is online */
  installed: boolean;
  /** user-language reason when not usable */
  reason: string | null;
  runtime?: LocalRuntimeView;
}

/**
 * Reports whether local execution is usable. Synchronous and side-effect free: the server implementation reads the
 * worker's heartbeat file (`local-worker/status.ts`); it never probes, installs or starts anything.
 */
export interface LocalToolchain {
  probe(): LocalToolchainStatus;
}

/** No worker integration (tests, and any server without the local worker wiring): never usable. */
export const UNAVAILABLE_TOOLCHAIN: LocalToolchain = {
  probe: () => ({
    installed: false,
    reason: "Local reconstruction tools are not installed yet (they arrive in a later Prism update).",
  }),
};

const notRunnable = () =>
  new ProviderError(
    "capability_unavailable",
    "Local capture runs in the local worker, never in a web request.",
  );

export class LocalCaptureProvider implements ReconstructionProvider {
  readonly id = "local_capture" as const;

  constructor(private readonly toolchain: LocalToolchain = UNAVAILABLE_TOOLCHAIN) {}

  capabilities(): ProviderCapabilities {
    return {
      capability: "local_capture",
      execution: "local",
      runner: "local_worker",
      cost: "free",
      // photographs only: video (FFmpeg frame extraction) is a later, separate decision
      inputModes: ["multi_image"],
      resultKinds: ["gaussian_splat"],
      maxInputs: MAX_JOB_SOURCES,
      minInputs: 3,
      inputMimes: ["image/jpeg", "image/png"],
      models: [],
      defaultModel: null,
      options: [],
      // the worker re-reads the job every second or two and stops COLMAP/Brush when it is cancelled
      supportsCancel: true,
      supportsProgress: true,
      // a validated result that was not yet imported is imported after a worker restart (never re-trained)
      supportsResume: true,
      supportsIdempotencyKey: true,
      testOnly: false,
    };
  }

  estimateCost(model: string | null, mode: InputMode): JobCostEstimate {
    return FREE_COST_ESTIMATE(`${model ?? "local"} · ${mode} · runs on this machine`);
  }

  status(): ProviderStatus {
    const t = this.toolchain.probe();
    const runtime = t.runtime;
    return {
      provider: this.id,
      label: "Local Capture",
      configured: t.installed || runtime?.toolchain === "ready",
      // no operator switch beyond the worker's own: availability is decided by the toolchain and the worker
      enabled: true,
      capability: t.installed
        ? "available"
        : runtime && runtime.toolchain === "ready"
          ? "unavailable"
          : "not_installed",
      reason: t.installed ? null : (t.reason ?? "Local reconstruction tools are not installed."),
      ...(runtime ? { local: runtime } : {}),
    };
  }

  /**
   * The web side of a cancel: the job is marked cancelled by the job service (compare-and-set); the worker notices on
   * its next check and aborts COLMAP/Brush (process tree), cleans the workspace and writes no result. Confirmed because
   * a cancelled job can never be completed: the worker's ingestion is a compare-and-set on the running job.
   */
  async cancel(): Promise<boolean> {
    return true;
  }

  // The worker executes local jobs; none of these may be reached from a web request.
  async prepareInputs(): Promise<PreparedInput[]> {
    throw notRunnable();
  }
  async submit(): Promise<OperationSnapshot> {
    throw notRunnable();
  }
  async getOperation(): Promise<OperationSnapshot> {
    throw notRunnable();
  }
  extractResult(): ExtractedResult {
    throw notRunnable();
  }
  async download(): Promise<Uint8Array> {
    throw notRunnable();
  }
}
