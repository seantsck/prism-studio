/**
 * Phase 5B-I2: the provider-neutral boundary between the `openai-image` adapter and the OpenAI SDK. The adapter builds
 * an `OpenAIImageCall`; exactly ONE transport (`sdk-transport.ts`, lazily imported) talks to the network. Tests use
 * `FakeOpenAIImageTransport`; no test ever reaches OpenAI.
 */
export interface OpenAIImageInput {
  bytes: Uint8Array;
  mime: string;
  filename: string;
}

export interface OpenAIImageCall {
  /** generate = images.generate (text only); edit = images.edit (1..16 input images, the first is edited). */
  operation: "generate" | "edit";
  model: string;
  prompt: string;
  /** "WxH". */
  size: string;
  quality: "low" | "medium" | "high";
  background: "opaque" | "transparent";
  outputFormat: "png";
  images: OpenAIImageInput[];
  /** Optional PNG mask (alpha = 0 where the first image is edited); only with `edit`. */
  mask: OpenAIImageInput | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface OpenAIImageUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  textInputTokens: number | null;
  imageInputTokens: number | null;
}

export interface OpenAIImageCallResult {
  /** The single image, base64 (GPT image models always return b64_json). */
  b64: string;
  size: string | null;
  outputFormat: string | null;
  background: string | null;
  quality: string | null;
  created: number | null;
  /** The `x-request-id` header when the SDK exposes it (safe to store: an opaque id). */
  requestId: string | null;
  usage: OpenAIImageUsage | null;
}

export interface OpenAIImageTransport {
  /** EXACTLY one outbound call. SDK retries are disabled: Prism's queue owns every retry decision. */
  call(call: OpenAIImageCall): Promise<OpenAIImageCallResult>;
}

/** A transport failure already reduced to an HTTP status and the provider's error code (never the body or key). */
export class OpenAIImageTransportError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string | null,
    message: string,
    /** True when the request may have reached OpenAI (timeout, dropped connection): it may have been billed. */
    readonly ambiguous: boolean,
  ) {
    super(message);
  }
}
