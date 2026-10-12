import { defineConfig } from "@playwright/test";

// Same smoke suite, but against the real dedicated Prism Studio database (PostgresRepository).
// Safe by construction: read-only navigation plus one take selection that restores itself.
// Requires `npm run db:seed -- --reset` first so the demo project is pristine.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "smoke.spec.ts",
  timeout: 60_000,
  workers: 1,
  expect: { timeout: 15_000 }, // remote DB: each action is a load + write + re-render
  use: { baseURL: "http://localhost:3101" },
  webServer: {
    command: "npm run build && npx next start -p 3101",
    url: "http://localhost:3101",
    reuseExistingServer: false,
    timeout: 300_000,
    // SUPABASE_DB_URL / PRISM_STUDIO_DEV_USER_ID come from .env.local (loaded by Next).
    env: { PRISM_STUDIO_PERSISTENCE: "supabase" },
  },
});
