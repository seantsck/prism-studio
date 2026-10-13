# Prism Studio

An AI filmmaking **production operating system**. Not another video generator: Prism Studio prepares every
shot so thoroughly that downstream image/video/audio models receive a production-ready package instead of a
vague prompt.

```
SCRIPT → PERFORMANCE → BREAKDOWN → SHOT DESIGN → STORYBOARD → ANIMATIC → 3D SET / BLOCKING → GENERATION → CONTINUITY QA → EDIT
```

Two principles drive the design:

1. **Never ask a generation model to remember what Prism Studio can store explicitly.** Looks, sets, camera,
   blocking, constraints and timing are stored as structured data and assembled into a generation package.
2. **Timing originates from the selected performance.** A dialogue shot's duration is
   `pre-roll + selected take(s) + gaps + post-roll`, not an arbitrary video length.

Production domain: `studio.prismsuite.io` (not deployed). Standalone repo, separate from PrismSuite.

## Status (Phase 2A)

Planning, performance, storyboard and animatic are implemented, on two persistence backends:

- **memory mode** (default): in-process repository with a seeded demo project, no accounts, files on local disk.
- **supabase mode**: Postgres + Supabase Auth + private Storage bucket, ownership enforced by Row Level Security.

**Generation infrastructure (Phase 2A)**: a durable, provider-independent pipeline (frozen attempts, Postgres
job queue, worker process, output ingestion into private Storage, review) with a free **MockProvider**. No real
provider is integrated yet and the app is not deployed. See [docs/generation-architecture.md](docs/generation-architecture.md)
and [docs/roadmap.md](docs/roadmap.md) (including "Known gaps").

## Quick start: memory mode

```bash
npm install
npm run dev          # http://localhost:3100
```

Boots with a seeded Japanese-drama demo project (Episode 1 "The Arrangement"). Edits live for the lifetime of
the dev server process; uploads go to `.local-storage/` (git-ignored). No `.env.local` is required.

### Try generation (no cost)

Shot Prep → section **19 · Generate** (open any READY shot, e.g. 3A). Choose "Mock Video 1", Generate, and watch
the attempt go queued → generating → ready for review. In memory mode the demo server runs the worker in-process.

## Quick start: supabase mode

Prerequisites: the dedicated Prism Studio Supabase project with migrations applied, and one Auth user
(email + password) created in the Supabase dashboard.

```bash
cp .env.example .env.local   # fill in the values below
npm run db:migrate:check     # read-only: are all migrations applied and unchanged?
npm run db:migrate           # apply pending migrations (one transaction)
npm run db:seed              # seed the demo project for PRISM_STUDIO_DEV_USER_ID (--reset to rebuild)
PRISM_STUDIO_PERSISTENCE=supabase npm run dev   # or set it in .env.local
```

Open http://localhost:3100, you are redirected to `/login`; sign in with the Auth user's email and password.
Details: [docs/auth.md](docs/auth.md), [docs/persistence.md](docs/persistence.md),
[docs/local-supabase.md](docs/local-supabase.md).

## Environment variables

| Variable                               | Used by        | Purpose                                                                                              |
| -------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `PRISM_STUDIO_PERSISTENCE`             | app            | `supabase` enables Postgres/Auth/Storage. Anything else (or unset) = memory mode.                    |
| `NEXT_PUBLIC_SUPABASE_URL`             | app (supabase) | Project URL. Must contain the dedicated project ref `lyqdxiyjperhniwhzsvg` or the app refuses.       |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | app (supabase) | Publishable (anon-class) key; safe to expose, useless without a session + RLS.                       |
| `SUPABASE_DB_URL`                      | app + scripts  | Session-pooler Postgres connection string. **Server-only secret.** Must contain the project ref.     |
| `PRISM_STUDIO_DEV_USER_ID`             | scripts only   | UUID of the Auth user that owns seeded/test data. Never read by the app (a unit test enforces this). |
| `PRISM_STUDIO_DEV_USER_EMAIL`          | scripts only   | Optional cross-check against `auth.users.email` for the dev user.                                    |
| `PRISM_STUDIO_TEST_EMAIL`              | Playwright     | Account for the signed-in e2e flow.                                                                  |
| `PRISM_STUDIO_TEST_PASSWORD`           | Playwright     | Its password. Without it the signed-in flow is skipped.                                              |

| `NEXT_PUBLIC_SITE_URL` | app | Public origin of this app (`http://localhost:3100`; `https://studio.prismsuite.io` in production). |
| `PRISM_STUDIO_GENERATION_PROVIDERS` | app + worker | Comma list of enabled provider ids. `mock` is on by default outside production. |
| `PRISM_STUDIO_ENABLE_MOCK_PROVIDER` | app + worker | `1` enables the Mock provider in a production build. |
| `PRISM_STUDIO_PROVIDER_<ID>_API_KEY` | app + worker | Per-provider credential (**server-only**; names only in `.env.example`). |
| `PRISM_STUDIO_WORKER_SERVICE_KEY` | **worker only**| Server key the worker uses to write generated files to private Storage. Never in the app/browser. |

The web app uses no service-role / secret key. The generation **worker** may hold one server-only storage key
(`PRISM_STUDIO_WORKER_SERVICE_KEY`) — see [docs/security-model.md](docs/security-model.md#generation-and-outputs).
Generation limits and worker tuning: `PRISM_STUDIO_GENERATION_*`, `PRISM_STUDIO_WORKER_*` ([generation-jobs](docs/generation-jobs.md)).

## npm scripts

| Command                           | Purpose                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run dev` / `build` / `start` | Next.js 16 dev server / production build / serve the build                                   |
| `npm run typecheck`               | `tsc --noEmit`                                                                               |
| `npm run lint`                    | ESLint                                                                                       |
| `npm run format` / `format:check` | Prettier                                                                                     |
| `npm test` / `test:watch`         | Vitest unit tests (domain, mapping, upload policy, audio analysis, migration/safety helpers) |
| `npm run test:e2e`                | Playwright, memory mode (forces `PRISM_STUDIO_PERSISTENCE=memory`, never touches a database) |
| `npm run test:e2e:supabase`       | Playwright with real Supabase Auth (needs `PRISM_STUDIO_TEST_PASSWORD`; skipped without it)  |
| `npm run db:inspect`              | Read-only: tables, auth user count, buckets                                                  |
| `npm run db:migrate`              | Apply pending migrations; records SHA-256 checksums; refuses if an applied file changed      |
| `npm run db:migrate:check`        | Read-only checksum / pending verification (`--check`)                                        |
| `npm run db:validate`             | Read-only structure check: tables, RLS, policies, indexes, triggers, storage bucket, ledger  |
| `npm run db:behavior`             | ~40 constraint/trigger/RLS invariants in one transaction that is always rolled back          |
| `npm run db:rls`                  | App-level RLS + Storage policy integration checks (`UserRepository` and raw RLS SQL)         |
| `npm run db:seed`                 | Seed the demo project for the dev user (`-- --reset` deletes and re-seeds it)                |
| `npm run db:exercise -- <phase>`  | `baseline`, `mutate`, `verify` persistence round-trip across separate processes              |
| `npm run db:generation`           | Live generation integration: queue, worker + Mock provider, RLS, state machine, invariants   |
| `npm run worker:generation`       | The generation worker (`-- --until-idle`, `--once`, `--dry-run`)                             |

Every `db:*` script prints a banner (project ref, safe host, mode, dev owner) before mutating, redacts
secrets from output and refuses a connection string without the dedicated project ref.
See [docs/local-supabase.md](docs/local-supabase.md).

Playwright installs its browser separately: `npx playwright install chromium`.

## Documentation index

| Doc                                                        | Topic                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| [architecture](docs/architecture.md)                       | Layers, request flow, key decisions, testing                       |
| [domain-model](docs/domain-model.md)                       | Entities, invariants, SQL mapping                                  |
| [persistence](docs/persistence.md)                         | Repository interface, memory vs Postgres, RLS preamble             |
| [auth](docs/auth.md)                                       | Sign-in, session verification, route protection                    |
| [storage](docs/storage.md)                                 | Private bucket, object keys, signed URLs, upload policy            |
| [asset-lifecycle](docs/asset-lifecycle.md)                 | Upload → metadata → where-used → delete protection, audio pipeline |
| [performance-workflow](docs/performance-workflow.md)       | Dialogue, directions, takes, waveform, timing                      |
| [animatic](docs/animatic.md)                               | Timeline model, player, clocks, shortcuts                          |
| [script-coverage](docs/script-coverage.md)                 | Script → action blocks → shots traceability and coverage           |
| [production-workflow](docs/production-workflow.md)         | End-to-end creative workflow and freshness signals                 |
| [shot-prep](docs/shot-prep.md)                             | Shot Prep sections and preflight rules                             |
| [generation-package](docs/generation-package.md)           | Package v2 contract, brief, attempts                               |
| [generation-architecture](docs/generation-architecture.md) | Attempt vs job, layers, submission, derived lifecycle              |
| [generation-jobs](docs/generation-jobs.md)                 | Queue, leases, worker, retries, cancellation, idempotency          |
| [provider-contract](docs/provider-contract.md)             | Adapter interface, capabilities, compatibility rules               |
| [adding-a-provider](docs/providers/adding-a-provider.md)   | Step-by-step guide, tests and security checklist                   |
| [generation-review](docs/generation-review.md)             | Approve/reject, rejection categories, history guarantees           |
| [local-supabase](docs/local-supabase.md)                   | Environments, DB tooling and safety rails                          |
| [migration-policy](docs/migration-policy.md)               | Forward-only migrations, checksums, history 0001–0014              |
| [security-model](docs/security-model.md)                   | Trust boundaries, enforcement layers, residual risks               |
| [roadmap](docs/roadmap.md)                                 | Phases and known gaps                                              |

## Where to look

| Path                          | What                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `src/domain/`                 | Pure domain: schemas, preflight, timeline, fingerprints, package, animatic, coverage. No I/O. |
| `src/data/`                   | `Repository`, `MemoryRepository`, `PostgresRepository` (User/Admin), seed fixtures.           |
| `src/server/`                 | Server-only: auth, repository per request, storage providers, DB pool, server actions.        |
| `src/lib/`                    | Upload policy, audio analysis, storage paths, `@supabase/ssr` clients.                        |
| `src/proxy.ts`                | Next 16 proxy (formerly middleware): session refresh and route protection.                    |
| `src/app/`, `src/components/` | Routes (thin) and UI.                                                                         |
| `src/generation/`             | Provider contract, registry, Mock provider, worker, output ingestion, SSRF-safe fetch.        |
| `supabase/migrations/`        | Forward-only SQL, `0001`–`0014`.                                                              |
| `scripts/`                    | Guarded database tooling.                                                                     |
| `e2e/`                        | Playwright specs.                                                                             |
