import type { HardwareFacts } from "./hardware";

/**
 * Prism's hardware acceptance policy for REAL local reconstruction (M2D.3D1).
 *
 * Upstream facts: COLMAP runs on the CPU in Prism's profile (no CUDA, no GPU SIFT); Brush v0.3.0 trains on a GPU
 * through wgpu/Vulkan. Neither project documents a formal minimum CPU, RAM or VRAM. The thresholds below are
 * therefore PRISM HEURISTICS chosen conservatively for a first acceptance run, not upstream requirements, and the
 * tiers are evidence-based: a Vulkan DLL on disk proves nothing; an ENUMERATED hardware Vulkan device is the minimum
 * for a test, and only the REAL_SMOKE training run proves that Brush can actually use it.
 *
 *   UNSUPPORTED        cannot run the toolchain here (or cannot show that it could)
 *   SUPPORTED_FOR_TEST may run REAL_SMOKE (a tiny training run) to find out; not expected to handle a room
 *   PRACTICAL          plausibly able to reconstruct one ordinary room (REAL_ROOM) in a working session
 */

export type HardwareTier = "UNSUPPORTED" | "SUPPORTED_FOR_TEST" | "PRACTICAL";
export type HardwareDecision = "READY_FOR_REAL_RUN" | "NOT_READY_FOR_REAL_RUN";

const GiB = 1024 ** 3;

export const HARDWARE_POLICY = {
  platforms: ["win32", "linux"] as readonly NodeJS.Platform[],
  arch: "x64",
  /**
   * Below "8 GB" the OS, COLMAP's matcher and Brush's host-side buffers compete for memory. The thresholds are a
   * machine's NOMINAL size: firmware and integrated graphics reserve some of it, so an 8 GB / 16 GB machine reports
   * a little less (e.g. 15.9 GiB) and still counts.
   */
  minRamBytes: 7.5 * GiB,
  practicalRamBytes: 15 * GiB,
  /** COLMAP's CPU SIFT extraction and exhaustive matching scale with cores */
  practicalLogicalCores: 8,
  /** REAL_SMOKE workspace (12 synthetic 640×480 views + a ≤100 k-splat PLY), with a wide margin */
  smokeDiskBytes: 2 * GiB,
  /** REAL_ROOM workspace estimate: fixed overhead + a multiple of the photographs' bytes (see diskRequirement) */
  roomFixedBytes: 10 * GiB,
  roomInputMultiplier: 25,
  /** the nominal first-room dataset used when no photographs were chosen yet (~120 phone photos) */
  nominalRoomInputBytes: 1 * GiB,
} as const;

/**
 * A CONSERVATIVE workspace estimate for a REAL_ROOM run: COLMAP's feature database and matches, the undistorted
 * copies of every photograph, Brush's dataset and its exported PLY (≤1 M Gaussians ≈ 250 MB), the SPZ, and logs. The
 * intermediates can be many times the photographs' size. This is Prism's safety policy, not an upstream number.
 */
export function roomDiskRequirement(inputBytes: number): number {
  return HARDWARE_POLICY.roomFixedBytes + HARDWARE_POLICY.roomInputMultiplier * Math.max(0, inputBytes);
}

export interface HardwareAssessment {
  tier: HardwareTier;
  /** the decision for a REAL_ROOM run on this machine */
  decision: HardwareDecision;
  /** whether REAL_SMOKE may be attempted (still needs the operator's opt-in and a ready toolchain) */
  smokeEligible: boolean;
  reasons: string[];
  usableVulkanDevices: string[];
}

export function assessHardware(h: HardwareFacts, o: { roomInputBytes?: number } = {}): HardwareAssessment {
  const blockers: string[] = [];
  const limits: string[] = [];
  const P = HARDWARE_POLICY;

  if (!P.platforms.includes(h.os.platform))
    blockers.push(`${h.os.platform} is not a supported platform for Prism Local Capture (Windows or Linux).`);
  if (h.os.arch !== P.arch) blockers.push(`${h.os.arch} is not supported (x64 only).`);
  if (h.memory.totalBytes < P.minRamBytes)
    blockers.push(`${fmtGiB(h.memory.totalBytes)} RAM is below Prism's minimum (an 8 GB machine).`);

  // Vulkan: an enumerated HARDWARE device is required; a loader alone is not evidence
  const hw = h.vulkan.devices.filter(
    (d) => d.type === "discrete" || d.type === "integrated" || d.type === "other",
  );
  if (h.vulkan.loaderPresent === false) blockers.push("No Vulkan loader is installed; Brush needs Vulkan.");
  else if (h.vulkan.vulkaninfo !== "ok")
    blockers.push(
      "No Vulkan device could be enumerated (vulkaninfo is missing or failed); a loader on disk is not enough evidence.",
    );
  else if (hw.length === 0)
    blockers.push(
      h.vulkan.devices.length > 0
        ? "Only a software/virtual Vulkan device is present (e.g. a CPU rasteriser); Brush needs a GPU."
        : "Vulkan enumerated no device.",
    );

  const discrete = hw.some((d) => d.type === "discrete");
  if (hw.length > 0 && !discrete)
    limits.push(
      "Only an integrated GPU is available: it shares system memory, and Brush's standard profile (30 000 steps, up to 1 M splats) is not expected to be practical on it.",
    );
  if (h.cpu.logicalCores < P.practicalLogicalCores)
    limits.push(
      `${h.cpu.logicalCores} logical CPU cores: COLMAP's CPU feature extraction and exhaustive matching of a room-sized set will be slow (Prism's practical threshold: ${P.practicalLogicalCores}).`,
    );
  if (h.memory.totalBytes < P.practicalRamBytes)
    limits.push(`${fmtGiB(h.memory.totalBytes)} RAM is below Prism's practical threshold (a 16 GB machine).`);

  const free = h.disk.freeBytes;
  const roomNeed = roomDiskRequirement(o.roomInputBytes ?? P.nominalRoomInputBytes);
  if (free === null) blockers.push("Free disk space is unknown for the workspace volume.");
  else if (free < P.smokeDiskBytes)
    blockers.push(
      `Only ${fmtGiB(free)} free on the workspace volume (REAL_SMOKE needs ${fmtGiB(P.smokeDiskBytes)}).`,
    );
  else if (free < roomNeed)
    limits.push(
      `${fmtGiB(free)} free on the workspace volume; a room run of this size needs about ${fmtGiB(roomNeed)} (conservative Prism estimate).`,
    );

  const tier: HardwareTier = blockers.length
    ? "UNSUPPORTED"
    : limits.length
      ? "SUPPORTED_FOR_TEST"
      : "PRACTICAL";
  return {
    tier,
    decision: tier === "PRACTICAL" ? "READY_FOR_REAL_RUN" : "NOT_READY_FOR_REAL_RUN",
    smokeEligible: tier !== "UNSUPPORTED",
    reasons: [...blockers, ...limits],
    usableVulkanDevices: hw.map((d) => `${d.name} (${d.type}, Vulkan ${d.apiVersion ?? "?"})`),
  };
}

export function fmtGiB(bytes: number): string {
  return `${(bytes / GiB).toFixed(1)} GiB`;
}
