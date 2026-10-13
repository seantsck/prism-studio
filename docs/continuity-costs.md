# Continuity analysis costs and spend control (Phase 2D)

Analysis spend is **its own concern**: separate flag, separate ceiling, separate accounting. It never reuses
`PRISM_STUDIO_ALLOW_PAID_GENERATION` or `generation_costs`.

## Gates

| Variable                                | Meaning                                                 | Default         |
| --------------------------------------- | ------------------------------------------------------- | --------------- |
| `PRISM_STUDIO_ALLOW_PAID_ANALYSIS`      | the live-spend switch for model analyzers               | `false`         |
| `PRISM_STUDIO_MAX_ANALYSIS_USD_PER_RUN` | per-run ceiling checked against the WORST-CASE estimate | unset ⇒ blocked |
| `PRISM_STUDIO_MAX_ANALYSIS_USD_PER_DAY` | optional global 24 h ceiling (actual, else estimate)    | unset           |

A key + an enabled analyzer is **not** permission to spend. The gate is evaluated (a) in the UI preview,
(b) in the server action at submission, (c) again by the worker at the moment of the call. The numbers come
from server configuration only; nothing the browser submits can raise them. The free Mock analyzer needs no gate.
Per-project budgets are a documented follow-up (global ceilings only in Phase 2D).

## Before you run

The Continuity page shows, for each analyzer: model and mode, criteria to analyse, what stays deterministic /
manual / unsupported / no media (with reasons), references used and **not sent due to budget**, output images,
the number of requests, expected and worst-case cost, and what leaves Prism. Paid analysis requires an
explicit acknowledgement. Nothing runs automatically (auto-run after conform is architecture only and OFF).

## Estimate

Conservative and explicit (`provider.estimate`): input tokens (documented image tiling, prompt text, schema
overhead) × input rate + output ceiling × output rate, plus one worst-case correction per request.
`expected` is a typical answer; `max` is what the gate uses. If the model has no pricing entry the estimate is
unknown and a paid run is blocked.

## Actual cost

From authoritative provider `usageMetadata` of every call that returned (including the correction call):
input, output, thinking tokens → amount. Missing usage ⇒ **unknown** (never invented). Unknown records say why
(`usage.unknownReason`):

| Reason                 | Meaning                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `provider_overloaded`  | every request was answered 429/503 and none reported usage (not claimed to be zero: no usage record) |
| `ambiguous_submission` | a request may have been processed (timeout / connection lost after send)                             |
| `no_usage_reported`    | a request completed but the provider returned no usage metadata                                      |

`usage.transportCalls` records how many outbound requests were actually made. A call refused locally (ceiling)
is not a request and is not counted.

## Accounting (`continuity_analysis_costs`, migration 0023)

Append-only rows per job: `estimated` (written by the user's session at submission), then exactly one
`actual` or `unknown` (written by the worker). Fields: analyzer, model, amount, expected, usage JSON (tokens per
call, correction), pricing version. `analysisSpentSince` sums actual where known, otherwise the estimate
ceiling, so spend is never under-counted.

## Live smoke (prepared, NOT executed)

`npm run continuity:fixture` plans a disposable synthetic project (two synthetic 512×288 PNGs; identity +
wardrobe; no video). `npm run continuity:pre-paid:check` proves, with the network trapped: credential/config
status, the flag is false, the ceiling, the model, the fixture plan and estimate, that submission and the worker
both refuse while paid analysis is off or over the ceiling, no browser secret exposure, and the worker role.

To run it after explicit approval: set `GEMINI_API_KEY`, `PRISM_STUDIO_CONTINUITY_ANALYZERS=mock,gemini`,
`PRISM_STUDIO_ALLOW_PAID_ANALYSIS=true`, `PRISM_STUDIO_MAX_ANALYSIS_USD_PER_RUN=0.10` on the worker/app,
`npm run continuity:fixture -- --create`, run the analysis from the Continuity page, run
`npm run continuity:worker -- --until-idle`, then set the flag back to `false` and
`npm run continuity:fixture -- --remove`.
