# Generation package

The contract between Prism Studio and any downstream model. It is **normalized and provider-independent**;
provider adapters (Phase 2, not built) will translate it into provider payloads. There is no provider logic in
the package code.

- `src/domain/generation-package.ts`: `assembleGenerationPackage(ctx)` (pure), `renderGenerationBrief(pkg)`,
  `briefToText(brief)`, `PACKAGE_SCHEMA_VERSION = 3` (v2 snapshots stay readable).
- `src/server/generation-package.ts`: `buildGenerationPackage(projectSlug, shotId)` loads the project through
  the RLS-bound repository and calls the pure assembler.

## Export

```
GET /api/projects/:projectSlug/shots/:shotId/package?format=json    # default; application/json attachment
GET /api/projects/:projectSlug/shots/:shotId/package?format=brief   # text/plain attachment
```

Requires a session (401 otherwise); an unknown or foreign shot is a plain 404; responses are `no-store`.

## Shape (v3)

`packageSchemaVersion: 3` (also exposed as `version`) and `builtAt`. Bump the version when the **shape**
changes; attempts keep the version they were built with (history is never rewritten). **v3 (Phase 2G.1)** adds the
selected Production Frame ([production-frames](production-frames.md)); every v3-only key is optional, so a v2 snapshot
is still read by the same code.

| Key                              | Contents                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`, `episode`, `shot`     | ids, titles, slug, default language, shot code and status                                                                                                                                                                                                                                                                                                           |
| `sourceScript`                   | Linked action blocks and dialogue copied **by value** (ids, text, start line, speaker, locked)                                                                                                                                                                                                                                                                      |
| `storyIntent`                    | beat, dramatic purpose, scene (number, slugline, summary, emotion entering/leaving), episode title                                                                                                                                                                                                                                                                  |
| `style`                          | visual style, color language, cinematography rules, aspect ratio (from the Bible)                                                                                                                                                                                                                                                                                   |
| `characters[]`                   | identity reference asset ids, **exact Look** (wardrobe, shoes, jewelry, hair, makeup, grooming, accessories, refs), expression, posture, gestures, interactions, notes                                                                                                                                                                                              |
| `set`                            | location id/name, locked, description, geography, zone, lighting, reference assets                                                                                                                                                                                                                                                                                  |
| `props[]`                        | id, name, description                                                                                                                                                                                                                                                                                                                                               |
| `camera`, `blocking`, `lighting` | verbatim shot sections                                                                                                                                                                                                                                                                                                                                              |
| `performance[]`                  | line text, language, locked, emotion/objective/intensity/pace, **selected take** (id, number, duration, audio asset, source, transcript)                                                                                                                                                                                                                            |
| `timing`                         | `durationMs`, `mode` (durationMode), `source`, labelled `segments`, `breakdown`, action `beats`, poses, ambience, foley, music, silence                                                                                                                                                                                                                             |
| `continuity`                     | previous **and next** shot, wardrobe/hair/makeup/jewelry/props/lighting, weather, time of day, vehicle, named count, geography, project rules, scene notes                                                                                                                                                                                                          |
| `constraints`                    | hard (shot + derived), negative, project guardrails, forbidden objects/people/actions, generator notes                                                                                                                                                                                                                                                              |
| `references`                     | start/end frame (**start frame precedence: the Shot's explicit override, then the selected Production Frame, then the approved storyboard frame**), approved frame, **`productionFrame`** (v3: frame id, Asset id, version, source, intent fingerprint, `fresh`/`stale`, changed parts; present only when one is selected), reference assets, reference video/audio |
| `generation`                     | modality, provider, model, resolution, fps                                                                                                                                                                                                                                                                                                                          |
| `assets`                         | **Self-describing asset index** keyed by id: type, purpose, name, filename, mime, byte size, checksum, dimensions, duration, sample rate, channels, storage provider, bucket, object path                                                                                                                                                                           |
| `freshness`                      | `storyboard`: status, changed parts, timing change, messages; **`productionFrame`** (v3, only when one is selected): status, changed parts, messages                                                                                                                                                                                                                |
| `readiness`                      | preflight result (ready, score, blockers, warnings)                                                                                                                                                                                                                                                                                                                 |
| `prompt`                         | convenience positive/negative strings (adapters may ignore)                                                                                                                                                                                                                                                                                                         |
| `provenance`                     | `fingerprint`, per-part `parts`, `builtAt`, `sourceVersions` (shot `updatedAt`, look ids, location id, selected take ids, frame id)                                                                                                                                                                                                                                 |

The `assets` index means a stored package stays interpretable after the asset row is renamed or changed: the
checksum and metadata at build time are inside the snapshot. Note it includes `bucket`/`objectPath`; these are
internal keys, not URLs, and access still goes through `/api/assets/:id` ([storage](storage.md)).

## Fingerprints

`provenance.fingerprint` = SHA-256 of every other key of the package (including `assets`, `freshness`,
`readiness` and `prompt`) with `builtAt` nulled and the `provenance` block excluded, so rebuilding an unchanged
shot gives an identical value. Because `readiness` and `freshness` are inside it, a change in preflight outcome
also changes the fingerprint.

### Two fingerprints, two questions (never interchangeable)

| Field                                              | Identifies                                                                                                                | Answers                                      | Used by                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `provenance.fingerprint`                           | the **exact normalised GenerationPackage**: its frozen content, schema-version fields included                            | "is this the same frozen package?"           | attempts (`package_fingerprint`), candidate sets, continuity runs, the exported/frozen package |
| `provenance.parts.overall` (and the named `parts`) | the **Shot's production inputs** (the 13 named parts, plus the selected Production Frame's identity when one is selected) | "have the Shot's production inputs changed?" | Shot Prep's "this shot has changed since generation attempt N" only                            |

A package **schema upgrade** (v2 → v3) therefore changes `provenance.fingerprint` (a v3 package and a v2 package are
different frozen shapes) but leaves `parts.overall` unchanged for an unchanged Shot, so Shot Prep does not report a
change merely because the package serialisation evolved. `shotChangedSinceAttempt(attempt, pkg)` compares the
`parts.overall` recorded in the attempt's frozen snapshot with the current package's; only a snapshot that never
recorded one falls back to comparing the exact package fingerprints. Attempts are never rewritten.

**Production Frames.** The selected Production Frame adds one part, `productionFrame` (its id, frame fingerprint, image
checksum and intent fingerprint), **only while a frame is selected**: selecting or switching frames changes both
identities; an _unselected_ historical frame changes neither (history is never hashed); re-selecting the same frame
changes neither. A Shot with no selected frame has exactly the `parts.overall` it had before Phase 2G.1.
`provenance.parts` are the per-part hashes from `computeShotParts` plus `overall`
([production-workflow](production-workflow.md)).

## Derived constraints

Explicit stored state becomes explicit constraints so the model never has to infer them:

- named character count → `Only these named characters appear: … Do not add anyone else.`
- vehicle in play → `Vehicle orientation: …`
- locked location → `Set is locked: … Do not alter its geography.`
- locked Look → `<Name> wears locked Look "<Look>". Do not change it.`
- weather → `Weather: … Do not change it.`

## Generation brief

`renderGenerationBrief(pkg)` returns titled sections for humans (Shot Prep → Brief, the Generations page and
`?format=brief`): Story intent, Look & style, Set, Camera, Blocking, Performance, Timing, Audio, Continuity,
Hard constraints, Negative constraints, Project guardrails, References, Target, Readiness.

## Attempts

`startGeneration` freezes the package into `generation_attempts.package_snapshot` (and its
`package_fingerprint`) together with the **PromptPlan**, the normalized **request**, the **compatibility
report** and the acknowledged ignored features, then queues a job. `logAttempt` still exists for attempts made
**outside** Prism (no job, no output).

Attempts are append-only: execution result (status, output, cost, duration) and review fields can change; the
package, plan, request, compatibility, provider/model, prompt, settings, input assets, shot id and attempt
number cannot (`guard_attempt_history`). One approved attempt per shot at most.

The three layers are kept apart: the **package** is what the filmmaker decided, the **PromptPlan** is a
provider-independent sectioning of it, and the **provider request** is whatever an adapter builds. The Prompt
Inspector shows all three, for the current shot and for any historical attempt
([generation-architecture](generation-architecture.md)). A past attempt's brief is always reachable at
`/projects/<slug>/generations/<attemptId>` and `/api/projects/<slug>/generations/<attemptId>/package`.
