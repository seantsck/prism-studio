# Production workflow

How work flows through the app, and which signals tell you something upstream changed.

```
Script ─► Breakdown ─► Perform ─► Shot Prep ─► Storyboard ─► Animatic ─► Generations
 (scenes,    (shots from   (takes,     (18 sections,   (frames,      (timed        (package,
  lines,      script,       selected    preflight)      approval)     playback)     attempts)
  actions)    coverage)     take)
```

| Step        | Where                    | Produces                                                                                                   |
| ----------- | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Script      | `/script`                | Scenes, dialogue lines, action blocks with stable ids ([script-coverage](script-coverage.md))              |
| Breakdown   | `/breakdown`             | Shots created or linked from selected script content; coverage per scene                                   |
| Perform     | `/perform`               | Directions, takes, a selected take per line, locked text ([performance-workflow](performance-workflow.md)) |
| Shot Prep   | `/episodes/:e/shots/:id` | Everything a shot needs; live preflight ([shot-prep](shot-prep.md))                                        |
| Storyboard  | `/storyboard`            | Versioned frames, one approved per shot, drag-reorder                                                      |
| Animatic    | `/animatic`              | Timed playback of approved frames + selected takes ([animatic](animatic.md))                               |
| Generations | `/generations`           | Package export, brief, append-only attempt log ([generation-package](generation-package.md))               |

## Shot Prep

18 sections: Story, Source script, Performance, Character, Look, Location/set, Camera, Composition, Blocking,
Action timing, Continuity, Props, Lighting, Audio, Storyboard/keyframes, Generation intent, Preflight,
Generation brief. A right rail shows the frame, the timing breakdown and preflight. A warning banner appears
when the approved storyboard is stale or the package changed since the last attempt.

## Gates

Preflight rules are `required` (blockers; the shot is not ready) or `recommended` (warnings). Approval gates
(`approval.performance`, `approval.continuity`, storyboard approved) are explicit user actions. Readiness is
computed live and never stored.

## Freshness (migrations 0009, 0011)

Freshness answers "is this approved thing still true of the shot?" without event sourcing: hash the current
state and compare with hashes recorded when the artifact was made.

### Per-part fingerprints (`src/domain/fingerprint.ts`)

`computeShotParts(ctx)` returns one SHA-256 hash (`src/domain/hash.ts`, pure TS) per part:

| Part          | Hashes                                                                                 | Visual? |
| ------------- | -------------------------------------------------------------------------------------- | ------- |
| `story`       | beat, dramatic purpose, scene slugline/summary/purpose                                 | no      |
| `camera`      | `shot.composition`                                                                     | yes     |
| `blocking`    | `shot.spatial`                                                                         | yes     |
| `characters`  | assignments, physical description, identity refs                                       | yes     |
| `looks`       | each assigned Look's wardrobe, shoes, jewelry, hair, makeup, …, reference assets, lock | yes     |
| `location`    | description, geography, zones, entrances, lighting, references, lock                   | yes     |
| `props`       | prop ids, names, descriptions                                                          | yes     |
| `lighting`    | `shot.lighting`                                                                        | yes     |
| `action`      | beats (order, time, text, ids excluded), beginning/ending pose                         | yes     |
| `continuity`  | `shot.continuity`                                                                      | yes     |
| `constraints` | shot constraints + project guardrails                                                  | no      |
| `performance` | lines, directions, selected take id/duration/audio asset/checksum                      | no      |
| `timing`      | total duration, source, segment kinds and bounds                                       | no      |

`visualFingerprint` combines the visual parts; `overallFingerprint` combines all.

### Storyboard frames

On approval a frame stores `approved_fingerprint` and `approved_snapshot = { parts, durationMs }`
(`storyboard_frames`, migrations 0009 and 0011). `storyboardFreshness(ctx, frame)` returns:

| Status    | Meaning                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `none`    | No approved frame.                                                                                                |
| `fresh`   | No visual part differs from the snapshot.                                                                         |
| `stale`   | One or more visual parts differ. `changedParts` names them ("Character Look changed after storyboard approval."). |
| `unknown` | Approved before tracking existed; re-approve to start tracking.                                                   |

`timingChange { fromMs, toMs }` is reported separately when the derived duration moved
("derived duration changed from 4.5s → 5.1s"). With only a legacy fingerprint (no snapshot) the status can be
`stale` but cannot say which part.

Preflight rule `storyboard.fresh` (recommended) turns stale, unknown or changed-timing into a **warning**; it does
not block generation. Shot Prep, Storyboard and Animatic show the same messages.

### Generation attempts

- `generation_attempts.package_fingerprint` stores the package fingerprint at logging time. The trigger
  `guard_attempt_history` makes it (and prompt, negative prompt, package snapshot, model settings, input assets,
  shot id, attempt number) immutable; only review fields can change.
- `package.provenance.fingerprint` hashes the whole package content **excluding `builtAt`** (and the provenance
  block itself), so rebuilding an unchanged shot yields the same value. `provenance.parts` carries the per-part
  hashes.
- Shot Prep compares the latest attempt's fingerprint with the current package's; a mismatch shows "this shot
  has changed since generation attempt N". The attempt itself stays interpretable.

## Manual continuity review

Continuity checks (`continuity_checks`, kind `manual`) are recorded from Shot Prep → Preflight; the continuity
approval gate is separate. Automated checking is not built ([roadmap](roadmap.md)).
