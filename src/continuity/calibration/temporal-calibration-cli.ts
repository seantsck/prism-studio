import { writeFileSync } from "node:fs";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import { geminiModelBlocker, readGeminiConfig } from "../providers/gemini/config";
import { FakeGeminiTransport, answerAll } from "../providers/gemini/fake-transport";
import type { GeminiTransport } from "../providers/gemini/transport";
import {
  CALIBRATION_ACCEPTANCE,
  CALIBRATION_VERSION,
  TEMPORAL_FIXTURES,
  liveReadinessProblems,
  runTemporalCalibration,
  type CalibrationQuota,
} from "./temporal-calibration";

/**
 * The calibration CLI (scripts/continuity-temporal-calibration.mts is a thin wrapper). The real SDK transport is
 * INJECTED (`createLiveTransport`) and is only ever created after every live refusal has passed: the acknowledgement
 * flag, both env flags, the model, the ceilings, the operator's quota/billing readiness, the model check and the
 * credential. A refusal returns exit code 2 with "REFUSED: … Nothing was sent."
 */
export interface CalibrationCliDeps {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  /** Creates the real (network) transport. Called at most once, and only after every live refusal has passed. */
  createLiveTransport: (apiKey: string) => Promise<GeminiTransport>;
  log?: (line: string) => void;
  error?: (line: string) => void;
  writeReport?: (path: string, json: string) => void;
}

const VERDICT = {
  accepted: "ACCEPTED",
  not_accepted_incomplete: "NOT ACCEPTED — calibration incomplete",
  not_accepted_incorrect: "NOT ACCEPTED — model answered incorrectly",
  not_accepted_provider_errors: "NOT ACCEPTED — provider errors (no answer)",
} as const;

class Refusal extends Error {}

/** Returns the process exit code: 0 completed, 2 refused (nothing sent), 3 aborted (partial report written). */
export async function runCalibrationCli(deps: CalibrationCliDeps): Promise<number> {
  const { argv, env } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const error = deps.error ?? ((l: string) => console.error(l));
  const writeReport = deps.writeReport ?? ((p: string, j: string) => writeFileSync(p, j));
  const flag = (n: string) => argv.includes(n);
  const value = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (n: string) => (value(n) === undefined ? undefined : Number(value(n)));
  const live = flag("--live");
  const out = value("--out") ?? `temporal-calibration-${live ? "live" : "fake"}.json`;
  const fail = (m: string): never => {
    throw new Refusal(m);
  };

  try {
    let provider: GeminiAnalysisProvider;
    let maxCalls = TEMPORAL_FIXTURES.length * CALIBRATION_ACCEPTANCE.trials;
    let maxUsd = 2; // fake transport: spends nothing; the ceiling still has to hold the worst-case estimate
    const readiness = {
      maxRpm: num("--max-rpm"),
      maxTpm: num("--max-tpm"),
      maxRpd: num("--max-rpd"),
      rpdRemainingConfirmed: flag("--confirm-rpd-remaining"),
      billingActive: value("--billing-active"),
      projectTier: value("--project-tier"),
      spendCap: value("--spend-cap"),
    };
    const declared = (): CalibrationQuota => ({
      maxRpm: readiness.maxRpm ?? Number.NaN,
      maxTpm: readiness.maxTpm ?? Number.NaN,
      maxRpd: readiness.maxRpd ?? Number.NaN,
    });
    let quota: CalibrationQuota | undefined;
    if (live) {
      if (!flag("--i-understand-this-sends-synthetic-video-and-costs-money"))
        fail("--live needs --i-understand-this-sends-synthetic-video-and-costs-money.");
      if (env.PRISM_STUDIO_TEMPORAL_CALIBRATION_LIVE !== "1")
        fail("PRISM_STUDIO_TEMPORAL_CALIBRATION_LIVE=1 is not set.");
      if (env.PRISM_STUDIO_ALLOW_PAID_ANALYSIS !== "1")
        fail("PRISM_STUDIO_ALLOW_PAID_ANALYSIS=1 is not set.");
      const model = value("--model") ?? fail("--model is required (an exact verified Gemini model id).");
      const mc = Number(value("--max-calls"));
      const mu = Number(value("--max-usd"));
      if (!(mc > 0) || !Number.isInteger(mc)) fail("--max-calls must be a positive integer.");
      if (!(mu > 0) || !Number.isFinite(mu)) fail("--max-usd must be a positive amount.");
      const problems = liveReadinessProblems(readiness);
      if (problems.length) fail(problems.join(" "));
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
      maxCalls = mc;
      maxUsd = mu;
      quota = declared();
    } else {
      provider = new GeminiAnalysisProvider({
        config: readGeminiConfig({
          PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
          GEMINI_API_KEY: "fake-transport-no-key",
          PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
        }),
        transport: new FakeGeminiTransport(answerAll("pass")),
      });
      if (readiness.maxRpm !== undefined || readiness.maxTpm !== undefined || readiness.maxRpd !== undefined)
        quota = declared();
    }
    log(
      `${CALIBRATION_VERSION} · ${live ? "LIVE" : "FAKE transport"} · ${TEMPORAL_FIXTURES.length} fixtures × ${CALIBRATION_ACCEPTANCE.trials} trials · ceilings: ${maxCalls} requests, $${maxUsd}`,
    );
    if (live) {
      log(`PROJECT TIER: ${readiness.projectTier}`);
      log(`MODEL RPM LIMIT: ${readiness.maxRpm}`);
      log(`MODEL TPM LIMIT: ${readiness.maxTpm}`);
      log(`MODEL RPD LIMIT: ${readiness.maxRpd} (remaining capacity confirmed by the operator)`);
      log(`PROJECT SPEND CAP: ${readiness.spendCap}`);
      log(`BILLING ACTIVE: YES`);
    }
    const report = await runTemporalCalibration({
      provider,
      maxTransportCalls: maxCalls,
      maxUsd,
      live,
      quota,
      // fake mode never waits: the pacing plan is computed and reported, not slept
      ...(live ? {} : { sleep: async () => undefined }),
    });
    const operator = live
      ? {
          projectTier: readiness.projectTier,
          spendCap: readiness.spendCap,
          billingActive: true,
          rpdRemainingConfirmed: true,
        }
      : null;
    // the report is written for every run that got this far, including an aborted one (the audit trail)
    writeReport(out, JSON.stringify({ ...report, operator }, null, 2));
    if (report.quota)
      log(
        `pacing: ${report.quota.effectiveRpm} req/min (≥${report.quota.minIntervalMs} ms apart) · worst case ${report.quota.worstCaseTokensPerMinute} tokens/min ≤ TPM ${report.quota.maxTpm} · ${report.quota.plannedAnalysisRequests} requests ≤ RPD ${report.quota.maxRpd}`,
      );
    log(
      `status=${report.status}${report.abort ? ` abort=${report.abort.reason} http=${report.abort.httpStatus ?? "-"} at ${report.abort.fixture}#${report.abort.trial}` : ""} trials=${report.trialsAttempted}/${report.trialsPlanned} unattempted=${report.trialsUnattempted} responses=${report.answersReceived}`,
    );
    for (const [c, v] of Object.entries(report.verdicts)) log(`${VERDICT[v]}  ${c}`);
    log(
      `requests=${report.transportCalls} (analysis=${report.analysisAttempts} upload=${report.uploadAttempts} correction=${report.correctionAttempts} usage_reported=${report.usageReportedCalls}) estimate≤$${report.estimatedMaxUsd} actual=${report.actualUsd == null ? "UNKNOWN" : `$${report.actualUsd}`} (${report.costStatus}; known usage $${report.knownUsageUsd ?? "?"}) lip_sync_capable=${report.lipSyncCapable}`,
    );
    log(`report: ${out}${live ? "" : " (fake transport: says nothing about a real analyzer)"}`);
    return report.status === "completed" ? 0 : 3;
  } catch (err) {
    if (err instanceof Refusal) {
      error(`REFUSED: ${err.message} Nothing was sent.`);
      return 2;
    }
    throw err;
  }
}
