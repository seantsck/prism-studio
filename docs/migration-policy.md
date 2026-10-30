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

Later files (0012–0039) are documented in their own headers and in [generation-jobs](generation-jobs.md),
[continuity-analysis-jobs](continuity-analysis-jobs.md) and [generation-candidate-sets](generation-candidate-sets.md).
Notable fix-forward: **0027** replaces the review append-only guard so the `on delete set null` action of 0026's
`generation_reviews.candidate_set_id` is permitted (0026 is applied and therefore immutable). **0028** adds the
explicit `projects.is_benchmark` classification (default false; no data is reclassified by SQL, never inferred from a
slug) and a trigger that refuses a human review for an attempt that has not succeeded. **0029** replaces that boolean
with the extensible `projects.purpose` enum (`production` default, `benchmark`, `test`; existing `is_benchmark = true`
rows become `benchmark`) and drops `is_benchmark`. **0039** (Phase 2G.1) adds the immutable
`shot_production_frames` history, the one-per-Shot `shot_production_frame_selections` pointer (composite FKs keep a
selection inside its own Shot and Project) and the `production_frame` asset purpose; owner-only RLS, no worker
grant ([production-frames](production-frames.md)). **0040** (Phase 2G.3) adds the immutable `location_views` (composite
FKs to the Location and the Asset, an Asset-facts trigger, an update guard) and the one-per-Shot
`shot_location_view_selections` pointer (composite FK carrying the view's Location, a same-Location trigger, and a trigger
on `shots.location_id` that clears a selection of the old Location's view); owner-only RLS, no worker grant, no new
asset purpose ([location-views](location-views.md)). **0041** (Phase 2G.4) adds:

- the immutable `character_continuity_locks` (facts by value, composite FK to the Character, a Look-of-this-Character
  trigger, an update guard, `unique (character_id, lock_fingerprint)`);
- their frozen `character_continuity_lock_assets` (an Asset-facts trigger, an update guard, deferred membership
  triggers: complete at commit, never grows);
- the one-per-assignment `shot_character_continuity_selections` pointer (composite FK carrying the Lock's Character,
  FK to the `shot_characters` row with cascade, a same-Look trigger, and a trigger on `shot_characters.look_id` that
  clears an incompatible selection);
- owner-only RLS and no worker grant.

The Postgres Shot write now updates `shot_characters` rows in place instead of re-creating them, so an unrelated Shot
save keeps those selections. **0042** is a fix-forward for 0041 (applied, therefore immutable): the Lock image → Asset
FK becomes `DEFERRABLE INITIALLY DEFERRED`, as 0005 did for `shot_characters`. A Project cascade can then pass through
Lock images, while a direct delete of an Asset a Lock froze is still refused at commit
([character-continuity-locks](character-continuity-locks.md)). **0043** (Phase 2I.1B, applied to hosted DEV after explicit
approval) adds the persisted Episode edit: `episode_edits` (one per Episode via the
removable `episode_edits_one_per_episode`, rational edit rate, revision counter), `episode_edit_items` (explicit
deferred-unique order, picture by kind with a kind/column check and a source trigger, removable one item per Shot) and
`episode_edit_audio_placements` (line + take references, inside the item in 2I.1); every source key is deferred NO
ACTION (the 0042 lesson), owner-only RLS, no worker grant
([timeline-performance-assembly](timeline-performance-assembly.md)).

**0044** (Phase 3A.2, **applied to hosted DEV on 2026-10-28**) adds `project_qa_policies` (one owner-only Shot QA
automation policy per Project; `semantic_mode` default `off`; `automatic` must name an analyzer, carry media consent and
two finite ceilings, database-enforced; revision for optimistic concurrency; no grant to `anon` or either worker role)
and the nullable `continuity_runs.automation_key` (unique per Project when set, frozen by the run guard; historical rows
null) ([automatic-shot-qa](automatic-shot-qa.md)). Hosted gate: `db:migrate:dry-run-check` 7/7, `--dry-run` rehearsal
rolled back (ledger unchanged), then `db:migrate` applied exactly 0044 (ledger 44 rows, checksum
`31abe729026e1c89b9590d9167b2d608b1747de4bae72fdf7bcdb7961b72dcd7`, 0043 unchanged, `MIGRATION CHECKSUMS OK`);
historical QA rows unchanged, 0 non-null automation keys, 0 policy rows; `db:validate` STRUCTURE OK, `db:behavior` 55/55,
`db:rls` 67/67, `db:worker-role` 58/58 (REAL LOGIN), `db:continuity-analysis` 78/78, `db:media-qa` 39/39, hosted
browser E2E 40/40.

**Table grants (Supabase default privileges).** Like 0040-0043, 0044 relies on the project's default privileges to give
`authenticated` (the role the app uses via `set local role authenticated`) access to a new table, guarded by RLS, and
revokes `anon` explicitly. Supabase stops granting new `public` tables to `anon` / `authenticated` / `service_role`
automatically (default for new projects from 2026-05-30, enforced on existing projects from 2026-10-30; existing
tables keep their grants). **From 0045 on, a migration that creates a table must grant `authenticated` explicitly**
(and never `anon` unless intended).

`npm run db:migrate -- --dry-run` rehearses the pending files: they are applied for real inside the transaction, which
is then **always rolled back** (nothing persists). Use it before applying a migration to the hosted project.

**0045** (Phase 3A.3, **applied to hosted DEV on 2026-10-28**) adds `project_qa_policies.direct_video_allowed boolean
not null default false`: the owner's explicit permission to send the FULL selected delivery video for temporal Shot QA
([temporal-video-qa](temporal-video-qa.md)). One column, no new table (so no new-table grant is needed), no grant,
revoke or policy change; every existing policy gets `false`. Hosted gate: `db:migrate:dry-run-check` 7/7, `--dry-run`
rehearsal rolled back (ledger unchanged, column absent), then `db:migrate` applied exactly 0045 (ledger 45 rows,
checksum `44cc9360b867cc1d30b5fa8d758eca311f56b01d3485bb100d235c87d265d325`, 0044 unchanged, `MIGRATION CHECKSUMS OK`);
column `boolean not null default false`, RLS and the single owner policy unchanged, no column grant to `anon` or either
worker role, 0 policies with `direct_video_allowed = true`; `db:validate` STRUCTURE OK, `db:behavior` 57/57, `db:rls`
67/67, `db:worker-role` 60/60 (REAL LOGIN), `db:continuity-analysis` 80/80, `db:media-qa` 39/39, narrow repository
acceptance on a disposable Project 15/15, hosted browser E2E 40/40; counts and Storage back to baseline afterwards.

**0046** (Phase 3A.4C, **NOT applied to hosted**; verified on a disposable local PostgreSQL only) adds
`continuity_runs.subject_kind` / `continuity_analysis_jobs.subject_kind` (`attempt` | `transition`, default `attempt`
for every existing row, otherwise unchanged; shape checks; a kind-aware run key the job references), re-creates both
continuity guards with every field they froze before plus `subject_kind`, creates `continuity_transition_subjects`
(the frozen 1:1 subject of a transition run; historical edit / item / Shot ids, not cascading keys; immutable; exactly
one per transition run at commit; numbered per transition; **explicit grants**: `authenticated` SELECT + INSERT only,
owner RLS, nothing for `anon` or either worker role), and adds `episode_edit_items.incoming_cut_intent` (validated JSON,
predecessor-bound at commit) ([sequence-continuity-supervisor](sequence-continuity-supervisor.md#3a4c-implementation-notes)).
Disposable gate: 0001–0045 apply unchanged through the Supabase shim; `--dry-run` rehearsal of 0046 rolled back; 0046
applied; historical rows unchanged (backfill proof); `db:validate` STRUCTURE OK, `db:behavior` 61/61,
`db:sequence-continuity` 70/70, `db:media-qa` 39/39, `db:continuity-analysis` 81/81, `db:episode-edits` 94/94,
`db:worker-role` 57/63 (the 6 generation end-to-end timing checks fail identically at 0045 on the loopback harness).
Read-only `db:migrate:check` on hosted: 0001–0045 ok, 0046 pending.

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
