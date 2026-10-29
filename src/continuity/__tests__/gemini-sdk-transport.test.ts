import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SdkGeminiTransport } from "../providers/gemini/sdk-transport";
import { GeminiTransportError, type GeminiRequest } from "../providers/gemini/transport";

/**
 * The REAL pinned SDK transport over a stubbed fetch (the global fetch is trapped too: nothing can leave the
 * process). Proves one provider request per call — no hidden SDK retry that would let one calibration trial
 * consume several generation requests — and the status → category mapping the calibration's abort rules rely on.
 */
const req: GeminiRequest = {
  model: "gemini-3.8-flash",
  systemInstruction: "s",
  turns: [{ role: "user", parts: [{ type: "text", text: "DATA {}" }] }],
  responseJsonSchema: { type: "object" },
  maxOutputTokens: 100,
  temperature: 0,
  thinkingLevel: "LOW",
  timeoutMs: 5000,
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const providerError = (status: number, message: string, reason: string) =>
  json(status, { error: { code: status, message, status: reason } });

let realFetch: typeof fetch;
let leaked = 0;
beforeEach(() => {
  realFetch = globalThis.fetch;
  leaked = 0;
  globalThis.fetch = (async () => {
    leaked += 1;
    throw new Error("network trapped");
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  expect(leaked).toBe(0);
});

function transport(respond: () => Response | Promise<Response>) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return respond();
  }) as typeof fetch;
  return { t: new SdkGeminiTransport({ apiKey: "test-key", fetchImpl }), calls: () => calls };
}

describe("SdkGeminiTransport (stubbed fetch, no network)", () => {
  for (const [status, message, reason, category] of [
    [
      429,
      "You exceeded your current quota, please check your plan and billing details.",
      "RESOURCE_EXHAUSTED",
      "rate_limit",
    ],
    [429, "Too many requests.", "RESOURCE_EXHAUSTED", "rate_limit"],
    // account/project refusals: the calibration aborts on these by HTTP status (the transport taxonomy is unchanged)
    [401, "API key not valid. Please pass a valid API key.", "UNAUTHENTICATED", "auth"],
    [402, "Your prepayment credits are depleted.", "FAILED_PRECONDITION", "invalid_input"],
    [403, "Permission denied on the project.", "PERMISSION_DENIED", "auth"],
    [404, "models/gemini-x is not found for API version v1beta.", "NOT_FOUND", "invalid_input"],
    [500, "Internal error encountered.", "INTERNAL", "server_error"],
    [503, "This model is currently experiencing high demand.", "UNAVAILABLE", "overloaded"],
  ] as const) {
    it(`HTTP ${status} (${message.slice(0, 24)}…) is ONE request, mapped to ${category}`, async () => {
      const { t, calls } = transport(() => providerError(status, message, reason));
      const err = await t.generate(req).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GeminiTransportError);
      expect(err).toMatchObject({ httpStatus: status, category });
      expect((err as Error).message).toContain(`HTTP ${status}`);
      expect((err as Error).message).not.toContain("test-key");
      expect(calls()).toBe(1);
    });
  }

  it("a provider error body that echoes a credential is redacted in the error message", async () => {
    const key = "AIzaSy-test-not-a-real-credential-111111";
    vi.stubEnv("GEMINI_API_KEY", key);
    try {
      const { t, calls } = transport(() =>
        providerError(402, `Credits depleted for key ${key}. Authorization: Bearer abcdefgh12345678`, "X"),
      );
      const err = (await t.generate(req).catch((e: unknown) => e)) as GeminiTransportError;
      expect(err.httpStatus).toBe(402);
      expect(err.message).not.toContain(key);
      expect(err.message).not.toContain("abcdefgh12345678");
      expect(calls()).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a timeout / aborted request is ONE request, mapped to timeout (never re-sent)", async () => {
    const { t, calls } = transport(() => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" });
    });
    await expect(t.generate(req)).rejects.toMatchObject({ category: "timeout", httpStatus: null });
    expect(calls()).toBe(1);
  });

  it("success reports usage when present, and null usage when the provider omits it", async () => {
    const body = {
      candidates: [{ content: { role: "model", parts: [{ text: "{}" }] }, finishReason: "STOP" }],
      responseId: "r1",
    };
    const withUsage = transport(() =>
      json(200, {
        ...body,
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 2,
          totalTokenCount: 17,
        },
      }),
    );
    const a = await withUsage.t.generate(req);
    expect(a.usage).toEqual({ promptTokens: 10, candidatesTokens: 5, thoughtsTokens: 2, totalTokens: 17 });
    expect(withUsage.calls()).toBe(1);
    const without = transport(() => json(200, body));
    const b = await without.t.generate(req);
    expect(b.usage).toBeNull();
    expect(without.calls()).toBe(1);
  });
});
