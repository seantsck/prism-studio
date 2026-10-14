# Model recommendation v1 (`model-routing-v1`)

Deterministic, advisory, explainable. **No LLM, no learned model, no opaque score, no automatic routing.** The user
always sees the selected model before anything is spent and can choose any model freely.

Code: `src/domain/generation/recommendation.ts`. Tests: `phase2e-intelligence.test.ts`.

## Output labels

| Label               | Meaning                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Recommended         | the single top-scoring model that is compatible, available and not a poor historical fit |
| Worth trying        | compatible, not the top                                                                  |
| Unknown             | capability facts the shot needs are missing (documentation does not state them)          |
| Poor historical fit | ≥ 3 weighted reviews and a shrinkage rate ≤ 0.35                                         |
| Incompatible        | the shot cannot be sent as it is (blockers listed)                                       |
| Not available here  | not configured / retired on this server: shown, never selectable                         |

Every label comes with **why / concerns**, the **sample** (similar shots, positives among them), and a **confidence**
(LOW < 3 weighted reviews, MEDIUM < 8, HIGH ≥ 8).

## The math

1. **Capability fit F ∈ [0,1]** from the fit matrix:
   `F = 1 − min(.30, .12·adaptations) − min(.20, .04·limitations) − refLoss − audioLoss − min(.10, .05·unknowns)`
   - `refLoss = (shot needs 2+ identity/Look refs ? .25 : .10) · (1 − used/total references)`
   - `audioLoss = .15` when the shot has performed audio the model cannot take.
2. **Human history H ∈ [0,1]**, a shrinkage estimate of the positive rate:
   value `v` = 1 (good/Best), 0.6 (shortlisted), 0 (rejected); unreviewed attempts do not count;
   weight `w` = 1.0 for a **similar** shot, 0.35 for the same model on another kind of shot;
   `H = (Σ w·v + K·P0) / (Σ w + K)` with prior `P0 = 0.5` and strength `K = 4`.
   One lucky 1/1 gives `H = 0.60`; a 20/25 record gives `≈ 0.76`: **one success never outranks a track record.**
3. **Reason penalty ≤ 0.15**: if this model's rejections concentrate on a reason that matters for THIS shot (identity
   for a recurring character, wardrobe, lip sync/dialogue audio, camera motion): `0.5 · count / (nEff + 4)`.
4. **Cost C ∈ [0,1]** among compared candidates: `1 − (est − min)/(max − min)`; unknown cost = 0.5.
5. **Score** `= wF·F + wH·(H − penalty) + wC·C`:

   | Preference    | wF  | wH  | wC  |
   | ------------- | --- | --- | --- |
   | Quality first | .35 | .55 | .10 |
   | Balanced      | .35 | .40 | .25 |
   | Cost first    | .30 | .25 | .45 |

   Ties break on lower cost, then model id (fully deterministic).

## Cold start

If the whole candidate pool has `Σ w < 3` (fewer than three similar-weighted reviews), H carries no information, so
its weight is dropped and F/C are renormalized. The panel says: _"Not enough Prism history yet. Recommendation based
mainly on model capabilities."_ Nothing is fabricated.

## Transparency and versioning

The Generate panel shows, per model: fit status, what it receives, historical column ("6/8 liked · 5 similar · low
sample"), cost and the label with confidence; the expanded row lists the reasons. When a candidate set is created
the recommendation (engine version, profile, per-model parts and reasons, recommended vs chosen) is **frozen on the
set**. Pages are not persisted on every render.

## Benchmark data never counts

Outcome records flagged `benchmark` (an explicit project classification, see [model-performance](model-performance.md))
are removed before any history is computed: a benchmark project's reviews are invisible to `model-routing-v1`, so a
fixture experiment cannot make a model look better or worse in production. A benchmark project itself is always
cold-start.

## Scope limits

- Project/account history only. No hidden global crowd model, no sharing outcomes between users.
- Recommendations are computed at each model's _default_ options (first tier, default input mode, no provider audio);
  the visible fit/cost reflect the options you select.
- Runway's own Model Router is not used as the recommendation engine (see [generation-model-catalog](generation-model-catalog.md)).
