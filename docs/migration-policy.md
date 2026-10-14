# Migration policy

## Rules

1. **Never edit an applied migration.** Fix forward with a new numbered file.
2. Files are `supabase/migrations/NNNN_description.sql`, applied in lexical order, all pending files in **one
   transaction** (`scripts/db-migrate.mjs`).
3. Every applied file's SHA-256 is recorded in `public.prism_migrations` and re-verified on every run.
4. A pending file that sorts before an applied one, an applied file missing on disk, or an applied file whose
   checksum changed makes the runner refuse before touching anything.
5. Migrations are written to be safe on a database that already holds data (backfill, then constrain).

## The ledger

```sql
public.prism_migrations (
  name text primary key,
  applied_at timestamptz not null default now(),
  checksum text,                          -- sha256 hex, line endings normalised CRLF → LF
  checksum_baseline boolean not null default false
)
-- RLS enabled, no policies: not reachable through the API
```

`checksumOf` (`scripts/lib/migrations.mjs`) normalises `\r\n` to `\n` so a Windows checkout and a Linux checkout
agree. `planMigrations` is pure and unit tested (`scripts/lib/__tests__/migrations.test.ts`).

## Commands

| Command                    | Behaviour                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run db:migrate:check` | Read-only. Prints `ok` / `pending` / `CHANGED ON DISK` / "applied, no checksum recorded yet" per file; exits non-zero on any problem. Prints `MIGRATION CHECKSUMS OK` when clean. |
| `npm run db:migrate`       | Creates the ledger if needed, baselines un-checksummed applied files, applies pending files, commits.                                                                             |
| `npm run db:validate`      | Includes a ledger check next to the structural checks.                                                                                                                            |

Mismatch message: `Applied migration has changed on disk. Create a new migration instead.` (followed by the file names).

## Baselined migrations (0001–0005)

Checksums were introduced after `0001`–`0005` were applied. The runner recorded each file's **current** content
as its baseline (`checksum_baseline = true`). A baseline guarantees no further silent drift; it does **not**
prove the file equals the text that was originally executed.

Specifically, `0005` had been edited after its first application (the `shot_characters` FKs changed from
`RESTRICT` to `NO ACTION … DEFERRABLE INITIALLY DEFERRED`) and was re-applied by hand, so its baseline is the
current file, not necessarily the originally executed text. Only `0001`–`0005` carry `checksum_baseline = true`;
later files are checksummed when applied.

Some comments in `0001`–`0003` ("REVIEW ONLY. Not applied") and in `0010` (reference to a
`scripts/db-storage-setup.mjs` that does not exist) are stale. They are left as is: editing an applied file
would trip the checksum guard, and that is the point of the guard.

## History

| #    | File                                         | What it does                                                                                                                                                                                         |
| ---- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | `0001_core.sql`                              | `set_updated_at`, projects, bibles, assets, characters, identity refs, Looks, voice profiles, locations, props.                                                                                      |
| 0002 | `0002_production.sql`                        | Episodes, scenes, dialogue (`guard_locked_dialogue` trigger), directions, takes, shots and join tables, storyboard frames, generation attempts (`guard_attempt_history` trigger), continuity checks. |
| 0003 | `0003_rls_draft.sql`                         | `is_project_owner()` and ownership RLS policies on every project table (join tables authorise through their parent).                                                                                 |
| 0004 | `0004_reference_order_and_cache_columns.sql` | `shot_reference_assets.position` + unique `(shot_id, role, position)`; drops `shots.prep_score` / `ready_to_generate`.                                                                               |
| 0005 | `0005_shot_character_fk_no_action.sql`       | `shot_characters` character/Look FKs become `NO ACTION` + deferrable, so project cascade deletes work but direct deletes of used Looks are rejected.                                                 |
| 0006 | `0006_assets_hardening.sql`                  | Asset as production object: purpose, storage provider/bucket/path, filename, size, frame rate, sample rate, channels, notes, `created_by`, checks, unique `(bucket, object_path)`.                   |
| 0007 | `0007_performance_audio.sql`                 | Takes: `archived`, `archived_at`, `duration_source`; check archived ⇒ not selected; waveform wrapped as versioned object.                                                                            |
| 0008 | `0008_script_sources.sql`                    | `action_blocks`, `shot_script_sources`, dialogue source line range, RLS for both.                                                                                                                    |
| 0009 | `0009_freshness.sql`                         | Frame `approved_fingerprint`/`approved_at`; attempt `package_fingerprint`; `guard_attempt_history` extended to make it immutable.                                                                    |
| 0010 | `0010_storage.sql`                           | Private bucket `prism-assets` (50 MB, MIME allow-list), `storage_object_project_id()`, four ownership policies on `storage.objects`.                                                                 |
| 0011 | `0011_frame_approval_snapshot.sql`           | `storyboard_frames.approved_snapshot` JSONB (`parts` required) so staleness can name the changed parts.                                                                                              |

Later files (0012–0027) are documented in their own headers and in [generation-jobs](generation-jobs.md),
[continuity-analysis-jobs](continuity-analysis-jobs.md) and [generation-candidate-sets](generation-candidate-sets.md).
Notable fix-forward: **0027** replaces the review append-only guard so the `on delete set null` action of 0026's
`generation_reviews.candidate_set_id` is permitted (0026 is applied and therefore immutable).

## Adding a migration

1. Create `supabase/migrations/NNNN_name.sql` with the next number. Do not touch earlier files.
2. Add RLS in the same file for any new project-scoped table (`is_project_owner(project_id)` or via a parent).
3. Update the expected tables in `scripts/db-validate.mjs` and add invariants to `scripts/db-behavior.mjs`.
4. Update the Zod schema and `src/data/postgres-mapping.ts` if entities change.
5. `npm run db:migrate:check` (expect "Pending"), `npm run db:migrate`, then `db:validate`, `db:behavior`,
   `db:rls`. See [local-supabase](local-supabase.md).

## Gaps

- No down-migrations; rollback means a new forward migration.
- Applying is one transaction for the whole pending set, so a failing file rolls back all pending files.
- The ledger cannot prove what was executed before checksums existed (0001–0005, see above).
