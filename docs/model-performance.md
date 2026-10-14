# Model performance (Phase 2E)

Performance is **derived from human reviews**, recomputed on demand and never persisted: an aggregate would go stale
and hide how it was built. It is a personal, per-project sample, not a benchmark, and the UI says so.

## Inputs

For every attempt of the project (`listOutcomeRecords`): its current human decision and reasons, whether it won its
set, actual and estimated cost, timestamps, status/failure category, and the **shot feature profile derived from the
attempt's frozen package** (nothing is stored twice).

## Shot feature profile

`ShotFeatureProfile` uses structured Prism data only (no AI, nothing subjective): character count bucket, dialogue,
performance audio, duration bucket (<3, 3–6, 6–10, >10 s), shot size, camera movement (static/moving/unspecified),
interior/exterior, day/night, recurring character (has identity references), reference count, wardrobe and location
continuity needs, production ratio and whether it is a non-standard ratio.

Two shots are _similar_ when ≥ 4 of 5 key features match (character count, dialogue, duration bucket, shot size, camera
movement). The "By shot type" table groups by characters · shot size · dialogue.

## What is reported (per model, by shot type, by provider)

Reviewed · good · shortlisted · rejected · preferred wins · in sets vs standalone · common rejection reasons ·
common strengths · average and median actual cost · median generation time and total time · positive reviews per $10
· preferred wins per $10 · average cost per positive review · **spend on rejected candidates** (the cost of
exploring, not a judgment) · count of generations with unknown cost.

Latency honesty: _generation_ = job `submitted_at` (accepted by the provider) → `completed_at` (output ingested);
_total_ = job `created_at` → `completed_at`. The provider-reported completion instant is not stored separately, so
"ingested" and "completed" coincide.

## Benchmark / fixture data is separate

Records from a project classified `is_benchmark` carry `benchmark: true`. Every aggregate (`aggregateByModel`,
`…ByModelAndBucket`, `…ByProvider`) takes a scope that **defaults to production**, so benchmark reviews can never leak
into production statistics, approval rates or recommendations by accident. A benchmark project's own Models page shows
its data with a **TEST / BENCHMARK DATA** banner (scope `benchmark`); the data is real and still useful for exercising
the tooling.

## Small samples are labelled

| Reviews | Reliability | Wording                                  |
| ------- | ----------- | ---------------------------------------- |
| 0       | none        | No reviewed generations yet.             |
| < 3     | very low    | an anecdote, not a trend                 |
| < 10    | low         | a hint, not a measurement                |
| ≥ 10    | moderate    | still a personal sample, not a benchmark |

Unknown costs are never filled with estimates: quality-per-dollar uses known spend only and is `—` otherwise.

## Health (informational)

For generation models: not configured, disabled, unavailable, rate limited, recent provider failure, recent success,
configured (no history = availability unknown). It never routes, switches or disables a paid model.

Code: `src/domain/generation/{performance,outcomes,model-health}.ts`; UI: `/projects/<slug>/models`.
