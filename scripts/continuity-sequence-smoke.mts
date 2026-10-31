// Sequence analyzer-contract smoke (Phase 3A.4E): one request, no upload, no correction, no retry, at most $0.05.
//
//   npm run continuity:sequence:smoke                          FAKE transport (default): sends nothing.
//   npm run continuity:sequence:smoke -- --live --model gemini-3.8-flash --max-usd 0.05 \
//     --i-understand-this-sends-synthetic-video-and-costs-money  LIVE: only at the separately authorised 3A.4E-B gate.
//
// A live run also needs PRISM_STUDIO_SEQUENCE_CALIBRATION_LIVE=1, PRISM_STUDIO_ALLOW_PAID_ANALYSIS=1 and a Gemini
// credential. It proves the request contract only: no calibration fixture, no truth, no quality meaning.
//
// The logic lives in src/continuity/calibration/sequence-contract-smoke.ts; this wrapper only supplies the real
// transport, argv and env, and ends the process gracefully (cli-exit.ts).
import { exitGracefully } from "../src/continuity/calibration/cli-exit";
import { runSequenceSmokeCli } from "../src/continuity/calibration/sequence-contract-smoke";

runSequenceSmokeCli({
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
