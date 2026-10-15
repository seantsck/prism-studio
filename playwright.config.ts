import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "supabase-*.spec.ts",
  timeout: 30_000,
  // Tests share one in-memory server and a few mutate (then restore) state: run them serially.
  workers: 1,
  use: { baseURL: "http://localhost:3102" },
  webServer: {
    command: "npm run build && npx next start -p 3102",
    url: "http://localhost:3102",
    // Always a fresh server in memory mode: e2e must never reach a real database, even if .env.local says otherwise.
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      PRISM_STUDIO_PERSISTENCE: "memory",
      SUPABASE_DB_URL: "",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3102",
      // Generation: the free MockProvider, run in-process with short stage delays (no external calls).
      PRISM_STUDIO_ENABLE_MOCK_PROVIDER: "1",
      PRISM_STUDIO_MOCK_STAGE_DELAY_MS: "400",
      PRISM_STUDIO_WORKER_IDLE_POLL_MS: "250",
      PRISM_STUDIO_DEV_GENERATION_TICK: "1",
      // Continuity analysis: the free Mock analyzer runs; Gemini is listed but has NO credential and paid
      // analysis stays off, so no E2E can ever reach an external analyzer even if .env.local holds a key.
      PRISM_STUDIO_CONTINUITY_ANALYZERS: "mock,gemini,openai",
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
      // OpenAI runs against a deterministic in-memory transport (PRISM_STUDIO_ANALYSIS_TRANSPORT=fake, memory
      // mode only): the placeholder key is not a credential and no request can leave the process. The spend gate
      // is real: a ceiling is required and the analysis must be acknowledged.
      OPENAI_API_KEY: "e2e-placeholder-not-a-credential",
      PRISM_STUDIO_ANALYSIS_TRANSPORT: "fake",
      PRISM_STUDIO_ALLOW_PAID_ANALYSIS: "true",
      PRISM_STUDIO_MAX_ANALYSIS_USD_PER_RUN: "0.10",
    },
  },
});
