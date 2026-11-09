import { GenerationProviderError } from "@/domain/generation/errors";
import type { GenerationErrorCategory } from "@/domain/generation/schemas";

/**
 * Runway errors → Prism's taxonomy. Messages are STABLE, user-safe sentences: the SDK's own `message` embeds
 * the response payload and is never copied. `code` is a short safe token (HTTP status or Runway failureCode).
 */
const TEXT: Record<GenerationErrorCategory, string> = {
  transient: "Runway could not be reached. This usually clears up on its own.",
  rate_limit: "Runway is rate limiting requests.",
  provider_unavailable: "Runway is temporarily unavailable.",
  timeout: "Runway did not answer in time.",
  invalid_request: "Runway rejected the request as invalid.",
  content_rejected: "Runway's content moderation rejected this request.",
  auth: "Runway rejected the API credential.",
  quota: "The Runway account has no credits or has reached its usage limit.",
  permanent: "Runway could not complete this request.",
};

const safeToken = (v: unknown, fallback: string) => {
  const s = typeof v === "string" ? v.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60) : "";
  return s || fallback;
};

interface SdkLikeError {
  name?: string;
  status?: number;
  headers?: { get?(name: string): string | null } | Record<string, string>;
  error?: unknown;
  message?: string;
}

function header(e: SdkLikeError, name: string): string | null {
  const h = e.headers;
  if (!h) return null;
  if (typeof (h as { get?: unknown }).get === "function") {
    return (h as { get(n: string): string | null }).get(name);
  }
  const rec = h as Record<string, string>;
  return rec[name] ?? rec[name.toLowerCase()] ?? null;
}

type ErrorOptions = ConstructorParameters<typeof GenerationProviderError>[3];

/** Duck-typed on purpose: works for the SDK's error classes and for test doubles. Never throws. */
export function mapRunwayError(err: unknown): GenerationProviderError {
  if (err instanceof GenerationProviderError) return err;
  const e = (err ?? {}) as SdkLikeError;
  const hint = `${JSON.stringify(e.error ?? "")} ${String(e.message ?? "")}`.toLowerCase();
  const make = (category: GenerationErrorCategory, code: string, options: ErrorOptions = {}) =>
    new GenerationProviderError(category, code, TEXT[category], options);

  const status = typeof e.status === "number" ? e.status : null;
  if (status === null) {
    if (e.name === "APIConnectionTimeoutError") return make("timeout", "runway_timeout");
    if (e.name === "APIUserAbortError") return make("transient", "runway_aborted");
    return make("transient", "runway_network");
  }
  const retryAfter = Number.parseFloat(header(e, "retry-after") ?? "");
  const retryAfterMs =
    Number.isFinite(retryAfter) && retryAfter > 0 ? Math.round(retryAfter * 1000) : undefined;
  const withRetryAfter: ErrorOptions = retryAfterMs ? { retryAfterMs } : {};

  if (status === 429) {
    // The daily generation cap is a quota, not a burst limit: retrying within minutes cannot help.
    if (/daily|per day|24 hours|limit.*day/.test(hint)) {
      return make("quota", "runway_429_daily", { retryable: false });
    }
    return make("rate_limit", "runway_429", withRetryAfter);
  }
  if (status === 401) return make("auth", "runway_401", { retryable: false });
  if (status === 403) {
    if (/credit/.test(hint)) return make("quota", "runway_403_credits", { retryable: false });
    return make("auth", "runway_403", { retryable: false });
  }
  if (status === 400 || status === 422) {
    if (/credit|insufficient|balance/.test(hint)) {
      return make("quota", `runway_${status}_credits`, { retryable: false });
    }
    if (/moderation|safety|policy|public figure/.test(hint)) {
      return make("content_rejected", `runway_${status}_moderation`, { retryable: false });
    }
    return make("invalid_request", `runway_${status}`, { retryable: false });
  }
  if (status === 404 || status === 409) return make("permanent", `runway_${status}`, { retryable: false });
  if (status >= 500) return make("provider_unavailable", `runway_${status}`, withRetryAfter);
  return make("permanent", `runway_${status}`, { retryable: false });
}

/**
 * Task-level failure (status FAILED). The submitted task is terminal, so Prism never blindly re-submits it.
 * The category/message still matter for the filmmaker's next explicit action and must match Runway's documented
 * failure families rather than collapsing every INTERNAL code into "provider unavailable".
 */
export function mapRunwayFailure(failureCode: unknown): {
  category: GenerationErrorCategory;
  code: string;
  message: string;
} {
  const raw = typeof failureCode === "string" ? failureCode : "";
  const code = safeToken(raw, "runway_task_failed");
  const upper = raw.toUpperCase();

  if (upper.startsWith("SAFETY.") || upper.startsWith("INPUT_PREPROCESSING.SAFETY.")) {
    return { category: "content_rejected", code, message: `${TEXT.content_rejected} (${code})` };
  }
  if (upper.startsWith("ASSET.INVALID")) {
    return { category: "invalid_request", code, message: `${TEXT.invalid_request} (${code})` };
  }
  if (upper.startsWith("INTERNAL.BAD_OUTPUT")) {
    return {
      category: "provider_unavailable",
      code,
      message:
        "Runway rejected the generated output during internal quality or system checks. Review the input media and prompt, then try again. " +
        `(${code})`,
    };
  }
  if (
    upper.startsWith("INPUT_PREPROCESSING.INTERNAL") ||
    upper.startsWith("THIRD_PARTY.UNAVAILABLE") ||
    upper === "INTERNAL" ||
    upper === ""
  ) {
    return { category: "provider_unavailable", code, message: `${TEXT.provider_unavailable} (${code})` };
  }
  if (upper.includes("INPUT")) {
    return { category: "invalid_request", code, message: `${TEXT.invalid_request} (${code})` };
  }
  return { category: "permanent", code, message: `${TEXT.permanent} (${code})` };
}
