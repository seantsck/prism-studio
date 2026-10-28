# Temporal Video QA (Phase 3A.3)

Phase 3A.1 asked whether a Shot appears to match production truth. Phase 3A.2 made that QA automatic. Phase 3A.3 asks
the questions a still frame cannot answer:

> Did the requested motion, blocking and action actually happen through time, and where in the video did Prism see
> the evidence?

QA stays **advisory**. An analyzer never approves, rejects, retries, regenerates, marks Best, selects a Production
Frame or Location View, changes a Character Continuity Lock or touches an Episode Edit. People keep creative
authority.

**Status:** implemented with fake transports and a calibration harness. **Live calibration not yet successfully
completed:** the first live attempt (2026-10-28) got zero model answers (provider quota/infrastructure; see
[the incident record](#first-live-attempt-2026-10-28-provider-access-failure-not-an-evaluated-trial)).
Migration 0045 is **applied to hosted DEV and verified** (2026-10-28; see
[migration-policy](migration-policy.md)). Lip sync stays **unchecked**.

## One system, not a second one

Temporal QA is the existing continuity-analysis pipeline. Nothing parallel was built:

`ContinuityAnalysisProvider` (`modes()` = `image_set` | `direct_video`, `videoCapabilities()`) → `buildAnalysisPlan` →
frozen job snapshot + external-media manifest → continuity worker → `continuity_analysis_costs` → ordinary normalized
findings → 3A.1 Shot QA priority, human overrides and 3A.2 automation.

One run can contain **image-set batches** (identity, wardrobe, set, framing, lighting, Production Frame fidelity) **and
a direct-video batch** (only the criteria where time matters), under the same frozen run and job. A durable retry
resumes at the first incomplete batch and never re-sends a completed image or video batch.

## Providers (verified 2026-10-28)

| Provider   | Direct video                                                     | Why                                                                                                                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Gemini** | **First direct-video provider**                                  | The official docs list video input with timestamp-oriented understanding (MP4/WebM, inline for small clips, Files API for larger ones); static sampling defaults to 1 fps and a custom rate is set per video part (`videoMetadata.fps`, range (0, 24]) |
| **OpenAI** | **None** (`modes()` = `image_set`, `videoCapabilities()` = `[]`) | The GPT-6 model pages list video input as **Not supported**. The OpenAI Videos _generation_ endpoint is not video understanding. An OpenAI run judges still-image criteria; temporal criteria stay unchecked                                           |

The Gemini analyzer is now **version 2** (it was 1). The version is part of the analysis job identity, so a v1
(image-only) run of unchanged truth does not suppress a v2 run that can add temporal coverage.

## Who must say yes (no single switch is enough)

A direct-video batch is planned only when **all** of these hold:

1. **Server gate** `PRISM_STUDIO_GEMINI_DIRECT_VIDEO=1` (off by default).
2. The analyzer is Gemini, the model's verified record accepts **video**, a credential is present.
3. **Project full-video permission** `project_qa_policies.direct_video_allowed` (migration **0045**, default **false**).
4. The current QA subject is a **video** within Prism's bounds (see below).
5. The usual gates: Project per-run / 24-hour ceilings, the global per-run / rolling ceilings, active-job limit,
   transport-call and correction ceilings.

**Manual runs** also need the run's own **full-video acknowledgement**. The launcher discloses that the full delivery
video will be sent, plus the provider, model, duration, size, sampling rate, inline vs temporary provider file,
cleanup and the worst-case estimate. The spend checkbox alone does not enable submit.

**Automatic runs** need both `direct_video_allowed` and 3A.2's standing `external_media_allowed`. The Automatic
confirmation then says the full video may be sent without asking each time.

`direct_video_allowed` is never inferred from a credential, the semantic mode, `external_media_allowed` or a past
manual analysis. Migration 0045 gives every existing row `false`, so a Project that enabled Automatic in 3A.2
**does not** start sending full videos when 3A.3 code is deployed.

Without the permission, semantic QA still runs (image-set criteria); temporal criteria are planned `not_allowed` and
stay unchecked with "The Project has not allowed full-video analysis". Free deterministic QA is never blocked.

## The subject that is sent

Exactly what Shot QA considers current: the selected delivery master, else the provider primary output. Its asset id
and checksum are frozen in the input and manifest. The worker re-verifies the checksum before anything is sent; a
mismatch, a missing object or an unsupported format is an **infrastructure** failure, never a creative mismatch.

Prism-owned bounds, checked by the planner before any transport: MP4/WebM only, known duration, at most **30 s**
and **100 MB** (one constant shared by the planner and the worker), and a **recorded checksum**. A video without one
is never planned, and the worker refuses to send one (fail closed). Nothing is transcoded just to please a provider. An image output leaves temporal criteria unchecked
("The output is not a video").

## Sampling policy `shot-temporal-static-v1`

| Setting        | Value                                           | Reason                                                                                                                             |
| -------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Processing     | static (uniform)                                | Short Shots: predictable, auditable and calibratable. Agentic/dynamic navigation is not used                                       |
| Frame rate     | **4 fps** (`videoMetadata.fps`)                 | The documented 1 fps default can miss fast action; 250 ms spacing resolves a camera move, beat order or direction in a 3–10 s Shot |
| Inline vs file | inline ≤ 12 MB, else a temporary Files-API copy | Prism-owned, below the documented inline request limit                                                                             |
| Token estimate | ⌈s × fps⌉ × 300 + ⌈s⌉ × 32                      | Documented 258 tokens/frame (default resolution) rounded up, plus 32 tokens/s audio                                                |

The policy id and fps are frozen on every direct-video batch, so they are in the plan fingerprint and the job
snapshot. Whether 4 fps is enough for each criterion is a **calibration** question, not an assumption.

## Criteria (rules version unchanged)

`CONTINUITY_RULES_VERSION` stays **`3a.1`**. The temporal criteria already existed with the same expected truth,
severity and routing; only an analyzer's ability to judge them changed. Analyzer capability is not production truth,
so no run becomes "QA stale" because a better analyzer exists. Coverage is tracked separately.

| Criterion                                   | Capability       | Notes                                                                                                          |
| ------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `camera_movement`                           | `video_temporal` | Apparent frame motion; ambiguous motion is warn/unchecked, not an invented camera move                         |
| `action_continuity` (beats)                 | `video_temporal` | Observed order and approximate timing vs the frozen beat timestamps                                            |
| `screen_direction`, `eyelines`, `geography` | `video_temporal` | Within this one Shot only (cross-Shot continuity is 3A.4); unchecked when not visible enough                   |
| `forbiddenActions:*`                        | `video_temporal` | Fail only when observed (with its time); pass only after inspecting the whole clip                             |
| `lip_sync`                                  | `lip_sync`       | **Not declared by any adapter**: "Lip sync — unchecked: the temporal lip-sync analyzer is not yet calibrated." |

Identity, wardrobe, set, framing, lighting and Production Frame opening fidelity stay image-set (more precise, cheaper).

## Prompt, schema, evidence

- Prompt **`continuity-gemini-video-v2`**: a dedicated temporal instruction. It covers production text as data,
  media-injection resistance, fictional characters only, the whole clip, no inferred events, the camera/beat/staging
  rules, the forbidden-action rule, no severity/approval/score, and no frame-accurate claims. `video-v1` (dormant,
  architecture-era) only appears on historical runs.
- Schema **2** (`ANALYSIS_SCHEMA_VERSION`): direct-video evidence is `{ input, timestampMs, endMs | null,
observation }`. Validation is strict:
  - evidence must cite the video that was sent;
  - integers only, `0 ≤ timestampMs ≤ duration`, `timestampMs ≤ endMs ≤ duration`. Both ends are **closed** by
    decision: the recorded duration is the clip's final instant, and provider timestamps are only as precise as the
    sampling interval, so an event in the last sample may be reported at the duration itself. Anything past it is
    rejected;
  - every pass/warn/fail answer needs at least one timestamped video evidence item.

  A still-image answer can never carry `endMs`, a timestamp on a reference or contact sheet, or a frame time other
  than the frame's own. Severity, approval and score keys are rejected. A violation uses the run's single correction,
  then fails visibly. Schema-1 runs are read as they are; nothing historical is rewritten.

- `RUBRIC_VERSION` stays `continuity-rubric-1`: the result meanings (pass / warn / fail / unchecked) did not change.
- Evidence lives in the existing JSON (`continuity_findings.evidence.items[].endMs`); no SQL change was needed.

**Precision:** times are shown as approximate (`≈ 00:01.0–00:02.5`), never as frame numbers. Clicking evidence seeks
the existing output player to the moment or interval start (`SeekButton`); no new player.

## Review surface

- Each run gets a **Temporal Video QA** line: `N evaluated · M unchecked`, with the reason for each unchecked
  criterion (server disabled, Project permission missing, analyzer has no video, output not a video, lip sync not
  calibrated, not enough visible evidence). "Evaluated" never means "passed".
- The manifest states whether the **full output video** was sent (asset, checksum) or why not.
- Temporal FAIL/WARNING findings feed the same 3A.1 issue ordering and rejection-reason **suggestions**. There is
  no temporal score and no automatic rejection.

## Provider files

A video over the inline limit becomes a **temporary** Gemini Files-API copy:

- The upload is an outbound request: it is counted against the run's transport ceiling **before** it happens, and a
  refused count uploads nothing. Events record `kind=upload` separately from `kind=analysis` and `kind=correction`.
  The SDK's status polls while the file is PROCESSING (`files.get`) and the cleanup delete are free metadata calls;
  they are not counted.
- **Upload failure is classified honestly.**
  - A confirmed 429/503 means the provider refused it: the job is requeued with backoff, and the retry uploads again
    (counted again).
  - A rejected upload (401/403/4xx) fails visibly.
  - A **timeout, network failure or 5xx is ambiguous** (`outcome_unknown`, `video_upload_outcome_unknown`). The bytes
    may have reached Gemini, and a temporary file may exist whose name Prism never received, so Prism cannot delete
    it; Gemini deletes it automatically after 48 hours. It is never retried automatically and never reported as
    "nothing was sent". No analysis request follows a failed upload, so it adds no analysis cost.
  - If the file was created but never became ACTIVE (or polling failed), the transport deletes it best-effort before
    reporting the failure.
- **Upload succeeded, then generate got a confirmed 429/503:** the file is deleted before the job is requeued. The
  retry uploads a fresh copy, both uploads count against the ceiling, and completed batches are never re-sent.
- Only the provider file name is recorded (job `provider_files`); never the URI, bytes, a signed Prism URL or a
  credential. The copy is never canonical media.
- It is deleted best-effort after the analysis. A failed delete is recorded as `cleanup_failed`, stays visible, and
  never rewrites the result or triggers a re-upload.
- **Durability limit (accepted, documented):** the file name is held in the worker's memory and recorded only at
  cleanup. If the worker dies between upload and cleanup, the reclaimed job finds `provider_state = sending` and fails
  `outcome_unknown` (nothing is re-sent). That temporary copy is not deleted by Prism and remains until Gemini's
  automatic 48-hour deletion. Prism does not claim crash-safe cleanup.

## Cost

Same ledger (`continuity_analysis_costs`) and gates as 3A.2. The pre-request worst-case estimate (frames at the frozen
rate plus audio, plus one correction re-sending the input) is the spend-gate ceiling. Actual cost comes only from
provider usage metadata; missing usage is UNKNOWN, never zero. Full-video permission bypasses no spend gate.

## Automatic orchestration (3A.2) and coverage

The automatic semantic identity is the existing job idempotency key with the stable nonce, which already names
analyzer id, **version** and model. 3A.3 adds a coverage flag `temporal` **only** when the analysis would plan the
full video, so every image-only key is exactly what it was in 3A.2. Consequences:

- A Gemini v1 image-only run of unchanged truth: the v2 analysis is new coverage, queued **once**.
- The owner allows the full video: one new temporal-capable run; repeats dedupe.
- The owner turns it off again: the image-only analysis of that truth already exists, so nothing new is queued and
  no video is sent. Existing jobs are never changed.
- Older runs are **not** marked stale: they remain a truthful record ("these temporal criteria were unchecked").

## Calibration (required before production capability claims)

`src/continuity/calibration/temporal-calibration.ts` (`temporal-calibration-v1`) holds the calibration set:

- **Fixtures.** 16 deterministic synthetic clips rendered by ffmpeg (no copyrighted footage, no real person):
  - camera pan right, plus a reverse control and a static control;
  - left→right direction plus a reverse;
  - eyeline: a face proxy whose pupil faces the target, plus a control where it turns away at 2 s;
  - beats in order, reordered, omitted;
  - forbidden action occurring at 2–3 s, plus an absent control;
  - geography kept and swapped;
  - lip-sync readiness: an abstract mouth proxy with a pulsed tone, synchronised and offset by 400 ms.
- **Pre-registered acceptance**, fixed before any live call: 3 trials per fixture. A criterion is usable only if every
  fixture is answered correctly 3/3, and event fixtures cite evidence inside their window, widened on each side by
  750 ms (250 ms sampling precision and 500 ms slack). `unchecked` and errors never count.
- **Strict grading** (tightened in the 3A.3 technical review, BEFORE any live call). Every conflict fixture is
  deliberate and unambiguous, so only `fail` is correct for it; `warn` ("possible deviation") is not definitive enough
  to claim a production capability. On a pass fixture, `warn` is also wrong, which catches a hallucinated "possible"
  forbidden action.
- **Unknown cost blocks.** Every fixture's estimate must be a finite, non-negative number before it is summed (no
  `|| 0`), and the request and dollar ceilings must themselves be valid. Otherwise the run is refused before anything
  is sent.
- **Harness.** One request per fixture per trial, no corrections, no retry (the SDK's own retry is off:
  `retryOptions: { attempts: 1 }`). The request count and worst-case dollars are checked against hard ceilings
  **before** anything is sent.
- **Run control** (`CALIBRATION_RUN_CONTROL`, fixed before the next live run; it changes when a run stops, never how
  an answer is graded):
  - the **first HTTP 429 aborts** the run. The project cannot complete the trial set at this schedule, and
    continuing only adds correlated missing trials under rate pressure. A 429 is labelled `quota_or_billing_exhausted`
    only when the provider's message says so, otherwise `quota_or_rate_limit`. The production worker is unchanged: it
    still requeues a 429 durably;
  - a single 500/503 is an error trial (not retried); **3 consecutive 5xx abort** the run as provider-unavailable;
  - an aborted run still writes its partial report (status, abort reason, HTTP status, sanitized message, the trials
    done, the unattempted count, request counters, cost status) and the CLI exits 3. Every criterion of an aborted run
    reads "NOT ACCEPTED — calibration incomplete", which is distinct from "model answered incorrectly" and from
    "provider errors (no answer)".
- **Cost honesty.** The report counts analysis, upload and correction attempts and the calls that reported usage.
  `actualUsd` is `0` only when no generation request left Prism, the provider's figure only when **every** generation
  attempt reported usage, and otherwise `null` (UNKNOWN: a 429/5xx/timeout without usage may or may not be billed).
  `knownUsageUsd` is the lower bound from the calls that did report usage.

CI runs it with the fake transport (`src/continuity/__tests__/temporal-calibration.test.ts`). The unit suite proves:

- a truthful oracle passes, and an "always pass" analyzer is caught;
- `warn` on a conflict fixture is not correct;
- the ceilings, or an unknown estimate, refuse before sending;
- the run-control rules: 429 fail-fast, 5xx, the partial report, UNKNOWN cost for missing or mixed usage, and zero
  only when nothing was sent;
- pacing (with an injected clock, so nothing waits) and the quota preflight.

`gemini-sdk-transport.test.ts` drives the real SDK over a stubbed fetch and proves one request per call for 429, 500,
503 and a timeout.

`temporal-calibration-cli.test.ts` proves the CLI's order of checks. It covers every live refusal: the
acknowledgement, the env flags, the model, the ceilings, each readiness requirement and the credential. Each refusal
exits 2, names the failed requirement, and happens **before** the network transport exists. No transport factory
call, no SDK client, no request. The CLI logic lives in `src/continuity/calibration/temporal-calibration-cli.ts`; the
script only injects the real SDK transport.

### First live attempt (2026-10-28): provider access failure, not an evaluated trial

The run used `temporal-calibration-v1`, `gemini-3.8-flash`, analyzer v2, prompt v2 and 4 fps, with 48 planned
requests, a $1.25 ceiling and a $1.018092 worst-case estimate.

- **What happened:** all 48 attempted requests returned provider errors: **40 × HTTP 429** ("You exceeded your current
  quota, please check your plan and billing details"), **4 × 503** and **4 × 500**. There were **zero model answers**
  and no evaluable evidence. No usage metadata came back, so the **actual cost is unknown**.
- **What it means:** there is **no model-quality conclusion**. The fixtures, truth labels, windows, trials and
  threshold remain valid and unchanged, because no model output was seen, and `temporal-calibration-v1` stands.
- **What happened next:** there was no rerun. Only synthetic clips were sent. The harness was remediated as described
  above before any new paid gate: UNKNOWN cost, 429 fail-fast, partial abort report, and live pacing with a quota
  preflight.

### Live calibration gate (needs separate authorisation)

#### Operator readiness (before authorisation)

Check these in **Google AI Studio** for the **same project** that backs `GEMINI_API_KEY`. Gemini limits are per
project, not per key, and Prism cannot read them from a key. Prism never changes billing, keys, projects or quotas.

- The project is available.
- An active billing account is linked (paid tier).
- The usage tier is appropriate.
- `gemini-3.8-flash` has nonzero active limits, and its **RPM**, **TPM** and **RPD** are known.
- Today's **remaining** requests cover the 48-request plan.
- No project **spend cap** blocks the plan.
- Any prepaid balance requirement is satisfied.

Record these for the gate:

```
PROJECT TIER:
MODEL RPM LIMIT:
MODEL TPM LIMIT:
MODEL RPD LIMIT:
PROJECT SPEND CAP:
BILLING ACTIVE: YES/NO
```

A one-request connectivity check, if it is ever authorised, is not a calibration trial. It must not use a v1 fixture,
and it never replaces any of the 48 observations.

#### Command

```
PRISM_STUDIO_TEMPORAL_CALIBRATION_LIVE=1 PRISM_STUDIO_ALLOW_PAID_ANALYSIS=1 \
npm run continuity:temporal:calibrate -- --live --model gemini-3.8-flash \
  --max-calls 48 --max-usd 1.25 \
  --max-rpm <RPM> --max-tpm <TPM> --max-rpd <RPD> --confirm-rpd-remaining \
  --billing-active yes --project-tier "<tier>" --spend-cap "<cap or none>" \
  --i-understand-this-sends-synthetic-video-and-costs-money --out <report.json>
```

- **Scope:** exactly the 16 fixtures × 3 trials = 48 generate requests (inline clips, no uploads). The plan is never
  shrunk to fit a quota.
- **Readiness is required:** every limit, the RPD-remaining confirmation, `--billing-active yes`, the tier and the
  spend cap. Without them the run is refused before anything is sent.
- **Pacing:** generation requests start no faster than `floor(RPM × 0.8)` per minute, start to start. Pacing never
  changes media, prompt, grading or sampling, and never retries.
- **Preflight before any request:**
  - planned requests ≤ `--max-calls`;
  - worst-case estimate ≤ `--max-usd`;
  - planned requests ≤ RPD;
  - worst-case tokens per minute ≤ TPM. This is the largest request's estimated input tokens plus its output ceiling,
    multiplied by the paced requests per minute.
- **Ceilings:** at most 48 transport calls; the worst-case estimate is ≈ $1.02 at the current price table. Only
  synthetic clips leave Prism.
- **Checks:** provider files are cleaned up (none are expected for inline clips). The report records the run status,
  results, request counters, the pacing plan, the estimate, and the actual cost or UNKNOWN.
- **Decision:** `video_temporal` stays declared only if all six video criteria (camera movement, screen direction,
  eyelines, action beats, forbidden actions, geography) are accepted. `lip_sync` is declared
  only if the lip-sync fixtures are accepted; until then `GEMINI_LIP_SYNC_CALIBRATED = false`.

## Pre-paid validation

`npm run continuity:pre-paid:check` (network trapped, nothing sent) also reports:

- the direct-video gate state and that the model accepts video;
- the video is in the frozen plan with consent and absent without it;
- the estimate covers at least the documented per-frame and audio cost;
- the paid-analysis gate blocks it;
- zero outbound requests.

## Migration 0045 (applied to hosted DEV)

`alter table project_qa_policies add column direct_video_allowed boolean not null default false`. No new table, no
grant or revoke, no policy change (owner-only RLS on the table is unchanged; `anon` and both worker roles still have no
privilege). Forward-only and now immutable; the applied 0044 is unchanged. On a database without 0045 the policy reads
full-video permission as `false`; saving `true` reports that 0045 is needed, and saving `false` works.

Hosted gate (2026-10-28): rehearsed with `--dry-run` (rolled back), applied with checksum
`44cc9360b867cc1d30b5fa8d758eca311f56b01d3485bb100d235c87d265d325`; every existing policy reads `false`; on a
disposable Project the owner can set and clear the permission (revisioned, stale revision refused) while a stranger and
`anon` can neither read nor change it; the generation and continuity workers cannot read the policy; hosted browser E2E
40/40. The permission is **off** on every real Project, and the server direct-video gate stays unset.

## Versions

| Identity                   | Before                       | After                        | Why                                                           |
| -------------------------- | ---------------------------- | ---------------------------- | ------------------------------------------------------------- |
| `CONTINUITY_RULES_VERSION` | `3a.1`                       | `3a.1`                       | Criteria, expected values, severity and routing are unchanged |
| Gemini analyzer version    | `1`                          | `2`                          | Production temporal capability; new coverage identity         |
| Direct-video prompt        | `continuity-gemini-video-v1` | `continuity-gemini-video-v2` | New temporal instruction and evidence contract                |
| `RUBRIC_VERSION`           | `continuity-rubric-1`        | `continuity-rubric-1`        | Result meanings unchanged                                     |
| `ANALYSIS_SCHEMA_VERSION`  | `1`                          | `2`                          | Interval evidence (`endMs`) and duration-bounded timestamps   |
| Migration head             | `0044`                       | `0045` (hosted DEV)          | Explicit full-video consent                                   |
