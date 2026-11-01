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

| Slice    | Scope                                                                                                                                                                                                                                                                                                                                                                           | Status                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **2A**   | Provider-independent generation domain, capability + compatibility engine, PromptPlan, attempt/job split, Postgres queue + worker, output ingestion, review, cost records, **MockProvider**                                                                                                                                                                                     | implemented                   |
| 2B       | Least-privilege worker + first real provider (Runway Gen-4.5), live-spend gate; live smoke test passed                                                                                                                                                                                                                                                                          | implemented                   |
| **2C**   | Framing adaptation plan, provider-canvas planning + crop overlay, deterministic delivery conform (ffmpeg), derived-asset lineage, delivery masters, continuity QA foundation + Mock analyzer                                                                                                                                                                                    | implemented                   |
| **2D**   | Real multimodal continuity analyzer: queued analysis jobs + dedicated worker role, Gemini adapter, strict evidence schema, analysis spend gate + ledger, evidence UI; live Gemini inference attempts returned sustained provider 503 (no analysis produced)                                                                                                                     | implemented                   |
| **2D.1** | Second real analyzer: OpenAI (`gpt-6-luna`, Responses API, Structured Outputs) behind the same provider contract; model registry; informational provider health; no live OpenAI call yet                                                                                                                                                                                        | implemented (fake transport)  |
| 2D.2     | Live OpenAI smoke (explicit approval) + direct-video temporal QA refinement, calibration on real runs                                                                                                                                                                                                                                                                           | next                          |
| **2E**   | Multi-model production + human quality intelligence: model catalog (6 Runway video models), shot-specific fit matrix, candidate sets, side-by-side compare, fast human review, model performance history, deterministic recommendation v1 (advisory); AI continuity QA stays optional                                                                                           | implemented                   |
| 2E.1     | Model catalog hardening (documented duration ranges, pre-provider duration enforcement), benchmark/test project purpose enum (0029), operational provider reliability kept separate from creative quality, failed-candidate review guard; Kling blocked by the SDK, documented                                                                                                  | implemented (local)           |
| 2E.2     | Second real candidate set at 5 s on a disposable fixture (explicit approval); calibration of the recommendation weights on real reviews                                                                                                                                                                                                                                         | next                          |
| 2E-old   | (superseded) Multi-model generation routing + attempt comparison (capability + cost + history + continuity aware)                                                                                                                                                                                                                                                               | —                             |
| 2F       | **Optional spatial infrastructure**: 3D sets, camera motion, character blocking, control passes, Gaussian-splat Locations, free local reconstruction (M2A–M2D). Core complete; real GPU reconstruction acceptance (M2D.3D2) deferred / optional. **3D augments the image-first path; it never gates it**                                                                        | core complete                 |
| **2G**   | **Image-First Shot Studio** (GPU-optional): Production Frame core, image shot generator, location-view and character continuity, shot sequence board. Default filmmaking path: script → performance → Shot Prep → storyboard → Production Frame → image-to-video → edit                                                                                                         | **complete**                  |
| **2H**   | **Image-to-Video**: animate the selected, CURRENT Production Frame as the exact first frame (image-to-video only), reusing candidate sets, review, delivery conform and QA ([image-to-video](image-to-video.md))                                                                                                                                                                | **complete** (merged, PR #22) |
| **2I**   | **Timeline & Performance Assembly**: one persisted edit per Episode, Shot clips and the selected performances assembled deliberately ([timeline-performance-assembly](timeline-performance-assembly.md)); 2I.1A domain complete; 2I.1B persistence complete (migration 0043 applied to hosted DEV); 2I.1C read-only Edit page and 2I.1A–F complete (hosted acceptance in 2I.1F) | **complete** (merged, PR #24) |
| (later)  | Production editor/timeline; delivery-master consumption; project budgets and cost intelligence (the earlier 2F plan, see Phase 5)                                                                                                                                                                                                                                               | —                             |

Phase 2A details: [generation-architecture](generation-architecture.md), [generation-jobs](generation-jobs.md),
[provider-contract](provider-contract.md), [adding-a-provider](providers/adding-a-provider.md),
[generation-review](generation-review.md).

Still open in Phase 2 scope: voice adapters populate `performance_takes` (`generated_voice`); provider
webhook endpoints (architecture only); realtime push instead of status polling; collaboration and sharing.

### Phase 2F M2D — free local reconstruction of Locations

| Milestone   | Scope                                                                                                                                                                                                                                       | Status                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| M2D.3A      | Local engine: photographs → COLMAP 4.2.1 (verified build) → Brush 0.3.0 → validated PLY → SPZ ([local-reconstruction](local-reconstruction.md))                                                                                             | implemented (fake tools)                                                                     |
| M2D.3B      | Same-host durable worker (`local_capture`)                                                                                                                                                                                                  | implemented (fake tools)                                                                     |
| M2D.3C1     | Paired remote Local Agent identity and control plane ([local-agent-protocol](local-agent-protocol.md))                                                                                                                                      | implemented                                                                                  |
| M2D.3C2     | Remote distributed execution (`local_agent_capture`): lease, source relay, signed result, shared ingestion                                                                                                                                  | **complete** (implementation validated; not production enabled)                              |
| **M2D.3D1** | Production readiness + real-tool acceptance harness: readiness check, hardware policy, REAL_SMOKE/REAL_ROOM, report, human checklist, Spark render check, hosted-security gates ([reconstruction-acceptance](reconstruction-acceptance.md)) | **in progress** (no real tool run)                                                           |
| M2D.3D2     | First real reconstruction: verified native tools → real room photographs → real COLMAP/Brush → real SPZ → Spark render → Prism Location → human filmmaking acceptance                                                                       | **deferred / optional** (needs a PRACTICAL machine and approval; not on the filmmaking path) |

Local Capture is not production-ready until the three acceptance gates pass: A hosted security (dedicated relay key,
edge rate limiting, lease ids out of access logs), B real toolchain, C real reconstruction judged by a human.

### Phase 2G — Image-First Shot Studio (GPU-optional)

Prism Studio must not require a discrete GPU, COLMAP, Brush, a 3D reconstruction or a Gaussian splat to make a film.
Phase 2F stays valuable as **optional** spatial infrastructure that can help create a Production Frame. Core principle:
never ask a generation model to remember information Prism can store explicitly.

| Slice | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 2G.1  | **Production Frame core**: immutable per-Shot history + one selection pointer, private image Asset, origin/provenance, production aspect, frozen visual-intent snapshot, freshness, promotion from the approved Storyboard or an optional 3D Master Frame, upload, GenerationPackage v3, start-frame default ([production-frames](production-frames.md))                                                                                                                                                                             | **complete** (merged)                                                                                                |
| 2G.2  | **Image Shot Generator**: Production Frame candidates → multiple generated stills (Runway image models via one adapter, SDK 4.22.0, one image per attempt) → human compare/review → Use as Production Frame; no 3D requirement ([image-shot-generator](image-shot-generator.md))                                                                                                                                                                                                                                                     | **complete**: live smoke passed (3 Runway images, $0.10, no retries, all succeeded; Production Frame from a conform) |
| 2G.3  | **Location View Continuity**: immutable canonical Location Views (image + semantic view spec, no 3D), one view selection per Shot (same Location enforced in the database), part of the Shot's location truth, GenerationPackage v4, `location_view` image reference for Production Frame candidates, Production Frame → Location View ([location-views](location-views.md))                                                                                                                                                         | **complete** (merged); migration 0040 applied                                                                        |
| 2G.4  | **Character Continuity Locks**: immutable approved appearance per Character + exact Look (facts by value + frozen reference images, no bytes copied), one Lock selection per Shot Character assignment (same Character AND same Look enforced in the database; a Look change clears it), the Lock is authoritative identity / Look truth for generation, freshness and continuity QA references, GenerationPackage v5; no-Lock Shots unchanged ([character-continuity-locks](character-continuity-locks.md))                         | **complete** (merged); migrations 0041 + 0042 (fix-forward) applied                                                  |
| 2G.5  | **Shot Sequence Board**: the episode as a sequence of canonical stills (Production Frame first, truthfully labelled Storyboard fallback), Production Frame freshness, Location View and Character Continuity anchors, adjacent-cut transition facts (review aids, not failures), side-by-side cut review, within-Scene reorder, previous-Shot link mismatches and an explicit, previewed, atomic link sync that refuses locked Shots; a pure projection: no table, no package change ([shot-sequence-board](shot-sequence-board.md)) | **complete** (merged); no migration                                                                                  |

Phase 2G is complete: 2G.1 Production Frame Core, 2G.2 Image Shot Generator (complete and proven live), 2G.3 Location
View Continuity, 2G.4 Character Continuity Locks and 2G.5 Shot Sequence Board are merged.

**2H Image-to-Video** is complete (merged, PR #22): the selected, current Production Frame is the exact first frame of
the Shot's video ([image-to-video](image-to-video.md)); no migration, GenerationPackage stays v5. 3D augments the
image-first path; 3D does not gate it.

### Phase 2I — Timeline & Performance Assembly (complete)

Tracking issue #23. Architecture: [timeline-performance-assembly](timeline-performance-assembly.md).

| Slice    | Scope                                                                                                                                                                                                                                                                                                                                                                                                                     | Status                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2I.1     | **Timeline Foundation**: one persisted edit per Episode (explicit editorial order, contiguous items in integer ms with a rational edit rate), each item's picture named by kind (pinned generated clip or a labelled placeholder still), the selected performance referenced by take with sync offsets and trims, lineage, and staleness / replacement facts reported on read, never applied silently                     | **complete** (2I.1A–F)                                                                                                                                                   |
| 2I.1-pre | Prerequisite hardening (not timeline model): creative approval restricted to Shot-output attempts on the server (`reviewAttempt`)                                                                                                                                                                                                                                                                                         | **done**                                                                                                                                                                 |
| 2I.1A    | Pure domain (`src/domain/edit/`): edit rate, model + shape checks, source eligibility, initial assembly proposal, edit view (timing, Scene runs, currentness / replacement facts), lineage; unit tests                                                                                                                                                                                                                    | **complete** (pushed `e5f5061`; full unit 1638/1639: one accepted, unrelated, non-reproducible timing flake in `character-continuity-actions.test.ts`, not a clean pass) |
| 2I.1B    | Persistence: migration `0043_episode_edits.sql` (three tables, composite project-safe keys, source/placement triggers, removable one-per-Episode / one-per-Shot rules, deferred positions, owner-only RLS), `EpisodeEditRepository` memory + Postgres (shared op rules, expected-revision compare-and-set under `FOR UPDATE`), `db:episode-edits`, validate/behavior updates, `db:generation` approval-purpose regression | **complete**: 0043 applied to hosted DEV (approved); `db:episode-edits` 94/94, `db:validate` OK, `db:behavior` 49/49, `db:generation` 71/71; full unit 1661/1661         |
| 2I.1C    | Read-only Episode Edit page (`/episodes/<ep>/edit`): proposed initial assembly with explicit “Create edit” (stale-proposal key, concurrent create resolved), the saved edit with truthful source kinds, performance lane, currentness badges, Scene runs, lineage; Animatic link                                                                                                                                          | **implemented**: server tests + memory E2E (isolated server) pass; no editing controls yet                                                                               |
| 2I.1D    | Explicit editing on the Episode Edit page: source picker (any eligible clip, placeholders, none), Use replacement (exactly as shown), trim, hold, ↑/↓ reorder, add / remove Shots, take pinning, Silence, clip-audio policy; every change revision-checked with a clear conflict message                                                                                                                                  | **implemented**: server tests (real mock clips) + memory E2E pass; no migration                                                                                          |
| 2I.1E    | Rough-sequence playback of the saved edit (“Watch this edit”): one wall-clock master; pinned clips within their trims, still holds, no-picture intervals, pinned takes at their offsets (several per item), Silence, clip-audio policy; seek / pause / restart / end; missing media shown, never substituted; no render or export                                                                                         | **implemented**: controller tests + memory E2E (fake clock) pass                                                                                                         |
| 2I.1F    | Hosted Supabase browser close-out on a disposable project with real private media; final regressions                                                                                                                                                                                                                                                                                                                      | **complete**: hosted E2E 8/8 with exact cleanup, full memory E2E 158/158, full unit 1705/1705, DB gates green                                                            |

Phase 2I is the persistent editorial substrate (one edit per Episode, pinned sources, explicit editing, rough-sequence preview); Phase 5 expands it into full post-production. Not in 2I: transitions, effects, grading, keyframes, multitrack/music/ambience editing, captions, EDL/XML export,
collaboration, AI editing (Phase 5 and later).

### Phase-2 Alpha status

**Phase-2 Alpha functionally accepted; remote deployment architecture deferred.** The absence of a remote deployment
is an infrastructure/hosting decision, not an unresolved Phase-2 application correctness gate. Functional acceptance
(source `fbd1beb`, migration head 0043) is recorded in [timeline-performance-assembly §8](timeline-performance-assembly.md#8-phase-2i-acceptance-2i1f);
the closed Vercel Preview experiment and the open **Prism Studio Hosting Architecture** decision item are in
[deployment](deployment.md).

**Known gap (found in 2H, not fixed in 2H): generic selection revision coverage.** Core `projectRevision`
protection covers the original package-input revision set. Canonical selection tables added later — Production
Frame, Location View and Character Continuity selections — are not yet included in that generic digest
(`REVISION_SOURCES` in `src/data/generation-postgres.ts`), so generic **Generate** has a TOCTOU window for those
mutable selection pointers. Animate Production Frame independently revalidates its canonical Production Frame source:
before the candidate set is created, before every candidate is submitted, and again in the worker against the frozen
request / package provenance. Extending generic revision coverage is a separate hardening task.

### Known gaps (Phase 2A)

- **No real provider adapter.** Only the Mock provider executes; nothing here has been exercised against a paid API.
- **Worker storage credential for Supabase is not provisioned.** Live ingestion into Storage was verified through
  the dev test-credential path; production needs `PRISM_STUDIO_WORKER_SERVICE_KEY` on the worker host.
- **Status updates poll** Prism's own endpoint (1.5 s while active); no push.
- ~~`maxConcurrency` per model is advisory.~~ **Enforced for billing models in Phase 2B** (see known gaps).
- ~~Submission TOCTOU window~~ **Closed (post-review) for the original package-input set.** `projectRevision()` (a
  digest of the package input rows that existed in Phase 2A) is read before the project is loaded and re-verified
  inside the submit transaction (`stale_package`). See the Phase 2H gap below: later selection tables are not in it.
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
  prepared; the semantic smoke is **not yet run** (needs explicit approval).
- **Gemini, historically:** during Phase 2D, Gemini (`gemini-3.8-flash`, `gemini-3.6-flash`) had no successful live
  inference. `generateContent` returned sustained 503 overload, while auth, model access and parsing were verified
  at zero cost. Prism's durable retry, accounting and ceilings behaved as designed
  ([continuity-costs](continuity-costs.md)).
- **Gemini, later:** Phase 3A.3 verified live Gemini direct-video inference with analyzer v3, whose request contract
  is verified, and a successful 48-request temporal calibration
  ([temporal-video-qa](temporal-video-qa.md#final-acceptance-2026-10-29)).
- **Credential unverified**: no zero-cost verification call is made (none is documented as free).
- **Direct video** was architecture only in Phase 2D. Phase 3A.3 made it live and calibrated
  `video_temporal` for six families: camera movement, screen direction, eyelines, action beats, forbidden actions and
  geography. It stays **opt-in**: OFF by default, gated by the server switch AND explicit Project full-video consent,
  plus the spend gates. Lip sync remains uncalibrated and OFF.
- **Batching is conservative**: criteria with different reference sets get separate requests (identity vs
  wardrobe), re-sending the output frames; merging would cut cost but blur which references judged which criterion.
- **Global spend ceilings only**; per-project budgets are a follow-up.
- **Two real analyzers are wired** (Gemini, OpenAI); multi-analyzer comparison is a per-attempt run table, not a
  benchmark, and there is **no automatic routing or failover** between providers (health is informational).
- **The continuity worker shares the project-wide Storage secret** with the generation worker (read-only use).
- **Auto-run after conform is intentionally absent.**
- **Mock outputs/frames are fixtures**, so semantic results in demo mode only demonstrate flow, not pictures.
- **Conform is still synchronous**; the analysis queue shape could carry media jobs later.

## Phase 3 — Automated Shot QA / AI Continuity Supervisor _(complete)_

**Phase 3 — COMPLETE.** 3A.1–3A.4 are merged, and the hosted migration head is 0047. The specialised analyzers row below
is future optional work, not part of the completed scope. The Phase 2 backlog (2D.2, 2E.2, optional M2D.3D2 and the known
gaps) stays open as independent follow-ups and does not block Phase 4.

Built on the Phase 2C/2D continuity infrastructure (runs, findings, overrides, analysis jobs, costs); no parallel QA
persistence. QA always advises; a person approves or rejects. Details: [shot-qa](shot-qa.md).

| Slice    | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status                                                                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **3A.1** | **Shot QA Decision Layer**: pure assessment projection (states, priority issues, deterministic rejection-reason suggestions, freshness reasons); Production Frame / Location View fidelity from frozen truth; camera framing vs movement; honest constraint routing; Shot QA summary + Attempt card; rules `3a.1`; no migration                                                                                                               | **complete** (PR #27)                                                                                                                                                                                                |
| **3A.2** | Automatic QA orchestration: free deterministic QA automatically after output and delivery changes (eventually automatic, authenticated reconciliation); semantic auto-run only under an explicit Project policy, budgets and provider gates; migration 0044 applied to hosted DEV ([automatic-shot-qa](automatic-shot-qa.md))                                                                                                                 | **complete** (PR #29)                                                                                                                                                                                                |
| **3A.3** | Temporal Video QA: Gemini direct video (static 4 fps), Project full-video consent (0045, applied to hosted DEV), timestamped evidence, mixed image/video runs, calibration harness; live calibration + lip sync gated ([temporal-video-qa](temporal-video-qa.md))                                                                                                                                                                             | **complete** — Gemini temporal calibration v2 verified; six production temporal families accepted; lip sync remains separately gated (PR #32)                                                                        |
| **3A.4** | **Sequence Continuity Supervisor**: adjacent-Shot / cut-level continuity across the Episode, batch review and dashboard ([sequence-continuity-supervisor](sequence-continuity-supervisor.md)). 3A.4A cut domain; 3A.4B deterministic Supervisor UI; 3A.4C transition persistence + cut intent (migration 0046); 3A.4D semantic cross-cut pipeline; 3A.4E live calibration; 3A.4F automatic orchestration + hosted acceptance (migration 0047) | **complete** (PR #41) — `sequence-calibration-v1` accepted 9/10 semantic cut families; eyeline rejected and off. Sequence Automatic is opt-in, defaults off and is enabled on no Project. Hosted migration head 0047 |
| (later)  | Specialised analyzers (face identity / embeddings, Claude vision) behind the same normalized contract                                                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                    |

Not in 3A.1–3A.3: automatic regeneration, approval or rejection; automatic analyzer routing; provider failover; Claude
vision; face embeddings; cross-Shot / cut-level continuity (3A.4); cross-Episode QA. 3A.3 production temporal QA is
accepted on the verified calibration v2 (six temporal families). Lip sync stays unchecked and separately gated, and QA
stays advisory.

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
