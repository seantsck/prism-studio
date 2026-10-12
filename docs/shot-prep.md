# Shot prep & preflight

The **Shot Prep** screen (`/projects/:p/episodes/:e/shots/:shotId`) is an inspector of 18 collapsible sections
rather than one 70-field form. A sticky right rail always shows the frame, the timing breakdown and live
preflight.

| #   | Section                | Contains                                                                                    | Preflight group |
| --- | ---------------------- | ------------------------------------------------------------------------------------------- | --------------- |
| 1   | Story                  | title, beat, purpose, status, duration mode, target duration                                | story           |
| 2   | Source script          | linked action blocks and dialogue, link/unlink                                              | —               |
| 3   | Performance            | linked dialogue lines, selected takes, performance gate                                     | performance     |
| 4   | Character              | assigned characters, expression/posture/gestures                                            | character       |
| 5   | Look                   | **Look by id** per character                                                                | —               |
| 6   | Location / set         | location, zone, background activity                                                         | set             |
| 7   | Camera                 | framing, size, aspect, position, height, angle, lens, aperture, movement                    | camera          |
| 8   | Composition            | composition details                                                                         | —               |
| 9   | Blocking               | blocking, facing, eyelines, screen direction, entry/exit, marks, poses                      | blocking        |
| 10  | Action timing          | beats, beginning/ending pose                                                                | —               |
| 11  | Continuity             | previous shot, weather, time, vehicle orientation, count, wardrobe/hair/makeup/jewelry/prop | continuity      |
| 12  | Props                  | shot props                                                                                  | —               |
| 13  | Lighting               | lighting and reference                                                                      | —               |
| 14  | Audio                  | pre/post roll, line gap, ambience, foley, music, silence                                    | audio           |
| 15  | Storyboard / keyframes | frame versions, approve, freshness                                                          | storyboard      |
| 16  | Generation intent      | modality, provider, model, resolution, fps, hard/negative/forbidden constraints             | generation      |
| 17  | Preflight              | full report, manual continuity review                                                       | —               |
| 18  | Generation brief       | human-readable brief, export links                                                          | —               |

Each section header shows ✕/⚠/✓ counts for its preflight group; the first section with a blocker opens by
default (`?section=` overrides).

A **warning banner** at the top lists freshness messages (stale storyboard, changed timing) and, when the latest
attempt's `packageFingerprint` differs from the current package, "this shot has changed since generation
attempt N". See [production-workflow](production-workflow.md).

Field definitions live in `src/domain/shot-fields.ts` (declarative specs); the form renderer and the server
action share them, so adding a field is a one-line change plus the schema.

## Preflight

`runPreflight(ctx)` evaluates `PREFLIGHT_RULES` over a `ShotContext`. No AI, no I/O, deterministic.

Statuses: `✓ pass`, `✕ fail`, `⚠ warn`, `— na`.

- **required** rules that fail are blockers → `NOT READY TO GENERATE`.
- **recommended** rules that fail are warnings and never block.
- `na` is used when a rule does not apply (e.g. no dialogue → no take required).
- `score` = share of applicable rules passed (recommended count half).

Current rules (see `src/domain/preflight.ts`; `*` = recommended):

```
story.beat, story.purpose*, story.duration
performance.takes, performance.locked_text*, performance.direction*, approval.performance
character.assigned, character.look_assigned, character.look_valid, character.look_locked, character.identity*
set.location, set.locked, set.zone*
camera.core, camera.lens*
blocking.specified, blocking.eyelines*
continuity.previous, continuity.weather, continuity.time_of_day, continuity.character_count,
continuity.vehicle (only when vehicleInPlay), continuity.wardrobe*, approval.continuity
audio.ambience*
storyboard.frame, storyboard.approved, storyboard.fresh*
generation.model*, generation.guardrails*
```

`storyboard.fresh` warns when the approved frame is stale, unknown (approved before tracking) or the derived
timing changed since approval. It never blocks.

### Adding a rule

```ts
{ id: "set.weather_matches_scene", section: "set", severity: "required",
  label: "Weather matches scene",
  evaluate: (c) => /* pure function of ShotContext */ ({ status: "pass" }) }
```

Append it to `PREFLIGHT_RULES` and add a test. Future AI/vision continuity checks should produce the same
`RuleOutcome` shape so they surface in the same report.
