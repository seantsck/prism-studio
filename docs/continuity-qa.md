# Continuity QA (Phase 2C)

**QA advises; humans approve.** An automated result can never approve, reject or change the review state of a
shot. Three facts about an attempt stay separate everywhere (chips, cards, compare, dashboard):

| Concern           | Source                         | Values                                                           |
| ----------------- | ------------------------------ | ---------------------------------------------------------------- |
| Generation        | job/attempt status             | queued … succeeded / failed / cancelled                          |
| Continuity QA     | latest continuity run          | not started · in review · passed · passed with warnings · failed |
| Creative approval | `attempt.reviewStatus` (human) | unreviewed · approved · rejected                                 |

## Domain (`src/domain/continuity/`, pure)

- **Criteria** (`criteria.ts`): derived only from production truth. Each has a stable key, category, severity
  (critical / major / minor), `sourceRef` ("Look "Formal Black" (locked)"), the **expected** value and who may
  answer it (`deterministic`, `analyzer`, `manual`). Categories: identity, wardrobe, hair, makeup, jewelry,
  props, location/set, lighting, weather, time of day, character count, screen direction, eyelines, geography,
  camera, composition, action continuity, duration, audio, lip sync, other.
  Locked Looks/sets raise severity to critical; protected-composition notes become manual composition criteria.
- **Reference set** (`buildReferenceSet`): exactly which identity refs, Look refs, approved storyboard, location
  refs, previous approved shot output, next shot storyboard, performance takes, production constraints and
  delivery framing were used, with checksums. Frozen on the run.
- **Deterministic checks** (`checks.ts`, no AI): output present, duration (±1.5 frames), aspect ratio, resolution
  (only when the bible sets an explicit size), fps, container/codec playability, audio stream, conformed delivery
  master present. Anything needing understanding of the picture stays `unchecked`; nothing is faked.
- **Results**: `pass · warn · fail · n_a · unchecked`.
- **Aggregation** (`status.ts`): transparent counts, never one opaque score: critical failures, passed `x/y`
  evaluated, warnings, failures by severity, unchecked, "continuity confidence: not available until a semantic
  analyzer runs" (or "MOCK ANALYSIS only").
- **QA status**: a run is `in_review` until a person closes it; closing yields `failed` (any critical fail),
  `passed_with_warnings` (any other fail/warn/unchecked), or `passed`. A critical fail prevents "passed" but does
  not reject or delete the output.

## Persistence (migration 0021)

`continuity_runs` (frozen snapshot: subject asset, original, analyzer + version + kind, rules version, package /
subject / criteria / reference fingerprints, the reference set; only `analysis_status` and the human close-out
may change), `continuity_findings` (one row per criterion: expected, system result, source, confidence, notes,
evidence; criteria are frozen and results are immutable once the run is complete), `continuity_overrides`
(append-only human decisions; the latest wins and the system result is never rewritten). Owner-only RLS;
the generation worker has no access. Distinct from the legacy manual `continuity_checks` table, left untouched.

## Freshness

A run is compared with what is true **now** (`staleness`): the subject (output / delivery master / plan),
the criteria (production truth) and the reference set fingerprints. A change marks the run **stale** in the UI;
the stored run is never mutated. Re-running creates `run N+1`; history stays.

## Approval advisories

Shown beside Approve, never blocking: QA not run · QA stale · critical failure recorded · review not closed.

## Review workspace

`/projects/<project>/generations/<attempt>/continuity`: examined output, contact sheet and frames, the frozen
reference set, criteria grouped by category with expected / actual / system result / human override, per-
criterion decision form (result + note), close-out note, run history.

## Mock analyzer

`MockContinuityAnalyzer` is deterministic (a pure function of subject checksum + criterion key), declares only
image_identity, wardrobe, object_presence, scene_match, character_count, composition and lighting, and labels
every result **MOCK ANALYSIS**. Temporal, audio and lip-sync criteria stay unchecked. It exists to exercise
queued analysis, findings, scores, overrides, re-runs and the UI. See [continuity-analyzer-contract](continuity-analyzer-contract.md).

## Dashboard and shot list

Project overview: shots, generated, continuity reviewed, critical failures, creative approved. Shot list shows
`PREP · GENERATED · QA … · APPROVED` as separate badges. One narrow query (latest run per attempt) feeds both.
