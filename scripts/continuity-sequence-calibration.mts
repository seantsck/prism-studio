// Sequence Continuity calibration (Phase 3A.4E, sequence-calibration-v1).
//
//   npm run continuity:sequence:calibrate                      FAKE transport (default): the real media and request
//                                                               path with an offline oracle; spends and sends nothing.
//   npm run continuity:sequence:calibrate -- --live \
//     --model gemini-3.8-flash --max-calls 120 --max-usd USD --input-hash HASH \
//     --max-rpm RPM --max-tpm TPM --max-rpd RPD --confirm-rpd-remaining \
//     --billing-active yes --project-tier TIER --spend-cap CAP \
//     --i-understand-this-sends-synthetic-video-and-costs-money  LIVE: only at the separately authorised 3A.4E-B gate.
//
// A live run needs ALL of the flags above, PRISM_STUDIO_SEQUENCE_CALIBRATION_LIVE=1, PRISM_STUDIO_ALLOW_PAID_ANALYSIS=1,
// a Gemini credential, and a computed input hash equal to the reviewed one. --max-calls counts every outbound request,
// corrections included: at least 60, worst case 120. Run `continuity:sequence:smoke` first and require PASS. Only
// synthetic fixtures leave Prism. The run writes a report and changes no production configuration.
//
// The logic lives in src/continuity/calibration/sequence-calibration-cli.ts (tested: every live refusal happens before
// the SDK transport below is created). This wrapper only supplies the real transport, argv and env, and ends the
// process gracefully (cli-exit.ts).
import { exitGracefully } from "../src/continuity/calibration/cli-exit";
import { runSequenceCalibrationCli } from "../src/continuity/calibration/sequence-calibration-cli";

runSequenceCalibrationCli({
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
