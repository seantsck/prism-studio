# Architecture

## Layers

```
src/domain   pure TypeScript: schemas, preflight, timeline, fingerprints, package, animatic, coverage
   ▲
src/data     Repository interface · MemoryRepository · PostgresRepository (UserRepository / AdminRepository)
   ▲
src/server   auth.ts · repo.ts · storage.ts · db.ts · actions.ts · action-result.ts · generation-package.ts
   ▲
src/app (routes) · src/components (UI)         src/proxy.ts (route protection)    src/lib/supabase/* (@supabase/ssr clients)
```

- **`domain/`** has no React, Next, Node or Supabase imports (SHA-256 is hand-written in `hash.ts` for this
  reason). Everything is a pure function of typed data:
  `buildShotContext → runPreflight / timelineFromContext / assembleGenerationPackage / buildAnimaticTimeline /
buildEpisodeCoverage / storyboardFreshness`. The unit tests cover this layer.
- **`data/`** is the only persistence boundary. See [persistence](persistence.md).
- **`server/`** is server-only (`import "server-only"`). `actions.ts` is the only write path from the UI: each
  action loads the project fresh, calls domain functions, `Zod.parse`s the resulting entity and calls
  `repo.upsert`. `repo.ts#getRepo()` picks the repository per request.
- **Routes are thin.** Views in `components/views/*` are shared by project-level pages and episode-level pages
  (`/projects/x/perform` and `/projects/x/episodes/ep-1/perform`).
- **`src/proxy.ts`** is the Next.js 16 proxy (the former middleware). In supabase mode it refreshes the Auth
  session and redirects unauthenticated page requests to `/login?next=…` (API routes get `401`). It is a
  convenience layer; data access is enforced by RLS and each action/route re-checks the session. See [auth](auth.md).

## Modes

| `PRISM_STUDIO_PERSISTENCE` | Repository                        | Identity                       | Files                     |
| -------------------------- | --------------------------------- | ------------------------------ | ------------------------- |
| unset / `memory`           | `MemoryRepository` (seeded)       | none (fixed `LOCAL_USER_ID`)   | `.local-storage/` on disk |
| `supabase`                 | `UserRepository` over the pg pool | verified Supabase Auth session | private bucket            |

Memory mode has no accounts and the proxy is a no-op there. `PRISM_STUDIO_DEV_USER_ID` is read only by scripts
(`scripts/lib/dev-user.mjs`), never by the app; `production-flow.test.ts` fails if any file under `src/` mentions it.

## Request flow (supabase mode)

```
browser ─► proxy.ts (refresh cookies, getClaims) ─► page / route / server action
                                                       │ requireUser() → getClaims() (verified JWT)
                                                       ▼
                                   getRepo() → new UserRepository(pool, {sub,email})
                                                       │ begin; set local role authenticated; set_config('request.jwt.claims', …)
                                                       ▼
                                                   Postgres RLS
```

## Errors and feedback

Server actions are wrapped in `runAction` and return an `ActionResult`
(`{ ok: true } | { ok: false, error, fieldErrors?, reference? }`):

- `UserFacingError` (locked entity, asset in use, bad input) and `ZodError` become inline messages.
- Anything else is logged server-side with a short reference id; the user sees a generic message plus the id.
- `<ActionForm>` (`components/action-form.tsx`) shows a pending state, "Saved", inline errors, disables controls
  while pending and keeps typed input when validation fails.
- `app/error.tsx` and `app/not-found.tsx` are last-resort boundaries.

## Key decisions

| Decision                                    | Reason                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Domain independent of AI providers          | Providers change monthly; the package format must not. Adapters (Phase 2) translate `GenerationPackage`.                            |
| Preflight is a rule table                   | Rules are data (`PREFLIGHT_RULES`); AI checks can later append rule sources without touching the evaluator.                         |
| Readiness is derived, not stored            | `prep_score` / `ready_to_generate` columns were dropped in 0004; computed live so they cannot drift.                                |
| Shot sections as JSONB, relations as tables | Sections are edited as units and evolve; characters, looks, dialogue, props, script sources are real FKs.                           |
| Assets are rows, not URLs                   | Everything references `asset.id`; `StorageProvider` hides where bytes live. See [storage](storage.md).                              |
| Append-only generation history              | Trigger `guard_attempt_history` blocks edits to prompt, snapshot, fingerprint, settings, inputs.                                    |
| Freshness by content hash                   | Per-part fingerprints, not event sourcing. See [production-workflow](production-workflow.md).                                       |
| RLS is the authority                        | The app connects with a privileged pool but drops to role `authenticated` per transaction. See [security-model](security-model.md). |
| Server actions + native forms               | Little client JS; client components only where interaction demands (animatic, drag-reorder, audio input).                           |

## Testing

| Suite                                                      | Where                                       | Notes                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Unit (`npm test`)                                          | `src/**/__tests__`, `scripts/lib/__tests__` | Domain, SQL mapping, upload policy, audio analysis, migration checksums, redaction, env safety. |
| Memory e2e (`npm run test:e2e`)                            | `e2e/smoke`, `e2e/workflow`                 | Production build, forced memory mode.                                                           |
| DB (`db:validate`, `db:behavior`, `db:rls`, `db:exercise`) | `scripts/`                                  | Run against the dedicated project; see [local-supabase](local-supabase.md).                     |
| Supabase e2e (`test:e2e:supabase`)                         | `e2e/supabase-auth.spec.ts`                 | Real Auth; needs `PRISM_STUDIO_TEST_PASSWORD`, skipped without it.                              |

## Not built yet

Real provider adapters (the contract, queue, worker and a Mock provider exist: see
[generation-architecture](generation-architecture.md)), automated continuity QA, model routing, budgets,
collaboration, 3D sets, NLE export. See [roadmap](roadmap.md).

## Generation (Phase 2A)

Generation is a separate runtime concern: pure vocabulary in `src/domain/generation`, adapters/worker in
`src/generation` (no Next.js, no React), persistence behind `GenerationRepository` (user path, RLS) and
`GenerationStore` (worker path). The web app only enqueues and observes; `npm run worker:generation`
executes. See [generation-architecture](generation-architecture.md).

## Framing, conform and continuity QA (Phase 2C)

Three more pure/bounded layers, all outside React and outside the worker:

- `src/domain/framing/*`: aspect-ratio parsing, integer-safe crop/pad math, the GenerationAdaptationPlan and the
  DeliveryConformPlan. Pure. Consumed by the compatibility engine; the plan is frozen on the attempt.
- `src/media/*`: the `MediaProcessor` interface, the FFmpeg adapter (no shell, magic-byte allow-list, limits,
  timeouts, temp cleanup) and the delivery/derivation orchestration (idempotent, crash-safe).
- `src/domain/continuity/*` + `src/continuity/service.ts`: criteria from production truth, reference sets,
  deterministic checks, the analyzer contract (+ Mock), aggregation/status/staleness; persistence behind
  `MediaQaRepository` (memory + Postgres, RLS-bound).

Production frame ≠ provider canvas ≠ delivery frame: see [framing-adaptation](framing-adaptation.md).
Media runs in the app server under the user's session; the worker role gained **no** privileges.
