# Provider contract

A provider is an object implementing `GenerationProviderAdapter` (`src/generation/provider.ts`). Prism hands it
a normalized `GenerationRequest`; it translates internally. Provider request/response types never leave the
adapter module.

```ts
interface GenerationProviderAdapter {
  info(): GenerationProviderInfo; // id, name, kind, required config NAMES, webhooks?
  listModels(): GenerationModel[]; // declared capabilities, lifecycle, pricing
  compileRequest(req, plan): CompiledRequestSummary; // pure, secret-free; powers the Prompt Inspector
  validateRequest(req, model): { ok; errors }; // beyond the generic compatibility engine
  estimateCost(req, model): CostEstimate; // null amount = unknown (never invented)
  submit(req, plan, ctx): GenerationSubmission; // returns providerJobId (+ idempotency honoured)
  poll(ref, ctx): GenerationStatus; // queued | processing | succeeded | failed | cancelled
  cancel?(ref, ctx): { confirmed }; // only if capabilities.operational.cancellation
  fetchResult(ref, req, ctx): GenerationResult; // outputs (bytes | provider-issued URL) + provenance + cost
  allowedOutputHosts?(): string[]; // SSRF allow-list for URL outputs
  verifyWebhook?(headers, rawBody): boolean; // MUST run before any parsing
  handleWebhook?(headers, rawBody): WebhookEvent | null;
}
```

## Capabilities (`modelCapabilitiesSchema`)

Declared per model, evaluated deterministically by `evaluateCompatibility(package, model)`:

| Group       | Fields                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| modalities  | text_to_image, image_to_image, text_to_video, image_to_video, video_to_video, audio_to_video, lip_sync, voice, upscale                              |
| references  | text/negative prompt, reference images, max count, ordered, character/style/location refs, start frame, end frame, reference video, reference audio |
| video       | min/max duration, step **or** exact allowed durations, camera control, motion prompting, max resolution, aspect ratios, fps                         |
| image       | resolutions, aspect ratios, transparency, editing                                                                                                   |
| audio       | `nativeDialogueAudio`, `audioConditioning`, `lipSync`, `referenceAudio`, `soundGeneration` — **deliberately distinct**                              |
| operational | sync/async, polling, webhook, cancellation, idempotency, max concurrency, poll interval, job timeout, rate-limit notes                              |
| commercial  | pricing strategy, currency, cost unit, unit cost (`null` = unknown)                                                                                 |

**Do not declare capabilities a provider does not have.** Providers that are not integrated simply have no
adapter.

## What the compatibility engine decides

| Situation                                                                                | Outcome                                                                       |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Duration not offered by the model                                                        | **error** — "Production duration 4.5s; model supports 5s, 10s". Never rounded |
| Aspect ratio not offered                                                                 | **error**                                                                     |
| More references than the model accepts                                                   | **error** naming both numbers                                                 |
| Image-to-video but no start frame                                                        | **error**                                                                     |
| End frame / style refs / performed audio / negative prompt / reference video unsupported | **ignored feature** — listed, impact explained, must be acknowledged          |
| Resolution above model maximum, unsupported fps                                          | **ignored feature** (output differs from request)                             |

Errors block generation. Ignored features block until each id is acknowledged, then the acknowledgement is
frozen on the attempt (`acknowledged_ignored`). Prism never silently discards production intent.

## Asset access

Adapters needing Prism files (frames, references, performed audio) read them through `ctx.assets.read(assetId)`.
The frozen package carries each asset's storage location, checksum and dimensions, so a re-executed attempt
reads exactly what it was built from.

## Output delivery

`fetchResult` returns `ProviderOutput[]` with `source: { type: "bytes" } | { type: "url" }`. URLs must be ones
the **provider** returned (never user input) and must match `allowedOutputHosts()`; Prism then downloads with the
SSRF-safe fetcher, validates, stores in the private bucket and forgets the URL. See
[security-model](security-model.md#generation-and-outputs).

## Errors

Throw `GenerationProviderError(category, stableCode, sanitizedMessage, { retryAfterMs?, retryable? })`.
Never put credentials, request bodies, signed URLs or raw provider text in the message.

## Webhooks

The architecture is generic (verify → normalize → locate job → transition idempotently → ingest) but **no
endpoint exists** until a provider that needs one is integrated. Verification must precede parsing; unsigned
events are never trusted; handlers are idempotent on the provider event id.

Step-by-step: [providers/adding-a-provider](providers/adding-a-provider.md).
