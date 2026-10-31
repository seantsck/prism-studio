import { createHash } from "node:crypto";
import {
  buildSequencePlan,
  sequenceInputSide,
  transitionInputProblem,
} from "@/domain/continuity/analysis/sequence-plan";
import type {
  AnalysisFindingResult,
  NormalizedFinding,
  TransitionContinuityAnalysisInput,
} from "@/domain/continuity/analysis/types";
import {
  CUT_EDGE_POLICY,
  firstDisplayedFrameMs,
  lastDisplayedFrameMs,
  leftEdgeWindow,
  rightEdgeWindow,
  SEMANTIC_CUT_FAMILIES,
  SEQUENCE_RULES_VERSION,
  type CutCriterion,
  type CutTransition,
  type SemanticCutFamily,
} from "@/domain/continuity/sequence";
import { DEFAULT_EDIT_RATE } from "@/domain/edit/edit-rate";
import type { EpisodeEditView } from "@/domain/edit/view";
import type { Asset, ProjectData } from "@/domain/schemas";
import { redactText } from "@/lib/auth/redact";
import type { MediaProcessor } from "@/media/types";
import { AnalysisBatchError, type ContinuityAnalysisProvider, type UsageCall } from "../analysis/provider";
import { buildTransitionInput, clipTransfer, type EdgeAssets } from "../sequence-review";
import {
  FAMILY_CRITERIA,
  INTER_SCENE_CONTROL_FAMILIES,
  SEQUENCE_CALIBRATION_ACCEPTANCE,
  SEQUENCE_CALIBRATION_PLAN,
  SEQUENCE_CALIBRATION_VERSION,
  SEQUENCE_FIXTURES,
  sequenceCalibrationDefinition,
  sequenceDefinitionHash,
  sequenceInputHash,
  type SequenceCalibrationFixture,
  type SequenceFixtureChecksums,
  type SequenceRenderSpec,
} from "./sequence-fixtures";
import {
  CALIBRATION_RUN_CONTROL,
  http400Signature,
  http429Reason,
  planQuota,
  providerAccessFailure,
  renderFixture,
  type CalibrationQuota,
  type CalibrationQuotaPlan,
  type ProviderAccessFailure,
} from "./temporal-calibration";

/**
 * The Sequence Continuity calibration runner (Phase 3A.4E). It runs the REAL path over the frozen fixtures: render each
 * parent, derive both edges with the production `extractWindow` / `extractFrame` under `cut-edge-static-v1`, build the
 * production `TransitionContinuityAnalysisInput` with `buildTransitionInput`, and call the provider's real
 * `analyzeBatch` (prompt, provider-facing schema, sided validation, one schema correction). Ordinary CI uses a fake
 * transport; a live run is a separate, explicitly authorised gate (`sequence-calibration-cli.ts`).
 *
 * The run produces EVIDENCE. Nothing here touches `GEMINI_CROSS_CUT_ACCEPTED_FAMILIES`: enabling a production family is
 * a separate reviewed source change. It needs no database, Project or Storage.
 */

/**
 * The reviewed input hash and the ffmpeg build that produces it. A live run refuses any other computed hash: another
 * build, recipe or truth is another experiment. Updating these is a reviewed source change, and after a live run it is
 * only allowed with a new calibration version.
 */
export const SEQUENCE_CALIBRATION_PREREGISTERED = {
  inputHash: "14c679499d38c5cad5ea6c91bba8ebe1073e1c579681cba0049318d4e5509f95",
  definitionHash: "8852f8e720c8980e767da0609567a9bc91fa666fd4661856581c290da75fbb7f",
  ffmpegVersion: "9.0.1-full_build-www.gyan.dev",
} as const;

/**
 * RUN CONTROL, fixed before any live run and never tuned on answers. 3A.3's rules apply unchanged (first 401/402/403/404
 * or 429 aborts; 3 consecutive 5xx abort; 2 consecutive identical 400s abort as `request_contract_invalid`; pacing at
 * 80% of the declared RPM). A timeout or network failure is an ambiguous, possibly billed attempt: it is recorded as
 * not answered, NEVER retried, and `maxConsecutiveOutcomeUnknown` of them abort instead of sending into an outage.
 */
export const SEQUENCE_RUN_CONTROL = { ...CALIBRATION_RUN_CONTROL, maxConsecutiveOutcomeUnknown: 3 } as const;

// ───────────────────────── media ─────────────────────────

export interface EdgeMediaFile {
  bytes: Uint8Array;
  mime: string;
  checksum: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export interface SequenceEdgeSide {
  parentChecksum: string;
  sourceInMs: number;
  sourceOutMs: number;
  window: { startMs: number; endMs: number };
  stillAtMs: number;
  clip: EdgeMediaFile;
  still: EdgeMediaFile;
  /** Set when the clip kept an audio stream (never for the production extraction). */
  clipHasAudio: boolean;
}

export interface SequenceEdgePair {
  left: SequenceEdgeSide;
  right: SequenceEdgeSide;
}

export type SequenceMaterials = ReadonlyMap<string, SequenceEdgePair>;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const file = (
  bytes: Uint8Array,
  mime: string,
  width: number | null,
  height: number | null,
  durationMs: number | null,
): EdgeMediaFile => ({ bytes, mime, checksum: sha256(bytes), width, height, durationMs });

/**
 * One side's exact edge media, by the production rules: the window and the still position come from the production
 * functions; the clip from `extractWindow`, the still from the PARENT via `extractFrame`.
 */
export async function deriveEdgeSide(args: {
  which: "left" | "right";
  parent: Uint8Array;
  sourceInMs: number;
  sourceOutMs: number;
  processor: Pick<MediaProcessor, "extractWindow" | "extractFrame">;
}): Promise<SequenceEdgeSide> {
  const { which, parent, sourceInMs, sourceOutMs, processor } = args;
  const window =
    which === "left" ? leftEdgeWindow(sourceInMs, sourceOutMs) : rightEdgeWindow(sourceInMs, sourceOutMs);
  const stillAtMs =
    which === "left"
      ? lastDisplayedFrameMs(sourceInMs, sourceOutMs, DEFAULT_EDIT_RATE)
      : firstDisplayedFrameMs(sourceInMs);
  const clip = await processor.extractWindow(parent, window.startMs, window.endMs);
  const still = await processor.extractFrame(parent, stillAtMs);
  const p = clip.probe;
  return {
    parentChecksum: sha256(parent),
    sourceInMs,
    sourceOutMs,
    window,
    stillAtMs: still.atMs,
    clip: file(clip.bytes, clip.mime, p.width, p.height, p.durationMs),
    still: file(still.bytes, still.mime, still.width, still.height, null),
    clipHasAudio: p.hasAudio === true,
  };
}

/** Renders every parent and derives every edge. Local only; nothing leaves the process. */
export async function prepareSequenceMaterials(args: {
  processor: Pick<MediaProcessor, "extractWindow" | "extractFrame">;
  fixtures?: readonly SequenceCalibrationFixture[];
  render?: (id: string, spec: SequenceRenderSpec) => Promise<Uint8Array>;
}): Promise<Map<string, SequenceEdgePair>> {
  const render = args.render ?? ((id, s) => renderFixture({ id, ...s }));
  const out = new Map<string, SequenceEdgePair>();
  for (const f of args.fixtures ?? SEQUENCE_FIXTURES) {
    const [leftParent, rightParent] = [await render(`${f.id}-a`, f.left), await render(`${f.id}-b`, f.right)];
    out.set(f.id, {
      left: await deriveEdgeSide({
        which: "left",
        parent: leftParent,
        sourceInMs: f.cut.left.inMs,
        sourceOutMs: f.cut.left.outMs,
        processor: args.processor,
      }),
      right: await deriveEdgeSide({
        which: "right",
        parent: rightParent,
        sourceInMs: f.cut.right.inMs,
        sourceOutMs: f.cut.right.outMs,
        processor: args.processor,
      }),
    });
  }
  return out;
}

export const materialChecksums = (materials: SequenceMaterials): Record<string, SequenceFixtureChecksums> =>
  Object.fromEntries(
    [...materials].map(([id, m]) => [
      id,
      {
        leftParent: m.left.parentChecksum,
        rightParent: m.right.parentChecksum,
        leftClip: m.left.clip.checksum,
        rightClip: m.right.clip.checksum,
        leftStill: m.left.still.checksum,
        rightStill: m.right.still.checksum,
      },
    ]),
  );

// ───────────────────────── the production input ─────────────────────────

/** The calibration-only family set. The production registry never passes it (a test proves that). */
export const sequenceCalibrationIdentity = () => ({
  version: SEQUENCE_CALIBRATION_VERSION,
  acceptedFamilies: [...SEMANTIC_CUT_FAMILIES] as readonly string[],
});

const asAsset = (id: string, f: EdgeMediaFile) =>
  ({
    id,
    checksum: f.checksum,
    mime: f.mime,
    width: f.width,
    height: f.height,
    byteSize: f.bytes.length,
    durationMs: f.durationMs,
  }) as Asset;

const criterionOf = (
  family: SemanticCutFamily,
  applicability: "applies" | "n_a" = "applies",
): CutCriterion => ({
  ...FAMILY_CRITERIA[family],
  handler: "analyzer",
  family,
  applicability,
  intentCoverable: true,
  position: 0,
});

/**
 * One cut's production input: `buildTransitionInput` itself (the media ids, labels, plan, versions and calibration
 * identity are production's), over a cut assembled from the fixture. It reads only the fields set here, and the labels
 * and refs carry no truth: the shot codes are "A" and "B" and every id is a neutral ordinal.
 */
export function buildCutInput(args: {
  /** neutral, never derived from fixture text (it does not reach the prompt either way) */
  ref: string;
  criterion: CutCriterion;
  edge: SequenceEdgePair;
  provider: ContinuityAnalysisProvider;
}): TransitionContinuityAnalysisInput {
  const { ref, edge, provider } = args;
  const sideOf = (which: "left" | "right", s: SequenceEdgeSide, index: number) => ({
    itemId: `${ref}:${which}:item`,
    index,
    shotId: `${ref}:${which}:shot`,
    shotCode: which === "left" ? "A" : "B",
    picture: {
      kind: "video",
      assetId: `${ref}:${which}:parent`,
      assetChecksum: s.parentChecksum,
      sourceInMs: s.sourceInMs,
      sourceOutMs: s.sourceOutMs,
    },
    window: { ...s.window, durationMs: s.window.endMs - s.window.startMs },
    still: { atMs: s.stillAtMs },
    references: [],
  });
  const cut = {
    address: { editId: ref, leftItemId: `${ref}:left:item`, rightItemId: `${ref}:right:item` },
    transitionKey: ref,
    left: sideOf("left", edge.left, 0),
    right: sideOf("right", edge.right, 1),
    criteria: [args.criterion],
    truth: {
      subjectFingerprint: `${ref}:subject`,
      leftSubjectFingerprint: `${ref}:left`,
      rightSubjectFingerprint: `${ref}:right`,
      criteriaFingerprint: `${ref}:criteria`,
      referenceFingerprint: `${ref}:references`,
      rulesVersion: SEQUENCE_RULES_VERSION,
    },
  } as unknown as CutTransition;
  const view = {
    edit: { episodeId: ref, revision: 1 },
    items: [
      { timing: { startMs: 0 } },
      { timing: { startMs: edge.left.sourceOutMs - edge.left.sourceInMs } },
    ],
  } as unknown as EpisodeEditView;
  const data = { assets: [], bible: { aspectRatio: "16:9" } } as unknown as ProjectData;
  const edgeOf = (which: "left" | "right", s: SequenceEdgeSide): EdgeAssets => ({
    clip: asAsset(`${ref}:${which}:clip`, s.clip),
    still: asAsset(`${ref}:${which}:still`, s.still),
  });
  const input = buildTransitionInput({
    cut,
    view,
    data,
    provider,
    directVideoAllowed: true,
    edge: { left: edgeOf("left", edge.left), right: edgeOf("right", edge.right) },
    runKey: ref,
  });
  // the transfer method is frozen on the clip exactly as a confirmed review does; the adapter enforces it
  for (const m of input.media)
    if (m.kind === "video" && m.edge) m.edge.transfer = clipTransfer(provider, m.byteSize, true);
  return input;
}

export const fixtureInput = (
  f: SequenceCalibrationFixture,
  index: number,
  edge: SequenceEdgePair,
  provider: ContinuityAnalysisProvider,
) =>
  buildCutInput({
    ref: `${SEQUENCE_CALIBRATION_VERSION}:cut-${index + 1}`,
    criterion: criterionOf(f.family),
    edge,
    provider,
  });

export const edgeMediaMap = (edge: SequenceEdgePair) =>
  new Map(
    (
      [
        ["left:clip", edge.left.clip],
        ["right:clip", edge.right.clip],
        ["left:last", edge.left.still],
        ["right:first", edge.right.still],
      ] as const
    ).map(([inputId, f]) => [inputId as string, { inputId, mime: f.mime, bytes: f.bytes }]),
  );

/**
 * The Scene-boundary PLANNER control: Prism's `n_a` criteria through the real sequence planner with every family
 * trusted. It sends nothing and is never graded; it does not count toward the plan.
 */
export function interSceneControl(
  provider: ContinuityAnalysisProvider,
  edge: SequenceEdgePair,
  criteria: readonly CutCriterion[] = INTER_SCENE_CONTROL_FAMILIES.map((f) => criterionOf(f, "n_a")),
) {
  const media = buildCutInput({
    ref: `${SEQUENCE_CALIBRATION_VERSION}:inter-scene-control`,
    criterion: criterionOf("screen_direction"),
    edge,
    provider,
  }).media;
  const plan = buildSequencePlan({
    analyzer: provider.plannerView(),
    criteria,
    media,
    referenceUses: {},
    directVideoAllowed: true,
  });
  return {
    requests: plan.batches.length,
    criteria: plan.items.map((i) => ({ key: i.criterionKey, status: i.status })),
    prismOwnedNa: plan.items.every((i) => i.status === "not_applicable"),
  };
}

// ───────────────────────── grading ─────────────────────────

export type SequenceWindowGrade = "not_applicable" | "inside" | "outside";

export interface SequenceTrial {
  fixture: string;
  family: SemanticCutFamily;
  control: "positive" | "conflict";
  trial: number;
  expected: "pass" | "fail";
  result: AnalysisFindingResult | "error";
  correct: boolean;
  evidence: Array<{
    input: string;
    side: "left" | "right" | null;
    atMs: number | null;
    endMs: number | null;
  }>;
  bothSides: boolean;
  windowGrade: SequenceWindowGrade;
  correctionUsed: boolean;
  /** Set when a correction was used and whether its answer then validated. */
  correctionValidated: boolean | null;
  providerRef: string | null;
  note: string;
  httpStatus?: number | null;
  errorCategory?: string;
}

/** Clip-local time of one evidence item (a still sits at its own instant in the clip). Null = no time. */
function localInterval(
  e: NormalizedFinding["evidence"][number],
  edge: SequenceEdgePair,
): [number, number] | null {
  if (e.input === "left:clip" || e.input === "right:clip") {
    if (e.atMs == null) return null;
    return [e.atMs, e.endMs ?? e.atMs];
  }
  const side = e.input === "left:last" ? edge.left : e.input === "right:first" ? edge.right : null;
  if (!side) return null;
  const at = side.stillAtMs - side.window.startMs;
  return [at, at];
}

/** Every windowed side needs one cited edge input entirely inside its window ± the frozen tolerance. */
export function gradeEvidenceWindows(
  f: Pick<SequenceCalibrationFixture, "evidenceWindows">,
  finding: Pick<NormalizedFinding, "evidence">,
  edge: SequenceEdgePair,
): SequenceWindowGrade {
  if (!f.evidenceWindows) return "not_applicable";
  const tol = SEQUENCE_CALIBRATION_ACCEPTANCE.eventToleranceMs;
  for (const side of ["left", "right"] as const) {
    const w = f.evidenceWindows[side];
    if (!w) continue;
    const hit = finding.evidence.some((e) => {
      if (sequenceInputSide(e.input) !== side) return false;
      const t = localInterval(e, edge);
      return t != null && t[0] >= w[0] - tol && t[1] <= w[1] + tol;
    });
    if (!hit) return "outside";
  }
  return "inside";
}

/** Grades one answer against the frozen truth. `warn` on a conflict, `unchecked` and errors are never correct. */
export function gradeSequenceTrial(
  f: SequenceCalibrationFixture,
  finding: NormalizedFinding | null,
  edge: SequenceEdgePair,
): Pick<
  SequenceTrial,
  | "fixture"
  | "family"
  | "control"
  | "expected"
  | "result"
  | "correct"
  | "evidence"
  | "bothSides"
  | "windowGrade"
  | "note"
> {
  const base = { fixture: f.id, family: f.family, control: f.control, expected: f.correct };
  if (!finding)
    return {
      ...base,
      result: "error",
      correct: false,
      evidence: [],
      bothSides: false,
      windowGrade: f.evidenceWindows ? "outside" : "not_applicable",
      note: "no answer",
    };
  const evidence = finding.evidence.map((e) => ({
    input: e.input,
    side: sequenceInputSide(e.input),
    atMs: e.atMs,
    endMs: e.endMs ?? null,
  }));
  // the validator already refuses a one-sided judgement; graded again here because this is the acceptance boundary
  const edgeOf = (side: "left" | "right") =>
    evidence.some((e) => e.side === side && !e.input.startsWith("ref:"));
  const bothSides = edgeOf("left") && edgeOf("right");
  const windowGrade = gradeEvidenceWindows(f, finding, edge);
  return {
    ...base,
    result: finding.result,
    correct: finding.result === f.correct && bothSides && windowGrade !== "outside",
    evidence,
    bothSides,
    windowGrade,
    note: redactText(finding.summary).slice(0, 200),
  };
}

// ───────────────────────── report ─────────────────────────

export type SequenceRunStatus = "completed" | "aborted_provider" | "aborted_local_policy";
export type SequenceFamilyDecision = "accepted" | "rejected" | "not_measured";

export interface SequenceFamilyReport {
  decision: SequenceFamilyDecision;
  /** Why: the same vocabulary as the 3A.3 report. */
  verdict:
    | "accepted"
    | "not_accepted_incomplete"
    | "not_measured_provider_error"
    | "not_accepted_incorrect"
    | "not_accepted_provider_errors";
  correct: number;
  required: number;
  corrections: number;
  /** Any correction in this family: the owner reviews it before production enablement. */
  ownerReviewRequired: boolean;
}

export interface SequenceCostEstimate {
  /** Per fixture, one trial (the estimator's worst case includes the one correction). */
  perFixture: Array<{
    fixture: string;
    expectedUsd: number;
    maxUsd: number;
    inputTokens: number;
    maxOutputTokens: number;
  }>;
  expectedUsd: number;
  worstCaseUsd: number;
  worstCaseTransportRequests: number;
  estimatedInputTokens: number;
  pricingVersion: string;
}

export interface SequenceCalibrationReport {
  version: string;
  /** "fake": no request left Prism, and every usage and cost figure below is the fake transport's simulation. */
  transport: "live" | "fake";
  inputHash: string;
  definitionHash: string;
  matchesPreregisteredHash: boolean;
  date: string;
  analyzer: string;
  analyzerVersion: string;
  model: string;
  prompt: string;
  rubric: string;
  schema: number;
  edgePolicy: string;
  fps: number;
  fixtureCount: number;
  trialsPerFixture: number;
  plannedQualityRequests: number;
  transportCeiling: number;
  acceptance: typeof SEQUENCE_CALIBRATION_ACCEPTANCE;
  fixtures: Array<
    Pick<SequenceCalibrationFixture, "id" | "family" | "control" | "description" | "correct" | "notes">
  >;
  interSceneControl: ReturnType<typeof interSceneControl>;
  status: SequenceRunStatus;
  abort: {
    reason:
      | "quota_or_billing_exhausted"
      | "quota_or_rate_limit"
      | "provider_unavailable"
      | "outcome_unknown_repeated"
      | ProviderAccessFailure
      | "request_contract_invalid"
      | "local_policy";
    httpStatus: number | null;
    category: string;
    message: string;
    fixture: string;
    trial: number;
  } | null;
  trials: SequenceTrial[];
  trialsPlanned: number;
  trialsAttempted: number;
  trialsUnattempted: number;
  trialsUnanswered: number;
  trialsRejected: number;
  answersReceived: number;
  transportCalls: number;
  uploadAttempts: number;
  analysisAttempts: number;
  correctionAttempts: number;
  corrections: Array<{ fixture: string; trial: number; validated: boolean }>;
  usageReportedCalls: number;
  estimate: SequenceCostEstimate;
  /** 0 only when no generation request left; the figure only when EVERY attempt reported usage; else null = UNKNOWN. */
  actualUsd: number | null;
  costStatus: "none_sent" | "known" | "unknown";
  /** A lower bound when `costStatus` is unknown. */
  knownUsageUsd: number | null;
  reportedTokens: { inputTokens: number; outputTokens: number; thoughtsTokens: number };
  quota: CalibrationQuotaPlan | null;
  families: Record<SemanticCutFamily, SequenceFamilyReport>;
  /** Always true: evidence for a separately reviewed source change. */
  productionConfigUnchanged: true;
}

const usageComplete = (c: UsageCall) =>
  c.inputTokens != null && (c.outputTokens != null || c.thoughtsTokens != null);

export function familyReports(
  trials: readonly SequenceTrial[],
  status: SequenceRunStatus,
  fixtures: readonly SequenceCalibrationFixture[] = SEQUENCE_FIXTURES,
): Record<SemanticCutFamily, SequenceFamilyReport> {
  const out = {} as Record<SemanticCutFamily, SequenceFamilyReport>;
  for (const family of SEMANTIC_CUT_FAMILIES) {
    const mine = trials.filter((t) => t.family === family);
    const passedEveryFixture = fixtures
      .filter((f) => f.family === family)
      .every(
        (f) =>
          mine.filter((t) => t.fixture === f.id && t.correct).length >=
          SEQUENCE_CALIBRATION_ACCEPTANCE.minCorrectPerFixture,
      );
    // deliberate: `every` on an EMPTY list is true, so a family the run never reached before a provider abort is "not
    // measured"; one genuine model answer makes it "incomplete"
    const verdict: SequenceFamilyReport["verdict"] =
      status === "aborted_provider" && mine.every((t) => t.result === "error")
        ? "not_measured_provider_error"
        : status !== "completed"
          ? "not_accepted_incomplete"
          : passedEveryFixture
            ? "accepted"
            : mine.some((t) => t.result !== "error" && !t.correct)
              ? "not_accepted_incorrect"
              : "not_accepted_provider_errors";
    const corrections = mine.filter((t) => t.correctionUsed).length;
    out[family] = {
      decision:
        verdict === "accepted"
          ? "accepted"
          : verdict === "not_measured_provider_error"
            ? "not_measured"
            : "rejected",
      verdict,
      correct: mine.filter((t) => t.correct).length,
      required: SEQUENCE_CALIBRATION_ACCEPTANCE.correctPerFamily,
      corrections,
      ownerReviewRequired: corrections > 0,
    };
  }
  return out;
}

/** What each fixture costs, from the real estimator on the real inputs. */
export function estimateSequenceCalibration(
  provider: ContinuityAnalysisProvider,
  materials: SequenceMaterials,
  now: Date,
  fixtures: readonly SequenceCalibrationFixture[] = SEQUENCE_FIXTURES,
): SequenceCostEstimate {
  const trials = SEQUENCE_CALIBRATION_PLAN.trials;
  let pricingVersion = "";
  const perFixture = fixtures.map((f, i) => {
    const e = provider.estimate(fixtureInput(f, i, materials.get(f.id)!, provider), now);
    if (!Number.isFinite(e.maxUsd) || e.maxUsd < 0 || !Number.isFinite(e.expectedUsd))
      throw new Error(
        `Calibration cannot estimate the cost of fixture ${f.id} (estimate ${String(e.maxUsd)}); unknown cost blocks the run. Nothing was sent.`,
      );
    pricingVersion = e.pricingVersion;
    return {
      fixture: f.id,
      expectedUsd: e.expectedUsd,
      maxUsd: e.maxUsd,
      inputTokens: e.tokens.inputTokens,
      maxOutputTokens: e.tokens.maxOutputTokens,
    };
  });
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    perFixture,
    expectedUsd: round(perFixture.reduce((n, p) => n + p.expectedUsd, 0) * trials),
    worstCaseUsd: round(perFixture.reduce((n, p) => n + p.maxUsd, 0) * trials),
    worstCaseTransportRequests: fixtures.length * trials * 2,
    estimatedInputTokens: perFixture.reduce((n, p) => n + p.inputTokens, 0) * trials,
    pricingVersion,
  };
}

/** Refusals before the first request. An empty list = the plan may run. */
export function inlineOnlyProblems(
  provider: ContinuityAnalysisProvider,
  materials: SequenceMaterials,
  fixtures: readonly SequenceCalibrationFixture[] = SEQUENCE_FIXTURES,
): string[] {
  const out: string[] = [];
  for (const f of fixtures) {
    const m = materials.get(f.id);
    if (!m) {
      out.push(`Fixture ${f.id} has no prepared media.`);
      continue;
    }
    for (const which of ["left", "right"] as const) {
      const size = m[which].clip.bytes.length;
      if (provider.videoTransfer?.(size) !== "inline")
        out.push(`Fixture ${f.id}'s ${which} clip (${size} bytes) would not be sent inline.`);
    }
  }
  return out;
}

/**
 * Runs the frozen plan under hard ceilings. Exactly one primary request per fixture per trial (60); the analyzer's one
 * correction may add a request only while the ceiling still leaves room for every remaining primary, so corrections can
 * never starve the plan. `maxTransportCalls` counts EVERY outbound request. Everything is refused before the first
 * request when it does not hold: the fixed plan, inline-only media, the production input contract, the worst-case
 * dollars and, live, the declared quota. No retry of any kind.
 */
export async function runSequenceCalibration(args: {
  provider: ContinuityAnalysisProvider;
  materials: SequenceMaterials;
  maxTransportCalls: number;
  maxUsd: number;
  now?: Date;
  live?: boolean;
  quota?: CalibrationQuota;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SequenceCalibrationReport> {
  const fixtures = SEQUENCE_FIXTURES;
  const { provider, materials } = args;
  const trials = SEQUENCE_CALIBRATION_PLAN.trials;
  const planned = fixtures.length * trials;
  if (planned !== SEQUENCE_CALIBRATION_PLAN.qualityRequests)
    throw new Error("The calibration plan is fixed at 60 quality requests; nothing was sent.");
  if (!Number.isInteger(args.maxTransportCalls) || args.maxTransportCalls < planned)
    throw new Error(`Calibration needs a request ceiling of at least ${planned}; nothing was sent.`);
  const ceiling = Math.min(args.maxTransportCalls, SEQUENCE_CALIBRATION_PLAN.maxTransportRequests);
  if (typeof args.maxUsd !== "number" || !Number.isFinite(args.maxUsd) || args.maxUsd <= 0)
    throw new Error("Calibration needs a positive, finite dollar ceiling; nothing was sent.");
  if (args.live && !args.quota)
    throw new Error("A live calibration needs the project's declared RPM/TPM/RPD limits; nothing was sent.");
  const now = args.now ?? new Date();
  const clock = args.clock ?? (() => Date.now());
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const inline = inlineOnlyProblems(provider, materials, fixtures);
  if (inline.length) throw new Error(`${inline.join(" ")} Calibration v1 is inline-only; nothing was sent.`);
  const inputs = fixtures.map((f, i) => {
    const edge = materials.get(f.id)!;
    const input = fixtureInput(f, i, edge, provider);
    const problem = transitionInputProblem(input);
    if (problem) throw new Error(`Fixture ${f.id}: ${problem} Nothing was sent.`);
    const batches = input.plan.batches;
    if (batches.length !== 1 || batches[0]!.mode !== "sequence_transition")
      throw new Error(
        `Fixture ${f.id} must plan exactly one sequence batch (${input.plan.items[0]?.reason ?? "no plan"}); nothing was sent.`,
      );
    return { f, edge, input, batch: batches[0]!, media: edgeMediaMap(edge) };
  });
  const estimate = estimateSequenceCalibration(provider, materials, now, fixtures);
  if (estimate.worstCaseUsd > args.maxUsd)
    throw new Error(
      `Calibration's worst-case estimate $${estimate.worstCaseUsd.toFixed(4)} exceeds the ceiling of $${args.maxUsd}; nothing was sent.`,
    );
  // the paced preflight uses the larger correction request and every request the ceiling allows
  const quota = args.quota
    ? planQuota(
        args.quota,
        ceiling,
        estimate.perFixture.map((p) => ({
          inputTokens: p.inputTokens + p.maxOutputTokens + 300,
          maxOutputTokens: p.maxOutputTokens,
        })),
      )
    : null;
  const checksums = materialChecksums(materials);
  const inputHash = sequenceInputHash(checksums);
  const definitionHash = sequenceDefinitionHash();

  const out: SequenceTrial[] = [];
  const calls: UsageCall[] = [];
  const counts = { transport: 0, upload: 0, analysis: 0, correction: 0 };
  let abort: SequenceCalibrationReport["abort"] = null;
  let consecutive5xx = 0;
  let consecutiveUnknown = 0;
  let identical400 = { signature: "", count: 0 };
  let lastStart: number | null = null;
  const priced = (cs: UsageCall[]) => (cs.length ? provider.actualCost(cs, now).amountUsd : 0);

  run: for (let t = 1; t <= trials; t++) {
    for (const { f, edge, input, batch, media } of inputs) {
      const ctx = {
        now: () => now,
        sleep: async () => undefined,
        canCorrect: () => counts.transport + (planned - counts.analysis) < ceiling,
        beforeTransportCall: async ({ kind }: { kind: "analysis" | "correction" | "upload" }) => {
          if (kind === "upload") {
            counts.upload += 1;
            throw new AnalysisBatchError(
              "local_policy_block",
              "calibration_upload",
              "Calibration v1 is inline-only: an upload was refused and nothing was sent.",
            );
          }
          if (counts.transport >= ceiling)
            throw new AnalysisBatchError(
              "local_policy_block",
              "ceiling",
              "Calibration request ceiling reached.",
            );
          // start-to-start pacing of every generation request at the declared, safety-margined RPM
          if (quota) {
            if (lastStart != null) {
              const wait = lastStart + quota.minIntervalMs - clock();
              if (wait > 0) await sleep(wait);
            }
            lastStart = clock();
          }
          counts.transport += 1;
          counts[kind] += 1;
        },
      };
      try {
        const res = await provider.analyzeBatch({ batch, input, media, ctx });
        calls.push(...res.calls);
        consecutive5xx = 0;
        consecutiveUnknown = 0;
        identical400 = { signature: "", count: 0 };
        const finding = res.findings.find((x) => x.criterionKey === batch.criterionKeys[0]) ?? null;
        out.push({
          ...gradeSequenceTrial(f, finding, edge),
          trial: t,
          correctionUsed: res.correctionUsed,
          correctionValidated: res.correctionUsed ? true : null,
          providerRef: res.providerRef ?? null,
        });
      } catch (err) {
        const e = err instanceof AnalysisBatchError ? err : null;
        if (e) calls.push(...e.calls);
        // the transport already sanitizes; redacted again here because this text lands in the written report
        const message = err instanceof Error ? redactText(err.message).slice(0, 200) : "error";
        const status = e?.httpStatus ?? null;
        const access = providerAccessFailure(status);
        const category = access ?? e?.category ?? "error";
        const correctionUsed = (e?.calls ?? []).some((c) => c.kind === "correction");
        out.push({
          ...gradeSequenceTrial(f, null, edge),
          trial: t,
          correctionUsed,
          correctionValidated: correctionUsed ? false : null,
          providerRef: null,
          note: message,
          httpStatus: status,
          errorCategory: category,
        });
        consecutive5xx = status != null && status >= 500 ? consecutive5xx + 1 : 0;
        consecutiveUnknown = e?.category === "outcome_unknown" ? consecutiveUnknown + 1 : 0;
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
        else if (SEQUENCE_RUN_CONTROL.abortOnHttp429 && status === 429)
          abort = { reason: http429Reason(message), ...at };
        else if (consecutive5xx >= SEQUENCE_RUN_CONTROL.maxConsecutive5xx)
          abort = { reason: "provider_unavailable", ...at };
        else if (consecutiveUnknown >= SEQUENCE_RUN_CONTROL.maxConsecutiveOutcomeUnknown)
          abort = { reason: "outcome_unknown_repeated", ...at };
        else if (identical400.count >= SEQUENCE_RUN_CONTROL.maxConsecutiveIdentical400)
          abort = { reason: "request_contract_invalid", ...at };
        if (abort) break run;
      }
      // the estimate gated the start; real usage above the ceiling stops the run too
      const spent = priced(calls.filter(usageComplete));
      if (spent != null && spent > args.maxUsd) {
        abort = {
          reason: "local_policy",
          httpStatus: null,
          category: "local_policy_block",
          message: `Known usage ($${spent}) passed the $${args.maxUsd} ceiling.`,
          fixture: f.id,
          trial: t,
        };
        break run;
      }
    }
  }

  const status: SequenceRunStatus =
    abort == null
      ? "completed"
      : (abort as NonNullable<typeof abort>).reason === "local_policy"
        ? "aborted_local_policy"
        : "aborted_provider";

  // cost: never a partial sum presented as the total
  const generationAttempts = counts.analysis + counts.correction;
  const reported = calls.filter(usageComplete);
  const totalKnown =
    generationAttempts > 0 && calls.length === generationAttempts && reported.length === calls.length;
  const actualUsd = generationAttempts === 0 ? 0 : totalKnown ? priced(calls) : null;
  const costStatus: SequenceCalibrationReport["costStatus"] =
    generationAttempts === 0 ? "none_sent" : actualUsd == null ? "unknown" : "known";
  const sum = (k: "inputTokens" | "outputTokens" | "thoughtsTokens") =>
    reported.reduce((n, c) => n + (c[k] ?? 0), 0);

  return {
    version: SEQUENCE_CALIBRATION_VERSION,
    transport: args.live ? "live" : "fake",
    inputHash,
    definitionHash,
    matchesPreregisteredHash: inputHash === SEQUENCE_CALIBRATION_PREREGISTERED.inputHash,
    date: now.toISOString(),
    analyzer: provider.id,
    analyzerVersion: inputs[0]!.input.analyzerVersion,
    model: provider.model,
    prompt: inputs[0]!.batch.promptVersion,
    rubric: inputs[0]!.input.rubricVersion,
    schema: inputs[0]!.input.schemaVersion,
    edgePolicy: CUT_EDGE_POLICY.id,
    fps: CUT_EDGE_POLICY.fps,
    fixtureCount: fixtures.length,
    trialsPerFixture: trials,
    plannedQualityRequests: planned,
    transportCeiling: ceiling,
    acceptance: SEQUENCE_CALIBRATION_ACCEPTANCE,
    fixtures: sequenceCalibrationDefinition().fixtures.map((f) => ({
      id: f.id,
      family: f.family,
      control: f.control,
      description: f.description,
      correct: f.correct,
      notes: f.notes,
    })),
    interSceneControl: interSceneControl(provider, inputs[0]!.edge),
    status,
    abort,
    trials: out,
    trialsPlanned: planned,
    trialsAttempted: out.length,
    trialsUnattempted: planned - out.length,
    trialsUnanswered: out.filter((t) => t.result === "error").length,
    trialsRejected: out.filter((t) => t.result === "error" && t.httpStatus != null).length,
    answersReceived: calls.length,
    transportCalls: counts.transport,
    uploadAttempts: counts.upload,
    analysisAttempts: counts.analysis,
    correctionAttempts: counts.correction,
    corrections: out
      .filter((t) => t.correctionUsed)
      .map((t) => ({ fixture: t.fixture, trial: t.trial, validated: t.correctionValidated === true })),
    usageReportedCalls: reported.length,
    estimate,
    actualUsd,
    costStatus,
    knownUsageUsd: priced(reported),
    reportedTokens: {
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
      thoughtsTokens: sum("thoughtsTokens"),
    },
    quota,
    families: familyReports(out, status, fixtures),
    productionConfigUnchanged: true,
  };
}
