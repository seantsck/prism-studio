// Phase 3A.3 analyzer-contract smoke: ONE Gemini request built exactly like a real temporal analysis batch, on a
// synthetic diagnostic clip (never a calibration fixture). It proves the provider accepts the analyzer's request
// contract and that Prism's local validation accepts the answer; it never grades quality. A live calibration must
// first pass it. Hard ceilings: 1 request, $0.05, no upload, no correction, no retry.
//
//   npm run continuity:temporal:smoke                       # fake transport, no network
//   PRISM_STUDIO_TEMPORAL_CALIBRATION_LIVE=1 PRISM_STUDIO_ALLOW_PAID_ANALYSIS=1 \
//   npm run continuity:temporal:smoke -- --live --model gemini-3.8-flash --max-usd 0.05 \
//     --i-understand-this-sends-synthetic-video-and-costs-money --out smoke.json
//
// The logic lives in src/continuity/calibration/analyzer-contract-smoke.ts; this wrapper only supplies the real
// transport, argv and env, and ends the process gracefully (cli-exit.ts: no forced exit mid-teardown).
import { exitGracefully } from "../src/continuity/calibration/cli-exit";
import { runSmokeCli } from "../src/continuity/calibration/analyzer-contract-smoke";

runSmokeCli({
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
