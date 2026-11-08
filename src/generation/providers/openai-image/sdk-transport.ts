import OpenAI, { toFile } from "openai";
import { redactText } from "@/lib/auth/redact";
import {
  OpenAIImageTransportError,
  type OpenAIImageCall,
  type OpenAIImageCallResult,
  type OpenAIImageInput,
} from "./transport";

/**
 * The real `openai-image` transport: the official SDK (pinned openai@7.32.0), `images.generate` / `images.edit`.
 * Loaded lazily by the adapter, only in the process that executes a job (the worker); the web never imports it.
 *
 *  - SDK retries are DISABLED (`maxRetries: 0`, also per request). The Images API takes no idempotency key, so an
 *    ambiguous outcome (timeout, dropped connection) is never re-sent automatically.
 *  - The API key lives only in this object; it is never logged, returned or put in an error message.
 *  - `fetchImpl` lets a caller trap the network (tests, the pre-paid check).
 */
export class SdkOpenAIImageTransport {
  private readonly client: OpenAI;

  constructor(opts: { apiKey: string; fetchImpl?: typeof fetch }) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      maxRetries: 0,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl as never } : {}),
    });
  }

  async call(call: OpenAIImageCall): Promise<OpenAIImageCallResult> {
    const options = { timeout: call.timeoutMs, maxRetries: 0, signal: call.signal };
    try {
      const common = {
        model: call.model,
        prompt: call.prompt,
        n: 1,
        size: call.size as "1024x1024",
        quality: call.quality,
        background: call.background,
        output_format: call.outputFormat,
      } as const;
      const { data: res, response } =
        call.operation === "generate"
          ? await this.client.images.generate({ ...common, stream: false }, options).withResponse()
          : await this.client.images
              .edit(
                {
                  ...common,
                  stream: false,
                  image: await Promise.all(call.images.map(file)),
                  ...(call.mask ? { mask: await file(call.mask) } : {}),
                },
                options,
              )
              .withResponse();
      const first = res.data?.[0];
      if (!first?.b64_json) {
        throw new OpenAIImageTransportError(null, "no_image", "OpenAI returned no image.", false);
      }
      const usage = res.usage;
      return {
        b64: first.b64_json,
        size: res.size ?? null,
        outputFormat: res.output_format ?? null,
        background: res.background ?? null,
        quality: res.quality ?? null,
        created: typeof res.created === "number" ? res.created : null,
        requestId: response.headers.get("x-request-id"),
        usage: usage
          ? {
              inputTokens: usage.input_tokens ?? null,
              outputTokens: usage.output_tokens ?? null,
              textInputTokens: usage.input_tokens_details?.text_tokens ?? null,
              imageInputTokens: usage.input_tokens_details?.image_tokens ?? null,
            }
          : null,
      };
    } catch (err) {
      throw toTransportError(err);
    }
  }
}

async function file(input: OpenAIImageInput) {
  return toFile(Buffer.from(input.bytes), input.filename, { type: input.mime });
}

function toTransportError(err: unknown): OpenAIImageTransportError {
  if (err instanceof OpenAIImageTransportError) return err;
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new OpenAIImageTransportError(null, "timeout", "OpenAI did not answer in time.", true);
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new OpenAIImageTransportError(null, "connection", "The connection to OpenAI failed.", true);
  }
  if (err instanceof OpenAI.APIError) {
    const code = typeof err.code === "string" ? err.code : null;
    // the provider's message is reduced to a redacted, short form (it can echo request fields, never the key)
    const message = redactText(String(err.message ?? "OpenAI refused the request.")).slice(0, 200);
    // a 5xx may have been produced after the image was rendered: treat it as possibly billed
    return new OpenAIImageTransportError(err.status ?? null, code, message, (err.status ?? 0) >= 500);
  }
  return new OpenAIImageTransportError(null, "unknown", "The OpenAI request failed.", true);
}
