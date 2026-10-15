import type { PricingTable } from "@/domain/continuity/analysis/cost";

/**
 * Gemini continuity analyzer configuration: the ONLY place the model id, SDK pin and pricing live.
 *
 * Verified against the official documentation on 2026-10-13:
 *   - models:   https://ai.google.dev/gemini-api/docs/models        gemini-3.8-flash and gemini-3.6-flash (both Stable)
 *   - model pg: https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash  inputs Text/Image/Video/Audio/PDF,
 *               output Text, Structured outputs Supported, Thinking Supported (latest update July 2026)
 *   - pricing:  https://ai.google.dev/gemini-api/docs/pricing       page last updated 2026-10-13
 *   - SDK:      @google/genai 2.29.0 (npm `latest`), `ai.models.generateContent`
 * Pricing is configuration, not scraped at runtime: when it changes, bump `version` here.
 *
 * ONE analyzer implementation serves every listed model; a model is selected by id and carries its own
 * capability record and price. A model that is not listed here is BLOCKED (never silently priced or sent).
 */
export const GEMINI_ANALYZER_ID = "gemini";
export const GEMINI_ANALYZER_VERSION = "1";
export const GEMINI_SDK = "@google/genai@2.29.0";
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";

export interface GeminiModelSpec {
  id: string;
  /** Official lifecycle status at `verifiedAt`. Only stable models may be used for analysis. */
  status: "stable";
  inputs: ReadonlyArray<"text" | "image" | "video" | "audio" | "pdf">;
  outputs: ReadonlyArray<"text">;
  structuredOutputs: boolean;
  thinking: boolean;
  verifiedAt: string;
  source: string;
}

/** Models Prism is willing to send continuity analysis to. Same analyzer, model-specific capability + price. */
export const GEMINI_MODELS: readonly GeminiModelSpec[] = [
  {
    id: "gemini-3.8-flash",
    status: "stable",
    inputs: ["text", "image", "video", "audio", "pdf"],
    outputs: ["text"],
    structuredOutputs: true,
    thinking: true,
    verifiedAt: "2026-10-13",
    source: "https://ai.google.dev/gemini-api/docs/models (Stable, New Stable)",
  },
  {
    id: "gemini-3.6-flash",
    status: "stable",
    inputs: ["text", "image", "video", "audio", "pdf"],
    outputs: ["text"],
    structuredOutputs: true,
    thinking: true,
    verifiedAt: "2026-10-13",
    source: "https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash (Stable; July 2026)",
  },
];

/** Why a model may not be used (null = supported): needs listing, image input, structured output, a price. */
export function geminiModelBlocker(model: string): string | null {
  const spec = GEMINI_MODELS.find((m) => m.id === model);
  if (!spec) return `Model "${model}" is not a verified continuity-analysis model.`;
  if (spec.status !== "stable") return `Model "${model}" is not a stable release.`;
  if (!spec.inputs.includes("image")) return `Model "${model}" does not accept image input.`;
  if (!spec.structuredOutputs) return `Model "${model}" does not support structured outputs.`;
  if (!GEMINI_PRICING.models.some((m) => m.provider === "gemini" && m.model === model))
    return `Model "${model}" has no verified price.`;
  return null;
}

export const GEMINI_PRICING: PricingTable = {
  version: "gemini-2026-10-13",
  source:
    "https://ai.google.dev/gemini-api/docs/pricing (standard paid tier, per 1M tokens; page updated 2026-10-13)",
  checkedAt: "2026-10-13",
  models: [
    {
      provider: "gemini",
      model: "gemini-3.8-flash",
      // Documented: $0.75 in / $3.75 out through 2026-12-31, then $1.50 / $7.50 from 2027-01-01.
      // Image and video input are billed at the text input rate; thinking tokens at the output rate.
      rates: [
        { from: "2026-01-01", inputPerMillionUsd: 0.75, outputPerMillionUsd: 3.75 },
        { from: "2027-01-01", inputPerMillionUsd: 1.5, outputPerMillionUsd: 7.5 },
      ],
      mediaBilledAsText: true,
    },
    {
      provider: "gemini",
      model: "gemini-3.6-flash",
      // Documented (pricing page, 2026-10-13): identical to gemini-3.8-flash.
      rates: [
        { from: "2026-01-01", inputPerMillionUsd: 0.75, outputPerMillionUsd: 3.75 },
        { from: "2027-01-01", inputPerMillionUsd: 1.5, outputPerMillionUsd: 7.5 },
      ],
      mediaBilledAsText: true,
    },
  ],
};

export type GeminiState = "configured" | "missing_credential" | "disabled" | "unsupported_model";

export interface GeminiConfig {
  enabled: boolean;
  /** Secret: server/worker only. Never serialised to the browser, a job, a log or a manifest. */
  apiKey: string | null;
  model: string;
  /** Absolute ceiling on one response (also bounds thinking). */
  maxOutputTokensCap: number;
  timeoutMs: number;
  /** Direct video analysis exists in the architecture but is OFF unless explicitly enabled. */
  directVideo: boolean;
  thinkingLevel: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
}

export function readGeminiConfig(env: Record<string, string | undefined>): GeminiConfig {
  const providers = (env.PRISM_STUDIO_CONTINUITY_ANALYZERS ?? "mock")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const key = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || null;
  const level = (env.PRISM_STUDIO_GEMINI_THINKING_LEVEL ?? "LOW").toUpperCase();
  return {
    enabled: providers.includes("gemini"),
    apiKey: key,
    model: env.PRISM_STUDIO_GEMINI_ANALYSIS_MODEL?.trim() || GEMINI_DEFAULT_MODEL,
    maxOutputTokensCap: 8192,
    timeoutMs:
      Number(env.PRISM_STUDIO_GEMINI_TIMEOUT_MS) > 0 ? Number(env.PRISM_STUDIO_GEMINI_TIMEOUT_MS) : 120_000,
    directVideo: env.PRISM_STUDIO_GEMINI_DIRECT_VIDEO === "1",
    thinkingLevel: (["MINIMAL", "LOW", "MEDIUM", "HIGH"].includes(level)
      ? level
      : "LOW") as GeminiConfig["thinkingLevel"],
  };
}

export const geminiState = (c: GeminiConfig): GeminiState =>
  !c.enabled
    ? "disabled"
    : geminiModelBlocker(c.model)
      ? "unsupported_model"
      : c.apiKey
        ? "configured"
        : "missing_credential";
