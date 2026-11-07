# Phase 5A — Commercial Runtime Foundation (architecture; 5A.1)

**Status: 5A.1 is architecture plus the smallest runtime change (worker liveness, a container entrypoint and the
generation worker image). Nothing is deployed, no Production Supabase project exists, and no migration is created.**
Base: `phase-5` (`1e67cdb`, on top of Phase 4 `main` `b5b1125`). Staging remains the hosted DEV Supabase project
(`lyqdxiyjperhniwhzsvg`) and the existing protected Vercel project `prism-studio`. That project is never customer
production.

Target: Vercel web app → dedicated Production Supabase → durable Vercel Daemon workers → real providers (server-side
only) → private Storage → review and continuity → Episode Edit → final MP4. Normal customer operation never depends on
a laptop, a VPS or a hand-run command.

## 1. Platform facts this design rests on

These come from Vercel's own pages ([Daemons](https://vercel.com/docs/daemons),
[config reference](https://vercel.com/docs/daemons/config-reference), [limits](https://vercel.com/docs/daemons/limits),
[managing](https://vercel.com/docs/daemons/managing-daemons),
[Build Output API](https://vercel.com/docs/build-output-api/daemons),
[public beta](https://vercel.com/changelog/vercel-daemons-is-now-in-public-beta)). The feature is in public beta.

- **Declaration.** A daemon is declared in `vercel.json` under `daemons.<name>` with `root`, `entrypoint` (a
  Dockerfile path relative to `root`), `instances` (per region, 0–100), and optionally `command`, `resources`,
  `livenessProbe` and `terminationGracePeriodSeconds`. **The build context is the Dockerfile's directory**, and daemon
  names allow no digits.
- **Sizes.** `resources.requests.memory` is one of `1Gi` (1 vCPU), `2Gi` (1 vCPU, the default), `4Gi` (2 vCPU) or
  `8Gi` (4 vCPU). There is no autoscaling.
- **Plan limits.** Pro allows 16 vCPU and 32 GiB running at once, and 50 instances per environment. The team
  (`prism-s-projects3`) is on **Pro**; Hobby's 420 GB-h a month could not even run one 1 GiB instance around the
  clock.
- **Lifecycle.**
  - An instance that exits or crashes is restarted with exponential backoff (1 s up to 5 min).
  - On deploy, new instances start immediately. Old instances get SIGTERM and the grace period (default 30 s,
    0–3600 s). **Both versions run briefly, side by side.**
  - A failed liveness probe restarts the instance with **SIGKILL, with no grace period**.
- **Production only.** Daemons run **only for production deployments; there are no preview daemons.**
- **Environment.** Each instance receives the **deployment's** environment variables. These are also passed to the
  image build as build arguments. Per-daemon scoping is not documented.
- **Networking and logs.** There is no inbound traffic and no `vercel dev` support. Logs go to the project's Logs
  (`source:daemon`).

## 2. Audit

**Generation worker (`scripts/generation-worker.mts`, `src/generation/worker.ts`): already daemon-compatible.**

- **Leases.** Jobs are claimed with `FOR UPDATE SKIP LOCKED`, leases (60 s default) and heartbeats. An interrupted step
  is resumed by any instance ("safe to stop mid-job"), so the overlap of two versions during a deploy is safe.
- **Shutdown.** SIGINT and SIGTERM abort the loop after the in-flight tick.
- **Fail-closed credentials.** Only the dedicated `prism_generation_worker` role is used. The development opt-ins are
  refused when `NODE_ENV=production`. A startup check verifies `current_user`.
- **Spend gate.** It is **rechecked at provider-call time** (`spendBlockers` inside the worker, "enforced where money
  is actually spent").
- **Logging.** Structured, with safe fields only (`src/generation/log.ts`). Prompts, URLs and credentials are never
  logged. Uncaught-error handlers redact.
- **Limits already present.** Per-worker `concurrency` (default 2, max 16), per-provider/model capacity reservation,
  and per-project active-job and per-user submit-rate limits at enqueue.

**Gaps found and the slice that closes each:**

| Gap                                                                                                                                                                                   | Slice    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `npm run worker:generation` requires `.env.local` (`tsx --env-file`)                                                                                                                  | **5A.1** |
| No liveness endpoint (a daemon probe needs an HTTP port)                                                                                                                              | **5A.1** |
| No container image                                                                                                                                                                    | **5A.1** |
| **The Supabase project ref is hard-pinned to DEV** (`scripts/lib/safety.mjs` `PRISM_STUDIO_REF`, `src/lib/supabase/config.ts`, `src/generation/sink.ts`), so Production is impossible | 5A.2     |
| Spend limits are per deployment (env), not per account or plan                                                                                                                        | 5C       |
| Mock failure-simulation models (flaky, reject, hang) are visible wherever the mock is enabled                                                                                         | 5A.2     |

**Media and ffmpeg execution points.**

- **`createDeliveryConform` (`src/server/media-actions.ts`).** It runs ffmpeg **synchronously inside a server action**,
  that is, in a Vercel request: crop, letterbox, pillarbox and trim. Vercel has no ffmpeg, so it reports "Media
  processing is not available". This must move to a durable job.
- **QA frame extraction and analysis.** These run in the separate continuity worker (`scripts/continuity-worker.mts`,
  `src/continuity/analysis/worker.ts`), off the request path, but they need ffmpeg in their own runtime.
- **Memory-mode inline workers.** These are demo-only (`ensureInlineAnalysisWorker`). Supabase mode never uses them.
- **Missing.** Still-image production conform, contact sheets and episode render have no job at all.
- **Lineage.** `asset_derivations` and `attempt_deliveries` (0020) already record child → parent and the deterministic
  operation, so a media job reuses them rather than inventing new lineage.

## 3. Environments and Vercel projects

The daemon facts drive this: daemons run only for production deployments, and they share the deployment's
environment variables with the web app. If workers lived in the web project, every web function would also receive
the provider keys and the worker database credential. **Least privilege therefore requires a separate Vercel project
for workers.** Recommended layout (owner decision):

| Vercel project                         | Role                                                             | Database                        | Holds                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `prism-studio` (existing)              | Staging / owner review web; previews; All Deployments protection | DEV (transaction pooler)        | public Supabase URL and key, DEV DB URL, mock-only flags                                           |
| `prism-studio-workers-staging` (new)   | Staging daemons (generation, media, continuity)                  | DEV (worker roles)              | worker DB URLs, worker Storage key; no real provider keys until a staging spend gate is authorized |
| `prism-studio-production` (new, later) | Customer web; private until 5E                                   | Production (transaction pooler) | public Supabase URL and key, Production DB URL; **no** provider or worker secrets                  |
| `prism-studio-workers` (new, later)    | Production daemons                                               | Production (worker roles)       | worker DB URLs, worker Storage key, provider keys, spend ceilings                                  |

- **Previews** stay on `prism-studio` (protected, DEV, no daemons).
- **The existing project** keeps serving owner review untouched.
- **Alternative:** one web project with a Vercel custom "staging" environment. This was rejected for workers, because
  of the shared-environment-variable problem, which would still need its own worker project.
- **To verify before 5A.2 creates the worker projects:** whether a project whose only output is daemons is accepted
  (the docs do not say).

## 4. Production Supabase (plan only; nothing is created in 5A.1)

**Shape.** A new project in AWS **us-east-1** (same region as DEV and Vercel `iad1`). Pro tier, for daily backups with
point-in-time recovery. It has its own Auth users, its own private bucket (created by the migrations, as on DEV), and
**no copied users, test accounts or demo history**. Sample content, if any, is seeded deliberately as product content
in 5D.

**Bootstrap.** Rehearse first, then run the same procedure for real:

1. **5A.2 code:** replace the hard-coded DEV ref with an **environment-scoped target**:
   - a required `PRISM_STUDIO_SUPABASE_REF` and `PRISM_STUDIO_ENVIRONMENT` (`development` | `staging` | `production`);
   - every guard still refuses a database whose ref does not match;
   - destructive tooling (`db:seed --reset`, cleanup scripts, e2e fixtures, `previs-cleanup`) refuses
     `production` outright.
2. **Rehearsal** on a throwaway project (created, verified, deleted):
   - `db:migrate:dry-run-check`, then `db:migrate` (0001 → head through the existing ledger and checksums);
   - `db:validate`;
   - worker-role provisioning (`worker:db:provision` and the continuity and media equivalents);
   - `db:rls`, `db:worker-role` and the full DB behaviour matrix (each suite cleans up after itself);
   - Auth settings: email confirmation on, Site URL, redirect URLs;
   - a restore drill from backup.
3. **Production:** the same steps, then a read-only verification only. No behaviour suites run on Production (they
   write and clean up, but customer data must never share a run with test fixtures). Post-bootstrap acceptance runs on
   the rehearsal project.
4. **Rollback:**
   - Before customers exist, Production is empty: rollback means delete and recreate.
   - After launch, migrations are forward-only, with the existing dry-run, then apply, then a hosted gate for each
     migration. Restore comes from point-in-time recovery, with a documented drill.
5. **Connections:**
   - Web (serverless) uses the **transaction pooler** (port 6543), as proven on staging (#61).
   - Daemons may use the session pooler or a direct connection, sized to each daemon's own pool.
   - Pool sizing becomes explicit per runtime (#61).

## 5. Generation daemon

The image and entrypoint are delivered in **5A.1**: `Dockerfile.generation-worker` at the repository root (the build
context must contain `src/` and `scripts/`, so a `workers/generation/Dockerfile` cannot build it) and `.dockerignore`.

- **Image.** `node:24-bookworm-slim` with `npm ci`, then `src/`, `scripts/` and `tsconfig.json`.
  - It runs as the non-root `node` user with `NODE_ENV=production`.
  - The command is one Node process: `node --import tsx scripts/generation-worker.mts`.
  - **No `ARG`**, so the platform's build arguments never enter the image, and `.dockerignore` keeps every `.env*` file
    out.
- **Liveness.** `PRISM_STUDIO_WORKER_HEALTH_PORT` serves `GET /healthz`.
  - It returns 200 while the loop completes iterations, and 503 after `PRISM_STUDIO_WORKER_HEALTH_STALE_MS` (default
    10 min) without one.
  - Tick failures are reported, not fatal: a database or provider outage is not a stuck process, and restarting would
    not fix it.
  - The body holds counts and ages only.

**Proposed daemon config** for the worker project (5A.2). It is **not** added to the existing `vercel.json`, because
there it would start on the staging project's next production deploy:

```json
{
  "daemons": {
    "generation": {
      "root": "./",
      "entrypoint": "Dockerfile.generation-worker",
      "instances": { "iad1": 1 },
      "resources": { "requests": { "memory": "1Gi" } },
      "terminationGracePeriodSeconds": 120,
      "livenessProbe": {
        "httpGet": { "port": 8080, "path": "/healthz" },
        "initialDelaySeconds": 60,
        "periodSeconds": 30,
        "timeoutSeconds": 5,
        "failureThreshold": 4
      }
    }
  }
}
```

- **Sizing.** One `1Gi` (1 vCPU) instance in `iad1`. The work is I/O-bound (provider polling, then ingest to Storage)
  with `PRISM_STUDIO_WORKER_CONCURRENCY=2`.
- **Scaling.** Scale by instance count; the leases make several instances safe. Per-provider ceilings are enforced by
  the existing capacity reservation and the provider's own rate limits.
- **Grace period.** 120 s covers a normal tick. A longer ingest that is killed is resumed by lease expiry.

**Runtime environment of the worker project (names only).**

- `PRISM_STUDIO_WORKER_DB_URL`, `PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_URL`.
- `PRISM_STUDIO_GENERATION_PROVIDERS`, `PRISM_STUDIO_ALLOW_PAID_GENERATION`, `PRISM_STUDIO_MAX_GENERATION_USD`,
  `PRISM_STUDIO_WORKER_CONCURRENCY`, `PRISM_STUDIO_WORKER_HEALTH_PORT=8080`.
- `RUNWAYML_API_SECRET`, Production only, after the paid gate is authorized.
- In 5A.2: `PRISM_STUDIO_SUPABASE_REF` and `PRISM_STUDIO_ENVIRONMENT`.

## 6. Media daemon and the persisted media queue (5A.3)

- **A separate image**, `Dockerfile.media-worker`: the same base plus Debian `ffmpeg`/`ffprobe`. It needs its own
  `4Gi` (2 vCPU) instance in `iad1`. Episode renders may later justify `8Gi` or a second instance. Grace period 300 s;
  a longer render resumes by lease expiry and re-renders from its frozen plan.
- **Its own job domain**, not `generation_jobs`. Proposed migration **0051 `media_jobs`**:
  - `kind`: `delivery_conform` | `production_frame_conform` | `qa_frames` | `contact_sheet` | `episode_render`;
  - `status`, `lease_owner`, `lease_expires_at`, `attempt_count` and `next_run_at` (the same lease pattern);
  - `idempotency_key`, unique per project;
  - `plan` jsonb: the explicit conform or render plan (no silent crop: the plan names crop, letterbox or pillarbox and
    the exact parameters);
  - `source_asset_ids` and a frozen `source_fingerprint`;
  - `result_asset_id`, plus `error_category` and `error_code`.
- **RLS on `media_jobs`.** Owner select and insert (the user enqueues), owner cancel by status transition; no owner
  update of results.
- **The `prism_media_worker` role.** Least privilege, provisioned by script like the generation role. It may claim and
  update jobs, read sources, write results and `asset_derivations`, and touch nothing else. No SECURITY DEFINER.
- **Invariants carried over.** Provider originals are immutable. Every derived asset records its parent, operation and
  checksum in `asset_derivations`. Delivery selection stays in `attempt_deliveries`. An idempotency key resubmitted
  returns the same job.
- **Request path.** `createDeliveryConform` becomes "enqueue and return the job". The UI polls job state. ffmpeg never
  runs in a Vercel request.
- **Continuity.** The continuity worker becomes a third daemon (`continuity`, `1Gi`), using the media image because it
  needs ffmpeg for QA frames. The episode render job (`0052 episode_exports`) is 5B on top of `media_jobs`.

## 7. Security boundary

- **Web.** Web functions hold only the public Supabase URL and key, plus the web database URL (transaction pooler,
  RLS-preamble access). They **never** hold provider keys, worker database URLs or Storage secret keys. This is
  enforced by the separate worker projects (§3).
- **Database roles.** One role per daemon, least privilege, checked at startup (`current_user`). `db:worker-role`
  proves grants with real logins. #42 (the breadth of the worker Storage secret) and #47 (legacy anon grants) are
  closed in 5A before any customer data exists.
- **Credentials.** Provider credentials live only in the worker project's Production environment. They are never in
  an image, a log, the browser, or a preview.
- **Authorization.** Browser-visible plan state is never authorization. Spend is authorized server-side twice: at
  enqueue (account and plan limits, 5C) and again at provider-call time (the existing worker gate).

## 8. Cost controls

1. Deployment ceilings remain (`PRISM_STUDIO_ALLOW_PAID_GENERATION`, `PRISM_STUDIO_MAX_GENERATION_USD`). Paid
   generation stays off until a gate is authorized.
2. 5C adds per-account and per-plan credits and a hard spend ceiling, checked in the enqueue transaction.
3. The worker rechecks the spend gate at submit.
4. Humans choose models, with an estimate shown before submission. Prism never switches provider silently.
5. Daemon cost is provisioned memory (24/7) plus active CPU. The starting footprint is generation `1Gi` + continuity
   `1Gi` + media `4Gi`, about 6 GiB, around the clock, in each environment that runs daemons. Rates are confirmed on
   Vercel's pricing page before the first daemon deploy. Staging daemons can be scaled to 0 when idle.

## 9. Observability

- **Logs.**
  - Web runtime errors and daemon stdout/stderr go to Vercel Logs (`source:daemon`, `daemonName`).
  - Workers log structured, safe-field events only.
  - `/healthz` drives the liveness probe.
- **Owner/admin health page (5A.3).** It shows, from the database:
  - queue age by kind and status;
  - stuck jobs (lease expired, or no progress for N minutes);
  - failed jobs over the last 24 h, by error category;
  - provider error counts;
  - generation spend (estimated and actual, from `generation_costs`);
  - each worker's last-seen time.

  It reads aggregate-only views through a dedicated read-only operations role (no SECURITY DEFINER), is gated to an
  owner allowlist on the server, and never shows secrets, prompts or raw provider payloads.

- **Alerting (5A.3).** A scheduled check, through a Vercel cron route on the web project using the read-only role,
  raises an alert on stuck jobs, a rising failure rate, a stale worker, or spend near a ceiling. The delivery channel
  is an owner decision.

## 10. Acceptance gates

**5A.1 (this PR):**

- unit: liveness window, failure reporting, port parsing and the `/healthz` server; `run(onLoop)` reports ok and
  failed iterations, stops on abort, and an observer that throws cannot stop the worker;
- static: the image guarantees (no env files in context, no `ARG`, no credential, non-root, production mode,
  single-process command);
- the existing generation suite stays green;
- a local smoke of the container command with a curated environment against **staging** (mock only, no provider
  keys): fail-closed without a credential (exit 2); a dry run as the dedicated role with nothing due; a live loop with
  `/healthz` returning 200; no secret in any output.

**5A.2:**

1. The image builds and runs (`docker build` and `docker run`).
2. SIGTERM drains the in-flight tick and exits 0 inside the container.
3. The environment-scoped ref guard has tests, and destructive tooling refuses Production.
4. The staging workers project runs the generation daemon against DEV, mock only. A queued mock job completes with no
   terminal. Instance restart and deploy overlap are proven lease-safe. Logs show no secrets.
5. The Production rehearsal bootstrap passes the DB matrix.
6. The mock failure-simulation models are hidden in production.

**5A.3:** `media_jobs` migration (reviewed, applied to DEV), the media daemon (conform, QA frames, contact sheet), the
health page and alerts, #42 and #47.

## 11. Next slice

**5A.2 — environment-scoped Supabase targeting and the staging generation daemon:**

- de-pin the DEV ref safely;
- build and run the image;
- create `prism-studio-workers-staging` (after owner approval);
- deploy the generation daemon against DEV with mock providers only;
- rehearse the Production bootstrap on a throwaway project;
- hide the failure-simulation mocks from production.

No real provider calls, no Production project, and no public site.
