import type { GenerationModel, GenerationProviderInfo, ModelAvailability } from "@/domain/generation/schemas";
import { missingConfig, readGenerationConfig, type GenerationConfig } from "./config";
import type { GenerationProviderAdapter } from "./provider";
import { MockProvider } from "./providers/mock";
import { RunwayProvider } from "./providers/runway/adapter";

/**
 * Server-side model registry: which providers/models exist, what they can do, whether they are enabled and
 * configured. It exposes availability WITHOUT credentials: `ModelAvailability` carries names of missing
 * configuration, never values.
 */
export class ModelRegistry {
  private readonly adapters_ = new Map<string, GenerationProviderAdapter>();

  constructor(
    adapters: GenerationProviderAdapter[],
    private readonly config: GenerationConfig,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    for (const a of adapters) this.adapters_.set(a.info().provider, a);
  }

  adapters(): GenerationProviderAdapter[] {
    return [...this.adapters_.values()];
  }

  providers(): GenerationProviderInfo[] {
    return [...this.adapters_.values()].map((a) => a.info());
  }

  adapter(provider: string): GenerationProviderAdapter | null {
    return this.adapters_.get(provider) ?? null;
  }

  models(): GenerationModel[] {
    return [...this.adapters_.values()].flatMap((a) => a.listModels());
  }

  model(provider: string, modelId: string): GenerationModel | null {
    return (
      this.adapter(provider)
        ?.listModels()
        .find((m) => m.modelId === modelId) ?? null
    );
  }

  /** The live-spend gate configuration (shared by the UI gate, submission and the worker). */
  spendPolicy(): GenerationConfig["paid"] {
    return this.config.paid;
  }

  /** Mock models are free; everything else bills and is subject to the spend gate. */
  billsMoney(model: GenerationModel): boolean {
    return model.kind !== "mock";
  }

  availabilityOf(model: GenerationModel): ModelAvailability {
    const adapter = this.adapters_.get(model.provider);
    const info = adapter?.info();
    const enabled = this.config.enabledProviders.includes(model.provider);
    const missing = info ? missingConfig(info.requiredConfig, this.env) : [];
    const paidGenerationEnabled = !this.billsMoney(model) || this.config.paid.enabled;
    return {
      provider: model.provider,
      providerName: info?.displayName ?? model.provider,
      modelId: model.modelId,
      displayName: model.displayName,
      description: model.description,
      kind: model.kind,
      modalities: model.capabilities.modalities,
      enabled,
      configured: missing.length === 0,
      missingConfig: missing,
      paidGenerationEnabled,
      available: enabled && missing.length === 0 && model.lifecycle !== "retired" && paidGenerationEnabled,
      lifecycle: model.lifecycle,
    };
  }

  availability(): ModelAvailability[] {
    return this.models().map((m) => this.availabilityOf(m));
  }

  /** Models a user can pick right now. */
  usable(): GenerationModel[] {
    return this.models().filter((m) => this.availabilityOf(m).available);
  }
}

/** Builds the registry from environment configuration. New provider adapters are registered here. */
export function createRegistry(
  env: Record<string, string | undefined> = process.env,
  config: GenerationConfig = readGenerationConfig(env),
): ModelRegistry {
  const adapters: GenerationProviderAdapter[] = [
    new MockProvider({ stageDelayMs: config.mock.stageDelayMs }),
  ];
  // Real adapters: registered always (so their availability and blockers are visible), enabled per deployment
  // through PRISM_STUDIO_GENERATION_PROVIDERS and configured through their own credentials.
  adapters.push(new RunwayProvider({ env }));
  return new ModelRegistry(adapters, config, env);
}
