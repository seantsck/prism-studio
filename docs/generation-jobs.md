# Generation jobs: queue, worker, retries, cancellation

Request handlers never wait for a generation. Work is queued in Postgres and executed by a separate worker
process, so a video that takes minutes costs the web tier nothing and survives restarts.

## State machine (`domain/generation/job-state.ts`, mirrored by a DB trigger)

```
queued ──► submitting ──► submitted ──► processing ──► ingesting ──► succeeded
   ▲            │              │             │             │
   └─ transient ┘              └─────────────┴──► failed ◄─┘
any active ──► cancel_requested ──► cancelled        queued ──► cancelled (never reached a provider)
```

Statuses are **phases of work**. "A worker is on it right now" is a **lease** (`lease_owner`, `lease_token`,
`lease_expires_at`), so one mechanism covers submit, poll and ingest, and there is no separate "claimed" state to
get stuck in. Illegal transitions throw in the application (`IllegalTransitionError`) and are rejected by the
`guard_generation_job` trigger; `npm run db:generation` compares all 72 (from, to) pairs between the two.

## Claiming and leases

```sql
select id from generation_jobs
 where status in (…workable…) and next_run_at <= now
   and (lease_token is null or lease_expires_at <= now)
 order by queue_priority desc, next_run_at limit $n
 for update skip locked
```

then the rows are leased in the same statement. Properties:

- two workers never get the same job while a lease is valid (`SKIP LOCKED` + lease);
- a worker that dies loses its lease at `lease_expires_at`; another worker resumes the job;
- every write by a worker presents its `lease_token`; a stale worker gets `LeaseLostError` and abandons the job;
- a heartbeat (`PRISM_STUDIO_WORKER_HEARTBEAT_MS`) extends the lease during long steps.

`submitting` with an expired lease means "we may or may not have reached the provider". The job is re-run and
the provider receives the same **idempotency key**, so adapters/providers that support de-duplication do not
create a second paid generation. Adapters that cannot de-duplicate document the residual risk.

## Steps (one worker `tick`)

| Job status               | Work                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `queued`/`submitting`    | `adapter.submit` → `submitted` / `processing` / `ingesting`; schedule first poll            |
| `submitted`/`processing` | `adapter.poll`; schedule the next poll from the provider's hint (never tighter than 250 ms) |
| provider succeeded       | `ingesting`: `adapter.fetchResult` → validate → store → `finalizeSuccess` (one transaction) |
| `cancel_requested`       | `adapter.cancel` if supported → `cancelled` with an honest outcome                          |

Polling is persisted (`poll_count`, `last_polled_at`, `next_run_at`, `provider_status`), so it survives restarts
and never hammers a provider.

## Errors and retries

Adapters throw `GenerationProviderError(category, code, message)`:

| Category               | Retried?          | User sees                                                   |
| ---------------------- | ----------------- | ----------------------------------------------------------- |
| `transient`            | yes               | "The provider had a temporary problem. Prism will retry."   |
| `rate_limit`           | yes               | "The provider is rate limiting requests. Prism will retry." |
| `provider_unavailable` | yes               | "Provider temporarily unavailable."                         |
| `timeout`              | yes (per request) | "Generation timed out."                                     |
| `invalid_request`      | no                | "Model does not support this input."                        |
| `content_rejected`     | **never**         | "Generation rejected by provider."                          |
| `auth`                 | no                | "Prism could not authenticate with the provider…"           |
| `quota`                | no                | "Quota unavailable."                                        |
| `permanent`            | no                | "Generation failed."                                        |

Backoff is exponential (5 s base, 5 min cap, 20 % jitter, honours `Retry-After`) bounded by
`PRISM_STUDIO_GENERATION_MAX_ATTEMPTS` (default 4). A job that exceeds the model's `jobTimeoutMs` after
submission fails terminally with `job_timeout` (not retried). Stored error text is sanitized and carries a
stable code, never a payload, URL or credential.

## Cancellation

| When                                 | What happens                                                                                   | `cancel_outcome`           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------- |
| job still `queued`                   | cancelled immediately in Prism; nothing reached a provider                                     | `local_only`               |
| submitted, provider can cancel       | worker calls `adapter.cancel`; provider confirms                                               | `confirmed`                |
| submitted, provider cannot / refuses | cancelled **in Prism**; polling stops; UI states that the provider may still complete and bill | `not_supported` / `failed` |

Prism never claims a remote cancellation the provider did not confirm; billing is recorded as **unknown**.

## Idempotency and abuse protection

- `unique (project_id, idempotency_key)`; the key is deterministic per (shot, attempt number, package, model), so
  double clicks replay instead of duplicating.
- one active job per attempt (partial unique index) and per shot (checked under a project row lock).
- `PRISM_STUDIO_GENERATION_MAX_ACTIVE_PER_PROJECT` (default 3) and
  `PRISM_STUDIO_GENERATION_MAX_SUBMITS_PER_MINUTE` (default 10, per user).

## Running the worker

```
npm run worker:generation                    # long-running, Ctrl+C / SIGTERM finishes in-flight work
npm run worker:generation -- --until-idle    # one-shot (CI, tests)
npm run worker:generation -- --once          # one tick
npm run worker:generation -- --dry-run       # show what is due; touches nothing
```

It prints the target Supabase project, refuses any other, redacts everything, and has no Next.js dependency, so
it deploys unchanged to a VPS/container. Storage credentials: see [storage](storage.md) and
[security-model](security-model.md) (`PRISM_STUDIO_WORKER_SERVICE_KEY`).

Memory/demo mode has no database to share with a separate process, so the demo server runs the **same worker
loop in-process** (`PRISM_STUDIO_INLINE_WORKER=0` disables it).

## Observability

Structured JSON logs with an allow-list of fields (job/attempt ids, provider, model, status, durations, retry
counts, error category/code). Prompts, dialogue, base64 payloads, signed URLs, cookies and headers are never
logged; unknown fields are dropped, not redacted. The per-job **event timeline** (`generation_job_events`) is
shown on the attempt page.

## The worker's trust boundary (Phase 2B)

```
Browser / user ──► authenticated submission (RLS, spend gate) ──► frozen Attempt + authorised Job
                                                                   │
                                      queue (Postgres) ◄───────────┘
                                          │
                              Generation Worker  ── role prism_generation_worker (no password in git)
```

The worker takes **no** project/user id from any request. Everything it does is derived from persisted jobs it
claimed, and its database role can do nothing else:

- Role `prism_generation_worker` (migrations 0015–0017): NOLOGIN until `npm run worker:db:provision` sets a login
  password from `PRISM_STUDIO_WORKER_DB_PASSWORD`. Not superuser, **not BYPASSRLS**, no role/db creation, owns
  nothing, member of no role.
- `SELECT` on jobs; `UPDATE` only execution columns of jobs (status, lease, provider ids, errors, actual cost) and
  of attempts (status, output, duration, cost). Identity, frozen request, review fields: no privilege.
- Row visibility follows **active jobs**: an attempt, its project owner id and its INPUT assets are visible only
  while a job is in flight; finished history is out of reach.
- `INSERT` only: generated assets (purpose `generation_output`, source `provider_output`, only while a job is
  `ingesting`), outputs, `actual`/`unknown` costs, job events. No `DELETE`/`TRUNCATE` anywhere.
- No access to characters, Looks, dialogue, scripts, shots, bible, auth schema, Storage metadata or the migration
  ledger. `npm run worker:db:check` audits every column privilege against `scripts/lib/worker-role-spec.mjs`;
  `npm run db:worker-role` proves the can/cannot list as the real role, plus a full queue → worker → Mock → ingest
  flow under it.
- `PRISM_STUDIO_WORKER_DB_URL` is required. The worker verifies at startup that it really is that role and never
  falls back to the admin credential (development opt-in only: `PRISM_STUDIO_WORKER_DEV_ASSUME_ROLE=1`).
- Residual PUBLIC privileges (Supabase-managed, deliberately not revoked): schema `public` USAGE, EXECUTE on public
  functions (`is_project_owner`, `rls_auto_enable`), `TEMPORARY` on the database, SELECT on the `pg_stat_statements`
  views (statistics; query text is hidden from non-privileged roles). None grants table data.

Storage: the worker needs a **secret** key to write the private bucket (`PRISM_STUDIO_WORKER_SUPABASE_SECRET_KEY`,
legacy `PRISM_STUDIO_WORKER_SERVICE_KEY`). It exists only on the worker host, a publishable/anon key is refused,
and with no key the worker refuses to start in production. A narrower mechanism (per-object signed upload URLs
minted by the app) is possible future hardening.

## Cost and candidate sets (Phase 2E)

Costs stay per attempt (`generation_costs`: estimated at submission, then actual or unknown); a candidate set only
**groups** attempts and sums them. For a set the UI and the experiments page show: estimated total, actual total
(partial when some actual costs are unknown), winner cost, and spend on candidates a human rejected ("what exploring
cost", not a judgment). Gates, in order: `PRISM_STUDIO_ALLOW_PAID_GENERATION`, the per-generation ceiling
`PRISM_STUDIO_MAX_GENERATION_USD` for every candidate, then the set ceiling `PRISM_STUDIO_MAX_CANDIDATE_SET_USD`
(unset blocks paid sets) and `PRISM_STUDIO_MAX_CANDIDATES_PER_SET`. The user must confirm the displayed maximum
total; the server recomputes it. Model pricing is versioned configuration
([generation-model-catalog](generation-model-catalog.md)); historical cost is never re-priced.
