# Continuity analysis jobs (Phase 2D)

Automated analysis is **durable asynchronous work**. A server action never calls an analyzer.

```
user clicks "Run automated analysis"
  → server action: plan + frozen input + manifest + estimate + SERVER-SIDE spend gate
  → one transaction: ContinuityRun (immutable history) + findings + ContinuityAnalysisJob (queued) + estimate + event
  → continuity worker (own process, own DB role): claim → analyse → normalized findings → cost → done
  → the page polls Prism's job status (never the provider)
```

## Run vs job (same separation as Attempt vs GenerationJob)

|            | `continuity_runs` (0021 + 0022)                                                                                             | `continuity_analysis_jobs` (0022)                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Nature     | immutable analytical history                                                                                                | mutable execution state                                                                                   |
| Holds      | subject, criteria + reference fingerprints, frozen reference set, **analysis plan, external manifest, prompt/rubric/model** | queue/lease/retries, provider interaction state, provider files, cost refs, the **frozen input snapshot** |
| May change | analysis status + review close-out only                                                                                     | status, lease, counters, provider state                                                                   |

The frozen `ContinuityAnalysisInput` contains ids, checksums, criteria (expected value, severity, source), media
roles, framing, analyzer/model/prompt/rubric/schema versions and the plan. **Never** signed URLs, bytes or
credentials (asserted by tests). Re-running creates a NEW run + job; earlier runs are never mutated.

## State machine

`queued → claimed → processing → succeeded | failed`, `claimed/processing → queued` (safe retry only),
`any active → cancel_requested → cancelled | failed | succeeded`, `queued → cancelled`. Mirrored in TypeScript
(`job-state.ts`) and a DB trigger; `db:continuity-analysis` compares all 42 ordered pairs.

## Queue mechanics (lessons from GenerationJob, no shared code to destabilise it)

- **Claim:** `FOR UPDATE SKIP LOCKED`, sets a per-claim `lease_token` and `lease_expires_at`.
- **Fencing:** every write checks the token; a worker that lost its lease changes nothing (`AnalysisLeaseLostError`).
- **Heartbeat:** extends the lease while processing.
- **Retries:** durable and bounded. Only provider answers proving nothing was processed (429/503) requeue, and
  never in a loop: the claim ends, `next_run_at` is persisted (15 s, 45 s, 120 s, 300 s, 600 s + jitter) and a
  later claim sends ONE new request. `transport_calls` (≤ 6 per run, corrections included) and `max_attempts`
  bound it; exhaustion is `provider_overloaded_retry_exhausted`.
- **Resume:** answered batches are persisted (`batch_results`, migration 0025); a later claim sends only what is
  unfinished, so nothing already answered is paid for twice.
- **No double spend:** `provider_state` goes `not_sent → sending → responded`; a job reclaimed while
  `provider_state = sending` (a request may be in flight) fails `outcome_unknown` instead of re-sending. A local
  guard that stops a call before the transport is invoked is `local_policy_block`, not `outcome_unknown`.
- **Exactly one result:** `finalizeSuccess` is one transaction (findings, run complete, final cost, job
  succeeded) and a duplicate finisher finds a final cost record and changes nothing.
- **Cancellation:** `queued` cancels locally (no request ever); a running job stops before its next request.
- **Spend gate at execution time:** the queue may predate a configuration change; the worker re-checks.
- **Limits:** ≤ 3 active analyses per project (`PRISM_STUDIO_ANALYSIS_MAX_ACTIVE_PER_PROJECT`).
- **Idempotency:** the submission key (subject + criteria + references + analyzer + model + rubric + page nonce)
  replays a double click instead of queueing a second paid job.

## The continuity worker

`npm run continuity:worker [-- --until-idle | --once | --dry-run]`. Connects as **`prism_continuity_worker`**
(`PRISM_STUDIO_CONTINUITY_DB_URL`); it refuses to start as any other role and never falls back to the admin
credential. In memory/demo mode the same worker loop runs in-process.

### Role (migrations 0022–0024; `db:continuity-analysis` proves it with the REAL login)

| CAN                                                                                       | CANNOT                                                                                    |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| claim/lease jobs; update execution columns of non-terminal jobs                           | create or delete jobs; change the frozen snapshot, run identity, model                    |
| read the frozen job + `assets` rows **named by an active job** (RLS on `input_asset_ids`) | read any other asset, project, shot, script, character, Look, bible, storyboard, location |
| update `analysis_status/_error/completed_at` of an active run                             | change a run's plan/manifest/fingerprints/subject (trigger)                               |
| update **result fields** of findings of a run still being analysed                        | create findings; change criteria/expected/severity; read **or write human overrides**     |
| append the **final** cost and events                                                      | write estimated costs; touch generation tables or approvals; DDL; TRUNCATE; create roles  |

`prism_generation_worker` has no access to any of these tables and vice versa. Both roles are NOINHERIT, not
superuser/BYPASSRLS, members of nothing. The worker reads the private bucket with the same worker Storage secret
as the generation worker (project-wide Storage access: a documented residual risk, mitigated by reading only
assets named in the frozen job and by never writing to Storage).

## Provisioning

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # → PRISM_STUDIO_CONTINUITY_DB_PASSWORD
npm run continuity:db:provision            # enables LOGIN (never printed); --rotate to replace
PRISM_STUDIO_CONTINUITY_DB_URL=postgresql://prism_continuity_worker.<ref>:<pw>@<session-pooler>:5432/postgres
npm run db:continuity-analysis             # privilege + queue proof
```

## Migrating media work (conform) later

Delivery conform still runs synchronously in the app server (bounded, user session). The same queue shape
(`claim` + lease + fenced writes + frozen input) would carry a `media_jobs` kind; it is deliberately not
generalised yet so the generation and analysis queues stay independent and cannot destabilise each other.
