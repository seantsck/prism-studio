import type { PricingTable } from "@/domain/continuity/analysis/cost";

/**
 * Gemini continuity analyzer configuration: the ONLY place the model id, SDK pin and pricing live.
 *
 * Verified against the official documentation on 2026-10-13:
 *   - models:   https://ai.google.dev/gemini-api/docs/models        gemini-3.8-flash (stable)
 *   - pricing:  https://ai.google.dev/gemini-api/docs/pricing       page last updated 2026-10-09
 *   - SDK:      @google/genai 2.29.0 (npm `latest`), `ai.models.generateContent`
 * Pricing is configuration, not scraped at runtime: when it changes, bump `version` here.
 */
export const GEMINI_ANALYZER_ID = "gemini";
export const GEMINI_ANALYZER_VERSION = "1";
export const GEMINI_SDK = "@google/genai@2.29.0";
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";

export const GEMINI_PRICING: PricingTable = {
  version: "gemini-2026-10-13",
  source:
    "https://ai.google.dev/gemini-api/docs/pricing (standard paid tier, per 1M tokens; updated 2026-10-09)",
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
      rates: [
        { from: "2026-01-01", inputPerMillionUsd: 0.75, outputPerMillionUsd: 3.75 },
        { from: "2027-01-01", inputPerMillionUsd: 1.5, outputPerMillionUsd: 7.5 },
      ],
      mediaBilledAsText: true,
    },
  ],
};

export type GeminiState = "configured" | "missing_credential" | "disabled";

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
  !c.enabled ? "disabled" : c.apiKey ? "configured" : "missing_credential";
