import type { AnalysisSpendPolicy } from "@/domain/continuity/analysis/cost";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import {
  GEMINI_ANALYZER_ID,
  geminiState,
  readGeminiConfig,
  type GeminiConfig,
  type GeminiState,
} from "../providers/gemini/config";
import type { GeminiRequest, GeminiResponse, GeminiTransport } from "../providers/gemini/transport";
import { MockAnalysisProvider, MOCK_PROVIDER_ID } from "./mock-provider";
import type { ContinuityAnalysisProvider } from "./provider";

/**
 * Analyzer registry + analysis configuration. Environment is read HERE, server-side only. The browser only ever
 * receives `AnalyzerStatus` (booleans / enums / names of missing variables), never a credential.
 */
export interface AnalysisConfig {
  enabled: string[];
  paid: AnalysisSpendPolicy;
  limits: { maxActivePerProject: number; maxJobAttempts: number };
  /** Automatic paid analysis after conform: architecture only, ALWAYS off in Phase 2D. */
  autoRun: false;
  gemini: GeminiConfig;
}

const num = (v: string | undefined): number | null => {
  const n = Number(v);
  return v != null && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
};

export function readAnalysisConfig(env: Record<string, string | undefined>): AnalysisConfig {
  const enabled = (env.PRISM_STUDIO_CONTINUITY_ANALYZERS ?? "mock")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    enabled,
    paid: {
      enabled: env.PRISM_STUDIO_ALLOW_PAID_ANALYSIS === "true",
      maxUsdPerRun: num(env.PRISM_STUDIO_MAX_ANALYSIS_USD_PER_RUN),
      maxUsdPerDay: num(env.PRISM_STUDIO_MAX_ANALYSIS_USD_PER_DAY),
    },
    limits: {
      maxActivePerProject: Math.max(
        1,
        Math.floor(num(env.PRISM_STUDIO_ANALYSIS_MAX_ACTIVE_PER_PROJECT) ?? 3),
      ),
      maxJobAttempts: Math.max(1, Math.floor(num(env.PRISM_STUDIO_ANALYSIS_MAX_ATTEMPTS) ?? 3)),
    },
    autoRun: false,
    gemini: readGeminiConfig(env),
  };
}

/** Loads the SDK only when a request is actually made (never in the browser, never for the mock analyzer). */
class LazyGeminiTransport implements GeminiTransport {
  private inner: GeminiTransport | null = null;
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}
  private async load(): Promise<GeminiTransport> {
    if (!this.inner) {
      const { SdkGeminiTransport } = await import("../providers/gemini/sdk-transport");
      this.inner = new SdkGeminiTransport({ apiKey: this.apiKey, fetchImpl: this.fetchImpl });
    }
    return this.inner;
  }
  async generate(req: GeminiRequest): Promise<GeminiResponse> {
    return (await this.load()).generate(req);
  }
  async uploadFile(args: { bytes: Uint8Array; mimeType: string; displayName: string }) {
    return (await this.load()).uploadFile!(args);
  }
  async deleteFile(name: string) {
    return (await this.load()).deleteFile!(name);
  }
}

export function createAnalysisProviders(
  env: Record<string, string | undefined>,
  opts: { transport?: GeminiTransport; fetchImpl?: typeof fetch } = {},
): Map<string, ContinuityAnalysisProvider> {
  const cfg = readAnalysisConfig(env);
  const out = new Map<string, ContinuityAnalysisProvider>();
  if (cfg.enabled.includes("mock")) out.set(MOCK_PROVIDER_ID, new MockAnalysisProvider());
  if (cfg.gemini.enabled && (cfg.gemini.apiKey || opts.transport)) {
    out.set(
      GEMINI_ANALYZER_ID,
      new GeminiAnalysisProvider({
        config: cfg.gemini,
        transport: opts.transport ?? new LazyGeminiTransport(cfg.gemini.apiKey!, opts.fetchImpl),
      }),
    );
  }
  return out;
}

/** Throws on use: lets the UI PLAN and ESTIMATE for an analyzer that is not configured, without ever sending. */
const unavailableTransport: GeminiTransport = {
  async generate() {
    throw new Error("This analyzer is not configured on this server.");
  },
};

/**
 * Providers used only to preview (plan + estimate) what an analysis would do. Includes analyzers that are
 * disabled or missing a credential so the user sees why they cannot run; they cannot execute.
 */
export function createPreviewProviders(
  env: Record<string, string | undefined>,
): Map<string, ContinuityAnalysisProvider> {
  const cfg = readAnalysisConfig(env);
  const out = createAnalysisProviders(env);
  if (!out.has(MOCK_PROVIDER_ID) && cfg.enabled.includes("mock"))
    out.set(MOCK_PROVIDER_ID, new MockAnalysisProvider());
  if (!out.has(GEMINI_ANALYZER_ID)) {
    out.set(
      GEMINI_ANALYZER_ID,
      new GeminiAnalysisProvider({ config: cfg.gemini, transport: unavailableTransport }),
    );
  }
  return out;
}

export interface AnalyzerStatus {
  id: string;
  label: string;
  model: string;
  kind: "mock" | "model";
  /** Safe state only: no key material, ever. */
  state: GeminiState | "configured";
  /** Paid analyzers additionally report whether paid analysis is switched on and a ceiling exists. */
  spend: "free" | "enabled" | "disabled";
  missingConfig: string[];
  usable: boolean;
  modes: string[];
}

export function analyzerStatuses(env: Record<string, string | undefined>): AnalyzerStatus[] {
  const cfg = readAnalysisConfig(env);
  const out: AnalyzerStatus[] = [];
  if (cfg.enabled.includes("mock")) {
    out.push({
      id: MOCK_PROVIDER_ID,
      label: "Mock analyzer (free, deterministic)",
      model: "mock",
      kind: "mock",
      state: "configured",
      spend: "free",
      missingConfig: [],
      usable: true,
      modes: ["image_set"],
    });
  }
  const g = cfg.gemini;
  const state = geminiState(g);
  const spendOn = cfg.paid.enabled && cfg.paid.maxUsdPerRun != null;
  out.push({
    id: GEMINI_ANALYZER_ID,
    label: "Gemini multimodal analyzer",
    model: g.model,
    kind: "model",
    state,
    spend: spendOn ? "enabled" : "disabled",
    missingConfig:
      state === "missing_credential"
        ? ["GEMINI_API_KEY"]
        : state === "disabled"
          ? ["PRISM_STUDIO_CONTINUITY_ANALYZERS=…,gemini"]
          : [],
    usable: state === "configured" && spendOn,
    modes: g.directVideo ? ["image_set", "direct_video"] : ["image_set"],
  });
  return out;
}
