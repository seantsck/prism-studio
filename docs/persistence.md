# Persistence

## The `Repository` interface

`src/data/repository.ts` is the only boundary the app uses:

```ts
interface Repository {
  currentUserId(): string;
  listProjects(): Promise<Project[]>;
  loadProject(slug): Promise<ProjectData | null>;     // whole project graph
  createProject(project, bible): Promise<void>;
  updateProject(project) / saveBible(bible): Promise<void>;
  upsert(projectId, collection, item) / upsertMany(projectId, collection, items): Promise<void>;
  remove(projectId, collection, id): Promise<void>;
  findAsset(assetId): Promise<Asset | null>;
  archivedProjectIds(): Promise<{ ids: Set<string>; available: boolean }>;
  setProjectArchived(projectId, archived): Promise<void>;
  activeProjectWork(projectId): Promise<string[]>;   // unfinished jobs, one line per kind
  deleteProject(projectId): Promise<void>;           // irreversible
}
```

`CollectionName` covers assets, characters, identityRefs, looks, voiceProfiles, locations, props, episodes,
scenes, shots, dialogueLines, actionBlocks, directions, takes, frames, attempts, continuityChecks;
`COLLECTION_TABLES` maps each to its SQL table.

## Archiving and deleting projects

On the Projects page each project has **Archive** (or **Restore**) and **Delete…**.

- **Character library** is `character_library` (migration `0062_character_library.sql`): one row per saved Character
  (`user_id`, `character_id`, `saved_at`; unique per user and Character), owner-only RLS (the saver, for a Character
  in a project they own), cascading from the Character (so from its project). `libraryEntries()` reads it
  defensively (undefined table → `available: false`).
- **Episode length** is `episodes.target_minutes` (migration `0061_episode_length.sql`; nullable integer, 1–600). It is an
  optional column (`CollectionSpec.optional`): an Episode that has none stored is written without it, so every write
  works before `0061` is applied; setting a length before then fails with a message naming the migration.
- **Delete character / location** sets `characters.trashed_at` / `locations.trashed_at` (migration
  `0064_character_location_trash.sql`, optional columns written only when set); see docs/reference-studio.md.
- **Delete project** sets `projects.trashed_at` (migration `0063_project_trash.sql`): the project goes to the Trash on
  the Projects page, out of `listProjects` and not openable (`loadProject` returns null unless `includeTrashed`), for
  30 days; **Restore** clears it; **Delete now** (exact title typed) or 30 days later (`purgeExpiredProjects`, when the
  Projects page is opened) runs the old cascade delete and removes its stored files. A new project never takes a
  trashed project's slug. Until `0063` is applied, Delete says the migration is needed.
- **Archive** sets `projects.archived_at` (migration `0060_project_archive.sql`). The project leaves the list for an
  **Archived (N)** section; nothing in it changes and it still opens by URL. Until `0060` is applied, the column is read
  defensively: the list works, nothing is archived, and Archive answers that it needs the database update (code can ship
  before the migration).
- **Delete** asks for the project's exact title (the button stays off until it matches; the server checks it again),
  refuses while any job for the project is queued or running (generation, continuity, reconstruction, render, story,
  writing, shot list, shot direction), then runs one `delete from projects` as the owner. Every project-scoped table
  cascades from `projects`. The stored files of its assets are removed afterwards, best effort.
- Verified on a disposable local PostgreSQL with all migrations and the seed (`docs/local-supabase.md`): as the owner
  under RLS, the delete emptied all 18 populated project tables (135 rows); another user could not delete it; a queued
  story analysis was counted; and without `0060` the list and project edits still worked.

## Implementations

| Class              | File                              | Used by                       | Security context                                              |
| ------------------ | --------------------------------- | ----------------------------- | ------------------------------------------------------------- |
| `MemoryRepository` | `src/data/memory-repository.ts`   | memory mode, memory e2e       | none; in-process, seeded from `src/data/seed.ts`              |
| `UserRepository`   | `src/data/postgres-repository.ts` | **the app** (supabase mode)   | RLS enforced: role `authenticated` + the user's JWT claims    |
| `AdminRepository`  | `src/data/postgres-repository.ts` | scripts only (seed, exercise) | bypasses RLS; scopes every query to an explicit owner user id |

Both Postgres classes extend one abstract base and differ only in `preamble()`, the SQL that opens each
transaction.

### Memory mode

`getRepo()` (`src/server/repo.ts`) keeps one `MemoryRepository` on `globalThis`. State lives for the lifetime
of the server process. There are no accounts; the owner is the fixed `LOCAL_USER_ID`.

### Supabase mode: how RLS is enforced

The pool (`src/server/db.ts`) is a privileged connection (`SUPABASE_DB_URL`). The app never runs statements on
it directly; `UserRepository` opens every transaction with `rlsPreamble`:

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated","aud":"authenticated","email":"…"}', true)
```

This is what PostgREST does for a request carrying that JWT, so `auth.uid()` and the policies from
`0003_rls_draft.sql` / `0008` / `0010` evaluate as that user. The subject must be a UUID taken from a verified
session (`getClaims()`); `UserRepository` throws otherwise. `set local` scopes the role and claims to the
transaction, so pooled connections do not leak identity.

`AdminRepository.preamble()` is just `begin`; it exists so seed/exercise scripts can act for the dev user
without a browser session. The application never constructs it.

### Behaviour worth knowing

| Aspect          | Detail                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership check | Every write also calls `assertOwns(projectId)` (`select 1 from projects where id and user_id`), in addition to RLS.                                                                                     |
| `loadProject`   | Runs one query per collection and join table, spread over up to 5 pooled connections, each its own RLS transaction. It is **not** one snapshot.                                                         |
| Join tables     | Shots and scenes are written by delete-then-insert of `shot_characters`, `shot_props`, `shot_dialogue_lines`, `shot_reference_assets`, `shot_script_sources` (resp. `scene_characters`, `scene_props`). |
| Write ordering  | `upsertMany` writes rows being switched OFF before rows switched ON (partial unique indexes: one selected take, one approved frame/attempt) and orders shots so `previous_shot_id` targets exist first. |
| Validation      | Every write `Zod`-parses the entity; every read is parsed with the entity schema.                                                                                                                       |
| Mapping         | camelCase ↔ snake_case, embedded arrays ↔ join tables in `src/data/postgres-mapping.ts` (unit tested).                                                                                                  |
| Guard rails     | `getPool()` refuses a connection string that does not contain the dedicated project ref.                                                                                                                |

## Storage of bytes

Assets are rows; bytes live behind `StorageProvider`. See [storage](storage.md).

## Schema

Migrations `0001`–`0011` in `supabase/migrations/`; policy and history in [migration-policy](migration-policy.md).
Entity-to-table mapping in [domain-model](domain-model.md).

## Generation persistence (Phase 2A)

Generation does not go through `Repository.loadProject`. Two narrow interfaces
(`src/data/generation-repository.ts`) with memory and Postgres implementations:

- `GenerationRepository` — application path: `createAttemptWithJob` (one transaction), `listShotAttempts`,
  `listActiveProjectJobs`, `listProjectGenerations`, `getJob`, `requestCancel`, `reviewAttempt`. In supabase
  mode it runs under the same RLS preamble as the project repository.
- `GenerationStore` — worker path: `claim` (`FOR UPDATE SKIP LOCKED` + lease), `heartbeat`, `update`,
  `finalizeSuccess` (assets + outputs + attempt result + cost + job, atomic), `recordUnknownCost`.

Status refreshes use only these (never a whole-project load).
