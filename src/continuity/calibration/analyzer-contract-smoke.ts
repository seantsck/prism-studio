import { writeFileSync } from "node:fs";
import { redactText } from "@/lib/auth/redact";
import { AnalysisBatchError, type ContinuityAnalysisProvider, type UsageCall } from "../analysis/provider";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { geminiModelBlocker, readGeminiConfig } from "../providers/gemini/config";
import { FakeGeminiTransport, answerAll } from "../providers/gemini/fake-transport";
import type { GeminiTransport } from "../providers/gemini/transport";
import { renderFixture, temporalAnalysisInput } from "./temporal-calibration";

/**
 * ANALYZER-CONTRACT SMOKE (Phase 3A.3). ONE request built through the SAME code path as a real Gemini temporal
 * analysis batch (analyzer, prompt builder, direct-video mode, provider-facing response schema, sampling metadata,
 * thinking configuration), on a NEW synthetic diagnostic clip with a sacrificial criterion. It is not a calibration
 * fixture, carries no calibration truth and never grades quality: it only proves that the provider accepts the exact
 * request contract and that Prism's local validation accepts the answer.
 *
 * Why it exists: the third live calibration attempt passed a basic connectivity smoke (minimal schema) and then sent
 * 48 analyzer requests that Gemini refused with HTTP 400 (the analyzer's response schema). A future calibration must
 * first pass THIS smoke.
 */
export const SMOKE_VERSION = "analyzer-contract-smoke-v1";
/** Hard ceilings for one smoke, independent of the operator's flags. */
export const SMOKE_LIMITS = { maxRequests: 1, maxUsd: 0.05 } as const;

/** Navy field, one static green square, 2 s, 640×360: no overlap with any calibration fixture's content or truth. */
export const DIAGNOSTIC_CLIP = {
  id: "analyzer-contract-diagnostic",
  durationMs: 2000,
  video:
    "color=c=0x1e3a5f:s=640x360:d=2:r=24[b];color=c=0x2ecc40:s=90x90:d=2:r=24[s];[b][s]overlay=x=275:y=135",
} as const;
export const DIAGNOSTIC_CRITERION = {
  key: "diagnostic_visibility",
  expected: "A green square is visible.",
} as const;

export type SmokeStatus =
  | "pass"
  | "provider_rejected"
  | "provider_accepted_local_invalid"
  | "outcome_unknown"
  | "refused_locally"
  | "error";

export interface SmokeReport {
  version: string;
  analyzer: string;
  analyzerVersion: string;
  model: string;
  mode: string;
  status: SmokeStatus;
  /** The provider accepted the request (a 2xx response came back), whatever local validation then said. */
  providerAccepted: boolean;
  localValidation: "ok" | "failed" | "not_reached";
  httpStatus: number | null;
  category: string | null;
  message: string | null;
  requests: number;
  uploadAttempts: number;
  estimatedMaxUsd: number;
  /** 0 only when nothing was sent; the provider's figure only when usage is complete; otherwise null (UNKNOWN). */
  actualUsd: number | null;
  costStatus: "none_sent" | "known" | "unknown";
  /** Shape only (no quality meaning): the returned result and how many evidence items it carried. */
  finding: { result: string; evidence: number } | null;
}

const usageComplete = (c: UsageCall) =>
  c.inputTokens != null && (c.outputTokens != null || c.thoughtsTokens != null);

export function smokeInput(provider: ContinuityAnalysisProvider, bytes: Uint8Array) {
  return temporalAnalysisInput(
    {
      id: DIAGNOSTIC_CLIP.id,
      idPrefix: "diagnostic",
      runKeyPrefix: SMOKE_VERSION,
      label: "Diagnostic clip",
      key: DIAGNOSTIC_CRITERION.key,
      category: "action_continuity",
      capability: "video_temporal",
      sourceRef: SMOKE_VERSION,
      expected: DIAGNOSTIC_CRITERION.expected,
      durationMs: DIAGNOSTIC_CLIP.durationMs,
    },
    provider,
    bytes,
  );
}

/** Sends at most ONE request (no upload, no correction, no retry). Throws only when it refuses before sending. */
export async function runAnalyzerContractSmoke(args: {
  provider: ContinuityAnalysisProvider;
  maxUsd: number;
  render?: () => Promise<Uint8Array>;
  now?: Date;
}): Promise<SmokeReport> {
  const now = args.now ?? new Date();
  const maxUsd = Math.min(args.maxUsd, SMOKE_LIMITS.maxUsd);
  if (!(maxUsd > 0)) throw new Error("The smoke needs a positive dollar ceiling; nothing was sent.");
  const bytes = await (args.render ?? (() => renderFixture({ ...DIAGNOSTIC_CLIP, audio: undefined })))();
  const input = smokeInput(args.provider, bytes);
  const batch = input.plan.batches[0];
  if (input.plan.batches.length !== 1 || batch?.mode !== "direct_video")
    throw new Error("The smoke must plan exactly one direct-video batch; nothing was sent.");
  const estimate = args.provider.estimate(input, now).maxUsd;
  if (typeof estimate !== "number" || !Number.isFinite(estimate) || estimate < 0 || estimate > maxUsd)
    throw new Error(
      `The smoke's estimate ($${String(estimate)}) is unknown or above $${maxUsd}; nothing was sent.`,
    );
  const counts = { requests: 0, upload: 0 };
  const base = {
    version: SMOKE_VERSION,
    analyzer: args.provider.id,
    analyzerVersion: args.provider.version,
    model: args.provider.model,
    mode: batch.mode,
    estimatedMaxUsd: Math.round(estimate * 1e6) / 1e6,
  };
  const cost = (calls: UsageCall[]) => {
    if (counts.requests === 0) return { actualUsd: 0, costStatus: "none_sent" as const };
    if (calls.length === counts.requests && calls.every(usageComplete))
      return { actualUsd: args.provider.actualCost(calls, now).amountUsd, costStatus: "known" as const };
    return { actualUsd: null, costStatus: "unknown" as const };
  };
  try {
    const res = await args.provider.analyzeBatch({
      batch,
      input,
      media: new Map([["video", { inputId: "video", mime: "video/mp4", bytes }]]),
      ctx: {
        now: () => now,
        sleep: async () => undefined,
        canCorrect: () => false,
        beforeTransportCall: async ({ kind }) => {
          if (kind === "upload") {
            counts.upload += 1;
            throw new AnalysisBatchError("local_policy_block", "smoke_upload", "The smoke never uploads.");
          }
          if (counts.requests >= SMOKE_LIMITS.maxRequests)
            throw new AnalysisBatchError("local_policy_block", "ceiling", "The smoke sends one request.");
          counts.requests += 1;
        },
      },
    });
    const f = res.findings.find((x) => x.criterionKey === DIAGNOSTIC_CRITERION.key) ?? null;
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
      ...cost(res.calls),
      finding: f ? { result: f.result, evidence: f.evidence.length } : null,
    };
  } catch (err) {
    const e = err instanceof AnalysisBatchError ? err : null;
    const calls = e?.calls ?? [];
    const status: SmokeStatus =
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
      ...cost(calls),
      finding: null,
    };
  }
}

class Refusal extends Error {}

/** The smoke CLI. Exit 0 = pass, 2 = refused (nothing sent), 3 = sent but not a pass. */
export async function runSmokeCli(deps: {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  createLiveTransport: (apiKey: string) => Promise<GeminiTransport>;
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
  const out = value("--out") ?? `analyzer-contract-smoke-${live ? "live" : "fake"}.json`;
  const fail = (m: string): never => {
    throw new Refusal(m);
  };
  try {
    let provider: GeminiAnalysisProvider;
    let maxUsd: number = SMOKE_LIMITS.maxUsd;
    if (live) {
      if (!argv.includes("--i-understand-this-sends-synthetic-video-and-costs-money"))
        fail("--live needs --i-understand-this-sends-synthetic-video-and-costs-money.");
      if (env.PRISM_STUDIO_TEMPORAL_CALIBRATION_LIVE !== "1")
        fail("PRISM_STUDIO_TEMPORAL_CALIBRATION_LIVE=1 is not set.");
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
      // the ONLY place the network transport is created: every refusal above has already passed
      provider = new GeminiAnalysisProvider({
        config: cfg,
        transport: await deps.createLiveTransport(apiKey),
      });
      maxUsd = Math.min(mu, SMOKE_LIMITS.maxUsd);
    } else {
      provider = new GeminiAnalysisProvider({
        config: readGeminiConfig({
          PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
          GEMINI_API_KEY: "fake-transport-no-key",
          PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
        }),
        transport: new FakeGeminiTransport(answerAll("pass")),
      });
    }
    let report: SmokeReport;
    try {
      report = await runAnalyzerContractSmoke({ provider, maxUsd });
    } catch (err) {
      return fail(err instanceof Error ? err.message.replace(/; nothing was sent\.$/, ".") : String(err));
    }
    writeReport(out, JSON.stringify(report, null, 2));
    log(
      `${SMOKE_VERSION} · ${live ? "LIVE" : "FAKE transport"} · ${report.analyzer} v${report.analyzerVersion} ${report.model} · ${report.mode}`,
    );
    log(
      `status=${report.status} provider_accepted=${report.providerAccepted} local_validation=${report.localValidation} http=${report.httpStatus ?? "-"}${report.category ? ` category=${report.category}` : ""}`,
    );
    log(
      `requests=${report.requests} uploads=${report.uploadAttempts} estimate≤$${report.estimatedMaxUsd} actual=${report.actualUsd == null ? "UNKNOWN" : `$${report.actualUsd}`} (${report.costStatus})`,
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
