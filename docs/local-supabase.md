# Local development against Supabase

## What "local" means here

There is **no Supabase CLI local stack** in this repo (no `supabase/config.toml`, no `supabase start`). Local
development runs the Next.js app on your machine against the **single dedicated Prism Studio Supabase project**
(ref `lyqdxiyjperhniwhzsvg`). Every script and the app itself refuse a connection string or URL that does not
contain that ref, so they cannot be pointed at a local stack or another project without changing code.

Memory mode needs none of this: `npm run dev` with no `.env.local`.

## Setup

1. In the Supabase dashboard of the dedicated project create one Auth user (email + password).
2. `cp .env.example .env.local` and fill in:

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://lyqdxiyjperhniwhzsvg.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>
   SUPABASE_DB_URL=<session-pooler connection string>      # server-only secret
   PRISM_STUDIO_PERSISTENCE=supabase
   PRISM_STUDIO_DEV_USER_ID=<auth user uuid>                # scripts only
   PRISM_STUDIO_DEV_USER_EMAIL=<optional cross-check>
   ```

   `.env*` is git-ignored except `.env.example`. Scripts load it via `node --env-file=.env.local` (or
   `tsx --env-file=.env.local`); Next loads it on its own.

3. `npm run db:migrate:check`, then `npm run db:migrate`, `npm run db:validate`, `npm run db:seed`.
4. `npm run dev`, sign in at `/login`.

`.env.example` currently lists only the Supabase URL/key, DB URL, persistence mode and dev user id; add the
optional variables above and the test variables from the [README](../README.md) yourself.

## Tool reference

| Script                    | Mutates?                       | Needs dev user | What it checks / does                                                                                                                                                                      |
| ------------------------- | ------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db:inspect`              | no                             | no             | Database name, public tables, `auth.users` count, buckets.                                                                                                                                 |
| `db:migrate:check`        | no                             | no             | Checksums of applied files, pending list ([migration-policy](migration-policy.md)).                                                                                                        |
| `db:migrate`              | yes (schema + ledger)          | no             | Applies pending migrations in one transaction.                                                                                                                                             |
| `db:validate`             | no                             | no             | Expected tables, RLS enabled, policies, indexes, triggers; bucket is private and has no anon/public policy; ledger consistent.                                                             |
| `db:behavior`             | no (always rolled back)        | yes            | About 40 constraint, trigger and RLS invariants in one transaction (unique selected take, immutable attempt history, archived ≠ selected, cross-user insert denied, …).                    |
| `db:rls`                  | cleans up after itself         | yes            | About 54 checks: `UserRepository` vs `AdminRepository`, raw RLS SQL under `rlsPreamble` for every project table, stranger reads/writes denied, Storage policies. Requires `db:seed` first. |
| `db:seed`                 | yes (demo project)             | yes            | Seeds `buildSeedProject()` for the dev user via `AdminRepository`. `-- --reset` deletes the demo project (cascade) and re-seeds.                                                           |
| `db:exercise -- baseline` | no                             | yes            | Seeded project loads and equals `buildSeedProject()`.                                                                                                                                      |
| `db:exercise -- mutate`   | yes (demo project, idempotent) | yes            | Shot update, Look assignment, take selection, frame approval, attempt.                                                                                                                     |
| `db:exercise -- verify`   | no                             | yes            | In a fresh process, every mutation persisted. Restore with `db:seed -- --reset`.                                                                                                           |

Typical full check after a migration or persistence change:

```bash
npm run db:migrate:check && npm run db:migrate && npm run db:validate
npm run db:seed -- --reset
npm run db:behavior && npm run db:rls
npm run db:exercise -- baseline && npm run db:exercise -- mutate && npm run db:exercise -- verify
npm run db:seed -- --reset
```

## Safety rails (`scripts/lib/safety.mjs`, `scripts/lib/dev-user.mjs`)

| Rail                | Behaviour                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ref guard           | `assertProjectRef`: connection string must contain the dedicated ref, before any connection.                                                                   |
| Banner              | Before the first statement: project ref, host:port/db (never user or password), mode, dev owner.                                                               |
| Redaction           | Postgres URL passwords, JWT-shaped tokens, `sb_secret_*` / `sb_publishable_*` keys and literal secret env values are masked, including in uncaught exceptions. |
| Dev user validation | `PRISM_STUDIO_DEV_USER_ID` must be a UUID (not an email) and must exist in `auth.users`; if `PRISM_STUDIO_DEV_USER_EMAIL` is set it must match.                |
| Isolated app        | The app never reads the dev user variable (unit test `application code never reads PRISM_STUDIO_DEV_USER_ID`).                                                 |
| Rollback            | `db:behavior` and the mutating parts of `db:rls` run inside transactions that roll back.                                                                       |
| Memory e2e          | `playwright.config.ts` forces `PRISM_STUDIO_PERSISTENCE=memory` and an empty `SUPABASE_DB_URL`.                                                                |

## Signed-in browser tests

`npm run test:e2e:supabase` builds the app and runs `e2e/supabase-auth.spec.ts` on port 3101 (memory-mode e2e uses 3102; the dev server owns 3100) against the real
project. It reads `PRISM_STUDIO_DEV_USER_EMAIL` / `PRISM_STUDIO_DEV_USER_PASSWORD` from `.env.local`; both are required and
are the one local dev user (the suite fails loudly without them). Run `db:seed -- --reset` first
so the demo project is pristine; the flow restores what it changes and deletes what it uploads.

## Known limitations

- One shared remote database: there is no per-developer or throwaway environment.
- There is no script that creates the dev Auth user (removed: it could only use the e-mail sign-up flow). Create the
  user in the Supabase dashboard (Authentication → Users) and put its UUID in `PRISM_STUDIO_DEV_USER_ID`.
- Counts such as "about 40" and "about 54" are what the scripts reported when written; some checks are
  generated in loops, so read the script's own summary line.
