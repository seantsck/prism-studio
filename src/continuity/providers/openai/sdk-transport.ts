import OpenAI from "openai";
import type { ResponseInput, ResponseInputContent } from "openai/resources/responses/responses";
import { redactText } from "@/lib/auth/redact";
import {
  OpenAITransportError,
  categoryForOpenAIStatus,
  isQuotaCode,
  type OpenAIRequest,
  type OpenAIResponse,
  type OpenAITransport,
} from "./transport";

/**
 * The real transport: official `openai` SDK (pinned), `client.responses.create`.
 *
 *  - SDK retries are DISABLED (`maxRetries: 0`, also per request): Prism must know every outbound billable
 *    invocation, and the durable queue owns when to ask again.
 *  - No idempotency key is sent. The Responses `create` documentation does not describe server-side
 *    de-duplication, so an ambiguous outcome (timeout / lost connection) is NEVER re-sent.
 *  - `store: false`: the response is not retained in the provider's response store.
 *  - The API key lives only in this object (server/worker); it is never logged or returned.
 *  - `fetchImpl` lets a caller trap/stub the network (pre-paid check, tests).
 */
export class SdkOpenAITransport implements OpenAITransport {
  private readonly client: OpenAI;

  constructor(opts: { apiKey: string; fetchImpl?: typeof fetch }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      maxRetries: 0,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl as never } : {}),
    });
  }

  async create(req: OpenAIRequest): Promise<OpenAIResponse> {
    try {
      const res = await this.client.responses.create(
        {
          model: req.model,
          instructions: req.instructions,
          input: toInput(req),
          text: {
            format: {
              type: "json_schema",
              name: req.schemaName,
              schema: req.jsonSchema as Record<string, unknown>,
              strict: true,
            },
          },
          max_output_tokens: req.maxOutputTokens,
          reasoning: { effort: req.reasoningEffort },
          store: false,
        },
        { timeout: req.timeoutMs, maxRetries: 0, signal: req.signal },
      );

      let text: string | null = null;
      let refusal: string | null = null;
      for (const item of res.output ?? []) {
        if (item.type !== "message") continue;
        for (const c of item.content ?? []) {
          if (c.type === "output_text") text = (text ?? "") + c.text;
          else if (c.type === "refusal") refusal = (refusal ?? "") + c.refusal;
        }
      }
      const u = res.usage;
      return {
        text,
        status: res.status ?? null,
        incompleteReason: res.incomplete_details?.reason ?? null,
        refusal,
        usage: u
          ? {
              inputTokens: u.input_tokens ?? null,
              outputTokens: u.output_tokens ?? null,
              reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? null,
              cachedTokens: u.input_tokens_details?.cached_tokens ?? null,
              totalTokens: u.total_tokens ?? null,
            }
          : null,
        responseId: res.id ?? null,
        modelVersion: res.model ?? null,
      };
    } catch (err) {
      throw mapOpenAIError(err);
    }
  }
}

function toInput(req: OpenAIRequest): ResponseInput {
  return req.input.map((item) => {
    if (item.role === "assistant") {
      return {
        role: "assistant" as const,
        content: item.content.map((p) => (p.type === "output_text" ? p.text : "")).join(""),
      };
    }
    const content: ResponseInputContent[] = [];
    for (const p of item.content) {
      if (p.type === "input_text") content.push({ type: "input_text", text: p.text });
      else if (p.type === "input_image")
        content.push({ type: "input_image", image_url: p.imageUrl, detail: p.detail });
    }
    return { role: "user" as const, content };
  });
}

function headerValue(headers: unknown, name: string): string | null {
  const h = headers as { get?: (n: string) => string | null } | Record<string, string> | null | undefined;
  if (!h) return null;
  if (typeof (h as { get?: unknown }).get === "function")
    return (h as { get: (n: string) => string | null }).get(name);
  return (h as Record<string, string>)[name] ?? null;
}

/** `retry-after-ms`, `retry-after` seconds or an HTTP date → milliseconds (null when absent/unparseable). */
export function retryAfterMs(headers: unknown, now = Date.now()): number | null {
  const ms = Number(headerValue(headers, "retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return Math.round(ms);
  const raw = headerValue(headers, "retry-after");
  if (!raw) return null;
  const s = Number(raw);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const d = Date.parse(raw);
  return Number.isFinite(d) ? Math.max(0, d - now) : null;
}

/** Never copies provider payloads into the message: status + a short redacted tail only. */
export function mapOpenAIError(err: unknown): OpenAITransportError {
  const e = err as {
    status?: unknown;
    name?: string;
    message?: string;
    code?: string | null;
    headers?: unknown;
  };
  const name = e?.name ?? "";
  if (typeof e?.status === "number") {
    const code = typeof e.code === "string" ? e.code : null;
    const category = categoryForOpenAIStatus(e.status, code);
    const tail = redactText(String(e.message ?? ""))
      .replace(/\s+/g, " ")
      .slice(0, 120);
    const quota = e.status === 429 && isQuotaCode(code);
    return new OpenAITransportError(
      category,
      e.status,
      quota
        ? "OpenAI reports the account's quota, credit or spend limit is exhausted."
        : `OpenAI returned HTTP ${e.status}${tail ? `: ${tail}` : ""}`,
      category === "rate_limit" || category === "overloaded" ? retryAfterMs(e.headers) : null,
      code,
    );
  }
  if (
    name === "APIConnectionTimeoutError" ||
    name === "AbortError" ||
    name === "APIUserAbortError" ||
    /timeout|timed out|aborted/i.test(String(e?.message ?? ""))
  ) {
    return new OpenAITransportError("timeout", null, "The analysis request timed out.");
  }
  return new OpenAITransportError(
    "network",
    null,
    "The analysis request could not be completed (network error).",
  );
}
