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
  signed-in test without `PRISM_STUDIO_DEV_USER_PASSWORD`; until it has run, upload through the real session is
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

| Slice    | Scope                                                                                                                                                                                                                                                                                 | Status                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **2A**   | Provider-independent generation domain, capability + compatibility engine, PromptPlan, attempt/job split, Postgres queue + worker, output ingestion, review, cost records, **MockProvider**                                                                                           | implemented                  |
| 2B       | Least-privilege worker + first real provider (Runway Gen-4.5), live-spend gate; live smoke test passed                                                                                                                                                                                | implemented                  |
| **2C**   | Framing adaptation plan, provider-canvas planning + crop overlay, deterministic delivery conform (ffmpeg), derived-asset lineage, delivery masters, continuity QA foundation + Mock analyzer                                                                                          | implemented                  |
| **2D**   | Real multimodal continuity analyzer: queued analysis jobs + dedicated worker role, Gemini adapter, strict evidence schema, analysis spend gate + ledger, evidence UI; live Gemini inference attempts returned sustained provider 503 (no analysis produced)                           | implemented                  |
| **2D.1** | Second real analyzer: OpenAI (`gpt-6-luna`, Responses API, Structured Outputs) behind the same provider contract; model registry; informational provider health; no live OpenAI call yet                                                                                              | implemented (fake transport) |
| 2D.2     | Live OpenAI smoke (explicit approval) + direct-video temporal QA refinement, calibration on real runs                                                                                                                                                                                 | next                         |
| **2E**   | Multi-model production + human quality intelligence: model catalog (6 Runway video models), shot-specific fit matrix, candidate sets, side-by-side compare, fast human review, model performance history, deterministic recommendation v1 (advisory); AI continuity QA stays optional | implemented                  |
| 2E.1     | Model catalog hardening (documented duration ranges, pre-provider duration enforcement), benchmark/test project purpose enum (0029), operational provider reliability kept separate from creative quality, failed-candidate review guard; Kling blocked by the SDK, documented        | implemented (local)          |
| 2E.2     | Second real candidate set at 5 s on a disposable fixture (explicit approval); calibration of the recommendation weights on real reviews                                                                                                                                               | next                         |
| 2E-old   | (superseded) Multi-model generation routing + attempt comparison (capability + cost + history + continuity aware)                                                                                                                                                                     | —                            |
| 2F       | Production editor/timeline; delivery-master consumption; project budgets and cost intelligence                                                                                                                                                                                        | —                            |

Phase 2A details: [generation-architecture](generation-architecture.md), [generation-jobs](generation-jobs.md),
[provider-contract](provider-contract.md), [adding-a-provider](providers/adding-a-provider.md),
[generation-review](generation-review.md).

Still open in Phase 2 scope: voice adapters populate `performance_takes` (`generated_voice`); provider
webhook endpoints (architecture only); realtime push instead of status polling; collaboration and sharing.

### Phase 2F M2D — free local reconstruction of Locations

| Milestone   | Scope                                                                                                                                                                                                                                       | Status                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| M2D.3A      | Local engine: photographs → COLMAP 4.2.1 (verified build) → Brush 0.3.0 → validated PLY → SPZ ([local-reconstruction](local-reconstruction.md))                                                                                             | implemented (fake tools)                                        |
| M2D.3B      | Same-host durable worker (`local_capture`)                                                                                                                                                                                                  | implemented (fake tools)                                        |
| M2D.3C1     | Paired remote Local Agent identity and control plane ([local-agent-protocol](local-agent-protocol.md))                                                                                                                                      | implemented                                                     |
| M2D.3C2     | Remote distributed execution (`local_agent_capture`): lease, source relay, signed result, shared ingestion                                                                                                                                  | **complete** (implementation validated; not production enabled) |
| **M2D.3D1** | Production readiness + real-tool acceptance harness: readiness check, hardware policy, REAL_SMOKE/REAL_ROOM, report, human checklist, Spark render check, hosted-security gates ([reconstruction-acceptance](reconstruction-acceptance.md)) | **in progress** (no real tool run)                              |
| M2D.3D2     | First real reconstruction: verified native tools → real room photographs → real COLMAP/Brush → real SPZ → Spark render → Prism Location → human filmmaking acceptance                                                                       | next (needs a PRACTICAL machine and approval)                   |

Local Capture is not production-ready until the three acceptance gates pass: A hosted security (dedicated relay key,
edge rate limiting, lease ids out of access logs), B real toolchain, C real reconstruction judged by a human.

### Known gaps (Phase 2A)

- **No real provider adapter.** Only the Mock provider executes; nothing here has been exercised against a paid API.
- **Worker storage credential for Supabase is not provisioned.** Live ingestion into Storage was verified through
  the dev test-credential path; production needs `PRISM_STUDIO_WORKER_SERVICE_KEY` on the worker host.
- **Status updates poll** Prism's own endpoint (1.5 s while active); no push.
- ~~`maxConcurrency` per model is advisory.~~ **Enforced for billing models in Phase 2B** (see known gaps).
- ~~Submission TOCTOU window~~ **Closed (post-review).** `projectRevision()` (a digest of every package input row)
  is read before the project is loaded and re-verified inside the submit transaction (`stale_package`).
- ~~Worker DB role is broad.~~ **Closed in Phase 2B:** least-privilege role, see docs/generation-jobs.md.
- ~~Ingestion not crash-idempotent.~~ **Closed in Phase 2B:** deterministic output ids/paths; a retry reuses the
  object already uploaded (see docs/providers/runway.md, `ingest-crash.test.ts`).
- **Exactly-once remote submission is not guaranteed.** Providers that declare `idempotency` receive the same key
  on every re-submit. For providers that do not, an ambiguous failure fails the job (`submission_outcome_unknown`)
  rather than risk a second paid generation.
- **Memory mode** runs the worker in-process; there is no cross-process queue without Postgres.
- **Mock outputs are fixtures** (a 5 s 192×108 clip regardless of requested duration).

### Known gaps (Phase 2B)

- **No live Runway call has been made.** Everything is verified against the SDK types and a fake at the SDK
  boundary; the first paid smoke test needs explicit approval of the spend (docs/providers/runway.md).
- **Failed/cancelled Runway tasks record cost as unknown** even when Runway returns credits.
- **Per-model concurrency across several worker processes is best effort** (single process is exact; Runway
  `THROTTLED` is the backstop).
- **Runway output host allow-list uses `*.cloudfront.net`**; extend/tighten with `PRISM_STUDIO_RUNWAY_OUTPUT_HOSTS`
  once the live output host is observed.
- **Provider-confirmed cancellation still has a look-then-delete window** (Runway offers no conditional delete).
- **Worker DB credential must be provisioned per environment** (`worker:db:provision`); `db:worker-role` proves the
  role with SET ROLE, the connect-as-worker section of `worker:db:check` needs `PRISM_STUDIO_WORKER_DB_URL`.

### Known gaps (Phase 2C)

- **No real semantic analyzer.** Only the deterministic checks and the clearly-labelled Mock analyzer exist;
  identity/wardrobe/set/props/lighting remain `unchecked` until Phase 2D. Nothing calls an external AI.
- **ffmpeg is a runtime dependency** of the app server for conform and review frames (documented, detected,
  optional). Conform is synchronous and bounded; a long-running job queue/role is not built.
- **Only centre crops.** No subject-aware reframing; protected composition is manual notes, not computer vision.
- **No duration extension** (`generate_shorter_and_extend` is declared but unavailable); a provider output
  shorter than the trim target is reported, never stretched.
- **Mock outputs are a fixed 192×108 / 5 s fixture**, so conform math is exercised on that, not on a real 16:9
  1280×720 render (the unit tests cover the arithmetic at real sizes).
- **Delivery masters are selected per attempt, not yet consumed** by an editor/animatic (Phase 5).
- **QA staleness is computed on read** (per attempt page); the shot list shows the latest run's status, not its
  staleness.
- **One QA run's analysis is synchronous** in the server action; the schema supports queued/running/failed for
  a future background analyzer.

### Known gaps (Phase 2D)

- **One live provider analysis exists** (OpenAI `gpt-6-luna`, Run 5, 2 transport calls, $0.000502): the
  pipeline is proven end to end, but its two findings were UNCHECKED because the abstract fixture has no
  character. A semantic fixture (`continuity-semantic-test`: identity, black formal Look, red-jacket output) is
  prepared; the semantic smoke is **not yet run** (needs explicit approval). Gemini (`gemini-3.8-flash`,
  `gemini-3.6-flash`) still has no successful live inference: `generateContent` returned sustained 503
  overload while auth, model access and parsing were verified at zero cost; Prism's durable retry, accounting
  and ceilings behaved as designed ([continuity-costs](continuity-costs.md)).
- **Credential unverified**: no zero-cost verification call is made (none is documented as free).
- **Direct video is architecture only** (OFF by default; fake-transport tests; no live use). Temporal
  criteria stay unchecked until it is enabled and calibrated.
- **Batching is conservative**: criteria with different reference sets get separate requests (identity vs
  wardrobe), re-sending the output frames; merging would cut cost but blur which references judged which criterion.
- **Global spend ceilings only**; per-project budgets are a follow-up.
- **Two real analyzers are wired** (Gemini, OpenAI); multi-analyzer comparison is a per-attempt run table, not a
  benchmark, and there is **no automatic routing or failover** between providers (health is informational).
- **The continuity worker shares the project-wide Storage secret** with the generation worker (read-only use).
- **Auto-run after conform is intentionally absent.**
- **Mock outputs/frames are fixtures**, so semantic results in demo mode only demonstrate flow, not pictures.
- **Conform is still synchronous**; the analysis queue shape could carry media jobs later.

## Phase 3 — vision QA at scale (after 2D.1)

- Real analyzers (Gemini / OpenAI / Claude vision, face-identity, embedding models) behind the 2C contract.
- Preflight gains post-generation rules; rejection reasons auto-suggested from findings.

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

## Known gaps (Phase 2E)

- **One real candidate set has run** (1 of 3 succeeded; see [generation-candidate-sets](generation-candidate-sets.md)).
  It has no human review yet, so model history is still empty and recommendations are cold-start.
- **Capability unknowns are visible, not resolved:** Seedance 2.5's minimum duration (planned conservatively as 4 s),
  whether Hailuo can generate audio, the provider-side reference limit on the image-to-video route. The provider
  validates; a rejected request is free. Duration ranges for Gen-4.5, Gen-4 Turbo, Hailuo 3 and Veo are documented.
- **Kling 3.0 is documented by Runway but not typed by any published SDK** (4.21.0, 4.22.0), so it is not offered
  (`SDK_BLOCKED_MODELS`); other Runway-hosted models are one catalog entry each.
- **Reference video and reference-audio duration limits** are not enforced at planning (Prism sends reference
  images and performed audio only; video references are architecture-ready).
- **Recommendations are computed at each model's default options** and are project-local; weights are a first
  hand-set calibration, not fitted.
- **Synchronized playback is start/pause/seek/loop/solo**, not frame-locked: videos start together but can drift
  over a long loop. Same-position buttons seek every candidate to one fraction of its own duration.
- **Review frames are the extracted QA frames** (free deterministic run); until one exists the strip says so and the
  video same-position buttons still work.
- **Latency** records provider-accepted → ingested; the provider's own completion instant is not stored.
- **Model health is derived from attempts** (not probes); it never routes.
- **Standalone attempts can be reviewed through the same action** but the attempt card has no quick-review buttons yet.
