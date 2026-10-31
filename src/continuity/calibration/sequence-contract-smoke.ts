import { writeFileSync } from "node:fs";
import { transitionInputProblem } from "@/domain/continuity/analysis/sequence-plan";
import type { CutCriterion } from "@/domain/continuity/sequence";
import { redactText } from "@/lib/auth/redact";
import { FfmpegMediaProcessor } from "@/media/ffmpeg";
import type { MediaProcessor } from "@/media/types";
import { AnalysisBatchError, type ContinuityAnalysisProvider, type UsageCall } from "../analysis/provider";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { geminiModelBlocker, readGeminiConfig } from "../providers/gemini/config";
import { FakeGeminiTransport, type FakeStep } from "../providers/gemini/fake-transport";
import type { GeminiRequest, GeminiTransport } from "../providers/gemini/transport";
import { buildCutInput, deriveEdgeSide, edgeMediaMap, type SequenceEdgePair } from "./sequence-calibration";
import { renderFixture } from "./temporal-calibration";

/**
 * SEQUENCE ANALYZER-CONTRACT SMOKE (Phase 3A.4E). ONE request through the SAME code path as a real cut analysis
 * (`sequence_transition`, `gemini-sequence-1`, the real prompt builder, the provider-facing sequence schema, two bounded
 * clips, two edge stills, sided input ids, local sided validation) on NEW diagnostic media with a sacrificial criterion.
 * It is not a calibration fixture, carries no calibration truth and grades nothing: it proves the provider accepts the
 * exact request contract before any 60-request run, the check whose absence cost 3A.3's third live attempt.
 */
export const SEQUENCE_SMOKE_VERSION = "sequence-contract-smoke-v1";
/** Hard ceilings for one smoke, independent of the operator's flags. */
export const SEQUENCE_SMOKE_LIMITS = { maxRequests: 1, maxUsd: 0.05, uploads: 0, corrections: 0 } as const;

/** Navy field, one static green square, 4 s: no overlap with any calibration fixture's content or truth. */
export const SEQUENCE_DIAGNOSTIC = {
  id: "sequence-contract-diagnostic",
  durationMs: 4000,
  video:
    "color=c=0x1e3a5f:s=640x360:d=4:r=24[b];color=c=0x2ecc40:s=90x90:d=4:r=24[s];[b][s]overlay=x=275:y=135",
} as const;
const DIAGNOSTIC_FAMILY = "object_continuity";
export const SEQUENCE_DIAGNOSTIC_CRITERION: CutCriterion = {
  key: "cut:diagnostic_visibility",
  category: "other",
  severity: "minor",
  title: "Diagnostic",
  sourceRef: SEQUENCE_SMOKE_VERSION,
  expected: "A green square is visible on both sides of the cut.",
  handler: "analyzer",
  family: DIAGNOSTIC_FAMILY,
  applicability: "applies",
  intentCoverable: false,
  position: 0,
};
export const sequenceSmokeIdentity = () => ({
  version: SEQUENCE_SMOKE_VERSION,
  acceptedFamilies: [DIAGNOSTIC_FAMILY] as readonly string[],
});

export type SequenceSmokeStatus =
  | "pass"
  | "provider_rejected"
  | "provider_accepted_local_invalid"
  | "outcome_unknown"
  | "refused_locally"
  | "error";

export interface SequenceSmokeReport {
  version: string;
  analyzer: string;
  analyzerVersion: string;
  model: string;
  mode: string;
  prompt: string;
  status: SequenceSmokeStatus;
  providerAccepted: boolean;
  localValidation: "ok" | "failed" | "not_reached";
  httpStatus: number | null;
  category: string | null;
  message: string | null;
  requests: number;
  uploadAttempts: number;
  correctionAttempts: number;
  estimatedMaxUsd: number;
  actualUsd: number | null;
  costStatus: "none_sent" | "known" | "unknown";
  /** Shape only (no quality meaning). */
  finding: { result: string; evidence: number } | null;
}

const usageComplete = (c: UsageCall) =>
  c.inputTokens != null && (c.outputTokens != null || c.thoughtsTokens != null);

/** Renders the diagnostic parent once and derives both edges with the production extraction. */
export async function prepareSmokeEdges(
  processor: Pick<MediaProcessor, "extractWindow" | "extractFrame">,
): Promise<SequenceEdgePair> {
  const parent = await renderFixture({ ...SEQUENCE_DIAGNOSTIC, audio: undefined });
  const side = (which: "left" | "right") =>
    deriveEdgeSide({
      which,
      parent,
      sourceInMs: 0,
      sourceOutMs: SEQUENCE_DIAGNOSTIC.durationMs,
      processor,
    });
  return { left: await side("left"), right: await side("right") };
}

/** Sends at most ONE request (no upload, no correction, no retry). Throws only when it refuses before sending. */
export async function runSequenceContractSmoke(args: {
  provider: ContinuityAnalysisProvider;
  maxUsd: number;
  edges: SequenceEdgePair;
  now?: Date;
}): Promise<SequenceSmokeReport> {
  const { provider, edges } = args;
  const now = args.now ?? new Date();
  const maxUsd = Math.min(args.maxUsd, SEQUENCE_SMOKE_LIMITS.maxUsd);
  if (!(maxUsd > 0)) throw new Error("The smoke needs a positive dollar ceiling; nothing was sent.");
  for (const which of ["left", "right"] as const) {
    const size = edges[which].clip.bytes.length;
    if (provider.videoTransfer?.(size) !== "inline")
      throw new Error(`The smoke's ${which} clip (${size} bytes) would need an upload; nothing was sent.`);
  }
  const input = buildCutInput({
    ref: SEQUENCE_SMOKE_VERSION,
    criterion: SEQUENCE_DIAGNOSTIC_CRITERION,
    edge: edges,
    provider,
  });
  const batch = input.plan.batches[0];
  if (input.plan.batches.length !== 1 || batch?.mode !== "sequence_transition")
    throw new Error("The smoke must plan exactly one sequence batch; nothing was sent.");
  const problem = transitionInputProblem(input);
  if (problem) throw new Error(`${problem} Nothing was sent.`);
  const estimate = provider.estimate(input, now).maxUsd;
  if (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate < 0 || estimate > maxUsd)
    throw new Error(
      `The smoke's estimate ($${String(estimate)}) is unknown or above $${maxUsd}; nothing was sent.`,
    );
  const counts = { requests: 0, upload: 0, correction: 0 };
  const base = {
    version: SEQUENCE_SMOKE_VERSION,
    analyzer: provider.id,
    analyzerVersion: input.analyzerVersion,
    model: provider.model,
    mode: batch.mode,
    prompt: batch.promptVersion,
    estimatedMaxUsd: Math.round(estimate * 1e6) / 1e6,
  };
  const cost = (calls: UsageCall[]) => {
    if (counts.requests === 0) return { actualUsd: 0, costStatus: "none_sent" as const };
    if (calls.length === counts.requests && calls.every(usageComplete))
      return { actualUsd: provider.actualCost(calls, now).amountUsd, costStatus: "known" as const };
    return { actualUsd: null, costStatus: "unknown" as const };
  };
  try {
    const res = await provider.analyzeBatch({
      batch,
      input,
      media: edgeMediaMap(edges),
      ctx: {
        now: () => now,
        sleep: async () => undefined,
        canCorrect: () => false,
        beforeTransportCall: async ({ kind }) => {
          if (kind === "upload") {
            counts.upload += 1;
            throw new AnalysisBatchError("local_policy_block", "smoke_upload", "The smoke never uploads.");
          }
          if (kind === "correction") counts.correction += 1;
          if (counts.requests >= SEQUENCE_SMOKE_LIMITS.maxRequests)
            throw new AnalysisBatchError("local_policy_block", "ceiling", "The smoke sends one request.");
          counts.requests += 1;
        },
      },
    });
    const f = res.findings.find((x) => x.criterionKey === SEQUENCE_DIAGNOSTIC_CRITERION.key) ?? null;
    return {
      ...base,
      status: f ? "pass" : "provider_accepted_local_invalid",
      providerAccepted: true,
      localValidation: f ? "ok" : "failed",
      httpStatus: 200,
      category: null,
      message: f ? null : "The answer carried no finding for the diagnostic criterion.",
      requests: counts.requests,
      uploadAttempts: counts.upload,
      correctionAttempts: counts.correction,
      ...cost(res.calls),
      finding: f ? { result: f.result, evidence: f.evidence.length } : null,
    };
  } catch (err) {
    const e = err instanceof AnalysisBatchError ? err : null;
    const calls = e?.calls ?? [];
    const status: SequenceSmokeStatus =
      e?.httpStatus != null
        ? "provider_rejected"
        : e?.category === "local_policy_block"
          ? "refused_locally"
          : e?.category === "outcome_unknown"
            ? "outcome_unknown"
            : calls.length > 0
              ? "provider_accepted_local_invalid"
              : "error";
    return {
      ...base,
      status,
      providerAccepted: status === "provider_accepted_local_invalid",
      localValidation: status === "provider_accepted_local_invalid" ? "failed" : "not_reached",
      httpStatus: e?.httpStatus ?? (calls.length > 0 ? 200 : null),
      category: e?.category ?? "error",
      message: redactText(err instanceof Error ? err.message : String(err)).slice(0, 200),
      requests: counts.requests,
      uploadAttempts: counts.upload,
      correctionAttempts: counts.correction,
      ...cost(calls),
      finding: null,
    };
  }
}

/** The offline answer: a contract-valid sided observation about the diagnostic criterion only. */
export const smokeFakeAnswer =
  (result: "pass" | "unchecked" = "pass") =>
  (req: GeminiRequest): FakeStep => {
    void req;
    return {
      kind: "json",
      body: {
        criteria: [
          {
            criterionId: SEQUENCE_DIAGNOSTIC_CRITERION.key,
            result,
            confidence: 0.9,
            summary: "Diagnostic.",
            evidence: [
              { input: "left:last", timestampMs: null, endMs: null, observation: "Left edge frame." },
              { input: "right:first", timestampMs: null, endMs: null, observation: "Right edge frame." },
            ],
            contradictions: [],
            limitations: [],
          },
        ],
      },
    };
  };

class Refusal extends Error {}

/** The smoke CLI. Exit 0 = pass, 2 = refused (nothing sent), 3 = sent but not a pass. */
export async function runSequenceSmokeCli(deps: {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  createLiveTransport: (apiKey: string) => Promise<GeminiTransport>;
  prepare?: () => Promise<SequenceEdgePair>;
  log?: (line: string) => void;
  error?: (line: string) => void;
  writeReport?: (path: string, json: string) => void;
}): Promise<number> {
  const { argv, env } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const error = deps.error ?? ((l: string) => console.error(l));
  const writeReport = deps.writeReport ?? ((p: string, j: string) => writeFileSync(p, j));
  const value = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const live = argv.includes("--live");
  const out = value("--out") ?? `sequence-contract-smoke-${live ? "live" : "fake"}.json`;
  const fail = (m: string): never => {
    throw new Refusal(m);
  };
  const prepare = deps.prepare ?? (() => prepareSmokeEdges(new FfmpegMediaProcessor()));
  const identity = sequenceSmokeIdentity();
  try {
    let maxUsd: number = SEQUENCE_SMOKE_LIMITS.maxUsd;
    let provider: GeminiAnalysisProvider;
    let edges: SequenceEdgePair;
    if (live) {
      if (!argv.includes("--i-understand-this-sends-synthetic-video-and-costs-money"))
        fail("--live needs --i-understand-this-sends-synthetic-video-and-costs-money.");
      if (env.PRISM_STUDIO_SEQUENCE_CALIBRATION_LIVE !== "1")
        fail("PRISM_STUDIO_SEQUENCE_CALIBRATION_LIVE=1 is not set.");
      if (env.PRISM_STUDIO_ALLOW_PAID_ANALYSIS !== "1")
        fail("PRISM_STUDIO_ALLOW_PAID_ANALYSIS=1 is not set.");
      const model = value("--model") ?? fail("--model is required (an exact verified Gemini model id).");
      const mu = Number(value("--max-usd"));
      if (!(mu > 0) || !Number.isFinite(mu)) fail("--max-usd must be a positive amount.");
      const blocker = geminiModelBlocker(model);
      if (blocker) fail(blocker);
      const cfg = readGeminiConfig({
        ...env,
        PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
        PRISM_STUDIO_GEMINI_ANALYSIS_MODEL: model,
        PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
      });
      const apiKey = cfg.apiKey ?? fail("GEMINI_API_KEY is not set.");
      maxUsd = Math.min(mu, SEQUENCE_SMOKE_LIMITS.maxUsd);
      edges = await prepare();
      // the same checks with a network-free provider, so a refusal happens before any real transport exists
      const planner = new GeminiAnalysisProvider({
        config: cfg,
        transport: new FakeGeminiTransport([]),
        testCrossCutCalibration: identity,
      });
      const estimate = planner.estimate(
        buildCutInput({
          ref: SEQUENCE_SMOKE_VERSION,
          criterion: SEQUENCE_DIAGNOSTIC_CRITERION,
          edge: edges,
          provider: planner,
        }),
        new Date(),
      ).maxUsd;
      if (!Number.isFinite(estimate) || estimate > maxUsd)
        fail(`The smoke's estimate ($${String(estimate)}) is unknown or above $${maxUsd}.`);
      for (const which of ["left", "right"] as const)
        if (planner.videoTransfer(edges[which].clip.bytes.length) !== "inline")
          fail(`The smoke's ${which} clip would need an upload.`);
      // the ONLY place the network transport is created: every refusal above has already passed
      provider = new GeminiAnalysisProvider({
        config: cfg,
        transport: await deps.createLiveTransport(apiKey),
        testCrossCutCalibration: identity,
      });
    } else {
      edges = await prepare();
      provider = new GeminiAnalysisProvider({
        config: readGeminiConfig({
          PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
          GEMINI_API_KEY: "fake-transport-no-key",
          PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
        }),
        transport: new FakeGeminiTransport(smokeFakeAnswer()),
        testCrossCutCalibration: identity,
      });
    }
    let report: SequenceSmokeReport;
    try {
      report = await runSequenceContractSmoke({ provider, maxUsd, edges });
    } catch (err) {
      return fail(
        err instanceof Error ? err.message.replace(/;? ?[Nn]othing was sent\.$/, ".") : String(err),
      );
    }
    writeReport(out, JSON.stringify(report, null, 2));
    log(
      `${SEQUENCE_SMOKE_VERSION} · ${live ? "LIVE" : "FAKE transport"} · ${report.analyzer} ${report.analyzerVersion} ${report.model} · ${report.mode} · ${report.prompt}`,
    );
    log(
      `status=${report.status} provider_accepted=${report.providerAccepted} local_validation=${report.localValidation} http=${report.httpStatus ?? "-"}${report.category ? ` category=${report.category}` : ""}`,
    );
    log(
      `requests=${report.requests} uploads=${report.uploadAttempts} corrections=${report.correctionAttempts} estimate≤$${report.estimatedMaxUsd} actual=${report.actualUsd == null ? "UNKNOWN" : `$${report.actualUsd}`} (${report.costStatus})`,
    );
    log(`report: ${out} (request-contract check only: no quality meaning)`);
    return report.status === "pass" ? 0 : 3;
  } catch (err) {
    if (err instanceof Refusal) {
      error(`REFUSED: ${err.message} Nothing was sent.`);
      return 2;
    }
    throw err;
  }
}
