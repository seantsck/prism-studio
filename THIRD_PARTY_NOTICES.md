# Third-party notices

Prism Studio includes or depends on the following material that is not original to this repository.
This file lists code that is **vendored or bundled**; ordinary npm dependencies are covered by their own
licenses in `package-lock.json`.

## ArtCraft scene-authoring core (vendored)

- **Location:** `src/vendor/artcraft-scene-engine/`
- **Source:** https://github.com/storytold/artcraft at commit `d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373`
- **License:** MIT OR Apache-2.0, at the licensee's option; Prism Studio elects the MIT License.
  Full texts: `src/vendor/artcraft-scene-engine/LICENSE-MIT` and `LICENSE-APACHE`; the upstream `NOTICE` is kept as
  `src/vendor/artcraft-scene-engine/NOTICE.upstream`.
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the ArtCraft contributors.
- **Modifications:** documented in `src/vendor/artcraft-scene-engine/UPSTREAM.md` and reproducible from
  `src/vendor/artcraft-scene-engine/patches/prism-vendor.patch` (Apache-2.0 §4(b) statement of changes).
- **Trademark:** the ArtCraft name, wordmark and logos are trademarks of the ArtCraft Team and are not licensed;
  they are not used here.
- **Not included:** any ArtCraft asset (models, textures, skyboxes, sound effects, fonts, videos, logos). The
  upstream `NOTICE` lists material it does not cover (e.g. sound effects, memes, third-party skybox packs, MMD
  motion data, Mixamo renders); none of it is in this repository.

### Material inside the vendored code with its own provenance

- `engine/TransformControls.js` and `engine/CustomOutlinePass.js` follow the structure of the
  three.js examples (`TransformControls`, outline post-processing). three.js is MIT licensed,
  Copyright © 2010-2026 three.js authors. The upstream files carry no header of their own; this notice preserves it.
- `viewer-3d/disposeObject3D.ts` interoperates with `@sparkjsdev/spark` (MIT).

## npm packages added with the 3D set

| Package             | License | Why                                                                                                 |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `three`             | MIT     | Three.js renderer used by the vendored engine                                                       |
| `@types/three`      | MIT     | typings (dev)                                                                                       |
| `zustand`           | MIT     | the vendored engine's state store                                                                   |
| `@sparkjsdev/spark` | MIT     | imported by the vendored scene/editor modules (Gaussian-splat support is not exposed in Prism's UI) |

`mediabunny` (MPL-2.0, used upstream only for video recording) is **not** added; it is deferred to the camera-path /
local previs video milestone.
