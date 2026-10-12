# Shot prep & preflight

The **Shot Prep** screen (`/projects/:p/episodes/:e/shots/:shotId`) is an inspector of collapsible sections
rather than one 70-field form. A sticky right rail always shows the frame and live preflight.

| Section     | Contains                                                                                             | Preflight group |
| ----------- | ---------------------------------------------------------------------------------------------------- | --------------- |
| Story       | title, beat, purpose, status, duration mode, target duration                                         | story           |
| Performance | linked dialogue lines, canonical takes, performance gate                                             | performance     |
| Character   | assigned characters, **Look by id**, expression/posture/gestures                                     | character       |
| Set         | location, zone, background activity, lighting                                                        | set             |
| Camera      | framing, size, aspect, position, height, angle, lens, aperture, movement                             | camera          |
| Blocking    | blocking, facing, eyelines, screen direction, entry/exit, beats, marks, poses                        | blocking        |
| Continuity  | previous shot, weather, time, vehicle orientation, count, wardrobe/hair/makeup/jewelry/prop/lighting | continuity      |
| Audio       | pre/post roll, line gap, ambience, foley, music, silence                                             | audio           |
| Storyboard  | frame versions, approve                                                                              | storyboard      |
| Generation  | modality, provider, model, resolution, fps, hard/negative/forbidden constraints                      | generation      |
| Preflight   | full report, generation brief, manual continuity review                                              | —               |

Each section header shows ✕/⚠/✓ counts; the first section with a blocker opens by default (`?section=` overrides).

Field definitions live in `src/domain/shot-fields.ts` (declarative specs) — the form renderer and the
server action share them, so adding a field is a one-line change plus the schema.

## Preflight

`runPreflight(ctx)` evaluates `PREFLIGHT_RULES` over a `ShotContext`. No AI, no I/O, deterministic.

Statuses: `✓ pass`, `✕ fail`, `⚠ warn`, `— na`.

- **required** rules that fail are blockers → `NOT READY TO GENERATE`.
- **recommended** rules that fail are warnings and never block.
- `na` is used when a rule does not apply (e.g. no dialogue → no take required).
- `score` = share of applicable rules passed (recommended count half).

Current rules (see `src/domain/preflight.ts`):

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
storyboard.frame, storyboard.approved
generation.model*, generation.guardrails*
(* = recommended)
```

### Adding a rule

```ts
{ id: "set.weather_matches_scene", section: "set", severity: "required",
  label: "Weather matches scene",
  evaluate: (c) => /* pure function of ShotContext */ ({ status: "pass" }) }
```

Append it to `PREFLIGHT_RULES` and add a test. Future AI/vision continuity checks should produce the same
`RuleOutcome` shape so they surface in the same report.
