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
`sceneMetadata.ts`, `models/sceneGenerationMetadata.ts`, and `viewer-3d/.../disposeObject3D.ts`. 13.3k lines, 98 files.

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

Added: `three@^0.171`, `@types/three@^0.171` (dev), `zustand@^5`, `@sparkjsdev/spark@^0.1.10` (MIT; imported by the
hard-wired `scene.ts`/`editor.ts`/`SelectionOutlinePass`/dispose, so removing it would have meant rewriting vendored
files; its splat feature is not exposed).
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

| Risk                                                                                                                 | Status                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hidden global state: `PageSceneStore` is a module singleton                                                          | mitigated: the adapter resets scene state on every mount; two editors on one page are unsupported                                                                                                 |
| `snapShotOfCurrentFrame` renders the **viewport** camera (upstream flagged render-camera reconciliation as deferred) | mitigated: capture first enters camera view, sets the viewport lens to the production focal length and waits two frames; verified visually, no pixel-diff against a second render-camera pass yet |
| Focal length is not keyframed upstream                                                                               | M2 (see virtual-set.md)                                                                                                                                                                           |
| Euler (not quaternion) rotation                                                                                      | stored as Euler XYZ radians; M2 slerp for camera paths                                                                                                                                            |
| `mixamorig:*` bone names for FK posing                                                                               | not used in M1; the mannequin is a single merged mesh                                                                                                                                             |
| GLB only, no Draco/KTX2/Meshopt, external resources unsupported                                                      | M1 accepts plain GLBs from Prism's asset library; upload of `.glb` is not yet in the Assets UI (see Known gaps)                                                                                   |
| `@sparkjsdev/spark` pre-1.0                                                                                          | pinned by lockfile; not on any M1 code path at runtime                                                                                                                                            |
| Dormant `Water`/MMD code compiled in                                                                                 | unreachable from Prism UI; `Water` would fetch a texture from threejs.org if instantiated                                                                                                         |
| Bundle size (three + spark + postprocessing)                                                                         | the editor is `next/dynamic` with `ssr:false`, so it only loads on the 3D route                                                                                                                   |
| Upstream JSON format has only a `version` number                                                                     | wrapped in `prism.previs.v1`; the engine payload is opaque to the DB                                                                                                                              |
| Engine logs verbosely (`console.log/debug`)                                                                          | harmless; left unpatched to keep the diff small                                                                                                                                                   |

## 8. Licensing / provenance checklist

- [x] LICENSE-MIT, LICENSE-APACHE, NOTICE retained in the vendor directory
- [x] statement of changes (UPSTREAM.md + patch file)
- [x] trademark not used (feature is "3D Set")
- [x] no upstream asset copied; mannequin and Hotel Canopy set are procedural and Prism-authored
- [x] `THIRD_PARTY_NOTICES.md` updated
- [ ] `engine/TransformControls.js`, `CustomOutlinePass.js`: no header upstream; believed three.js-derived (MIT) — noted
      in THIRD_PARTY_NOTICES; confirm with upstream if redistribution outside this repo is planned

## 9. Update procedure

See `src/vendor/artcraft-scene-engine/UPSTREAM.md`.
