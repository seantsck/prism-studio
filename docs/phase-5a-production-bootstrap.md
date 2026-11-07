# Production Supabase bootstrap: rehearsal runbook (Phase 5A.2)

The procedure that creates customer Production is rehearsed first, end to end, on a **throwaway** Supabase project.
The throwaway project is created, verified, then deleted. Production itself is created later with the same steps, minus
the behaviour suites (§4). No step here touches the DEV/staging project (`lyqdxiyjperhniwhzsvg`). The environment guard
refuses it: `rehearsal` and `production` can never target DEV.

## 1. Create the throwaway project (owner, Supabase dashboard)

- Organization: the paid organization that will host Production, so backups and restore behave like Production.
- Name: `prism-studio-rehearsal`. Region: **AWS us-east-1** (the same as DEV and Vercel `iad1`). Compute: the smallest.
- A strong generated database password, stored only in the local `.env.rehearsal` (git-ignored by `.env*`).
- Auth:
  - email confirmations **on**;
  - Site URL `http://localhost:3101` for the rehearsal;
  - one test user created in the dashboard (Authentication → Users → Add user, auto-confirm) for the behaviour suites
    and the RLS checks. This user exists only in the throwaway project.

## 2. Local environment (`.env.rehearsal`, never committed, never printed)

```
NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT=rehearsal
NEXT_PUBLIC_PRISM_STUDIO_SUPABASE_REF=<rehearsal ref>
NEXT_PUBLIC_SUPABASE_URL=https://<rehearsal ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>
SUPABASE_DB_URL=postgresql://postgres.<rehearsal ref>:<password>@<pooler host>:5432/postgres      # session pooler
PRISM_STUDIO_DEV_USER_ID=<rehearsal test user UUID>
PRISM_STUDIO_DEV_USER_EMAIL=<rehearsal test user email>
PRISM_STUDIO_DEV_USER_PASSWORD=<rehearsal test user password>
```

The worker role URLs (`PRISM_STUDIO_WORKER_DB_URL`, `PRISM_STUDIO_CONTINUITY_DB_URL`) are added after step 3.4.

## 3. Bootstrap

Every command runs with `--env-file=.env.rehearsal`. The npm scripts hard-code `.env.local`, so they are invoked
directly. Each banner must show `Target Supabase project: <rehearsal ref> (rehearsal)`.

| #   | Command                                                                                             | Acceptance                                                                |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 3.1 | `node --env-file=.env.rehearsal scripts/db-migrate-dry-run-check.mjs`                               | the dry run applies 0001 → head, then rolls back; ledger empty afterwards |
| 3.2 | `node --env-file=.env.rehearsal scripts/db-migrate.mjs`                                             | exactly 0001 → head applied, `MIGRATION CHECKSUMS OK`                     |
| 3.3 | `node --env-file=.env.rehearsal scripts/db-validate.mjs`                                            | `STRUCTURE OK`; private `prism-assets` bucket (created by 0010/0034/0035) |
| 3.4 | `tsx --env-file=.env.rehearsal scripts/worker-db-provision.mts`, then `continuity-db-provision.mts` | dedicated worker roles; set their URLs in `.env.rehearsal`                |
| 3.5 | `tsx --env-file=.env.rehearsal scripts/worker-db-check.mts`                                         | the generation role logs in and holds only its grants                     |
| 3.6 | `node --env-file=.env.rehearsal scripts/db-migrate.mjs --check`                                     | head = repository head, nothing pending                                   |

## 4. Rehearsal-only verification (never on Production)

These write fixtures, then remove them. They are allowed in `rehearsal` and **refused in `production`** by the guard.

- `tsx --env-file=.env.rehearsal scripts/db-seed.mts`. This seeds the demo project the suites need, in the throwaway
  project only.
- `db:rls`, `db:worker-role` (real logins), `db:behavior`, `db:previs`, `db:blocking`, `db:lighting`,
  `db:spatial-source`, `db:spatial-passes`, `db:production-frames`, `db:setup-copy`, `db:setup-templates`,
  `db:generation`. Each runs as `tsx --env-file=.env.rehearsal scripts/<suite>.mts` and must be all green.
- A storage smoke: `node --env-file=.env.rehearsal scripts/db-storage-smoke.mjs`. Private reads are refused for
  `anon`.
- The **generation worker image against the rehearsal project**, mock only: one acceptance job end to end
  (`tsx --env-file=.env.rehearsal scripts/daemon-acceptance.mts` while the container runs with the rehearsal worker
  URL). This proves the Production-shaped database and the daemon image together.

## 5. Backup and restore drill

1. Take or confirm a backup (daily on paid plans; point-in-time recovery if that add-on is enabled).
2. Write a marker row through the app (a project named `restore-drill-<timestamp>`), wait for the next backup, delete
   the marker, then restore into a **new** project (the Supabase "restore to new project" flow). Never restore over
   the source project.
3. In the restored project, run `db:migrate --check` and `db:validate`, and confirm the marker is present.
4. Record the times: backup age, restore duration, and the time until the restored project validates.
5. Delete the restored project.

## 6. Teardown and record

- Delete the throwaway project. Remove `.env.rehearsal`.
- Record in Issue #44's successor (the Phase 5 tracking issue):
  - the migration head;
  - the suite counts;
  - the worker acceptance;
  - the restore timings;
  - anything that differed from this runbook. Fix the runbook before Production.

## 7. Production differences

- **Environment.** Set `NEXT_PUBLIC_PRISM_STUDIO_ENVIRONMENT=production`. Only `db-migrate-dry-run-check`,
  `db-migrate`, `db-validate`, `worker-db-provision`, `worker-db-check` and `continuity-db-provision` may run. Seeds,
  cleanups, behaviour suites and all dev-user tooling are refused by the guard.
- **Users.** No test users and no demo data. The first users sign up through the product (5C).
- **Web connection.** The web app uses the transaction pooler (port 6543). Daemons use the role URLs.
- **Backups.** Point-in-time recovery is enabled before the first customer, and the restore drill is repeated on
  Production's own backups before launch (5E).
