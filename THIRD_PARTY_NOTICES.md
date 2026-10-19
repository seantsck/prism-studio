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

- `engine/TransformControls.js` is a copy of **three.js** `examples/jsm/controls/TransformControls.js`
  (MIT, Copyright © 2010-2024 three.js authors, https://github.com/mrdoob/three.js) with one ArtCraft modification
  (a drag `sensitivity` multiplier). It matches that file as published in three r163/r164 apart from formatting and
  that change (token comparison; details in `src/vendor/artcraft-scene-engine/UPSTREAM.md`). The licence text is
  reproduced below and a header in the file points here.
- ArtCraft's outline post-processing (`CustomOutlinePass.js`, `FindSurfaces.js`) and chroma-key shader
  (`chromakey.js`, `shaders.js`) were **removed** from the vendored tree because their provenance could not be
  established from the files alone and Prism does not use them (their comments cite a social-media post, the third-party
  `webgl-outlines` project and a three.js forum post that itself cites a `libretro/glsl-shaders` routine). Nothing in this repository derives from them.

#### three.js (applies to `engine/TransformControls.js`)

```
The MIT License

Copyright © 2010-2024 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## npm packages added with the 3D set

| Package        | License | Why                                           |
| -------------- | ------- | --------------------------------------------- |
| `three`        | MIT     | Three.js renderer used by the vendored engine |
| `@types/three` | MIT     | typings (dev)                                 |
| `zustand`      | MIT     | the vendored engine's state store             |

| `mediabunny` | MPL-2.0 | local MP4/WebM encoding of previs renders (Phase 2F M2A), including the AAC/Opus performance-audio track (M2A.1). Used unmodified as an npm dependency and lazily imported; its source is not vendored. MPL-2.0 file-level terms apply to MediaBunny's own files only. |

## npm packages added with Gaussian-splat Locations (Phase 2F M2D.1)

| Package             | Version | License | Why                                                                                                                                                                                                                                                                          |
| ------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@sparkjsdev/spark` | 0.1.10  | MIT     | Gaussian-splat renderer for three.js (Copyright © 2025 World Labs Technologies, Inc., https://github.com/sparkjsdev/spark). Used unmodified as an npm dependency and lazily imported; its source is not vendored. It renders through Prism's existing `THREE.WebGLRenderer`. |
| `fflate`            | 0.8.3   | MIT     | gzip decompression to validate `.spz` files (Copyright © 2023 Arjun Barrett); also a dependency of Spark. Used on the server and in the browser for structural validation and to generate synthetic test splats.                                                             |

Since Phase 2F M2D.3A Spark is also used server-side (Node) by the local reconstruction engine: its `SpzWriter`
encodes the PLY → SPZ conversion and its `SpzReader` decodes in tests. Same package, same pinned version, unmodified.

Spark's published bundle inlines a few three.js routines (MIT, Copyright 2010-2025 three.js authors) and carries no
network URL on an executable path (the only URLs in the bundle are reference links in source comments). Spark 0.1.10
is the version the pinned ArtCraft commit used (`^0.1.10`); Spark 2.x requires a newer three.js than Prism pins.
No splat asset, demo scene or sample file from ArtCraft, Spark or any third party is included in this repository;
tests generate their Gaussian data programmatically.

## External tools for local reconstruction (Phase 2F M2D.3A): not distributed

Prism Studio does **not** include, bundle, download or install COLMAP or Brush. The operator installs them and Prism
invokes them as separate processes. They are supported external tooling, not Prism-distributed dependencies; their
licences are the operator's to observe:

- **COLMAP** 4.2.1 (https://github.com/colmap/colmap, new BSD for COLMAP itself; dependencies under their own
  licences, including LGPL-2.1+/GPL-2+ SuiteSparse components in the operator's build). Prism supports only a
  Prism-verified external build (operator-built, restricted-dependency CPU profile, provenance-verified); official prebuilt archives are not supported (they compile in SiftGPU, licensed for
  educational, research and non-profit use only, and AGPL-3.0 LSD). See `docs/local-reconstruction.md`.
- **Brush** v0.3.0 (https://github.com/ArthurBrussee/brush, Apache-2.0).
