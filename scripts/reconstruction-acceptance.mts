// Phase 2F M2D.3D1: the operator's real-reconstruction acceptance commands (readiness check, REAL_SMOKE, REAL_ROOM,
// Spark render, final verdict). See docs/reconstruction-acceptance.md. Local only: no provider, no paid call, no
// upload; REAL modes need --real and never run inside automated tests.
import { runAcceptanceCli } from "../src/lib/reconstruction/acceptance/cli";
import { installRedactingHandlers } from "./lib/safety.mjs";

installRedactingHandlers();
const code = await runAcceptanceCli({
  argv: process.argv.slice(2),
  env: process.env,
  repoRoot: process.cwd(),
  out: (l) => console.log(l),
  err: (l) => console.error(l),
});
process.exit(code);
