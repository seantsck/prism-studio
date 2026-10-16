# ArtCraft scene-core integration audit (Phase 2F M1)

Status: M1 implemented. This file is the engineering record of what was taken from ArtCraft, why, what had to change,
and what is still a risk. The feature itself is described in [virtual-set.md](./virtual-set.md); provenance and the
update procedure live next to the code in `src/vendor/artcraft-scene-engine/UPSTREAM.md`.

## 1. Upstream, licence, scope

- Repo `https://github.com/storytold/artcraft`, pinned `d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373` (re-verified with
  `git rev-parse HEAD` in the scratch clone; analysis used `git archive` of that commit, not a working tree).
- Licence re-checked at the pin: `LICENSE-MIT`, `LICENSE-APACHE`, `NOTICE`, README "License" section → **MIT OR
  Apache-2.0**, ArtCraft name/logos excluded as trademarks. Nothing differs from the earlier audit.
- Tauri required: **no** (`pagescene`/`viewer-3d` contain zero Tauri imports; Tauri is only in the app host).
- ArtCraft API required: **no** for M1. The engine needs a token→URL resolver, a binary fetch and optional
  save/load; Prism supplies all three. Observed in the running app: zero requests to any ArtCraft host.

## 2. Reused paths (see UPSTREAM.md for the table)

`pagescene/src/lib/{engine,proxy,enums,datastructures,actions(12),hooks(2)}`, `PageSceneStore.ts`,
`sceneMetadata.ts`, `models/sceneGenerationMetadata.ts`, and `viewer-3d/.../disposeObject3D.ts`. 13.3k lines / 98 files at first import; **12.3k lines / 91 files** after the pre-PR hardening cut (§10).

Reused implementations (not rebuilt): `Scene`/`StoryTellerProxyScene` (scene graph + JSON), `CameraController`
(viewport vs render camera, `::CAM::` proxy, camera view, frame projection), `GizmoController` + `TransformControls`
(translate/rotate/scale), `SelectionBridge` + selection outline, `HistoryManager` + actions (undo/redo),
`SaveManager.getSceneJson`, `Editor.snapShotOfCurrentFrame`, `disposeObject3D`/`Editor.unmountEngine`, `useFreeCam`,
`useViewportPointer`, `MouseControls`.

## 3. Excluded

UI kit and screens, asset menu/demo lists, scene library, `@storyteller/*` packages, `engine/entrance*`,
`engine/ammoLoader.ts`, `engine/recording/TimelineRecorder.ts`, `engine/keymap.ts`, `engine/EditorState/**`, specs,
and **every** non-code asset (sound, memes, skyboxes, MMD/VMD, Mixamo GIFs, avatars, logos, fonts, video, wasm).

## 4. Dependency closure

Added: `three@^0.171`, `@types/three@^0.171` (dev), `zustand@^5`. `@sparkjsdev/spark` was added at first import (the
engine hard-wired it) and **removed in the pre-PR hardening**: its four import sites were a splat loader, an
`instanceof SplatMesh` check, a dispose helper and a type-only field, all unreachable from M1 (§10).
Deferred: `mediabunny` (MPL-2.0; only the video recorder), `react-hot-toast` (replaced by a shim),
`@storyteller/*` (replaced by shims), `lucide-react` (already in Prism).

## 5. Patches (171 added lines, plus whole-file removals of excluded modules)

See UPSTREAM.md §"Prism patches". The ones that matter for correctness:

| Patch                                                      | Why                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 2.39:1 in `getRenderDimensions` + `snapShotOfCurrentFrame` | upstream had no cinema ratio, and its two dimension tables disagree with each other for several ratios |
| `prism*` userData survives load                            | otherwise a mannequin lost its Character association on reload (found by the e2e)                      |
| shape-factory hook                                         | Plane and Mannequin without editing `instantiate` per shape                                            |
| placeholder font removed                                   | otherwise a 404 + unhandled rejection on every mount (found by the first live run)                     |
| `adapter.ts` reduced                                       | the original mirrors the ArtCraft host (generation, accounts, CDN)                                     |

## 6. What the running integration proved

Verified in Chromium (software WebGL) against the production build of Next 16 / React 19:

- The engine mounts, renders a grid, accepts primitives and the mannequin, selects, moves via the object panel and
  records undo.
- Save → reload restores objects, transforms, mannequin→Character association, production camera pose and focal length.
- "Look through production camera" shows the exact 2.39:1 framing; capture produced a **1912×800** PNG whose content
  matches the framed view with no grid, gizmo or camera helper.
- Four mount/unmount cycles leave **0** live WebGL contexts and never more than 2 per mount.
- Zero requests to ArtCraft services.

## 7. Known risks

| Risk                                                                                                             | Status                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Hidden global state: `PageSceneStore` is a module singleton                                                      | mitigated: the adapter resets scene state on every mount; two editors on one page are unsupported                                 |
| `snapShotOfCurrentFrame` renders the viewport camera (upstream flagged render-camera reconciliation as deferred) | **resolved in §10**: capture passes an isolated camera built from the frozen bookmark; the viewport camera is not read or changed |
| Focal length is not keyframed upstream                                                                           | M2 (see virtual-set.md)                                                                                                           |
| Euler (not quaternion) rotation                                                                                  | stored as Euler XYZ radians; M2 slerp for camera paths                                                                            |
| `mixamorig:*` bone names for FK posing                                                                           | not used in M1; the mannequin is a single merged mesh                                                                             |
| GLB only, no Draco/KTX2/Meshopt, external resources unsupported                                                  | M1 accepts plain GLBs uploaded through the normal Assets flow                                                                     |
| Bundle size (three + postprocessing)                                                                             | the editor is `next/dynamic` with `ssr:false`, so it only loads on the 3D route                                                   |
| Upstream JSON format has only a `version` number                                                                 | wrapped in `prism.previs.v1`; the engine payload is opaque to the DB                                                              |
| Engine logs verbosely (`console.log/debug`)                                                                      | harmless; left unpatched to keep the diff small                                                                                   |

## 8. Licensing / provenance checklist

- [x] LICENSE-MIT, LICENSE-APACHE, NOTICE retained in the vendor directory
- [x] statement of changes (UPSTREAM.md + patch file)
- [x] trademark not used (feature is "3D Set")
- [x] no upstream asset copied; mannequin and Hotel Canopy set are procedural and Prism-authored
- [x] `THIRD_PARTY_NOTICES.md` updated
- [x] `engine/TransformControls.js`: three.js (MIT) — identified by token comparison against r140–r181 (§10), header and
      licence text added
- [x] `CustomOutlinePass.js`, `FindSurfaces.js`, `chromakey.js`, `shaders.js`: provenance not establishable from the
      files (they cite a social-media post, the `webgl-outlines` project and a forum post that cites a libretro shader). **Removed**, not
      shipped

## 9. Update procedure

See `src/vendor/artcraft-scene-engine/UPSTREAM.md`.

## 10. Pre-PR hardening (after the first M1 report)

**Master frame uses the production camera.** `Editor.snapShotOfCurrentFrame` rendered `cameraController.camera` (the
viewport camera), which the capture code pushed to the production pose by entering camera view. That worked but made the
editor camera the source of the image. It now takes an optional camera: `ArtCraftSceneAdapter.captureMasterFrame(bookmark)`
builds a fresh `PerspectiveCamera` from the frozen shot bookmark (`productionRenderSpec`: position, Euler rotation,
vertical FOV from the focal length on the declared `vertical-sensor-24mm` basis, 1912×800 aspect, proxy layer excluded)
and the main composer renders through it for that one call. The viewport camera, the look-through state and the
editor/navigation pose are never touched. Evidence: `production-render.test.ts`, `capture-camera.test.ts` (unit);
`e2e/zzzzzz-previs-controls.spec.ts` moves the navigation camera across the scene between two captures and requires the
frames to match, then changes the production camera and requires them to differ.

**Real gizmos.** The same e2e file drives the reused `TransformControls` by mouse (translate along one axis, rotate a
ring), saves, reloads and checks persistence. Scale is asserted to remain available (not drag-tested).

**Dead code.** See `UPSTREAM.md` "Removed after the first import": Water, MMD, splats (and `@sparkjsdev/spark`), the raw
composer + second WebGL context, `CustomOutlinePass`/`FindSurfaces`, chroma key. The vendor tree went from 98 files /
13.3k lines to 91 files / 12.3k lines, one WebGL context per mount, and no executable path to a non-same-origin URL
(asserted by the e2e "same-origin requests" test).

**Remaining coupling, documented.** `scene.ts` still imports the `three/examples/jsm/Addons.js` barrel for the two camera
controls in `keybinds_controls.ts` (a tree-shaken import, not a dependency); `editor.ts` imports three's `stats.module`
(never attached). Both are three.js and MIT.

**Package immutability.** A GenerationPackage is persisted only inside a provider attempt (`packageSnapshot`), and no
non-provider path stores one, so the A→B→A read-back was not added as a database test (that would need a second
persistence mechanism or a real attempt). The existing unit proof (`spatial-package.test.ts`) freezes a package, edits the
scene, freezes another and shows the first unchanged; the attempt row stores the JSON snapshot by value.

## 11. M2A: camera motion (decision record)

- **Engine timeline vs Prism evaluator.** The upstream `TimelineController` keys `TransformSnap` (position, Euler
  rotation, scale) per object with Euler lerp and no lens channel. M2A needs quaternion slerp, a focal-length channel,
  Catmull-Rom position and easing that apply identically to previews, scrubbing and rendering. Patching the engine
  timeline would have left two interpolation implementations. Prism owns the path and its evaluator; the engine still
  executes the result (the `::CAM::` object, lens, camera view, snapshots). No upstream file was changed for motion.
- **Vendor patches added in M2A (1):** `Editor.snapShotOfCurrentFrame(download, camera?, size?)` gained an optional
  output `size` so a previs can render below the production frame through the same isolated camera path as master
  frames. `UPSTREAM.md`/`prism-vendor.patch` were regenerated.
- **Dependency added:** `mediabunny@1.60.0` (MPL-2.0), as an npm dependency only; used for local MP4/WebM encoding.
  MPL-2.0 file-level copyleft applies to modifications of MediaBunny's own files, which Prism does not make.
- **Spark/splats** remain removed (M2D).

## 12. M2B: FK pose reuse (decision record)

**Audit.** `engine/KinHelpers/{FKHelper,FKBoneFilter,BoneJSONHelper}.ts`, `engine/editor/SkeletonHelperController.ts`,
`engine/keybinds_controls.ts` (`toggleFKMode`), `HistoryManager`/`TransformAction`, `GizmoController` and the proxy
save/load were read in full.

| Piece                                        | Verdict  | Notes                                                                                                                                              |
| -------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FKHelper` (bone spheres + rotate gizmo)     | reused   | Works on any `THREE.Bone` hierarchy. Name filtering is a substring blacklist (`FKBoneFilter`); every Prism alias passes (asserted in a unit test). |
| `toggleFKMode` / `KinMode`                   | reused   | Needs a selected scene child with `userData.isCharacter`. Prism proxies set it.                                                                    |
| Root selection, gizmo, `TransformAction`     | reused   | The proxy is a named top-level `Group`, so the engine's click-select, translate/rotate gizmo and undo work by uuid.                                |
| `HistoryManager.record(UndoableAction)`      | reused   | Prism pushes joint/preset/visibility/add/remove as `UndoableAction`s into the **same** stack: one undo/redo, no second history.                    |
| `BoneJSONHelper`                             | not used | It looks up `mixamorighips` and applies a bone tree by child index. Prism stores `prism.pose.v1` quaternions by semantic id instead.               |
| `SkeletonHelperController` (outliner toggle) | not used | Keyed to outliner objects with `userData.skeletonVisible`; the proxies are not outliner objects. FK mode draws its own skeleton.                   |
| Upstream characters/animations/GLBs          | none     | None is vendored or used. The rig is generated in code.                                                                                            |

**Naming.** Upstream wants `mixamorig:*`. Prism keeps its own semantic ids (`prism.humanoid-rig.v1`) as the domain
schema and puts an explicit `mixamoAlias` table on the bones; only the Three.js bone _names_ borrow the convention
(a naming convention, not an asset). Reverse lookup (`jointFromAlias`) resolves a foreign bone name to a semantic joint.

**Vendor patches added in M2B (`prism-m2b.patch`)** — all editor-only behaviour, no asset or feature change:

1. `shims/fk-hooks.ts` (new): host hooks for bone selected / drag start / drag end / constrain / change.
2. `FKHelper.ts`: calls the hooks; bone spheres and the skeleton helper move to **layer 1** (editor-only, excluded from
   renders) and the raycaster enables layer 1; adds `selectBone`, `getSelectedBone`, `setSkeletonVisible`,
   `setGizmoVisible`; removes the debug `console.log` calls; disposes the per-sphere materials and the skeleton helper
   (both leaked upstream).
3. `keybinds_controls.ts`: `kinMode` and `fkHelper` made readable by the host (they were `private`).

**Cost of the integration.** No part of the editor was replaced. The Prism code is `src/lib/previs/humanoid-rig.ts`,
`blocking-overlay.ts` and the panel; the engine still owns selection, gizmos, history, camera and rendering.

**Known interaction quirk (upstream).** The engine swallows the first click after the navigation camera pose changed
(`camera_last_pos`), so the first joint click after flying the camera may need repeating.
