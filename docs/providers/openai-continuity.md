# OpenAI continuity analyzer (Phase 2D.1)

The second real implementation of the provider-independent `ContinuityAnalysisProvider` contract. It exists to
prove that the Phase 2D architecture (frozen input, batch planner, strict result schema, durable queue, spend gate,
cost ledger, manifest, human overrides) works with a second multimodal provider **without any change to the
domain**. Gemini and OpenAI implement the same normalized analyzer contract; nothing downstream knows which one
produced a finding.

> **Status:** built and tested against a deterministic fake transport only. **No live OpenAI request has been
> made.** Paid analysis stays off by default and a live smoke needs explicit approval.

## Verified against the official documentation (2026-10-13)

| Fact               | Value                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Model id           | `gpt-6-luna` (the only snapshot and the default)                                                                        |
| Inputs / outputs   | text + image in, text out                                                                                               |
| Endpoint           | Responses API, `POST /v1/responses` (`client.responses.create`)                                                         |
| Structured outputs | supported: `text.format = { type: "json_schema", name, schema, strict: true }`                                          |
| Images             | `input_image` with `image_url` (URL or base64 data URL) or `file_id`; `detail` low \| high \| original \| auto          |
| Image formats      | PNG, JPEG, WEBP, non-animated GIF; up to 1,500 images / 512 MB per request                                              |
| Image tokenization | patch based: `ceil(w/32) × ceil(h/32)` × a per-model multiplier (1.2 documented for `gpt-6-astra`; none for luna)       |
| Context / output   | 1,050,000 / 128,000 tokens                                                                                              |
| Price (standard)   | $0.10 / 1M input, $0.01 / 1M cached input, $0.50 / 1M output (≤ 272K input tokens)                                      |
| Long context       | > 272K input tokens: 2× input and cache rates, 1.5× output for the whole request                                        |
| Usage fields       | `input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens`         |
| Refusals           | a `refusal` content item on the output message (not schema-conforming output); `incomplete_details.reason`              |
| Errors             | 401 auth · 403 region · 429 rate limit **or** quota/billing (`error.code`) · 500 · 503 overloaded; honour `Retry-After` |
| SDK                | `openai@7.32.0` (npm `latest`), pinned exactly                                                                          |

Where the documentation is silent (reasoning-model `temperature`, a luna patch multiplier, idempotency) Prism
makes the conservative choice and says so below. Re-verify before changing `OPENAI_PRICING` / `OPENAI_MODELS`.

## Where things live

| Concern                              | File                                                |
| ------------------------------------ | --------------------------------------------------- |
| Model registry, pricing, detail      | `src/continuity/providers/openai/config.ts`         |
| Transport boundary + error map       | `src/continuity/providers/openai/transport.ts`      |
| Real transport (SDK, lazy import)    | `src/continuity/providers/openai/sdk-transport.ts`  |
| Adapter (`OpenAIContinuityAnalyzer`) | `src/continuity/providers/openai/analyzer.ts`       |
| Deterministic fake                   | `src/continuity/providers/openai/fake-transport.ts` |
| Cross-provider model registry        | `src/continuity/analysis/models.ts`                 |
| Provider health (informational)      | `src/domain/continuity/analysis/health.ts`          |

Only `sdk-transport.ts` imports the `openai` package, and it is loaded lazily (a test enforces this).

## Configuration

| Variable                                    | Meaning                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `PRISM_STUDIO_CONTINUITY_ANALYZERS`         | must list `openai` (e.g. `mock,gemini,openai`). A key alone never enables a provider. |
| `OPENAI_API_KEY`                            | secret; server/worker only; never `NEXT_PUBLIC_`                                      |
| `PRISM_STUDIO_OPENAI_ANALYSIS_MODEL`        | default `gpt-6-luna`; an unlisted model is blocked (state `unsupported_model`)        |
| `PRISM_STUDIO_OPENAI_REASONING_EFFORT`      | `none` \| `low` (default) \| `medium` \| `high`                                       |
| `PRISM_STUDIO_OPENAI_TIMEOUT_MS`            | per-request timeout (default 120000)                                                  |
| `PRISM_STUDIO_ALLOW_PAID_ANALYSIS`          | the **shared** spend gate (default false)                                             |
| `PRISM_STUDIO_MAX_ANALYSIS_USD_PER_RUN`     | the **shared** per-run ceiling                                                        |
| `PRISM_STUDIO_ANALYSIS_MAX_TRANSPORT_CALLS` | the **shared** transport ceiling (default 6; the proposed smoke uses 4)               |

Adding `gpt-6-astra` or `gpt-6-sol` later is one `OPENAI_MODELS` entry plus one `OPENAI_PRICING` entry; the
adapter, queue and UI are model-agnostic. They are intentionally not listed yet.

## Request compilation

One logical batch (from the existing Phase 2D batch planner; OpenAI has no batching of its own) becomes one
`responses.create`:

- `instructions`: `SYSTEM_INSTRUCTION_OPENAI_IMAGE_V1`, static text only (prompt version
  `continuity-openai-image-v1`). Project text is never concatenated into it.
- `input`: one user message made of `input_text` parts (the `DATA` document, labels) and `input_image` parts
  (references first, then output frames) in the planner's order.
- `text.format`: the shared strict JSON Schema (`ANALYSIS_RESPONSE_JSON_SCHEMA`; verified to use only
  strict-compatible keywords: every property required, `additionalProperties: false`).
- `reasoning.effort`: `low` by default. `max_output_tokens`: `min(8192, 2048 + 450 × criteria)`; reasoning tokens
  count against it, so there is headroom.
- `store: false`: the response is not retained in OpenAI's response store.
- No `temperature`: the documentation does not state support for reasoning models, so none is sent.

### Image transport and detail policy

Images are already normalized and bounded by Prism (longest side ≤ `maxImageDimension`). They are sent
**inline as base64 data URLs**, built per request from bytes already in memory. No URL is created, nothing is made
public, the Files API is not used, and base64 is never written to a job, run, manifest or log: history keeps asset
id, checksum and role only.

`detail` is centralised in `OPENAI_IMAGE_DETAIL = "high"` (documented standard fidelity). `original` (dense text,
computer use) and `auto` (model-dependent, unpredictable cost) are deliberately not used: continuity judges
identity, wardrobe and scene, not OCR.

### Media volume is product policy, not provider capability

OpenAI accepts up to 1,500 images per request. Prism does not: the same `maxReferencesPerBatch`, output-frame
budget, ranking and omission reporting apply to every provider, and `omittedReferenceInputIds` is reported
exactly as for Gemini.

## Result normalization

The model returns strict JSON; the adapter hands the text to the **same** `validateBatchResponse` Gemini uses.
Rejected before anything is stored: unknown or duplicate `criterionId`, evidence pointing at an input that was not
sent (no invented frame ids), invented timestamps for image-only mode, out-of-range confidence, and any extra key
(`severity`, `approved`, scores). OpenAI cannot assign severity, expected truth, continuity approval or creative
approval; those remain Prism-owned.

| Provider output                                 | Becomes                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| valid answer                                    | normalized findings (identical shape for every provider)                       |
| `refusal` item, or `incomplete: content_filter` | all batch criteria `unchecked` with limitation `provider_refusal` (never FAIL) |
| invalid / truncated JSON                        | one schema-correction request, if the run still has its allowance              |
| criterion not answered                          | `unchecked` (`not_returned`); nothing is invented                              |

## Cost

- **Estimate** (pre-request, for the spend gate): text ≈ chars ÷ 3, images by the patch formula with an assumed
  multiplier of **1.5** (above the documented 1.2 for astra; luna's is undocumented), output ceiling included,
  plus one correction worst case. It is a ceiling, not a quote. For the synthetic smoke shape it is ~$0.0065.
- **Actual**: only from the response's `usage`. Reasoning tokens are a subset of `output_tokens`; the adapter
  splits them out so the shared cost code never double-counts, and bills cached input at the cached rate. A
  request above 272K input tokens is priced with the long-context tier. Usage absent ⇒ the cost is **unknown**,
  never invented.
- Recorded in `continuity_analysis_costs` (never `generation_costs`) with `pricingVersion = openai-2026-10-13`.

## Retries, ceilings and ambiguity

The Phase 2D queue semantics apply unchanged: one worker claim sends at most one request per batch; there is no
in-process retry and **SDK retries are disabled** (`maxRetries: 0`), so Prism sees every billable invocation.

| OpenAI outcome                               | Prism category                            | Behaviour                                              |
| -------------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| 429 rate limit / `slow_down`                 | `rate_limit`                              | durable requeue, `Retry-After` honoured                |
| 503 overloaded                               | `overloaded`                              | durable requeue with exponential backoff               |
| 429 `insufficient_quota`, spend/usage limits | `config`                                  | terminal: retrying cannot help until a person fixes it |
| 401 / 403                                    | `auth`                                    | terminal                                               |
| 400 / 404 / 413 / 422                        | `invalid_input`                           | terminal                                               |
| 500 / other 5xx                              | `server_error`                            | terminal (not auto-retried)                            |
| timeout / connection lost after send         | `outcome_unknown`                         | terminal, **never re-sent**                            |
| refusal                                      | (result) `unchecked` / `provider_refusal` | job succeeds; spend recorded                           |
| local ceiling reached                        | `local_policy_block`                      | refused before the transport; not counted              |

**Idempotency finding.** The SDK exposes an `Idempotency-Key` request option, but the Responses `create`
documentation does not describe server-side de-duplication or a replay window. Prism therefore does **not** send
one and does **not** rely on it: an ambiguous outcome is never re-sent, exactly as for Gemini. If OpenAI documents
a guarantee for Responses creation, it can be adopted behind this adapter without touching the queue.

Transport-call and correction ceilings (`PRISM_STUDIO_ANALYSIS_MAX_TRANSPORT_CALLS`,
`PRISM_STUDIO_ANALYSIS_MAX_CORRECTIONS`) are persisted on the job and are provider-independent.

## Security

- `OPENAI_API_KEY` is read only server-side; redacted from logs both by value and by key shape (`sk-…`); absent
  from jobs, snapshots, manifests, estimates and the browser bundle (tests).
- Inline images only; no public URL; no Files API object to clean up.
- Prompt injection: static instructions, production text only as bounded `DATA`, text inside images declared
  untrusted (rules A–E in the prompt: ignore embedded instructions, treat posters/screens/captions/signs as scene
  content, use media only for the listed criteria, fictional-character wording for identity, unchecked rather than
  fail). Covered by regression tests.
- Identity means _visual consistency with the designated fictional-character reference_. The adapter never asks
  the model to identify a real person.
- No new database role, column or migration: the existing `prism_continuity_worker` claims jobs of any provider.

## Provider health

`providerHealth()` is informational: `disabled`, `not_configured`, `configured`, `available`,
`recent_provider_failure`, with the count of provider-side failures in history. It is shown next to the analyzer
picker ("Gemini — configured, recent failure: overload (503)"). It never routes, retries or disables anything, and
history is never erased: a past failure stays counted after a later success.

## Validation without spending

```bash
npm run continuity:pre-paid:check -- --provider openai   # or: npm run continuity:pre-paid:check:openai
```

Real provider class and real SDK transport, with every outbound fetch trapped: reports credential
present/missing, flag state, ceiling, model, plan and estimate for the synthetic fixture, that submission and the
worker refuse while paid analysis is off or over the ceiling, and that no request was attempted.

## Proposed live smoke (NOT executed; needs explicit approval)

Same synthetic `continuity-smoke-test` fixture as the Gemini attempts (identity + wardrobe, image set, one
512×288 output, ≤ 2 references), `gpt-6-luna`, `PRISM_STUDIO_ANALYSIS_MAX_TRANSPORT_CALLS=4`, ceiling $0.10,
paid analysis enabled at process level only for that run, then restored to `false`.
