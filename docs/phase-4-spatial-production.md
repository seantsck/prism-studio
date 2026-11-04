# Phase 4 — Spatial Production

**Status: 4A complete (architecture accepted by the owner 2026-11-01, decisions in [§12](#12-accepted-owner-decisions)).
4B (Shot Lighting Rigs) complete (PR #46); migration 0048 applied to and accepted on hosted DEV (hosted head 0048, nothing
pending). 4C architecture is in review ([4C-A](#4c-a-architecture-in-review)); 4C implementation and 4D–4F have not
started. What 4B actually shipped is
recorded in [4B implementation notes](#4b-implementation-notes); elsewhere, design text describes intent.**

Phase 4 finishes the optional spatial path into a Production Frame. It does not build a 3D system: Phase 2F already built
one, in a different shape from the one the old roadmap described. What is missing is Shot-owned lighting, a workflow that
starts from the Shot, reusable setups, and a documented, tested refusal of splat control passes.

Abbreviations for citations: `VS` is [virtual-set.md](virtual-set.md), `PF` is [production-frames.md](production-frames.md).

## 1. Phase 2F foundation

Evidence is a static read of the code, plus read-only hosted counts taken on 2026-11-01. "Location" and "Shot" name the
owner.

| Capability                     | State    | Owner    | Authority and where it lives                                                                                                                                                      | Known limit                                                                                                      |
| ------------------------------ | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Persistent scene               | built    | Location | `location_scene_documents`, `prism.previs.v1`, one per Location, compare-and-set revision (`0030`, `src/domain/previs/types.ts`)                                                  | No hierarchy UI                                                                                                  |
| Set geometry, GLB              | built    | Location | Document `objects[]`; `kind=glb` resolved to `m_<assetId>` (`src/domain/previs/document.ts`)                                                                                      | Single file; no Draco, KTX2 or Meshopt (VS "Known gaps")                                                         |
| Splat environment              | built    | Location | `kind=splat` plus `location_spatial_reconstructions` (`0035`, `src/domain/previs/splat.ts`)                                                                                       | One per Set; 50 MB and 8M Gaussians; software-renderer proof only                                                |
| Navigation vs production cam   | built    | Location | `productionCamera`; `editor.navigationCamera` is excluded from the fingerprint                                                                                                    | Inspector camera edits are not undoable                                                                          |
| Camera bookmark                | built    | Shot     | `shot_camera_bookmarks` (`0030`), basis `vertical-sensor-24mm`                                                                                                                    |                                                                                                                  |
| Camera path                    | built    | Shot     | `shot_camera_paths`, `prism.camera-path.v1` (`0031`, `src/domain/previs/camera-path.ts`)                                                                                          | Engine timeline unused                                                                                           |
| Local previs, audio mix        | built    | Shot     | `shot_previs_clips` (`0031`, `0032`), `prism.previs-audio-mix.v1`                                                                                                                 | Static blocking pose; no mixer                                                                                   |
| Blocking, rig, pose            | built    | Shot     | `shot_character_blocking`, `prism.shot-blocking.v1`, `prism.humanoid-rig.v1`, `prism.pose.v1` (`0033`)                                                                            | FK only, no IK, no pose animation                                                                                |
| Master Frames                  | built    | Shot     | `scene_master_frames` (`0030`, `0033`), `src/server/previs-actions.ts`                                                                                                            | Needs a saved set and a linked camera; see [§9](#9-findings-this-audit-surfaced)                                 |
| Production Frame handoff       | built    | Shot     | `promoteMasterFrame` creates a `shot_production_frames` row with source `previs_master` and selects it (`0039`, `src/server/production-frame-actions.ts`)                         | Aspect mismatch refused, never cropped                                                                           |
| Depth, object id, masks        | built    | Shot     | `shot_spatial_pass_bundles` (`0034`), `src/domain/previs/spatial-passes.ts`                                                                                                       | One frame per capture; raw rasters; refused when a splat is visible                                              |
| Reconstruction jobs            | built    | Location | `reconstruction_jobs`, `prism.reconstruction-job.v1` (`0036`, `0037`)                                                                                                             | No automatic fallback                                                                                            |
| Local and remote agent capture | partial  | Location | `src/lib/reconstruction/local-capture.ts` (`not_installed` until a toolchain exists); `local_agents` (`0038`), gated by `PRISM_LOCAL_AGENTS_ENABLED`                              | Not production ready. No real COLMAP or Brush run ([reconstruction-acceptance.md](reconstruction-acceptance.md)) |
| Package reference              | built    | Shot     | `spatialReference` frozen by value (`src/domain/previs/spatial.ts`); key omitted when absent (`src/domain/generation-package.ts`). Assets by id and checksum, never bytes or URLs |                                                                                                                  |
| **Shot lighting**              | **none** | —        | Text only, see [§5](#5-shot-lighting-architecture)                                                                                                                                |                                                                                                                  |

**Boundary.** `SpatialSceneAdapter` (`src/lib/previs/scene-adapter.ts`) is the architectural boundary, implemented by
`ArtCraftSceneAdapter` over the vendored ArtCraft-derived Three.js engine at a pinned commit. New spatial capability goes
through it. `blocking-overlay.ts` is the one other module that touches engine internals (`UPSTREAM.md`), which VS's "only
the adapter" sentence omits.

**Security shape, to be copied by anything new.** Owner-only RLS, no worker grant, and repo memory and Postgres twins.

**Hosted data.** All spatial tables hold 0 rows. `storyboard_frames` holds only `sketch` sources. No `generation_attempts`
snapshot has a `spatialReference`. So additive Phase 4 migrations have nothing to backfill today, and no feature here has
yet been accepted against real hosted spatial data.

## 2. Why the old roadmap wording is obsolete

| Old statement                                               | Classification             | What is true now                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React Three Fiber set editor attached via `locations.set3d` | Implemented differently    | The editor exists, on the ArtCraft-derived Three.js engine, attached through `location_scene_documents`. No R3F anywhere. **R3F is not a requirement, and the working engine is not to be replaced because the roadmap once named another library.** `locations.set3d` was never used as the attachment. |
| Camera rigs replace `spatial.marks`                         | Implemented differently    | Cameras are `shot_camera_bookmarks` and `shot_camera_paths`. They did not replace marks; they sit beside them.                                                                                                                                                                                           |
| Blocking markers replace `spatial.marks`                    | Implemented differently    | `shot_character_blocking` is the 3D authority. `spatial.marks` stays as authored text intent ([§8](#8-camera-blocking-and-reconstruction-decisions)).                                                                                                                                                    |
| 3D previews become `storyboard_frames(source='3d_preview')` | Implemented, not primary   | `adoptMasterFrame` writes that source, and it works. The canonical route is now Master Frame promotion to a Production Frame, which does not need adoption.                                                                                                                                              |
| Light rigs feed `lighting`                                  | Obsolete, and wrong way up | A rig must not write the authored `lighting` text. Authored intent and spatial implementation are separate truths ([§5.2](#52-four-separate-truths)).                                                                                                                                                    |
| Light rigs feed the generation package                      | Still missing              | No Shot-owned spatial lighting exists. Designed below as optional `spatialReference.shotLighting`.                                                                                                                                                                                                       |
| Phase 4 is the persistent 3D set                            | Mostly delivered by 2F     | Persistent scene, cameras, blocking, previs, Master Frames, control passes, splats and the handoff are delivered. Phase 4 is what remains.                                                                                                                                                               |

### `locations.set3d` and `set3d_model_asset_id`

| Question                      | Answer                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authoritative paths?          | None. No authoring path, and no previs, render or package use.                                                                                                                                                                                                                                                                                                      |
| What still touches them?      | Column definitions (`0001_core.sql`); pass-through mapping (`src/data/postgres-mapping.ts`); schema (`src/domain/schemas.ts`); action preserving the existing value (`src/server/actions.ts`); seed and fixture nulls. **One real read:** `src/domain/asset-usage.ts` reports `set3d_model` where-used. So `domain-model.md` calling it "unused" is slightly wrong. |
| Hosted data?                  | None: 0 of 8 Locations have a non-empty `set3d` or a `set3d_model_asset_id`.                                                                                                                                                                                                                                                                                        |
| Duplicates current authority? | Yes in meaning. `{cameraRigs, blockingMarkers, lightRigs}` overlaps bookmarks, blocking and the proposed rig table, and it is Location-owned where those are Shot-owned.                                                                                                                                                                                            |
| Stay deprecated?              | Yes. **Legacy and non-authoritative. No new feature may read or write them.**                                                                                                                                                                                                                                                                                       |
| Later removal?                | After Phase 4 ([D7](#d7--locationsset3d-removal-after-phase-4)), as its own forward-only migration plus removal of the mapping, schema and where-used reader.                                                                                                                                                                                                       |
| Would removal break history?  | Not on current evidence: no package reads them and hosted is empty. Re-check counts on every environment immediately before any removal. **Nothing is removed by 4A.**                                                                                                                                                                                              |

UI copy at `src/app/projects/[project]/locations/page.tsx` still promises "A future 3D Set". That is stale; 4C corrects it.

## 3. Authority matrix

The matrix proposed for this gate matches the code, with the refinements below.

| Truth                        | Authority                                                                             | Not authority                                          |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Location geometry            | `location_scene_documents` / `prism.previs.v1`                                        | `locations.set3d`                                      |
| Reconstruction               | `location_spatial_reconstructions`, with the splat object saved in the scene document | Job rows, which are process history                    |
| Static Shot camera           | `shot_camera_bookmarks`                                                               | `editor.navigationCamera`; `productionCamera` alone    |
| Camera motion                | `shot_camera_paths`                                                                   | Engine timeline                                        |
| Blocking                     | `shot_character_blocking`                                                             | `spatial.marks`, `locations.set3d`                     |
| **Shot lighting (proposed)** | **`shot_light_rigs`**                                                                 | Location scene; the `lighting` text; `locations.set3d` |
| Authored lighting intent     | `shot.lighting`, time of day, weather; `location.lighting`; `continuity.lighting`     | Any rig                                                |
| Render provenance            | `scene_master_frames`, `shot_previs_clips`, `shot_spatial_pass_bundles`               | Live scene state                                       |
| Canonical visual             | `shot_production_frames` and the selection pointer                                    | Master Frames; `3d_preview` storyboard frames          |
| Downstream frozen            | `GenerationPackage.spatialReference`                                                  | Any live pointer                                       |

Differences from the proposed matrix:

1. **Lighting is two truths**, and the authored one has three text sources today.
2. **A Master Frame's camera provenance is a pointer.** `camera_bookmark_id` has no camera fingerprint, unlike blocking.
3. **`spatial.characterBlocking` in `spatialReference` is legacy**, kept for historical shape; `shotBlocking` is current.
4. **The provenance tables do not all enforce immutability.** See [§9](#9-findings-this-audit-surfaced).

## 4. Image-first invariant

> **3D is an optional construction tool for a Production Frame, never a prerequisite for one.**

Default path:

```text
script → performance → Shot Prep → storyboard → Production Frame → image-to-video → Episode Edit → QA
```

Optional spatial construction:

```text
Location scene + Shot camera + Shot blocking + Shot lighting → Master Frame → Production Frame
```

No-3D filmmaking stays byte-compatible wherever the optional spatial keys are absent.

Today's code already honours this (PF top section; `production-workflow.md`; `src/domain/production-frame.ts`; tests in
`production-frame.test.ts`; `e2e/zzzzzzzzzzzzzzz-production-frames.spec.ts`). A Shot with no scene promotes a storyboard,
upload or generated image, and its package has no `spatialReference` key. Rules for every Phase 4 slice:

- No Phase 4 migration, preflight check, QA criterion or UI step may require a scene, camera, blocking or rig.
- Every new package key is optional and omitted when absent, so historical and no-3D packages stay byte-comparable.
- Each slice carries a test that a Shot with no spatial data reaches a selected Production Frame and a valid package.

**Production Frame authority.** The Production Frame is the downstream visual authority. The Master Frame is a
deterministic render and its provenance. Promotion reuses the Asset and writes an immutable row. Later spatial edits never
silently rewrite either one or the selection, and they do not stale the Production Frame: the scene is deliberately not a
freshness part (PF; `production-frame.test.ts`). Video generation reads stored Assets and never depends on a live viewport.

## 5. Shot Lighting architecture

### 5.1 Current state

- **Engine base rig**, created by the vendored engine rather than authored: hemisphere 3.0, directional 2.0 with shadows
  off, plus an ambient light added only by some skybox branches (`src/vendor/artcraft-scene-engine/engine/scene.ts`).
- **Scene lights**: the schema has `kind: "light"` with transform and colour only. An engine `PointLight` is hardcoded to
  intensity 1, range 100, and neither value persists. No Prism UI can add one (`PrimitiveKind` omits lights). In practice
  every set is lit by the base rig.
- **Skybox**: a saved `skybox` changes which base lights exist, is **outside the scene fingerprint**, and has no Prism UI.
- **Shadows**: the static read found no `shadowMap` enablement in the engine scene or adapter, and the base rig has
  `castShadow = false`.
- **Text**: `shot.lighting` reaches the prompt, package, QA, Production Frame intent and freshness; `location.lighting`
  reaches freshness, package and prompt; `continuity.lighting` reaches package and sequence QA.
- **Pixels**: Master Frames and previs render the live lit scene, so lighting changes them. Control passes do not depend on
  it: their shader override sets `lights: false`, lights are hidden, and environment and fog are nulled
  (`src/lib/previs/spatial-pass-renderer.ts`).

So a Shot cannot express "night, single practical from camera left" spatially. **Shot Lighting is needed.** The base rig's
3.0 + 2.0 also means added lights alone cannot make a dark scene, so the design must control the base, not only add to it.

### 5.2 Four separate truths

| Truth                                   | Meaning                    | Changes when                 |
| --------------------------------------- | -------------------------- | ---------------------------- |
| `shot.lighting`, `timeOfDay`, `weather` | Authored intent (text)     | A writer edits it            |
| `ShotLightingRig`                       | Spatial implementation     | The rig is saved             |
| Master Frame `lighting_json`            | What was actually rendered | Never, once captured         |
| Production Frame                        | The approved image         | Never; a new one is selected |

Neither truth writes another. No rig save edits text, and no text edit changes a rig. Prism does not try to judge whether a
rig "matches" prose. Conflict is detected deterministically: the rig freezes the authored text it was saved against
(`authoredIntent`), and a later difference surfaces as `REVIEW: authored lighting changed since this rig was saved`. It is a
review flag and blocks nothing. A rig saved after `Rain, dusk` became `Clear, noon` still renders exactly as saved until a
person changes it.

### 5.3 Proposed schema: `prism.shot-lighting.v1`

```ts
interface ShotLightingRigV1 {
  schema: "prism.shot-lighting.v1";
  /** how the engine's built-in lights behave for this Shot; see below */
  base: { mode: "engine_default" | "replace" };
  lights: ShotLightV1[]; // ordered by id for fingerprinting; capped, proposed 16
  authoredIntent: { lighting: string; timeOfDay: string; weather: string };
}

interface ShotLightV1 {
  id: string; // stable within the rig
  role: "key" | "fill" | "rim" | "practical" | "background" | "other"; // a label; it changes no pixels
  label: string; // excluded from the fingerprint, like the role
  type: "directional" | "point" | "spot" | "ambient";
  enabled: boolean; // disabled lights stay in the document and in the fingerprint
  color: string; // lowercase #rrggbb, always authoritative
  intensity: number; // finite, >= 0, capped
  position?: Vec3; // point, spot, directional
  target?: Vec3; // spot, directional. A target, so orientation has one representation
  range?: number; // point, spot. 0 means unbounded, as in Three.js
  coneAngleDeg?: number; // spot only
  penumbra?: number; // spot only, 0..1. This is the edge softness, nothing more
  castShadow?: false; // v1 refuses true (D1)
}
```

What the renderer can honestly support decides each field:

| Field              | Decision                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`             | Three.js types that work on the materials in use (Phong primitives, Standard mannequins). **`RectAreaLight` is excluded**: it needs Standard or Physical materials, so primitives would silently ignore it.        |
| Colour temperature | **Not a stored field.** Three.js has no Kelvin input. A later UI helper may convert Kelvin to `color` at authoring time; `color` stays the only truth.                                                             |
| Softness           | **Spot `penumbra` only.** No area-light softness, and no claim of physically based falloff or photometric units. `intensity` is an engine value, not lumens.                                                       |
| `castShadow`       | **`true` is refused by schema and domain validation in v1 ([D1](#d1--shadows-v1-ships-without-them)).** UI and docs say v1 does not simulate authored shadows. 4B does not enable shadow maps.                     |
| `base.mode`        | `engine_default` keeps today's look. `replace` suppresses the base rig for this Shot, so dark scenes are possible; authored scene lights and the skybox visual remain ([D2](#d2--base-replace-is-required-in-v1)). |

**Domain and engine stay separate.** `src/domain/previs/lighting.ts` holds the zod schema, normalisation, fingerprint and
stale logic, and imports no Three.js. Translation to engine objects lives behind `SpatialSceneAdapter`. The engine's
`media_id`, uuids and light classes never appear in the document.

**Fingerprint.** `lighting_fingerprint` is a SHA-256 over canonical JSON of pixel-affecting fields only: `base`, and each
light sorted by `id`, without `role`, `label` or `authoredIntent`. Relabelling therefore does not stale a render.

### 5.4 Overlay layering

**Shot Lighting is an overlay and must not alter `location_scene_documents` or `sceneFingerprint`.**

```text
Location scene -> sceneFingerprint
Shot lighting  -> lightingFingerprint
```

A rig save may carry the scene revision and fingerprint it was authored against, for review and staleness. That does not make
it part of Location scene truth. The overlay follows `BlockingOverlay` exactly:

- Overlay objects carry no `media_id`, so the scene save filter skips them, and the scene document and its fingerprint are
  untouched. A test must assert both.
- `setFigures` and `reattachAll` have direct analogues: swap per Shot, and re-attach after scene load.
- **Layers matter.** Three.js layer-tests lights against the camera, so overlay lights must stay on layer 0 and their
  helpers on layer 1, which production cameras disable. A `cleanRender` hides gizmos.
- `base: replace` is applied and **restored exactly** on switching Shots, clearing a rig, unloading the editor, and when a
  render or capture exits or fails, so one Shot's rig cannot leak into another Shot's render.
- Scene-level lights remain Location truth. A rig does not edit them; `replace` covers the engine base only.
- Adapter additions, proposed: `lighting.setRig`, `lighting.clear`, `lighting.select`, and a read of the applied fingerprint
  for the capture guard.

### 5.5 Persistence: `shot_light_rigs`

Candidate shape for **0048, not created by this gate**. It follows `shot_character_blocking`.

```text
shot_light_rigs
  id, project_id, shot_id, location_id, scene_document_id
  scene_revision, scene_fingerprint        the set state it was authored against
  schema_version                           check = 'prism.shot-lighting.v1'
  revision                                 compare-and-set, +1 per save
  rig_json                                 check: object, schema matches
  lighting_fingerprint                     char(64)
  created_by, created_at, updated_at, metadata
  unique (id, project_id); unique (shot_id)   one current rig per Shot
  composite FKs to shots, locations, location_scene_documents, each cascading on project
  guard trigger: cannot move between projects, Shots or Locations
  owner-only RLS; no worker grant
```

**Is 0048 appropriate? Yes, as one forward-only migration in 4B and only there.** It is expected to contain:

- `shot_light_rigs`;
- nullable lighting provenance on `scene_master_frames` and on `shot_previs_clips` ([§5.6](#56-render-provenance));
- narrow provenance guards for those two historical-render tables ([D3](#d3--provenance-guards-in-0048));
- the required indexes, constraints, RLS and grants.

Nothing is backfilled, because hosted is empty and historical nulls are correct.
Scene edits do not invalidate a rig: light positions are world coordinates, so a changed set raises a review flag from
`scene_fingerprint`, as blocking does.

### 5.6 Render provenance

Additive and nullable on `scene_master_frames` and `shot_previs_clips`:

```text
lighting_fingerprint text null check (char_length = 64)
lighting_json        jsonb null
```

- **Null means no rig was applied,** which is every historical render. Historical rows are never rewritten or backfilled,
  and null never gets a guessed value.
- `lighting_json` is the frozen rig plus the **base environment actually in effect**: engine base state and the saved
  `skybox` identifier. That closes the skybox gap for lit renders without changing `sceneFingerprint`, which would falsely
  stale every historical comparison.
- Server guard, copied from blocking: the claimed fingerprint must equal the one derived from the saved rig, or the capture
  is refused.
- Staleness is a new pure `masterFrameStaleReasons`, plus a `lighting` reason in `previsStaleReasons`. Master Frames have no
  such function today ([§9](#9-findings-this-audit-surfaced)).

### 5.7 Staleness boundaries

| Artifact                         | Rig change does | Why                                                                            |
| -------------------------------- | --------------- | ------------------------------------------------------------------------------ |
| Master Frame                     | Stale flag      | Pixels depend on lights                                                        |
| Local previs                     | Stale flag      | Pixels depend on lights                                                        |
| Depth, object id, mask bundles   | **Nothing**     | `lights: false`; lights hidden; no dependency. **A test must pin this**        |
| Camera bookmark, path, blocking  | Nothing         | Independent truths                                                             |
| Selected Production Frame        | Nothing         | The immutable visual authority. Its source Master Frame may show a review note |
| Shot textual lighting, freshness | Nothing         | Rig is not a freshness part. `shot.lighting` text remains one, unchanged       |

### 5.8 GenerationPackage

Optional `spatialReference.shotLighting`, frozen by value, following `cameraMotion`:

```ts
interface ShotLightingReference {
  schemaVersion: 1;
  rigId: string;
  rigRevision: number;
  lightingFingerprint: string;
  sceneRevision: number; // the set state it was authored against; may differ from live
  sceneFingerprint: string;
  rig: ShotLightingRigV1; // by value. No URLs, no live pointers, no bytes
  /** the lighting the selected Production Frame's source Master Frame rendered, if any */
  productionFrameLightingFingerprint: string | null;
}
```

- **No rig: key omitted.** Historical packages and no-3D packages are unchanged, and no schema bump is needed, as with
  `cameraMotion` and `shotBlocking`.
- **It does not replace authored `lighting`.** Both travel. The authored text remains what the prompt plan uses.
- `productionFrameLightingFingerprint` exists because the rig may have moved on since the approved image was rendered. A
  mismatch is visible in the package and is not corrected. This avoids repeating the gap in [§9](#9-findings-this-audit-surfaced).
- **Later, not 4B:** a deterministic prose summary such as "single warm key from camera left, low fill" could be derived for
  provider prompts. It needs the same no-3D byte stability and its own review. **4B wires no provider and changes no prompt.**

## 6. Shot-centric workflow

Today the only route is `/projects/[project]/locations/[locationId]/3d?shot=`, reached through "Open in 3D Set" in Shot Prep.
The editor is Location-first with an optional Shot.

**Decision (4C): a Shot route over the same engine, not a second scene system.** A Shot-owned entry such as
`/projects/[project]/shots/[shotId]/spatial` resolves the Shot's Location and mounts the same editor and adapter. The same
Location scene is edited by the same CAS path. The workspace shows the Shot's camera, blocking and rig, then capture, then
"Use as Production Frame". A Shot with no Location, or with a Location with no scene, sees a plain explanation and a route
back to the image-first path. It is never a blocker. Editing Location geometry from a Shot must be visibly a Location edit,
since other Shots share it.

## 7. Reusable setups

**Decision (4D): explicit copy-by-value templates.** A template is a saved camera, lighting or blocking value that a person
applies to a Shot. Applying writes a normal revision of the Shot's own row and records `applied_from_template_id` and the
template revision as provenance. **There is no live link: editing or deleting a template rewrites nothing**, neither Shots
nor renders nor packages. Scope is Location for anything in world coordinates, since coordinates mean nothing in another set.
Project-wide scope is limited to values that do not depend on position, such as lens-only camera presets.

## 8. Camera, blocking and reconstruction decisions

**Camera: split accepted.** Navigation (never fingerprinted), production (scene), bookmark (static Shot) and path (motion
Shot) are distinct and work. **No second camera-rig table.** Named camera "rigs" are templates under §7. This closes the old
`cameraRigs` idea.

**Blocking: `shot_character_blocking` accepted. `spatial.marks` is not revived.** Marks remain authored text. Remaining uses:
written in `src/server/actions.ts`, defaulted in `shot-defaults.ts`, read by `src/domain/preflight.ts` as a blocking check and
by `shot-prep-view.tsx`, and carried indirectly by the whole `shot.spatial` in fingerprint, package and Production Frame
intent. Editing marks therefore stales the `blocking` part, and that behaviour stays. Nothing links marks to 3D blocking, and
nothing should start to.

**Reconstruction: optional.** A splat can be imported without running a capture. Real local reconstruction stays "PRODUCTION
READY: NO" with Gates A, B and C unpassed. **M2D.3D2 does not block any Phase 4 slice.** Phase 4 acceptance must not depend on
a real COLMAP or Brush run.

**Splat control passes: the refusal is accepted ([D6](#d6--splat-control-passes-the-current-refusal-is-accepted)).** Today's
refusal stands in panel, client and server, with its honest message. Depth from a Gaussian renderer is a different thing from
mesh depth, and object ids and masks have no direct equivalent. Any approximate output must use a **new, distinct pass schema**
and may never claim the current exact ones. Whether a rig has any effect on a splat is unverified, since splats generally carry
baked appearance. 4B must test it and tell the user plainly if lights do not affect the environment.

## 9. Findings this audit surfaced

These are real gaps in merged code, recorded here and fixed only by the slice named.

| #   | Finding                                                                                                                                                                                            | Disposition                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | **Scene fingerprint omits lighting and skybox**, so the picture can change while the fingerprint does not. VS's fingerprint section does not say so.                                               | 4B records base environment; doc corrected                                              |
| 2   | **Master Frames have no staleness function.** Only an inline blocking compare in `virtual-set-editor.tsx`; VS implies more. Shot Prep shows none.                                                  | 4B adds it; 4C surfaces it in Shot Prep                                                 |
| 3   | **Master Frames have no camera fingerprint**, only `camera_bookmark_id`.                                                                                                                           | 4C adds a nullable additive column; historical stays null                               |
| 4   | **Promotion has no Master Frame staleness check** (`promoteMasterFrame_impl`). A stale frame promotes without warning.                                                                             | 4C warns and requires confirmation. It does not refuse: an older look can be the choice |
| 5   | **Production Frame intent `spatial` freezes live `ctx.spatial`**, not the source Master Frame's fingerprints, so the two can differ.                                                               | 4C records source fingerprints additively                                               |
| 6   | **"Never rewritten" is not enforced on `scene_master_frames` or `shot_previs_clips`.** No guard trigger; owner policy is `for all`. Only the bundle table is guarded, and DELETE stays open there. | 4B, in 0048 ([D3](#d3--provenance-guards-in-0048))                                      |
| 7   | Doc drift: VS "M2 reuse" lists built features as unbuilt; VS's adapter sentence; `domain-model.md` "unused".                                                                                       | 4F, docs only                                                                           |

## 10. Slices

Each slice is its own branch, PR, review and gate. Provider and network calls are **none** in every slice unless stated.

### 4A — Consolidation (accepted)

- **Goal:** this document, roadmap, tracking issue.
- **Domain, persistence, UI, package, tests, hosted:** none.

### 4B — Shot Lighting Rigs

- **Goal:** a person can light one Shot, capture it, and see truthful provenance.
- **Domain:** `prism.shot-lighting.v1`, normalisation, fingerprint, `masterFrameStaleReasons`, `lighting` in `previsStaleReasons`.
- **Persistence:** migration 0048 ([contents](#55-persistence-shot_light_rigs)), after auditing every update path; memory and
  Postgres twins; CAS actions.
- **UI:** lighting panel in the existing editor; overlay; add, edit, disable and delete lights; base mode; stale and review flags.
- **Package:** optional `spatialReference.shotLighting`. No prompt change.
- **Tests:** schema refusals (including `castShadow: true`); fingerprint ignores labels; scene save and fingerprint unchanged by
  a rig; no leak across Shots; **control-pass bytes unchanged by a rig**; historical package byte-stable; no-rig and no-3D
  paths; guard refuses a mismatched fingerprint; light visibly changes a Master Frame; light effect on a splat recorded; base
  restored after a failed capture; every permitted and refused guard mutation on real PostgreSQL; Postgres RLS and behaviour.
- **Hosted acceptance:** apply 0048 through the standard dry-run gate, `db:validate`, `db:behavior`, `db:rls`, non-owner denial.
- **Non-goals:** shadows; Shot route; templates; prose summary; relighting a Production Frame.

#### 4B implementation notes

Status: **complete** (PR #46). 0048 is applied to and accepted on hosted DEV; the record is in
[migration-policy](migration-policy.md). The final implementation includes the deterministic base-environment fix (below):

- the UI theme no longer affects production rendering;
- the engine's base lights are rebuilt on every scene load;
- the saved base directional light's visibility and position are not independent production authority.

So `prism.render-lighting.v1` (`baseEnvironment {upstreamCommit, skybox}`) is enough for the accepted contract.

- **Domain** (`src/domain/previs/lighting.ts`): `prism.shot-lighting.v1`; light types `ambient | point | directional |
spot`; at most 16 lights; base modes `engine_default | replace`; `castShadow: true` refused (an explicit `false` is
  dropped in normalisation). Every number is the Three.js engine value the renderer consumes (no lumens, Kelvin or
  softness). `lightingFingerprint` covers `schema`, base mode and each light's pixel-affecting fields, sorted by id and
  rounded to 1e-5; **label, role and authored intent do not affect it**, and a disabled light stays in it. The authored
  intent (`Shot.lighting`, `continuity.lighting`, time of day, weather) is read server-side when a rig is saved and only
  drives the non-blocking `REVIEW: authored lighting changed…` flag, as does `REVIEW: the set changed…`.
- **Overlay** (`src/lib/previs/lighting-overlay.ts`): Shot lights carry no `media_id`, so the engine's save filter skips
  them. Lights render on layer 0; markers are on layer 1 only, which production cameras disable. `replace` hides the
  engine's base hemisphere, directional and ambient lights and spares authored Location lights. Serialising the Set runs
  under `withBaseRestored` (on success and on a throw), so **a rig changes neither the scene document nor
  `sceneFingerprint`**. A Shot switch, a clear or an editor unmount restores the exact prior base state. A scene load
  re-attaches the overlay once, and first gives back what it suppressed, because a load whose JSON lacks the engine's
  `DirectionalLight` (or a superseded load) keeps the same base-light objects (fixed during review; covered by unit tests).
  Also fixed during review: the camera-path overlay effect depended on all of `CameraMotionPanel`'s props, so each state
  update from the lighting panel rebuilt the overlay's meshes and materials; it now depends only on what it draws
  (`spatial-passes` "a capture leaves the live scene… unchanged" caught it).
- **Provenance**: Master Frames and previs clips record `lighting_fingerprint` + `lighting_json`
  (`prism.render-lighting.v1`: the rig by value plus the base environment, upstream commit and skybox). The server reloads
  the saved rig and refuses a render whose claimed fingerprint differs; unsaved lighting cannot be captured. null/null
  means "no rig recorded"; nothing is backfilled. `masterFrameStaleReasons` (scene, blocking, lighting) and `lighting` in
  `previsStaleReasons` compare that provenance with the Shot now. Lighting never stales a control-pass bundle.
- **Base environment (technical-review fix)**: **the application UI theme is never production visual truth.** Audit of
  the engine's base rig: hemisphere (colour, ground colour, intensity), ambient (colour, intensity) and directional
  (colour, intensity, target) are engine constants; their presence and the background depend on the skybox. Two inputs
  varied behind identical provenance and are removed by vendor patch 15 (`UPSTREAM.md`): the page's `theme-light`
  class switched the background and the base lights, and the saved `DirectionalLight` entry's transform and visibility
  were applied on load (while `sceneFingerprint` excludes that light), with a load that omitted it re-adding the previous
  scene's lights. The rig is now rebuilt fresh on every load and only its identity round-trips. So the base
  environment is fully determined by `upstreamCommit` and the saved `skybox`, `prism.render-lighting.v1` keeps that
  smaller shape, and 0048 is unchanged. Browser proof: the same Set renders the same production pixels with and without
  `theme-light` (no rig, `engine_default` + a light, `replace` + a light; before the fix the difference was 208/255),
  and a hidden, moved or omitted saved base light renders the same pixels as the saved default (31/255 before). Any
  future Prism change to base-rig behaviour must change the recorded engine identity.
- **Package**: optional `spatialReference.shotLighting`, frozen by value; **omitted, never `null`, without a rig**. A Shot
  whose only spatial data is a rig is still discovered. `productionFrameLightingFingerprint` follows the selected
  Production Frame → `source = previs_master` → its own `source_master_frame_id` → that Master Frame's
  `lighting_fingerprint`; never the current rig or the newest or adopted frame, and null when the chain does not apply.
  No prompt changed.
- **Splat observation** (synthetic `.splat` plane, memory mode, no provider or reconstruction call): sampled centre pixel
  `[227,124,110]` with the engine base, with `replace` and no lights, and with a strong red point light. **Shot lights do
  not affect a Gaussian splat's pixels**: splat colour is baked. The panel says so (`lighting-splat-note`). This is not
  relighting, and the M2C refusal of splat control passes stands.
- **Pixels**: `replace` with no lights darkens the beauty render below 75% of the base; a red point light then raises
  the red channel by more than it raises green; clearing returns the base picture. Depth, object-id and Character-mask bytes are identical across materially
  different rigs.
- **0048**: `shot_light_rigs` (one current rig per Shot, CAS revision, owner-only RLS, `anon` and both worker roles hold
  no privilege and are denied real SELECT/INSERT/UPDATE/DELETE); nullable lighting provenance pairs on
  `scene_master_frames` and `shot_previs_clips`; deny-by-default provenance guards (D3) on both, allowing only adoption,
  FK `SET NULL` of a deleted bookmark/path, DELETE and cascades. Legacy CHECK constraints previously proven through
  UPDATE are now proven through INSERTs the guard cannot pre-empt. No grant to either worker role changed (catalogue
  diff 0047 → 0048). `anon`'s Supabase-default table grants on the two render tables pre-date 0048 and are unchanged;
  RLS still denies it rows.
- **Local gate** (disposable PostgreSQL 17, 0001–0047 then 0048 after a rolled-back `--dry-run`): `db:lighting`,
  `db:blocking`, `db:previs`, `db:validate`, `db:behavior`, `db:spatial-passes`, `db:production-frames`,
  `db:reconstructions` green. `db:rls` cannot run on the shim (its minimal `storage` schema) and `db:worker-role` fails
  its 6 generation end-to-end checks, **both identically on `main` at 0047**; both passed on hosted (67/67, 63/63).

### 4C — Shot-centric Spatial Workspace and Production Frame handoff

- **Goal:** start from a Shot, finish with a selected Production Frame, without visiting a Location page.
- **Domain:** source fingerprints on promotion; stale warning at promotion.
- **Persistence:** likely one additive migration for master frame camera fingerprint and Production Frame source fingerprints.
- **UI:** Shot route over the same editor; Shot Prep shows Master Frame staleness; correct the stale "future 3D Set" copy.
- **Package:** none beyond additive provenance already designed.
- **Tests:** E2E Shot → camera → blocking → rig → Master Frame → Production Frame → package; no-Location Shot; shared-set warning.
- **Hosted acceptance:** migration gate if one exists, plus the E2E story against hosted.
- **Non-goals:** a second scene system; replacing the Location route; making any step mandatory.

#### 4C-A architecture — accepted

Status: **architecture accepted (PR #49, merged as `b340bcd`); owner decisions P1–P6 accepted (4C.13).**
Implementation order: **camera capture correctness (P5) first**. Audited on `main` `070c1f1`, hosted head 0048. This
section is the plan the 4C implementation follows.

##### 4C.1 What the audit found

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                        | Consequence for 4C                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | The only way into 3D is Shot Prep § Location / set → **Open in 3D Set** → `/projects/<p>/locations/<L>/3d?shot=<id>`. The Location page loads everything for `activeShotId` only.                                                                                                                                                                                                              | A Shot route needs the same loader, not a new one.                                                                                                                 |
| F2  | `VirtualSetEditor` (1085 lines) already is the reusable workspace: one adapter, camera / blocking / lighting / motion / passes panels, Master Frame capture and adoption. Its only Location-route assumption is the in-page Shot `<select>` (`shot-select`).                                                                                                                                   | Reuse it; replace the dropdown by route identity.                                                                                                                  |
| F3  | **Shot-state leak on the Location route:** choosing another Shot in `shot-select` changes only local `shotId`. `bookmark` and `frames` stay the previously loaded Shot's (they are `useState(props…)` with no reset); panels for the new Shot render with `initial = null`; staleness lines are hidden (`shotId === props.activeShotId`).                                                      | Route = Shot identity; the Location route's switcher becomes navigation.                                                                                           |
| F4  | **Capture does not verify the camera.** The browser renders with ITS `bookmark.value` and the server checks only that the Shot has _a_ bookmark on the same scene document. With F3, Shot A's camera can be recorded as Shot B's Master Frame.                                                                                                                                                 | The capture must claim a camera fingerprint the server verifies, as blocking and lighting already are.                                                             |
| F5  | `scene_master_frames` keeps `camera_bookmark_id` only (nulled when the bookmark is deleted, and the bookmark's value can be re-linked). The camera a frame was rendered with is not frozen.                                                                                                                                                                                                    | 0049 adds frozen camera provenance.                                                                                                                                |
| F6  | `promoteMasterFrame` reads only the Master Frame row (same Project and Shot) and its Asset, then `draftProductionFrame` → create + select. **No staleness is computed or shown; a stale frame is promoted silently.** Two call paths: Production Frame section (Shot Prep), nothing in the editor.                                                                                             | Server-side recheck, explicit confirmation, digest.                                                                                                                |
| F7  | `shot_production_frames.source_master_frame_id` is a plain uuid **without a foreign key**; Master Frames may be deleted (0048 allows DELETE). The 4B chain (selected PF → `source_master_frame_id` → that row's `lighting_fingerprint`) silently becomes null when the Master Frame is gone.                                                                                                   | Freeze the source's spatial fingerprints on the Production Frame itself; **no FK is added** (a Production Frame stays history after its source render is removed). |
| F8  | `shot_production_frames` is already fully immutable: `guard_shot_production_frame()` raises on **every** UPDATE; there is no user UPDATE/DELETE policy; Shot/Project cascades still work.                                                                                                                                                                                                      | New columns are immutable with no new guard.                                                                                                                       |
| F9  | 0048's Master Frame guard is deny-by-default (`to_jsonb(new) - [adopted_at, adopted_frame_id, camera_bookmark_id]`).                                                                                                                                                                                                                                                                           | New Master Frame columns are immutable with no trigger change.                                                                                                     |
| F10 | `bookmarkCameraFingerprint(value)` = `fingerprint(controlCameraFromBookmark(value))`: position (1e-6), canonical quaternion, focal length, the 24 mm vertical sensor, vertical FOV, production aspect, 2.39:1 frame size, near 0.05 / far 2000 (the same values `productionRenderSpec` renders with). It refuses any other projection or focal basis. The spatial-pass bundles already use it. | Reuse it as the camera fingerprint; no new canonicalisation.                                                                                                       |
| F11 | Every insert into `scene_master_frames` and `shot_production_frames` names its columns, and reads map by name.                                                                                                                                                                                                                                                                                 | Nullable 0049 columns are safe for current `main` (migration ahead of code).                                                                                       |
| F12 | Stale product copy: Locations page subtitle "A future 3D Set plugs into `set3d`…"; `src/domain/schemas.ts` comment "Extension points for the future 3D Set" (`set3d` is legacy, D7).                                                                                                                                                                                                           | Correct both; nothing else.                                                                                                                                        |
| F13 | A Master Frame is 2.39:1 (`PREVIS_PRODUCTION_FRAME`); promotion refuses a Shot whose production aspect differs (`assetPromotionStatus`).                                                                                                                                                                                                                                                       | Unchanged; the workspace shows the same reason instead of a button.                                                                                                |

##### 4C.2 Route and workspace

- **Route:** `/projects/[project]/episodes/[ep]/shots/[shotId]/spatial` (beside the existing Shot detail route). The route
  is the Shot identity: no Shot switcher. "Previous / next Shot" are links to those Shots' routes.
- **Loader extraction:** move the body of `locations/[locationId]/3d/page.tsx` (scene, bookmark, path, clips, blocking,
  passes, lighting, splats, timing, Master Frames) into one server function, e.g. `loadVirtualSetProps(data, locationId,
shotId | null)`. Both pages call it, through the SAME `getPrevisRepo()`. No Shot-owned scene storage, no second adapter,
  engine or scene table, no R3F.
- **Editor:** `VirtualSetEditor` gains `mode: { kind: "location"; shots } | { kind: "shot"; shot: { id; label; prev?;
next? }; sharedWith: ShotRef[] }`. Shot mode hides `shot-select`; everything else is the same component.
- **Location route** keeps its multi-Shot overview, but `shot-select` **navigates** (`?shot=<id>`) instead of changing
  local state, and the loader is keyed by Shot (`key={activeShotId}`), so every Shot's state is reloaded from the server
  (fixes F3 on both routes). Remounting reloads the scene from the saved document, so unsaved Set edits must be confirmed before the
  navigation (there is no unsaved-changes prompt today; 4C adds one for the Set's dirty state).
- **Resolution on the Shot route:** Shot → `shot.spatial.locationId` → that Location's scene. A Shot whose Location
  changed resolves its NEW Location; its old bookmark / path / blocking / rig (tied to the old scene document) are listed
  as "authored for another set" and are not loaded into the editor (today's saves already refuse a Shot set in another
  Location).

| State                                             | Shot route shows                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Location                                       | "Assign a Location to use optional spatial tools." + a link to § Location / set. No editor.                                                                   |
| Location, no `location_scene_documents`           | **Create 3D Set**: opens the editor on an empty set; the first save creates THE Location's scene (`saveLocationScene`), the same row the Location page edits. |
| Location scene deleted / Location gone            | Same as the two rows above (re-resolved on every request; nothing is cached client-side across routes).                                                       |
| Bookmark deleted / rig cleared / blocking removed | The panel shows "none yet"; Master Frames keep their frozen provenance (camera shows stale or unknown, see 4C.4).                                             |
| Deep link, refresh, back / forward                | Server-rendered from the route; no client state survives a route change (keyed loader).                                                                       |

##### 4C.3 Ownership and the shared-set warning

| Location-owned (one row, every Shot in the Location sees it)                                                         | Shot-owned (independent per Shot)                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `location_scene_documents`: set geometry, GLBs, splat environment, the working production camera, `sceneFingerprint` | `shot_camera_bookmarks`, `shot_camera_paths`, `shot_character_blocking`, `shot_light_rigs`, Master Frames, previs, Production Frames |

- **Working camera vs Shot camera:** the Location's production camera is shared working state. "Use Production Camera
  for Shot" freezes it into THIS Shot's bookmark; "Restore Shot camera" copies the bookmark back into the working camera
  for editing. Neither touches another Shot's bookmark. On the Shot route the workspace restores the Shot's bookmark into
  the working camera on open (a viewport change, not a save; the set is not marked dirty by it, because the dirty check
  already excludes navigation-only state and the restore is applied before the clean baseline is taken).
- **Warning rule:** shown only for Location-owned truth, and only when the Location is shared — `sharedWith` = other Shots
  whose `spatial.locationId` is this Location or that hold any bookmark / path / blocking / rig on this scene document.
  - On open (Shot route, `sharedWith.length > 0`): a quiet line "This 3D Set is shared by N other Shots (2B, 3A…)."
  - When the Set itself is dirty (live `sceneFingerprint` ≠ saved), beside **Save Set**: "Saving changes the Set for
    every Shot in this Location: 2B, 3A. Their Master Frames will show STALE SCENE."
  - Never for camera, blocking or lighting saves (Shot-owned).
- A fingerprint change is the trigger, not a click: moving a light rig or a proxy never shows it, moving a set object does.

##### 4C.4 Camera provenance and Master Frame states

- **Camera fingerprint** = `bookmarkCameraFingerprint(bookmark.value)` (F10). No navigation camera, no browser state, no URL.
- **Snapshot** `prism.render-camera.v1`, stored on new Master Frames:
  `{ schema, cameraFingerprint, bookmarkId, bookmarkLabel, projection: "perspective", focalLengthBasis:
"vertical-sensor-24mm", productionAspectRatio, camera: ControlCamera }`. `camera` is the normalised control camera
  already used for spatial passes: position, canonical quaternion, focal length, sensor height, vertical FOV, aspect,
  frame width / height, near / far (no engine object, no Three.js dump). `bookmarkId` / `bookmarkLabel` are identity
  history, not a live link. The snapshot is built server-side from the bookmark row; browser camera JSON is never stored.
- **Capture (fixes F4):** the browser sends `cameraFingerprint` of the bookmark it rendered with; the server re-reads the
  Shot's bookmark, recomputes, and refuses a mismatch (`conflict`: "The Shot's camera changed after this frame was
  rendered. Capture again."), exactly like the blocking and lighting claims. The stored snapshot is built server-side
  from the bookmark row.
- **Historical rows:** `camera_fingerprint` / `camera_json` stay **null**; null means _camera provenance was not frozen
  at capture_. Never backfilled from current bookmarks, on any installation (hosted happens to hold 0 Master Frames; the
  design does not rely on it).
- **Per-axis state** (new domain function `masterFrameSpatialStatus`, extending `masterFrameStaleReasons`):

| Axis     | fresh                                                                 | stale                                                      | unknown                            |
| -------- | --------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------- |
| scene    | frame's scene doc and fingerprint = the Shot's current Location scene | different fingerprint, different document, or no scene now | —                                  |
| camera   | frame `camera_fingerprint` = fingerprint of the current Shot bookmark | different, or the Shot has no bookmark now                 | frame `camera_fingerprint` is null |
| blocking | as today (frame vs current saved blocking provenance)                 | as today                                                   | —                                  |
| lighting | as today (4B rig + base environment)                                  | as today                                                   | —                                  |

Result: `{ stale: Axis[]; unknown: Axis[] }`; **fresh** = both empty. Unknown is never reported as fresh or stale.
Only camera can be unknown: pre-4B frames had no rig and pre-0033 frames had no blocking, so their nulls are true
statements, not missing provenance.

- **Labels:** existing `STALE SCENE / BLOCKING / LIGHTING` plus `STALE CAMERA — the Shot's camera changed after this
frame.` and `UNKNOWN CAMERA PROVENANCE — this frame was captured before cameras were recorded.`
- `masterFrameStaleReasons` keeps its signature and returns the stale axes (4B callers and tests unchanged); the new
  function is the one promotion uses.

##### 4C.5 Promotion: server recheck, confirmation, TOCTOU

- **Never a hard block.** An older composition may be the one wanted. No recapture, regeneration or approval is automatic.
- **Server is the authority:** `promoteMasterFrame` reloads the exact Master Frame, the Shot's current Location scene,
  bookmark, saved blocking and rig, and computes `masterFrameSpatialStatus` itself. Browser-sent reasons are ignored.
- **State digest:** `promotionStateDigest = fingerprint({ masterFrameId, current: { scene, camera, blocking, lighting },
stale, unknown })`, an absent current value being an explicit `null` and an unknown axis listed in `unknown`. Deterministic, recomputable, not secret, not stored as a credential; ownership stays RLS's job.
- **Flow:**
  1. Submit without a digest. Fresh → promote. Otherwise → `{ ok: false, needsConfirmation: true, stale, unknown,
stateDigest }` (an additive `ActionResult` variant; `ActionForm` renders the reasons and a **Use anyway** button
     that resubmits with `confirmedStateDigest`).
  2. Submit with a digest: the server recomputes the whole state immediately before promotion; equal → promote (the
     success message says the stale / unknown state was confirmed in this request); different → create and select
     NOTHING and return a NEW `needsConfirmation` with the current state (never "promote under reasons B").
  3. A frame that turned stale between display and a plain submit also gets `needsConfirmation`.
- **Stale / unknown are workflow state, never frame truth:** `stale[]`, `unknown[]` and the digest are derived on each
  request and returned or displayed; they are **not persisted** on the Production Frame (P2). A durable
  human-confirmation audit, if wanted later, is a separate append-only event record (not in 4C).
- **Dedup invariant:** `frame_fingerprint` stays the Production Frame's artifact and intent identity. Promotion-time
  stale / unknown status is **not** part of it. Re-promoting a Master Frame that already became Production Frame vN
  reselects vN (the existing immutable row) under whatever the current state is; the reselection is the selection
  table's event, as today.
- One server action for both surfaces (Production Frame section and the workspace); no parallel promotion logic.

##### 4C.6 Production Frame exact-source provenance

**Choice: dedicated nullable columns (Option A)**, because the four values are fixed-width fingerprints the database can
verify against the source row by equality, the 4B chain query reads one of them directly, and the existing
`intent_snapshot` / `parts` hold Shot intent, not render provenance. A JSON blob would need the same trigger with less
readable checks.

| Column                        | Meaning                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `source_scene_fingerprint`    | non-null ⇔ exact spatial source provenance was frozen (the marker)                      |
| `source_camera_fingerprint`   | the Master Frame's `camera_fingerprint` (null = that frame had none: unknown at source) |
| `source_blocking_fingerprint` | the Master Frame's blocking fingerprint (null = no visible proxies)                     |
| `source_lighting_fingerprint` | the Master Frame's lighting fingerprint (null = no rig)                                 |

Promotion-time stale / unknown arrays are **rejected** from Production Frame persistence (P2): they describe one
promotion attempt, and a deduplicated frame can be reselected later under a different current state.

- Values come **only** from `source_master_frame_id` → that exact `scene_master_frames` row, never from current state,
  the newest or the adopted Master Frame. A `BEFORE INSERT` trigger verifies equality with that row (and that it is the
  same Shot, Project and Asset, and that the source Master Frame exists at insert), so neither the browser nor a server
  bug can freeze current state by mistake.
- Historical and non-spatial Production Frames: all four null (_not frozen under this schema_). Never reconstructed.
- **No FK on `source_master_frame_id`** (unchanged): source ids may outlive their row. When the source Master Frame
  still exists the UI links to it; when it was deleted the UI says "Source Master Frame no longer exists; frozen source
  provenance retained." The four fingerprints are the durable lineage and are never nulled.
- Immutable through the existing guard (F8). Later scene / camera / blocking / lighting changes **do not** make the
  selected Production Frame stale and never block image-to-video: it stays the approved visual truth; these columns only
  explain where it came from. Production Frame freshness (`parts`, intent) is unchanged.

##### 4C.7 GenerationPackage

- `spatialReference` stays **current** spatial state (unchanged).
- `references.productionFrame` (the selected frame) gains an optional `sourceSpatial`, **omitted** when not frozen:
  `{ schemaVersion: 1, masterFrameId, sceneFingerprint, cameraFingerprint, blockingFingerprint, lightingFingerprint }`:
  intrinsic source lineage only (no stale / unknown, no URL, no snapshot payload). So
  `references.productionFrame.sourceSpatial` = what produced the selected approved image, and `spatialReference` = what
  the Shot's spatial setup is now.
- `spatialReference.shotLighting.productionFrameLightingFingerprint` keeps its 4B meaning; it reads the frozen
  `source_lighting_fingerprint` when present, otherwise (historical frames) the 4B chain `source_master_frame_id` →
  `scene_master_frames.lighting_fingerprint`, otherwise null; never the current rig, the newest or the adopted Master
  Frame. A 4C Production Frame therefore keeps its lighting lineage after its Master Frame is deleted (P3).
- Packages of Shots without spatial state or without frozen frames are byte-identical. No prompt, adapter (Runway,
  Gemini, OpenAI) or routing change.

##### 4C.8 Shot Prep and the workspace UI

- **Shot Prep, § Location / set:** "Open in 3D Set" becomes **Open Spatial Workspace** (the Shot route); the Location
  page stays reachable from the Location list.
- **Production Frame section:** each Master Frame row shows thumbnail, captured time, four axis badges
  (fresh / STALE / UNKNOWN), **Use as Production Frame** (the same `promoteMasterFrame`, with the confirmation flow) and
  **Open Spatial Workspace**. No canvas in Shot Prep. Statuses are computed server-side by the page (same function as
  promotion).
- **Workspace Master Frame list:** the same badges and the same **Use as Production Frame** next to "Use as Master Frame".
- **After promotion:** the selected Production Frame shows its lineage: "from 3D Master Frame captured <time>" and the
  four source fingerprints (short), or the deleted-source line above. It records no promotion-time freshness and never
  claims the current setup still matches; a separate "compare with current" line (computed now, server-side) may say so.
- The user is never asked which table something lives in; ownership is shown only in the shared-set warning.

##### 4C.9 Proposed migration 0049 (not created)

```sql
-- 0049_spatial_camera_and_frame_source.sql (proposal; forward-only from 0048)
alter table scene_master_frames
  add column camera_fingerprint text,
  add column camera_json jsonb,
  add constraint scene_master_frames_camera_check check (
    (camera_fingerprint is null and camera_json is null)
    or coalesce(char_length(camera_fingerprint) = 64
       and camera_json ->> 'schema' = 'prism.render-camera.v1'
       and camera_json ->> 'cameraFingerprint' = camera_fingerprint
       and jsonb_typeof(camera_json -> 'camera') = 'object', false));
-- no trigger change: 0048's deny-by-default guard already freezes the new columns

alter table shot_production_frames
  add column source_scene_fingerprint    text,
  add column source_camera_fingerprint   text,
  add column source_blocking_fingerprint text,
  add column source_lighting_fingerprint text,
  add constraint shot_production_frames_spatial_source_check check (
    (source_scene_fingerprint is null and source_camera_fingerprint is null and source_blocking_fingerprint is null
       and source_lighting_fingerprint is null)
    or (source = 'previs_master' and char_length(source_scene_fingerprint) = 64
       and (source_camera_fingerprint is null or char_length(source_camera_fingerprint) = 64)
       and (source_blocking_fingerprint is null or char_length(source_blocking_fingerprint) = 64)
       and (source_lighting_fingerprint is null or char_length(source_lighting_fingerprint) = 64)));

-- exact source: the frozen values must be that very Master Frame's own (SECURITY INVOKER; RLS lets the owner read it)
create or replace function check_shot_production_frame_spatial_source() returns trigger
language plpgsql as $$
declare mf scene_master_frames%rowtype;
begin
  if new.source_scene_fingerprint is null then return new; end if;
  select * into mf from scene_master_frames
   where id = new.source_master_frame_id and shot_id = new.shot_id and project_id = new.project_id;
  if not found or mf.asset_id <> new.asset_id
     or mf.scene_fingerprint <> new.source_scene_fingerprint
     or mf.camera_fingerprint is distinct from new.source_camera_fingerprint
     or mf.blocking_fingerprint is distinct from new.source_blocking_fingerprint
     or mf.lighting_fingerprint is distinct from new.source_lighting_fingerprint then
    raise exception 'Production Frame spatial source must be its Master Frame''s own provenance';
  end if;
  return new;
end;
$$;
create trigger shot_production_frames_spatial_source_check before insert on shot_production_frames
  for each row execute function check_shot_production_frame_spatial_source();
```

- No new FK on `source_master_frame_id`; no stale / unknown arrays. No backfill, no UPDATE / DELETE / INSERT of rows, no destructive DDL, no grant or revoke (the two tables keep their
  current privileges; #47 stays separate), no SECURITY DEFINER, no new table.
- **Migration ahead of code (mandatory):** current `main` inserts name their columns (F11), so with 0049 applied, `main`
  writes null/null camera and null source provenance, which both checks accept, and its reads ignore the new columns.
  The 4C code must also run against 0048 until 0049 is applied: it probes the columns once per request the way 4B probed
  `shot_light_rigs` (`to_regclass` / `information_schema`) and omits them when absent.
- The DB cannot require new code to fill the source columns (that would break `main`); the application requires it and
  tests prove it.

##### 4C.10 Memory / Postgres parity

Both previs repositories store and return `cameraFingerprint` / `camera`; both Production Frame repositories store the
four source fingerprints and run the same exact-source check (`assertExactSpatialSource` in the domain, called by the memory
repository; the trigger in Postgres). `masterFrameSpatialStatus`, `promotionStateDigest`, the confirmation flow and the
package `sourceSpatial` are domain functions shared by both modes; memory mode does not skip any check.

##### 4C.11 Tests

- **Domain:**
  - Camera fingerprint: same value gives the same fingerprint; position, rotation and focal length each change it; −0
    and quaternion sign normalise; navigation-only fields are absent.
  - `masterFrameSpatialStatus`: fresh, each axis stale, camera unknown, unknown not counted as fresh, no current
    bookmark gives stale camera, and a different scene document gives stale scene.
  - Digest: deterministic, and it changes with each input.
  - Exact-source extraction: takes the source frame, never the newest or adopted one.
  - Package: `sourceSpatial` is omitted for old frames, and `productionFrameLightingFingerprint` is unchanged when the
    Master Frame exists.
- **Real PostgreSQL** (`db:lighting`-style script `db:spatial-source`):
  - Camera pair: null/null accepted; a valid pair accepted.
  - Camera pair refusals: fingerprint without JSON, JSON without fingerprint, wrong schema, mismatched fingerprint, and
    short fingerprint.
  - A post-insert camera change is refused by the 0048 guard.
  - Production Frame source: null accepted for non-spatial and old rows; `previs_master` with exact values accepted;
    each mismatched value refused; another Shot's Master Frame refused; another Asset refused; source columns on a
    non-`previs_master` frame refused.
  - Any UPDATE is refused, and the Shot cascade still deletes.
  - Migration: 0048 checksum unchanged; 0049 applies once; no row changed (digest before and after); a `main`-shaped
    insert still works.
  - Worker roles and `anon` are not broadened (privilege diff).
- **Browser (memory, no provider):**
  - **Story:** Shot → Open Spatial Workspace → existing set → link camera → blocking → lighting → capture → all fresh →
    move the camera and re-link → STALE CAMERA → **Use as Production Frame** asks for confirmation → confirm → the
    frame is selected, its source fingerprints equal the Master Frame's, and the package is valid with
    `references.productionFrame.sourceSpatial`.
  - **TOCTOU (release-blocking):** get the confirmation → change the blocking → submit the old digest → the server
    returns a new confirmation and creates no frame.
  - **Exact source:** Master Frames A and B with different fingerprints, B newest → promote A → the frame and package
    source are A, never B.
  - **Shared Location A/B:**
    - each Shot keeps independent camera, blocking and lighting across route changes;
    - a Set geometry edit from A shows the warning and changes the scene fingerprint for both;
    - a lighting edit shows no warning.
  - **Capture camera claim:** a forged `cameraFingerprint` is refused, and the Location route's Shot switch reloads
    the right bookmark (F3 / F4 regression).
  - **No spatial:** a Shot with no Location, scene, camera, blocking or lighting reaches a Production Frame, a package
    and the image-first path, with no new required key.
  - Location without a scene → **Create 3D Set** creates the Location's own scene document.
  - **Production Frame reuse:** promote A while fresh → make the current state stale → promote A again with
    confirmation → the existing row is reused, nothing claims the latest promotion was fresh, the source fingerprints
    are still A's, and the current server status reports the difference. The reverse too: first promotion stale and
    confirmed, later the current state matches again; the lineage is unchanged and carries no stale metadata.
  - **Source deletion:** a 4C Production Frame from Master Frame A → delete A → the frame, its four fingerprints,
    package `sourceSpatial` and the frozen `productionFrameLightingFingerprint` all remain, and the UI says the source
    no longer exists.
  - **Wrong camera (P5, release-blocking, implemented first):** Shot A and Shot B on one Set with different bookmarks;
    an A-camera render submitted as B is refused, and no Master Frame row and no Asset reference survives (the stored
    object is removed).
  - **Dropdown navigation (P6):** on the Location route, switching A → B navigates and remounts; B's bookmark, path,
    blocking, lighting and Master Frames load, and none of A's survive.
- Existing 4B tests stay green unchanged.

##### 4C.12 Hosted acceptance (4C-B, later, not executed now)

0049 `--dry-run` → exact checksum → apply → `db:validate`, `db:behavior`, `db:rls`, `db:spatial-source`, `db:lighting`,
`db:previs`, worker-role checks with real logins; current-`main` compatibility on hosted (its suites, a `main`-shaped
insert); real owner and real non-owner (Admin-API ephemeral user, as 4B-B); the Shot-centric browser story run locally
against hosted; temporary fixtures removed; no deployment; no provider call.

##### 4C.13 Accepted owner decisions

- **P1 Route — accepted.** `/projects/[project]/episodes/[ep]/shots/[shotId]/spatial` owns the Shot identity; no Shot
  switcher inside it. The Location 3D page keeps its selector, but selecting another Shot is navigation with a
  Shot-keyed remount that reloads bookmark, path, blocking, lighting and Master Frames.
- **P2 Production Frame source storage — accepted with one change:** dedicated source fingerprint columns accepted;
  promotion-time stale / unknown arrays rejected from Production Frame persistence. Exactly four nullable columns
  (`source_scene_fingerprint` as the marker); the SECURITY INVOKER `BEFORE INSERT` exact-source trigger verifies only
  intrinsic source provenance; no FK on `source_master_frame_id`.
- **P3 Lighting lineage — accepted.** Frozen `source_lighting_fingerprint`, else the 4B chain, else null.
- **P4 Unknown camera — accepted.** Three states (fresh / stale / unknown); unknown is neither; stale or unknown needs
  explicit confirmation; never a hard prohibition.
- **P5 Capture camera correctness — accepted, the first release-blocking 4C item.** The server reloads the Shot's
  bookmark, derives the `prism.render-camera.v1` snapshot and fingerprint, refuses a mismatched client claim, and stores
  only the server-derived snapshot.
- **P6 Location-page Shot leak — accepted.** The selector becomes navigation; regression required.

##### 4C.14 Non-goals

A second scene system or engine; Shot-owned set storage; replacing the Location route; mandatory 3D at any step;
automatic recapture, regeneration or approval; relighting or re-framing an existing Production Frame; templates and
copies (4D); splat changes (4E); NLE, mixer, grading, EDL (Phase 5); autonomous camera / lighting choice, routing or
agents (Phase 6); any provider call (Runway / Gemini / OpenAI / reconstruction = 0; paid = 0).

### 4D — Reusable setups

- **Goal:** apply a camera, lighting or blocking setup to several Shots explicitly.
- **Domain:** template schema; copy-by-value apply; provenance.
- **Persistence:** one additive templates table and `applied_from_*` columns.
- **UI:** save as template, apply, and a visible "copied from" note.
- **Package:** none. The Shot's own rows are what freeze.
- **Tests:** editing or deleting a template changes no Shot, render or package.
- **Hosted acceptance:** migration gate.
- **Non-goals:** live-linked templates; automatic application; a global marketplace.

### 4E — Splat control-pass refusal and environment limits

- **Goal:** keep the truthful refusal, and write down why it exists.
- **Domain, persistence, package:** none.
- **Docs:** why exact mesh depth, object-id and Character-mask semantics do not automatically apply to splats; any
  renderer-light interaction 4B discovered.
- **UI:** clearer messaging about what splats support.
- **Tests:** regression tests of the refusal in panel, client and server paths.
- **Hosted acceptance:** none.
- **Non-goals:** a real-GPU spike, unless a concrete production requirement appears before 4E; approximate passes; real COLMAP
  or Brush acceptance (M2D.3D2); new reconstruction providers.

### 4F — Production acceptance and roadmap close

- **Goal:** prove the optional spatial path end to end on hosted, and prove the image-first path still works.
- **Domain, persistence, package:** none expected. The doc-drift corrections from §9 land here.
- **Provider calls:** one bounded paid image-to-video smoke is accepted in principle ([D5](#d5--paid-video-proof-accepted-in-principle)),
  but **only after its own explicit owner gate**. Nothing is authorized yet.
- **Non-goals:** Phase 5 or 6 scope.

## 11. Non-goals

**Kept in Phase 5:** NLE timeline work, transitions and effects, colour grading, captions, music editor, EDL/XML export.

**Kept in Phase 6:** agents, automatic routing, automatic regeneration, AI-directed camera or lighting.

**Also out:** replacing the engine; adopting React Three Fiber; physically based rendering claims; making reconstruction
required; reading or writing `locations.set3d`; any change to Sequence Automatic.

## 12. Accepted owner decisions

Accepted by the owner on 2026-11-01. These bind 4B–4F, and where earlier wording seems to differ, this section wins.

### D1 — Shadows: v1 ships without them

`prism.shot-lighting.v1` has no authored shadows. Schema and domain validation refuse `castShadow: true`, and UI and docs say
plainly that v1 does not simulate authored shadows. 4B does not enable Three.js shadow maps. A later shadow version needs
deterministic acceptance across render size and runtime, and must enter the lighting fingerprint.

### D2 — Base replace is required in v1

`base.mode` is `engine_default` or `replace`. `replace`:

- suppresses the engine-created base hemisphere and base directional;
- suppresses engine and skybox-branch ambient contributions that are part of the base rig;
- preserves actual Location-scene authored light objects;
- preserves the skybox or environment visual itself, unless existing scene behaviour independently hides it.

The base is restored exactly when switching Shots, clearing a rig, unloading the editor, and when a render or capture exits
or fails. No Shot lighting may leak into another Shot.

### D3 — Provenance guards in 0048

0048 adds guards on `scene_master_frames` and `shot_previs_clips`. They are provenance guards, not blanket UPDATE denial.
**4B audits every existing update path before writing 0048.**

| Table                 | Permitted UPDATE                                                                                                      | Immutable after INSERT                                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scene_master_frames` | The explicit adoption path, `adopted_at` and `adopted_frame_id`, semantics unchanged; FK `camera_bookmark_id` to null | Project, Shot, Location, scene document, scene revision and fingerprint, captured Asset, render dimensions and aspect, blocking provenance, lighting provenance, capture timestamp and creator                                       |
| `shot_previs_clips`   | FK `camera_path_id` to null                                                                                           | Project, Shot, Location, path revision and fingerprint, scene revision and fingerprint, rendered Asset, frame rate, duration, dimensions, container, codec, audio and blocking and lighting provenance, render timestamp and creator |

Normal DELETE and FK cascade cleanup stay allowed. No SECURITY DEFINER functions. Every permitted and refused mutation is
tested against real PostgreSQL. Known update paths so far: `src/data/previs-postgres.ts` (adoption), and test scripts
`scripts/db-blocking.mts` and `scripts/db-previs.mts`, which issue UPDATEs to prove constraints refuse them and must be
re-checked once a guard can refuse first.

### D4 — Slice order

4B Shot Lighting, then 4C Shot-centric Spatial Workspace, then 4D reusable setups. Templates follow the usable Shot workflow.

### D5 — Paid video proof: accepted in principle

4F should include one tightly bounded paid image-to-video smoke from a Production Frame whose origin is a spatial Master Frame.
**This is not provider-call or spend authorization.** The real call needs its own explicit owner gate at 4F, stating the exact
model and provider, maximum calls, maximum USD, no retries unless separately authorized, and the expected artifact and
acceptance criteria.

### D6 — Splat control passes: the current refusal is accepted

Parity is not a Phase 4 core requirement. 4E preserves the truthful refusal, documents why exact mesh depth, object-id and
Character-mask semantics do not automatically apply to splats, regression-tests the refusal, and records any renderer-light
interaction 4B discovers. No real-GPU spike is required for Phase 4 completion unless a concrete production requirement appears
before 4E. Any future approximate splat pass uses a distinct schema and version and cannot claim to be the existing exact M2C
pass.

### D7 — `locations.set3d`: removal after Phase 4

Not during 4B–4F. Removal is its own forward-only cleanup migration and code PR. Immediately before it, re-audit every relevant
environment for `locations.set3d` and `set3d_model_asset_id`, and every code reader and writer. Remove only if historical and
runtime compatibility is proven.
