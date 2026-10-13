# Roadmap

## Phase 1 — planning / performance / storyboard / animatic _(implemented)_

| Slice | Delivered                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1A    | Domain, in-memory repository, seeded demo, Perform / Shot Prep / Storyboard / Animatic, preflight, generation package v1, attempt log.                                                                                                                                                                                                                                                  |
| 1B    | Postgres schema (0001–0005), `PostgresRepository`, guarded DB tooling, seed, migration runner.                                                                                                                                                                                                                                                                                          |
| 1C    | Supabase Auth + RLS-bound repository, private Storage bucket and signed-URL reads, asset library with where-used and delete protection, server-side audio analysis and waveforms, take archiving, explainable timeline, animatic player with audio clock, script action blocks + coverage + Breakdown, freshness fingerprints, package v2, migration checksums, inline action feedback. |

Details: [architecture](architecture.md), [persistence](persistence.md), [auth](auth.md), [storage](storage.md),
[production-workflow](production-workflow.md).

## Known gaps (Phase 1)

Stated plainly; none of these are implied to exist elsewhere in the docs.

- **Signed-in browser flow and live Storage upload need a test account password.** `test:e2e:supabase` skips the
  signed-in test without `PRISM_STUDIO_TEST_PASSWORD`; until it has run, upload through the real session is
  unproven end to end.
- **Storage was validated at the policy level (SQL), not through the Storage HTTP API** in the environment
  where it was built (`db:rls` exercises `storage.objects` policies under the RLS preamble; bucket
  configuration is checked by `db:validate`).
- **Cached readiness columns were removed, not maintained.** `prep_score` / `ready_to_generate` were dropped in
  0004; readiness is recomputed on every read (cheap today; revisit if project size demands caching).
- **Waveform decode of exotic codecs falls back to metadata-only** (no waveform, `waveformStatus: "unavailable"`).
  Decoding is in-process pure JS, not ffmpeg ([asset-lifecycle](asset-lifecycle.md)).
- **No script creates the dev Auth user**; create it in the Supabase dashboard and put its UUID in
  `PRISM_STUDIO_DEV_USER_ID`.
- **No Supabase CLI local stack**; one shared remote project is the only database environment
  ([local-supabase](local-supabase.md)).
- **Migrations 0001–0005 are baselined, not proven** equal to what was first executed
  ([migration-policy](migration-policy.md)).
- **Security gaps**: no rate limiting, no CSP, no malware scanning, no DB TLS certificate verification,
  single-owner model ([security-model](security-model.md)).
- **Account management** (sign-up, reset, MFA) is outside the app.
- **Script coverage is link-based** and does not gate preflight ([script-coverage](script-coverage.md)).
- **Animatic**: no export, no motion/ambience/music playback ([animatic](animatic.md)).
- **No real provider is integrated** (Phase 2A adds the infrastructure and a Mock provider; see below).
- **Playwright coverage** is a smoke + workflow set (memory mode) plus one signed-in flow, not exhaustive.
- **No server action exists to create or edit a Prop's own record** (only shot-level prop selection,
  `saveShotProps`); props come from the seed.

## Phase 2 — generation

| Slice  | Scope                                                                                                                                                                                       | Status      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **2A** | Provider-independent generation domain, capability + compatibility engine, PromptPlan, attempt/job split, Postgres queue + worker, output ingestion, review, cost records, **MockProvider** | implemented |
| 2B     | First production image / video / voice adapters (official APIs only, verified against current docs, opt-in live tests)                                                                      | next        |
| 2C     | Automated continuity QA on outputs (vision checks linked to `attempt_id`)                                                                                                                   | hooks only  |
| 2D     | Model routing / recommendations (capability + cost + history aware)                                                                                                                         | —           |
| 2E     | Cost and budget intelligence (per shot / episode / project)                                                                                                                                 | —           |

Phase 2A details: [generation-architecture](generation-architecture.md), [generation-jobs](generation-jobs.md),
[provider-contract](provider-contract.md), [adding-a-provider](providers/adding-a-provider.md),
[generation-review](generation-review.md).

Still open in Phase 2 scope: voice adapters populate `performance_takes` (`generated_voice`); provider
webhook endpoints (architecture only); realtime push instead of status polling; collaboration and sharing.

### Known gaps (Phase 2A)

- **No real provider adapter.** Only the Mock provider executes; nothing here has been exercised against a paid API.
- **Worker storage credential for Supabase is not provisioned.** Live ingestion into Storage was verified through
  the dev test-credential path; production needs `PRISM_STUDIO_WORKER_SERVICE_KEY` on the worker host.
- **Status updates poll** Prism's own endpoint (1.5 s while active); no push.
- **`maxConcurrency` per model is declared but only advisory**; the worker bounds total concurrency.
- **Submission TOCTOU window**: the package is built from a fresh read and `shots.updated_at` is verified inside
  the transaction, but changes to a Look/take/location between read and insert are not re-verified (the frozen
  package and fingerprint still describe exactly what was sent).
- **Memory mode** runs the worker in-process; there is no cross-process queue without Postgres.
- **Mock outputs are fixtures** (a 5 s 192×108 clip regardless of requested duration).

## Phase 3 — continuity vision QA

- Automated continuity QA: vision-model checks compare outputs to identity refs, Looks, set references and
  previous shots.
- Results stored as `continuity_checks(kind='automated')`, scores per dimension, issues with frame timestamps.
- Preflight gains post-generation rules; rejection reasons auto-suggested.

## Phase 4 — persistent 3D sets + virtual cameras + blocking

- React Three Fiber set editor attached via `locations.set3d`.
- Camera rigs and blocking markers replace abstract `spatial.marks`; 3D previews become
  `storyboard_frames(source='3d_preview')`.
- Light rigs feed `lighting` and the generation package.

## Phase 5 — rough-cut editor / audio / captions / NLE export

- Promote the animatic to a rough-cut timeline with approved generations replacing frames.
- Audio tracks (dialogue, ambience, music), captions from dialogue lines and translations, EDL/XML (NLE) export.

## Phase 6 — automatic model routing and production agents

- Route shots to models by modality, constraints, cost and historical approval rate.
- Agents propose breakdowns, shot lists, performance directions; humans approve through the existing gates.
