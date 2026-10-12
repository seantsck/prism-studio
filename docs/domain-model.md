# Domain model

Source of truth: `src/domain/schemas.ts` (Zod). SQL: `supabase/migrations/0001_core.sql`, `0002_production.sql`.

```
User
 └ Project ─ ProjectBible (canon, rules, guardrails)
    ├ Asset                       generic file/reference record
    ├ Character
    │   ├ IdentityRef             front / three_quarter / profile / full_body / additional → Asset
    │   ├ CharacterLook           wardrobe, shoes, jewelry, hair, makeup … (optionally episode-scoped, lockable)
    │   └ VoiceProfile            provider-agnostic voice description (lockable)
    ├ Location                    zones, entrances, lighting; reserved `set3d` for the future 3D set
    ├ Prop
    └ Episode  (script text)
        ├ Scene                   slugline, location, emotional arc, script range
        │   └ DialogueLine        stable id, text, translation, locked
        │        ├ PerformanceDirection (1:1)
        │        └ PerformanceTake (N; exactly one `selected`)
        └ Shot
            ├ ShotCharacter[]     character + lookId (+ expression, posture, gestures…)
            ├ sections            composition, spatial, continuity, action, audio, lighting, constraints, generation
            ├ approval            storyboard / performance / continuity gates
            ├ StoryboardFrame[]   versioned; at most one approved
            ├ GenerationAttempt[] append-only, with package snapshot
            └ ContinuityCheck[]   manual now, automated later
```

## Invariants

| Invariant                                                           | Enforced by                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| One selected take per dialogue line                                 | `selectTake()` domain fn + partial unique index `takes_one_selected_per_line` |
| One approved storyboard frame per shot                              | `setFrameApproved` action + `frames_one_approved_per_shot`                    |
| A shot's Look belongs to the assigned character (and episode scope) | `validateLookLink()`; preflight rule `character.look_valid`; FK restrict      |
| Locked dialogue text is never rewritten                             | `syncScript` / `saveDialogueLine`; `guard_locked_dialogue` trigger            |
| Generation history is immutable                                     | `guard_attempt_history` trigger; `reviewAttempt` touches only review fields   |
| Locked shots keep their order slot                                  | `reorderShotsInScene()`                                                       |
| `ready_to_generate` is derived                                      | `runPreflight()` — not stored (cache columns dropped in migration 0004)       |
| Reference-asset order is preserved                                  | `shot_reference_assets.position` + unique `(shot_id, role, position)`         |

## Design notes

- **Shots reference, never repeat.** A shot stores `lookId`, `locationId`, `previousShotId`, dialogue line ids.
  Wardrobe text is read from the Look at package-assembly time.
- **Next shot is derived.** Only `previousShotId` is stored; the next shot is computed from order, so reordering
  cannot leave two links disagreeing.
- **Named character count.** `continuity.characterCount` counts assigned (named) characters visible. Background
  extras are described in `spatial.backgroundActivity` and constrained via `constraints.*`. `0` is an explicit
  statement that an establishing shot has no named characters.
- **Non-principal speakers.** A dialogue line may have `characterId = null` with a `speakerLabel`
  (e.g. `REPORTER`, `MOTHER (V.O.)`) so they can have takes without being full characters.
- **Locations are 3D-ready.** `set3d` (`modelAssetId`, `cameraRigs`, `blockingMarkers`, `lightRigs`) is nullable
  and unused in Phase 1; `spatial.marks` use normalised 0–1 coordinates that a 3D set can later replace with world coordinates.

## Persistence mapping (for the Supabase adapter)

| Domain                                                                             | SQL                                           |
| ---------------------------------------------------------------------------------- | --------------------------------------------- |
| `Shot.characters[]`                                                                | `shot_characters`                             |
| `Shot.audio.dialogueLineIds[]`                                                     | `shot_dialogue_lines` (ordered by `position`) |
| `Shot.propIds[]`                                                                   | `shot_props`                                  |
| `Shot.generation.*AssetId(s)`                                                      | `shot_reference_assets.role`                  |
| `Shot.continuity.previousShotId`                                                   | `shots.previous_shot_id`                      |
| `Shot.spatial.locationId`                                                          | `shots.location_id`                           |
| `Shot.composition/spatial/continuity/action/audio/lighting/constraints/generation` | JSONB columns                                 |
| `Scene.characterIds/propIds`                                                       | `scene_characters`, `scene_props`             |
| `Scene.scriptRange`                                                                | `scenes.script_start_line/end_line`           |
