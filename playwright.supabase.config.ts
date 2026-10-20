import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Credentials for the signed-in flow live in .env.local (git-ignored). The Playwright process itself does not
// load it, so do that here (Node >= 21); the Next server loads .env.local on its own.
try {
  process.loadEnvFile(".env.local");
} catch {
  /* no .env.local: the signed-in test will skip itself */
}

// Real Supabase Auth + RLS persistence against the dedicated Prism Studio project.
// Safe by construction: the signed-in flow restores what it changes and deletes what it uploads.
// Requires `npm run db:seed -- --reset` first so the demo project is pristine.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "supabase-*.spec.ts",
  timeout: 90_000,
  workers: 1,
  expect: { timeout: 20_000 }, // remote DB: each action is a load + write + re-render
  use: { baseURL: "http://localhost:3101" },
  webServer: {
    command: "npm run build && npx next start -p 3101",
    url: "http://localhost:3101/login",
    reuseExistingServer: false,
    timeout: 300_000,
    // SUPABASE_DB_URL / NEXT_PUBLIC_* come from .env.local (loaded by Next).
    env: {
      PRISM_STUDIO_PERSISTENCE: "supabase",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3101",
      PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
      // Reconstruction jobs (M2D.2): the free mock provider only; World Labs unconfigured; paid generation off.
      PRISM_RECONSTRUCTION_JOBS_ENABLED: "1",
      PRISM_STUDIO_ENABLE_MOCK_RECONSTRUCTION: "1",
      PRISM_STUDIO_MOCK_RECONSTRUCTION_MS: "15000",
      PRISM_RECONSTRUCTION_POLL_MS: "1000",
      WLT_API_KEY: "",
      WORLDLABS_RECONSTRUCTION_ENABLED: "",
      PRISM_STUDIO_ALLOW_PAID_GENERATION: "false",
      // Local Capture (M2D.3B): the worker switch is on, with a throwaway work root; supabase-local-worker.spec.ts
      // writes the worker heartbeat there (no tool runs, no worker process in this suite)
      PRISM_LOCAL_RECONSTRUCTION_WORKER_ENABLED: "1",
      PRISM_LOCAL_RECONSTRUCTION_ROOT: path.join(os.tmpdir(), "prism-e2e-local-worker"),
      // Remote Local Agents (M2D.3C1): supabase-local-agents.spec.ts pairs the real agent CLI (no credentials)
      PRISM_LOCAL_AGENTS_ENABLED: "1",
      // M2D.3C2: the Prism SERVER's agent-relay Storage key (server-side only; the agent CLI never sees it). A machine
      // without a dedicated relay key runs this local test server with the worker key's VALUE in that role; production
      // configures a separate sb_secret_ key (docs/security-model.md).
      PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY:
        process.env.PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY ||
        process.env.PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY ||
        "",
    },
  },
});
