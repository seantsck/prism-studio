import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { redactText } from "@/lib/auth/redact";
import {
  GeminiTransportError,
  categoryForStatus,
  type GeminiRequest,
  type GeminiResponse,
  type GeminiTransport,
} from "./transport";

/**
 * The real transport: official `@google/genai` (pinned), `ai.models.generateContent`.
 *
 *  - SDK retries are DISABLED (`attempts: 1`): generateContent has no documented idempotency key, so Prism
 *    owns the retry policy and never lets a hidden retry double-bill.
 *  - The API key lives only in this object (server/worker); it is never logged or returned.
 *  - `fetchImpl` lets a caller trap/stub the network (pre-paid check, tests).
 */
const LEVELS: Record<GeminiRequest["thinkingLevel"], ThinkingLevel> = {
  MINIMAL: ThinkingLevel.MINIMAL,
  LOW: ThinkingLevel.LOW,
  MEDIUM: ThinkingLevel.MEDIUM,
  HIGH: ThinkingLevel.HIGH,
};

export class SdkGeminiTransport implements GeminiTransport {
  private readonly ai: GoogleGenAI;

  constructor(opts: { apiKey: string; fetchImpl?: typeof fetch }) {
    this.ai = new GoogleGenAI({
      apiKey: opts.apiKey,
      httpOptions: {
        retryOptions: { attempts: 1 },
        ...(opts.fetchImpl ? { fetch: opts.fetchImpl as never } : {}),
      },
    });
  }

  async uploadFile(args: { bytes: Uint8Array; mimeType: string; displayName: string }) {
    try {
      let file = await this.ai.files.upload({
        file: new Blob([args.bytes as BlobPart], { type: args.mimeType }),
        config: { mimeType: args.mimeType, displayName: args.displayName.slice(0, 80) },
      });
      for (let i = 0; i < 30 && file.state === "PROCESSING" && file.name; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        file = await this.ai.files.get({ name: file.name });
      }
      if (file.state !== "ACTIVE" || !file.name || !file.uri) {
        throw new GeminiTransportError(
          "invalid_input",
          null,
          "The provider could not process the uploaded video.",
        );
      }
      return { name: file.name, uri: file.uri };
    } catch (err) {
      if (err instanceof GeminiTransportError) throw err;
      throw mapSdkError(err);
    }
  }

  async deleteFile(name: string): Promise<void> {
    try {
      await this.ai.files.delete({ name });
    } catch (err) {
      throw mapSdkError(err);
    }
  }

  async generate(req: GeminiRequest): Promise<GeminiResponse> {
    try {
      const res = await this.ai.models.generateContent({
        model: req.model,
        contents: req.turns.map((t) => ({
          role: t.role,
          parts: t.parts.map((p) =>
            p.type === "text"
              ? { text: p.text }
              : {
                  ...(p.type === "inline"
                    ? { inlineData: { mimeType: p.mimeType, data: p.dataBase64 } }
                    : { fileData: { mimeType: p.mimeType, fileUri: p.fileUri } }),
                  // static sampling at the batch's frozen rate (documented range (0, 24]; default would be 1 fps)
                  ...(p.videoFps ? { videoMetadata: { fps: p.videoFps } } : {}),
                },
          ),
        })),
        config: {
          systemInstruction: req.systemInstruction,
          responseMimeType: "application/json",
          responseJsonSchema: req.responseJsonSchema,
          maxOutputTokens: req.maxOutputTokens,
          temperature: req.temperature,
          thinkingConfig: { thinkingLevel: LEVELS[req.thinkingLevel] },
          httpOptions: { timeout: req.timeoutMs, retryOptions: { attempts: 1 } },
          abortSignal: req.signal,
        },
      });
      const cand = res.candidates?.[0];
      const u = res.usageMetadata;
      return {
        text: res.text ?? null,
        finishReason: cand?.finishReason ? String(cand.finishReason) : null,
        blockReason: res.promptFeedback?.blockReason ? String(res.promptFeedback.blockReason) : null,
        usage: u
          ? {
              promptTokens: u.promptTokenCount ?? null,
              candidatesTokens: u.candidatesTokenCount ?? null,
              thoughtsTokens: u.thoughtsTokenCount ?? null,
              totalTokens: u.totalTokenCount ?? null,
            }
          : null,
        responseId: res.responseId ?? null,
        modelVersion: res.modelVersion ?? null,
      };
    } catch (err) {
      throw mapSdkError(err);
    }
  }
}

/** Never copies provider payloads into the message: status + a short redacted tail only. */
export function mapSdkError(err: unknown): GeminiTransportError {
  const e = err as { status?: unknown; name?: string; message?: string; cause?: { code?: string } };
  const name = e?.name ?? "";
  if (typeof e?.status === "number") {
    const tail = redactText(String(e.message ?? ""))
      .replace(/\s+/g, " ")
      .slice(0, 120);
    return new GeminiTransportError(
      categoryForStatus(e.status),
      e.status,
      `Gemini returned HTTP ${e.status}${tail ? `: ${tail}` : ""}`,
    );
  }
  if (name === "AbortError" || /timeout|timed out|aborted/i.test(String(e?.message ?? ""))) {
    return new GeminiTransportError("timeout", null, "The analysis request timed out.");
  }
  return new GeminiTransportError(
    "network",
    null,
    "The analysis request could not be completed (network error).",
  );
}
