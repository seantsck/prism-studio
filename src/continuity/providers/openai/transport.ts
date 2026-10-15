import type { AnalysisErrorCategory } from "@/domain/continuity/analysis/types";

/**
 * Transport boundary for OpenAI (Responses API). The analyzer builds provider-shaped requests and interprets
 * responses; this interface is the ONLY thing that can reach the network. Tests and the pre-paid check use
 * FakeOpenAITransport.
 */
export type OpenAIContentPart =
  | { type: "input_text"; text: string }
  /** Bounded inline image as a data URL. Never persisted: built per request from bytes already in memory. */
  | { type: "input_image"; imageUrl: string; detail: "low" | "high" | "original" | "auto" }
  /** An earlier model answer (schema-correction turn only). */
  | { type: "output_text"; text: string };

export interface OpenAIInputItem {
  role: "user" | "assistant";
  content: OpenAIContentPart[];
}

export interface OpenAIRequest {
  model: string;
  /** Static analyzer instructions only (never project text). */
  instructions: string;
  input: OpenAIInputItem[];
  /** Strict JSON Schema for the answer (Structured Outputs). */
  jsonSchema: unknown;
  schemaName: string;
  maxOutputTokens: number;
  reasoningEffort: "none" | "low" | "medium" | "high";
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface OpenAIUsage {
  inputTokens: number | null;
  /** Includes reasoning tokens (OpenAI reports reasoning as a subset of output). */
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
}

export interface OpenAIResponse {
  /** Concatenated output_text, null when the model produced none (refusal / filtered). */
  text: string | null;
  status: "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress" | string | null;
  /** `incomplete_details.reason` (max_output_tokens | content_filter). */
  incompleteReason: string | null;
  /** The model's refusal text when the answer is a refusal (Structured Outputs). */
  refusal: string | null;
  usage: OpenAIUsage | null;
  responseId: string | null;
  modelVersion: string | null;
}

/** Failure mapped to Prism's analysis taxonomy. `message` is sanitized: never prompt content or credentials. */
export class OpenAITransportError extends Error {
  constructor(
    readonly category: AnalysisErrorCategory,
    readonly httpStatus: number | null,
    message: string,
    readonly retryAfterMs: number | null = null,
    /** Provider `error.code` (e.g. insufficient_quota). Operational metadata only. */
    readonly providerCode: string | null = null,
  ) {
    super(message);
    this.name = "OpenAITransportError";
  }
}

export interface OpenAITransport {
  /** EXACTLY one outbound `responses.create`. SDK retries are disabled: Prism owns the retry policy. */
  create(request: OpenAIRequest): Promise<OpenAIResponse>;
}

/** Billing / quota exhaustion arrives as 429 but retrying cannot help until a person fixes the limit. */
const QUOTA_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

export function isQuotaCode(code: string | null | undefined): boolean {
  return code != null && QUOTA_CODES.has(code);
}

/** HTTP status (+ provider error code) → Prism taxonomy. Used by the SDK transport and tests. */
export function categoryForOpenAIStatus(status: number, code?: string | null): AnalysisErrorCategory {
  if (status === 429) return isQuotaCode(code) ? "config" : "rate_limit";
  if (status === 503) return "overloaded";
  if (status === 401 || status === 403) return "auth";
  if (status >= 400 && status < 500) return "invalid_input";
  return "server_error";
}
