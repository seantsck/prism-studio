import { FakeStoryProvider } from "./providers/fake";
import { OpenAIStoryProvider } from "./providers/openai";
import type { StoryIntelligenceProvider, StoryModel } from "./provider";

/**
 * Phase 5B-S1: which Story Intelligence providers/models this server offers, and the spend policy for paid ones.
 * Provider priority (the listing order): OpenAI first, Claude next (a future implementation of the same interface),
 * then the free test analyser. The human chooses the model; nothing is substituted.
 *
 *   PRISM_STUDIO_STORY_AI_PROVIDERS     comma list (default "openai"); the free test analyser is added only with
 *                                       PRISM_STUDIO_ENABLE_MOCK_PROVIDER=1
 *   PRISM_STUDIO_ALLOW_PAID_STORY_AI    "true" to allow paid analysis at all (default off: nothing silently spends)
 *   PRISM_STUDIO_STORY_AI_MAX_USD       per-analysis ceiling (default 1)
 *   PRISM_STUDIO_PROVIDER_OPENAI_STORY_API_KEY   worker only (see providers/openai.ts)
 */
export interface StorySpendPolicy {
  paidEnabled: boolean;
  maxUsd: number;
}

export class StoryRegistry {
  constructor(
    private readonly providers: StoryIntelligenceProvider[],
    readonly spend: StorySpendPolicy,
  ) {}

  models(): Array<StoryModel & { available: boolean; reason: string | null }> {
    return this.providers.flatMap((p) =>
      p.models().map((m) => {
        const reason =
          p.unavailable(m) ??
          (m.paid && !this.spend.paidEnabled ? "Paid analysis is switched off on this server." : null);
        return { ...m, available: reason === null, reason };
      }),
    );
  }

  model(provider: string, modelId: string): StoryModel | null {
    return (
      this.providers
        .find((p) => p.id === provider)
        ?.models()
        .find((m) => m.modelId === modelId) ?? null
    );
  }

  provider(id: string): StoryIntelligenceProvider | null {
    return this.providers.find((p) => p.id === id) ?? null;
  }
}

export function readStorySpend(env: Record<string, string | undefined>): StorySpendPolicy {
  const max = Number(env.PRISM_STUDIO_STORY_AI_MAX_USD ?? "1");
  return {
    paidEnabled: env.PRISM_STUDIO_ALLOW_PAID_STORY_AI === "true",
    maxUsd: Number.isFinite(max) && max >= 0 ? max : 1,
  };
}

export function createStoryRegistry(
  env: Record<string, string | undefined>,
  extra: StoryIntelligenceProvider[] = [],
): StoryRegistry {
  const wanted = (env.PRISM_STUDIO_STORY_AI_PROVIDERS ?? "openai")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const providers: StoryIntelligenceProvider[] = [];
  if (wanted.includes("openai")) providers.push(new OpenAIStoryProvider({ env }));
  if (env.PRISM_STUDIO_ENABLE_MOCK_PROVIDER === "1") providers.push(new FakeStoryProvider());
  return new StoryRegistry([...providers, ...extra], readStorySpend(env));
}
