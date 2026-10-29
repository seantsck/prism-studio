import type { AnalyzerCapability } from "../model";

/**
 * Temporal Video QA (Phase 3A.3): the versioned policy for how a direct-video batch is SAMPLED, bounded and priced.
 * Pure. Stored on every direct-video batch (and so in the plan fingerprint and the frozen job snapshot), so a run
 * stays interpretable after the policy changes.
 *
 *   "Did the requested motion, blocking and action actually happen through time, and where?"
 *
 * Verified against the official Gemini video-understanding documentation (2026-10-28): video is STATIC-processed by
 * default at 1 frame per second, which the docs warn can miss fast motion; a custom frame rate is set per video part
 * (`videoMetadata.fps`, valid range (0, 24]); a frame costs 258 tokens at default media resolution (66 at low) and
 * audio 32 tokens per second. Prism's Shots are short (seconds), so a FIXED, higher, documented rate is predictable,
 * auditable and cheap; agentic/dynamic navigation is not used (it is harder to audit and to calibrate).
 */
export interface TemporalSamplingPolicy {
  id: string;
  /** Static (uniform) sampling: every frame at the same rate over the whole clip. */
  processing: "static";
  /** Frames per second sent to the analyzer (`videoMetadata.fps`). */
  fps: number;
  /** Prism-owned bounds, far below the provider's theoretical maxima: longer/larger video is not sent at all. */
  maxDurationMs: number;
  maxBytes: number;
  /** Conservative tokens per sampled frame (documented 258 at default resolution, rounded up). */
  tokensPerFrame: number;
  /** Documented audio tokens per second. */
  audioTokensPerSecond: number;
}

/**
 * `shot-temporal-static-v1`: 4 fps over the whole Shot. One sample every 250 ms resolves a camera move, a beat order
 * or a direction of travel in a 3-10 s Shot that 1 fps would reduce to a handful of frames; it stays well inside the
 * documented (0, 24] range and costs ~1.2k input tokens per second of video. Calibration (docs/temporal-video-qa.md)
 * decides whether the rate is sufficient per criterion; it is not assumed.
 */
export const TEMPORAL_SAMPLING_V1: TemporalSamplingPolicy = {
  id: "shot-temporal-static-v1",
  processing: "static",
  fps: 4,
  maxDurationMs: 30_000,
  maxBytes: 100 * 1024 * 1024,
  tokensPerFrame: 300,
  audioTokensPerSecond: 32,
};

/** Video formats a direct-video batch may send unchanged (no transcoding just to please a provider). */
export const DIRECT_VIDEO_MIMES = ["video/mp4", "video/webm"] as const;

/** Conservative input tokens for one video under a sampling policy (frames rounded up, audio always counted). */
export function videoInputTokens(durationMs: number, policy: TemporalSamplingPolicy): number {
  const seconds = Math.max(0, durationMs) / 1000;
  const frames = Math.max(1, Math.ceil(seconds * policy.fps));
  return frames * policy.tokensPerFrame + Math.ceil(seconds) * policy.audioTokensPerSecond;
}

/** The time resolution evidence can honestly claim: one sampling interval (never "frame-accurate"). */
export const samplingPrecisionMs = (policy: Pick<TemporalSamplingPolicy, "fps">) =>
  Math.round(1000 / policy.fps);

/**
 * Lip sync is CALIBRATION-GATED: an analyzer that accepts video+audio is not thereby a lip-sync checker. Until a
 * live calibration (synchronised vs deliberately offset fixtures) passes its pre-registered threshold, no adapter
 * declares `lip_sync` and the criterion stays unchecked with this reason.
 */
export const LIP_SYNC_NOT_CALIBRATED =
  "Lip sync — unchecked: the temporal lip-sync analyzer is not yet calibrated.";

/** Why a temporal capability the analyzer does not declare stays unchecked (specific, never "pass"). */
export function temporalCapabilityReason(cap: AnalyzerCapability, analyzerId: string): string {
  if (cap === "lip_sync") return LIP_SYNC_NOT_CALIBRATED;
  if (cap === "audio") return `${analyzerId} does not analyse audio here: this criterion stays unchecked.`;
  return `${analyzerId} does not declare ${cap}: this criterion stays unchecked.`;
}

/** "≈ 00:03.0" / "≈ 00:03.0–00:04.5": approximate by construction (the provider sees samples, not every frame). */
export function formatEvidenceTime(atMs: number, endMs?: number | null): string {
  const f = (ms: number) => {
    const s = ms / 1000;
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
  };
  return endMs != null && endMs > atMs ? `≈ ${f(atMs)}–${f(endMs)}` : `≈ ${f(atMs)}`;
}

const TEMPORAL_CAPS: readonly AnalyzerCapability[] = ["video_temporal", "lip_sync", "audio"];

export interface TemporalCoverage {
  /** Temporal criteria of this Shot (camera movement, action beats, staging, forbidden actions, lip sync). */
  total: number;
  /** Judged by an analyzer from the video (pass / warn / fail): "evaluated", never a synonym for "passed". */
  evaluated: number;
  unchecked: Array<{ key: string; title: string; reason: string }>;
}

/**
 * Temporal Video QA coverage of ONE run, for the review surface. Kept separate from the Shot QA state: it says what
 * was examined through time, not whether it passed.
 */
export function temporalCoverage(args: {
  criteria: Array<{ key: string; title: string; capability: AnalyzerCapability | null }>;
  /** The run's frozen plan (null for a deterministic-only run). */
  planItems: Array<{ criterionKey: string; reason: string; status: string }> | null;
  results: Map<string, { result: string; resultSource: string }>;
}): TemporalCoverage {
  const temporal = args.criteria.filter((c) => c.capability != null && TEMPORAL_CAPS.includes(c.capability));
  const unchecked: TemporalCoverage["unchecked"] = [];
  let evaluated = 0;
  for (const c of temporal) {
    const r = args.results.get(c.key);
    if (r && r.resultSource === "analyzer" && r.result !== "unchecked") {
      evaluated += 1;
      continue;
    }
    const item = args.planItems?.find((i) => i.criterionKey === c.key);
    unchecked.push({
      key: c.key,
      title: c.title,
      reason:
        c.capability === "lip_sync" && (!item || item.status !== "planned")
          ? LIP_SYNC_NOT_CALIBRATED
          : (item?.reason ??
            "No semantic analysis of the video was run (deterministic QA does not judge motion)."),
    });
  }
  return { total: temporal.length, evaluated, unchecked };
}
