// Temporal Video QA calibration (Phase 3A.3).
//
//   npm run continuity:temporal:calibrate                      FAKE transport (default): exercises fixtures, grading
//                                                               and ceilings; spends nothing, sends nothing.
//   npm run continuity:temporal:calibrate -- --live \
//     --model gemini-3.8-flash --max-calls 48 --max-usd 1.25 \
//     --max-rpm RPM --max-tpm TPM --max-rpd RPD --confirm-rpd-remaining \
//     --billing-active yes --project-tier TIER --spend-cap CAP \
//     --i-understand-this-sends-synthetic-video-and-costs-money  LIVE: only at the separately authorised gate.
//
// A live run needs ALL of: --live, the explicit acknowledgement flag, --model, --max-calls, --max-usd,
// PRISM_STUDIO_TEMPORAL_CALIBRATION_LIVE=1, PRISM_STUDIO_ALLOW_PAID_ANALYSIS=1, a Gemini credential, and the
// operator's readiness for the SAME Google project behind the key, read from AI Studio (limits are per project; Prism
// cannot infer them): the model's active RPM / TPM / RPD limits, confirmation that today's remaining requests cover
// the plan, an active billing account, the tier and the spend cap. The planned request count, the worst-case estimate
// and the paced token/day load are checked BEFORE anything is sent; requests are paced start to start at 80% of the
// declared RPM. The first 429 (or 3 consecutive 5xx) aborts the run; the partial report is still written and the
// exit code is 3. Only synthetic fixtures leave Prism (no project media). The pre-registered acceptance rule is in
// temporal-calibration.ts; the report says which capabilities the evidence supports (lip sync stays OFF unless it
// passes). Fake mode accepts the same limits to exercise the quota preflight; it never waits.
import { writeFileSync } from "node:fs";
import {
  CALIBRATION_ACCEPTANCE,
  CALIBRATION_VERSION,
  TEMPORAL_FIXTURES,
  liveReadinessProblems,
  runTemporalCalibration,
  type CalibrationQuota,
} from "../src/continuity/calibration/temporal-calibration";
import { GeminiAnalysisProvider } from "../src/continuity/providers/gemini/analyzer";
import { geminiModelBlocker, readGeminiConfig } from "../src/continuity/providers/gemini/config";
import { FakeGeminiTransport, answerAll } from "../src/continuity/providers/gemini/fake-transport";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const value = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (n: string) => (value(n) === undefined ? undefined : Number(value(n)));
const env = process.env as Record<string, string | undefined>;
const live = flag("--live");
const out = value("--out") ?? `temporal-calibration-${live ? "live" : "fake"}.json`;

const VERDICT = {
  accepted: "ACCEPTED",
  not_accepted_incomplete: "NOT ACCEPTED — calibration incomplete",
  not_accepted_incorrect: "NOT ACCEPTED — model answered incorrectly",
  not_accepted_provider_errors: "NOT ACCEPTED — provider errors (no answer)",
} as const;

async function main() {
  const fail = (m: string) => {
    console.error(`REFUSED: ${m} Nothing was sent.`);
    process.exit(2);
  };
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
    if (env.PRISM_STUDIO_ALLOW_PAID_ANALYSIS !== "1") fail("PRISM_STUDIO_ALLOW_PAID_ANALYSIS=1 is not set.");
    const model = value("--model");
    if (!model) fail("--model is required (an exact verified Gemini model id).");
    const mc = Number(value("--max-calls"));
    const mu = Number(value("--max-usd"));
    if (!(mc > 0) || !Number.isInteger(mc)) fail("--max-calls must be a positive integer.");
    if (!(mu > 0) || !Number.isFinite(mu)) fail("--max-usd must be a positive amount.");
    const problems = liveReadinessProblems(readiness);
    if (problems.length) fail(problems.join(" "));
    const blocker = geminiModelBlocker(model!);
    if (blocker) fail(blocker);
    const cfg = readGeminiConfig({
      ...env,
      PRISM_STUDIO_CONTINUITY_ANALYZERS: "gemini",
      PRISM_STUDIO_GEMINI_ANALYSIS_MODEL: model,
      PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
    });
    if (!cfg.apiKey) fail("GEMINI_API_KEY is not set.");
    const { SdkGeminiTransport } = await import("../src/continuity/providers/gemini/sdk-transport");
    provider = new GeminiAnalysisProvider({
      config: cfg,
      transport: new SdkGeminiTransport({ apiKey: cfg.apiKey! }),
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
  console.log(
    `${CALIBRATION_VERSION} · ${live ? "LIVE" : "FAKE transport"} · ${TEMPORAL_FIXTURES.length} fixtures × ${CALIBRATION_ACCEPTANCE.trials} trials · ceilings: ${maxCalls} requests, $${maxUsd}`,
  );
  if (live) {
    console.log(`PROJECT TIER: ${readiness.projectTier}`);
    console.log(`MODEL RPM LIMIT: ${readiness.maxRpm}`);
    console.log(`MODEL TPM LIMIT: ${readiness.maxTpm}`);
    console.log(`MODEL RPD LIMIT: ${readiness.maxRpd} (remaining capacity confirmed by the operator)`);
    console.log(`PROJECT SPEND CAP: ${readiness.spendCap}`);
    console.log(`BILLING ACTIVE: YES`);
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
  writeFileSync(out, JSON.stringify({ ...report, operator }, null, 2));
  if (report.quota)
    console.log(
      `pacing: ${report.quota.effectiveRpm} req/min (≥${report.quota.minIntervalMs} ms apart) · worst case ${report.quota.worstCaseTokensPerMinute} tokens/min ≤ TPM ${report.quota.maxTpm} · ${report.quota.plannedAnalysisRequests} requests ≤ RPD ${report.quota.maxRpd}`,
    );
  console.log(
    `status=${report.status}${report.abort ? ` abort=${report.abort.reason} http=${report.abort.httpStatus ?? "-"} at ${report.abort.fixture}#${report.abort.trial}` : ""} trials=${report.trialsAttempted}/${report.trialsPlanned} unattempted=${report.trialsUnattempted} responses=${report.answersReceived}`,
  );
  for (const [c, v] of Object.entries(report.verdicts)) console.log(`${VERDICT[v]}  ${c}`);
  console.log(
    `requests=${report.transportCalls} (analysis=${report.analysisAttempts} upload=${report.uploadAttempts} correction=${report.correctionAttempts} usage_reported=${report.usageReportedCalls}) estimate≤$${report.estimatedMaxUsd} actual=${report.actualUsd == null ? "UNKNOWN" : `$${report.actualUsd}`} (${report.costStatus}; known usage $${report.knownUsageUsd ?? "?"}) lip_sync_capable=${report.lipSyncCapable}`,
  );
  console.log(`report: ${out}${live ? "" : " (fake transport: says nothing about a real analyzer)"}`);
  if (report.status !== "completed") process.exit(3);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
