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
