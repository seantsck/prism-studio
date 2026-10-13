import type { PricingTable } from "@/domain/continuity/analysis/cost";

/**
 * OpenAI continuity analyzer configuration: the ONLY place the model id, SDK pin, detail policy and pricing live.
 *
 * Verified against the official documentation on 2026-10-13 (developers.openai.com/api/docs):
 *   - model:    /models/gpt-6-luna          id `gpt-6-luna`; input text+image, output text; Structured outputs
 *               supported; endpoints v1/responses, v1/chat/completions, v1/batch; context 1,050,000 tokens,
 *               max output 128,000; only snapshot is `gpt-6-luna`
 *   - pricing:  /pricing                    $0.10 / 1M input, $0.01 / 1M cached input, $0.50 / 1M output
 *               (standard, ≤ 272K input tokens). Over 272K input tokens the WHOLE request is 2× input/cache and
 *               1.5× output.
 *   - images:   /guides/images-vision       `input_image` with `image_url` (URL or base64 data URL) or `file_id`,
 *               `detail` low|high|original|auto (default auto); PNG/JPEG/WEBP/non-animated GIF; patch-based
 *               tokenization (32×32 patches × a per-model multiplier)
 *   - schemas:  /guides/structured-outputs  `text.format = {type: json_schema, name, schema, strict: true}`;
 *               refusals appear as a `refusal` content item; `incomplete` status with `incomplete_details.reason`
 *   - errors:   /guides/error-codes         401 auth, 403 region, 429 rate limit OR quota/billing (check
 *               `error.code`), 500, 503 overloaded; honour `Retry-After`
 *   - SDK:      `openai` 7.32.0 (npm `latest` on 2026-10-13), `client.responses.create`
 * Pricing is configuration, not scraped at runtime: when it changes, bump `version` here.
 *
 * ONE analyzer implementation serves every listed model. A model that is not listed is BLOCKED (never silently
 * priced or sent). Astra/Sol are intentionally not listed yet; adding one is a registry + price entry.
 */
export const OPENAI_ANALYZER_ID = "openai";
export const OPENAI_ANALYZER_VERSION = "1";
export const OPENAI_SDK = "openai@7.32.0";
export const OPENAI_DEFAULT_MODEL = "gpt-6-luna";
export const OPENAI_ENDPOINT = "POST /v1/responses";

/**
 * Image detail policy (centralised). Continuity judges identity, wardrobe and scene, not OCR-grade pixels, and
 * Prism already bounds every image (≤ maxImageDimension): `high` is the documented standard-fidelity level.
 * `original` (dense/small-text/computer-use) and provider `auto` (model-dependent, non-deterministic cost) are
 * deliberately not used.
 */
export const OPENAI_IMAGE_DETAIL = "high" as const;

/**
 * Assumed tokens-per-patch multiplier for the PRE-request estimate. The documentation publishes 1.2 for
 * gpt-6-astra and nothing for gpt-6-luna, so a deliberately higher value is used: the estimate is a ceiling
 * for the spend gate, never a quote. Actual cost always comes from the response's usage.
 */
export const OPENAI_ASSUMED_PATCH_MULTIPLIER = 1.5;

export interface OpenAIModelSpec {
  id: string;
  label: string;
  status: "stable";
  inputs: ReadonlyArray<"text" | "image">;
  outputs: ReadonlyArray<"text">;
  structuredOutputs: boolean;
  reasoning: boolean;
  verifiedAt: string;
  source: string;
}

export const OPENAI_MODELS: readonly OpenAIModelSpec[] = [
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    status: "stable",
    inputs: ["text", "image"],
    outputs: ["text"],
    structuredOutputs: true,
    reasoning: true,
    verifiedAt: "2026-10-13",
    source: "https://developers.openai.com/api/docs/models/gpt-6-luna",
  },
];

export const OPENAI_PRICING: PricingTable = {
  version: "openai-2026-10-13",
  source:
    "https://developers.openai.com/api/docs/pricing (standard processing, per 1M tokens, short context ≤ 272K input tokens)",
  checkedAt: "2026-10-13",
  models: [
    {
      provider: "openai",
      model: "gpt-6-luna",
      rates: [
        {
          from: "2026-01-01",
          inputPerMillionUsd: 0.1,
          outputPerMillionUsd: 0.5,
          cachedInputPerMillionUsd: 0.01,
        },
      ],
      // image input is tokenized and billed as input tokens; reasoning tokens are billed as output tokens
      mediaBilledAsText: true,
      longContext: { aboveInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    },
  ],
};

/** Why a model may not be used (null = supported): needs listing, image input, structured output, a price. */
export function openaiModelBlocker(model: string): string | null {
  const spec = OPENAI_MODELS.find((m) => m.id === model);
  if (!spec) return `Model "${model}" is not a verified continuity-analysis model.`;
  if (spec.status !== "stable") return `Model "${model}" is not a stable release.`;
  if (!spec.inputs.includes("image")) return `Model "${model}" does not accept image input.`;
  if (!spec.structuredOutputs) return `Model "${model}" does not support structured outputs.`;
  if (!OPENAI_PRICING.models.some((m) => m.provider === "openai" && m.model === model))
    return `Model "${model}" has no verified price.`;
  return null;
}

export type OpenAIState = "configured" | "missing_credential" | "disabled" | "unsupported_model";

export type OpenAIReasoningEffort = "none" | "low" | "medium" | "high";

export interface OpenAIConfig {
  enabled: boolean;
  /** Secret: server/worker only. Never serialised to the browser, a job, a log or a manifest. */
  apiKey: string | null;
  model: string;
  /** Absolute ceiling on one response (reasoning tokens count against it). */
  maxOutputTokensCap: number;
  timeoutMs: number;
  reasoningEffort: OpenAIReasoningEffort;
}

export function readOpenAIConfig(env: Record<string, string | undefined>): OpenAIConfig {
  const providers = (env.PRISM_STUDIO_CONTINUITY_ANALYZERS ?? "mock")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const effort = (env.PRISM_STUDIO_OPENAI_REASONING_EFFORT ?? "low").toLowerCase();
  return {
    enabled: providers.includes("openai"),
    apiKey: env.OPENAI_API_KEY?.trim() || null,
    model: env.PRISM_STUDIO_OPENAI_ANALYSIS_MODEL?.trim() || OPENAI_DEFAULT_MODEL,
    maxOutputTokensCap: 8192,
    timeoutMs:
      Number(env.PRISM_STUDIO_OPENAI_TIMEOUT_MS) > 0 ? Number(env.PRISM_STUDIO_OPENAI_TIMEOUT_MS) : 120_000,
    reasoningEffort: (["none", "low", "medium", "high"].includes(effort)
      ? effort
      : "low") as OpenAIReasoningEffort,
  };
}

export const openaiState = (c: OpenAIConfig): OpenAIState =>
  !c.enabled
    ? "disabled"
    : openaiModelBlocker(c.model)
      ? "unsupported_model"
      : c.apiKey
        ? "configured"
        : "missing_credential";

/** Patch-based image token estimate (conservative ceiling; see OPENAI_ASSUMED_PATCH_MULTIPLIER). */
export function openaiImageTokens(width: number | null, height: number | null): number {
  if (!width || !height) return Math.ceil(32 * 32 * OPENAI_ASSUMED_PATCH_MULTIPLIER); // assume 1024×1024
  return Math.ceil(Math.ceil(width / 32) * Math.ceil(height / 32) * OPENAI_ASSUMED_PATCH_MULTIPLIER);
}
