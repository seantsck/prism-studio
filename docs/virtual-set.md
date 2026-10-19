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
| Local previs video              | **Done in M2A**, with the selected performance audio muxed in **M2A.1** (MediaBunny + WebCodecs)                                                          | —                                                                                                                             |
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

**Staleness is computed, never destructive, and judged by what a clip contains.** A path is stale when the live set
fingerprint differs from the one it was saved against. A previs is stale when its scene or camera-path fingerprint
differs from the current ones; a previs **rendered with audio** is also stale when the Shot's performance-audio mix
fingerprint differs ("STALE SCENE", "STALE CAMERA", "STALE AUDIO", combined when several apply). A **silent** previs
depends on scene + camera only, so changing dialogue never invalidates a camera test. Stale paths and clips stay
readable and historical clips are never rewritten; "Re-save against the current set" re-anchors a path without
changing its keyframes.

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

### Performance audio (M2A.1)

| Surface                                | Audio                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| Interactive playback (camera timeline) | camera + the Shot's selected performance takes                                                |
| Rendered previs file                   | the same takes muxed in when "Include selected performance audio" is on; otherwise **silent** |

**One Shot timeline, one arithmetic.** Camera motion, interactive audio, the rendered video frames and the muxed audio
all share the Shot timebase (milliseconds from the start of the Shot):

```
Shot timing model  (layoutPerformance in src/domain/duration.ts: pre-roll → take → gap → take …, + post-roll)
  ├─ computeShotDuration           the Shot's duration
  └─ layoutTimelineCues            every selected take on the timeline (takes without audio keep their time)
       ├─ interactive scheduler    cues with audio, untrimmed          (src/lib/previs/performance-audio.ts)
       └─ PerformanceAudioPlan     cues with audio, trimmed to the render (src/domain/previs/audio-mix.ts)
            └─ offline mix → MediaBunny mux
```

There is no second timer and no second cue arithmetic; tests assert that the interactive cues, the offline plan and
`computeShotDuration` agree for every seeded Shot. The video duration stays the camera path's duration; the mix is
exactly that long (a take running past the end is trimmed, a take starting after it is dropped).

_Interactive playback._ The camera timeline playhead is the only clock. The scheduler owns no timer that advances time,
only one-shot starts armed relative to the playhead at play/seek, cancelled on every pause, seek, end and unmount.
Seeking into a take starts it at the right source offset; seeking into a gap plays nothing until the next take; resume
starts from the playhead; every start first stops everything so scrubbing never overlaps nodes.

_Audio plan._ `prism.previs-audio-mix.v1`: `{ sampleRate: 48000, channels: 2, durationMs, shotDurationMs, cues[] }`, each
cue `{ assetId, assetChecksum, timelineStartMs, sourceStartMs, durationMs }` (`sourceStartMs` is 0 today; trimming is
representable). No audio asset → the take occupies time and produces silence. The **audio mix fingerprint** (SHA-256) covers
the format, the render and Shot durations and every cue in order (asset, checksum, offsets, length), so it changes when a
selected take, its bytes, its duration, the pre-roll, a gap, the post-roll, the cue order or a source offset changes, and
never for the playhead, UI state, selection or object URLs.

_Local composition (nothing leaves the browser)._ Each cue's take audio is fetched as **bytes through the authenticated
asset route** (`/api/assets/<id>`; no public, signed or blob URL is kept), verified against the asset checksum, decoded by
the browser (`decodeAudioData` on a never-started `OfflineAudioContext` at 48 kHz, which also resamples), and placed
sample-exactly on a silent 48 kHz stereo track: mono is duplicated to L/R, stereo keeps L/R (a source with more channels
contributes its first two), a source longer than its cue is trimmed, a shorter one leaves silence (never stretched). No
gain, normalisation, EQ, compression or noise reduction. A take that cannot be read or decoded stops the render with an
error naming the asset; dialogue is never silently dropped. Placement is a pure function (`mixPlanToPcm`) rather than
`OfflineAudioContext` scheduling so it is exact and unit-testable without a browser; the browser is used only to decode.

_Muxing._ MediaBunny's `AudioSampleSource` encodes the PCM in the same `Output` as the video, fed alongside the frames so the
muxer can interleave. The audio/video pair must be encodable **together** and fit the container: MP4 carries H.264 + AAC,
WebM carries VP9/VP8 + Opus. Support is detected (`canEncodeVideo` + `canEncodeAudio`), never assumed. If video can be
encoded but no compatible audio pair exists, the previs is rendered **silent** and the status says so; a file is never
described as having audio unless the muxed file really has an audio track (the server also checks for an audio track
marker in the stored container). Progress phases: `preparing_audio` (fetch, decode, compose), `rendering` (frames, with the
audio encoding alongside), `finalizing`. Cancel works in every phase: fetches are aborted, no decode continues, the encoder
and its audio feed are cancelled and the canvas and decoded buffers are released.

_UI._ "Include selected performance audio" is on by default when the Shot has selected performance audio, disabled with
"No selected performance audio for this Shot." otherwise. Before rendering the panel shows `Video: 956×400 · 24 fps` and
`Audio: Selected performance · 48 kHz stereo` or `Audio: Silent`. There is no mixer (no gain, pan or effects).

_Provenance._ `shot_previs_clips` (migration 0032) gains `audio_mix_json` (the plan above plus codec and
`mixFingerprint`: asset ids, checksums and offsets only, never a URL) and `audio_mix_fingerprint`. `has_audio` means "a mix is
recorded"; the legacy single `audio_asset_id` stays null because a mix of several takes is not one source asset. The previs
video Asset's `metadata.previs` records `hasAudio` and `audio: { codec, sampleRate, channels, mixFingerprint, cueCount }`.
The server derives the expected mix itself from the Shot's current selected takes and rejects a render whose claimed mix
fingerprint differs (the takes changed while it rendered).

### GenerationPackage

`spatialReference.cameraMotion` (optional; the key is absent without a saved path, so M1 packages and non-3D packages
keep their exact fingerprints) freezes, by value: path id/revision/fingerprint, the set revision/fingerprint it was
authored against, duration, frame rate, interpolation, lens basis, every keyframe, and `previsAssetId` — the latest
previs that is exactly current for this path (null when none): a silent previs stays current when only the dialogue
changed, while a previs rendered with audio counts only while its audio mix is current. The optional
`cameraMotion.previs { assetId, hasAudio, audioMixFingerprint }` says whether that previs contains performance audio and
which mix (additive and present only with a previs, so earlier packages are unchanged). No audio bytes enter the package
and a previs file is not needed to compile it. Camera motion is **not** translated into provider prompts.

### Tests

| Layer                                                                         | File                                                        |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| evaluator, slerp, easing, fingerprint, sampling                               | `src/domain/previs/__tests__/camera-path.test.ts`           |
| renderer pipeline, cancel/cleanup, overlay layers                             | `src/lib/previs/__tests__/previs-render.test.ts`            |
| package freeze, immutability, staleness, memory-store rules                   | `src/domain/previs/__tests__/camera-motion-package.test.ts` |
| shared timeline, audio plan, mix fingerprint, staleness rules (M2A.1)         | `src/domain/previs/__tests__/audio-mix.test.ts`             |
| decode/compose: placement, mono/stereo, trim, cancel, errors (M2A.1)          | `src/lib/previs/__tests__/audio-compose.test.ts`            |
| interactive scheduler: seek, pause, resume, end, cleanup                      | `src/lib/previs/__tests__/performance-audio.test.ts`        |
| Postgres, RLS, isolation, guards, audio-mix provenance (0031, 0032)           | `scripts/db-previs.mts`                                     |
| authoring, persistence, playback, overlay, real local encode, stale, package  | `e2e/zzzzzzz-camera-previs.spec.ts`                         |
| real audio mux (tracks, timing, stale audio vs silent), gap, fallback (M2A.1) | `e2e/zzzzzzzz-previs-audio.spec.ts`                         |

## Character blocking (Phase 2F M2B)

A Shot knows **where each Character stands and how their body is posed**. This is a layer of the _Shot_, never of the
Location's persistent set.

```
Character → neutral rigged proxy → Shot blocking (root + FK pose) → production camera → master frame / local previs
                                                   └→ frozen GenerationPackage `spatialReference.shotBlocking`
```

**CHARACTER IDENTITY ≠ MANNEQUIN APPEARANCE.** The proxy carries position, facing, height, pose and nothing else. Face,
hair, wardrobe, skin tone and likeness stay in the Character's Prism references (Look, identity refs).

### Ownership: Set vs Shot

|                     | Owns                                                                       | Stored                                                                      |
| ------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Location's Set**  | architecture, props, environment, fixed set state                          | `location_scene_documents` (`prism.previs.v1`)                              |
| **Shot's blocking** | which Characters are present, root placement, root facing, height, FK pose | `shot_character_blocking` (`prism.shot-blocking.v1`), one row per Shot+Char |

Shots 3A, 3B and 5A can use the same Set with different blocking; editing one never touches another (proved in
`scripts/db-blocking.mts` and `e2e/zzzzzzzzz-character-blocking.spec.ts`). The proxies are a **runtime overlay** in the
engine's THREE scene: they carry no `media_id`, so the engine's scene save never serialises them, they are not in the
outliner, and adding one does not make the Set "dirty". Switching Shot swaps the overlay without reloading the Set. With
no Shot selected, only the base Set shows.

M1's scene-level `Mannequin` objects stay readable and untouched (they appear in the package's legacy
`characterBlocking` list). They are treated as generic Set figures; there is no automatic conversion. (An explicit "Use
as Shot Blocking" copy action was not built; see Known gaps.)

### Rig: `prism.humanoid-rig.v1`

Prism's own semantic model (`src/domain/previs/rig.ts`): `root, hips, spine, chest, neck, head`, and per side
`Shoulder, UpperArm, LowerArm, Hand` and `UpperLeg, LowerLeg, Foot` (20 joints; toes were left out). Y up, the figure
faces +Z at yaw 0, so its left is +X. Offsets are metres for a 1.70 m reference figure; blocking scales the whole figure
uniformly (no per-limb stretching).

The **runtime** (`src/lib/previs/humanoid-rig.ts`) is a procedural `THREE.Bone` hierarchy (one bone per joint except
`root`, which is the proxy group itself) with rigid primitives (boxes, cylinders, a sphere head with a nose wedge)
attached to the bones. No Mixamo, ArtCraft or other third-party mesh, texture or animation is used.

### Pose: `prism.pose.v1`

`{ schema, rig, joints: { <jointId>: {x,y,z,w} } }`. **Quaternions are authoritative** (Euler angles exist only in the
editor fields). Only joints that differ from neutral are stored, quaternion sign is canonical (`q` and `-q` are one
pose), values are rounded to 6 decimals, keys are in rig order. `poseFingerprint` changes with any joint rotation and
the rig version, and with nothing else.

### Root ≠ pose

Moving a figure three metres, turning its whole body, or changing its height is **root blocking**
(`position`, `orientation` quaternion, uniform `scale`; height = scale × 1.70 m; the UI exposes position XYZ, body yaw
and height in metres). Turning the head or bending an elbow is a **pose edit**. A pose preset never moves the root,
except one documented vertical difference: _Seated_ lowers the hips by 0.42 m (at reference height), applied as the
**difference from the preset the figure was previously in**, so stand → sit → stand returns to the same height.

Height defaults to 1.70 m and is labelled a proxy default. Characters have no recorded height in the data model, so no
height is invented for a real Character.

### Blocking fingerprint

`blockingFingerprint(entry, {locationId})` = character id, location, root position/orientation/scale, rig version, pose
fingerprint, visibility. It does **not** change with the selected bone, pose-panel state, gizmo mode, orbit camera,
timeline position, helper or skeleton visibility. `renderedBlockingFingerprint` is the identity of the Shot's _visible_
layer (null when no proxy is visible, which is also the identity of every pre-M2B render).

### FK posing and reuse of ArtCraft (see `artcraft-integration-audit.md` §12)

Pose Mode uses the vendored `FKHelper` (rotate gizmo on bone spheres) and the engine's own selection, root gizmo and
undo/redo. The upstream helper looks for `mixamorig:*` bone names, so the Prism rig carries an **explicit alias table**
(`mixamoAlias` per joint); Prism code reads the semantic id (`bone.userData.prismJoint`). Joint limits are **editor
safety constraints** (elbows and knees fold one way, the head cannot spin around), clamped as a bone is dragged; they are
not anatomical. The stored quaternion stays authoritative, and a stored pose is never silently rewritten by the limits.

FK only. There is no IK, foot planting, physics or pose animation in M2B.

### Presets

`Neutral Stand`, `Seated`, `Walk A`, `Walk B` and `Hands on Hips`: procedural quaternion data in
`src/domain/previs/pose.ts`, not animation files. They are starting points, all inside the joint limits.

### Staleness

Blocking stores the Set revision and fingerprint it was authored against. When the Set changes it is **STALE BLOCKING**
(never deleted). **Re-anchor to current set** is an explicit action that records the live revision/fingerprint without
changing any root transform or pose. Saving only writes the _changed_ figures, so saving never silently re-anchors a
stale one.

A master frame or previs records the blocking it showed (`blocking_fingerprint` + per-figure `{characterId, blockingId,
revision, fingerprint}`; ids and fingerprints only). A render is current only while that equals the Shot's current
rendered layer. A silent previs still ignores audio changes but **not** blocking changes. Historical renders are kept.

### Rendering

The proxies are production-blocking content: they appear in master frames and local previs (the previs renders the
Shot's **static** saved pose for the whole clip; there is no pose animation). Editor helpers never do: bone spheres and
skeleton lines are on the editor-only layer 1, and the FK gizmo is hidden for the duration of a render. The server
rejects a master frame or previs whose claimed blocking is not the saved blocking.

### GenerationPackage

`spatialReference.shotBlocking` (optional; absent without blocking, so earlier packages are byte-identical) freezes by
value, per figure: `characterId`, `blockingId`, `revision`, `fingerprint`, visibility, the Set revision/fingerprint it
was authored against, `root {position, orientation, scale, heightMeters}`, `rigVersion`,
`pose {schemaVersion, poseFingerprint, joints}` and a deterministic text `summary` (not model generated, no emotion
inferred, not injected into provider prompts). Identity (Character/Look references) is a separate channel. M1's
`characterBlocking` keeps its meaning and shape.

### Persistence (migration 0033)

`shot_character_blocking` (owner-only RLS, no worker grants, unique `(shot_id, character_id)`, composite project-safe
foreign keys including a new `characters (id, project_id)` key, compare-and-set `revision`, immutable
project/shot/character). `scene_master_frames` and `shot_previs_clips` gain `blocking_fingerprint` + `blocking_json`.

### Tests (M2B)

| Layer                                                                | File                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------- |
| rig, quaternions, pose schema/fingerprint, limits, presets, blocking | `src/domain/previs/__tests__/rig-pose-blocking.test.ts`  |
| persistence rules, Shot isolation, staleness, re-anchor, package     | `src/domain/previs/__tests__/shot-blocking-repo.test.ts` |
| procedural three.js rig: hierarchy, FK propagation, disposal         | `src/lib/previs/__tests__/humanoid-rig.test.ts`          |
| Postgres, RLS, isolation, constraints, render provenance             | `scripts/db-blocking.mts` (`npm run db:blocking`)        |
| real gizmos, persistence, undo, Shot isolation, renders, package     | `e2e/zzzzzzzzz-character-blocking.spec.ts`               |

## Spatial control passes (Phase 2F M2C)

Prism already knows the Set geometry, the Shot's character blocking, the production camera and (since M2A) the camera
motion. M2C turns that into **machine-readable, pixel-aligned control data** for one exact rendered frame of a Shot:

> **Do not ask a generation model to guess geometry Prism already knows.**

These are _not_ beauty renders. They are deterministic facts for later conditioning, compositing, inpainting,
occlusion control and continuity QA. **M2C creates control data only.** It sends nothing to any provider, writes no
provider syntax into any prompt, and decides nothing about how a provider will consume it. Provider adapters come later.

### Control frame: `prism.spatial-control-frame.v1`

One bundle belongs to ONE control frame: the Shot, the **saved** Set (document id, revision, fingerprint), the
**rendered** blocking layer (fingerprint, `null` = no visible proxies), an **explicit camera source**, the frame size
(always the full Production Frame, **1912 × 800**, 2.39:1; never the viewport) and the captured time.

| Camera source | Used when                        | Frozen BY VALUE                                                                                                                      |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `camera_path` | the Shot has a saved camera path | path id, revision, fingerprint, `timeMs` (the **timeline playhead**, whole ms) and the camera the shared `evaluateCameraPath()` gave |
| `bookmark`    | the Shot has no camera path      | bookmark id, a fingerprint of the bookmark's camera, and that camera                                                                 |

The editor/navigation camera is never a valid source. There is **one** camera interpolation: the same
`evaluateCameraPath()` that timeline playback and previs use.

The camera is stored by value so rays can be reconstructed: `position`, unit `quaternion` (canonical sign, rounded to
1e-6), `focalLengthMm`, `sensorHeightMm` (24, the engine's vertical-sensor basis), `fovVerticalDegrees`, `aspect`,
`near` (0.05), `far` (2000), `width`, `height`.

### Conventions (stored once, shared by every raster)

- Every raster is `width × height`, **row-major, row 0 = the TOP row**. The single flip from WebGL's bottom-left origin
  happens once, at readback (`spatial-pass-renderer.ts`). Flat index = `y · width + x`.
- Multi-byte values are **little-endian** regardless of host (`encode*` / `decode*` in `spatial-passes.ts`).
- All rasters of a bundle share exactly the same width, height, camera and framing; nothing is individually resized.
- At every pixel `depth[x,y]`, `objectId[x,y]` and each Character mask refer to the same production ray.

### Depth: `prism.depth-f32.v1`

| Property   | Value                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| Meaning    | **linear view-space depth**: the positive distance **along the camera's forward axis** (not ray length) |
| Units      | **metres**                                                                                              |
| Encoding   | Float32, little-endian, `w · h · 4` bytes                                                               |
| Background | **0** (no geometry). Geometry can never be 0: the near plane is 0.05 m                                  |
| Range      | `near` 0.05 … `far` 2000 (recorded in the metadata with `minDepth` / `maxDepth` / `validPixelCount`)    |
| MIME       | `application/x-prism-depth-f32`                                                                         |

The depth pass is rendered on the GPU with a temporary `RGBA32F` render target and a small shader that outputs
`-viewPosition.z` (varyings interpolate perspective-correctly, so this is exact linear depth). It is **not** derived
from a screenshot or from nonlinear hardware depth, and it runs with no lighting, fog, tone mapping, blending or
postprocessing. If the browser cannot render float targets (`EXT_color_buffer_float`), the capture **stops with an
error** instead of falling back to a lower-precision depth. The PNG/grayscale preview in the panel is display-only
(near = dark, far = light) and is never the canonical data.

Server validation: exact byte size, every value finite, non-negative and inside the near/far range.

### Object IDs: `prism.object-id-u32.v1`

Which stable production entity owns each visible pixel. Uint32, little-endian, `w · h · 4` bytes,
`application/x-prism-object-id-u32`. Rendered with depth test ON, **blending OFF, no multisampling, nearest sampling,
no lighting or tone mapping** into the float target (an exact integer round-trips through a float up to 2²⁴), so an
index is never blended or anti-aliased. The false-colour preview is visualisation only.

The manifest (`prism.object-id-manifest.v1`) and the id raster are authoritative together:

```
{ schema, objects: [{ index, semanticId, category, sceneObjectId? | characterId? + blockingId?, label?, visiblePixelCount }] }
```

- **Index 0 is the background; indices 1..N are assigned by sorting** (Set objects first, then Character proxies, each by
  semantic key). There is no hashing into colour, so there are no collisions.
- **Indices are BUNDLE-LOCAL. Semantic ids are persistent.** Adding an object may renumber a later bundle; its
  fingerprint then differs. Never treat an index as globally permanent.
- Set objects: `set_object:<scene object uuid>`. The uuid is the engine's persisted `object_uuid`: it survives save and
  reload (verified), unlike a runtime `THREE.Object3D.uuid` for an unsaved object. A GLB with many sub-meshes is **one**
  object.
- Character proxies: `character_proxy:<characterId>` (with the stored `blockingId`). The whole proxy (head, torso,
  limbs) is one object; Yumeko and Sean get different ids.
- Categories are extensible; M2C uses only `set_object` and `character_proxy`. There is no semantic segmentation.
- Lights are not geometry. Hidden Set objects and **hidden Character proxies are not rendered, so they have no entry**.
- The Location's scene never gains Character objects: proxies stay a Shot overlay (M2B ownership is intact).

**Only production geometry takes part.** The renderer is given an explicit registry of entity roots. Everything else in
the scene (grid, transform gizmo, FK joint spheres, skeleton lines, camera-path overlay, camera proxy, lights, selection
outlines) is hidden for the render and restored in `finally`; descendants of a Character proxy that are not proxy pieces
are hidden too; layer-1 (editor-only) objects are excluded by the pass camera. Names like "helper" are not the safety rule.

### Character masks: `prism.character-mask-u8.v1`

One exact binary mask per **visible** blocked Character: `w · h` bytes, **0 = not this Character, 255 = this
Character**, `application/x-prism-character-mask-u8`. A mask is **derived from the object-id raster and the manifest**
(not a re-render), so masks and ids can never disagree; the server re-derives each mask and rejects any difference.
No feathering, blur, dilation or erosion: **masks are geometry truth**; any provider-specific softening happens later.

- Masks are **visible pixels**: if Sean stands behind Yumeko, Sean's mask excludes everything Yumeko covers (the depth
  test does this automatically).
- A Character enabled in the blocking but **completely hidden** behind geometry keeps its manifest entry and gets an
  all-zero mask with `visiblePixelCount: 0`. "Proxy visibility enabled" is not "visible on camera".
- A **hidden** proxy (visibility off) has no manifest entry and no mask.
- `prism.character-masks.v1` maps by **Character id** (never list position):
  `{ blockingId, blockingRevision, blockingFingerprint, objectIndex, assetId, encoding, visiblePixelCount }`.

### Renderer (no second context, no side effects)

`ArtCraftSceneAdapter.captureSpatialPasses()` reuses the editor's **existing** `WebGLRenderer` and scene, an isolated
`PerspectiveCamera` built only from the frozen camera value, and one temporary `WebGLRenderTarget` (no multisampling).
Original materials, visibility, background, environment, fog, `overrideMaterial`, the render target, clear colour/alpha
and `autoClear` are saved and restored in a `try/finally`; temporary shader materials and the render target are
disposed. The ordinary (beauty) picture, the navigation camera, the production camera, the selection and the scene
graph are unchanged (checked by digests in the E2E), and repeated captures do not grow textures, geometries, shader
programs or canvases.

### Bundle: `prism.spatial-pass-bundle.v1`

One capture = one **immutable** bundle (`shot_spatial_pass_bundles`): the control frame, the depth asset, the id asset,
the manifest (with pixel counts) and the masks by Character id. The same exact control frame is stored **once**
(deterministic rendering): capturing it again returns the existing bundle.

`bundleFingerprint` covers the schema and algorithm versions, the three format versions, the Shot, the scene
fingerprint, the rendered-blocking fingerprint, the camera source by value (path id / revision / fingerprint / time),
the frame size and the manifest identity (indices, semantic ids, categories, ids). It does **not** depend on the
navigation camera, selection, selected bone, helper visibility, panel state, timeline zoom, playback state, labels,
pixel counts or any object URL.

### Capture rules and the server

Capture requires: the Set saved; the character blocking saved and not stale (re-anchored); the camera path saved,
current and not playing (or a Production Camera linked and current); never ambiguous unsaved state. The panel lists
exactly what is missing.

The browser renders; the server **re-derives and validates everything it can**: the saved scene and blocking, the
camera by value from the saved path/bookmark, the expected manifest from the saved Set + blocking, and the bundle
fingerprint (a mismatch is a conflict); exact byte sizes; finite, in-range depth; ids inside the manifest; depth and
ids covering the same pixels; masks containing only 0/255 and equal to the masks derived from the ids; no URLs in
metadata. All rasters are validated **before** anything is stored. Assets are uploaded and their rows written, then the
bundle row; if any step fails everything that capture wrote is removed, so a bundle never points at a missing asset.

### Request size and bounds

A two-Character capture is about 15.3 MB (depth 6.1 MB + ids 6.1 MB + 1.5 MB per mask + multipart overhead). Next buffers
request bodies for the proxy in front of the app and, by default, **truncates anything over 10 MB** ("Unexpected end of
form"), so `experimental.proxyClientMaxBodySize` is set to **55 MB**: the same ceiling as `serverActions.bodySizeLimit`,
which already had to cover a 50 MB previs. That global ceiling is only the outer limit; the capture action enforces its
own, independent of it, **before any raster byte is read**:

- only the known text fields; the manifest text is at most 512 K characters before it is parsed;
- the files must be exactly `depth`, `objectIds` and one `mask:<characterId>` per Character proxy in the manifest the
  server re-derived from the saved Set and blocking, so the **mask count is bounded by the Shot's visible Characters**,
  never by the client;
- each file's size must equal the canonical length (depth and ids `1912·800·4`, each mask `1912·800`): no truncated or
  padded raster, no duplicate or extra file, and therefore a bounded total;
- values are validated after that (finite in-range depth, ids inside the manifest, masks 0/255 and equal to the masks
  derived from the ids); previs clips keep their own 50 MB cap.

Storage is all-or-nothing (`persistPassBundle`): objects and Asset rows are written in order, then the bundle row; any
failure removes everything that attempt wrote (idempotently, and a cleanup error never replaces the original error).

### Assets, privacy and taxonomy

Every pass is a **private** Asset (no public bucket, no persisted signed URL; reads go through the authenticated
`/api/assets/<id>` route). Raw machine data is **not** an image: assets use the new type **`data`** and purpose
**`spatial_control`** (migration 0034 extends both checks) with the `application/x-prism-*` MIME types above, which the
private bucket now accepts. A bundle's assets cannot be deleted from the library ("belongs to a spatial control-pass
bundle").

### Staleness

| Reason           | When                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `STALE SCENE`    | the saved Set changed                                                                                                |
| `STALE CAMERA`   | the saved camera **path** changed (path source) or the Production Camera bookmark's camera changed (bookmark source) |
| `STALE BLOCKING` | the rendered blocking layer changed (including a proxy appearing or disappearing)                                    |
| (never)          | **audio**: these assets contain none, so a take selection or mix change leaves a bundle current                      |

History is kept: stale bundles remain stored and listed. The pure `pickCurrentBundle()` returns the latest bundle that is
**exactly** current, never merely the newest. A bookmark capture is unaffected by a camera path being added later.

### GenerationPackage

`spatialReference.controlPasses` (additive, **omitted** when the Shot has no current bundle, so earlier packages stay
byte/fingerprint compatible) freezes the **current** bundle by value: ids, fingerprint, size, camera source and camera,
`rowOrder`, depth `{assetId, encoding, units, backgroundValue, near, far}`, object ids `{assetId, encoding, manifest}`,
and per-Character `{characterId, assetId, encoding, objectIndex, blockingFingerprint, visiblePixelCount}`. No bytes and
no URLs. The pass assets also appear in the package's `assets` map (type, purpose, MIME, size, checksum). A stale
bundle is never frozen into a new package, and a compiled package never changes afterwards. Nothing is added to any
prompt ("use this depth map" etc.): provider adapters will decide how to consume the passes.

### Persistence (migration 0034)

`shot_spatial_pass_bundles` (owner-only RLS, no worker grants, unique `(shot_id, bundle_fingerprint)`, composite
project-safe foreign keys to shots, locations, scene documents, camera paths (`on delete set null`) and the depth/id
assets; an update guard makes bundles immutable). `assets` gains type `data` and purpose `spatial_control`; the
`prism-assets` bucket accepts the three machine MIME types (still private).

### Tests (M2C)

| Layer                                                                                          | File                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| formats, validation, manifest, masks, camera source, fingerprint, staleness, previews, package | `src/domain/previs/__tests__/spatial-passes.test.ts`          |
| repository, dedupe, current selection, package freeze/immutability, staleness                  | `src/domain/previs/__tests__/spatial-passes-repo.test.ts`     |
| Postgres, RLS, immutability, constraints, composite FKs, asset pinning, package                | `scripts/db-spatial-passes.mts` (`npm run db:spatial-passes`) |
| real WebGL: known-distance depth, occlusion, orientation, masks, helper exclusion, state, GPU  | `e2e/zzzzzzzzzz-spatial-passes.spec.ts`                       |
| UI + server flow, private assets, persistence, staleness, package                              | `e2e/zzzzzzzzzz-spatial-passes.spec.ts`                       |
| Supabase: private storage, anonymous refusal, Postgres persistence                             | `e2e/supabase-spatial-passes.spec.ts`                         |

### Known gaps (M2C)

- One frame per capture (no per-frame sequence of passes along a clip); no normal, motion-vector or flow passes.
- Raw, uncompressed rasters (≈ 6.1 MB depth + 6.1 MB ids + 1.5 MB per Character); no compression yet.
- Transparent/alpha materials are treated as opaque geometry; GLB sub-meshes inherit their root's id.
- Proxies are rigid segments, so masks follow that silhouette (a neutral stand-in, not a final Character).
- A GLB that fails to load makes the saved Set and the live scene disagree; capture then stops with a conflict.
- Depth needs WebGL2 float render targets (`EXT_color_buffer_float`); without it capture refuses.
- Provider conditioning (depth/mask upload, control nets, inpainting, compositing) is intentionally not built.

## Gaussian-splat Location environments (Phase 2F M2D.1)

A Location's 3D Set can hold a **reconstructed spatial environment**: a Gaussian splat. M2D.1 builds the provider-neutral
runtime for it: **store, display, transform, render and persist**. It does not create reconstructions (no image-to-3D
provider, no photogrammetry, no NeRF training: that is M2D.2).

```
Location → Spatial environment → Import Gaussian splat → private Asset (+ immutable reconstruction record)
         → one Set object → move / rotate / scale / calibrate → Production Camera → blocking → master frame → local previs
```

The splat belongs to the **Location**, not to a Shot. Shot-specific Character blocking remains an overlay exactly as in M2B.
A splat is **spatial environment data**: not a flat reference image, not a generated video, not Character identity, and
not a substitute for explicit Set geometry everywhere. Prism always knows whether a scene contains mesh geometry,
splats or both, and never claims capabilities the splat renderer cannot provide (see _M2C interop_).

### Runtime: Spark, one renderer, one context

|                      |                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package              | `@sparkjsdev/spark` **0.1.10**, exact; MIT, © 2025 World Labs Technologies, Inc. (`LICENSE` in the package; recorded in `THIRD_PARTY_NOTICES.md`)                                                                                                                                                                                                                                |
| Why 0.1.10           | the version the pinned ArtCraft commit used (`^0.1.10`); Spark 2.x peers `three ^0.180` and Prism pins `three ^0.171`                                                                                                                                                                                                                                                            |
| Renderer             | the editor's **existing** `THREE.WebGLRenderer`. `SparkRenderer({ renderer })` adds one object to the scene and draws splats in the same pass as meshes. **No second renderer, canvas, iframe or WebGL context** (asserted in the E2E: the context count is unchanged by importing a splat and a remount costs what a page load costs)                                           |
| Network              | none. The bundle has no executable URL (its only URLs are reference links in source comments); its sort worker and WebAssembly are inlined. Splat bytes come from Prism's authenticated Asset route                                                                                                                                                                              |
| Loading              | `fileBytes` (an in-memory buffer): **no URL, no Blob URL**, so there is nothing to persist or revoke                                                                                                                                                                                                                                                                             |
| Lazy                 | imported on the first splat load; a Set without a splat never downloads it                                                                                                                                                                                                                                                                                                       |
| ArtCraft code reused | none. The audit of the pinned commit found Spark used as `SplatMesh` + URL loading + a `__bbox_internal` selection helper + an entrance "dyno" effect + a `SparkRenderer` on the camera. M2D.1 keeps only the idea (Spark's `SplatMesh` as a scene object); everything else is Prism-written (`src/lib/previs/splat-runtime.ts`). No ArtCraft demo splat, scene or asset is used |

The only vendor edit is a small, documented hook: `PageSceneAdapter.loadSplat`, called from `Scene.loadObject` before the
model loader, plus a duck-typed `isPrismSplat` disposal branch in `disposeObject3D` (diff:
[`patches/prism-m2d1.patch`](../src/vendor/artcraft-scene-engine/patches/prism-m2d1.patch)). The upstream `.spz` URL
sniffing is gone; a splat is never recognised from a URL.

### Formats (only what is parsed AND tested)

| Format                 | Extension | MIME (stored on the Asset)     | Validation (client and server; the server is the authority)                                                                                                                                                             |
| ---------------------- | --------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Antimatter-style splat | `.splat`  | `application/x-gaussian-splat` | size is a whole number of 32-byte records; every position and scale is finite                                                                                                                                           |
| SPZ v2 / v3            | `.spz`    | `application/x-spz`            | gzip; stream-inflated in slices and stopped as soon as the output disagrees with the 16-byte header; exact decompressed size; Gaussian count bounded (no decompression bomb)                                            |
| Gaussian PLY           | `.ply`    | `application/x-ply`            | **binary little-endian**, exactly one `vertex` element, with the 3DGS attributes (`x y z scale_0‥2 rot_0‥3 opacity f_dc_0‥2`); exact size from the header. A point-cloud or ASCII PLY is refused with a precise message |

`.ksplat` and the PlayCanvas SOG variants are readable by Spark but are **not enabled**: nothing tests them. The filename
must agree with the bytes (a renamed `.ply` is refused as a `.splat`), the file is capped at **50 MB** and at 8 000 000
Gaussians. The global 55 MB request ceiling was **not** raised; larger splats need a resumable/direct upload (a later
storage milestone).

Test data is generated at test time from the formats' documented primitives (`src/lib/splat/synthetic.ts`): a coloured
plane of Gaussians. Nothing third-party is committed.

### Assets and privacy

A splat is a **3D Asset**: `type = '3d'`, `purpose = 'spatial_reconstruction'` (migration 0035), the truthful machine MIME
above, in the private bucket (no public bucket, no persisted signed URL; the browser reads it through the authenticated
`/api/assets/<id>` route). It cannot be uploaded through the generic library (the sniffer refuses it); it enters only
through the reconstruction import. Anonymous and cross-project users cannot read it.

### Two records, deliberately separate

|               | Record                                         | Mutable?                          | Holds                                                                                                                                                                                                                                                     |
| ------------- | ---------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Origin**    | `location_spatial_reconstructions` (immutable) | no (a trigger refuses any update) | the result Asset (+ its content checksum), `method = 'imported'`, `result_kind = 'gaussian_splat'`, the source reference images (ids + checksums, may be empty), the calibration the source **claimed** on arrival (units unknown), a content fingerprint |
| **Placement** | the Set document's splat object                | yes                               | position / rotation / uniform scale, visibility, lock, **calibration** (scale provenance)                                                                                                                                                                 |

Moving, rotating or re-scaling the splat never rewrites the origin. The reconstruction fingerprint covers: schema, Location,
method, result kind, the result Asset id **and content checksum**, the canonicalised source Asset ids + checksums, and the
imported calibration. It excludes panel state, selection, the navigation camera, names and any URL.

Source images are validated server-side: each must be an **image Asset of the same Project** (they are JSON members, so
the database cannot enforce this). They are provenance, not Shot references: they are **not** added to any prompt or
reference list. Result and sources are pinned against deletion.

### Scene object, fingerprint and versioning

`prism.previs.v1` is extended backward-compatibly: `PREVIS_OBJECT_KINDS` gains `splat`, and `PrevisObject` gains nullable
`reconstructionId` and `calibration` (defaults null, so old documents still parse). A splat object is an asset-bound
`m_<assetId>` token whose `user_data` names its reconstruction; the engine's own save JSON round-trips it.

The Set fingerprint changes when the splat **Asset checksum**, **transform**, **visibility**, **calibration** or presence
changes. Lock, loading progress, runtime buffers, selection and the navigation camera never change it. The fingerprint keys
for a splat (`reconstructionId`, `calibration`) are added **only** to splat objects, so a Set without one keeps its
historical fingerprint (unit-tested: the key set of a non-splat object is exactly the old one).

A Set holds **one** splat environment (enforced on save). The server re-checks on every save that the object's Asset is a
splat Asset of this Project, bound to a reconstruction of **this Location** whose result is that Asset and content.

### Calibration: scale is never assumed

A splat from another tool has an arbitrary origin, rotation and scale. Prism never assumes `1 unit = 1 metre`.

| Field                 | Meaning                                                |
| --------------------- | ------------------------------------------------------ |
| `units`               | `unknown` (default) or `metres`                        |
| `metresPerSourceUnit` | `null`, or a positive number a human entered           |
| `scaleMethod`         | `unknown` or `manual` (the only two M2D.1 can produce) |
| `groundOffsetMetres`  | informational: the Set-Y the user chose for the floor  |

The pairing is enforced (`manual` ⇔ a number ⇔ `metres`). **Apply scale** sets both the calibration and the object's
uniform scale so that one source unit equals that many Set metres; **Scale unknown** clears the claim. **Set as ground
level** rests the bottom of the (transformed) bounding box on `y = 0`; **Flip 180° (X)** fixes the common y-down
convention. There is no automatic ground, horizon or scale detection.

### Interaction

One production object: selecting, moving, rotating and uniformly scaling happens on the root with the existing gizmos.
Picking uses the splat's bounding box, never an individual Gaussian; there is no Gaussian editing. **Lock environment**
uses the engine's lock (gizmo detached) and also refuses numeric edits and calibration; navigation and Shot blocking keep
working. The inspector says **Gaussian Splat** and shows Asset, format, size, Gaussian count, provenance, scale status,
visibility, lock and the load time / GPU estimate.

### Rendering and depth composition

Master frames and previs render the splat through the same isolated Production Camera as meshes. Spark sorts
asynchronously for the **viewport** camera, so a production render first sorts a dedicated viewpoint from the production
pose, shows it for exactly that render and then gives the viewport its own viewpoint back (`SplatRuntime.renderFromCamera`;
it also returns the accumulator reference Spark's `prepare()` takes, or every capture would leak one).

Depth composition with ordinary THREE geometry is **proven in the real renderer** (SwiftShader), not assumed:

- a mesh in front of the splat hides it; behind it, the splat wins and the mesh is hidden;
- a Character proxy in front of the splat hides it; behind it, the splat wins;
- moving the mesh back restores the result (nothing depends on sort history).

Splats are alpha-blended without depth writes, so they composite correctly against opaque meshes; a **transparent** mesh
and a splat are not sorted against each other. Character proxies are opaque.

### M2C interop: blocked, not faked

The M2C depth / object-id / mask passes cannot represent splat geometry exactly. Rather than silently omit the
environment, **Capture Control Passes is blocked while a splat is visible**, in the UI and again on the server (which
checks the saved Set):

> Spatial control passes for Gaussian splat environments are not supported yet. Hide the splat or use mesh geometry to
> capture exact depth and object masks.

Hide the splat, save, and the capture is available again. A hidden splat is not in the manifest. Earlier bundles remain.

### GenerationPackage

`spatialReference.spatialEnvironment` is additive and optional (absent when the Set has no splat; earlier packages are
byte-identical). It freezes by value: kind, scene object id, reconstruction id + fingerprint, Asset id + checksum, format,
Gaussian count, visibility, the transform (position, Euler rotation, **quaternion orientation**, scale), the calibration,
and the reconstruction's source image ids + checksums. No bytes, no URL, no change to any provider prompt. The splat Asset
is also described in the package asset map. A package compiled before the splat moved is unchanged (a value, not a view).

### Failure states

Unsupported format, corrupt file, parse failure, oversize file, missing Asset, fetch failure and a GPU that cannot run the
runtime all produce a specific message; nothing is added to the Set. If the **saved** Set names a splat that cannot be
loaded, the editor shows the reason, **disables Save** (saving would silently drop it) and offers an explicit "Remove it
from this set". The saved Set is never corrupted by a failed load.

### Resources

Removing a splat (or leaving the page) disposes its Spark object and GPU buffers through the engine's own disposal path
(`isPrismSplat`); the SparkRenderer is removed and freed on unmount. Repeated navigation does not duplicate the splat and
does not add WebGL contexts (E2E: three remounts, one splat root and one SparkRenderer each time).

### Tests (M2D.1)

| What                                                                                                                                 | Where                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Formats, calibration, fingerprints, document, package value                                                                          | `src/domain/previs/__tests__/splat.test.ts`, `splat-reconstruction-repo.test.ts`, `src/lib/splat/__tests__/inspect.test.ts` |
| Reconstruction table, RLS, immutability, pinning, atomic import                                                                      | `npm run db:reconstructions` (`scripts/db-reconstructions.mts`)                                                             |
| Real browser: import, render, depth ordering, gizmos, lock, save/reload, previs, master frame, M2C block, package, failures, cleanup | `e2e/zzzzzzzzzzz-gaussian-splats.spec.ts`                                                                                   |
| Supabase: private storage, anonymous / cross-project refusal                                                                         | `e2e/supabase-gaussian-splats.spec.ts`                                                                                      |

### Known gaps (M2D.1)

- No reconstruction provider, image-to-3D, photogrammetry or NeRF training; "imported" is the only method.
- One splat per Set; no per-Gaussian editing, picking, segmentation or animation; no automatic ground/scale/horizon.
- No exact depth, object-id or mask pass for splats (capture is blocked); no splat↔transparent-mesh ordering.
- 50 MB / 8 M Gaussians; `.ksplat` and SOG are not enabled; spherical-harmonic view-dependence is whatever Spark renders.
- Rendering proof is SwiftShader (no hardware-GPU run); the FPS and load time of the small fixture say little about real scenes.
- A missing Asset is detected after load by comparing the saved Set with what materialised (the engine drops a failed
  object silently); the editor blocks Save rather than guessing.
- The sort worker is created from an inlined Blob; a Content-Security-Policy that forbids `worker-src blob:` would need an
  exception (Prism sets none today).

## Generated spatial environments (Phase 2F M2D.2)

A Location's spatial environment can now also be **generated** from its reference images by a reconstruction job
(see [reconstruction-providers](reconstruction-providers.md)). The result converges on exactly the M2D.1 path:

- the provider result is downloaded server-side, size-capped (50 MB), checksummed and validated with `inspectSplat`
  before it becomes a private `3d` / `spatial_reconstruction` Asset (`source = provider_output`);
- it is recorded as an immutable `location_spatial_reconstructions` row with `method = 'generated'`, the job's
  ORDERED sources and the job / provider / model / operation provenance;
- nothing changes in the Set until **Use as Spatial Environment** (with an explicit confirmation to replace an existing
  environment); it is then an ordinary splat object: transform, lock, calibrate, save;
- calibration gains `scaleMethod: provider_estimated` for a provider's documented metric ESTIMATE (World Labs
  `metric_scale_factor` ≠ 1); the inspector says "provider-estimated … (an estimate, not exact)";
- `spatialReference.spatialEnvironment` gains an optional `generation` block (job, attempt, provider, capability,
  model, operation id) for generated environments only; imported environments are unchanged;
- a visible generated splat blocks M2C control passes exactly like an imported one.
