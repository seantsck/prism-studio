import type { AnalysisSpendPolicy } from "@/domain/continuity/analysis/cost";
import { DEFAULT_MAX_CORRECTIONS, DEFAULT_MAX_TRANSPORT_CALLS } from "@/domain/continuity/analysis/retry";
import { GeminiAnalysisProvider } from "../providers/gemini/analyzer";
import {
  GEMINI_ANALYZER_ID,
  geminiModelBlocker,
  geminiState,
  readGeminiConfig,
  type GeminiConfig,
  type GeminiState,
} from "../providers/gemini/config";
import type { GeminiRequest, GeminiResponse, GeminiTransport } from "../providers/gemini/transport";
import { OpenAIContinuityAnalyzer } from "../providers/openai/analyzer";
import {
  OPENAI_ANALYZER_ID,
  openaiModelBlocker,
  openaiState,
  readOpenAIConfig,
  type OpenAIConfig,
  type OpenAIState,
} from "../providers/openai/config";
import type { OpenAIRequest, OpenAIResponse, OpenAITransport } from "../providers/openai/transport";
import { analyzerModelLabel } from "./models";
import { MockAnalysisProvider, MOCK_PROVIDER_ID } from "./mock-provider";
import type { ContinuityAnalysisProvider } from "./provider";

/**
 * Analyzer registry + analysis configuration. Environment is read HERE, server-side only. The browser only ever
 * receives `AnalyzerStatus` (booleans / enums / names of missing variables), never a credential.
 */
export interface AnalysisConfig {
  enabled: string[];
  paid: AnalysisSpendPolicy;
  limits: {
    maxActivePerProject: number;
    /** Worker claims a job may use (each claim sends at most one request per batch). */
    maxJobAttempts: number;
    /** Hard ceiling on provider transport invocations per run, retries and corrections included. */
    maxTransportCalls: number;
    /** Schema-correction requests allowed per RUN (they also count against the transport ceiling). */
    maxCorrections: number;
  };
  /** Automatic paid analysis after conform: architecture only, ALWAYS off in Phase 2D. */
  autoRun: false;
  gemini: GeminiConfig;
  openai: OpenAIConfig;
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
      maxJobAttempts: Math.max(1, Math.floor(num(env.PRISM_STUDIO_ANALYSIS_MAX_ATTEMPTS) ?? 6)),
      maxTransportCalls: Math.min(
        12,
        Math.max(
          1,
          Math.floor(num(env.PRISM_STUDIO_ANALYSIS_MAX_TRANSPORT_CALLS) ?? DEFAULT_MAX_TRANSPORT_CALLS),
        ),
      ),
      maxCorrections: Math.min(
        2,
        Math.floor(num(env.PRISM_STUDIO_ANALYSIS_MAX_CORRECTIONS) ?? DEFAULT_MAX_CORRECTIONS),
      ),
    },
    autoRun: false,
    gemini: readGeminiConfig(env),
    openai: readOpenAIConfig(env),
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

/** Same lazy-load rule as Gemini: the SDK is imported only when a request is actually made. */
class LazyOpenAITransport implements OpenAITransport {
  private inner: OpenAITransport | null = null;
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}
  async create(req: OpenAIRequest): Promise<OpenAIResponse> {
    if (!this.inner) {
      const { SdkOpenAITransport } = await import("../providers/openai/sdk-transport");
      this.inner = new SdkOpenAITransport({ apiKey: this.apiKey, fetchImpl: this.fetchImpl });
    }
    return this.inner.create(req);
  }
}

export function createAnalysisProviders(
  env: Record<string, string | undefined>,
  opts: { transport?: GeminiTransport; openaiTransport?: OpenAITransport; fetchImpl?: typeof fetch } = {},
): Map<string, ContinuityAnalysisProvider> {
  const cfg = readAnalysisConfig(env);
  const out = new Map<string, ContinuityAnalysisProvider>();
  if (cfg.enabled.includes("mock")) out.set(MOCK_PROVIDER_ID, new MockAnalysisProvider());
  // an unlisted model never gets an executable provider (it cannot be priced, so it must not be sent)
  if (cfg.gemini.enabled && !geminiModelBlocker(cfg.gemini.model) && (cfg.gemini.apiKey || opts.transport)) {
    out.set(
      GEMINI_ANALYZER_ID,
      new GeminiAnalysisProvider({
        config: cfg.gemini,
        transport: opts.transport ?? new LazyGeminiTransport(cfg.gemini.apiKey!, opts.fetchImpl),
      }),
    );
  }
  if (
    cfg.openai.enabled &&
    !openaiModelBlocker(cfg.openai.model) &&
    (cfg.openai.apiKey || opts.openaiTransport)
  ) {
    out.set(
      OPENAI_ANALYZER_ID,
      new OpenAIContinuityAnalyzer({
        config: cfg.openai,
        transport: opts.openaiTransport ?? new LazyOpenAITransport(cfg.openai.apiKey!, opts.fetchImpl),
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

const unavailableOpenAITransport: OpenAITransport = {
  async create() {
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
  if (!out.has(OPENAI_ANALYZER_ID)) {
    out.set(
      OPENAI_ANALYZER_ID,
      new OpenAIContinuityAnalyzer({ config: cfg.openai, transport: unavailableOpenAITransport }),
    );
  }
  return out;
}

export interface AnalyzerStatus {
  id: string;
  label: string;
  model: string;
  /** Human label of the model ("GPT-6 Luna"); the raw id stays in `model`. */
  modelLabel: string;
  /** Provider display name ("OpenAI"). */
  providerName: string;
  kind: "mock" | "model";
  /** Safe state only: no key material, ever. */
  state: GeminiState | OpenAIState | "configured";
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
      modelLabel: "Mock",
      providerName: "Prism mock",
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
    modelLabel: analyzerModelLabel("gemini", g.model),
    providerName: "Gemini",
    kind: "model",
    state,
    spend: spendOn ? "enabled" : "disabled",
    missingConfig:
      state === "missing_credential"
        ? ["GEMINI_API_KEY"]
        : state === "disabled"
          ? ["PRISM_STUDIO_CONTINUITY_ANALYZERS=…,gemini"]
          : state === "unsupported_model"
            ? [`PRISM_STUDIO_GEMINI_ANALYSIS_MODEL (unsupported: ${g.model})`]
            : [],
    usable: state === "configured" && spendOn,
    modes: g.directVideo ? ["image_set", "direct_video"] : ["image_set"],
  });
  const o = cfg.openai;
  const oState = openaiState(o);
  out.push({
    id: OPENAI_ANALYZER_ID,
    label: "OpenAI multimodal analyzer",
    model: o.model,
    modelLabel: analyzerModelLabel("openai", o.model),
    providerName: "OpenAI",
    kind: "model",
    state: oState,
    spend: spendOn ? "enabled" : "disabled",
    missingConfig:
      oState === "missing_credential"
        ? ["OPENAI_API_KEY"]
        : oState === "disabled"
          ? ["PRISM_STUDIO_CONTINUITY_ANALYZERS=…,openai"]
          : oState === "unsupported_model"
            ? [`PRISM_STUDIO_OPENAI_ANALYSIS_MODEL (unsupported: ${o.model})`]
            : [],
    usable: oState === "configured" && spendOn,
    modes: ["image_set"],
  });
  return out;
}
