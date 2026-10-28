// Temporal Video QA calibration (Phase 3A.3).
//
//   npm run continuity:temporal:calibrate                      FAKE transport (default): exercises fixtures, grading
//                                                               and ceilings; spends nothing, sends nothing.
//   npm run continuity:temporal:calibrate -- --live \
//     --model gemini-3.8-flash --max-calls 42 --max-usd 0.50 \
//     --i-understand-this-sends-synthetic-video-and-costs-money  LIVE: only at the separately authorised gate.
//
// A live run needs ALL of: --live, the explicit acknowledgement flag, --model, --max-calls, --max-usd,
// PRISM_STUDIO_TEMPORAL_CALIBRATION_LIVE=1, PRISM_STUDIO_ALLOW_PAID_ANALYSIS=1 and a Gemini credential. The planned
// request count and worst-case estimate are checked against the ceilings BEFORE anything is sent. Only synthetic
// fixtures leave Prism (no project media). The pre-registered acceptance rule is in temporal-calibration.ts; the
// report says which capabilities the evidence supports (lip sync stays OFF unless it passes).
import { writeFileSync } from "node:fs";
import {
  CALIBRATION_ACCEPTANCE,
  CALIBRATION_VERSION,
  TEMPORAL_FIXTURES,
  runTemporalCalibration,
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
const env = process.env as Record<string, string | undefined>;
const live = flag("--live");
const out = value("--out") ?? `temporal-calibration-${live ? "live" : "fake"}.json`;

async function main() {
  const fail = (m: string) => {
    console.error(`REFUSED: ${m} Nothing was sent.`);
    process.exit(2);
  };
  let provider: GeminiAnalysisProvider;
  let maxCalls = TEMPORAL_FIXTURES.length * CALIBRATION_ACCEPTANCE.trials;
  let maxUsd = 1;
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
  console.log(
    `${CALIBRATION_VERSION} · ${live ? "LIVE" : "FAKE transport"} · ${TEMPORAL_FIXTURES.length} fixtures × ${CALIBRATION_ACCEPTANCE.trials} trials · ceilings: ${maxCalls} requests, $${maxUsd}`,
  );
  const report = await runTemporalCalibration({ provider, maxTransportCalls: maxCalls, maxUsd });
  writeFileSync(out, JSON.stringify(report, null, 2));
  for (const [c, okay] of Object.entries(report.accepted))
    console.log(`${okay ? "ACCEPTED" : "NOT ACCEPTED"}  ${c}`);
  console.log(
    `requests=${report.transportCalls} estimate≤$${report.estimatedMaxUsd} actual=${report.actualUsd == null ? "UNKNOWN" : `$${report.actualUsd}`} lip_sync_capable=${report.lipSyncCapable}`,
  );
  console.log(`report: ${out}${live ? "" : " (fake transport: says nothing about a real analyzer)"}`);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
