import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AnalyzerCapability, ContinuityCategory } from "@/domain/continuity/model";
import { buildAnalysisPlan } from "@/domain/continuity/analysis/plan";
import { TEMPORAL_SAMPLING_V1, samplingPrecisionMs } from "@/domain/continuity/analysis/temporal";
import {
  ANALYSIS_SCHEMA_VERSION,
  DEFAULT_ANALYSIS_BUDGET,
  promptVersionFor,
  RUBRIC_VERSION,
  type AnalysisMedia,
  type ContinuityAnalysisInput,
  type NormalizedFinding,
} from "@/domain/continuity/analysis/types";
import { redactText } from "@/lib/auth/redact";
import { AnalysisBatchError, type ContinuityAnalysisProvider, type UsageCall } from "../analysis/provider";

/**
 * Temporal Video QA calibration (Phase 3A.3). Deterministic SYNTHETIC clips with known temporal truth (no copyrighted
 * footage, no real person), a PRE-REGISTERED acceptance rule per criterion, and a harness that runs an analyzer over
 * them under a hard request/dollar ceiling. Ordinary CI runs it with a fake transport; a live run is a separate,
 * explicitly authorised gate (scripts/continuity-temporal-calibration.mts, docs/temporal-video-qa.md).
 *
 * The expectations below are fixed BEFORE any live answer is seen. Changing them after a live run is a new
 * calibration version, never a re-grade.
 */
// v2 (2026-10-29): the screen-direction truth text is corrected (see the direction fixtures). Every other fixture,
// the pixels, windows and grading are v1's; v1 stays the record of the fourth live run, never re-graded.
export const CALIBRATION_VERSION = "temporal-calibration-v2";

export type CalibrationCriterion =
  | "camera_movement"
  | "screen_direction"
  | "eyelines"
  | "action_continuity"
  | "forbidden_action"
  | "geography"
  | "lip_sync";

export interface CalibrationFixture {
  id: string;
  criterion: CalibrationCriterion;
  /** What the clip is (for the report; never sent as truth). */
  description: string;
  /** The production truth the analyzer is asked to judge (sent as DATA, like a real Shot's expected value). */
  expected: string;
  /**
   * Pre-registered correct answer. Every "fail" fixture is a deliberate, unambiguous conflict, so ONLY `fail` is
   * correct for it: `warn` ("possible deviation") is not definitive enough to claim a production capability.
   */
  correct: "pass" | "fail";
  /** For event fixtures: the window (ms) in which the evidence must point, ± the sampling precision + slack. */
  eventWindowMs?: [number, number];
  durationMs: number;
  /** ffmpeg lavfi graph inputs and filter (arrays only: no shell). */
  video: string;
  /** Optional lavfi audio source. */
  audio?: string;
}

const W = 640;
const H = 360;
const D = 4; // seconds: short, like a Shot
const bg = `color=c=0x303030:s=${W}x${H}:d=${D}:r=24`;
const box = (c: string, s = 70) => `color=c=${c}:s=${s}x${s}:d=${D}:r=24`;

/** Every fixture is a pure function of this table: same ffmpeg ⇒ same pixels, timings and truth. */
export const TEMPORAL_FIXTURES: readonly CalibrationFixture[] = [
  // ── camera movement: a viewport sliding over a wide test pattern ──
  {
    id: "camera-pan-right",
    criterion: "camera_movement",
    description: "Viewport pans steadily to the right across a wide test pattern.",
    expected: "Slow pan right",
    correct: "pass",
    durationMs: D * 1000,
    video: `testsrc2=s=1920x${H}:d=${D}:r=24,crop=${W}:${H}:x='t/${D}*1280':y=0`,
  },
  {
    id: "camera-pan-right-reversed",
    criterion: "camera_movement",
    description: "Reverse control: the viewport pans LEFT.",
    expected: "Slow pan right",
    correct: "fail",
    durationMs: D * 1000,
    video: `testsrc2=s=1920x${H}:d=${D}:r=24,crop=${W}:${H}:x='1280-t/${D}*1280':y=0`,
  },
  {
    id: "camera-static-negative",
    criterion: "camera_movement",
    description: "Negative control: a locked-off (static) frame.",
    expected: "Slow pan right",
    correct: "fail",
    durationMs: D * 1000,
    video: `testsrc2=s=1920x${H}:d=${D}:r=24,crop=${W}:${H}:x=640:y=0`,
  },
  // ── screen direction: a proxy subject crossing the frame ──
  // The square (70 px) runs x = 0 → W-70 over the clip: it reaches the right edge but never leaves the frame. v1's
  // truth said "(exits screen-right)", which these pixels never do; the fourth live run answered WARN 3/3 on the
  // positive fixture for exactly that. v2 states only the direction the pixels show. Do not reintroduce an exit
  // claim (or add an exit to the render): this criterion tests direction, not frame exits.
  {
    id: "direction-left-to-right",
    criterion: "screen_direction",
    description: "A red square proxy moves from frame left to frame right.",
    expected: "The red subject moves left to right across the frame",
    correct: "pass",
    durationMs: D * 1000,
    video: `${bg}[b];${box("red")}[s];[b][s]overlay=x='t/${D}*${W - 70}':y=145`,
  },
  {
    id: "direction-reversed",
    criterion: "screen_direction",
    description: "Reverse control: the red square moves right to left.",
    expected: "The red subject moves left to right across the frame",
    correct: "fail",
    durationMs: D * 1000,
    video: `${bg}[b];${box("red")}[s];[b][s]overlay=x='${W - 70}-t/${D}*${W - 70}':y=145`,
  },
  // ── eyelines: an abstract face proxy (white square, dark pupil) and a green target on screen-right ──
  {
    id: "eyeline-on-target",
    criterion: "eyelines",
    description: "The face proxy's pupil stays on the side facing the green target for the whole clip.",
    expected:
      "The white face proxy looks toward the green target on screen-right throughout (its dark pupil is on the side facing the target)",
    correct: "pass",
    durationMs: D * 1000,
    video: `${bg},drawbox=x=100:y=130:w=100:h=100:color=white:t=fill,drawbox=x=170:y=170:w=20:h=20:color=black:t=fill,drawbox=x=470:y=145:w=70:h=70:color=green:t=fill`,
  },
  {
    id: "eyeline-broken",
    criterion: "eyelines",
    description: "Negative control: at 2.0 s the pupil jumps to the side facing AWAY from the target.",
    expected:
      "The white face proxy looks toward the green target on screen-right throughout (its dark pupil is on the side facing the target)",
    correct: "fail",
    eventWindowMs: [2000, 2000],
    durationMs: D * 1000,
    video: `${bg},drawbox=x=100:y=130:w=100:h=100:color=white:t=fill,drawbox=x='if(lt(t,2),170,110)':y=170:w=20:h=20:color=black:t=fill,drawbox=x=470:y=145:w=70:h=70:color=green:t=fill`,
  },
  // ── action beats: shapes appearing at known times ──
  {
    id: "beats-in-order",
    criterion: "action_continuity",
    description: "Beat 1 at 1.0 s: a red square appears left. Beat 2 at 2.5 s: a blue square appears right.",
    expected: "0:01.0 a red square appears on the left; 0:02.5 a blue square appears on the right",
    correct: "pass",
    eventWindowMs: [1000, 2500],
    durationMs: D * 1000,
    video: `${bg},drawbox=x=80:y=145:w=70:h=70:color=red:t=fill:enable='gte(t,1)',drawbox=x=490:y=145:w=70:h=70:color=blue:t=fill:enable='gte(t,2.5)'`,
  },
  {
    id: "beats-reordered",
    criterion: "action_continuity",
    description: "Reordered: the blue square appears first (1.0 s), the red one later (2.5 s).",
    expected: "0:01.0 a red square appears on the left; 0:02.5 a blue square appears on the right",
    correct: "fail",
    eventWindowMs: [1000, 2500],
    durationMs: D * 1000,
    video: `${bg},drawbox=x=80:y=145:w=70:h=70:color=red:t=fill:enable='gte(t,2.5)',drawbox=x=490:y=145:w=70:h=70:color=blue:t=fill:enable='gte(t,1)'`,
  },
  {
    id: "beats-omitted",
    criterion: "action_continuity",
    description: "Omitted beat: only the red square ever appears.",
    expected: "0:01.0 a red square appears on the left; 0:02.5 a blue square appears on the right",
    correct: "fail",
    durationMs: D * 1000,
    video: `${bg},drawbox=x=80:y=145:w=70:h=70:color=red:t=fill:enable='gte(t,1)'`,
  },
  // ── forbidden action: a yellow square crossing during a known interval ──
  {
    id: "forbidden-occurs",
    criterion: "forbidden_action",
    description: "A yellow square sweeps across the frame between 2.0 s and 3.0 s.",
    expected: "Absent: a yellow square sweeping across the frame",
    correct: "fail",
    eventWindowMs: [2000, 3000],
    durationMs: D * 1000,
    video: `${bg}[b];${box("yellow")}[s];[b][s]overlay=x='(t-2)*${W}':y=145:enable='between(t,2,3)'`,
  },
  {
    id: "forbidden-absent",
    criterion: "forbidden_action",
    description: "Negative control: nothing sweeps across the frame.",
    expected: "Absent: a yellow square sweeping across the frame",
    correct: "pass",
    durationMs: D * 1000,
    video: bg,
  },
  // ── geography: two proxies keep / swap their relative positions ──
  {
    id: "geography-kept",
    criterion: "geography",
    description: "Red stays left of blue for the whole clip.",
    expected: "The red subject stays to the left of the blue subject throughout",
    correct: "pass",
    durationMs: D * 1000,
    video: `${bg},drawbox=x=120:y=145:w=70:h=70:color=red:t=fill,drawbox=x=450:y=145:w=70:h=70:color=blue:t=fill`,
  },
  {
    id: "geography-swapped",
    criterion: "geography",
    description: "At 2.0 s the red and blue squares swap sides.",
    expected: "The red subject stays to the left of the blue subject throughout",
    correct: "fail",
    eventWindowMs: [2000, 2000],
    durationMs: D * 1000,
    video: `${bg},drawbox=x='if(lt(t,2),120,450)':y=145:w=70:h=70:color=red:t=fill,drawbox=x='if(lt(t,2),450,120)':y=145:w=70:h=70:color=blue:t=fill`,
  },
  // ── lip-sync readiness: an abstract mouth proxy and a pulsed tone ──
  {
    id: "lipsync-synchronised",
    criterion: "lip_sync",
    description: "An abstract mouth (white bar) opens exactly while a 440 Hz tone pulse sounds (4 pulses).",
    expected: "Mouth movement matches the performed dialogue",
    correct: "pass",
    durationMs: D * 1000,
    video: `${bg},drawbox=x=270:y=200:w=100:h=40:color=white:t=fill:enable='lt(mod(t,1),0.25)'`,
    audio: `aevalsrc='0.5*sin(2*PI*440*t)*lt(mod(t,1),0.25)':s=48000:d=${D}`,
  },
  {
    id: "lipsync-offset",
    criterion: "lip_sync",
    description: "The same mouth proxy opens 400 ms AFTER each tone pulse (deliberately out of sync).",
    expected: "Mouth movement matches the performed dialogue",
    correct: "fail",
    durationMs: D * 1000,
    video: `${bg},drawbox=x=270:y=200:w=100:h=40:color=white:t=fill:enable='lt(mod(t-0.4,1),0.25)*gte(t,0.4)'`,
    audio: `aevalsrc='0.5*sin(2*PI*440*t)*lt(mod(t,1),0.25)':s=48000:d=${D}`,
  },
];

/**
 * PRE-REGISTERED acceptance (fixed before any live call). A criterion is "usable" only if EVERY fixture of it is
 * answered correctly in at least `minCorrectPerFixture` of `trials`, and event fixtures cite evidence inside their
 * window (± sampling precision + slack). `unchecked` is never correct. Lip sync additionally gates the capability.
 */
export const CALIBRATION_ACCEPTANCE = {
  trials: 3,
  minCorrectPerFixture: 3,
  eventSlackMs: 500,
} as const;

const CAPABILITY: Record<CalibrationCriterion, AnalyzerCapability> = {
  camera_movement: "video_temporal",
  screen_direction: "video_temporal",
  eyelines: "video_temporal",
  action_continuity: "video_temporal",
  forbidden_action: "video_temporal",
  geography: "video_temporal",
  lip_sync: "lip_sync",
};
const CATEGORY: Record<CalibrationCriterion, ContinuityCategory> = {
  camera_movement: "camera",
  screen_direction: "screen_direction",
  eyelines: "eyelines",
  action_continuity: "action_continuity",
  forbidden_action: "action_continuity",
  geography: "geography",
  lip_sync: "lip_sync",
};

/** Renders one fixture to MP4 bytes with ffmpeg (argument arrays only, no shell); deterministic flags. */
export async function renderFixture(
  f: Pick<CalibrationFixture, "id" | "durationMs" | "video" | "audio">,
  ffmpeg = "ffmpeg",
): Promise<Uint8Array> {
  const dir = await mkdtemp(path.join(tmpdir(), "prism-temporal-fixture-"));
  const out = path.join(dir, `${f.id}.mp4`);
  // the video graph is self-contained (source filters inside -filter_complex); audio, when present, is input 0
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    ...(f.audio ? ["-f", "lavfi", "-i", f.audio] : []),
    "-filter_complex",
    `${f.video}[v]`,
    "-map",
    "[v]",
    ...(f.audio ? ["-map", "0:a"] : []),
    "-t",
    String(f.durationMs / 1000),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "1",
    ...(f.audio ? ["-c:a", "aac", "-b:a", "64k"] : ["-an"]),
    "-fflags",
    "+bitexact",
    "-flags:v",
    "+bitexact",
    "-map_metadata",
    "-1",
    "-movflags",
    "+faststart",
    "-y",
    out,
  ];
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(ffmpeg, args, { timeout: 60_000 }, (err) => (err ? reject(err) : resolve())),
    );
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The frozen analysis input for one fixture: one criterion, the video only, the production sampling policy. */
export function fixtureInput(
  f: CalibrationFixture,
  provider: ContinuityAnalysisProvider,
  bytes: Uint8Array,
): ContinuityAnalysisInput {
  return temporalAnalysisInput(
    {
      id: f.id,
      idPrefix: "calibration",
      runKeyPrefix: CALIBRATION_VERSION,
      label: "Calibration clip",
      key: f.criterion,
      category: CATEGORY[f.criterion],
      capability: CAPABILITY[f.criterion],
      sourceRef: CALIBRATION_VERSION,
      expected: f.expected,
      durationMs: f.durationMs,
    },
    provider,
    bytes,
  );
}

/**
 * A one-criterion, video-only direct-video analysis input (640×360, the production sampling policy). Shared by the
 * calibration fixtures and the analyzer-contract smoke, so the smoke exercises the SAME request construction.
 */
export function temporalAnalysisInput(
  spec: {
    id: string;
    idPrefix: string;
    runKeyPrefix: string;
    label: string;
    key: string;
    category: ContinuityCategory;
    capability: AnalyzerCapability;
    sourceRef: string;
    expected: string;
    durationMs: number;
  },
  provider: ContinuityAnalysisProvider,
  bytes: Uint8Array,
): ContinuityAnalysisInput {
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const ref = `${spec.idPrefix}:${spec.id}`;
  const media: AnalysisMedia[] = [
    {
      inputId: "video",
      kind: "video",
      role: "output_video",
      label: spec.label,
      assetId: ref,
      checksum,
      mime: "video/mp4",
      width: W,
      height: H,
      byteSize: bytes.length,
      durationMs: spec.durationMs,
      atMs: null,
    },
  ];
  const criterion = {
    key: spec.key,
    category: spec.category,
    severity: "major" as const,
    title: spec.key,
    sourceRef: spec.sourceRef,
    expected: spec.expected,
    handler: "analyzer" as const,
    capability: spec.capability,
    position: 0,
  };
  // calibration measures what the analyzer CAN do: lip sync is offered to it here (and only here) so the gate
  // can be evaluated; production never plans lip sync until this calibration passes
  const view = provider.plannerView();
  const plan = buildAnalysisPlan({
    analyzer: {
      ...view,
      videoCapabilities: [...new Set([...view.videoCapabilities, spec.capability])],
    },
    criteria: [criterion],
    media,
    directVideoAllowed: true,
    sampling: TEMPORAL_SAMPLING_V1,
  });
  return {
    version: 1,
    runKey: `${spec.runKeyPrefix}:${spec.id}`,
    attemptId: ref,
    subjectAssetId: ref,
    providerOriginalAssetId: null,
    criteria: [
      {
        key: criterion.key,
        category: criterion.category,
        severity: criterion.severity,
        title: criterion.title,
        sourceRef: criterion.sourceRef,
        expected: criterion.expected,
        capability: criterion.capability,
      },
    ],
    media,
    framing: {
      productionAspectRatio: "16:9",
      deliveryWidth: W,
      deliveryHeight: H,
      providerCanvas: null,
      strategy: null,
    },
    analyzer: provider.id,
    analyzerVersion: provider.version,
    model: provider.model,
    promptVersions: {
      image_set: promptVersionFor(provider.id, "image_set"),
      direct_video: promptVersionFor(provider.id, "direct_video"),
    },
    rubricVersion: RUBRIC_VERSION,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    plan: { ...plan, budget: DEFAULT_ANALYSIS_BUDGET },
  };
}

export interface CalibrationTrial {
  fixture: string;
  criterion: CalibrationCriterion;
  trial: number;
  result: NormalizedFinding["result"] | "error";
  correct: boolean;
  evidenceInWindow: boolean | null;
  note: string;
  /** Error trials only: the provider HTTP status (when it answered) and the normalized category. */
  httpStatus?: number | null;
  errorCategory?: string;
}

/**
 * RUN CONTROL (not grading), fixed before the next live run and never tuned on model answers. The first live attempt
 * (2026-10-28) produced ZERO model answers (48 provider errors: 40×429, 4×503, 4×500), so it is not an evaluated
 * calibration trial and `temporal-calibration-v1` stays uncontaminated.
 *
 *  - The FIRST HTTP 429 aborts the run: the project's quota or request schedule cannot complete the pre-registered
 *    trial set, and continuing only produces correlated missing trials under rate pressure. (Calibration only: the
 *    production worker still requeues a 429 durably.)
 *  - `maxConsecutive5xx` consecutive HTTP 5xx answers abort the run as provider-unavailable. A single 5xx is an error
 *    trial (never retried).
 *  - Live pacing keeps `rpmSafety` of the operator-declared RPM limit, start to start.
 *  - `maxConsecutiveIdentical400` consecutive HTTP 400 answers with the SAME sanitized error signature abort the run
 *    as `request_contract_invalid`. One 400 may be a fixture-specific input problem and stays an error trial; two
 *    different fixtures refused identically, back to back, mean the shared request construction is invalid. (The
 *    third live attempt sent all 48 requests into an identical 400 INVALID_ARGUMENT: Gemini refused the response
 *    schema, not any fixture.) A success or any other outcome resets the count.
 */
export const CALIBRATION_RUN_CONTROL = {
  abortOnHttp429: true,
  maxConsecutive5xx: 3,
  maxConsecutiveIdentical400: 2,
  rpmSafety: 0.8,
} as const;

/**
 * A safe, stable signature for an HTTP 400: status, normalized category and the sanitized message with volatile
 * tokens (long digit or hex runs, e.g. request ids) masked. Never request data or credentials (the message is the
 * transport's redacted text).
 */
export function http400Signature(status: number, category: string, message: string): string {
  const msg = redactText(message)
    .replace(/\b[0-9a-f]{12,}\b/gi, "#")
    .replace(/\d{4,}/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return `${status}|${category}|${msg}`;
}

/**
 * PROVIDER ACCESS FAILURES abort the run on their FIRST occurrence. They mean that the account or project cannot serve
 * any request until the operator fixes it, not that the fixture or the model failed, so every remaining trial would be
 * rejected the same way. The second live attempt (2026-10-28) sent all 48 requests and got 48 × HTTP 402 ("prepayment
 * credits are depleted"), because a 402 was then an ordinary `invalid_input` error trial. A 404 means the model or
 * endpoint is not served for this project, which is equally run-wide. Other 4xx (400, 413, 422, …) stay per-trial
 * error trials: a malformed or oversized request is a fixture/harness input problem that need not affect the other
 * fixtures. (Calibration only: the transport's production taxonomy is unchanged.)
 */
export const PROVIDER_ACCESS_FAILURES = {
  401: "provider_authentication_error",
  402: "provider_billing_error",
  403: "provider_authorization_error",
  404: "provider_model_unavailable",
} as const;
export type ProviderAccessFailure = (typeof PROVIDER_ACCESS_FAILURES)[keyof typeof PROVIDER_ACCESS_FAILURES];

export function providerAccessFailure(httpStatus: number | null): ProviderAccessFailure | null {
  return httpStatus != null && Object.hasOwn(PROVIDER_ACCESS_FAILURES, httpStatus)
    ? PROVIDER_ACCESS_FAILURES[httpStatus as keyof typeof PROVIDER_ACCESS_FAILURES]
    : null;
}

export type CalibrationRunStatus = "completed" | "aborted_provider" | "aborted_local_policy";

/**
 * Per criterion: `accepted`, or why not. `incomplete` = the pre-registered test did not finish (an aborted run) after
 * the model answered some of the criterion's trials; `not_measured_provider_error` = the run aborted on the provider
 * before the model answered ANY of the criterion's trials (not a quality result); `incorrect` = the model answered and
 * at least one answer was graded wrong; `provider_errors` = a completed run where every miss was an error with no
 * answer (nothing was learned about the model).
 */
export type CriterionVerdict =
  | "accepted"
  | "not_accepted_incomplete"
  | "not_measured_provider_error"
  | "not_accepted_incorrect"
  | "not_accepted_provider_errors";

/** Operator-declared limits of the Google project behind the key (read from AI Studio; never inferred). */
export interface CalibrationQuota {
  maxRpm: number;
  maxTpm: number;
  maxRpd: number;
}

export interface CalibrationQuotaPlan extends CalibrationQuota {
  effectiveRpm: number;
  minIntervalMs: number;
  plannedAnalysisRequests: number;
  /** Largest single request: estimated input tokens + the output ceiling (thinking included). */
  maxTokensPerRequest: number;
  maxInputTokensPerRequest: number;
  /** Worst case in any minute at the paced rate (conservative: input + output ceiling). */
  worstCaseTokensPerMinute: number;
}

export interface CalibrationReport {
  version: string;
  analyzer: string;
  analyzerVersion: string;
  model: string;
  sampling: string;
  status: CalibrationRunStatus;
  /** Present when the run aborted: why, and on which trial. The message is the transport's sanitized text. */
  abort: {
    reason:
      | "quota_or_billing_exhausted"
      | "quota_or_rate_limit"
      | "provider_unavailable"
      | ProviderAccessFailure
      | "request_contract_invalid"
      | "local_policy";
    httpStatus: number | null;
    category: string;
    message: string;
    fixture: string;
    trial: number;
  } | null;
  trials: CalibrationTrial[];
  trialsPlanned: number;
  trialsAttempted: number;
  trialsUnattempted: number;
  /**
   * Attempted trials with no GRADEABLE answer: every error trial, i.e. an HTTP rejection, a timeout/network failure, a
   * local refusal, or a model response that was unusable (schema-invalid, safety-blocked).
   */
  trialsUnanswered: number;
  /** Of those, the trials the provider REJECTED with an HTTP error status (no model response at all). */
  trialsRejected: number;
  /**
   * Model responses received: generation calls that came back with a 2xx response body, whether the answer was
   * usable, schema-invalid or safety-blocked (one usage record each). HTTP rejections (4xx/5xx) and timeouts are NOT
   * model responses and are not counted here; they are in `trialsRejected` / `trialsUnanswered`.
   */
  answersReceived: number;
  /** Every outbound request (uploads included). */
  transportCalls: number;
  uploadAttempts: number;
  analysisAttempts: number;
  correctionAttempts: number;
  /** Generation calls whose response carried complete usage metadata. */
  usageReportedCalls: number;
  estimatedMaxUsd: number;
  /**
   * TOTAL actual spend: 0 only when no generation request left Prism; the provider's figure only when EVERY
   * generation attempt reported usage; otherwise null = UNKNOWN (a 429/5xx/timeout without usage may or may not
   * have been billed). Never a partial sum presented as the total.
   */
  actualUsd: number | null;
  costStatus: "none_sent" | "known" | "unknown";
  /** Spend of the calls that DID report usage (a lower bound when costStatus is unknown). */
  knownUsageUsd: number | null;
  reportedTokens: { inputTokens: number; outputTokens: number; thoughtsTokens: number };
  quota: CalibrationQuotaPlan | null;
  /** Per criterion: did EVERY fixture meet the pre-registered rule? (false for every criterion of an aborted run) */
  accepted: Record<CalibrationCriterion, boolean>;
  verdicts: Record<CalibrationCriterion, CriterionVerdict>;
  /** The capability decision this calibration supports (lip sync stays OFF unless accepted). */
  lipSyncCapable: boolean;
}

/** Grades one answer against the pre-registered truth. `unchecked` and errors are never correct. */
export function gradeTrial(
  f: CalibrationFixture,
  finding: NormalizedFinding | null,
): Omit<CalibrationTrial, "trial"> {
  if (!finding)
    return {
      fixture: f.id,
      criterion: f.criterion,
      result: "error",
      correct: false,
      evidenceInWindow: null,
      note: "no answer",
    };
  // strict: a deliberate conflict must be reported as `fail`; `warn` and `unchecked` are not correct for it
  const correct = finding.result === f.correct;
  let evidenceInWindow: boolean | null = null;
  if (f.eventWindowMs && finding.result !== "pass") {
    const slack = samplingPrecisionMs(TEMPORAL_SAMPLING_V1) + CALIBRATION_ACCEPTANCE.eventSlackMs;
    const [a, b] = f.eventWindowMs;
    evidenceInWindow = finding.evidence.some(
      (e) => e.atMs != null && (e.endMs ?? e.atMs) >= a - slack && e.atMs <= b + slack,
    );
  }
  return {
    fixture: f.id,
    criterion: f.criterion,
    result: finding.result,
    correct: correct && evidenceInWindow !== false,
    evidenceInWindow,
    note: finding.summary.slice(0, 200),
  };
}

export function acceptance(trials: CalibrationTrial[]): Record<CalibrationCriterion, boolean> {
  const out = {} as Record<CalibrationCriterion, boolean>;
  for (const c of Object.keys(CAPABILITY) as CalibrationCriterion[]) {
    const fixtures = TEMPORAL_FIXTURES.filter((f) => f.criterion === c);
    out[c] =
      fixtures.length > 0 &&
      fixtures.every(
        (f) =>
          trials.filter((t) => t.fixture === f.id && t.correct).length >=
          CALIBRATION_ACCEPTANCE.minCorrectPerFixture,
      );
  }
  return out;
}

/**
 * A conservative reason for a 429. The pinned SDK exposes only the HTTP status and message, so "quota or billing" is
 * claimed only when the provider's message says so; anything else is "quota or rate limit" (never assumed daily).
 */
export function http429Reason(message: string): "quota_or_billing_exhausted" | "quota_or_rate_limit" {
  return /exceeded your current quota|billing/i.test(message)
    ? "quota_or_billing_exhausted"
    : "quota_or_rate_limit";
}

/**
 * Live-run readiness the operator declares from AI Studio for the SAME Google project that backs the key (limits are
 * per project, not per key; Prism cannot read them). Returns the refusals; empty = ready to plan.
 */
export function liveReadinessProblems(r: {
  maxRpm?: number;
  maxTpm?: number;
  maxRpd?: number;
  rpdRemainingConfirmed?: boolean;
  billingActive?: string;
  projectTier?: string;
  spendCap?: string;
}): string[] {
  const out: string[] = [];
  const posInt = (v: number | undefined) => typeof v === "number" && Number.isInteger(v) && v > 0;
  if (!posInt(r.maxRpm))
    out.push("--max-rpm must be the project's active RPM limit for the model (a positive integer).");
  if (!posInt(r.maxTpm))
    out.push("--max-tpm must be the project's active TPM limit for the model (a positive integer).");
  if (!posInt(r.maxRpd))
    out.push("--max-rpd must be the project's active RPD limit for the model (a positive integer).");
  if (r.rpdRemainingConfirmed !== true)
    out.push("--confirm-rpd-remaining is required: confirm today's REMAINING requests cover the plan.");
  if (r.billingActive !== "yes")
    out.push("--billing-active yes is required (an active billing account is linked).");
  if (!r.projectTier?.trim()) out.push("--project-tier is required (as shown in AI Studio).");
  if (!r.spendCap?.trim()) out.push('--spend-cap is required (the project spend cap, or "none").');
  return out;
}

/** Pacing + token/day preflight from the declared limits. Throws (nothing sent) when the plan does not fit. */
export function planQuota(
  quota: CalibrationQuota,
  plannedAnalysisRequests: number,
  perRequest: Array<{ inputTokens: number; maxOutputTokens: number }>,
): CalibrationQuotaPlan {
  for (const [k, v] of Object.entries(quota))
    if (!Number.isInteger(v) || v <= 0)
      throw new Error(`Calibration needs a positive integer ${k}; nothing was sent.`);
  const effectiveRpm = Math.floor(quota.maxRpm * CALIBRATION_RUN_CONTROL.rpmSafety);
  if (effectiveRpm < 1)
    throw new Error(`An RPM limit of ${quota.maxRpm} leaves no paced request per minute; nothing was sent.`);
  const minIntervalMs = Math.ceil(60_000 / effectiveRpm);
  const maxInputTokensPerRequest = Math.max(0, ...perRequest.map((p) => p.inputTokens));
  const maxTokensPerRequest = Math.max(0, ...perRequest.map((p) => p.inputTokens + p.maxOutputTokens));
  const worstCaseTokensPerMinute = Math.min(effectiveRpm, plannedAnalysisRequests) * maxTokensPerRequest;
  if (worstCaseTokensPerMinute > quota.maxTpm)
    throw new Error(
      `At ${effectiveRpm} requests/min the worst case is ${worstCaseTokensPerMinute} tokens/min, above the TPM limit of ${quota.maxTpm}; nothing was sent.`,
    );
  if (plannedAnalysisRequests > quota.maxRpd)
    throw new Error(
      `The plan needs ${plannedAnalysisRequests} requests, above the RPD limit of ${quota.maxRpd}; nothing was sent.`,
    );
  return {
    ...quota,
    effectiveRpm,
    minIntervalMs,
    plannedAnalysisRequests,
    maxTokensPerRequest,
    maxInputTokensPerRequest,
    worstCaseTokensPerMinute,
  };
}

const usageComplete = (c: UsageCall) =>
  c.inputTokens != null && (c.outputTokens != null || c.thoughtsTokens != null);

/**
 * Runs the calibration under HARD ceilings: the number of provider requests and the worst-case dollar estimate are
 * computed up front and the run is refused before anything is sent if either would exceed its ceiling. One request
 * per fixture per trial; no correction requests (a malformed answer is graded as an error); no retry. A live run
 * (`live: true`) must declare the project's limits (`quota`): requests are then paced start to start, and the plan
 * must fit the TPM and RPD limits before anything is sent. The run aborts (and still returns its partial report) on
 * the first provider access failure (401/402/403/404), on the first 429, on `maxConsecutive5xx` consecutive 5xx
 * answers, on `maxConsecutiveIdentical400` consecutive identical 400s, or on a local ceiling.
 */
export async function runTemporalCalibration(args: {
  provider: ContinuityAnalysisProvider;
  fixtures?: readonly CalibrationFixture[];
  trials?: number;
  render?: (f: CalibrationFixture) => Promise<Uint8Array>;
  maxTransportCalls: number;
  maxUsd: number;
  now?: Date;
  live?: boolean;
  quota?: CalibrationQuota;
  /** Injected for tests; default wall clock and real sleep. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<CalibrationReport> {
  const fixtures = args.fixtures ?? TEMPORAL_FIXTURES;
  const trials = args.trials ?? CALIBRATION_ACCEPTANCE.trials;
  // the ceilings themselves must be real numbers: a NaN ceiling would make every comparison false (= no ceiling)
  if (!Number.isInteger(args.maxTransportCalls) || args.maxTransportCalls <= 0)
    throw new Error("Calibration needs a positive integer request ceiling; nothing was sent.");
  if (typeof args.maxUsd !== "number" || !Number.isFinite(args.maxUsd) || args.maxUsd <= 0)
    throw new Error("Calibration needs a positive, finite dollar ceiling; nothing was sent.");
  if (!Number.isInteger(trials) || trials <= 0)
    throw new Error("Calibration needs a positive integer trial count; nothing was sent.");
  if (args.live && !args.quota)
    throw new Error("A live calibration needs the project's declared RPM/TPM/RPD limits; nothing was sent.");
  const now = args.now ?? new Date();
  const clock = args.clock ?? (() => Date.now());
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const render = args.render ?? ((f) => renderFixture(f));
  const rendered = new Map<string, Uint8Array>();
  for (const f of fixtures) rendered.set(f.id, await render(f));

  // up-front ceilings (uploads count as requests too)
  const inputs = fixtures.map((f) => ({ f, input: fixtureInput(f, args.provider, rendered.get(f.id)!) }));
  const uploadsPerTrial = inputs.filter(
    ({ f }) => args.provider.videoTransfer?.(rendered.get(f.id)!.length) === "provider_file",
  ).length;
  const plannedCalls = (fixtures.length + uploadsPerTrial) * trials;
  if (plannedCalls > args.maxTransportCalls)
    throw new Error(
      `Calibration needs ${plannedCalls} provider requests, above the ceiling of ${args.maxTransportCalls}; nothing was sent.`,
    );
  // UNKNOWN cost blocks: every per-fixture estimate must be a finite, non-negative number (never `|| 0`)
  let perTrialUsd = 0;
  const perRequest: Array<{ inputTokens: number; maxOutputTokens: number }> = [];
  for (const { f, input } of inputs) {
    const est = args.provider.estimate(input, now);
    const usd = est.maxUsd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0)
      throw new Error(
        `Calibration cannot estimate the cost of fixture ${f.id} (estimate ${String(usd)}); unknown cost blocks the run. Nothing was sent.`,
      );
    perTrialUsd += usd;
    perRequest.push({ inputTokens: est.tokens.inputTokens, maxOutputTokens: est.tokens.maxOutputTokens });
  }
  const estimatedMaxUsd = perTrialUsd * trials;
  if (estimatedMaxUsd > args.maxUsd)
    throw new Error(
      `Calibration's worst-case estimate $${estimatedMaxUsd.toFixed(4)} exceeds the ceiling of $${args.maxUsd}; nothing was sent.`,
    );
  const quota = args.quota ? planQuota(args.quota, fixtures.length * trials, perRequest) : null;

  const out: CalibrationTrial[] = [];
  const calls: UsageCall[] = [];
  const counts = { transport: 0, upload: 0, analysis: 0, correction: 0 };
  let abort: CalibrationReport["abort"] = null;
  let consecutive5xx = 0;
  let identical400 = { signature: "", count: 0 };
  let lastStart: number | null = null;
  const files: string[] = [];
  try {
    run: for (let t = 1; t <= trials; t++) {
      for (const { f, input } of inputs) {
        const batch = input.plan.batches[0]!;
        try {
          const res = await args.provider.analyzeBatch({
            batch,
            input,
            media: new Map([["video", { inputId: "video", mime: "video/mp4", bytes: rendered.get(f.id)! }]]),
            ctx: {
              now: () => now,
              sleep: async () => undefined,
              canCorrect: () => false,
              onProviderFile: (ref) => void files.push(ref),
              beforeTransportCall: async ({ kind }) => {
                if (counts.transport >= args.maxTransportCalls)
                  throw new AnalysisBatchError(
                    "local_policy_block",
                    "ceiling",
                    "Calibration request ceiling reached.",
                  );
                // start-to-start pacing of generation requests at the declared, safety-margined RPM
                if (quota && kind !== "upload") {
                  if (lastStart != null) {
                    const wait = lastStart + quota.minIntervalMs - clock();
                    if (wait > 0) await sleep(wait);
                  }
                  lastStart = clock();
                }
                counts.transport += 1;
                counts[kind] += 1;
              },
            },
          });
          calls.push(...res.calls);
          consecutive5xx = 0;
          identical400 = { signature: "", count: 0 };
          out.push({
            ...gradeTrial(f, res.findings.find((x) => x.criterionKey === f.criterion) ?? null),
            trial: t,
          });
        } catch (err) {
          const e = err instanceof AnalysisBatchError ? err : null;
          if (e) calls.push(...e.calls);
          // the transport already sanitizes; redacted again here because this text lands in the written report
          const message = err instanceof Error ? redactText(err.message).slice(0, 200) : "error";
          const status = e?.httpStatus ?? null;
          const access = providerAccessFailure(status);
          // an account/project failure is never filed as the fixture's `invalid_input`
          const category = access ?? e?.category ?? "error";
          out.push({
            ...gradeTrial(f, null),
            trial: t,
            note: message,
            httpStatus: status,
            errorCategory: category,
          });
          consecutive5xx = status != null && status >= 500 ? consecutive5xx + 1 : 0;
          if (status === 400) {
            const signature = http400Signature(status, category, message);
            identical400 =
              signature === identical400.signature
                ? { signature, count: identical400.count + 1 }
                : { signature, count: 1 };
          } else identical400 = { signature: "", count: 0 };
          const at = { httpStatus: status, category, message, fixture: f.id, trial: t };
          if (e?.category === "local_policy_block") abort = { reason: "local_policy", ...at };
          else if (access) abort = { reason: access, ...at };
          else if (CALIBRATION_RUN_CONTROL.abortOnHttp429 && status === 429)
            abort = { reason: http429Reason(message), ...at };
          else if (consecutive5xx >= CALIBRATION_RUN_CONTROL.maxConsecutive5xx)
            abort = { reason: "provider_unavailable", ...at };
          else if (identical400.count >= CALIBRATION_RUN_CONTROL.maxConsecutiveIdentical400)
            abort = { reason: "request_contract_invalid", ...at };
          if (abort) break run;
        }
      }
    }
  } finally {
    if (files.length && args.provider.cleanupFiles) await args.provider.cleanupFiles(files);
  }

  const status: CalibrationRunStatus =
    abort == null
      ? "completed"
      : abort.reason === "local_policy"
        ? "aborted_local_policy"
        : "aborted_provider";
  const graded = acceptance(out);
  const accepted = Object.fromEntries(
    Object.entries(graded).map(([c, ok]) => [c, status === "completed" && ok]),
  ) as Record<CalibrationCriterion, boolean>;
  const verdicts = Object.fromEntries(
    (Object.keys(accepted) as CalibrationCriterion[]).map((c) => {
      const mine = out.filter((t) => t.criterion === c);
      // deliberate: `every` on an EMPTY list is true, so a criterion the run never reached before a provider abort is
      // "not measured"; one genuine model answer makes it "incomplete"
      const v: CriterionVerdict =
        status === "aborted_provider" && mine.every((t) => t.result === "error")
          ? "not_measured_provider_error"
          : status !== "completed"
            ? "not_accepted_incomplete"
            : accepted[c]
              ? "accepted"
              : mine.some((t) => t.result !== "error" && !t.correct)
                ? "not_accepted_incorrect"
                : "not_accepted_provider_errors";
      return [c, v];
    }),
  ) as Record<CalibrationCriterion, CriterionVerdict>;

  // cost: never a partial sum presented as the total
  const generationAttempts = counts.analysis + counts.correction;
  const reported = calls.filter(usageComplete);
  const priced = (cs: UsageCall[]) => (cs.length ? args.provider.actualCost(cs, now).amountUsd : 0);
  const totalKnown =
    generationAttempts > 0 && calls.length === generationAttempts && reported.length === calls.length;
  const actualUsd = generationAttempts === 0 ? 0 : totalKnown ? priced(calls) : null;
  const costStatus: CalibrationReport["costStatus"] =
    generationAttempts === 0 ? "none_sent" : actualUsd == null ? "unknown" : "known";
  const knownUsageUsd = priced(reported);
  const sum = (k: "inputTokens" | "outputTokens" | "thoughtsTokens") =>
    reported.reduce((n, c) => n + (c[k] ?? 0), 0);

  return {
    version: CALIBRATION_VERSION,
    analyzer: args.provider.id,
    analyzerVersion: args.provider.version,
    model: args.provider.model,
    sampling: TEMPORAL_SAMPLING_V1.id,
    status,
    abort,
    trials: out,
    trialsPlanned: fixtures.length * trials,
    trialsAttempted: out.length,
    trialsUnattempted: fixtures.length * trials - out.length,
    trialsUnanswered: out.filter((t) => t.result === "error").length,
    trialsRejected: out.filter((t) => t.result === "error" && t.httpStatus != null).length,
    answersReceived: calls.length,
    transportCalls: counts.transport,
    uploadAttempts: counts.upload,
    analysisAttempts: counts.analysis,
    correctionAttempts: counts.correction,
    usageReportedCalls: reported.length,
    estimatedMaxUsd: Math.round(estimatedMaxUsd * 1e6) / 1e6,
    actualUsd,
    costStatus,
    knownUsageUsd,
    reportedTokens: {
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      thoughtsTokens: sum("thoughtsTokens"),
    },
    quota,
    accepted,
    verdicts,
    lipSyncCapable: accepted.lip_sync,
  };
}
