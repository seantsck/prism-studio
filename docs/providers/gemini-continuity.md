# Gemini continuity analyzer (Phase 2D)

First REAL multimodal continuity analyzer, behind the provider-independent contract
([continuity-analyzer-contract](../continuity-analyzer-contract.md)). Nothing Gemini-specific appears in
criteria, plans, findings, the queue or the UI: it lives in `src/continuity/providers/gemini/`.

> **The model does not decide what continuity should be.** Prism supplies the expected truth, the references,
> the criterion, the severity and the media. The analyzer answers one question per criterion: _does this output
> appear consistent with THIS expectation, based on THESE references?_

> **Status.** Prism-side behaviour is proven; live inference is not. `models.get`, `countTokens` and request/media
> parsing succeed for both listed models, but `generateContent` returned sustained confirmed 503 (overload) on
> `gemini-3.8-flash` and `gemini-3.6-flash`, so no live analysis has been produced. Gemini stays implemented and
> configurable (it is disabled unless listed in `PRISM_STUDIO_CONTINUITY_ANALYZERS`), its retry policy and
> historical runs are unchanged, and it coexists with the OpenAI adapter behind the same contract
> ([openai-continuity](openai-continuity.md)). There is no automatic routing between providers.

## Verified against the official documentation (2026-10-13)

| Item      | Value                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model     | `gemini-3.8-flash` — listed **stable** on https://ai.google.dev/gemini-api/docs/models                                                                                                                 |
| SDK       | `@google/genai` **2.29.0** (npm `latest`, pinned), `ai.models.generateContent`                                                                                                                         |
| Pricing   | $0.75 / 1M input, $3.75 / 1M output through 2026-12-31; $1.50 / $7.50 from 2027-01-01 (page updated 2026-10-09). Image and video input are billed at the text rate; thinking tokens at the output rate |
| Config    | `src/continuity/providers/gemini/config.ts` — the only place model id, SDK pin and pricing live                                                                                                        |
| API shape | The docs now show the newer Interactions API; Prism uses the SDK's stable `generateContent` (documented, `usageMetadata`, `responseJsonSchema`). Re-evaluate when Interactions stabilises              |

Pricing is versioned configuration (`gemini-2026-10-13`), never scraped at runtime; the rate is selected by the
analysis date (the 2027 step is encoded). An unknown model has **no** price ⇒ cost unknown ⇒ the spend gate blocks.

### Model selection (one analyzer, several models)

`PRISM_STUDIO_GEMINI_ANALYSIS_MODEL` selects the model; the default stays `gemini-3.8-flash`. The same
`GeminiAnalysisProvider` serves every listed model; a model carries its own capability record and price in
`GEMINI_MODELS` / `GEMINI_PRICING`.

| Model              | Status (docs, 2026-10-13)        | Inputs                         | Output | Structured outputs | Price (≤ 2026-12-31 → 2027-01-01) |
| ------------------ | -------------------------------- | ------------------------------ | ------ | ------------------ | --------------------------------- |
| `gemini-3.8-flash` | Stable                           | text, image, video, audio, pdf | text   | supported          | $0.75/$3.75 → $1.50/$7.50 per 1M  |
| `gemini-3.6-flash` | Stable (latest update July 2026) | text, image, video, audio, pdf | text   | supported          | $0.75/$3.75 → $1.50/$7.50 per 1M  |

A model that is not listed (or lacks image input, structured output, a stable status or a price) is **blocked**:
state `unsupported_model`, no executable provider, never priced and never sent. The model id is frozen on the run
and the job at submission; changing the environment later never rewrites a stored run.

## Environment

```
PRISM_STUDIO_CONTINUITY_ANALYZERS=mock,gemini   # which analyzers exist (default: mock)
GEMINI_API_KEY=...                              # server/worker ONLY (GOOGLE_API_KEY also accepted)
PRISM_STUDIO_GEMINI_ANALYSIS_MODEL=gemini-3.8-flash
PRISM_STUDIO_GEMINI_THINKING_LEVEL=LOW          # MINIMAL|LOW|MEDIUM|HIGH (bounds thinking spend)
PRISM_STUDIO_GEMINI_DIRECT_VIDEO=0              # direct video (3A.3, calibrated): OFF by default; also needs Project consent
PRISM_STUDIO_ALLOW_PAID_ANALYSIS=false          # the analysis spend gate (separate from PAID_GENERATION)
PRISM_STUDIO_MAX_ANALYSIS_USD_PER_RUN=0.10      # server-side ceiling; unset = paid analysis blocked
PRISM_STUDIO_MAX_ANALYSIS_USD_PER_DAY=          # optional global daily ceiling
```

The key never reaches the browser (a test scans routes/components), a job, a log, a manifest or a snapshot
(`GEMINI_API_KEY` is in both secret redactors). The UI only receives analyzer **states**: `configured`,
`missing_credential`, `disabled`, and `spend` on/off.

## What Gemini sees

For each request (batch), exactly:

1. a **static system instruction** (`continuity-gemini-image-v1`): task, rules, injection/data boundaries,
   result semantics. No project text is ever concatenated into it;
2. one **DATA** JSON document: for each criterion `criterionId`, category, **expected value**, source — plus
   the list of inputs (`inputId`, role, label, timestamp). Labelled untrusted data;
3. the **reference images**, each preceded by its `inputId` label (ranked, see below);
4. the **output images** (first / 25 % / 50 % / 75 % / last review frames, or the contact sheet if frames do
   not exist) with timestamps;
5. a closing instruction to answer every criterionId as JSON.

It never sees: project/episode titles, scripts or dialogue (unless they are a criterion's expected value),
other criteria, severity, approval state, signed URLs, Prism ids beyond `inputId`/`criterionId`.

### Reference ranking (deterministic, roles matter)

| Criterion                          | References, best first                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| identity / character count         | approved **identity** refs → approved storyboard frame                       |
| wardrobe / hair / makeup / jewelry | assigned **Look** refs → identity refs → storyboard                          |
| location / weather / time of day   | **location** refs → (lighting) → storyboard → explicitly included prior shot |
| lighting                           | lighting ref → location → storyboard → prior shot                            |
| composition / camera               | storyboard → location (none required)                                        |

Only references that Prism's reference-set builder **explicitly** included are eligible. A generated frame
(including the output being judged) is never a reference: a bad generation cannot become identity truth. The
previous approved shot appears only when it was explicitly added as an approved neighbour.

### Batching, budget, bounding

Criteria with identical visual inputs share one request (≤ 8 criteria); results stay per criterion. Per request:
≤ 6 references and ≤ 5 output images. References that rank but do not fit are **recorded as omitted**
(`input_budget`) and shown in the UI: never silently dropped. Images are bounded to 1024 px on the long edge
(and 4 MB) before leaving Prism; the original Asset is untouched and the manifest records the size sent.

## Structured, evidence-based results

Response mode: `responseMimeType: application/json` + `responseJsonSchema`. Per criterion:
`criterionId`, `result` (`pass|warn|fail|unchecked`), `confidence` (0..1 or null), `summary`,
`evidence[]` (`input`, `timestampMs`, `observation`), `contradictions[]`, `limitations[]`.

Prism-owned fields cannot come back (`.strict()` schema): severity, expected value, approval, aggregate score.
Validation rejects unknown/duplicate criterion ids, evidence citing an input that was not in the request,
out-of-range values and oversized responses. Criteria the model simply did not answer become **UNCHECKED**
(`not_returned`): nothing is invented.

- **One correction per run, then fail.** A structurally invalid answer triggers one correction request
  (validation errors + the previous answer, media re-sent); a second failure — or a second batch needing a
  correction after the run's allowance is spent — ends the job visibly (`schema_invalid`). Correction usage is
  tracked separately and the correction counts against the transport-call ceiling.
- **Refusals are not failures.** `promptFeedback.blockReason` or a safety finish reason makes the batch's
  criteria **UNCHECKED** with `provider_refusal`. A continuity failure means a visible conflict with production
  truth, never provider inability.
- **Confidence is advisory** ("analysis confidence"), never presented as a calibrated probability.
- **Identity wording** is about _visual consistency with the designated fictional reference_, not who someone is.

## Retries and idempotency (the honest guarantee)

`generateContent` documents **no idempotency key** and no request-dedup mechanism. Therefore:

| Outcome                          | Policy                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 429 / 503                        | provider did not process it: **no in-process retry**; the job is released with a persisted, backed-off `next_run_at` (durable retry) |
| retries exhausted after 429/503  | `provider_overloaded_retry_exhausted` (confirmed, not ambiguous); cost `unknown` with reason `provider_overloaded`                   |
| 500 / 502 / 504                  | not auto-retried; fails with the sanitized status                                                                                    |
| 401/403, 400/404/413/422         | permanent (`auth`, `invalid_input`)                                                                                                  |
| timeout / network                | **ambiguous**: may have been processed and billed ⇒ `outcome_unknown`, **never re-sent**; cost `unknown` (`ambiguous_submission`)    |
| local ceiling / policy block     | `local_policy_block`: refused BEFORE the transport is invoked; never counted as a request, never `outcome_unknown`                   |
| lease expired after a send began | reclaimed job (`provider_state = sending`) fails `outcome_unknown` instead of spending again                                         |

SDK retries are disabled (`retryOptions.attempts = 1`) so a hidden retry cannot double-bill.

### Durable overload backoff

Google's guidance for 429/503 is exponential backoff. Prism applies it in the **queue**, not in a loop:

```
claim → ONE request → 503
      → persist transport_calls, partial usage, answered batches, next_run_at (+15 s)   [job released]
later claim → ONE new request → 503 → next_run_at (+45 s) → … (+120 s, +300 s, +600 s; ±10 % deterministic jitter)
```

A provider `Retry-After` longer than the schedule is honoured (capped at 15 min). No worker sleeps for minutes and
no database transaction is held while waiting: other workers skip a job whose `next_run_at` has not arrived.
Batches that already have an answer are stored on the job (`batch_results`, normalized findings + usage only), so a
later claim re-sends **only** the unfinished batch.

### Request ceiling (separate from batches and corrections)

| Limit                                  | Default | Setting                                     |
| -------------------------------------- | ------- | ------------------------------------------- |
| provider transport calls per run       | 6       | `PRISM_STUDIO_ANALYSIS_MAX_TRANSPORT_CALLS` |
| schema-correction requests per **run** | 1       | `PRISM_STUDIO_ANALYSIS_MAX_CORRECTIONS`     |
| worker claims per job (`max_attempts`) | 6       | `PRISM_STUDIO_ANALYSIS_MAX_ATTEMPTS`        |

Retries and corrections both count as transport calls. A call is counted only when Prism actually invokes the
Gemini transport (persisted immediately before the call; a locally refused call is never counted). Each attempt
is an audit event (`provider_request_attempt batch=1/2 kind=analysis transport_call=3/6`, then `http=503
overloaded; retry_ordinal=2; next_attempt_at=…`). No raw provider payload is stored.

## Cost

Estimated before submission (worst case includes one correction per request): image tokens per the documented
tiling (258 per ≤384 px image, else 258 per tile), prompt text ≈ chars/3, output at the configured ceiling.
Actual cost is derived from `usageMetadata` (`promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`);
missing usage ⇒ **unknown**, never guessed. Records live in `continuity_analysis_costs`, separate from
`generation_costs` ([continuity-costs](../continuity-costs.md)).

## Files API and retention

Direct video (OFF by default) larger than 12 MB goes through the Files API; smaller is inline. Provider files are
**temporary operational copies**: their names are stored on the job (`provider_files`) and deleted best-effort
after the analysis (`deleted` / `cleanup_failed`; a failed delete never invalidates the analysis). The provider
auto-deletes after 48 h; uploaded files cannot be downloaded back. Private Prism assets are never made public.
Image-set analysis sends bounded inline copies and creates no provider-side file.

## Not yet live

Phase 2D built and tested everything against a **fake transport**; no Gemini request has been made. The first
live smoke needs explicit approval ([continuity-costs](../continuity-costs.md) → "Live smoke").
