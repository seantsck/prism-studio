# Phase 5 — Commercial Product / 1.0 Readiness (plan)

**Status: planning only. Nothing here is implemented or authorized.** Audited on `main`
`b5b112537ed7c8ce6158629e11185e3b69af816a` (Phase 4 closed), hosted DEV migration head 0050, nothing pending. No code,
migration, hosted data, provider call or deployment was touched to write this.

This replaces the old roadmap placeholder ("rough-cut editor / audio / captions / NLE export"). The audit shows those
items are only part of what stands between Prism Studio and a paying user, and the others are larger.

## 1. The product today, as a paying user would meet it

Classes: **COMPLETE**, **ROUGH** (functional but rough), **PARTIAL**, **INTERNAL** (works, but not for a user),
**MISSING**. Each class was judged from routes, components and server actions, not from domain types.

| #   | Journey step                        | Class                | What is actually there                                                                                                                                                                                                                                                      |
| --- | ----------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Create an account                   | MISSING              | No sign-up; accounts are made in the Supabase dashboard ([auth](auth.md)). Sign-in and password reset work. No email-confirm flow, OAuth or MFA.                                                                                                                            |
| 2   | Start a project                     | ROUGH                | Home page "New project" form (`createProject`) and project settings (`saveProject`). No delete, no templates, no first-run guidance.                                                                                                                                        |
| 3   | Story / script                      | ROUGH                | Episodes can be created (not renamed or deleted). The script is a plain textarea with a deterministic Fountain-lite parser that syncs scenes and dialogue. No file import.                                                                                                  |
| 4   | Characters, locations, visual style | COMPLETE (no delete) | Characters, Looks, identity references and locks; Locations and locks; the project bible.                                                                                                                                                                                   |
| 5   | Create shots                        | ROUGH                | Manual breakdown (`createShotFromSources`), Shot Prep sections, Sequence Board reorder. No AI breakdown, no shot delete.                                                                                                                                                    |
| 6   | Generate or import media            | ROUGH / INTERNAL     | Generate panel with a cost estimate, candidate sets and review. One real provider (Runway). Jobs run only through a locally started `npm run worker:generation` in Supabase mode. Real use so far is one $0.10 image smoke. Preflight gates are strict.                     |
| 7   | Continuity                          | ROUGH                | Advisory Shot QA, Sequence Supervisor and Continuity Locks. Analysis needs a separate worker process.                                                                                                                                                                       |
| 8   | Spatial production (Phase 4)        | COMPLETE             | Accepted on hosted DEV in Phase 4F. Optional.                                                                                                                                                                                                                               |
| 9   | Assemble shots into scenes          | ROUGH                | Sequence Board order and scene runs inside the Episode Edit.                                                                                                                                                                                                                |
| 10  | Assemble the episode                | ROUGH                | Episode Edit: create from proposal, revision-checked saves, item list (not a track timeline), clip replacement, take pinning, ↑/↓ reorder.                                                                                                                                  |
| 11  | Edit timing and order               | ROUGH                | Numeric trim in/out and hold durations. No transitions, drag or ripple, or undo.                                                                                                                                                                                            |
| 12  | Audio                               | PARTIAL              | Dialogue takes are recorded or uploaded per line and placed per item. Clip audio is on/off. Music, SFX and ambience exist only as text. No mix, levels or fades. No TTS.                                                                                                    |
| 13  | Review the finished work            | ROUGH                | In-browser rough-cut player ("a preview, not a render"; 250 ms drift tolerance).                                                                                                                                                                                            |
| 14  | Render / export                     | **MISSING**          | No episode render, concat, export action, export table, download or output spec. Only per-shot delivery conforms (ffmpeg) and per-shot previs MP4s exist ([timeline-performance-assembly](timeline-performance-assembly.md): "final rendering / export … not implemented"). |
| 15  | Understand usage and cost           | PARTIAL              | Estimates before generation, an append-only `generation_costs` record, per-model spend on the Models page. Limits are per-deployment env ceilings, not per user or plan. No usage page.                                                                                     |
| 16  | Return later safely                 | ROUGH                | Data persists under owner RLS and saves are compare-and-set. But: no deletion of mistakes, no Retry for a failed generation, and nothing tells the user when no worker is running (jobs just stay queued).                                                                  |
| —   | Hosting / production                | **MISSING**          | "Never been served from a remote host"; hosting architecture "Open. Not chosen" ([deployment](deployment.md)). No CI. The app is pinned to the single DEV Supabase project (`src/lib/supabase/config.ts`, `src/generation/sink.ts`).                                        |
| —   | Billing, plans, entitlements        | **MISSING**          | No payment SDK and no plan, credit, quota or cancellation code.                                                                                                                                                                                                             |
| —   | Legal                               | **MISSING**          | No terms, privacy policy, acceptable-use or generated-content policy, and no disclosure that media goes to third-party providers.                                                                                                                                           |
| —   | Observability                       | **MISSING**          | Console logging with reference ids only. No error reporting.                                                                                                                                                                                                                |
| —   | Collaboration, mobile               | MISSING (post-1.0)   | One owner per project. Desktop layout only.                                                                                                                                                                                                                                 |

**What works today.** For a single operator on a developer machine against DEV, the whole authoring spine runs and saves
data: script to scenes, characters, locations and looks, shots with Shot Prep, storyboard and animatic, performance
takes, preflight-gated generation with cost estimates and review, continuity QA, the Phase 4 spatial path to a
Production Frame, and a revision-safe Episode Edit with a preview player. **It cannot be used by anyone else, and it
cannot produce a finished file.**

## 2. What "Prism Studio 1.0" means

> A creator signs up and is told what to do first. They write or paste a script, set up their characters, locations and
> look, break the script into shots, and generate or import each shot's media. Before every paid step they see the cost,
> and their plan sets a hard limit. They assemble the episode, hear their dialogue against the picture, and **export one
> MP4 they can download**. They pay through a self-serve plan and can return, fix mistakes and continue. The hosted
> production service does all of this without developer help. 3D stays optional.

**Must ship before paid launch.** Without these, a normal paying user cannot finish the core workflow, or cannot safely
be charged:

1. Production hosting for the web app **and** the generation/render workers. This needs a separate Production Supabase
   project (the DEV pin removed), CI, error monitoring, and uploads sent straight to Storage.
2. Tenant-safety hardening for many customers: #42 (scope the worker and relay keys), #47 (revoke the legacy anon
   grants), verified DB TLS, a CSP, and throttled actions.
3. **Episode render and export to MP4.** Pinned clips, holds and stills; a dialogue and clip-audio mixdown; one music bed
   with a level and fades; a defined output spec; render history, progress, retry and download.
4. Self-serve accounts: sign-up, email confirmation, acceptance of the terms and privacy policy, account deletion, and a
   data export.
5. Plans and spend controls. Billing (checkout, webhook-driven entitlements, cancellation), plus per-account credits or
   quotas and **hard caps enforced on the server before a paid job is queued**, and a usage page.
6. A way to recover from mistakes and failures. Delete or rename for projects, episodes, shots, characters and locations,
   with referential safety. A Retry button for failed generations. A visible warning when the worker or queue is
   unhealthy.
7. A first-run journey: empty states, a sample project and guided next actions.
8. Legal pages and a provider data-flow disclosure.
9. Paid-provider acceptance on Production ([#60](https://github.com/seantsck/prism-studio/issues/60), §7).

**Should ship soon after launch.** SRT captions from dialogue lines (and an optional burn-in); crossfades and fades
between edit items; undo in the edit; drag reordering inside the edit; script file import (.fountain / .fdx); a usage and
cost dashboard per project; optional AI-assisted breakdown behind the existing approval gates; reviewing which preflight
rules really have to block a first-time user; a second real video provider.

**Later (must not delay revenue).** Collaboration, multiplayer and roles; EDL/XML/OTIO interchange with professional
editing software; a track-based NLE with ripple, slip and roll; a DAW-style mixer; SFX libraries; TTS and voice cloning;
compositing and motion graphics; social publishing; a marketplace or plugins; native mobile apps; advanced analytics;
automatic model routing and production agents (the old Phase 6); real local reconstruction (M2D.3D2); Turbopack builds
([#59](https://github.com/seantsck/prism-studio/issues/59)); 3D modelling beyond Phase 4.

## 3. Phase 5 slices

Five slices, in critical-path order. Each is its own branch, PR, review and gate, as in Phase 4.

### 5A — Production platform and tenant safety _(blocks launch; first)_

- **Objective:** Prism Studio runs as a hosted, monitored service on its own Production database, safe for many
  customers.
- **User-visible outcome:** the app is reachable at its production URL; generation and render jobs run without anyone
  starting a process by hand.
- **Existing foundation:** [deployment](deployment.md) (the decision points are already listed), the worker scripts,
  leases and retries, owner RLS on every table, the migration ledger and checksums, the env-gated providers, and the
  Webpack build (#54).
- **Missing:**
  1. An owner decision on hosting, as an ADR: the web tier, plus a long-running worker tier with ffmpeg.
  2. A Production Supabase project, with the hard-coded DEV ref replaced by checked, per-environment configuration.
  3. CI (unit tests, typecheck, lint, build, the DB suites against a disposable database, and sharded browser runs; this
     resolves [#58](https://github.com/seantsck/prism-studio/issues/58) for CI).
  4. Error reporting.
  5. Uploads sent directly to Storage.
  6. #42: a least-privilege worker identity and Storage scope.
  7. #47: an additive revoke migration.
  8. Verified TLS and a CSP.
  9. A staging environment.
- **Schema impact:** one small additive migration (the #47 revoke, plus any worker-role grants #42 needs). Production is
  migrated from 0001 by the existing ledger.
- **Provider impact:** none. Production starts with paid generation off.
- **Acceptance:**
  - DB matrix on Production;
  - CI green;
  - a deployed smoke with mock providers;
  - `db:rls` and `db:worker-role` showing the narrowed key;
  - a real non-owner isolation run on Production.
- **Dependencies:** the hosting decision (owner).

### 5B — Episode render and export _(blocks launch)_

- **Objective:** turn the saved Episode Edit into one downloadable video.
- **User-visible outcome:** "Export" on the edit, choosing a quality preset; a progress indicator, the render history, a
  Retry, and a private download link.
- **Existing foundation:**
  - the Episode Edit model and its frozen item intervals;
  - the edit rate;
  - the per-shot ffmpeg conform (`src/media/ffmpeg.ts`, libx264/AAC);
  - `MediaProcessor`;
  - job leases and retries;
  - private assets with checksums;
  - the per-shot mediabunny MP4 path.
- **Missing:**
  - A render plan: a pure domain function from one edit revision to a list of segments.
  - Concat and composite operations, plus holds and placeholder stills.
  - A mixdown of dialogue placements and clip audio, with one music bed (level and fades).
  - The output spec: resolution and aspect from the project's production aspect, and the frame rate from the edit rate.
  - An `episode_exports` record that freezes the edit revision and render fingerprint.
  - A render job in the worker, and the UI.
- **Schema impact:** migration 0051 (or 0052): `episode_exports`, owner RLS, append-only history, no SECURITY DEFINER.
- **Provider impact:** none. Rendering is local ffmpeg.
- **Acceptance:**
  - unit tests for the render plan (deterministic and frame-exact);
  - an export that ffprobe checks (duration, streams, aspect);
  - stale-revision refusal;
  - retry after a failure in the middle of a job;
  - a browser story from edit to download;
  - a hosted run.
- **Dependencies:** 5A's worker hosting, so the plan should be written to fit it. Domain and unit work can start in
  parallel with 5A.

### 5C — Accounts, plans and spend controls _(blocks paid launch)_

- **Objective:** a stranger can sign up, pay, and never be surprised by spend.
- **User-visible outcome:** sign-up and email confirmation; accepting the terms; choosing a plan through checkout; a
  usage page showing credits used and remaining; paid generation blocked with a clear reason at the cap; cancellation;
  account deletion and data export.
- **Existing foundation:**
  - cost estimates;
  - append-only `generation_costs` and `continuity_analysis_costs`;
  - spend gates and USD ceilings (per deployment);
  - per-user submit rate limits;
  - Supabase Auth with PKCE reset.
- **Missing:**
  - Sign-up and email-confirm pages.
  - A billing integration, with webhook-driven entitlements. Stripe is the default assumption; the owner decides.
  - Per-account credit ledger and quota checks, enforced in the same transaction that queues a paid job.
  - The usage page.
  - Account deletion and data export.
  - The legal pages.
- **Schema impact:** one or two additive migrations (`account_entitlements`, `credit_ledger` / `usage_events`) with owner
  RLS. Entitlements are written only by a narrowly granted webhook role.
- **Provider impact:** none, beyond reading recorded costs.
- **Acceptance:**
  - a quota boundary test (the job that would cross the cap is refused before enqueue, with no partial write);
  - a webhook replay and idempotency test;
  - a non-owner cannot read or alter another account's entitlements;
  - the full sign-up-to-paid-plan story in Stripe test mode.
- **Dependencies:** 5A, for the Production project and the webhook endpoint. The domain, the ledger and the UI can be
  built in parallel.

### 5D — First-run journey and recovery _(blocks launch: the minimum; the rest is post-launch)_

- **Objective:** an unfamiliar creator knows what to do next and can fix mistakes.
- **User-visible outcome:**
  - empty states with next actions;
  - a sample project to explore;
  - delete or rename for projects, episodes, shots, characters and locations, with "in use" explanations;
  - a Retry on failed generations;
  - a "jobs are not being processed" warning;
  - a review of which preflight rules block a first generation.
- **Existing foundation:** the home and overview pages, the asset-lifecycle "refuse while in use" pattern, the job states,
  the seed project and the preflight engine.
- **Missing:** the delete and rename actions with referential rules (soft delete where history depends on a row); the
  retry action; the queue-health signal; the onboarding states; and the sample-project copy flow.
- **Schema impact:** possibly a `deleted_at` column or cascade rules. Each one must be designed so history and
  provenance are never broken (Phase 2–4 invariants).
- **Provider impact:** none.
- **Acceptance:**
  - deleting a used entity is refused, or keeps history, as designed;
  - a retried job is a new attempt, never a rewrite;
  - a first-run browser story from sign-up to a first approved shot with the mock provider.
- **Dependencies:** none, so it can run in parallel with 5A to 5C.

### 5E — Paid-provider acceptance and launch closeout _(blocks paid launch; last)_

- **Objective:** prove the whole product on Production with real money, then open it to the first customers.
- **Smallest acceptable paid-provider acceptance (#60):** on Production, one owner-authorized, capped run (for example
  ≤ $5 total, no retries unless authorized):
  1. one Runway image generation;
  2. one Runway image-to-video from a selected Production Frame;
  3. a successful ingest, with cost recorded and matching the estimate within its stated tolerance;
  4. one 5B export containing that clip, downloaded and ffprobe-verified;
  5. one refused job above the account cap, so the cap is proven against real pricing.
- **Also:** the legal pages are live; the support and incident runbook; a backup and restore drill on Production; a
  closed beta cohort; and a launch checklist.
- **Schema impact:** none expected.
- **Provider impact:** the only real-money step in Phase 5, behind its own explicit owner gate.
- **Dependencies:** 5A to 5D.

## 4. Critical path to the first paying external user

**Sequential:**

1. **Hosting decision (ADR).** Every later slice depends on where the workers and ffmpeg run.
2. **5A.** Production and CI; then #42 and #47.
3. **5B and 5C on Production.** The render job needs the worker host; billing webhooks need the Production URL.
4. **5E.** Paid-provider acceptance runs on Production, last.

**Can run in parallel, once the ADR exists:**

- 5B's render-plan domain and unit tests, and the export UI against memory mode;
- 5C's credit ledger domain, quota enforcement and usage page in memory mode;
- 5D in full;
- the legal page copy.

**Must stay sequential:**

- 0051+ migrations are applied in number order, each with its own hosted gate (as in Phase 4).
- Production is created before any webhook or real money.
- #42 is fixed before a second customer's media exists on Production.

## 5. Open issues and launch impact

| Issue                          | Launch impact                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #42 worker-secret breadth      | **Blocks launch.** A leaked worker or relay key exposes every customer's private media. Fix in 5A.                                                                                            |
| #47 legacy anon grants         | **Fix before launch (cheap).** RLS already denies rows, so this is defence in depth: one additive revoke migration in 5A.                                                                     |
| #58 Playwright 14 servers      | A developer inconvenience today; **a CI blocker** once CI exists (CI runners have less memory). Resolve with sharded or per-project server start in 5A's CI. Not a release blocker in itself. |
| #59 Turbopack on Windows       | **Not a launch blocker.** Webpack builds are supported in production. Revisit only if the chosen host requires Turbopack.                                                                     |
| #60 paid-provider smoke        | **Blocks paid launch.** The smallest acceptance is in 5E.                                                                                                                                     |
| #30 3D-set save E2E under load | Test stability; fold into 5A's CI work.                                                                                                                                                       |
| Security-model residual risks  | The privileged pool with an RLS preamble, unverified DB TLS, no CSP and unthrottled actions are addressed in 5A, as far as a multi-tenant launch requires.                                    |

## 6. Where Prism Studio stands

- **Core MVP (the intended outcome can be produced): not yet.** The authoring and generation spine works end to end for
  a single operator, but the defining output, a finished video file, cannot be produced. 5B is the only gap between
  today and an internal MVP.
- **Beta (an external test user with manageable support): not yet.** It also needs hosting, self-serve accounts, a
  minimal first run and recovery, and the tenant hardening (5A, 5D, and the account part of 5C).
- **Paid 1.0: not yet.** It also needs billing, quotas and caps, legal pages, and paid-provider acceptance (5C, 5E).

No completion percentage is given: the remaining work is mostly new platform surface (hosting, billing, rendering), so
the authoring depth already built is not a good measure of distance to launch.

**Remaining architectural complexity: MEDIUM.** The new pieces use known patterns: ffmpeg concat and mixdown, Stripe
webhooks, an append-only ledger, and a hosted worker. The existing invariants (owner RLS, append-only history,
compare-and-set saves, migration gates) carry over. The risk is concentrated in **5A**: choosing a host that runs
long-lived workers with ffmpeg, splitting DEV from Production, and replacing the privileged-pool and broad-key patterns
for many tenants. That slice deserves an ADR before any code.
