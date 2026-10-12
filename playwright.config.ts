import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "supabase-auth.spec.ts",
  timeout: 30_000,
  // Tests share one in-memory server and a few mutate (then restore) state: run them serially.
  workers: 1,
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "npm run build && npx next start -p 3100",
    url: "http://localhost:3100",
    // Always a fresh server in memory mode: e2e must never reach a real database, even if .env.local says otherwise.
    reuseExistingServer: false,
    timeout: 300_000,
    env: { PRISM_STUDIO_PERSISTENCE: "memory", SUPABASE_DB_URL: "" },
  },
});
