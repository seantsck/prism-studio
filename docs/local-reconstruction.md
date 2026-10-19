# Local reconstruction engine (Phase 2F M2D.3A)

Free, local reconstruction of a Location from photographs:

```
ordered photographs
  → run workspace (input/000001.jpg …)
  → COLMAP 4.2.1: CPU SIFT → exhaustive matching → incremental mapper → undistortion (PINHOLE)
  → Brush 0.3.0: Gaussian-splat training (Vulkan GPU)
  → production Gaussian PLY validation
  → PLY → SPZ v3 (Spark 0.1.10 SpzWriter)
  → SPZ validation (M2D.1 inspectSplat)
  → result: splat.spz + splat.ply + manifest.json
```

**Validation status.** Code validated: yes (against fake external tools). Real COLMAP build validated: **no**. Real
Brush training validated: **no**. Real hardware performance validated: **no**. M2D.3A is not production-validated;
the production acceptance gate for Local Capture requires at least one real reconstruction on supported hardware.

**Local means local.** The engine uploads nothing, calls no provider, ArtCraft, telemetry or model host, and
downloads, installs or builds nothing. The operator installs the tools; Prism detects, verifies and invokes them.
No binary, DLL, model or installer is in this repository.

M2D.3A is the engine and its library/CLI boundary only (`src/lib/reconstruction/local/`). It has no database,
storage or server-action code. Wiring it to `reconstruction_jobs` (a durable worker, claiming, progress,
cancellation, the existing atomic ingestion and the Location UI) is M2D.3B. Until then `local_capture` stays
unavailable in the web app, even on a machine whose toolchain is ready: a browser request must never start a
30-minute reconstruction.

## Supported tools

### COLMAP: 4.2.1, a Prism-verified external build

The only supported COLMAP is a **Prism-verified external COLMAP build**: built from source by the operator, at the
approved commit, with the restricted-dependency profile below, and accepted by Prism's provenance verifier. It is a
_restricted-dependency_ build, not a GPL-free one: it still links copyleft SuiteSparse components (see the table).
Prism invokes it as a separate process; Prism does not link COLMAP, embed its code, redistribute it or any of its
DLLs (including SuiteSparse and other GPL/LGPL libraries), or bundle a COLMAP installer.

|               |                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Source        | https://github.com/colmap/colmap, tag `4.2.1`, commit `bd1fcf654d2dd8fefa1466999c190a246f83f4b9` (2026-09-29)        |
| License       | COLMAP itself: new BSD. Its dependencies have their own licences (table below).                                      |
| Executable    | `bin\colmap.exe`, started directly with `shell: false` (never `COLMAP.bat`, which cannot be started without a shell) |
| Commands used | `feature_extractor`, `exhaustive_matcher`, `mapper`, `image_undistorter`; plus `version` / `help` for probing        |
| GPU           | none: CPU SIFT (VLFeat) and CPU matching                                                                             |

**Official prebuilt Windows archives are not supported for Prism Local Capture.** Both `colmap-x64-windows-cuda.zip`
and `colmap-x64-windows-nocuda.zip` compile in SiftGPU, whose licence permits use "for educational, research and
non-profit purposes" only, and LSD (AGPL-3.0), and enable CGAL. A runtime flag that disables GPU SIFT does not
remove the code from the binary. Prism therefore detects such a COLMAP, reports it as **unverified**, and never uses
it for Local Capture. There is no acknowledgement or waiver that changes this. This is an engineering policy, not
legal advice; supporting a prebuilt distribution would need a separate, explicit approval of that exact distribution.

#### Approved build profile

These option names were audited in COLMAP 4.2.1's `CMakeLists.txt` and `cmake/FindDependencies.cmake`. **This
profile comes from that source audit and has not yet been exercised by a real build in this project.**

| Option                               | Value     | Why                                                                        |
| ------------------------------------ | --------- | -------------------------------------------------------------------------- |
| `CUDA_ENABLED`                       | `OFF`     | defaults ON; with a CUDA toolkit present it compiles SiftGPU               |
| `HIP_ENABLED`                        | `OFF`     | no GPU code                                                                |
| `CASPAR_ENABLED`                     | `OFF`     | CUDA-only solver                                                           |
| `GUI_ENABLED`                        | `OFF`     | no Qt                                                                      |
| `OPENGL_ENABLED`                     | `OFF`     | OpenGL compiles SiftGPU                                                    |
| `MVS_ENABLED`                        | `OFF`     | no dense MVS; also drops CGAL linkage and PoissonRecon from the executable |
| `CGAL_ENABLED`                       | `OFF`     | CGAL has GPL/LGPL parts and is not needed                                  |
| `LSD_ENABLED`                        | `OFF`     | AGPL-3.0 line detector, not needed                                         |
| `ONNX_ENABLED`, `FETCH_ONNX`         | `OFF`     | learned features would download ONNX Runtime and models                    |
| `DOWNLOAD_ENABLED`                   | `OFF`     | no automatic resource download (vocabulary trees, models)                  |
| `TESTS_ENABLED`, `BENCHMARK_ENABLED` | `OFF`     | not needed                                                                 |
| `CMAKE_BUILD_TYPE`                   | `Release` |                                                                            |

Facts from the audit that matter when building (not validated by a build here):

- configure still looks for OpenGL and GLEW even with the GUI off (they are found, not linked), so GLEW must be
  installable;
- PoseLib and faiss are fetched at configure time by default (`FETCH_POSELIB`, `FETCH_FAISS`); pre-fetched sources
  can be supplied with `FETCHCONTENT_SOURCE_DIR_POSELIB` / `FETCHCONTENT_SOURCE_DIR_FAISS`;
- `COLMAP_HASH_MAP_BACKEND` may be STD or BOOST.

#### What remains linked (minimal profile, vcpkg baseline `127402f1`)

| Dependency                                                                        | Licence                         | Why                                                              | Concern                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| SuiteSparse CHOLMOD (Core, Cholesky, Utility, Partition)                          | LGPL-2.1+                       | COLMAP's own `Eigen::CholmodSupernodalLLT` (required, no switch) | copyleft: permits local commercial use; obligations only on redistribution     |
| SuiteSparse CHOLMOD MatrixOps / Supernodal, SPQR                                  | GPL-2+                          | pulled by COLMAP's stock manifest (`ceres[suitesparse]`)         | copyleft: as above; avoidable only with a patched manifest (below)             |
| SuiteSparse_config, AMD, CAMD, COLAMD, CCOLAMD                                    | BSD-3                           | CHOLMOD                                                          | none                                                                           |
| Ceres Solver 2.2.0                                                                | BSD-3                           | bundle adjustment                                                | none                                                                           |
| OpenBLAS / LAPACK (reference)                                                     | BSD-3 / BSD-3-Open-MPI          | SuiteSparse, faiss                                               | the Windows LAPACK build ships GCC runtime DLLs (GPL-3 with runtime exception) |
| Eigen 5.0.1                                                                       | MPL-2.0                         | maths (header-only)                                              | none                                                                           |
| glog / gflags                                                                     | BSD-3                           | logging                                                          | none                                                                           |
| Boost (graph, program_options, …)                                                 | BSL-1.0                         | CLI, graphs                                                      | none                                                                           |
| SQLite 3                                                                          | public domain                   | feature database                                                 | none                                                                           |
| OpenImageIO 3.1 (+ libjpeg-turbo, libpng, libtiff, zlib, OpenEXR, OpenColorIO, …) | Apache-2.0 and permissive       | image I/O                                                        | none                                                                           |
| METIS / GKlib                                                                     | Apache-2.0                      | ordering                                                         | none                                                                           |
| faiss 1.14.1 (static)                                                             | MIT                             | nearest-neighbour search                                         | none                                                                           |
| PoseLib (static)                                                                  | BSD-3                           | minimal solvers                                                  | none                                                                           |
| VLFeat (static, bundled)                                                          | BSD-2                           | CPU SIFT                                                         | none                                                                           |
| OpenMP (MSVC `vcomp140.dll`)                                                      | Microsoft redistributable terms | required                                                         | none                                                                           |

Not compiled or linked in this profile: SiftGPU, LSD, CGAL/GMP/MPFR, Qt, ONNX Runtime, CUDA, curl/OpenSSL, the MVS
library, PoissonRecon (built but linked only by MVS).

**Copyleft policy.** The profile cannot remove CHOLMOD (LGPL-2.1+); COLMAP's stock manifest also brings GPL-2+
SuiteSparse modules, so the verified build **contains copyleft components installed by the operator**. Prism's
engineering position is that these licences attach their obligations to redistribution, and Prism does not
redistribute them: the operator builds and installs COLMAP, Prism runs it as a separate process, and Prism's own
code never links it. The verifier records these components in the provenance manifest (`copyleftComponents`)
rather than hiding them. A variant without the GPL-2+ modules exists in principle (patch COLMAP's `vcpkg.json` to
build Ceres with `eigensparse` and `suitesparse-cholmod` without default features; LGPL CHOLMOD would remain), but
it changes the source tree, has not been tried, and is not a supported profile today.

**If Prism ever begins redistributing COLMAP or any of its DLLs** (bundling, an installer, a download, a container
image), this licensing position no longer applies and must be reviewed again before that ships. None of this is
legal advice.

#### Provenance: verify the build, do not trust a text file

A COLMAP executable cannot say how it was built (its version line reports only CUDA/HIP). After building, the
operator runs the local verifier once:

```
npm run local:verify-colmap -- --source <colmap checkout> --build <cmake build dir> --exe <colmap.exe> --out <manifest.json>
```

It runs only the given `colmap.exe` and `git status`, and writes `prism.local-tool.colmap.v1` **only if every check
passes**:

| Check                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| approved source             | `.git` HEAD is `bd1fcf6…` and `git status` shows no modification                                                                                                                                                                                                                                                                                                                            |
| approved options            | every option above is explicitly `OFF`/`Release` in `CMakeCache.txt` (absent counts as a failure); no `CGAL_DIR`/`Qt*_DIR`/`onnxruntime_DIR` found                                                                                                                                                                                                                                          |
| what is compiled and linked | the generator's build description (`build.ninja`, or `colmap_main.vcxproj`) references none of SiftGPU, `colmap_lsd`, `colmap_mvs`, `colmap_ui`, CGAL, Qt, ONNX Runtime, cudart, and defines none of `COLMAP_GPU_ENABLED`, `COLMAP_LSD_ENABLED`, `COLMAP_CGAL_ENABLED`, `COLMAP_CUDA_ENABLED`, `COLMAP_ONNX_ENABLED`, `COLMAP_MVS_ENABLED`, `COLMAP_GUI_ENABLED`, `COLMAP_DOWNLOAD_ENABLED` |
| installed dependencies      | `vcpkg_installed/vcpkg/status` holds no CGAL, GMP, MPFR, Qt, ONNX Runtime or CUDA package; all packages and features are recorded                                                                                                                                                                                                                                                           |
| the binary itself           | `colmap version` reports 4.2.1 and commit `bd1fcf6`; `colmap help` lists no `patch_match_stereo`/`stereo_fusion`; `feature_extractor --FeatureExtraction.use_gpu 1` is refused with COLMAP's own "Cannot use GPU feature extraction without CUDA or OpenGL support" (direct evidence that no GPU SIFT is compiled in)                                                                       |
| identity                    | sha256 and size of `colmap.exe`, and sha256 of every DLL next to it                                                                                                                                                                                                                                                                                                                         |

The manifest holds no absolute paths and no secrets. It **proves** the items above for the hashed files. It **does
not prove** anything about the compiler, about defects in the vcpkg-built libraries, or about files it did not
hash.

At run time the toolchain probe re-checks the executable against the manifest:

| State          | Meaning                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verified`     | version 4.2.1, a manifest naming the approved commit and profile, and current hashes of `colmap.exe` and its DLLs equal the manifest's                                                                                       |
| `unverified`   | installed, but no manifest, an unreadable manifest, or any hash mismatch (an official archive, a rebuild, a PATH binary). Reported as: _"COLMAP is installed but this build has not been verified for Prism Local Capture."_ |
| `incompatible` | another version, or a manifest for another commit or an unapproved profile; also a configured `.bat`/relative path                                                                                                           |
| `missing`      | not configured and not on PATH                                                                                                                                                                                               |

Only `verified` can make the toolchain ready. A PATH-found COLMAP is reported for diagnosis and stays unverified.

### Brush: v0.3.0

|                |                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source         | https://github.com/ArthurBrussee/brush, tag `v0.3.0`, commit `3edecbb2fe79d3e2c87eeab85b15e0b1dd10d486` (2025-09-14)                                                                              |
| License        | Apache-2.0 (dependencies restricted to permissive licences by the project's `deny.toml`)                                                                                                          |
| Executable     | `brush_app.exe` (Windows release asset `brush-app-x86_64-pc-windows-msvc.zip`)                                                                                                                    |
| GPU            | wgpu with the **Vulkan** backend on Windows and Linux (no CUDA, no DX12). A Vulkan-capable GPU and driver are required; with no adapter Brush exits with code 101, reported as `gpu_unavailable`. |
| Version policy | 0.3.x only (unreleased `main` changes CLI defaults); others are refused, not guessed                                                                                                              |

Brush is checked by version: its Apache-2.0 licence does not raise the provenance question COLMAP's archives do.

**Input bridge.** Brush reads a COLMAP workspace directly but ignores lens distortion, so it is always given COLMAP's
**undistorted** output (`image_undistorter --output_type COLMAP`: PINHOLE cameras, `images/`, `sparse/`). Brush scans
its dataset recursively, takes the first `cameras.bin` it finds, would use any single `.ply` as its initial point
cloud and asserts on case-colliding paths, so the engine verifies that the dataset holds exactly one model, an
`images/` folder and no `.ply`/`transforms.json`, and writes exports outside it.

**Training profile.** Only `standard` is defined (`draft` and `high` are refused until validated):

| Brush option                      | Value                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `--total-steps`                   | 30000 (Brush's documented default)                                                          |
| `--max-splats`                    | 1000000 (Brush defaults to 10 M; Prism caps lower so the SPZ can fit the 50 MB splat limit) |
| `--sh-degree`                     | 3                                                                                           |
| `--seed`                          | 42                                                                                          |
| `--export-every`                  | 30000 (one export, at the end)                                                              |
| `--export-path` / `--export-name` | absolute `brush/exports/`, `prism_export_{iter}.ply`                                        |

Brush runs headless (its default once a dataset path is given) with `RUST_LOG=info`; its `Refine iter N` lines give
the exact training iteration. Exit code 0 is not trusted (a failed export is only a warning in Brush): the expected
PLY must exist and pass the production PLY reader.

## Configuration

| Variable                                         | Meaning                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRISM_COLMAP_PATH`                              | absolute path of the verified `colmap.exe` (else PATH is searched, for diagnosis only)                                                                      |
| `PRISM_COLMAP_PROVENANCE_PATH`                   | absolute path of its `prism.local-tool.colmap.v1` manifest                                                                                                  |
| `PRISM_BRUSH_PATH`                               | absolute path of `brush_app.exe` (else PATH is searched)                                                                                                    |
| `PRISM_LOCAL_RECONSTRUCTION_ROOT`                | absolute work root (default: `%LOCALAPPDATA%\PrismStudio\local-reconstruction` on Windows, the user cache directory elsewhere); never inside the repository |
| `PRISM_LOCAL_RECONSTRUCTION_MAX_IMAGES`          | photographs per run (default and ceiling 300; minimum 3)                                                                                                    |
| `PRISM_LOCAL_RECONSTRUCTION_MAX_INPUT_BYTES`     | total input bytes (default 4 GiB; 64 MiB per photograph)                                                                                                    |
| `PRISM_LOCAL_RECONSTRUCTION_MAX_RUN_MS`          | whole-run limit (default 4 h; camera stage ≤ 2 h, training ≤ 3 h)                                                                                           |
| `PRISM_LOCAL_RECONSTRUCTION_MAX_WORKSPACE_BYTES` | disk used by one run (default 40 GiB, checked after each tool)                                                                                              |

Path resolution accepts only absolute paths; PATH entries that are relative (`.`, `bin`) are skipped, so a
similarly named program in the current directory is never run; on Windows only `.exe` is accepted.

## The run

`runLocalReconstruction(request, { toolchain, workRoot, onProgress, signal })`
(`src/lib/reconstruction/local/engine.ts`). The toolchain comes from `probeLocalToolchain()` and must be `ready`.

| Stage                   | Work                                                                                       | Progress weight                                             |
| ----------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `preparing`             | copy photographs into `input/` as `000001.<ext>`… (byte-for-byte, sha256 in the same pass) | 0.02                                                        |
| `camera_reconstruction` | COLMAP's four commands; validate each output                                               | 0.28                                                        |
| `splat_training`        | Brush                                                                                      | 0.60 (in-stage progress from Brush's exact iteration count) |
| `validating_ply`        | production PLY reader over the whole file                                                  | 0.03                                                        |
| `converting_spz`        | PLY → SPZ                                                                                  | 0.04                                                        |
| `validating_spz`        | `inspectSplat` on the written file                                                         | 0.03                                                        |
| `complete`              |                                                                                            |                                                             |

Progress is reported at stage boundaries (and per training iteration); it is never inferred from noisy logs.

**Workspace.** `<work root>/<runId>/{input,colmap,brush,output,logs}/` plus `manifest.json`. The run id is a safe
identifier; a fresh directory is required; every path is checked to stay inside it, symlinks included.

**Camera reconstruction is validated, not assumed.** `feature_extractor` must produce its database (it exits 0 even
when it extracted nothing); the mapper's models are read from COLMAP's binary format; the chosen model is the one
with the most registered images, then the most 3D points (never "directory 0" by default), and all models found are
recorded. Every registered image must be one of the run's own inputs, each at most once. Fewer than 3 registered
images, under 40 % of the photographs, or under 50 sparse points is `insufficient_camera_registration`. The
undistorted model must be PINHOLE and contain every registered image, all written to disk.

The database itself is only checked to exist and be non-empty (its SQLite contents are not read; Prism has no
SQLite dependency). That is a diagnostic weakness, not a correctness hole: an empty or bogus database cannot reach
success, because success requires a readable sparse model that passes every check above and an undistorted
dataset that matches it. It only means such a failure is reported at the mapper stage rather than at extraction.

**Errors** are normalized: `toolchain_missing, unsupported_version, invalid_inputs, workspace_failed, colmap_failed,
insufficient_camera_registration, brush_failed, gpu_unavailable, out_of_memory, cancelled, timeout, ply_missing,
ply_invalid, spz_conversion_failed, spz_invalid, result_too_large`, each with its stage and a bounded,
path-redacted diagnostic (never a full tool log).

**Cancellation** (an `AbortSignal`) stops the running tool (its whole process tree on Windows: polite stop, then
forced after a grace period), stops further stages, and a cancellation that wins the race is never reported as
success. **Retention:** success keeps `output/`, `logs/` and `manifest.json` for ingestion; a failure keeps the
bounded logs and a failure manifest; a cancellation or failure removes intermediates and any partial output;
`cleanupWorkspace` removes a run explicitly. Source Prism Assets are never touched (the workspace holds copies).

**Logs** (`logs/run.log`): timestamp, stage, tool, one line each, capped at 2 MB.

**Manifest** (`prism.local-reconstruction-run.v1`): run id, status, timestamps, ordered inputs (ordinal, file
name, MIME, size, sha256), tool versions (COLMAP, Brush, SPZ encoder), quality profile, COLMAP settings and metrics,
Brush settings, PLY and SPZ facts with checksums, or the error. Relative names only: no source path, URL or key.

## Gaussian PLY validation

`src/lib/reconstruction/local/ply.ts`: binary little-endian only (ASCII and big-endian refused); exactly one `vertex`
element; properties found by name (Brush writes them in alphabetical order); required `x y z f_dc_0..2 opacity
scale_0..2 rot_0..3` as float or double; `f_rest_*` contiguous with 0/9/24/45 values (SH degree 0-3); other scalar
properties skipped; the file size must equal header + count × stride; every essential value finite; zero-length
quaternions refused; at most 8 M Gaussians. Records are read in chunks through one reused buffer, so a large PLY is
never held in memory. The inspection reports the Gaussian count, SH degree, bounding box, extent, attribute map,
stride and size.

## PLY → SPZ

`src/lib/reconstruction/local/spz.ts` uses **`SpzWriter` from `@sparkjsdev/spark` 0.1.10 (MIT)**, the same pinned
package whose `SpzReader` Prism's runtime loads splats with, so the encoder and the renderer agree by construction.
Niantic's reference library (MIT) now writes SPZ v4 (zstd) and has no npm package; Prism does not need it.

| Attribute | PLY (3DGS)              | SPZ v3                                                                   | Fidelity                                                                                                                            |
| --------- | ----------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| position  | float                   | 24-bit fixed point; fractional bits chosen from the scene extent (≤ 12)  | quantized; a scene too large for 24 bits is **refused**, never wrapped or clipped                                                   |
| opacity   | logit                   | sigmoid, 8 bits                                                          | quantized                                                                                                                           |
| colour    | `f_dc`                  | 0.5 + SH_C0·f_dc, 8 bits over a fixed range                              | quantized; out-of-range values clamped by the format and counted                                                                    |
| scale     | log                     | 8-bit log over [-10, ~6)                                                 | quantized; out-of-range clamped and counted                                                                                         |
| rotation  | (w,x,y,z), any length   | normalized, "smallest three" 32 bits                                     | quantized (worst-case orientation error measured below 0.01 rad)                                                                    |
| SH        | `f_rest`, channel-major | per Gaussian, coefficient-major; 5 bits (degree 1), 4 bits (degrees 2-3) | **every degree is kept** unless an explicit setting lowers it (recorded as `shReduced`); values outside [-1, 1) clamped and counted |

SPZ is quantized compression and is never called lossless (`lossless: false`). Coordinates are written as the PLY
has them (no axis conversion, like Spark's own transcoder), so the SPZ renders in Prism exactly like the PLY.
Memory is bounded: `SpzWriter` builds the uncompressed body in one buffer (16 + n × (20 + SH bytes)), refused above
256 MB (`result_too_large`) before allocation; gzip output is streamed to disk. **Size:** an SPZ over Prism's 50 MB
splat limit is `result_too_large`; nothing is decimated and the global limit is unchanged. The result is then
validated twice: the PLY by the production reader, the SPZ by M2D.1's `inspectSplat`.

## Security

No shell, ever (`spawn` with `shell: false` and an argv array); absolute executables only; a minimal allow-listed
environment (no secrets reach a tool); bounded output capture; original file names never used as paths or
arguments; every tool argument comes from a fixed allow-list (the quality profile maps to fixed values; no option
is taken from a user); Brush is only ever given a local directory (it also accepts URLs); COLMAP is only ever given
commands that cannot download.

## M2D.3B integration contract

The worker will: claim a queued `local_capture` job with the existing compare-and-set (`queued → submitting`);
probe the toolchain (`ready`, COLMAP `verified`); read the job's ordered sources from private storage (by value,
checksums verified); call `runLocalReconstruction` with the job attempt as the run id and an `AbortSignal` tied to
the job's cancellation; map stage progress into the job's progress; on success hand `splat.spz` (with its checksum
and the run metadata as generation provenance) to the existing atomic ingestion; map engine error codes to job
error codes; and clean the workspace after ingestion. Closing the browser is not part of this contract.

## Tests (no GPU, no real tool, no network)

Fake `colmap.exe`, `brush_app.exe` and `git` are Node scripts run as real child processes through the same runner;
the fake COLMAP writes COLMAP's real binary model format. Only the external tools are fake: the PLY reader, the SPZ
converter and `inspectSplat` are the production code. Test fixtures (Gaussian PLYs up to ~24 MB) are generated at
test time.

| What                                                                                                                                                                                                       | Where                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| process runner, workspace, input materialization                                                                                                                                                           | `local/__tests__/process-workspace.test.ts` |
| PLY reader, PLY → SPZ round trip through Spark's `SpzReader`, range, quaternions, SH, size and memory bounds                                                                                               | `local/__tests__/ply-spz.test.ts`           |
| COLMAP build provenance verifier and run-time policy                                                                                                                                                       | `local/__tests__/colmap-provenance.test.ts` |
| COLMAP commands, model selection, registration thresholds, failures, cancellation                                                                                                                          | `local/__tests__/colmap.test.ts`            |
| Brush commands, dataset guards, failure normalization                                                                                                                                                      | `local/__tests__/brush.test.ts`             |
| toolchain probe and the end-to-end engine (synthetic photos → fake COLMAP → fake Brush → real PLY parser → real SPZ converter → `inspectSplat` → Spark `SpzReader`), cancellation at each stage, retention | `local/__tests__/engine.test.ts`            |

## Known gaps

- **No real COLMAP or Brush reconstruction has been run.** Code validated: yes; real COLMAP build, real Brush
  training and real hardware performance validated: no. A real-tool reconstruction on supported hardware is the
  production acceptance gate for Local Capture.
- The approved COLMAP profile and the Brush contract come from source audits (COLMAP 4.2.1, Brush v0.3.0) and are
  exercised against faithful fakes.
- The COLMAP database is checked for existence only (see "Camera reconstruction is validated"): diagnostic, not
  correctness.
- Only the `standard` profile exists; `draft`/`high` need validation on real scenes.
- No video input (FFmpeg licensing/packaging is a separate decision).
- Rendering the produced SPZ in a browser frame is not part of the automated tests; the SPZ is decoded by Spark's own
  `SpzReader` and accepted by `inspectSplat`, the gate the runtime loader uses.
- The worker, job integration and UI are M2D.3B.
