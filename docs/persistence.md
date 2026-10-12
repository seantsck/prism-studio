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
}
```

`CollectionName` covers assets, characters, identityRefs, looks, voiceProfiles, locations, props, episodes,
scenes, shots, dialogueLines, actionBlocks, directions, takes, frames, attempts, continuityChecks;
`COLLECTION_TABLES` maps each to its SQL table.

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
