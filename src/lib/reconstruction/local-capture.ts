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
 * `local_capture`: Prism's FREE, LOCAL reconstruction path (Phase 2F M2D.3). It is registered now so the provider
 * registry, the job schema and the UI are shaped for it, but it does NOT reconstruct anything yet:
 *
 *   photos (many, overlapping) or one video
 *     → camera poses (COLMAP)                 M2D.3
 *     → Gaussian-splat training (Brush)       M2D.3
 *     → Gaussian PLY → validate → SPZ         M2D.3
 *     → the existing M2D.2 atomic ingestion   (private Asset + immutable reconstruction)
 *
 * Execution boundary (`runner: "local_worker"`): a separate Prism worker process claims QUEUED local jobs, runs the
 * toolchain and writes progress/results through the same job repository (compare-and-set). Web requests never run
 * or poll it, so a 10-30 minute reconstruction survives a closed browser. No such worker exists in M2D.2, which is
 * why the toolchain probe below reports "not installed" and the provider is never available.
 *
 * Nothing here is downloaded, installed or executed. There is no hosted fallback: if local capture is unavailable or
 * fails, Prism does not switch to a paid provider; changing provider is always the user's explicit choice.
 */

export interface LocalToolchainStatus {
  installed: boolean;
  /** user-language reason when not installed */
  reason: string | null;
}

/**
 * Detects the local reconstruction toolchain (M2D.3: COLMAP + Brush binaries, a usable GPU). Synchronous and
 * side-effect free: an implementation caches whatever it probed at startup.
 */
export interface LocalToolchain {
  probe(): LocalToolchainStatus;
}

/** M2D.2: there is no toolchain integration yet, so it is never reported as installed. */
export const UNAVAILABLE_TOOLCHAIN: LocalToolchain = {
  probe: () => ({
    installed: false,
    reason: "Local reconstruction tools are not installed yet (they arrive in a later Prism update).",
  }),
};

const notRunnable = () =>
  new ProviderError("capability_unavailable", "Local capture cannot run on this server yet.");

export class LocalCaptureProvider implements ReconstructionProvider {
  readonly id = "local_capture" as const;

  constructor(private readonly toolchain: LocalToolchain = UNAVAILABLE_TOOLCHAIN) {}

  capabilities(): ProviderCapabilities {
    return {
      capability: "local_capture",
      execution: "local",
      runner: "local_worker",
      cost: "free",
      inputModes: ["multi_image", "video"],
      resultKinds: ["gaussian_splat"],
      maxInputs: MAX_JOB_SOURCES,
      models: [],
      defaultModel: null,
      options: [],
      supportsCancel: false,
      supportsProgress: true,
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
    return {
      provider: this.id,
      label: "Local Capture",
      configured: t.installed,
      // no operator switch exists yet: availability is decided by the toolchain alone
      enabled: true,
      capability: t.installed ? "available" : "not_installed",
      reason: t.installed ? null : (t.reason ?? "Local reconstruction tools are not installed."),
    };
  }

  // The worker (M2D.3) executes local jobs; none of these may be reached from a web request.
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
