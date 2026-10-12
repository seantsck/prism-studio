# Prism Studio

An AI filmmaking **production operating system**. Not another video generator: Prism Studio prepares every
shot so thoroughly that downstream image/video/audio models receive a production-ready package instead of a vague prompt.

```
SCRIPT → PERFORMANCE → BREAKDOWN → SHOT DESIGN → STORYBOARD → ANIMATIC → 3D SET / BLOCKING → GENERATION → CONTINUITY QA → EDIT
```

Two principles drive the design:

1. **Never ask a generation model to remember what Prism Studio can store explicitly.** Looks, sets, camera,
   blocking, constraints and timing are stored as structured data and assembled into a generation package.
2. **Timing originates from the selected performance.** A dialogue shot's duration is
   `pre-roll + selected take(s) + gaps + post-roll`, not an arbitrary video length.

Production domain: `studio.prismsuite.io` (not deployed). This is a standalone repo, separate from PrismSuite.

## Status

Phase 1 (planning / performance / storyboard / animatic) is implemented locally with seeded demo data.
No provider integrations, no remote database, no deployment. See [docs/roadmap.md](docs/roadmap.md).

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

The app boots with an in-memory repository seeded with a Japanese-drama demo project
(`お嬢様、僕と結婚してください。`, Episode 1 "The Arrangement", 14 shots). Edits persist only for the lifetime of
the dev server process; uploaded files are written to `.local-storage/` (git-ignored).

| Command             | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `npm run dev`       | Dev server                                                       |
| `npm run build`     | Production build                                                 |
| `npm run typecheck` | `tsc --noEmit` (strict)                                          |
| `npm run lint`      | ESLint                                                           |
| `npm test`          | Vitest unit tests (domain logic)                                 |
| `npm run test:e2e`  | Playwright smoke tests (needs `npx playwright install chromium`) |
| `npm run format`    | Prettier                                                         |

## Where to look

| Path                   | What                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/`          | Pure domain: Zod schemas, preflight, duration, generation package, animatic, script sync, ordering. No React, no Supabase. |
| `src/data/`            | `Repository` interface, in-memory implementation, demo seed fixtures.                                                      |
| `src/server/`          | Server-only: repository singleton, storage provider, server actions.                                                       |
| `src/app/`             | Next.js App Router routes (thin).                                                                                          |
| `src/components/`      | UI primitives, views, animatic player, sortable storyboard.                                                                |
| `supabase/migrations/` | SQL migrations **for review — never applied**.                                                                             |
| `docs/`                | Architecture, domain model, shot prep, performance, generation package, roadmap.                                           |

## Safety rails in this repo

- Migrations are local files only; nothing talks to Supabase.
- No provider API keys, no outbound generation calls.
- The seed project is fixture data; no product logic depends on its names.
