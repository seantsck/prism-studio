# Runway provider (Gen-4.5 video; still-image models since Phase 2G.2)

First real provider adapter. Lives entirely in `src/generation/providers/runway/` and registers through the same
adapter contract as the Mock provider; the Shot domain, GenerationPackage, queue, worker, attempt history,
output asset model and review UI are unchanged.

| Item           | Value                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| Provider id    | `runway`                                                                                                    |
| SDK            | `@runwayml/sdk` **4.22.0** (pinned exactly), official; the video request types are byte-identical to 4.21.0 |
| API version    | `X-Runway-Version: 2024-11-06`, set in one place: `runway/config.ts`                                        |
| Model          | `gen4.5` (the only Runway model Prism registers)                                                            |
| Modalities     | `text_to_video`, `image_to_video`                                                                           |
| Credential     | `RUNWAYML_API_SECRET` (server/worker only)                                                                  |
| Pricing source | https://docs.dev.runwayml.com/guides/pricing/ — 12 credits/s, $0.01/credit (checked 2026-10-13)             |

## Still-image models (Phase 2G.2)

The same adapter also serves `gpt_image_2_5_flare`, `muse_image` and `seedream5_lite` through `client.textToImage.create`
(text_to_image / image_to_image), polled and fetched with the same task API. Every request body is built against the SDK's
own request union (no `as any`, no hand-written REST); `outputCount` is always 1; GPT Image's quality is always sent
explicitly (default `medium`); references are tagged (GPT Image) or ordered (Muse, Seedream); the prompt carries a legend of
which image is which. Prices ($0.01/credit, `runway-image-2026-10-21`): GPT Image low 1 / medium 5 / high 16 / xhigh 28 / max 63
(+1 per reference per image), Muse 1, Seedream 4. `nano_banana_2.1` is priced but not typed by the SDK: not offered. See
[image-shot-generator](../image-shot-generator.md). **No real image call has been made yet.**

## Account requirements

1. A Runway **developer** account (dev.runwayml.com) and an API key from its developer portal.
2. **Credits** purchased in the portal. Generation fails with a quota error without them.
3. Know your **usage tier**: concurrency and daily generation caps depend on it (Tier 1: 1 concurrent task,
   ~50/day). Set `PRISM_STUDIO_RUNWAY_MAX_CONCURRENCY` accordingly (default 1). Extra tasks are `THROTTLED`
   by Runway (queued server-side), which Prism treats as "accepted, waiting", never as a failure.

## Environment

```
PRISM_STUDIO_GENERATION_PROVIDERS=runway     # enable the provider
RUNWAYML_API_SECRET=...                      # worker AND app server (availability); never NEXT_PUBLIC_
PRISM_STUDIO_ALLOW_PAID_GENERATION=true      # the live-spend gate (default false)
PRISM_STUDIO_MAX_GENERATION_USD=1.00         # per-generation ceiling (unset = paid generation blocked)
PRISM_STUDIO_RUNWAY_MAX_CONCURRENCY=1
PRISM_STUDIO_RUNWAY_OUTPUT_HOSTS=            # optional extra output CDN hosts
```

Runway appears in the model list with one of four states: **configured**, **missing credential**, **disabled**,
**paid generation disabled**. The browser only ever receives these states and the _names_ of missing variables.

## What Gen-4.5 can do (verified against the SDK types)

- Duration: whole seconds, **2–10**. Prism never rounds: a 4.5 s shot is _incompatible_ and says so.
- Text-to-video ratios: `16:9`, `9:16`. Image-to-video: `16:9`, `9:16`, `4:3`, `1:1`, `3:4`, `21:9`. A shot at
  `2.39:1` (the demo project) is blocked, not silently mapped to `21:9`.
- Inputs: **one first frame** (`promptImage`). No end frame, no reference images, no audio input, no negative
  prompt. Each such production intent appears in the compatibility panel as "will NOT be used" and must be
  acknowledged. Prose in the prompt is not presented as reference conditioning.
- Prompt: one text field, **1,000 characters**. Prism compiles the PromptPlan to compact prose in priority order
  (action, subject, performance, composition/camera, setting, lighting, wardrobe, continuity, constraints).
  Whatever does not fit is listed as an acknowledged "ignored feature" (`prompt.length`), never dropped silently.
- Audio: none of native dialogue, conditioning, lip sync or reference audio is available. A shot with an approved
  performance says: _this performance will not condition the generation_.

## Request lifecycle

`GenerationPackage → PromptPlan → Runway request` (the request shape never flows back).

1. **submit** creates the task and returns its id immediately (no `waitForTaskOutput`). The worker persists the id
   before anything else.
2. **poll** is a separate worker step: `tasks.retrieve`, no faster than every 5 s, backing off to 30 s.
   `PENDING`/`THROTTLED` → _queued_, `RUNNING` → _processing_, `SUCCEEDED` → ingest, `FAILED` → classified failure,
   `CANCELLED` → cancelled. (Note the SDK spells it `CANCELLED`.)
3. **ingest**: the output URL (CDN-signed, expires in 24–48 h) is consumed through `safe-fetch` (https only,
   allow-listed hosts, public IPs, bounded size/time), validated by content, checksummed, uploaded to private
   Storage and linked as an Asset. The URL is never stored (not in the package, plan, asset, provenance or logs).

## Private Prism assets → Runway

The first frame is read by the **worker** through its role-limited, checksum-verified asset access. Images up to
~3.5 MB go as a base64 **data URI** (nothing public is created). Larger images use a **short-lived (5 min) signed
Storage URL**. Either is execution transport only: never logged, never stored, never in a package export.
Historical truth is the Asset id + checksum.

## Cancellation

`cancel_requested` → adapter: look first (`tasks.retrieve`), then delete only a task that is still
`PENDING/THROTTLED/RUNNING`, then look again. Runway's `DELETE` on a **finished** task deletes its output, so a
completed task is never deleted: Prism keeps (ingests) the paid output and reports what happened. "Cancelled;
provider confirmed" is only shown after Runway reports `CANCELLED`. A tiny window remains between the look and the
delete; a task finishing inside it is reported as cancelled-by-provider.

## Idempotency — the honest guarantee

Runway's create-task endpoints expose **no idempotency key** (the SDK has none wired). So `idempotency: false`:

- Prism → at most one create call per user intention under normal operation (queue lease + unique key).
- After an **ambiguous** submit (timeout, network, 5xx, lease expiry mid-call) Prism does **not** resubmit: the job
  fails with `submission_outcome_unknown` and an _unknown_ cost record. Check the Runway dashboard; if nothing was
  created, generate again.
- The SDK's own retries are disabled (`maxRetries: 0`) for the same reason.
- Definitive refusals (429 with a clear refusal, 4xx) are retried/failed by the normal taxonomy.

## Cost

Estimate = `seconds × 12 credits × $0.01` from versioned configuration (`RUNWAY_PRICING`). Actual cost is the
`cost.credits` Runway returns on the finished task × $0.01; if Runway reports none, the cost stays **unknown**.
Failed or cancelled tasks currently record "unknown" even when Runway reports credits (known gap).

## Spend gate

A configured key is never permission to spend. Submission is refused (UI and server) unless
`PRISM_STUDIO_ALLOW_PAID_GENERATION=true`, `PRISM_STUDIO_MAX_GENERATION_USD` is set, and the estimate is within
it; the worker **re-checks** at the moment of the API call (the queue may predate a config change). The Generate
button reads `Generate — estimated $X` and a panel lists provider, model, production vs. provider duration,
inputs used and not used.

## Errors

429 → `rate_limit` (honouring `Retry-After`; "daily" → `quota`), 401/403 → `auth`, credits → `quota`, moderation →
`content_rejected`, 400/422 → `invalid_request`, 5xx → `provider_unavailable`, connection → `transient`, timeout →
`timeout`. Task failures: `SAFETY.*` → content_rejected, `ASSET.*`/input → invalid_request, `INTERNAL.*` →
provider_unavailable. Messages are fixed sentences; provider payloads are never copied.

## First live smoke test (NOT automatic — needs explicit approval of the spend)

1. `npm run worker:db:check` and `npm run db:worker-role` pass.
2. On the worker host set `RUNWAYML_API_SECRET`, `PRISM_STUDIO_GENERATION_PROVIDERS=runway`,
   `PRISM_STUDIO_ALLOW_PAID_GENERATION=true`, `PRISM_STUDIO_MAX_GENERATION_USD=0.50`.
3. Use a dedicated **2-second 16:9 text-to-video** test shot (24 credits ≈ **$0.24**). Do not change Shot 3A's
   4.5 s timing to fit.
4. Generate, watch queued → THROTTLED/RUNNING → ingested, check the Asset and the recorded actual cost against the
   Runway dashboard, then switch `PRISM_STUDIO_ALLOW_PAID_GENERATION` back to `false`.
