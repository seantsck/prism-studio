import type { GenerationModel, GenerationProviderInfo, ModelAvailability } from "@/domain/generation/schemas";
import { missingConfig, readGenerationConfig, type GenerationConfig } from "./config";
import type { GenerationProviderAdapter } from "./provider";
import { MockProvider } from "./providers/mock";

/**
 * Server-side model registry: which providers/models exist, what they can do, whether they are enabled and
 * configured. It exposes availability WITHOUT credentials: `ModelAvailability` carries names of missing
 * configuration, never values.
 */
export class ModelRegistry {
  private readonly adapters = new Map<string, GenerationProviderAdapter>();

  constructor(
    adapters: GenerationProviderAdapter[],
    private readonly config: GenerationConfig,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    for (const a of adapters) this.adapters.set(a.info().provider, a);
  }

  providers(): GenerationProviderInfo[] {
    return [...this.adapters.values()].map((a) => a.info());
  }

  adapter(provider: string): GenerationProviderAdapter | null {
    return this.adapters.get(provider) ?? null;
  }

  models(): GenerationModel[] {
    return [...this.adapters.values()].flatMap((a) => a.listModels());
  }

  model(provider: string, modelId: string): GenerationModel | null {
    return (
      this.adapter(provider)
        ?.listModels()
        .find((m) => m.modelId === modelId) ?? null
    );
  }

  availabilityOf(model: GenerationModel): ModelAvailability {
    const adapter = this.adapters.get(model.provider);
    const info = adapter?.info();
    const enabled = this.config.enabledProviders.includes(model.provider);
    const missing = info ? missingConfig(info.requiredConfig, this.env) : [];
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
      available: enabled && missing.length === 0 && model.lifecycle !== "retired",
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
  // Real adapters are added here once implemented and verified against the provider's current official API.
  return new ModelRegistry(adapters, config, env);
}
