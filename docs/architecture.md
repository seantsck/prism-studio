# Architecture

## Layers

```
app/ (routes, thin)            components/ (UI, no business rules)
        │                               │
        └────────────► server/ ◄────────┘     server actions: validate → call domain → persist
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
          domain/  (pure TS)      data/ (Repository interface, memory impl, seeds)
```

- **`domain/`** has no React, Next or Supabase imports. Everything is a pure function of typed data:
  `buildShotContext → runPreflight / computeShotDuration / assembleGenerationPackage / buildAnimaticTimeline`.
  This is what the unit tests cover and what a provider adapter or background worker would reuse unchanged.
- **`data/Repository`** is the only persistence boundary. `MemoryRepository` is the Phase 1 implementation.
  `PostgresRepository` (`PRISM_STUDIO_PERSISTENCE=supabase`) implements the same interface against `supabase/migrations/*`; it owns the
  camelCase ↔ snake_case mapping and the normalisation of embedded arrays (shot characters, dialogue links)
  into join tables.
- **`server/actions.ts`** is the only write path from the UI. Each action: parse `FormData` → load project →
  call a domain service → `Zod.parse` the resulting entity → `repo.upsert`. Components never mutate state.
- **Routes are thin.** Views in `components/views/*` are shared by project-level pages (`/projects/x/perform?ep=ep-1`)
  and episode-level pages (`/projects/x/episodes/ep-1/perform`).

## Key decisions

| Decision                                           | Reason                                                                                                                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain independent of AI providers                 | Providers change monthly; the package format must not. Adapters (Phase 2) translate `GenerationPackage` to payloads.                                                                   |
| Preflight is a rule table, not a function with ifs | Rules are data (`PREFLIGHT_RULES`). AI continuity checks can later be appended as additional rule sources without touching the evaluator.                                              |
| `ready_to_generate` is derived, not stored         | Computed live from required gates (no `prep_score`/`ready_to_generate` columns since migration 0004), so it cannot drift from reality.                                                 |
| Shot sections as JSONB, relations as tables        | Sections (camera, blocking, audio…) are edited as units and evolve quickly; characters/looks/dialogue/props are real FKs so integrity is enforced.                                     |
| Assets are rows, not URLs                          | Everything references `asset.id`. `StorageProvider` hides where bytes live (`LocalDiskStorage` now; Supabase Storage later).                                                           |
| Append-only generation history                     | Attempts snapshot the full package; DB trigger blocks edits to prompt/snapshot/settings.                                                                                               |
| Dialogue lock                                      | `locked` lines are immune to script sync and, in SQL, to text updates until unlocked.                                                                                                  |
| shadcn-style primitives, no CLI                    | `components/ui.tsx` follows the shadcn pattern (cva + tailwind-merge + CSS tokens) but is hand-written, so the dependency set stays small and `shadcn add` can still be adopted later. |
| Server actions + native forms                      | Zero client JS for CRUD; client components exist only where interaction demands it (animatic player, drag-reorder, audio duration probe).                                              |

## Storage

`StorageProvider { put, get }`. Dev: `.local-storage/<projectId>/<assetId>/<filename>`, served through
`/api/assets/[id]`. Production target: Supabase Storage bucket `prism-assets` with the same path scheme;
bucket policies derive ownership from the first path segment (see `0003_rls_draft.sql`).

## Auth / RLS

Ownership is `projects.user_id`; every child row carries `project_id` for a single indexed policy check.
RLS is drafted deliberately in `0003_rls_draft.sql` and is **not** assumed by the app: today the app runs with a
fixed local user id (`LOCAL_USER_ID`). Collaboration and billing are intentionally absent.

## Testing

- `src/domain/__tests__` — Vitest, no DOM: duration, take selection, Look linking, ordering, preflight,
  continuity requirements, generation package, seed schema validity, script sync, animatic timeline.
- `e2e/` — Playwright smoke tests against a production build.

## Not built yet

Provider adapters, queues, auth, Supabase Storage provider, 3D sets, NLE-grade editing — see [roadmap](roadmap.md).
