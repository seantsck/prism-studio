# Domain model

Source of truth: `src/domain/schemas.ts` (Zod). SQL: `supabase/migrations/0001`–`0011`
([history](migration-policy.md)). The aggregate loaded for a project is `ProjectData`.

```
User (auth.users)
 └ Project ─ ProjectBible (canon, rules, guardrails)
    ├ Asset                       file/reference record: purpose, storage location, metadata (see asset-lifecycle.md)
    ├ Character
    │   ├ IdentityRef             front / three_quarter / profile / full_body / additional → Asset
    │   ├ CharacterLook           wardrobe, shoes, jewelry, hair, makeup … (optionally episode-scoped, lockable)
    │   └ VoiceProfile            provider-agnostic voice description (lockable)
    ├ Location                    zones, entrances, lighting; reserved `set3d` for the future 3D set
    ├ Prop
    └ Episode  (script text)
        ├ Scene                   slugline, location, emotional arc, script range
        │   ├ ActionBlock         stable id, text, order, start/end line         (0008)
        │   └ DialogueLine        stable id, text, translation, locked, source line range
        │        ├ PerformanceDirection (1:1)
        │        └ PerformanceTake (N; one `selected`; may be `archived`)
        └ Shot
            ├ ShotCharacter[]     character + lookId (+ expression, posture, gestures…)
            ├ scriptSources       { actionBlockIds, dialogueLineIds }             (0008)
            ├ sections            composition, spatial, continuity, action, audio, lighting, constraints, generation
            ├ approval            storyboard / performance / continuity gates
            ├ StoryboardFrame[]   versioned; at most one approved; approved_fingerprint + approved_snapshot (0009, 0011)
            ├ GenerationAttempt[] append-only; package_fingerprint (0009)
            └ ContinuityCheck[]   manual now, automated later
```

## Invariants

| Invariant                                                           | Enforced by                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| One selected take per dialogue line                                 | `selectTake()` domain fn + partial unique index `takes_one_selected_per_line`   |
| Archived takes are never selected                                   | `setTakeArchived` / `selectTake` action + check `takes_archived_not_selected`   |
| One approved storyboard frame per shot                              | `setFrameApproved` action + `frames_one_approved_per_shot`                      |
| A shot's Look belongs to the assigned character (and episode scope) | `validateLookLink()`; preflight `character.look_valid`; deferrable no-action FK |
| Locked dialogue text is never rewritten                             | `syncScript` / `saveDialogueLine`; `guard_locked_dialogue` trigger              |
| Generation history is immutable                                     | `guard_attempt_history` trigger (includes `package_fingerprint`)                |
| Locked shots keep their order slot                                  | `reorderShotsInScene()`                                                         |
| Readiness is derived                                                | `runPreflight()`; cache columns dropped in 0004                                 |
| Reference-asset order is preserved                                  | `shot_reference_assets.position` + unique `(shot_id, role, position)`           |
| A shot links a script element at most once                          | unique indexes on `shot_script_sources`                                         |
| A Supabase-stored asset has bucket and path                         | check `assets_supabase_location_check`                                          |
| An asset in use cannot be deleted                                   | `findAssetUsage` + `deleteAsset` action                                         |
| Ownership of every row                                              | RLS (`is_project_owner`) — [security-model](security-model.md)                  |

## Design notes

- **Shots reference, never repeat.** A shot stores `lookId`, `locationId`, `previousShotId`, dialogue line ids.
  Wardrobe text is read from the Look at package-assembly time.
- **Next shot is derived.** Only `previousShotId` is stored; the next shot is computed from order.
- **Named character count.** `continuity.characterCount` counts assigned (named) characters visible; `0` is an
  explicit statement that an establishing shot has none.
- **Non-principal speakers.** A dialogue line may have `characterId = null` with a `speakerLabel`.
- **Timing is derived.** Duration comes from selected takes ([performance-workflow](performance-workflow.md)).
- **Freshness is hashed state.** Per-part fingerprints, not event history ([production-workflow](production-workflow.md)).
- **Locations are 3D-ready.** `set3d` is nullable and unused; `spatial.marks` use normalised 0–1 coordinates.

## Persistence mapping

| Domain                                                                             | SQL                                                                              |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Shot.characters[]`                                                                | `shot_characters`                                                                |
| `Shot.audio.dialogueLineIds[]`                                                     | `shot_dialogue_lines` (ordered by `position`)                                    |
| `Shot.scriptSources.*`                                                             | `shot_script_sources`                                                            |
| `Shot.propIds[]`                                                                   | `shot_props`                                                                     |
| `Shot.generation.*AssetId(s)`                                                      | `shot_reference_assets.role`                                                     |
| `Shot.continuity.previousShotId`                                                   | `shots.previous_shot_id`                                                         |
| `Shot.spatial.locationId`                                                          | `shots.location_id`                                                              |
| `Shot.composition/spatial/continuity/action/audio/lighting/constraints/generation` | JSONB columns                                                                    |
| `Scene.characterIds/propIds`                                                       | `scene_characters`, `scene_props`                                                |
| `Scene.scriptRange`                                                                | `scenes.script_start_line/end_line`                                              |
| `PerformanceTake.waveform`                                                         | `performance_takes.waveform` (JSONB `{version, sampleCount, peaks, durationMs}`) |
| `StoryboardFrame.approvedSnapshot`                                                 | `storyboard_frames.approved_snapshot` (JSONB `{parts, durationMs}`)              |

## Generation entities (Phase 2A)

| Entity             | Table                   | Nature                                                                                      |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------- |
| GenerationAttempt  | `generation_attempts`   | Immutable creative record (package, plan, request, compatibility) + execution/review result |
| GenerationJob      | `generation_jobs`       | Mutable execution state: provider job id, lease, retries, sanitized error                   |
| GenerationJobEvent | `generation_job_events` | Append-only status timeline                                                                 |
| GenerationOutput   | `generation_outputs`    | Ordered, role-tagged link attempt → Asset (primary, variant, preview, …)                    |
| GenerationCost     | `generation_costs`      | Estimated / actual / unknown, append-only                                                   |

Invariants: attempt ↔ job ↔ output ↔ cost always share a project (composite foreign keys); at most one active
job per attempt; at most one approved attempt per shot; `approved = (review_status = 'approved')`; outputs have
unique positions and at most one `primary`. See [generation-architecture](generation-architecture.md).

## Phase 2C entities

| Entity                   | Table / column                                                                                          | Nature                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GenerationAdaptationPlan | `generation_attempts.adaptation_plan`                                                                   | Frozen, immutable: how production framing/duration were adapted to the provider; `null` for older attempts   |
| ProductionFormat         | `project_bibles.aspect_ratio` (+ optional `delivery_width/height`, `target_codec`, `audio_sample_rate`) | Canonical frame; pixel size only when explicitly set                                                         |
| Protected composition    | `shots.generation.protectedComposition`                                                                 | Manual notes: what must survive a crop (not a freshness part)                                                |
| AssetDerivation          | `asset_derivations`                                                                                     | Child asset → parent + deterministic operation/parameters/processor; append-only; versioned per attempt slot |
| AttemptDelivery          | `attempt_deliveries`                                                                                    | The selected delivery master of an attempt (provider original may be the master)                             |
| ContinuityRun            | `continuity_runs`                                                                                       | Frozen QA snapshot: subject, analyzer, rules, fingerprints, reference set                                    |
| ContinuityFinding        | `continuity_findings`                                                                                   | One criterion: expected, system result, severity; criteria frozen                                            |
| ContinuityOverride       | `continuity_overrides`                                                                                  | Append-only human decision; latest wins; system result never rewritten                                       |

Distinct concerns: Production Shot · Generation Package · Generation Adaptation Plan · Provider Output ·
Delivery Conform · Continuity QA · Creative Approval. See [framing-adaptation](framing-adaptation.md),
[delivery-conform](delivery-conform.md), [continuity-qa](continuity-qa.md).

## Camera motion entities (Phase 2F M2A)

| Entity                | Table / column                                                    | Nature                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CameraPath            | `shot_camera_paths` (`path_json`, `revision`, `path_fingerprint`) | One current editable path per Shot; quaternion keyframes + focal length; compare-and-set revision; tied to the set revision/fingerprint it was authored against                                                                                                                                                                        |
| PrevisClip            | `shot_previs_clips`                                               | One locally rendered previs: path revision/fingerprint, set revision/fingerprint, private asset id, fps, duration, dimensions, container, codec; since 0032 `audio_mix_json` + `audio_mix_fingerprint` (the performance-audio mix by value: asset ids + checksums + timeline offsets, never a URL; null = silent); append-only history |
| CameraMotionReference | `GenerationPackage.spatialReference.cameraMotion`                 | Frozen copy (by value) of the path used for a package; optional                                                                                                                                                                                                                                                                        |

Distinct concerns: Editor camera · Production camera · Camera path · Camera bookmark (M1) · Master frame · Previs clip.
See [virtual-set](virtual-set.md).
