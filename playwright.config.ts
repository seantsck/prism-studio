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
    },
  },
});
