# Roadmap

## Phase 1 — planning / performance / storyboard / animatic _(this repo, in progress)_

Implemented locally: projects, Bible, characters (identity, Looks, voice profiles), locations, script
structure with stable ids, Perform workspace (directions, takes, canonical selection), scenes, shot prep with
deterministic preflight, storyboard (versions, approval, reorder), animatic (timeline, playback, timing edits),
generation package + brief, append-only attempt log, manual continuity review, asset abstraction,
SQL migrations (unapplied), seed project, unit tests.

Outstanding before Phase 1 is "done": Supabase repository adapter + auth, real waveform extraction, shot
creation from script action lines, CRUD for props, asset library upload UI, Playwright coverage of critical flows.

## Phase 2 — provider adapters + generation queue + cost tracking

- `ProviderAdapter` interface: `GenerationPackage → provider request`, status polling, result ingestion.
- Queue + worker, retries, rate limits; attempts move `queued → running → succeeded/failed`.
- Cost tracking per attempt/shot/episode against budgets.
- Voice provider adapters populate `performance_takes` (`generated_voice`).

## Phase 3 — continuity vision QA

- Vision-model checks compare outputs to identity refs, Looks, set references and previous shots.
- Results stored as `continuity_checks(kind='automated')`, scores per dimension, issues with frame timestamps.
- Preflight gains post-generation rules; rejection reasons auto-suggested.

## Phase 4 — persistent 3D sets + virtual cameras + blocking

- React Three Fiber set editor attached via `locations.set3d`.
- Camera rigs and blocking markers replace abstract `spatial.marks`; 3D previews become `storyboard_frames(source='3d_preview')`.
- Light rigs feed `lighting` and the generation package.

## Phase 5 — rough-cut editor / audio / captions

- Promote the animatic to a rough-cut timeline with approved generations replacing frames.
- Audio tracks (dialogue, ambience, music), captions from dialogue lines and translations, EDL/XML export.

## Phase 6 — automatic model routing and production agents

- Route shots to models by modality, constraints, cost and historical approval rate.
- Agents propose breakdowns, shot lists, performance directions; humans approve through the existing gates.
