import { defineConfig } from "@playwright/test";

/**
 * Manual live-smoke harness (NOT part of the default suite). Starts a production server against the REAL
 * Supabase project for the UI half of one approved paid smoke; the paid request is made later, by the separate
 * continuity worker process. See docs/providers/openai-continuity.md ("Semantic smoke runbook").
 *
 *   LIVE_SMOKE_APPROVED=yes SMOKE_PAID=true node --env-file=.env.local node_modules/@playwright/test/cli.js \
 *     test -c playwright.live.config.ts
 */
const paid = process.env.SMOKE_PAID === "true" ? "true" : "false";
export default defineConfig({
  testDir: "./e2e-live",
  timeout: 240_000,
  workers: 1,
  expect: { timeout: 30_000 },
  use: { baseURL: "http://localhost:3104" },
  webServer: {
    command: "npx next start -p 3104",
    url: "http://localhost:3104/login",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PRISM_STUDIO_PERSISTENCE: "supabase",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3104",
      PRISM_STUDIO_CONTINUITY_ANALYZERS: "mock,openai",
      PRISM_STUDIO_ALLOW_PAID_ANALYSIS: paid,
      PRISM_STUDIO_MAX_ANALYSIS_USD_PER_RUN: "0.10",
      PRISM_STUDIO_ANALYSIS_MAX_TRANSPORT_CALLS: "4",
      PRISM_STUDIO_ANALYSIS_TRANSPORT: "",
      GEMINI_API_KEY: "",
      GOOGLE_API_KEY: "",
    },
  },
});
