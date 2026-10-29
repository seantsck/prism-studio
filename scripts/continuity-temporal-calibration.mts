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
// declared RPM. The first 401/402/403/404 (provider access) or 429, 3 consecutive 5xx, or 2 consecutive identical
// 400s (request contract) aborts the run; the partial report is still written and the exit code is 3. Run
// `continuity:temporal:smoke` (the analyzer-contract smoke) and require PASS before any live calibration. Only synthetic fixtures leave Prism (no project media). The pre-registered acceptance rule is in
// temporal-calibration.ts; the report says which capabilities the evidence supports (lip sync stays OFF unless it
// passes). Fake mode accepts the same limits to exercise the quota preflight; it never waits.
//
// The logic lives in src/continuity/calibration/temporal-calibration-cli.ts (tested: every live refusal happens before
// the SDK transport below is created). This wrapper only supplies the real transport, argv and env, and ends the
// process gracefully (cli-exit.ts: no forced exit mid-teardown).
import { exitGracefully } from "../src/continuity/calibration/cli-exit";
import { runCalibrationCli } from "../src/continuity/calibration/temporal-calibration-cli";

runCalibrationCli({
  argv: process.argv.slice(2),
  env: process.env as Record<string, string | undefined>,
  createLiveTransport: async (apiKey) => {
    const { SdkGeminiTransport } = await import("../src/continuity/providers/gemini/sdk-transport");
    return new SdkGeminiTransport({ apiKey });
  },
}).then(
  (code) => exitGracefully(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    exitGracefully(1);
  },
);
