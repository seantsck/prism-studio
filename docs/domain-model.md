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

## Shot character blocking (Phase 2F M2B)

| Entity            | Table / column                                                                      | Nature                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ShotBlocking      | `shot_character_blocking` (`root_*`, `pose_json`, `revision`, fingerprints)         | ONE current state per (Shot, Character): root placement (position, quaternion, uniform scale) and `prism.pose.v1` on `prism.humanoid-rig.v1`; compare-and-set revision; tied to the set revision/fingerprint it was authored against; owner-only RLS |
| Render provenance | `scene_master_frames` / `shot_previs_clips` `blocking_fingerprint`, `blocking_json` | Which blocking a render showed (character id, blocking id, revision, fingerprint; never a URL); null = no character proxies                                                                                                                          |
| ShotBlockingRef   | `GenerationPackage.spatialReference.shotBlocking`                                   | Frozen copy (by value) of the Shot's blocking, with a deterministic text summary; optional; separate from Character/Look identity                                                                                                                    |

Blocking is **shot-specific**: it is never part of the Location's set. The proxy carries no identity. See
[virtual-set](virtual-set.md#character-blocking-phase-2f-m2b).

## Spatial control passes (Phase 2F M2C)

| Entity            | Table / column                                                                                            | Nature                                                                                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SpatialPassBundle | `shot_spatial_pass_bundles` (`camera_json`, `object_manifest_json`, `character_masks_json`, fingerprints) | ONE **immutable** capture per exact control frame: Shot + saved Set state + rendered blocking + an explicit production-camera source (camera path time or Production Camera bookmark, camera by value) + 1912×800. Owner-only RLS; unique `(shot_id, bundle_fingerprint)` |
| Pass assets       | `assets` (`type = 'data'`, `purpose = 'spatial_control'`, `application/x-prism-*`)                        | Private raw rasters: depth (`prism.depth-f32.v1`, metres), object ids (`prism.object-id-u32.v1`), one Character mask per visible blocked Character (`prism.character-mask-u8.v1`). Never an image type, never a URL                                                       |
| ControlPassesRef  | `GenerationPackage.spatialReference.controlPasses`                                                        | Frozen copy (by value) of the **current** bundle: asset ids, manifest, camera, per-Character mask identity. Optional; provider-neutral; nothing is injected into prompts                                                                                                  |

Object indices are **bundle-local**; semantic ids (`set_object:<object_uuid>`, `character_proxy:<characterId>`) are
persistent. A bundle is stale (`SCENE` / `CAMERA` / `BLOCKING`, never audio) by fingerprint comparison; it is never
rewritten or deleted. See [virtual-set](virtual-set.md#spatial-control-passes-phase-2f-m2c).

## Gaussian-splat Location environments (Phase 2F M2D.1)

| Entity                | Table / column                                                                                                                                                             | Nature                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SpatialReconstruction | `location_spatial_reconstructions` (`method`, `result_kind`, `result_asset_id`, `result_checksum`, `source_assets_json`, `calibration_json`, `reconstruction_fingerprint`) | ONE **immutable** provenance record per reconstruction of a **Location**: the private result Asset, the reference images it came from (may be none), the calibration the source claimed on arrival, a content fingerprint. M2D.1 only records `imported` Gaussian splats. Owner-only RLS; no worker grants; unique `(location_id, reconstruction_fingerprint)` |
| Splat Asset           | `assets` (`type = '3d'`, `purpose = 'spatial_reconstruction'`, `application/x-gaussian-splat` / `x-spz` / `x-ply`)                                                         | Private; pinned by its reconstruction; never uploadable through the generic library                                                                                                                                                                                                                                                                            |
| Splat scene object    | `PrevisDocument.objects[]` (`kind = 'splat'`, `reconstructionId`, `calibration`)                                                                                           | Mutable **placement** (transform, visibility, lock) and scale provenance. Part of the Set fingerprint (asset checksum, transform, visibility, calibration)                                                                                                                                                                                                     |
| SpatialEnvironmentRef | `GenerationPackage.spatialReference.spatialEnvironment`                                                                                                                    | Frozen copy (by value) of the splat object and its reconstruction identity and provenance. Optional; provider-neutral; no bytes, no URLs                                                                                                                                                                                                                       |

Origin (the reconstruction) and placement (the scene object) are separate on purpose: re-positioning an environment never
rewrites where it came from. See [virtual-set](virtual-set.md#gaussian-splat-location-environments-phase-2f-m2d1).

## Reconstruction jobs (Phase 2F M2D.2)

| Entity                   | Table / column                                                                                                                                                                                                    | Nature                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ReconstructionJob        | `reconstruction_jobs` (`job_fingerprint`, `attempt`, `previous_job_id`, `provider`, `provider_capability`, `provider_model`, `source_assets_json`, `options_json`, `status`, `revision`, `provider_operation_id`) | ONE row per ATTEMPT of a request to reconstruct a Location from reference images. Sources frozen by value in the user's ORDER. Status derived by the server only; transition matrix, frozen request, never-replaced operation id and terminal immutability enforced by the database. Owner-only RLS; no worker grants |
| JobEvent                 | `reconstruction_job_events`                                                                                                                                                                                       | Append-only, sanitised history (created, submitted, progress, succeeded, failed, cancelled, retry_created …)                                                                                                                                                                                                          |
| Generated reconstruction | `location_spatial_reconstructions` (`method = 'generated'`, `job_id`, `provider`, `provider_capability`, `provider_model`, `provider_operation_id`, `generation_json`)                                            | The same immutable record an import produces, plus job/provider provenance; sources keep the job's order; exactly one per job                                                                                                                                                                                         |
| Result Asset             | `assets` (`type = '3d'`, `purpose = 'spatial_reconstruction'`, `source = 'provider_output'`)                                                                                                                      | The validated, checksummed, PRIVATE copy of the provider's result. Provider URLs are never stored                                                                                                                                                                                                                     |
| Provider-estimated scale | calibration `scaleMethod = 'provider_estimated'`                                                                                                                                                                  | A provider's documented metric-scale ESTIMATE (e.g. World Labs `metric_scale_factor`); never called exact                                                                                                                                                                                                             |

A job is Location history; only the reconstruction a saved Set actually uses reaches a GenerationPackage
(`spatialReference.spatialEnvironment.generation`). See [reconstruction-providers](reconstruction-providers.md).
