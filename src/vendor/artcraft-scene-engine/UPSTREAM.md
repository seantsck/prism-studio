# artcraft-scene-engine — upstream provenance

| | |
| --- | --- |
| Repository | https://github.com/storytold/artcraft |
| Pinned commit | `d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373` (never a floating branch) |
| License | MIT OR Apache-2.0, at the licensee's option. Prism elects **MIT**. `LICENSE-MIT`, `LICENSE-APACHE` and upstream `NOTICE` (as `NOTICE.upstream`) are kept in this directory. |
| Copyright | © 2026 ArtCraft Team and the ArtCraft contributors |
| Trademark | The ArtCraft name, wordmark and logos are **not** covered by the license and are not used. Prism calls the feature "3D Set". |
| Taken from | `frontend/libs/components/pagescene/src/lib/` and `frontend/libs/components/viewer-3d/src/lib/disposeObject3D.ts` |

This is **code only**. No ArtCraft application, UI kit, API client, account/credit code, Tauri host or Rust crate
is included, and the engine makes **no** request to any ArtCraft service.

## What was imported

| Upstream path | Vendored as | Notes |
| --- | --- | --- |
| `engine/**` | `engine/**` | scene graph, editor, camera controller, gizmos, selection, history, timeline model, FK helpers, save/load |
| `proxy/**` | `proxy/**` | scene JSON (de)serialisation |
| `enums/**`, `datastructures/common.ts`, `models/sceneGenerationMetadata.ts` | same | |
| `PageSceneStore.ts`, `sceneMetadata.ts` | same | the engine's zustand store (a module singleton) |
| `adapter.ts` | `adapter.ts` | **replaced** by a 5-method boundary (see patches) |
| `actions/{addObject,addCharacter,addShape,deleteObject,selectObject,setTransformMode,setCameraAspect,setObjectColor,toggleObjectLock,toggleObjectVisibility,cameraView,transformObject}.ts` | `actions/` | |
| `hooks/{useFreeCam,useViewportPointer}.ts` | `hooks/` | |
| `viewer-3d/.../disposeObject3D.ts` | `viewer-3d/disposeObject3D.ts` | GPU resource disposal |

Approximately 12.3k lines in 91 files (TypeScript/JS, including Prism shims and declarations). The M1 hardening pass
removed ~1k lines of code Prism never reaches (see "Removed after the first import" below).

## What was excluded

- All UI components (`comps/**`, `Stage3D*.tsx`), the asset menu and demo-asset lists, scene library, generation
  prompt box, pricing, help — and every `@storyteller/*` workspace package they use.
- Assets: skyboxes, sound effects (Nintendo SFX), memes, MMD motion data, Mixamo GIFs, avatars, characters, logos,
  fonts, videos, `ammo.wasm`. **No upstream asset of any kind is in this repository.**
- `engine/entrance*` (Spark "dyno" polish effect; stubbed), `engine/ammoLoader.ts` (MMD physics blob),
  `engine/recording/TimelineRecorder.ts` (needs `mediabunny`, MPL-2.0, M2), `engine/keymap.ts` and
  `hooks/useViewportKeyboard.ts` (need `@storyteller/keybinds`), the legacy `engine/EditorState/**`, all `*.spec.ts`.

## Prism patches

All edits are in [`patches/prism-vendor.patch`](./patches/prism-vendor.patch) (a `diff -ruN` against the pinned
commit, line endings normalised to LF). Summary:

1. **Boundary**: `adapter.ts` reduced to the members the engine really calls (`fetchAsset`, `getMediaUrlByToken`,
   `getMediaUrlsByTokens?`, `saveScene`, `loadScene`, optional title/owner hooks). `shims/common.ts`,
   `shims/toast.ts`, `shims/ui-viewer-3d.ts` replace `@storyteller/common`, `react-hot-toast`, `@storyteller/ui-viewer-3d`.
2. **2.39:1 production frame**: `CameraAspectRatio.HORIZONTAL_2_39_1` added to the enum, `getRenderDimensions` and
   `snapShotOfCurrentFrame` (1912×800). Upstream only knew 16:9, 3:2, 1:1, 2:3, 9:16.
3. **Procedural shapes**: `shims/shape-factory.ts` + a hook in `Scene.instantiate` so Prism registers a Plane and a
   neutral Mannequin from outside the vendor tree.
4. **Host userData round-trip**: keys prefixed `prism` (character blocking, asset checksums) survive a save/load.
5. **No-asset stubs**: `ammoLoader`, `entranceAnimation` are no-op stubs; the loading-text placeholder no longer
   fetches a font (`placeholder_manager.ts`).
6. **Free-cam keys**: fixed defaults instead of the keybind registry (`hooks/useFreeCam.ts`).
7. **Typing only**: a `.d.ts` for the one remaining JS module (`TransformControls.js`) and `// @ts-nocheck` on the files compiled against
   looser three typings upstream. Behaviour is unchanged.
8. **Isolated production render camera**: `Editor.snapShotOfCurrentFrame(download, cameraOverride?)` renders through
   a caller-supplied camera (the selection pass is pointed at it for that render only), so a master frame never
   reads or mutates the viewport/navigation camera. `SelectionOutlinePass` gained `getCamera/setCamera`.
9. **No second renderer**: the upstream "raw" `WebGLRenderer` + composer (a second WebGL context) is not created;
   `renderScene()` no longer waits on it.
10. **Unsupported media types fail loudly**: `.pmd/.pmx` (MMD), `.spz` (splat) and `.mp4` video planes throw
    "not supported" instead of loading.
11. **Snapshot output size (M2A)**: `snapShotOfCurrentFrame(download, camera?, size?)` accepts an explicit output size so
    local previs frames can render below the full production frame through the same isolated camera.
12. **`TransformControls.js` header**: provenance and the three.js MIT notice were added (see below).
13. **FK pose hooks (M2B)**: `shims/fk-hooks.ts` (new) lets the host observe and constrain the FK helper;
    `FKHelper` calls the hooks, moves its bone spheres and skeleton lines to the editor-only layer 1, gains
    `selectBone/getSelectedBone/setSkeletonVisible/setGizmoVisible`, drops its debug logging and now disposes its sphere
    materials and skeleton helper. `keybinds_controls.ts` exposes `kinMode`/`fkHelper` (were `private`).
    Diff: [`patches/prism-m2b.patch`](./patches/prism-m2b.patch).
14. **Host-owned Gaussian splats (M2D.1)**: `PageSceneAdapter.loadSplat?` (new optional member) is threaded through
    `Editor` into `SceneDeps`; `Scene.loadObject` asks it first and falls through to the model loader when it returns
    `null`, and the upstream `.spz` URL-sniffing branch (which threw) now states that splats are loaded by the host only.
    `disposeObject3D` calls `dispose()` on any object that sets `isPrismSplat === true`. The engine still bundles **no**
    splat runtime: `@sparkjsdev/spark` 0.1.10 (MIT) is a Prism npm dependency used only from `src/lib/previs/splat-runtime.ts`
    on the editor's existing renderer. No upstream splat loader, selection helper or entrance effect was re-imported.
    Diff: [`patches/prism-m2d1.patch`](./patches/prism-m2d1.patch) (4 files, +38/-2).

## Removed after the first import (M1 hardening)

| Removed | Why it was safe |
| --- | --- |
| `Water` primitive (`scene.ts`, `Water` import, `shader_objects` registry now always empty) | fetched `https://threejs.org/examples/textures/waternormals.jpg` when instantiated; no Prism UI or document can create one |
| MMD loader, animation helper, Ammo bootstrap (`scene.ts`) | anime-character path; needed a wasm blob that was never vendored |
| `engine/CustomOutlinePass.js`, `engine/FindSurfaces.js` and the "raw" composer in `PostProcessingPipeline.ts` | only fed the removed raw render path; the live outline is `SelectionOutlinePass` (upstream-written). Also removes a file with no establishable provenance |
| `engine/chromakey.js`, `engine/shaders.js`, the video-plane branch of `Scene.instantiate` | forum-sourced chroma-key shader whose conversion routine cites a `libretro/glsl-shaders` file (licence not established); video planes are not a Prism feature |
| Spark splats: `SplatMesh` loader (`scene.ts`), `instanceof SplatMesh` (`SelectionOutlinePass.ts`), `SparkRenderer`/`SplatMesh` disposal (`disposeObject3D.ts`), the `SparkRenderer` field (`editor.ts`) | splats were not exposed in M1, so the dependency was dropped. **M2D.1 reintroduced Spark as a Prism-owned dependency behind the `loadSplat` hook (patch 14); none of this removed upstream code came back** |
| second `THREE.WebGLRenderer` (`rawRenderer`) | only fed the removed raw composer; one WebGL context per mount instead of two |

What remains compiled but unused on Prism's paths: the `Image::` plane branch (png/jpg textures; the URL is always
the adapter-resolved `/api/assets/<id>`), the timeline/keyframe model and FK helpers (M2 basis), and
`InfiniteGridHelper`. The three.js addon `three/examples/jsm/libs/stats.module.js` is imported by `editor.ts`
(FPS counter, never attached to the DOM by Prism). Nothing in the vendor tree contains a remote URL on an executable
path; `placeholder_manager.ts` and `scene.ts` request only same-origin `/resources/…` paths for skyboxes and are covered
by the e2e "same-origin requests, none missing" test.

## Third-party code inside the vendor tree

- `engine/TransformControls.js` — **three.js** `examples/jsm/controls/TransformControls.js`, MIT,
  Copyright © 2010-2024 three.js authors, https://github.com/mrdoob/three.js. Established by token comparison
  (comments, whitespace, quote style, semicolons and trailing commas normalised) of the vendored file against the file
  as published in the `three` npm package for r140–r181: r163 and r164 differ by 45 tokens out of ~8 500, r162 and
  r165–r168 by 45–48, r158–r160 by 96, r140–r155 by 309–409, r169 by 626, r170–r181 by 1 150–1 381. The 45 differing tokens are formatter parentheses and
  one ArtCraft addition (a `sensitivity` multiplier on the drag delta, two sites). Closest releases: **three r163 /
  r164** (identical in this file). The upstream ArtCraft repository's history for the file begins at its "fresh start"
  commit, so no further origin is recorded there. three.js's examples carry no per-file header; the licence is the
  repository's MIT `LICENSE`, reproduced in `THIRD_PARTY_NOTICES.md`.
- `engine/SelectionOutlinePass.ts` — written by ArtCraft (its own header comment says so); depends on three.js
  addons `EffectComposer`/`Pass`/`FullScreenQuad` (MIT, npm dependency).

## Dependency edges that remain

`three`, `zustand`. Addons imported: `controls/{OrbitControls,PointerLockControls}`, `geometries/TextGeometry`,
`loaders/GLTFLoader`, `postprocessing/{EffectComposer,OutputPass,Pass,RenderPass}`,
`examples/jsm/Addons.js` (barrel; `keybinds_controls.ts` for the same two controls), `FontLoader`, `libs/stats.module`.

## Prism-written code (outside this directory)

`src/lib/previs/` (scene adapter, shapes, procedural humanoid rig, blocking overlay, `splat-runtime.ts`), `src/lib/splat/` (format inspection, synthetic test splats), `src/domain/previs/` (schema, fingerprint, camera maths, spatial
reference, rig/pose/blocking), `src/data/previs-*.ts`, `src/server/previs*.ts`, `src/components/previs/`, migration `0030`.
Nothing outside `src/lib/previs/scene-adapter.ts`, `src/lib/previs/blocking-overlay.ts` and the vendored hooks imports from this directory.

## Update procedure

1. `git fetch` the new upstream SHA into a scratch clone (never into this repo). Verify `LICENSE-*`, `NOTICE` and the
   README license section are unchanged in substance.
2. Re-export the same path list at the new SHA; normalise line endings to LF.
3. Re-apply `patches/prism-vendor.patch` from this directory (`patch -p1 --dry-run < patches/prism-vendor.patch`
   against a tree laid out like the vendored one, containing the upstream versions of every file listed in the patch).
   Resolve rejects by hand and regenerate the patch (`diff -ruN --strip-trailing-cr a b` between the LF-normalised
   upstream export `a` and this tree `b`, excluding `patches`, `UPSTREAM.md`, licences).
4. Bump `PREVIS_UPSTREAM_COMMIT` in `src/domain/previs/types.ts`. Stored documents keep the commit they were saved with.
5. Run `npm run typecheck`, `npx vitest run src/domain/previs`, `npm run db:previs`, and the 3D e2e
   (`e2e/zzzzz-previs.spec.ts`, `e2e/supabase-previs.spec.ts`). The engine's JSON format is versioned only by a
   `version` number: add a fixture round-trip for any format change before merging.
