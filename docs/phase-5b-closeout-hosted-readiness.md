# Phase 5B closeout and hosted-readiness audit

Baseline: `phase-5b-story-intelligence` at `ea6e2d099f37a0a578fad57d2153b7cbf53a3983` (Merge PR #80, V4 Final Render).
Branch: `phase-5b-closeout-hosted-readiness`. Audit date: 2026-11-09.

This is a closeout, not a feature slice:

- Nothing was deployed.
- No hosted migration was applied, and no hosted worker was provisioned.
- No provider was called.
- Hosted DEV (`lyqdxiyjperhniwhzsvg`) was only **read**: every query ran in a `begin read only` transaction with `default_transaction_read_only=on`.
- Four small hosted-readiness defects were fixed (§13), each with a test.

Legend:

- **Verified** means the fact was run or read during this audit.
- **Planned** means a proposal; nothing was executed.

---

## 1. Phase 5B completion statement

**Phase 5B is functionally complete.** The filmmaking loop exists end to end in code and is proven locally:

Screenplay → Production Proposal → AI writing/revisions → Characters / Locations / Scenes → Shot List → Shot Direction → Visual Bibles → Production Frame → Shot Clip → Sequence / Animatic → Episode Edit → Final MP4.

The proof uses the Ojou-sama project in browser stories K–S on memory mode with mock or local providers, and the real-ffmpeg final-film test. It does **not** mean hosted, real-provider, production or commercial readiness. Those are §16–§17.

### Ancestry (verified with `git log --merges ea6e2d0`)

| Slice                                 | PR  | Merge     |
| ------------------------------------- | --- | --------- |
| I1 image foundation (+ 0051 gate)     | #64 | `65ec005` |
| I1b Shot image entry points           | #65 | `8a24cfa` |
| I2 image generation / editing         | #66 | `df755bb` |
| I3 local background removal           | #67 | `9cf79c4` |
| I3b hosted matting (Photoroom)        | #68 | `c582e41` |
| I4 Character Visual Bible             | #69 | `6c2a588` |
| I5 Location Visual Bible              | #70 | `3bffe96` |
| I6 reference-driven Production Frames | #71 | `4773dd4` |
| S1 import / Production Proposal       | #72 | `78d12fa` |
| S2 AI Writing Assistant               | #73 | `5f0fac7` |
| S4 Scene → Shot List                  | #74 | `e181394` |
| S5 Storyboard Direction               | #75 | `c265c04` |
| Pre-video loop convergence            | #76 | `9066509` |
| V1 Shot Clip (image-to-video)         | #77 | `617f2f6` |
| V2 Sequence + Animatic                | #78 | `85e23d3` |
| V3 Episode Edit                       | #79 | `776ed2a` |
| V4 Final Render                       | #80 | `ea6e2d0` |

All slices are ancestors of `ea6e2d0`. The 5A commercial runtime (5A.1 and 5A.2, `e99c7a1`) is merged in via `b667cdd`. `main` is `b5b1125` (Phase 4F) and contains none of Phase 5.

## 2. Completed capabilities

| Area                        | What exists (code-complete, locally proven)                                                                            | Real provider ever called?                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Story Intelligence (S1–S5)  | Screenplay import → immutable Production Proposals; AI writing with accept/restore; Shot List; Direction; Story worker | **No** (mock only)                                                                      |
| Image generation (I1–I2)    | Shot, Character and Location subjects; GPT Image (direct) and Runway-hosted image models; candidate sets               | Runway image: yes (2026-10-22, $0.10). OpenAI direct: **no**                            |
| Background removal (I3/I3b) | Local keyer `prism-matting` (free); Photoroom "High Quality Removal" (paid, opt-in)                                    | Photoroom: **no** (fake transport only)                                                 |
| Visual Bibles (I4/I5)       | Canonical identity, Looks, cutouts; Location canonical, views, plates, variants                                        | n/a                                                                                     |
| Production Frames (I6)      | Reference-driven candidates → conform → canonical Production Frame                                                     | **No** paid I6 run                                                                      |
| Video (V1)                  | Canonical Production Frame → Runway image-to-video → reviewed Shot Clip                                                | Runway video: yes, pre-V1 (2026-10-14, Gen-4.5 2 s, $0.24); **not** through the V1 flow |
| Sequence / Animatic (V2)    | Episode sequence over the existing Episode Edit                                                                        | n/a                                                                                     |
| Episode Edit (V3)           | Trims, holds, Cut / Cross dissolve, titles, saved revisions, render manifest                                           | n/a                                                                                     |
| Final Render (V4)           | Segmented deterministic FFmpeg render → verified immutable MP4 Asset, restartable, private download                    | n/a (no provider)                                                                       |

## 3. Deferred capabilities (intentional, NOT blockers to Phase 5B functional completion)

| Deferred                       | Recorded in                      | Becomes a blocker?                                                                                      |
| ------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| V3b Episode music bed          | V3 doc §V3b (`audio.bed = null`) | No                                                                                                      |
| Split at playhead              | V3 doc (one item per Shot)       | No                                                                                                      |
| Advanced audio mixer           | V4 doc §deferrals                | No                                                                                                      |
| AI sound design                | V4 doc                           | No                                                                                                      |
| ADR / voice cloning            | V4 doc                           | No (and needs consent and legal review before it ever ships)                                            |
| Advanced transitions           | V4 doc                           | No                                                                                                      |
| Colour grading                 | V4 doc                           | No                                                                                                      |
| Render-cache pruning tool / UI | V4 doc §cache                    | **Before production**: segments are kept until the project is deleted; Storage grows without bound (§9) |
| Phase 5D layout consolidation  | §15                              | **Before commercial launch** (UX, not correctness)                                                      |

## 4. Migration audit (0051–0059)

The migration ledger checksum is SHA-256 of the file with CRLF normalized to LF (`scripts/lib/migrations.mjs`).

**Earlier migrations are untouched (verified):**

- `git diff b5b1125 ea6e2d0 -- supabase/migrations` contains only the nine added files, with no modification, deletion or rename.
- Hosted DEV's ledger checksums match the repository files for all 50 applied migrations (0 mismatches).

| Migration                           | Ledger checksum (sha256)                                           | Purpose                                                                                              | Prerequisites | Worker roles                                                                    | Operational caution                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0051_generation_subjects.sql`      | `1f9ca2000ea666955bd518c848eb41ee58d3cc5bbd4296130ff5e5c8803bb620` | Generation subjects: Character and Location attempts (`shot_id` nullable); asset-delete gate trigger | 0001–0050     | Generation worker reads subject columns; no new role                            | `generation_attempts.shot_id drop not null`. Schema-additive, but **`main`'s code assumes every attempt has a Shot** (see the isolation rule below). Forward-only. |
| `0052_character_visual_roles.sql`   | `3bbbae94ddd0e2bb4a168a4f8c89ba79a1ddb606e931bf701a144e3b20b62698` | Two partial unique indexes: one canonical identity and one cutout per Character                      | 0051          | none                                                                            | Index build fails if duplicates already exist (none possible on DEV: no Visual Bible data)                                                                         |
| `0053_location_visual_bible.sql`    | `229eed9903086b2a0e54c22c3b815f22fde9424159c134f9583f39aebaeedad4` | `locations.visual_bible` jsonb with shape check                                                      | 0052          | none                                                                            | Additive                                                                                                                                                           |
| `0054_story_proposals.sql`          | `382747f5ec051784b29523fd7940cd3bc59edb523526cc1dd837c6b168f087a8` | `story_proposals` + role **`prism_story_worker`** (NOLOGIN)                                          | 0053          | New role; LOGIN attached later by `story:db:provision`                          | Additive; creates a role (cluster-wide object)                                                                                                                     |
| `0055_story_writing.sql`            | `5de7cc21db73922b4473718a29b08a7f7a63770e45b775ad9134a9aa1afb3bd3` | `script_revisions`, `writing_sessions`, `scene_story_changes`, `writing_proposals`                   | 0054          | Story worker: SELECT + UPDATE (result and lease columns) on `writing_proposals` | Additive                                                                                                                                                           |
| `0056_shot_list_proposals.sql`      | `01d2452bab12641bbc7883d0b0bfdf131a5f80cc8acd43cae15750c88d6b5859` | `shot_list_proposals`                                                                                | 0055          | Story worker grants                                                             | Additive                                                                                                                                                           |
| `0057_shot_direction_proposals.sql` | `737b81a115ec186a22c0db0e71ee2114a6d5e59df2029645a0562b46803defa7` | `shot_direction_proposals`                                                                           | 0056          | Story worker grants                                                             | Additive                                                                                                                                                           |
| `0058_episode_edit_v3.sql`          | `90d9ce9f42cec49ae7c42c43b22b625469bfedc27186fa252508c83e67f7833e` | Transitions, titles, `episode_edit_revisions`                                                        | 0057          | none                                                                            | Additive                                                                                                                                                           |
| `0059_episode_renders.sql`          | `453367af9af3f9f15ffcc3a61ffaff9bd6e2dd4d15bd62cd8a791b3949b661d6` | `episode_renders`, `render_segment_cache`, purpose `episode_render`, role **`prism_render_worker`**  | 0058          | New role; LOGIN attached by `render:db:provision` (added in this closeout)      | Replaces `assets_purpose_check` (drop + add, in one transaction); **`main`'s Asset schema has no `episode_render`**. Creates a role                                |

**Applied anywhere?**

- **Hosted DEV:** none of 0051–0059 (verified, §5).
- **Disposable local Postgres:** all 59, from zero, many times. This audit's run is in §18.
- No other database exists. There is no rehearsal, staging or production Supabase project yet.

**Reversibility.** All nine are forward-only and have no down migrations.

- `db:migrate` applies every pending file in **one transaction**: either all 0051–0059 commit, or none do.
- Before a real apply, `db:migrate -- --dry-run` rehearses the whole chain inside a transaction that is rolled back. `db:migrate:dry-run-check` proves the rollback.
- After commit, rollback means restoring the database from backup (§11, step 1). Hand-reverting is not supported: it would contradict the ledger checksums.

**Safe to apply to hosted DEV in order?** Technically yes: they apply cleanly on top of 0050 with no data rewrite. **Operationally, not until the isolation decision (§11, step 0) is made.** Today the owner-review site `prism-studio-tawny.vercel.app` runs **`main`** against hosted DEV, and `main`:

- parses every generation attempt with a required `shotId`;
- parses Asset purposes from a list that lacks `episode_render`.

The migrations alone create no such rows. The first Character or Location image, or the first Episode render, made by Phase 5B code on that database would break `main`'s project page for that project. This is the existing I1 isolation rule (`docs/phase-5b-image-pipeline.md` §6). It is the single most important sequencing constraint in this plan.

## 5. Hosted DEV current state (read-only, verified 2026-11-09)

| Item                | Hosted DEV now                                                                                                                                                                                              | Phase 5B expects                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Postgres            | 17.11; `max_connections` 60                                                                                                                                                                                 | same                                                                                        |
| Latest migration    | **`0050_shot_setup_templates.sql`** (applied 2026-11-06 19:09 UTC); 50 rows; 0 checksum mismatches; nothing applied that is not in the repository                                                           | `0059_episode_renders.sql`; 59 rows                                                         |
| Missing migrations  | 0051, 0052, 0053, 0054, 0055, 0056, 0057, 0058, 0059 (all nine, **as expected**)                                                                                                                            | none                                                                                        |
| Schema drift        | **None.** `db:validate` (this branch, read-only) reports `STRUCTURE OK` at 50 migrations: no missing or unexpected tables, every table has RLS and a policy, no column, storage or ledger problems          | `STRUCTURE OK` at 59 (verified on disposable)                                               |
| Worker roles        | `prism_generation_worker` (LOGIN, conn limit 10, NOINHERIT, no BYPASSRLS, grants on 6 tables); `prism_continuity_worker` (LOGIN, conn limit 10)                                                             | + `prism_story_worker` (0054) and `prism_render_worker` (0059), each with LOGIN provisioned |
| Auth                | 1 user (the dev owner), email provider only, confirmed; no signup route in the app                                                                                                                          | same for DEV acceptance                                                                     |
| Storage             | Bucket `prism-assets`: **private**, `file_size_limit` 50 MB, 29 MIME types including `video/mp4`, `audio/wav`, `application/pdf`; 19 objects / 18 MB; 4 `storage.objects` policies for `authenticated` only | same; see §9 for the 50 MB render limit                                                     |
| Generation queue    | 11 jobs: Runway 7 succeeded, 2 failed; mock 2 succeeded; **0 leased** (nothing in flight)                                                                                                                   | —                                                                                           |
| Projects            | 5, including `ojousama`                                                                                                                                                                                     | —                                                                                           |
| Asset purposes used | storyboard 14, generation_output 13, performance_audio 13, identity_ref 10, look_ref 1                                                                                                                      | + production_frame, document, episode_render                                                |
| anon privileges     | `anon` holds Supabase-default table privileges on **63** public tables, for example full `arwdDxtm` on `scene_master_frames` and `shot_previs_clips` (issue #47). RLS is the only barrier                   | revoke (§12, #47)                                                                           |
| Extensions          | pgcrypto, uuid-ossp, pg_stat_statements, supabase_vault                                                                                                                                                     | same                                                                                        |

**Generation worker prerequisites on hosted DEV:**

- The role exists with LOGIN (`worker:db:provision` was run in 5A).
- A real-login `worker:db:check` and `db:worker-role` run have **not** been recorded against hosted (§6).

## 6. Generation worker

**Role and login**

- Role: `prism_generation_worker`, created by 0015 as NOLOGIN NOINHERIT with `statement_timeout` 60 s and idle-in-transaction 120 s.
- LOGIN is attached only by `npm run worker:db:provision`. It needs `PRISM_STUDIO_WORKER_DB_PASSWORD` (≥ 24 characters), sets connection limit 10, supports `--rotate`, and is production-safe.
- The pooler user is `prism_generation_worker.<ref>`.

**Environment**

- Database: `PRISM_STUDIO_WORKER_DB_URL`, checked by `assertProjectRef`. Startup refuses unless `current_user = prism_generation_worker`.
- Storage: `PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY` (legacy name `…_SERVICE_KEY`).
- Target: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT`, `NEXT_PUBLIC_PRISM_STUDIO_SUPABASE_REF`.
- Providers:
  - `RUNWAYML_API_SECRET` (Runway image and video);
  - `PRISM_STUDIO_PROVIDER_OPENAI_IMAGE_API_KEY` (GPT Image);
  - `PRISM_STUDIO_PROVIDER_PHOTOROOM_API_KEY`;
  - `PRISM_STUDIO_GENERATION_PROVIDERS` and `PRISM_STUDIO_WORKER_BACKED_PROVIDERS`.
- Spend: `PRISM_STUDIO_ALLOW_PAID_GENERATION`, `PRISM_STUDIO_MAX_GENERATION_USD` (unset blocks all paid work), `PRISM_STUDIO_MAX_CANDIDATE_SET_USD`, `PRISM_STUDIO_MAX_CANDIDATES_PER_SET`.
- Concurrency: `PRISM_STUDIO_WORKER_CONCURRENCY` (default 2), `PRISM_STUDIO_RUNWAY_MAX_CONCURRENCY`, `PRISM_STUDIO_OPENAI_IMAGE_MAX_CONCURRENCY`.
- Health: `PRISM_STUDIO_WORKER_HEALTH_PORT`, `PRISM_STUDIO_WORKER_HEALTH_STALE_MS`.
- It reads **no Story key and no render variable**. `phase5b-boundaries.test.ts` asserts the Story side.

**Database privileges (0015–0017, unchanged by 5B)**

- `generation_jobs`: SELECT, plus UPDATE on its execution columns.
- `generation_attempts`: SELECT, plus UPDATE on `status`, `output_asset_id`, `duration_ms`, `cost_usd`.
- `projects`: SELECT on `id`, `user_id`.
- `assets`: SELECT on 10 columns, plus INSERT (only generation and provider outputs while ingesting).
- `generation_outputs`, `generation_costs`, `generation_job_events`: INSERT only.
- RLS shows only active jobs.
- 0054–0059 grant it nothing; `worker-db-check` (32/0) asserts the forbidden list.

**Deployment target**

- `Dockerfile.generation-worker` (node:24-slim, non-root, no ffmpeg) as the Vercel Daemon `generation` in the separate project `deploy/workers-staging` (1 GiB / 1 vCPU, iad1, liveness `GET /healthz` on 8080, 120 s grace).
- Staging instances are scaled to 0 except during acceptance.
- Discrepancy: `deploy/workers-staging/vercel.json` declares `instances: {iad1: 1}` while its README says 0. Reconcile it before the next deploy of that project.

**Queue**

- Claim: a CTE with `for update skip locked` over workable statuses where `next_run_at <= now()` and the lease is absent or expired. An expired lease is reclaimed by the next claim.
- Concurrency defaults to 2; the pool size is concurrency + 2.
- Retries: `PRISM_STUDIO_MAX_ATTEMPTS` (default 4).

**Spend gates and kill switches**

- Paid work needs `ALLOW_PAID_GENERATION` and `MAX_GENERATION_USD`. Gates are checked at submit **and** in the worker.
- Per-set caps apply to candidate sets.
- Kill switch: remove a provider from `PRISM_STUDIO_GENERATION_PROVIDERS`, or unset `ALLOW_PAID_GENERATION`. Queued work then fails as `provider_unavailable`, and already-submitted provider jobs are still polled and ingested, so nothing is lost. To stop the worker entirely, scale the daemon to 0.

**Capabilities in the current worker code**

| Capability             | Status                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Image generation       | Yes (Runway image; GPT Image via `WORKER_BACKED_PROVIDERS=openai-image`)                                                                                                 |
| Video (image-to-video) | Yes (Runway; first frame checked by asset id **and** re-hashed bytes before submit)                                                                                      |
| Background removal     | Local `prism-matting` (free) and Photoroom (paid) as worker-backed providers                                                                                             |
| Candidate generation   | Yes (candidate sets are N ordinary jobs composed on the web)                                                                                                             |
| Polling / resume       | Yes: `provider_job_id` persisted at submit; any instance resumes polling after a lease expiry; an ambiguous submit stops as `submission_outcome_unknown` (never re-sent) |

**But: the hosted DEV database cannot hold any of the 5B subject, Visual Bible or Production Frame data** until 0051–0053 are applied.

**`db-worker-role --set-role` = 55/62.** Re-verified in this audit against a fresh run on the historical base `4773dd4`; the same seven failures reproduce (§18). Cause:

- `--set-role` impersonates the role on the disposable **superuser** connection, so the real-login-only `session_user` check is skipped (62 checks instead of 63).
- Six checks depend on the mock end-to-end flow finishing within wall-clock limits on loopback: succeeded, outputs/cost, owner attribution, terminal-job update, finished-attempt visibility, finished-attempt update.
- The seventh, "cannot create a database", runs its `create database` **outside** the `SET ROLE` transaction, so on the superuser it succeeds. This is a test artefact.

These are **not** permission defects, and no permission was changed to make them pass. **Exact hosted acceptance (real login, no impersonation), run against the target project after 0051–0059 are applied there:**

```sh
# admin URL in SUPABASE_DB_URL; worker login URL in PRISM_STUDIO_WORKER_DB_URL (session pooler, prism_generation_worker.<ref>)
npm run worker:db:check          # expects 32 PASS / 0 FAIL, and session_user = prism_generation_worker
npm run db:worker-role           # REAL LOGIN mode (no --set-role): 63 checks incl. session_user; expected 63/63
npm run db:generation            # queue → worker → MockProvider → ingest, zero cost
```

`db:worker-role` is not production-safe; it is refused on production by design and runs only on DEV or rehearsal.

## 7. Story worker

**Role and login**

- Role: `prism_story_worker`, created by 0054 as NOLOGIN NOINHERIT, with 60 s / 120 s timeouts.
- LOGIN is attached by `npm run story:db:provision`. It needs `PRISM_STUDIO_STORY_DB_PASSWORD` (≥ 24 characters), sets connection limit 5, supports `--rotate`, is production-safe, and audits the role after provisioning.
- `db-story-worker-login` (27/27) proves a real login on the disposable database. **There is no hosted real-login verifier**; `story:db:provision`'s built-in audit is the hosted check.

**Environment**

- Database: `PRISM_STUDIO_STORY_WORKER_DB_URL`.
- AI settings:
  - `PRISM_STUDIO_STORY_AI_PROVIDERS` (default `openai`);
  - `PRISM_STUDIO_ALLOW_PAID_STORY_AI` (literal `true` only);
  - `PRISM_STUDIO_STORY_AI_MAX_USD` (per request, default 1);
  - `PRISM_STUDIO_STORY_AI_SESSION_MAX_USD` (default 1).
- Provider key: `PRISM_STUDIO_PROVIDER_OPENAI_STORY_API_KEY`. It is **not** `OPENAI_API_KEY`.
- It has no Storage access and no Storage key.

**Database access**

- SELECT plus UPDATE (result and lease columns only) on `story_proposals`, `writing_proposals`, `shot_list_proposals` and `shot_direction_proposals`.
- RLS shows only queued or running rows.
- **No access** to projects, episodes, scenes, characters, locations, shots, assets, dialogue lines, script revisions, writing sessions, scene story changes or generation attempts; `story-worker-role.ts` asserts this.
- It never inserts or deletes. Applying a proposal is a creator action on the web.

**Process model**

- One Node process; pool max 2; requires `current_user = prism_story_worker`.
- `tick(limit 2)` per proposal kind; 2 s idle poll; `skip locked` claim; 10-minute lease.
- An expired running lease is failed as `ambiguous_interrupted` and **never re-sent** (no double spend).
- Up to 3 attempts for retryable errors.
- Expected concurrency: 1 process (Story calls are short and capped).

**Gaps (hosted)**

- No `/healthz`, no Dockerfile and no daemon definition.
- It does not `assertProjectRef` its URL.
- Health today is its stdout lines.

These are worker-hosting work for 5A (§12), not 5B defects.

**Credential boundary (verified, `phase5b-boundaries.test.ts`):**

- No `"use client"` file names a Story secret.
- No `NEXT_PUBLIC_*STORY|PROVIDER|WORKER*` variable exists.
- The generation worker and its providers never name a Story secret.
- The render worker's sources contain no OpenAI, Story or generation key (`migration-0059.test.ts`, `redact-closeout.test.ts`).

## 8. Render worker

**Database login**

- Role: `prism_render_worker` (0059), NOLOGIN NOINHERIT, with 60 s / 120 s timeouts.
- **Closeout fix:** `npm run render:db:provision` now attaches LOGIN to the role itself, mirroring the generation and Story workers. Before this, 0059 documented "a login that is a member of the role", and no provisioning existed.
- It needs `PRISM_STUDIO_RENDER_DB_PASSWORD` (≥ 24 characters), sets connection limit 5, supports `--rotate`, is production-safe, and audits the role.
- `db:renders` now also proves a real login on the disposable database: `current_user` and `session_user` are both `prism_render_worker`; it cannot read projects, shots, story_proposals, generation_jobs or episode_edits; it cannot create a database; it cannot `SET ROLE postgres`.

**Minimum privileges (0059)**

- `episode_renders`:
  - SELECT, with the policy `using (true)`. Postgres checks an UPDATE's new row against the SELECT policy, so the worker must be able to read the render it just completed.
  - UPDATE on 13 lifecycle columns, **only while the render is active**.
  - The guard trigger keeps terminal renders immutable.
- `render_segment_cache`: SELECT, INSERT, DELETE for projects with an active render.
- `assets`: SELECT on 11 media columns for projects with an active render; INSERT only `purpose = episode_render, type = video` while the render is `verifying`.
- No Story, generation, edit or continuity table.

**Storage**

- Its **own** key, `PRISM_STUDIO_RENDER_WORKER_SUPABASE_SECRET_KEY`, on the private `prism-assets` bucket. It reads sources and the segment cache, and writes segments and the final MP4.
- **Closeout fix:** the entrypoint used to spread the whole environment into the Storage sink. It now:
  - passes only the target variables and its own key;
  - refuses to start without its own key outside local dev, never falling back to the generation worker's legacy `PRISM_STUDIO_WORKER_SERVICE_KEY` or a dev-user sign-in;
  - runs `assertProjectRef`, installs the redacting handlers, prints the target banner, and refuses unless `current_user = prism_render_worker`.

**Runtime requirements**

| Need             | Requirement                                                                                                                                                                                                                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FFmpeg + FFprobe | On PATH, or `PRISM_STUDIO_FFMPEG_PATH` / `PRISM_STUDIO_FFPROBE_PATH`; capabilities in §10                                                                                                                                                                                                                                         |
| Fonts            | Noto Serif CJK (or Noto Serif JP) **and** Noto Sans CJK (or Noto Sans JP); Debian `fonts-noto-cjk`, or `PRISM_STUDIO_RENDER_FONT_DIR`                                                                                                                                                                                             |
| Temp disk        | `PRISM_STUDIO_RENDER_TEMP_DIR`, at least about 3× the largest render: sources + segments + final. The ~45 s Ojou-sama film is a few MB; a 10-minute 1920×804 CRF-18 episode is roughly 0.5–1 GB of scratch. Each render's directory is removed in `finally`.                                                                      |
| CPU              | libx264 `medium` at 1920×804 is CPU-bound. 2 vCPU renders roughly real-time to 2× real-time (estimate, to be measured in hosted acceptance). Preset is `PRISM_STUDIO_RENDER_PRESET` (default `medium`).                                                                                                                           |
| RAM              | Sources and segments are buffered in memory for upload and hashing: peak ≈ largest source or final file + ffmpeg (~300–500 MB at 1080-class). **2 GiB minimum, 4 GiB recommended.**                                                                                                                                               |
| Concurrency      | 1 render and 1 ffmpeg process per worker; pool max 2; horizontal scale = more instances (`skip locked`)                                                                                                                                                                                                                           |
| Polling          | `PRISM_STUDIO_RENDER_IDLE_POLL_MS` (default 5 s); 10-minute lease extended by every progress write; an expired lease is reclaimed and resumes from the verified segment cache                                                                                                                                                     |
| Retry / restart  | A failed render is retried by the owner as the same render. **Closeout fix:** writes to deterministic object paths now replace a leftover object, so a crash between upload and the DB record, or a corrupted cached segment, no longer fails every retry on hosted Storage (`upsert: false`). Covered by a new real-ffmpeg test. |
| Cleanup          | Temp directories are removed per render; segment cache and old renders are kept (no pruning yet, §9)                                                                                                                                                                                                                              |
| Health           | **New:** `npm run render:health`, deterministic and local (§10). Runtime liveness is stdout lines only; **no `/healthz` yet** (5A gap, §12).                                                                                                                                                                                      |

**Is the current generation runtime appropriate for FFmpeg rendering? No, not as it is.** The `generation` daemon image has no ffmpeg and no fonts, and runs at 1 GiB / 1 vCPU. Vercel **Functions** are unsuitable: renders take minutes, need scratch disk, and need a native ffmpeg.

Vercel **Daemons** are technically suitable: long-running containers, 4 GiB / 2 vCPU available, restart with backoff. But a daemon receives **all of its deployment's environment variables**, and per-daemon scoping is undocumented. A render daemon added to the existing `workers-staging` project would therefore receive the generation worker's Runway, OpenAI and Photoroom keys, violating the render boundary.

**Recommendation (smallest sensible target):**

- A **separate** Vercel project, `prism-studio-render-staging`, with one daemon `render`.
- Image: `node:24-bookworm-slim` + `apt-get install ffmpeg fonts-noto-cjk`, the same pattern as the existing `Dockerfile.media-worker`.
- Size 4 GiB (2 vCPU), 1 instance, iad1, grace 600 s.
- Environment: only the render DB URL, the render Storage key and the public target.
- Run `npm run render:health` as the image's build-time or start-up gate.

A small dedicated VM with ffmpeg and fonts is an equally valid alternative. Neither the Dockerfile nor the project is created here, because that is provisioning. Note that Debian bookworm's ffmpeg is 5.1: `render:health` checks the required options (`amix normalize`, `alimiter latency`, `drawtext expansion/textfile`) on the real image before any render.

## 9. Storage

**Bucket and paths**

- One **private** bucket, `prism-assets` (50 MB per object).
- Object path: `<project_id>/<asset_id>/<file>`. The `storage.objects` policies (`authenticated` only) require `is_project_owner(<first path segment>)`.
- Namespaces:

| What                                           | Path                                                               | Written by                      |
| ---------------------------------------------- | ------------------------------------------------------------------ | ------------------------------- |
| Uploads (images, screenplay PDF / text, audio) | `<project>/<asset>/<original name>`                                | Web (user session)              |
| Generated images, Production Frames, conforms  | `<project>/<asset>/<file>`                                         | Generation worker / web conform |
| Shot clips (video)                             | `<project>/<asset>/<file>.mp4`                                     | Generation worker               |
| Final Episode renders                          | `<project>/<derived asset>/ojousama-episode-1-the-arrangement.mp4` | Render worker                   |
| Render segment cache                           | `<project>/<derived id>/segment-<key32>.mp4 / .wav`                | Render worker                   |

**Access**

- **Web:** reads through `/api/assets/[id]`. That route requires sign-in, looks the Asset up through the RLS-bound repository (not yours → 404), then redirects (307) to a **300-second signed URL** minted with the **user's own session**, so the Storage policies apply too. Private delivery works today on hosted DEV.
- **Workers:** each uses its own server Storage secret key (generation; render). The Story worker has none.

**Gaps**

- **50 MB object limit vs. final renders (BLOCKER before production):** a 1920×804 CRF-18 render exceeds 50 MB at roughly 40–80 s. The upload then fails, and the render fails cleanly with "Storage upload failed". The Ojou-sama acceptance film is well under the limit, so hosted DEV acceptance is unaffected. Fix before real episodes:
  - raise the bucket limit (plan-dependent);
  - use resumable (TUS) uploads in the render sink;
  - stream downloads instead of buffering.
- **No retention or pruning:**
  - segment cache, superseded renders and orphaned objects (a failed object removal) persist;
  - project-delete cascades remove rows, not Storage objects;
  - needed before production (§12).
- `?download=1` sets `attachment` only on the proxied (local-disk) path. On Supabase the signed URL is created without the `download` option, so the browser decides; Story S verified the local path. This is a small fix for the hosted render acceptance (§11, step 18).

## 10. FFmpeg and font requirements

**Minimum FFmpeg capabilities** (checked by `npm run render:health`):

- Encoders `libx264` and `aac`; pixel format `yuv420p`.
- Filters: `fps`, `scale` (with `force_divisible_by`), `pad`, `setsar`, `format`, `tpad`, `xfade`, `drawtext` (`textfile`, `expansion`, `fontfile`; needs libfreetype, plus libharfbuzz/fribidi for shaping), `color`, `atrim`, `aresample`, `adelay`, `amix` (`normalize`), `alimiter` (`latency`), `apad`, `anullsrc`.
- Demuxers: `concat`, `matroska`/webm, `mov`/mp4, `image2`, `wav`.
- `ffprobe` is required: segment compatibility checks before stream-copy concat, and final verification.

**Fonts**

- Film titles: **Noto Serif JP** (`NotoSerifJP-*`) or **Noto Serif CJK** (`NotoSerifCJK-Regular.ttc`).
- Plain titles: **Noto Sans JP** or **Noto Sans CJK** (`NotoSansCJK-Regular.ttc`).
- Lookup order: `PRISM_STUDIO_RENDER_FONT_DIR`, then the Linux, macOS and Windows standard directories.
- **Fail closed:** no proprietary fallback, and the render fails before drawing. The family and SHA-256 enter every title segment's cache key and the render provenance.
- No font binaries are committed.
- The hosted generation image has none; the render image installs `fonts-noto-cjk` (Debian), which provides both `.ttc` files under `/usr/share/fonts/opentype/noto`.

**Versions in tests:** ffmpeg/ffprobe **9.0.1** (gyan.dev full build, Windows) with libx264, libfreetype, libharfbuzz and libfribidi; fonts Noto Serif JP and Noto Sans JP.

**Deterministic health check (`npm run render:health`, new; local; no DB, network or credential):**

1. ffmpeg present → ffprobe present.
2. Encoders, pixel format, filters and options → demuxers.
3. Both fonts resolve.
4. A **real** two-card Japanese title render (Film + Plain) through the production renderer → H.264 yuv420p at the delivery canvas, 24/1, exact frame count.
5. Title pixels drawn.
6. Temp directory removed.

Locally: **16/16 PASS.**

## 11. Exact hosted acceptance order

Default target is hosted DEV; see step 0. Every step after step 1 needs a recent backup. "Owner" means explicit owner approval in chat for that step.

| #   | Step                                                                                                                                                                                                                                                                                                           | Reversible?                                        | Risk              | Owner approval? | Production impact                                      | Rollback                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------- | --------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| 0   | **Isolation decision.** Either (a) run hosted acceptance on a **separate rehearsal Supabase project** (`phase-5a-production-bootstrap.md` §1–3; recommended), or (b) accept that the `main` owner-review site breaks for any project that receives 5B data, until `phase-5b-story-intelligence` reaches `main` | n/a (decision)                                     | High if (b)       | **Yes**         | (a) none; (b) the live owner-review site can break     | n/a                                                     |
| 1   | Verify backups: Supabase daily backup and PITR status for the target; take an on-demand backup or `pg_dump` of the target before migrating                                                                                                                                                                     | Yes                                                | Low               | Yes (dashboard) | None                                                   | n/a                                                     |
| 2   | Verify schema baseline: `db:migrate:check` (read-only) and `db:validate` → 50 migrations, `STRUCTURE OK` (verified today on DEV)                                                                                                                                                                               | Yes (read-only)                                    | None              | No              | None                                                   | n/a                                                     |
| 3   | Rehearse: `npm run db:migrate -- --dry-run` (all of 0051–0059 in one rolled-back transaction)                                                                                                                                                                                                                  | Yes (rolled back)                                  | Low               | Yes             | Brief locks                                            | Nothing persists (`db:migrate:dry-run-check` proves it) |
| 4   | Apply 0051–0059: `npm run db:migrate` (one transaction)                                                                                                                                                                                                                                                        | **No** (forward-only)                              | Medium            | **Yes**         | Brief locks; `main` keeps working until 5B data exists | Restore from step-1 backup                              |
| 5   | Verify DB: `db:migrate:check`, `db:validate` (expect 59, `STRUCTURE OK`), `db:behavior`, `db:rls`                                                                                                                                                                                                              | Yes                                                | Low               | No              | None (rolled back / cleaned)                           | n/a                                                     |
| 6   | Generation worker login: already provisioned on DEV. Rotate (`worker:db:provision -- --rotate`) only if the secret is not on hand                                                                                                                                                                              | Yes (rotate again)                                 | Low               | Yes             | None                                                   | Rotate                                                  |
| 7   | Real generation-worker DB-role acceptance: `worker:db:check` (32/0) → `db:worker-role` **real login** (expect 63/63) → `db:generation` (mock)                                                                                                                                                                  | Yes (cleans up)                                    | Low               | Yes             | None                                                   | n/a                                                     |
| 8   | Story worker login: `PRISM_STUDIO_STORY_DB_PASSWORD=… npm run story:db:provision` (audit must pass)                                                                                                                                                                                                            | Yes (`alter role … nologin`)                       | Low               | **Yes**         | None                                                   | `alter role prism_story_worker nologin password null`   |
| 9   | Deploy / start Story worker (separate host or project, Story key only, paid flag **off**) with `PRISM_STUDIO_STORY_AI_PROVIDERS=mock` first                                                                                                                                                                    | Yes (stop)                                         | Low               | **Yes**         | None                                                   | Stop / scale to 0                                       |
| 10  | Render worker login: `PRISM_STUDIO_RENDER_DB_PASSWORD=… npm run render:db:provision` (audit must pass)                                                                                                                                                                                                         | Yes                                                | Low               | **Yes**         | None                                                   | `alter role prism_render_worker nologin password null`  |
| 11  | Build the render image (ffmpeg + `fonts-noto-cjk`) and run `npm run render:health` **inside it** (16/16)                                                                                                                                                                                                       | Yes                                                | Low               | Yes             | None                                                   | n/a                                                     |
| 12  | Deploy / start render worker in its **own** project or host (render DB URL + render Storage key only)                                                                                                                                                                                                          | Yes (stop)                                         | Low               | **Yes**         | None                                                   | Stop / scale to 0                                       |
| 13  | Worker health: generation `/healthz` 200; Story and render start-up banners show the dedicated role and target; no claim errors                                                                                                                                                                                | Yes                                                | None              | No              | None                                                   | n/a                                                     |
| 14  | Zero-cost hosted smoke: mock image job; mock Story proposal; local `prism-matting` cutout; mock video; all through the hosted workers                                                                                                                                                                          | Yes (throwaway project or delete)                  | Low               | Yes             | None                                                   | Delete throwaway project                                |
| 15  | Revalidate provider registries and pricing against current provider documentation (§14); update `verifiedAt` and pricing versions in a PR                                                                                                                                                                      | Yes                                                | None              | Yes (review)    | None                                                   | Revert PR                                               |
| 16  | Authorize tiny real **Story** call (§14.1)                                                                                                                                                                                                                                                                     | Spend irreversible                                 | Low ($0.01 cap)   | **Yes**         | None                                                   | Spend stops at cap                                      |
| 17  | Authorize tiny real **Image** call (§14.2)                                                                                                                                                                                                                                                                     | Spend irreversible                                 | Low (≤ $0.50 cap) | **Yes**         | None                                                   | —                                                       |
| 18  | Hosted **Episode render** acceptance (§14.5, $0 provider)                                                                                                                                                                                                                                                      | Yes (renders are history; delete project to clear) | Low               | Yes             | CPU and Storage only                                   | Scale render worker to 0                                |
| 19  | Authorize tiny real **Video** call (§14.3), after the Runway revalidation blocker is cleared                                                                                                                                                                                                                   | Spend irreversible                                 | Low (≤ $0.50 cap) | **Yes**         | None                                                   | —                                                       |
| 20  | Photoroom only if the matting flow is needed (§14.4); separate authorization for the external upload                                                                                                                                                                                                           | Spend + external upload irreversible               | Low ($0.05 cap)   | **Yes**         | None                                                   | —                                                       |
| 21  | Ojou-sama hosted end-to-end: Story → Shot List → Direction → Visual Bible → Production Frame → Shot Clip → Sequence → Edit → Final MP4 → private download                                                                                                                                                      | —                                                  | Low               | Yes             | None                                                   | —                                                       |

Two changes from the suggested order:

- The render acceptance (step 18) moves **before** the paid video call. It costs nothing and proves the whole post-production path on hosted infrastructure first.
- Step 0 comes first, because the live `main` site shares hosted DEV.

## 12. Remaining Phase 5A gaps

| Gap                                                                                    | Classification                            | Notes                                                                                          |
| -------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Isolation of 5B data from the `main` site on DEV (rehearsal project or merge decision) | **BLOCKER before hosted DEV acceptance**  | §4, §11 step 0                                                                                 |
| Migrations 0051–0059 on the target                                                     | **BLOCKER before hosted DEV acceptance**  | §4                                                                                             |
| Story worker hosting (image, host, health)                                             | **BLOCKER before hosted DEV acceptance**  | No Dockerfile, daemon or `/healthz`                                                            |
| Render worker hosting (ffmpeg + fonts image, own project, 2–4 GiB)                     | **BLOCKER before hosted DEV acceptance**  | §8; `render:health` ready                                                                      |
| Generation worker real-login validation                                                | **BLOCKER before hosted DEV acceptance**  | §6 commands                                                                                    |
| Provider metadata revalidation (Runway especially)                                     | **BLOCKER before the first paid call**    | §14                                                                                            |
| Worker liveness for Story and render (`/healthz`)                                      | BLOCKER before production                 | Generation has it                                                                              |
| Observability: owner health page, alerts, ops role (5A.3)                              | BLOCKER before production                 | Planned, not built                                                                             |
| Queue stuck-job handling beyond lease expiry (reaper and alert)                        | BLOCKER before production                 | Lease reclaim exists; no alert                                                                 |
| DB pool sizing for serverless web (issue #61)                                          | BLOCKER before production                 | Web pool max 10 per instance against `max_connections` 60                                      |
| Security #42: breadth of worker Storage secret (it can call Auth Admin)                | BLOCKER before production                 | Render now has its own key of the same class; scope both                                       |
| Security #47: legacy `anon` privileges (63 tables on DEV, including all new 5B tables) | BLOCKER before production                 | RLS blocks today; revoke migration + `db:validate` check                                       |
| True production Supabase separation                                                    | BLOCKER before production                 | `resolveTarget` already refuses DEV for production; the project does not exist                 |
| Backup / restore drill + PITR                                                          | BLOCKER before production                 | Runbook §5 exists; not executed                                                                |
| Storage lifecycle: segment pruning, orphan sweep, delete-cascade to objects            | BLOCKER before production                 | §9                                                                                             |
| 50 MB object limit vs. full-length renders                                             | BLOCKER before production                 | §9                                                                                             |
| Worker restart behaviour                                                               | POST-LAUNCH acceptable (already designed) | Leases, idempotent claims, ambiguous-submit stop, render retry (fixed here for hosted Storage) |
| Deployment documentation (Story and render missing from bootstrap §3.4 and §7)         | BLOCKER before production                 | This document is the interim source                                                            |
| Redaction lists missing 5B secret names                                                | **Fixed in this closeout**                | §13                                                                                            |

## 13. Security closeout

Verified in source, grants and tests.

| Boundary          | Holds                                                                  | Never holds                                                    | Evidence                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Browser           | Publishable key, public URL and environment names                      | Provider keys, worker DB URLs, Storage secret keys             | Only 5 `NEXT_PUBLIC_*` names exist, none secret; no `"use client"` file reads `process.env` or a secret (`phase5b-boundaries.test.ts`) |
| Story worker      | `PRISM_STUDIO_PROVIDER_OPENAI_STORY_API_KEY`, its DB login             | Generation keys, render secrets, any Storage key               | Boundary test; 0054–0057 grants only the four proposal tables                                                                          |
| Generation worker | Runway, OpenAI Image and Photoroom keys; its DB login; its Storage key | Story key, render DB login or Storage key                      | Boundary test; `worker-db-check` forbidden list; 0054–0059 grant it nothing                                                            |
| Render worker     | Its DB login, its own Storage key                                      | OpenAI, Runway, Photoroom, Gemini, Story or generation secrets | `migration-0059.test.ts` static scan; `redact-closeout.test.ts`; ffmpeg children get a credential-free environment                     |

**Hosting caveat:** environment isolation between workers depends on deploying each worker in its **own** project or host (Vercel daemons share deployment environment variables).

**Fixed in this closeout (smallest safe changes, each tested):**

1. **Render retries on hosted Storage** (`src/render/worker.ts`). Writes to deterministic paths replace a leftover object instead of failing with "already exists". New test: crash after the final upload, plus a corrupted cached segment, on a never-overwrite sink → retry completes. It failed before the fix.
2. **Render worker entrypoint** (`scripts/render-worker.mts`):
   - Storage sink gets only its own key (no legacy generation key, no dev sign-in);
   - `assertProjectRef`, redacting handlers, banner, and the `current_user` self-check.
3. **Render worker login provisioning** (`scripts/render-db-provision.mts`, `scripts/lib/render-worker-role.ts`, `npm run render:db:provision`), plus real-login checks in `db:renders` (52/52).
4. **Redaction** (`scripts/lib/safety.mjs`, `src/lib/auth/redact.ts`): now masks the values of `PRISM_STUDIO_PROVIDER_OPENAI_IMAGE_API_KEY`, `…_OPENAI_STORY_API_KEY`, `…_PHOTOROOM_API_KEY`, the Story and render DB URLs and passwords, and `PRISM_STUDIO_RENDER_WORKER_SUPABASE_SECRET_KEY`.
5. **`db:validate`** expected-table list is now ledger-aware for 0050–0059. Before, a fully migrated database reported `STRUCTURE PROBLEMS`, and the post-migration check in step 5 would have failed.
6. **`npm run render:health`** (§10).

## 14. Provider acceptance plan (planned; nothing executed)

### 14.1 OpenAI Story: first real call

- **Status:** never called. Registry `gpt-6-luna`, pricing `openai-2026-10-13` (checked 2026-10-13, 27 days ago).
  - Rates: $0.10 per 1M input, $0.01 per 1M cached input, $0.50 per 1M output; 2× / 1.5× over 272K input.
  - The SDK is pinned at `openai@7.32.0`.
  - **REQUIRES PROVIDER METADATA REVALIDATION BEFORE REAL CALL:** a hand-entered price; re-check the model page and pricing on the day.
- **Test:** the prepared S2 procedure (`docs/phase-5b-s2-ai-writing-assistant.md`).
  - Project `ojousama`, Episode 1, Scene 6 (`INT. SKY-VIEW RESTAURANT - NIGHT`).
  - Instruction "Make Yumeko more guarded…", 1 version.
  - Code estimate **$0.0014** (about 2,900 input tokens, up to 2,162 output tokens); worst case about $0.003 with the correction turn.
  - Hard cap: `PRISM_STUDIO_STORY_AI_MAX_USD=0.01` and `PRISM_STUDIO_STORY_AI_SESSION_MAX_USD=0.01`, with `PRISM_STUDIO_ALLOW_PAID_STORY_AI=true` on the Story worker only.
  - Run with `npm run worker:story -- --once`.
- **Acceptance:**
  1. Job created with the exact confirmed total.
  2. Story worker claims it as `prism_story_worker`.
  3. **1** provider request (2 only if the validator requests a correction).
  4. Output passes schema.
  5. `actual_usd` and usage recorded.
  6. No project mutation: Scenes, Shots and script text are unchanged until the creator accepts.
  7. The proposal is visible in Write.
  8. The browser bundle and network contain no provider key.

### 14.2 Image: first reference-driven Production Frame

- **Status:** OpenAI direct has never been called. Runway-hosted image was called once (2026-10-22, $0.10, no references).
- **Shot:** Ojou-sama **3A** (Lobby, elevator bank, Yumeko, Formal Black, MCU, 85 mm, 2.39:1).
- **Prerequisite:** real Visual Bible images on the target (the seed's are byte-less placeholders): Yumeko canonical identity and the Formal Black Look; Lobby canonical, establishing and "entrance toward elevators" views.
- **References sent** (I6): the 6 listed (3 essential). The OpenAI limit is 16, so nothing is trimmed.
- **Model:** `gpt-image-2.5-flare`, quality medium, 1 candidate, 1536×864, then a 2.39:1 conform.
  - Registry `openai-image-2026-11-07-provisional`, verified 2026-11-07.
  - Rates: text $5, image input $8, image output $30 per 1M tokens.
  - Estimate ≈ **$0.38** (output 7.1¢ + 6 refs × ≤ 4.8¢ + text ≈ 2¢).
  - **The price is self-declared provisional:** revalidate, and recalibrate from the first run's reported `usage`.
- **Cheaper alternative:** Runway-hosted `gpt_image_2_5_flare` at **$0.11** (5 credits + 1 per reference; verified 2026-10-21). The trade-off is data retention/ZDR; the I2 doc prefers direct where it matters.
- **Spend cap:** `PRISM_STUDIO_ALLOW_PAID_GENERATION=1`, `PRISM_STUDIO_MAX_GENERATION_USD=0.50`, `PRISM_STUDIO_MAX_CANDIDATE_SET_USD=0.50`, `PRISM_STUDIO_MAX_CANDIDATES_PER_SET=1`.
- **Lineage to inspect:**
  - `generation_attempts`: `input_asset_ids` (6 reference Assets), `package_fingerprint`, `prompt_plan`, `compatibility.references` (no `optional_trimmed`), `cost_usd`.
  - `generation_jobs`: `provider_job_id`, `estimated_cost` vs. `actual_cost`.
  - The output Asset's checksum.
  - After "Use as Production Frame": `shot_production_frames.source = generation_output`, `source_generation_attempt_id`, `asset_checksum`, `frame_fingerprint`.

### 14.3 Runway video: first image-to-video

- **Shot:** Ojou-sama **3A**, from its canonical Production Frame (the 2.39:1 conform).
- **Model:** `gen4_turbo`, **2 s**, which is the integer minimum. Shot 3A is 4.5 s, so set the clip duration explicitly.
  - $0.05/s gives **$0.10**. Gen-4.5 would be $0.12/s ($0.24).
  - Provider ratio: 21:9, the closest to 2.39:1. Confirm the adaptation plan in Advanced before confirming spend.
  - Registry `runway-2026-10-13` / catalog verified 2026-10-14; SDK `@runwayml/sdk@4.22.0`, API `2024-11-06`.
- **Hard cap:** `PRISM_STUDIO_MAX_GENERATION_USD=0.50` (the `pre-paid:check` ceiling). Run `npm run pre-paid:check` first; it is zero-cost.
- **First frame:** verify `animationProvenance.firstFrameMatches`. The worker checks that the start frame equals the frozen `productionFrame.assetId` and **re-hashes the bytes** before submit; a mismatch gives `runway_input_unavailable`.
- **Async:**
  - `provider_job_id` is persisted at submit.
  - Kill the worker during `processing`, restart it, and verify it resumes polling the same task (no second submit).
  - An ambiguous submit must stop as `submission_outcome_unknown`.
- **Success lineage:** clip Asset ← `generation_outputs` ← attempt (`input_asset_ids` = the Production Frame Asset) ← `shot_production_frames`, and the Shot Clip review.
- **BLOCKER:** Runway model capabilities, pricing, duration and aspect support must be revalidated against current provider documentation before the first real paid call. V1 explicitly did not revalidate them, and the last Gen-4 Turbo run (2026-10-14) failed provider-side with `INTERNAL.BAD_OUTPUT`.

### 14.4 Photoroom

- **Status:** never exercised against the real service. I3b used a fake transport only.
- **Source fixture:** a real Character image with a **busy background**, for example the 14.2 Yumeko output. The offer appears only after the local keyer refuses with `matting_background_not_plain`.
- **Privacy disclosure (UI):**
  - "Processed by Photoroom. The provider states API images are discarded after processing."
  - "…sent to Photoroom's API (servers in the eastern United States) only when you choose High Quality Removal."
  - Uploading to Photoroom needs its **own** owner authorization.
- **Cost:** $0.02 (`photoroom-basic-2026-11-08`). Cap: `MAX_GENERATION_USD=0.05`.
- **Provenance expected:** `foregroundPreservation: "provider-process"`, `rgbUnchangedVerified`, source checksum, uncertainty score, cost, `inputAssetIds`, output Asset with alpha.

### 14.5 Hosted render ($0 provider)

**Prerequisites:**

- Steps 0–13 done.
- The Ojou-sama Edit on the target has real media: mock clips and uploaded or generated stills, as in Story S.
- The render worker is running in its own project with ffmpeg and fonts.

**Flow:** save the Edit revision → Render Episode → the render worker claims as `prism_render_worker` → segments → assemble → verify → completed.

**Accept:**

- `episode_renders.status = completed`.
- Output H.264 1920×804 24/1 + AAC, frames = manifest `totalFrames`.
- Asset purpose `episode_render`, with its checksum.
- Download through `/api/assets/<id>?download=1` (signed URL; check the filename).
- A second render reuses verified segments.
- Kill the worker mid-render → a lease reclaim (or retry) completes the **same** render (the closeout fix).

**Runtime:** about 1–3 minutes for the ~45 s film on 2 vCPU (estimate).

## 15. Phase 5D UX debt (consolidated; not redesigned here)

1. **Sequence / Animatic / Edit overlap.** Three surfaces over one Episode Edit (V2 doc). Recommended single workspace with modes **Board** (Sequence status as an overlay), **Timeline** (V3 editing) and **Watch** (Animatic + Final) (V3 doc).
2. **Plan Shots discoverability.** Only reachable from Scenes, inside a collapsed row. Write's Scene chips, the Shot page and the Story-changed notice don't link to it.
3. **Story changed → Re-plan / Direct links.** The notice links Write and Mark reviewed, not Re-plan Shots or Direct with Prism. Re-plan is offered but never automatic.
4. **Shot direction status visibility.** The Shot page shows none. "Direction needs review" appears only inside Direct with Prism.
5. **Post-S1 Apply next-step guidance.** Created Scenes have no "Plan Shots" call to action, and the panel links one Shot only.
6. **Post-Shot-List Apply links.** New Shots are reachable only via "Existing Shots", and the applied message has no links.
7. **Storyboard description visibility.** S5's description reaches the prompt but is not its own line in Production Frame Inputs.
8. **Repeated model/cost confirmation controls.** Import, Write, Plan Shots and Direct each repeat Advanced model and Confirm total. There is no Story-wide budget view.
9. **Production Frame conform friction.** At 2.39:1, every candidate needs "Create production conform" before "Use as Production Frame".
10. **Also known:**
    - Generate Alternative refuses paid models and redirects to the Animate comparison (V1);
    - no delete or rename;
    - no "Retry" on failed generation jobs;
    - no "worker not running" warning;
    - empty states and a sample project (commercial-readiness §5D).

## 16. Phase 5C preview (read-only architecture audit)

**Today:**

- **Tenancy:** single-owner Projects (`projects.user_id`, `is_project_owner()` = `auth.uid()`). Every child table is gated by `project_id` across 138 policies. There is no org, team or workspace.
- **Accounts:** created in the Supabase dashboard; there is no signup route.
- **Spend:** append-only `generation_costs` and `continuity_analysis_costs`; Story spend on proposal rows. Caps are per **deployment** (env) plus per-user submit rate limits.
- **Missing:** Stripe, subscriptions, entitlements or credit ledger; account deletion, export or project delete; Terms and Privacy pages; a production Supabase project.

**Architectural findings to settle before deployment:**

- **Worker roles see every tenant's queue rows** (`using (true)` or status-only policies on generation, continuity, Story and render queues). This is by design for shared workers and is safe only because each role is least-privilege and column-limited. Keep it, but per-tenant quotas must be enforced in the **enqueue transaction**, not in workers.
- **Spend caps are deployment-wide.** 5C must add per-account entitlements and a usage ledger checked at enqueue (planned: `account_entitlements`, `credit_ledger` / `usage_events`).
- **Storage paths are `<project_id>/…`**, owner-checked through the project. This suits single owners. Sharing or teams will need an access function rather than path ownership; no path migration is needed for single-owner accounts.
- **Worker Storage keys are project-wide secrets** (#42). For multi-tenant production, narrow them or move workers to scoped credentials.
- **Web uses an admin pool with an RLS preamble**; pool sizing is #61. Sound, but the preamble is the tenant boundary for server reads, so keep the boundary tests.
- **Render segment cache is per project** (no cross-tenant reuse), and derived Asset ids are tenant-scoped through their attempt or render. No global cache leaks.
- **Deletion:** project delete cascades rows but not Storage objects. Account deletion and export need an object sweep (also §9).
- **Docs:** `docs/phase-5-commercial-readiness.md` (2026-11-06) predates Phase 5B as built. Its "5B" meant render/export and "one real provider (Runway)". 5E (paid-provider acceptance) must now cover OpenAI Story, OpenAI Image and Photoroom as well as Runway.

**No blocker requires changing Phase 5B's data model before deployment.**

## 17. Readiness matrix

| Area                | Code Ready | Hosted Ready | Real Provider Verified | Production Ready | Commercial Ready |
| ------------------- | ---------- | ------------ | ---------------------- | ---------------- | ---------------- |
| Story Intelligence  | YES        | NO           | NO                     | NO               | NO               |
| Image Generation    | YES        | PARTIAL      | PARTIAL                | NO               | NO               |
| Background Removal  | YES        | NO           | NO                     | NO               | NO               |
| Production Frames   | YES        | NO           | NO                     | NO               | NO               |
| Video Generation    | YES        | PARTIAL      | PARTIAL                | NO               | NO               |
| Sequence / Animatic | YES        | NO           | n/a (YES)              | NO               | NO               |
| Episode Edit        | YES        | NO           | n/a (YES)              | NO               | NO               |
| Final Render        | YES        | NO           | n/a (YES)              | NO               | NO               |
| Storage             | YES        | PARTIAL      | n/a                    | NO               | NO               |
| Generation Worker   | YES        | PARTIAL      | PARTIAL                | NO               | NO               |
| Story Worker        | YES        | NO           | NO                     | NO               | NO               |
| Render Worker       | YES        | NO           | n/a (YES)              | NO               | NO               |
| Database            | YES        | PARTIAL      | n/a                    | NO               | NO               |
| Authentication      | PARTIAL    | PARTIAL      | n/a                    | NO               | NO               |
| Billing             | NO         | NO           | n/a                    | NO               | NO               |
| Monitoring          | PARTIAL    | NO           | n/a                    | NO               | NO               |
| Backups             | PARTIAL    | PARTIAL      | n/a                    | NO               | NO               |

**Explanations of every PARTIAL / NO.** "Hosted NO" for the 5B features means the target lacks 0051–0059 and the worker (Story, render) is not hosted.

- **Image generation:** Hosted PARTIAL because Shot images could run on the existing DEV worker, but Character/Location subjects and references need 0051–0053. Provider PARTIAL because Runway-hosted image was called once (no references); OpenAI direct never.
- **Video:** Hosted PARTIAL because the generation daemon exists (scaled to 0) but V1 data needs 0051+. Provider PARTIAL because Runway video was called before V1, not through V1's Production Frame path; capabilities not revalidated.
- **Background removal:** the local keyer needs no provider; Photoroom never called; I3b data needs 0051+.
- **Production Frames:** need 0051–0053 and real Visual Bible media; no paid I6 run.
- **Sequence / Edit / Render:** "Real Provider Verified n/a (YES)": no provider is involved, and the path is proven with real ffmpeg locally. Hosted NO because 0058/0059 and the render worker are absent.
- **Storage:** private bucket and signed delivery work on DEV. The 50 MB render limit and no pruning keep it from production.
- **Generation worker:** deployed design exists (staging daemon). The real-login acceptance is not recorded; the real-provider runs predate 5B.
- **Database:** DEV is consistent at 0050 (`STRUCTURE OK`), 9 migrations behind. No production project; #47 open.
- **Authentication:** works for the single dev owner; no signup, account management or deletion (5C).
- **Billing:** not built (5C).
- **Monitoring:** generation `/healthz` and structured logs only; no alerts, ops page or Story/render liveness (5A.3).
- **Backups:** Supabase managed backups on DEV (owner to confirm the plan and PITR); the restore drill has not been run.

## 18. Phase 5B closeout test results (this branch)

All runs were serialized on Windows with Docker Postgres 17 as the disposable database and `--maxWorkers=2`.

**Database (disposable Postgres, reset from zero):**

- 59 migrations applied; `migrate --check` OK; `db:validate` STRUCTURE OK (after the closeout fix).
- `db:renders` **52/52**, including the new real-login checks.
- Edits and sequencing: `db:episode-edits` 124, `db:sequence-continuity` 78, `db:sequence-automation` 53, `db:media-qa` 39.
- Generation and images: `db:generation` 71, `db:candidates` 55, `db:production-frames` 71, `db:location-views` 69, `db:generation-subjects` 28, `db:visual-bible` 6, `db:location-visual-bible` 10, `db:image-shot-generator` 30, `db:character-continuity` 80.
- Story suites: `db:story-proposals` 21, `db:story-writing` 29, `db:shot-lists` 23, `db:shot-directions` 22, `db-story-worker-login` 27.
- `db:behavior` 61; `worker:db:check` 32 PASS / 0 FAIL. All suites pass in full.
- `db:rls` cannot run on the disposable shim (it has no Supabase Storage `owner_id` column). It belongs to hosted step 5.

**Worker-role caveat:** `db-worker-role --set-role` is **55/62**. The same seven failures reproduced in a fresh run on `4773dd4` in this audit (`diff` of the FAIL lists is empty).

**Unit and static checks:**

- Unit: **242 files / 3085 tests**, all pass. This includes 11 real-ffmpeg V4 final-film tests (one is new) and 8 new redaction/boundary tests. One allow-list test was updated for the new production-safe `render-db-provision.mts`.
- `render:health` 16/16.
- Typecheck clean.
- ESLint: 0 errors, the same 3 pre-existing warnings.
- Prettier (`--end-of-line auto`, because this Windows working tree checks out CRLF while the index is LF): clean except `deploy/workers-staging/static/index.html`, which is unchanged since `ea6e2d0` and already non-conforming there. `git diff --check` clean.
- Production build passes.

**Browser (full Playwright suite, 260 tests):**

- 250 passed, including Phase 5B stories **A–S 19/19** and the 2I/2H isolated suites.
- 2 failed and 8 did not run (serial dependents of the failures). Both failures are outside Phase 5B and untouched by this branch:
  - `previs-controls` translate-gizmo drag: "Saving…" was still showing at the 5 s assertion in the 1.3 h serial run. It is a **flake**: re-run in isolation, the spec passes 5/5 on this branch and 5/5 on `ea6e2d0`.
  - `image-shot-generator` "Generate candidates": expects 6 model rows, but the I2 image catalog shows 10. This is **pre-existing**: it fails identically on the untouched `ea6e2d0` tree. It is a stale assertion, left for a follow-up because the scope rule says not to change completed behaviour.

## 19. Final verdict and exact next action

1. **Phase 5B functionally complete?** **YES.**
2. **Ready for hosted DEV acceptance?** **NOT YET.** The code is ready (including the closeout fixes). The environment, migrations, Story/render worker hosting and the isolation decision are not.
3. **Blocks hosted DEV acceptance:**
   - the isolation decision (the live `main` site shares DEV);
   - applying 0051–0059;
   - hosting the Story and render workers (render image with ffmpeg + Noto CJK, in its own project);
   - provisioning their logins;
   - the generation worker's real-login acceptance.
   - Before any paid call: provider metadata revalidation, with Runway mandatory.
4. **Blocks production:**
   - the production Supabase project and a backup/restore drill;
   - #42 and #47;
   - observability, alerts and liveness for all workers;
   - pool sizing (#61);
   - Storage lifecycle/pruning and the 50 MB render limit;
   - deployment runbook completion for Story and render.
5. **Blocks commercial launch:** 5A closeout plus 5C (accounts, signup, tenancy/quotas, Stripe, usage ledger, deletion/export, Terms/Privacy), 5D (UX consolidation, §15) and 5E (paid acceptance on production for all four providers).
6. **Exact single next action after this PR merges:** the owner decides step 0 (§11). The recommended choice is to create the `prism-studio-rehearsal` Supabase project per `docs/phase-5a-production-bootstrap.md` §1–3. Phase 5B migrations, workers and acceptance can then run there without touching the live `main` site's DEV database.
