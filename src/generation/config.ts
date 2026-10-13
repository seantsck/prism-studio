/**
 * Server-side generation configuration. Read from the environment ONLY on the server / in the worker.
 * Nothing here is ever sent to the browser, stored in a snapshot, exported in a brief or logged.
 *
 * Provider credentials follow one naming convention so adapters stay declarative:
 *     PRISM_STUDIO_PROVIDER_<PROVIDER_ID>_API_KEY      (adapter declares the names it needs in requiredConfig)
 * `.env.example` lists names only.
 */

export interface GenerationConfig {
  /** Provider ids enabled in this deployment. */
  enabledProviders: string[];
  limits: {
    maxActivePerProject: number;
    maxSubmitsPerMinutePerUser: number;
    maxJobAttempts: number;
  };
  worker: {
    concurrency: number;
    leaseMs: number;
    heartbeatMs: number;
    idlePollMs: number;
  };
  download: {
    maxBytes: number;
    timeoutMs: number;
    maxRedirects: number;
  };
  mock: {
    /** Simulated provider latency. 0 = completes on the first poll (used by tests). */
    stageDelayMs: number;
  };
}

type Env = Record<string, string | undefined>;

const intFrom = (raw: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function readGenerationConfig(env: Env = process.env): GenerationConfig {
  const production = env.NODE_ENV === "production";
  const listed = (env.PRISM_STUDIO_GENERATION_PROVIDERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // The mock provider is on by default outside production and must be enabled explicitly there.
  const enabledProviders = [...new Set([...listed, ...(production ? [] : ["mock"])])];
  if (production && env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER === "1") enabledProviders.push("mock");

  return {
    enabledProviders: [...new Set(enabledProviders)],
    limits: {
      maxActivePerProject: intFrom(env.PRISM_STUDIO_GENERATION_MAX_ACTIVE_PER_PROJECT, 3, 1, 50),
      maxSubmitsPerMinutePerUser: intFrom(env.PRISM_STUDIO_GENERATION_MAX_SUBMITS_PER_MINUTE, 10, 1, 600),
      maxJobAttempts: intFrom(env.PRISM_STUDIO_GENERATION_MAX_ATTEMPTS, 4, 1, 20),
    },
    worker: {
      concurrency: intFrom(env.PRISM_STUDIO_WORKER_CONCURRENCY, 2, 1, 16),
      leaseMs: intFrom(env.PRISM_STUDIO_WORKER_LEASE_MS, 60_000, 5_000, 600_000),
      heartbeatMs: intFrom(env.PRISM_STUDIO_WORKER_HEARTBEAT_MS, 20_000, 1_000, 300_000),
      idlePollMs: intFrom(env.PRISM_STUDIO_WORKER_IDLE_POLL_MS, 2_000, 100, 60_000),
    },
    download: {
      maxBytes: intFrom(env.PRISM_STUDIO_GENERATION_MAX_DOWNLOAD_BYTES, 50 * 1024 * 1024, 1024),
      timeoutMs: intFrom(env.PRISM_STUDIO_GENERATION_DOWNLOAD_TIMEOUT_MS, 60_000, 1_000, 600_000),
      maxRedirects: intFrom(env.PRISM_STUDIO_GENERATION_MAX_REDIRECTS, 3, 0, 10),
    },
    mock: { stageDelayMs: intFrom(env.PRISM_STUDIO_MOCK_STAGE_DELAY_MS, 1_500, 0, 60_000) },
  };
}

/** Environment variable name an adapter reads a provider credential from. */
export function providerEnvName(provider: string, key: string): string {
  return `PRISM_STUDIO_PROVIDER_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${key.toUpperCase()}`;
}

/** Names of the configuration entries that are missing (never their values). */
export function missingConfig(required: readonly string[], env: Env = process.env): string[] {
  return required.filter((name) => !env[name]?.trim());
}
