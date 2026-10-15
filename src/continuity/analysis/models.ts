import { GEMINI_MODELS } from "../providers/gemini/config";
import { OPENAI_MODELS } from "../providers/openai/config";

/**
 * One registry of every analyzer model Prism will send continuity analysis to, across providers. Provider
 * adapters own capability/price detail; this is the single answer to "which provider/model pairs exist".
 * Provider capability is NOT product policy: media volume, batching and budgets come from the Prism plan.
 */
export interface AnalyzerModelEntry {
  provider: "gemini" | "openai";
  model: string;
  label: string;
  status: "stable";
  inputs: readonly string[];
  structuredOutputs: boolean;
}

const gemLabel = (id: string) =>
  id
    .split("-")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");

export const ANALYZER_MODEL_REGISTRY: readonly AnalyzerModelEntry[] = [
  ...GEMINI_MODELS.map((m): AnalyzerModelEntry => ({
    provider: "gemini",
    model: m.id,
    label: gemLabel(m.id),
    status: m.status,
    inputs: m.inputs,
    structuredOutputs: m.structuredOutputs,
  })),
  ...OPENAI_MODELS.map((m): AnalyzerModelEntry => ({
    provider: "openai",
    model: m.id,
    label: m.label,
    status: m.status,
    inputs: m.inputs,
    structuredOutputs: m.structuredOutputs,
  })),
];

export const modelsFor = (provider: string): AnalyzerModelEntry[] =>
  ANALYZER_MODEL_REGISTRY.filter((m) => m.provider === provider);

const PROVIDER_NAMES: Record<string, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  "mock-continuity": "Prism mock",
};

/** Provider display name for a stored analyzer id (falls back to the id for historical/unknown ones). */
export const providerDisplayName = (provider: string): string => PROVIDER_NAMES[provider] ?? provider;

/** "GPT-6 Luna (gpt-6-luna)": label plus the exact stored id, so history is never ambiguous. */
export function modelDisplay(provider: string, model: string): string {
  const label = analyzerModelLabel(provider, model);
  return label === model ? model : `${label} (${model})`;
}

/** Display label for a stored provider/model pair (falls back to the raw id for historical/unknown models). */
export function analyzerModelLabel(provider: string, model: string): string {
  return ANALYZER_MODEL_REGISTRY.find((m) => m.provider === provider && m.model === model)?.label ?? model;
}
