import { redactText } from "@/lib/auth/redact";
import { PhotoroomTransportError, type PhotoroomCall, type PhotoroomResult } from "./transport";

/**
 * The real Photoroom transport (plain `fetch`, no SDK). Loaded lazily by the adapter in the worker only.
 *  - `x-api-key` is set here and nowhere else; it is never logged, returned or included in an error.
 *  - One request per call; no automatic retry (no idempotency key exists, so an ambiguous outcome is never re-sent).
 *  - `format=png&channels=rgba&size=full&crop=false`: an RGBA PNG at the input's size, not cropped to the subject.
 *  - `fetchImpl` lets a caller trap the network (tests, a pre-paid check).
 */
export const PHOTOROOM_SEGMENT_URL = "https://sdk.photoroom.com/v1/segment";

export class HttpPhotoroomTransport {
  constructor(private readonly opts: { apiKey: string; fetchImpl?: typeof fetch }) {}

  async segment(call: PhotoroomCall): Promise<PhotoroomResult> {
    const form = new FormData();
    form.set(
      "image_file",
      new Blob([Buffer.from(call.image.bytes)], { type: call.image.mime }),
      call.image.filename,
    );
    form.set("format", "png");
    form.set("channels", "rgba");
    form.set("size", "full");
    form.set("crop", "false");
    const timeout = AbortSignal.timeout(call.timeoutMs);
    const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(PHOTOROOM_SEGMENT_URL, {
        method: "POST",
        headers: { "x-api-key": this.opts.apiKey, accept: "image/png, application/json" },
        body: form,
        signal,
      });
    } catch (err) {
      const timedOut = (err as { name?: string })?.name === "TimeoutError";
      throw new PhotoroomTransportError(
        null,
        timedOut ? "timeout" : "connection",
        timedOut ? "Photoroom did not answer in time." : "The connection to Photoroom failed.",
        true,
      );
    }
    if (!res.ok) {
      // error bodies vary across Photoroom's docs ({error:{message}} or {detail}); keep only a short, redacted message
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { message?: string }; detail?: unknown };
        detail = String(body?.error?.message ?? (typeof body?.detail === "string" ? body.detail : "") ?? "");
      } catch {
        detail = "";
      }
      throw new PhotoroomTransportError(
        res.status,
        `http_${res.status}`,
        redactText(detail || `Photoroom returned HTTP ${res.status}.`).slice(0, 200),
        res.status >= 500,
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const score = Number(res.headers.get("x-uncertainty-score"));
    return {
      bytes,
      contentType: res.headers.get("content-type"),
      uncertaintyScore: Number.isFinite(score) && res.headers.has("x-uncertainty-score") ? score : null,
    };
  }
}
