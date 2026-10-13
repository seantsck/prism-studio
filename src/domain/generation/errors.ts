import type { GenerationErrorCategory } from "./schemas";

/**
 * Provider failures, classified once at the adapter boundary. The category (not the provider's wording)
 * drives retry policy and the message shown to the filmmaker.
 */
export class GenerationProviderError extends Error {
  constructor(
    readonly category: GenerationErrorCategory,
    /** Short stable code, e.g. "content_policy" or "http_503". Safe to store and show. */
    readonly code: string,
    /** Sanitized explanation. Adapters must not put credentials, payloads or URLs here. */
    message: string,
    readonly options: { retryAfterMs?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "GenerationProviderError";
  }

  get retryable(): boolean {
    return this.options.retryable ?? isRetryable(this.category);
  }
}

const RETRYABLE: readonly GenerationErrorCategory[] = [
  "transient",
  "rate_limit",
  "provider_unavailable",
  "timeout",
];

export function isRetryable(category: GenerationErrorCategory): boolean {
  return RETRYABLE.includes(category);
}

/** Message safe to show the user. Never includes provider detail, payloads or credentials. */
export const USER_ERROR_MESSAGES: Record<GenerationErrorCategory, string> = {
  transient: "The provider had a temporary problem. Prism will retry automatically.",
  rate_limit: "The provider is rate limiting requests. Prism will retry automatically.",
  provider_unavailable: "Provider temporarily unavailable.",
  timeout: "Generation timed out.",
  invalid_request: "Model does not support this input.",
  content_rejected: "Generation rejected by provider.",
  auth: "Prism could not authenticate with the provider. Check the provider configuration.",
  quota: "Quota unavailable.",
  permanent: "Generation failed.",
};

export interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** 0..1 fraction of the delay added as deterministic-by-input jitter. */
  jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { baseDelayMs: 5_000, maxDelayMs: 5 * 60_000, jitter: 0.2 };

/**
 * Exponential backoff for the Nth failure (1-based). `random` is injectable so tests are deterministic.
 * A provider-supplied Retry-After wins when it is longer than the computed delay.
 */
export function backoffDelayMs(
  failureCount: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  retryAfterMs: number | null = null,
  random: () => number = Math.random,
): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, failureCount - 1));
  const withJitter = Math.round(exp * (1 + policy.jitter * random()));
  return Math.min(policy.maxDelayMs, Math.max(withJitter, retryAfterMs ?? 0));
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  /** Why not retrying, when retry is false. */
  reason?: "not_retryable" | "attempts_exhausted";
}

export function decideRetry(
  error: { category: GenerationErrorCategory; retryAfterMs?: number | null; retryable?: boolean },
  attemptCount: number,
  maxAttempts: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): RetryDecision {
  if (error.retryable === false || !isRetryable(error.category)) {
    return { retry: false, delayMs: 0, reason: "not_retryable" };
  }
  if (attemptCount >= maxAttempts) return { retry: false, delayMs: 0, reason: "attempts_exhausted" };
  return {
    retry: true,
    delayMs: backoffDelayMs(attemptCount, policy, error.retryAfterMs ?? null, random),
  };
}
