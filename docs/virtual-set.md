# 3D Set (Phase 2F, milestone 1)

A persistent virtual set per Location. Prism stores spatial truth explicitly, so a generation model is never asked
to remember what the set looks like.

```
Location → persistent 3D scene → character blocking → production camera
        → shot camera bookmark → master frame → GenerationPackage spatial snapshot
```

Nothing in M1 generates video, calls a provider or touches an ArtCraft service.

## Ownership

| Prism owns (source of truth)                                                                                      | The vendored engine owns (runtime only)                                                   |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Project, Episode, Script Scene, Shot, Location, Character, Look, Performance, Production Frame, GenerationPackage | Three.js scene graph, viewport, selection, gizmos, transforms, camera controls, rendering |
| `prism.previs.v1` document, scene fingerprint, camera bookmark, master-frame provenance                           | the engine's own scene JSON (opaque round-trip payload inside the document)               |

Code boundary: only `src/lib/previs/scene-adapter.ts` imports engine internals (plus two vendored hooks the editor
component uses). Everything else depends on the `SpatialSceneAdapter` interface.

## Document (`prism.previs.v1`)

```
{ schema, engine: "artcraft-derived", upstreamCommit, productionFrame: {ratio:"2.39:1", width:1912, height:800},
  objects[]: {id, kind: primitive|mannequin|glb|light, shape, name, assetId, assetChecksum, characterId,
              position, rotation(Euler XYZ rad), scale, color, visible, locked},
  productionCamera: {id, label, position, rotation, focalLengthMm} | null,
  assetBindings: { <assetId>: {checksum} },
  scene: <engine JSON, no URLs>,
  editor: { navigationCamera } }          // excluded from the fingerprint
```

Never persisted: signed URLs, blob/data URLs, ArtCraft account/CDN ids, tokens, selection/hover/panel state.
`buildPrevisDocument` throws if the engine payload contains anything URL- or credential-shaped.
GLBs are referenced by Prism **Asset id** (`m_<assetId>` engine token). At load the adapter resolves the id to
`/api/assets/<id>` (authorised per request; Supabase mode redirects to a short-lived signed URL) and never stores it.

## Fingerprint

`sceneFingerprint(doc)` = SHA-256 of the production-relevant spatial snapshot: objects (id, kind, shape, name, asset
id + checksum, character, position/rotation/scale rounded to 1e-5, colour, visibility) sorted by id, the production
camera (pose + focal length) and the production frame. It does **not** include selection, hover, inspector tab,
panel width, the editor navigation camera, lock state or object order. Pinned by tests in
`src/domain/previs/__tests__/previs-document.test.ts`.

## Cameras

- **Editor/navigation camera**: how you fly around (the engine's viewport camera). Saved only under `editor`.
- **Production camera**: the engine's `::CAM::` proxy; this is the Shot's camera.
- **Shot camera bookmark** (`shot_camera_bookmarks`, one per shot): position, rotation, target, perspective, vertical
  FOV, focal length (+ `focalLengthBasis: "vertical-sensor-24mm"`, the engine's lens convention — not a claim about a
  real sensor), production aspect, and the scene revision + fingerprint it was authored against.
  "The set changed since this camera was linked" is shown whenever the live fingerprint differs.

## Master frame

Rendered locally in the browser, 1912×800, through a **dedicated production render camera**: a fresh perspective camera
built from the shot's frozen bookmark (pose, Euler rotation, focal length on the `vertical-sensor-24mm` basis,
2.39:1 aspect; see `productionRenderSpec`) and handed to the engine's `snapShotOfCurrentFrame(false, camera)`. The
editor/navigation camera, the look-through toggle and the viewport lens are neither read nor changed, so the frame is the
same wherever the operator has navigated.
The server validates PNG magic bytes and exact dimensions, re-derives revision/fingerprint from the saved scene,
stores the file in the private bucket (`purpose=storyboard`, `source=3d_render`) and writes provenance both to
`scene_master_frames` and the asset's `metadata.previs`. **Capturing never changes the approved storyboard.**
"Use as Master Frame" creates a _new unapproved_ storyboard frame version (`source=3d_preview`) and records the
adoption; approval stays a separate, existing action.

## GenerationPackage

`spatialReference` is optional and absent (key omitted, not null) when a Shot has no set, so those packages and their
fingerprints are unchanged. When present it freezes: location, live scene revision + fingerprint, the camera bookmark
(with the revision/fingerprint it was authored against), the adopted master-frame asset id (also described by value in
`assets`), and character blocking. It is not part of the 13 shot freshness parts, so enabling a set never stales an
existing storyboard approval. Attempts store the package as a JSON snapshot, so later set edits cannot alter it.

## Persistence & security

Migration `0030`: `location_scene_documents` (one per Location, compare-and-set `revision`),
`shot_camera_bookmarks`, `scene_master_frames`. Composite FKs `(id, project_id)` make cross-project references
impossible; owner-only RLS; no worker role has any grant. Verified by `npm run db:previs` (33 checks).

## Tests

| Layer                                                 | File                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| schema, URL refusal, fingerprint, camera maths        | `src/domain/previs/__tests__/previs-document.test.ts`                                                      |
| package snapshot, optionality, immutability, adoption | `src/domain/previs/__tests__/spatial-package.test.ts`                                                      |
| engine boundary, asset-id resolution                  | `src/lib/previs/__tests__/scene-adapter.test.ts`, `shapes.test.ts`                                         |
| Postgres, RLS, isolation, guards, cleanup             | `scripts/db-previs.mts` (`npm run db:previs`)                                                              |
| UI end to end + WebGL release (memory)                | `e2e/zzzzz-previs.spec.ts`                                                                                 |
| gizmo drags, production-camera capture, same-origin   | `e2e/zzzzzz-previs-controls.spec.ts`                                                                       |
| production render camera selection                    | `src/lib/previs/__tests__/capture-camera.test.ts`, `src/domain/previs/__tests__/production-render.test.ts` |
| UI end to end on Supabase + private storage           | `e2e/supabase-previs.spec.ts`                                                                              |

Playwright runs Chromium with the software rasteriser (`--use-angle=swiftshader`); GPU is not required.

## Known gaps (M1)

- No "New 3D set" template picker beyond "Load Hotel Canopy Test Set"; a fresh set starts empty with CAM-A at 35 mm.
- Undo/redo covers object add/delete/transform/colour/lock/visibility; production-camera edits made through the
  inspector are not on the undo stack.
- Lights other than the engine's default rig are not offered; the vendored point-light shape exists but has no button.
- The outliner has no rename, reorder or grouping; the engine has no hierarchy UI.
- GLBs must be single-file (`.glb`, no Draco/KTX2/Meshopt, no external resources) and are added through the normal
  Assets upload with any purpose.
- Master-frame capture needs the set to be saved and the shot's camera linked first (the server enforces both).

## M2 reuse (investigated, not built)

| Capability                      | Upstream basis                                                                                                                                            | What Prism must add                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Camera timeline / path          | **Built in M2A** as a Prism-owned `prism.camera-path.v1` evaluator (see "Camera motion and local previs"); the engine timeline is not used for the camera | M2B may use the engine timeline for object animation                                                                          |
| **Focal-length keyframing**     | **Done in M2A** in the Prism evaluator (not by patching the engine timeline)                                                                              | —                                                                                                                             |
| Quaternion/slerp rotation       | **Done in M2A** (`slerpQuaternion`, shortest arc)                                                                                                         | —                                                                                                                             |
| Character posing                | `KinHelpers/{FKHelper,BoneJSONHelper}`, `SkeletonHelperController`                                                                                        | a Prism mannequin with `mixamorig:*`-compatible bones (rig is name-matched); pose presets as JSON                             |
| Pose presets                    | `BoneJSONHelper.toJSON/poseFromBoneJSON`                                                                                                                  | Prism-authored preset library                                                                                                 |
| Local previs video              | **Done in M2A** with MediaBunny (WebCodecs)                                                                                                               | audio muxing                                                                                                                  |
| Depth pass                      | none vendored (`CustomOutlinePass`/`FindSurfaces` were removed: provenance not established)                                                               | write a Prism depth override material (three.js `MeshDepthMaterial`); PNG sequence                                            |
| Object-id / character masks     | surface-id material exists; per-object id pass does not                                                                                                   | new override material mapping `uuid → colour`; ties to mannequin `characterId`                                                |
| Gaussian splats                 | removed in the pre-PR hardening (the engine's loader and the `@sparkjsdev/spark` dependency)                                                              | re-add `@sparkjsdev/spark` and the upstream loader behind a feature flag; asset pipeline for `.spz`; licence of splat sources |
| Image-to-location / image-to-3D | none locally (ArtCraft calls its own backend)                                                                                                             | a Prism provider adapter behind the existing generation spend gates                                                           |

M2 recommendation order: ~~focal-length keyframes + slerp → camera path UI → local previs video~~ (M2A, done) → mannequin
rig/poses (M2B) → depth/object-id passes (M2C) → splats and image-to-location (M2D).

## Camera motion and local previs (Phase 2F M2A)

```
Shot → camera path (keyframes: pose + lens) → deterministic playback → local previs render
     → private previs Asset → frozen `cameraMotion` in the GenerationPackage
```

**EDITOR CAMERA ≠ PRODUCTION CAMERA ≠ CAMERA PATH.** The editor/navigation camera is how you fly around; the production
camera is the Shot's camera at an instant; the camera path is the production camera over time. Playback, scrubbing
and rendering write only the production camera. The navigation camera is moved only by the operator (and follows the
path only while "Look through production camera" is on). Nothing is ever screen-recorded.

### `prism.camera-path.v1`

```
{ schema, durationMs, frameRate, interpolation: "linear" | "smooth",
  keyframes[]: { id, timeMs, position{x,y,z}, orientation{quaternion{x,y,z,w}},
                 focalLengthMm, focalLengthBasis: "vertical-sensor-24mm",
                 easing: linear | ease_in | ease_out | ease_in_out | hold } }
```

- Orientation is a unit quaternion; Euler angles are an editor-facing view (`quaternionToEuler`). Interpolation is
  shortest-arc, normalised slerp (three.js `Quaternion.slerp` after a sign flip when the dot product is negative), so
  350° → 10° travels 20°, and `q` / `−q` are one rotation.
- Position: `linear` (piecewise) or `smooth` (three.js `CatmullRomCurve3`, passes through every keyframe).
- Lens: **focal length** is interpolated (mm) and FOV is derived with the M1 basis
  (`2·atan(12 / f)`). Averaging FOV would give a different (wrong) lens.
- Easing belongs to the segment that **starts** at the keyframe and shapes its progress for position, orientation and
  lens alike. `hold` keeps the previous keyframe until the next one.
- Keyframes sort by time, ids are stable, two keyframes may not share a time, and none may be after the duration.
- One evaluator: `evaluateCameraPath(path, timeMs)` in `src/domain/previs/camera-path.ts`. Timeline scrubbing,
  interactive playback and the previs renderer all call it (the renderer additionally samples frame `n` at
  `n / frameRate`).
- Fingerprint: `cameraPathFingerprint` (SHA-256 over schema, duration, frame rate, interpolation and the
  sign-normalised, 1e-5-rounded keyframes). Playhead, selection, zoom, overlay and the editor camera are not in a path
  and cannot affect it.

The ArtCraft `TimelineController` is **not** used for camera motion. Its tracks key object transforms with Euler
lerp and have no lens channel; adding one would put a second interpolation implementation next to Prism's evaluator,
which the single-evaluator rule forbids. The engine still _executes_ the motion: each evaluated state is written to the
engine's `::CAM::` object and lens (`ArtCraftSceneAdapter.applyCameraState`), so gizmos, camera view, frame overlay and
snapshots behave as in M1. The engine timeline stays available for M2B object animation.

### Timing authority

`Shot duration` is `computeShotDuration` (selected performance takes + pre/post-roll + gaps, else the manual target)
and the frame rate is the Shot's own `generation.fps`. A new path takes both. When the Shot has no duration yet the
panel says so and uses an explicit 4 s starting value (never silently). If the path's duration is changed it is shown
as "not the Shot's duration".

### Persistence (migration 0031)

`shot_camera_paths` (one current editable path per Shot, compare-and-set `revision`, the set revision + fingerprint it
was authored against, the path JSON and its fingerprint) and `shot_previs_clips` (every rendered previs, newest first,
with path revision/fingerprint, scene revision/fingerprint, asset id, fps, duration, dimensions, container, codec).
Owner-only RLS; composite `(id, project_id)` FKs; no worker grant. `assets.source` gains `local_previs`.

**Staleness is computed, never destructive.** A path is stale when the live set fingerprint differs from the one it was
saved against; a previs is stale when its path fingerprint or set fingerprint differs from the current ones. Stale
paths and clips stay readable; "Re-save against the current set" re-anchors a path without changing its keyframes.

### Authoring and playback in the editor

Create path → (scrub, move the production camera, **Add keyframe at playhead**) → Save. Camera edits that are not yet
keyed are tracked: scrubbing/playing will not silently overwrite them ("unkeyed edit"). Playing never makes the scene
"dirty": the adapter remembers the authored camera and serialises that, not the playback pose.
The path line, keyframe markers (start green, end red, selected white) and the current position are drawn on the
editor-only layer 1; the production render camera disables layer 1, so they are absent from master frames and previs
(asserted by an e2e that compares captures with the overlay on and off).

### Local previs

`renderPrevis` samples the path, asks the adapter to render each frame through an **isolated** `PerspectiveCamera`
(`renderPrevisFrame` → `Editor.snapShotOfCurrentFrame(false, camera, size)`) and hands frames to a `FrameEncoder`.
Default size is **956 × 400** (2.39:1 at half the 1912 × 800 Production Frame); the dimensions are recorded in
provenance. Stages are separate so tests never encode video: frame sampling and camera evaluation are pure, the
renderer and encoder are interfaces with fakes in unit tests, persistence is a server action.

Encoding uses **MediaBunny 1.60.0** (MPL-2.0, npm dependency, not vendored, lazily imported on first render) over
WebCodecs. Support is detected, not assumed: MP4/H.264 first, then WebM VP9, then WebM VP8; the container and codec
that were really used are stored. A browser with none gets a clear "cannot encode" message and nothing is uploaded.
Cancel stops the loop, cancels the muxer and frees the private canvas; unmount aborts a running render.

The server (`recordPrevisClip`) re-derives what it can: the saved path must be the revision that was rendered, must be
current for the saved set, the file must sniff as the claimed container, and the aspect must be 2.39:1. The video is a
private asset (`type video`, `purpose video_reference`, `source local_previs`, `metadata.previs` provenance). No URL is
stored; players use `/api/assets/<id>` (authorised per request, Range supported).

**Audio.** Previs files are silent (nothing is synthesised and no provider is called). The Shot's selected performance
takes are scheduled against the playhead during _interactive_ playback (`audioCues`: pre-roll, take durations and
gaps). Muxing that audio into the encoded file is the next narrow increment (MediaBunny `AudioBufferSource`).

### GenerationPackage

`spatialReference.cameraMotion` (optional; the key is absent without a saved path, so M1 packages and non-3D packages
keep their exact fingerprints) freezes, by value: path id/revision/fingerprint, the set revision/fingerprint it was
authored against, duration, frame rate, interpolation, lens basis, every keyframe, and `previsAssetId` — the latest
previs rendered from exactly this path (null when none). Camera motion is **not** translated into provider prompts.

### Tests

| Layer                                                                        | File                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------- |
| evaluator, slerp, easing, fingerprint, sampling                              | `src/domain/previs/__tests__/camera-path.test.ts`           |
| renderer pipeline, cancel/cleanup, overlay layers                            | `src/lib/previs/__tests__/previs-render.test.ts`            |
| package freeze, immutability, staleness, memory-store rules                  | `src/domain/previs/__tests__/camera-motion-package.test.ts` |
| Postgres, RLS, isolation, guards (0031)                                      | `scripts/db-previs.mts`                                     |
| authoring, persistence, playback, overlay, real local encode, stale, package | `e2e/zzzzzzz-camera-previs.spec.ts`                         |
