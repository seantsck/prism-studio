import { readGenerationConfig } from "@/generation/config";
import type { ReconstructionProviderId } from "@/domain/reconstruction/job";
import { MockReconstructionProvider, readMockConfig } from "./mock";
import type { ProviderStatus, ReconstructionProvider } from "./provider";
import { readWorldLabsConfig, WorldLabsProvider } from "./worldlabs";

/**
 * Reconstruction configuration. A provider is usable only when ALL of these hold:
 *   - PRISM_RECONSTRUCTION_JOBS_ENABLED=1            the feature is on for this server
 *   - the provider is enabled AND configured          e.g. WORLDLABS_RECONSTRUCTION_ENABLED=1 + WLT_API_KEY
 *   - for a billable provider: the live-spend gate    PRISM_STUDIO_ALLOW_PAID_GENERATION=true + a USD ceiling
 *     (PRISM_STUDIO_MAX_GENERATION_USD) that covers the documented cost of the chosen model
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

export function buildProviders(
  env: Record<string, string | undefined> = process.env,
): Map<ReconstructionProviderId, ReconstructionProvider> {
  const providers = new Map<ReconstructionProviderId, ReconstructionProvider>();
  providers.set("worldlabs_marble", new WorldLabsProvider(readWorldLabsConfig(env)));
  const mock = readMockConfig(env);
  if (mock.available) providers.set("mock_reconstruction", new MockReconstructionProvider(mock));
  return providers;
}

/** What the UI may know about each provider: status only, never a credential or URL. */
export interface ProviderSummary extends ProviderStatus {
  billable: boolean;
  testOnly: boolean;
  maxImages: number;
  models: Array<{
    id: string;
    label: string;
    usd: { min: number; max: number } | null;
    credits: { min: number; max: number } | null;
  }>;
  defaultModel: string | null;
  supportsCancel: boolean;
}

export function providerSummaries(
  providers: Map<ReconstructionProviderId, ReconstructionProvider>,
): ProviderSummary[] {
  return [...providers.values()].map((p) => {
    const c = p.capabilities();
    return {
      ...p.status(),
      billable: c.billable,
      testOnly: c.testOnly,
      maxImages: c.maxImages,
      models: c.models.map((m) => ({ id: m.id, label: m.label, usd: m.usd, credits: m.credits })),
      defaultModel: c.defaultModel,
      supportsCancel: c.supportsCancel,
    };
  });
}
