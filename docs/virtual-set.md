# 3D Set (Phase 2F, milestone 1)

A persistent virtual set per Location. Prism stores spatial truth explicitly, so a generation model is never asked
to remember what the set looks like.

```
Location → persistent 3D scene → character blocking → production camera
        → shot camera bookmark → master frame → GenerationPackage spatial snapshot
```

Nothing in M1 generates video, calls a provider or touches an ArtCraft service.

## Ownership

| Prism owns (source of truth) | The vendored engine owns (runtime only) |
| --- | --- |
| Project, Episode, Script Scene, Shot, Location, Character, Look, Performance, Production Frame, GenerationPackage | Three.js scene graph, viewport, selection, gizmos, transforms, camera controls, rendering |
| `prism.previs.v1` document, scene fingerprint, camera bookmark, master-frame provenance | the engine's own scene JSON (opaque round-trip payload inside the document) |

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

Rendered locally in the browser (`snapShotOfCurrentFrame` after entering camera view on the production lens), 1912×800.
The server validates PNG magic bytes and exact dimensions, re-derives revision/fingerprint from the saved scene,
stores the file in the private bucket (`purpose=storyboard`, `source=3d_render`) and writes provenance both to
`scene_master_frames` and the asset's `metadata.previs`. **Capturing never changes the approved storyboard.**
"Use as Master Frame" creates a *new unapproved* storyboard frame version (`source=3d_preview`) and records the
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

| Layer | File |
| --- | --- |
| schema, URL refusal, fingerprint, camera maths | `src/domain/previs/__tests__/previs-document.test.ts` |
| package snapshot, optionality, immutability, adoption | `src/domain/previs/__tests__/spatial-package.test.ts` |
| engine boundary, asset-id resolution | `src/lib/previs/__tests__/scene-adapter.test.ts`, `shapes.test.ts` |
| Postgres, RLS, isolation, guards, cleanup | `scripts/db-previs.mts` (`npm run db:previs`) |
| UI end to end + WebGL release (memory) | `e2e/zzzzz-previs.spec.ts` |
| UI end to end on Supabase + private storage | `e2e/supabase-previs.spec.ts` |

Playwright runs Chromium with the software rasteriser (`--use-angle=swiftshader`); GPU is not required.

## Known gaps (M1)

- No "New 3D set" template picker beyond "Load Hotel Canopy Test Set"; a fresh set starts empty with CAM-A at 35 mm.
- Undo/redo covers object add/delete/transform/colour/lock/visibility; production-camera edits made through the
  inspector are not on the undo stack.
- Lights other than the engine's default rig are not offered; the vendored point-light shape exists but has no button.
- The outliner has no rename, reorder or grouping; the engine has no hierarchy UI.
- GLBs must be single-file (`.glb`, no Draco/KTX2/Meshopt, no external resources) and are added through the normal
  Assets upload with any purpose.
- Camera-view framing uses the viewport camera at the production lens; it has been verified visually and by
  dimensions, not by a pixel diff against an independent render-camera pass.
- Master-frame capture needs the set to be saved and the shot's camera linked first (the server enforces both).

## M2 reuse (investigated, not built)

| Capability | Upstream basis | What Prism must add |
| --- | --- | --- |
| Camera timeline / path | `engine/timeline/{types,interpolation}.ts`, `TimelineController` (`::CAM::` is already a keyframe target, cubic-bezier easing) | a Prism UI; persist `timeline` inside the document; include it in the fingerprint |
| **Focal-length keyframing** | **not supported upstream** (keyframes store `TransformSnap` only) | patch: add an optional `focalLength` channel to `TimelineTrack`/`interpolation.ts`; evaluate into `cameras[].focalLength` each tick |
| Quaternion/slerp rotation | upstream lerps Euler angles (documented) | patch interpolation to slerp camera quaternions; store Euler for display |
| Character posing | `KinHelpers/{FKHelper,BoneJSONHelper}`, `SkeletonHelperController` | a Prism mannequin with `mixamorig:*`-compatible bones (rig is name-matched); pose presets as JSON |
| Pose presets | `BoneJSONHelper.toJSON/poseFromBoneJSON` | Prism-authored preset library |
| Local previs video | `engine/recording/TimelineRecorder.ts` (deterministic frame stepping) | `mediabunny` (MPL-2.0, WebCodecs); store as a derived asset with provenance |
| Depth pass | `CustomOutlinePass` + `FindSurfaces` already render depth/surface-id via override materials | expose as export; PNG sequence |
| Object-id / character masks | surface-id material exists; per-object id pass does not | new override material mapping `uuid → colour`; ties to mannequin `characterId` |
| Gaussian splats | `SplatMesh` + `@sparkjsdev/spark` already wired | asset pipeline for `.spz`; licence/provenance of splat sources |
| Image-to-location / image-to-3D | none locally (ArtCraft calls its own backend) | a Prism provider adapter behind the existing generation spend gates |

M2 recommendation order: focal-length keyframes + slerp → camera path UI → local previs video → depth/object-id
passes → mannequin rig/poses → splats → image-to-location.
