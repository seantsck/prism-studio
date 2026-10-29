import { defineConfig } from "@playwright/test";

/** One memory-mode server's environment (never a real database, never an external or paid provider). */
const memoryEnv = (port: number) => ({
  PRISM_STUDIO_PERSISTENCE: "memory",
  SUPABASE_DB_URL: "",
  NEXT_PUBLIC_SITE_URL: `http://localhost:${port}`,
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
  // Reconstruction jobs (M2D.2): the FREE deterministic mock provider only. World Labs is explicitly unconfigured
  // and paid generation stays off, so no E2E can reach a reconstruction provider.
  PRISM_RECONSTRUCTION_JOBS_ENABLED: "1",
  PRISM_STUDIO_ENABLE_MOCK_RECONSTRUCTION: "1",
  PRISM_STUDIO_MOCK_RECONSTRUCTION_MS: "15000",
  PRISM_RECONSTRUCTION_POLL_MS: "1000",
  WLT_API_KEY: "",
  WORLDLABS_RECONSTRUCTION_ENABLED: "",
  PRISM_STUDIO_ALLOW_PAID_GENERATION: "false",
  // Remote Local Agents (M2D.3C1): pairing + heartbeat only (no remote execution exists yet).
  PRISM_LOCAL_AGENTS_ENABLED: "1",
});

/**
 * The Phase 2H spec gets its OWN memory server (its own process, so its own in-memory store seeded fresh): it never
 * depends on what other specs wrote, and nothing it writes (frames, Locks, clips: append-only history) reaches them.
 */
const ISOLATED_2H = "zzzzzzzzzzzzzzzzzzzz-image-to-video.spec.ts";

/**
 * The Phase 2I Episode Edit spec gets its own memory server too: creating the Episode's edit is persistent for the life
 * of a store (one edit per Episode, and its pins refuse deleting what they reference), so it must neither see another
 * spec's writes (its proposal is asserted from the pristine seed) nor leave an edit behind for one.
 */
const ISOLATED_2I = "zzzzzzzzzzzzzzzzzzzzz-episode-edit.spec.ts";

/**
 * The Phase 3A.2 automatic-QA spec gets its own memory server: it changes the Project's Shot QA policy (Suggest, then
 * Automatic), which would otherwise make every later spec's generations queue semantic analysis automatically.
 */
const ISOLATED_3A2 = "zzzzzzzzzzzzzzzzzzzzzz-automatic-qa.spec.ts";

/**
 * The Phase 3A.3 temporal-QA spec gets its own memory server too: it changes the Project policy (Automatic, then
 * full-video permission) and runs Gemini through the in-memory FAKE transport with the server's direct-video gate on.
 */
const ISOLATED_3A3 = "zzzzzzzzzzzzzzzzzzzzzzz-temporal-video-qa.spec.ts";

/**
 * The Phase 3A.4B Continuity Supervisor spec gets its own memory server: it creates the Episode's edit (persistent for
 * the life of a store, one per Episode) and reorders it, which no other spec may see.
 */
const ISOLATED_3A4B = "zzzzzzzzzzzzzzzzzzzzzzzz-continuity-supervisor.spec.ts";

/**
 * TEST SERVERS ONLY. Playwright's request client reuses keep-alive sockets; at Node's default idle-close boundary
 * (5 s + 1 s buffer) the server could close a socket while `page.request` was reusing it, giving ECONNRESET before
 * the request reached the app. Longer than the longest test (20 min), so each test's request context closes first.
 */
const KEEP_ALIVE = "--keepAliveTimeout 1500000";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  // Tests share one in-memory server and a few mutate (then restore) state: run them serially.
  workers: 1,
  projects: [
    {
      name: "memory",
      testIgnore: ["supabase-*.spec.ts", ISOLATED_2H, ISOLATED_2I, ISOLATED_3A2, ISOLATED_3A3, ISOLATED_3A4B],
      use: { baseURL: "http://localhost:3102" },
    },
    {
      name: "memory-2h-isolated",
      testMatch: ISOLATED_2H,
      use: { baseURL: "http://localhost:3103" },
    },
    {
      name: "memory-2i-isolated",
      testMatch: ISOLATED_2I,
      use: { baseURL: "http://localhost:3104" },
    },
    {
      name: "memory-3a2-isolated",
      testMatch: ISOLATED_3A2,
      use: { baseURL: "http://localhost:3105" },
    },
    {
      name: "memory-3a3-isolated",
      testMatch: ISOLATED_3A3,
      use: { baseURL: "http://localhost:3106" },
    },
    {
      name: "memory-3a4b-isolated",
      testMatch: ISOLATED_3A4B,
      use: { baseURL: "http://localhost:3107" },
    },
  ],
  // Started in order: the first builds; the others serve the same build from separate processes (separate stores).
  webServer: [
    {
      command: `npm run build && npx next start -p 3102 ${KEEP_ALIVE}`,
      url: "http://localhost:3102",
      // Always a fresh server in memory mode: e2e must never reach a real database, even if .env.local says otherwise.
      reuseExistingServer: false,
      timeout: 300_000,
      env: memoryEnv(3102),
    },
    {
      command: `npx next start -p 3103 ${KEEP_ALIVE}`,
      url: "http://localhost:3103",
      reuseExistingServer: false,
      timeout: 120_000,
      env: memoryEnv(3103),
    },
    {
      command: `npx next start -p 3104 ${KEEP_ALIVE}`,
      url: "http://localhost:3104",
      reuseExistingServer: false,
      timeout: 120_000,
      env: memoryEnv(3104),
    },
    {
      command: `npx next start -p 3105 ${KEEP_ALIVE}`,
      url: "http://localhost:3105",
      reuseExistingServer: false,
      timeout: 120_000,
      env: memoryEnv(3105),
    },
    {
      command: `npx next start -p 3106 ${KEEP_ALIVE}`,
      url: "http://localhost:3106",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...memoryEnv(3106),
        // Gemini through the FAKE transport only (memory mode + PRISM_STUDIO_ANALYSIS_TRANSPORT=fake): the placeholder
        // is not a credential and nothing can leave the process. The server's direct-video gate is on here only.
        GEMINI_API_KEY: "e2e-placeholder-not-a-credential",
        PRISM_STUDIO_GEMINI_DIRECT_VIDEO: "1",
        PRISM_STUDIO_MAX_ANALYSIS_USD_PER_RUN: "0.50",
      },
    },
    {
      command: `npx next start -p 3107 ${KEEP_ALIVE}`,
      url: "http://localhost:3107",
      reuseExistingServer: false,
      timeout: 120_000,
      env: memoryEnv(3107),
    },
  ],
});
