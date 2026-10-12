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
    env: { PRISM_STUDIO_PERSISTENCE: "supabase", NEXT_PUBLIC_SITE_URL: "http://localhost:3101" },
  },
});
