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
export const CALIBRATION_VERSION = "temporal-calibration-v1";

export type CalibrationCriterion =
  | "camera_movement"
  | "screen_direction"
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
  /** Pre-registered correct answer. "fail" accepts fail OR warn (a clear conflict may be reported as a deviation). */
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
  {
    id: "direction-left-to-right",
    criterion: "screen_direction",
    description: "A red square proxy moves from frame left to frame right.",
    expected: "The red subject moves left to right (exits screen-right)",
    correct: "pass",
    durationMs: D * 1000,
    video: `${bg}[b];${box("red")}[s];[b][s]overlay=x='t/${D}*${W - 70}':y=145`,
  },
  {
    id: "direction-reversed",
    criterion: "screen_direction",
    description: "Reverse control: the red square moves right to left.",
    expected: "The red subject moves left to right (exits screen-right)",
    correct: "fail",
    durationMs: D * 1000,
    video: `${bg}[b];${box("red")}[s];[b][s]overlay=x='${W - 70}-t/${D}*${W - 70}':y=145`,
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
  action_continuity: "video_temporal",
  forbidden_action: "video_temporal",
  geography: "video_temporal",
  lip_sync: "lip_sync",
};
const CATEGORY: Record<CalibrationCriterion, ContinuityCategory> = {
  camera_movement: "camera",
  screen_direction: "screen_direction",
  action_continuity: "action_continuity",
  forbidden_action: "action_continuity",
  geography: "geography",
  lip_sync: "lip_sync",
};

/** Renders one fixture to MP4 bytes with ffmpeg (argument arrays only, no shell); deterministic flags. */
export async function renderFixture(f: CalibrationFixture, ffmpeg = "ffmpeg"): Promise<Uint8Array> {
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
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const media: AnalysisMedia[] = [
    {
      inputId: "video",
      kind: "video",
      role: "output_video",
      label: "Calibration clip",
      assetId: `calibration:${f.id}`,
      checksum,
      mime: "video/mp4",
      width: W,
      height: H,
      byteSize: bytes.length,
      durationMs: f.durationMs,
      atMs: null,
    },
  ];
  const criterion = {
    key: f.criterion,
    category: CATEGORY[f.criterion],
    severity: "major" as const,
    title: f.criterion,
    sourceRef: CALIBRATION_VERSION,
    expected: f.expected,
    handler: "analyzer" as const,
    capability: CAPABILITY[f.criterion],
    position: 0,
  };
  // calibration measures what the analyzer CAN do: lip sync is offered to it here (and only here) so the gate
  // can be evaluated; production never plans lip sync until this calibration passes
  const view = provider.plannerView();
  const plan = buildAnalysisPlan({
    analyzer: {
      ...view,
      videoCapabilities: [...new Set([...view.videoCapabilities, CAPABILITY[f.criterion]])],
    },
    criteria: [criterion],
    media,
    directVideoAllowed: true,
    sampling: TEMPORAL_SAMPLING_V1,
  });
  return {
    version: 1,
    runKey: `${CALIBRATION_VERSION}:${f.id}`,
    attemptId: `calibration:${f.id}`,
    subjectAssetId: `calibration:${f.id}`,
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
}

export interface CalibrationReport {
  version: string;
  analyzer: string;
  analyzerVersion: string;
  model: string;
  sampling: string;
  trials: CalibrationTrial[];
  transportCalls: number;
  estimatedMaxUsd: number;
  actualUsd: number | null;
  /** Per criterion: did EVERY fixture meet the pre-registered rule? */
  accepted: Record<CalibrationCriterion, boolean>;
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
  const correct =
    f.correct === "pass" ? finding.result === "pass" : finding.result === "fail" || finding.result === "warn";
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
 * Runs the calibration under HARD ceilings: the number of provider requests and the worst-case dollar estimate are
 * computed up front and the run is refused before anything is sent if either would exceed its ceiling. One request
 * per fixture per trial; no correction requests (a malformed answer is graded as an error).
 */
export async function runTemporalCalibration(args: {
  provider: ContinuityAnalysisProvider;
  fixtures?: readonly CalibrationFixture[];
  trials?: number;
  render?: (f: CalibrationFixture) => Promise<Uint8Array>;
  maxTransportCalls: number;
  maxUsd: number;
  now?: Date;
}): Promise<CalibrationReport> {
  const fixtures = args.fixtures ?? TEMPORAL_FIXTURES;
  const trials = args.trials ?? CALIBRATION_ACCEPTANCE.trials;
  const now = args.now ?? new Date();
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
  const estimatedMaxUsd =
    inputs.reduce((n, { input }) => n + (args.provider.estimate(input, now).maxUsd || 0), 0) * trials;
  if (!Number.isFinite(estimatedMaxUsd) || estimatedMaxUsd > args.maxUsd)
    throw new Error(
      `Calibration's worst-case estimate $${estimatedMaxUsd.toFixed(4)} exceeds the ceiling of $${args.maxUsd}; nothing was sent.`,
    );

  const out: CalibrationTrial[] = [];
  const calls: UsageCall[] = [];
  let transportCalls = 0;
  const files: string[] = [];
  try {
    for (let t = 1; t <= trials; t++) {
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
              beforeTransportCall: async () => {
                if (transportCalls >= args.maxTransportCalls)
                  throw new AnalysisBatchError(
                    "local_policy_block",
                    "ceiling",
                    "Calibration request ceiling reached.",
                  );
                transportCalls += 1;
              },
            },
          });
          calls.push(...res.calls);
          out.push({
            ...gradeTrial(f, res.findings.find((x) => x.criterionKey === f.criterion) ?? null),
            trial: t,
          });
        } catch (err) {
          if (err instanceof AnalysisBatchError) calls.push(...err.calls);
          if (err instanceof AnalysisBatchError && err.category === "local_policy_block") throw err;
          out.push({
            ...gradeTrial(f, null),
            trial: t,
            note: err instanceof Error ? err.message.slice(0, 200) : "error",
          });
        }
      }
    }
  } finally {
    if (files.length && args.provider.cleanupFiles) await args.provider.cleanupFiles(files);
  }
  const accepted = acceptance(out);
  return {
    version: CALIBRATION_VERSION,
    analyzer: args.provider.id,
    analyzerVersion: args.provider.version,
    model: args.provider.model,
    sampling: TEMPORAL_SAMPLING_V1.id,
    trials: out,
    transportCalls,
    estimatedMaxUsd: Math.round(estimatedMaxUsd * 1e6) / 1e6,
    actualUsd: calls.length ? args.provider.actualCost(calls, now).amountUsd : 0,
    accepted,
    lipSyncCapable: accepted.lip_sync,
  };
}
