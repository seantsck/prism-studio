import type { AnalysisErrorCategory } from "@/domain/continuity/analysis/types";

/**
 * Transport boundary for Gemini. The analyzer builds provider-neutral requests and interprets responses; this
 * interface is the ONLY thing that can reach the network. Tests and the pre-paid check use FakeGeminiTransport.
 */
export type GeminiPart =
  | { type: "text"; text: string }
  /** `videoFps` (3A.3): the frozen sampling rate for a video part (`videoMetadata.fps`). */
  | { type: "inline"; mimeType: string; dataBase64: string; videoFps?: number }
  /** Files-API reference (direct video). Operational metadata only; never canonical media. */
  | { type: "file"; mimeType: string; fileUri: string; videoFps?: number };

export interface GeminiTurn {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiRequest {
  model: string;
  systemInstruction: string;
  turns: GeminiTurn[];
  responseJsonSchema: unknown;
  maxOutputTokens: number;
  temperature: number;
  thinkingLevel: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface GeminiUsage {
  promptTokens: number | null;
  candidatesTokens: number | null;
  thoughtsTokens: number | null;
  totalTokens: number | null;
}

export interface GeminiResponse {
  text: string | null;
  finishReason: string | null;
  /** Prompt-level block (nothing generated). */
  blockReason: string | null;
  usage: GeminiUsage | null;
  responseId: string | null;
  modelVersion: string | null;
}

/** Failure mapped to Prism's analysis taxonomy. `message` is sanitized: never prompt content or credentials. */
export class GeminiTransportError extends Error {
  constructor(
    readonly category: AnalysisErrorCategory,
    readonly httpStatus: number | null,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "GeminiTransportError";
  }
}

export interface GeminiTransport {
  generate(request: GeminiRequest): Promise<GeminiResponse>;
  /**
   * Files API (direct video larger than the inline limit). Provider-side files are TEMPORARY operational
   * copies: the provider auto-deletes them (48 h documented) and Prism deletes them after the analysis.
   */
  uploadFile?(args: {
    bytes: Uint8Array;
    mimeType: string;
    displayName: string;
  }): Promise<{ name: string; uri: string }>;
  deleteFile?(name: string): Promise<void>;
}

/** Maps an HTTP status from the provider to the taxonomy (used by the SDK transport and tests). */
export function categoryForStatus(status: number): AnalysisErrorCategory {
  if (status === 429) return "rate_limit";
  if (status === 503) return "overloaded";
  if (status === 401 || status === 403) return "auth";
  if (status >= 400 && status < 500) return "invalid_input";
  if (status >= 500) return "server_error";
  return "server_error";
}
