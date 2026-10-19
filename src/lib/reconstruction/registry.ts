import { readGenerationConfig } from "@/generation/config";
import type { JobCostEstimate, ReconstructionProviderId } from "@/domain/reconstruction/job";
import { LocalCaptureProvider, type LocalToolchain } from "./local-capture";
import { MockReconstructionProvider, readMockConfig } from "./mock";
import type { InputMode, ProviderCapabilities, ProviderStatus, ReconstructionProvider } from "./provider";
import { readWorldLabsConfig, WorldLabsProvider } from "./worldlabs";

/**
 * The provider REGISTRY: the only place that knows which reconstruction providers exist. Provider ids in the
 * database are plain identifiers (migration 0037); whether an id is known, local or hosted, free or paid, and
 * available is decided here, from each adapter's capabilities and status.
 *
 * Free first: `local_capture` (free, runs on this machine; M2D.3) is listed first. World Labs Marble is an OPTIONAL
 * hosted, PAID provider. Prism never requires it, never selects it on its own, and never falls back to it. ArtCraft is
 * deliberately not a provider: its "Image to Location" is a paid cloud relay to World Labs / fal.ai behind an
 * ArtCraft account and credits, which is exactly the dependency Prism avoids.
 *
 * A provider is usable only when ALL of these hold:
 *   - PRISM_RECONSTRUCTION_JOBS_ENABLED=1            the feature is on for this server
 *   - the provider is available                       local: its toolchain is installed (M2D.3)
 *                                                     World Labs: WORLDLABS_RECONSTRUCTION_ENABLED=1 + WLT_API_KEY
 *   - for a paid / unknown-cost provider: the live-spend gate (PRISM_STUDIO_ALLOW_PAID_GENERATION=true and a
 *     PRISM_STUDIO_MAX_GENERATION_USD ceiling covering the documented maximum price) AND an explicit cost
 *     acknowledgement from the user on that request
 * An API key alone never activates anything. The mock provider is free and exists only on development/test servers.
 */
export interface ReconstructionConfig {
  jobsEnabled: boolean;
  paid: { enabled: boolean; maxUsd: number | null };
  /** minimum time between two provider polls of one job */
  pollIntervalMs: number;
}

export function readReconstructionConfig(
  env: Record<string, string | undefined> = process.env,
): ReconstructionConfig {
  const gen = readGenerationConfig(env);
  const poll = Number.parseInt(env.PRISM_RECONSTRUCTION_POLL_MS ?? "", 10);
  return {
    jobsEnabled: ["1", "true"].includes((env.PRISM_RECONSTRUCTION_JOBS_ENABLED ?? "").trim().toLowerCase()),
    paid: { enabled: gen.paid.enabled, maxUsd: gen.paid.maxUsd },
    // providers are not hammered: 5 s minimum unless a (test) server sets a shorter one explicitly
    pollIntervalMs: Number.isFinite(poll) && poll >= 250 ? poll : 5000,
  };
}

export type ProviderRegistry = Map<ReconstructionProviderId, ReconstructionProvider>;

export function buildProviders(
  env: Record<string, string | undefined> = process.env,
  opts: { localToolchain?: LocalToolchain } = {},
): ProviderRegistry {
  const providers: ProviderRegistry = new Map();
  const add = (p: ReconstructionProvider) => providers.set(p.id, p);
  add(new LocalCaptureProvider(opts.localToolchain));
  add(new WorldLabsProvider(readWorldLabsConfig(env)));
  const mock = readMockConfig(env);
  if (mock.available) add(new MockReconstructionProvider(mock));
  return providers;
}

/** What the UI may know about each provider: capabilities and status only, never a credential or URL. */
export interface ProviderSummary
  extends
    ProviderStatus,
    Pick<
      ProviderCapabilities,
      | "execution"
      | "runner"
      | "cost"
      | "inputModes"
      | "resultKinds"
      | "maxInputs"
      | "minInputs"
      | "inputMimes"
      | "defaultModel"
      | "options"
      | "supportsCancel"
      | "supportsProgress"
      | "supportsResume"
      | "testOnly"
    > {
  models: Array<{ id: string; label: string }>;
  /** the documented cost per model ("" = no model) and input mode, computed by the adapter */
  estimates: Record<string, Partial<Record<InputMode, JobCostEstimate>>>;
}

export function providerSummaries(providers: ProviderRegistry): ProviderSummary[] {
  return [...providers.values()].map((p) => {
    const c = p.capabilities();
    const modelIds = c.models.length ? c.models.map((m) => m.id) : [null];
    const estimates: ProviderSummary["estimates"] = {};
    for (const m of modelIds)
      estimates[m ?? ""] = Object.fromEntries(c.inputModes.map((mode) => [mode, p.estimateCost(m, mode)]));
    return {
      ...p.status(),
      execution: c.execution,
      runner: c.runner,
      cost: c.cost,
      inputModes: [...c.inputModes],
      resultKinds: [...c.resultKinds],
      maxInputs: c.maxInputs,
      ...(c.minInputs ? { minInputs: c.minInputs } : {}),
      ...(c.inputMimes ? { inputMimes: [...c.inputMimes] } : {}),
      models: c.models.map((m) => ({ id: m.id, label: m.label })),
      defaultModel: c.defaultModel,
      options: c.options,
      supportsCancel: c.supportsCancel,
      supportsProgress: c.supportsProgress,
      supportsResume: c.supportsResume,
      testOnly: c.testOnly,
      estimates,
    };
  });
}

/**
 * The provider pre-selected in the UI: a FREE, LOCAL provider that is ready right now, else none. A paid provider
 * (or the test mock) is never pre-selected, even when it is the only one available: the user picks it explicitly.
 */
export function defaultProviderId(summaries: ProviderSummary[]): ReconstructionProviderId | null {
  return (
    summaries.find(
      (s) =>
        s.execution === "local" &&
        s.cost === "free" &&
        s.configured &&
        s.enabled &&
        s.capability === "available",
    )?.provider ?? null
  );
}
