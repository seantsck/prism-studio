# Real reconstruction acceptance (M2D.3D)

M2D.3A–M2D.3C built and proved the reconstruction **orchestration** with fake external tools. M2D.3D is
**acceptance**: proving that real photographs, run through the real COLMAP and Brush, produce a useful 3D
filmmaking environment in Prism. The architecture does not change in M2D.3D.

- **M2D.3D1 (this document's tooling):** readiness checks, the hardware audit and policy, the REAL_SMOKE and
  REAL_ROOM harness, the acceptance report, the human checklist, the Spark render check, and the hosted-security
  prerequisites. No real tool has been run.
- **M2D.3D2:** the first real run. Verified native tools, then real room photographs, real COLMAP, real Brush and a
  real SPZ. Then a Spark render, a Prism Location, and human filmmaking acceptance.

> **Local Capture is not production-ready until all three gates below pass.** Passing tests prove the code, not
> the product.

**Status today: PRODUCTION READY: NO.** Gate A is NOT PASSED (the relay secret is not provisioned, edge rate
limiting is not configured, and no infrastructure logging target exists). Gate B is NOT PASSED (no verified real COLMAP,
no Brush, no real GPU smoke run). Gate C is NOT PASSED (no room has been reconstructed). No real COLMAP or Brush run has
occurred.

## The three production gates

| Gate                       | Passes when                                                                                                                                                                                            | Who decides                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **A. Hosted security**     | The dedicated relay Storage key is configured on the Prism server; ingress rate limiting is in place on `/api/local-agent/v1/*`; infrastructure access logs do not keep lease ids (§ Hosted security). | The operator. The application cannot see its own edge, so the readiness check never reports A as PASS. |
| **B. Real toolchain**      | A Prism-verified COLMAP 4.2.1 build, Brush 0.3.0, an enumerated hardware Vulkan GPU, and the toolchain probe READY.                                                                                    | `npm run local:acceptance:check`; REAL_SMOKE proves that Brush actually runs.                          |
| **C. Real reconstruction** | Real photographs go through real COLMAP and real Brush to a real SPZ. Prism imports and renders it, and a person judges it useful for filmmaking (**PASS** or **PASS WITH LIMITATIONS**).              | The human review (`npm run local:acceptance:verdict`).                                                 |

## Modes

| Mode         | What runs                                                                                                                                          | Where                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `FAKE`       | The real engine with the M2D.3A **fake** COLMAP and Brush (real child processes; production PLY/SPZ code).                                         | Automated tests only.                                                             |
| `REAL_SMOKE` | The **real** tools on a tiny dataset: 12 synthetic views, or a tiny real photo set with `--input`. Brush trains a 500-step `acceptance_smoke` run. | An operator, on purpose (`--real`).                                               |
| `REAL_ROOM`  | The **real** tools on a human-chosen room photo set with the `standard` profile.                                                                   | An operator, on purpose (`--real`). Done in M2D.3D2 only, on a PRACTICAL machine. |

REAL commands refuse to start without `--real`, and refuse inside automated tests (`NODE_ENV=test` or `VITEST`). They
run only from the CLI: the web app and the Local Agent never import the acceptance tooling (a source test proves it).
They make **0 network provider calls, 0 paid calls and 0 uploads**. They do not call World Labs, ArtCraft, fal.ai,
Meshy, OpenAI, Gemini or Runway, need no provider key, and need no Supabase. Before anything runs they print:

- the exact executables they will start (no shell)
- the input count
- the output directory

## Commands

```
npm run local:acceptance:check   [-- --profile <name>] [--diagnostic] [--json]
npm run local:acceptance:smoke   -- --real [--output <abs dir>] [--input <abs tiny photo dir>]
                                    [--keep-intermediates] [--no-render] [tool flags]
npm run local:acceptance:room    -- --real --input <abs photo dir> --output <abs new dir>
                                    [--keep-intermediates] [--no-render] [--accept-hardware-risk] [tool flags]
npm run local:acceptance:render  -- --output <abs run dir>
npm run local:acceptance:verdict -- --output <abs run dir>

tool flags: --colmap <abs colmap.exe> --colmap-manifest <abs manifest.json> --brush <abs brush_app.exe>
            (otherwise PRISM_COLMAP_PATH, PRISM_COLMAP_PROVENANCE_PATH, PRISM_BRUSH_PATH)
```

`check` reads `.env.local` if it exists, to report this environment's hosted configuration. It prints states only
(e.g. relay key `configured` / `missing` / `invalid`), never a value. `smoke` and `room` do not read `.env.local`: they
need no credential, and their tools receive a minimal allow-listed environment.

### The readiness report (`check`)

`check` reports:

- **HOSTED:** `PRISM_LOCAL_AGENTS_ENABLED`, relay key status, persistence mode, site origin, whether the origin is
  HTTPS, edge rate limit ("not detectable from the application"), and whether remote execution is available.
- **LOCAL AGENT:** whether a paired profile exists (and whether it is revoked), its server origin, and the protocol
  version.
- **TOOLCHAIN:** COLMAP `missing | unverified | incompatible | verified`, Brush `missing | incompatible | ready`, and
  Vulkan `available | unavailable`.
- **HARDWARE:** OS, CPU, RAM, free disk on the workspace volume, GPU adapters, and Vulkan instance and devices.
- **Assessment:** the tier and decision, gates A/B/C with reasons, and **READY FOR REAL ACCEPTANCE: YES/NO** with
  reasons.

It never reports a user name, a host name, a device key, a Supabase credential or a secret value. Tool locations
appear only with `--diagnostic`. Exit code: 0 when ready, 1 when not.

## Hardware audit and acceptance policy

The audit is local and read-only. It uses Node's `os` and `statfs`, one fixed read-only PowerShell CIM query on
Windows (OS caption, physical cores, display adapters), and `vulkaninfo --summary`. There is no telemetry, no upload
and no driver change.

**What it does not know, it says so.** VRAM is not reliably detectable from these sources:
`Win32_VideoController.AdapterRAM` is a 32-bit field, and for an integrated GPU it is a shared aperture. A Vulkan
**DLL on disk proves nothing**. An **enumerated** hardware Vulkan device is the minimum evidence, and only a REAL_SMOKE
training run proves that Brush can use it.

**Upstream facts.** COLMAP runs on the CPU in Prism's profile: no CUDA, no GPU SIFT. Brush v0.3.0 trains through
wgpu with Vulkan. **Neither project documents a formal minimum CPU, RAM or VRAM.** The numbers below are therefore
Prism's own conservative heuristics for a first acceptance run, not upstream requirements.

| Tier                 | Meaning                                                                              | Rules (Prism heuristics)                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNSUPPORTED`        | Cannot run the toolchain here, or cannot show that it could.                         | Not Windows/Linux x64; less than an "8 GB" machine; no Vulkan loader; `vulkaninfo` missing or failing; only a CPU/virtual Vulkan device (e.g. llvmpipe); free disk below REAL_SMOKE's 2 GiB or unknown. |
| `SUPPORTED_FOR_TEST` | May run REAL_SMOKE (a tiny training run) to find out. Not expected to handle a room. | A hardware Vulkan device enumerates, but one or more of the PRACTICAL rules is not met.                                                                                                                 |
| `PRACTICAL`          | Plausibly able to reconstruct one ordinary room in a working session.                | A **discrete** Vulkan GPU; ≥ 8 logical CPU cores (COLMAP's CPU extraction and exhaustive matching); a "16 GB" machine (≥ 15 GiB reported); free disk ≥ the room estimate.                               |

**Decision.** `READY_FOR_REAL_RUN` only for `PRACTICAL`. `room` refuses anything else unless the operator passes
`--accept-hardware-risk` after reading the reasons. `smoke` refuses only `UNSUPPORTED`.

**Disk.** REAL_SMOKE needs 2 GiB. A REAL_ROOM run needs about **10 GiB + 25 × the photographs' bytes**. That covers
COLMAP's feature database and matches, undistorted copies of every photograph, Brush's dataset, its exported PLY
(≤ 1 M Gaussians ≈ 250 MB), the SPZ and logs. Intermediates can be many times the size of the photographs. This is
Prism's conservative safety policy, not an upstream number; the engine's own per-run workspace cap (40 GiB) still
applies. Both commands refuse **before starting** when the output volume has less free space.

### This workstation (audited 2026-10-20, before anything was installed)

| Fact           | Value                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------- |
| OS             | Windows 11 Pro 10.0.22631, x64                                                                      |
| CPU            | Intel Core m3-6Y30 (2 cores / 4 logical, low-power mobile part)                                     |
| RAM            | 15.9 GiB reported (a 16 GB machine)                                                                 |
| Free disk      | 94.5 GiB on C:                                                                                      |
| GPU adapters   | Intel HD Graphics 515 (integrated, driver 31.0.101.2115); SMI USB Display (a USB display adapter)   |
| VRAM           | not reliably detectable (integrated: shared system memory)                                          |
| Vulkan         | loader present; instance 1.3.204; one device: Intel HD Graphics 515, **integrated**, Vulkan 1.3.215 |
| COLMAP / Brush | not installed                                                                                       |

**Decision: `NOT_READY_FOR_REAL_RUN` (tier `SUPPORTED_FOR_TEST`).**

- The only GPU is integrated and shares system memory.
- 4 logical cores make COLMAP's CPU matching of a room set slow.
- Building COLMAP from source with vcpkg on this machine is a long operator job.

REAL_SMOKE could be tried here to learn whether Brush runs on this GPU, but only after the operator explicitly
approves installing the tools. A REAL_ROOM run should use a PRACTICAL machine (a discrete Vulkan GPU, ≥ 8 logical
cores). Nothing was installed or built.

## COLMAP: the supported build (operator, manual)

Exactly **COLMAP 4.2.1 at commit `bd1fcf654d2dd8fefa1466999c190a246f83f4b9`** is supported. The version is never
updated silently.

- Official Windows binaries are not supported (they compile in SiftGPU, LSD and CGAL: see
  [local-reconstruction.md](local-reconstruction.md)).
- An arbitrary COLMAP found on PATH is never used for real acceptance.
- Only an operator-built, Prism-verified build is accepted. A COLMAP that "works" without a verified provenance
  manifest is **not** Prism-supported.

**Re-audited for M2D.3D1** against the pinned source (`CMakeLists.txt`, `cmake/FindDependencies.cmake`, `vcpkg.json`,
`vcpkg-configuration.json` at `bd1fcf6`):

- Every option name in the approved profile exists exactly as documented.
- With them OFF, COLMAP asks vcpkg only for its `core` manifest features (no `gui`, `download`, `cgal`, `onnx` or
  `cuda`).
- The vcpkg baseline is `127402f1c75bb3d5ff6bce04b285faa4930a5aca`.
- PoseLib (commit `fa7280f…`) and faiss (v1.14.1) are fetched at configure time by fixed URL with SHA256 hashes in
  COLMAP's CMake.
- vcpkg checks a SHA512 for every port archive.

**Download policy.** Prism itself never downloads, builds or installs COLMAP: not the app, not the worker, not the
agent. The operator's build downloads the pinned source and its pinned dependencies once, by hand, using the steps
below. The steps are documented rather than scripted on purpose, so every network action is visible to the operator.

Plan (Windows; run in a "x64 Native Tools Command Prompt for VS 2022"; all paths outside the Prism repository):

```
:: prerequisites (operator-installed): Visual Studio 2022 Build Tools (Desktop C++), Git, CMake >= 3.21, Ninja
set ROOT=D:\prism-tools
git clone https://github.com/microsoft/vcpkg %ROOT%\vcpkg
git -C %ROOT%\vcpkg checkout 127402f1c75bb3d5ff6bce04b285faa4930a5aca
%ROOT%\vcpkg\bootstrap-vcpkg.bat -disableMetrics
git clone https://github.com/colmap/colmap %ROOT%\colmap-src
git -C %ROOT%\colmap-src checkout bd1fcf654d2dd8fefa1466999c190a246f83f4b9
cmake -S %ROOT%\colmap-src -B %ROOT%\colmap-build -G Ninja ^
  -DCMAKE_TOOLCHAIN_FILE=%ROOT%\vcpkg\scripts\buildsystems\vcpkg.cmake ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DCUDA_ENABLED=OFF -DHIP_ENABLED=OFF -DCASPAR_ENABLED=OFF -DGUI_ENABLED=OFF -DOPENGL_ENABLED=OFF ^
  -DMVS_ENABLED=OFF -DCGAL_ENABLED=OFF -DLSD_ENABLED=OFF -DONNX_ENABLED=OFF -DFETCH_ONNX=OFF ^
  -DDOWNLOAD_ENABLED=OFF -DTESTS_ENABLED=OFF -DBENCHMARK_ENABLED=OFF ^
  -DCMAKE_INSTALL_PREFIX=%ROOT%\colmap
cmake --build %ROOT%\colmap-build --config Release
cmake --install %ROOT%\colmap-build --config Release
npm run local:verify-colmap -- --source %ROOT%\colmap-src --build %ROOT%\colmap-build ^
  --exe %ROOT%\colmap\bin\colmap.exe --out %ROOT%\colmap\prism-colmap-provenance.json
```

Then set `PRISM_COLMAP_PATH` and `PRISM_COLMAP_PROVENANCE_PATH`. The verifier is authoritative: if it refuses the
build, the build is not supported, whatever COLMAP itself does. **This plan has not been executed in this project
yet.** The first real build (M2D.3D2) must pass the verifier, and any deviation it reports is fixed in the build, never
by relaxing the verifier. (`git -C` is used so the checkout is at the exact commit. If `git status` in the source
directory is not clean, the verifier refuses.)

## Brush: v0.3.0 (operator-installed)

Exactly **Brush v0.3.0, tag `v0.3.0` → commit `3edecbb2fe79d3e2c87eeab85b15e0b1dd10d486`**, Apache-2.0. Prism never
bundles or downloads Brush, and never upgrades it silently.

- **Acquisition (Windows):** the official GitHub release asset `brush-app-x86_64-pc-windows-msvc.zip` of
  [ArthurBrussee/brush v0.3.0](https://github.com/ArthurBrussee/brush/releases/tag/v0.3.0). GitHub records its sha256
  as `b68e3e9cf052d51bf3ee30776fa5a364de7f2ba13b58443128ff797bb7bcfcd6`. The release also ships a `.sha256` file and
  a `sha256.sum`. Check the downloaded archive against these (`certutil -hashfile <zip> SHA256`) before extracting it,
  then set `PRISM_BRUSH_PATH` to the absolute `brush_app.exe`. There is no other supported source; building from the
  tagged `source.tar.gz` is the alternative.
- **Linux:** `brush-app-x86_64-unknown-linux-gnu.tar.xz` from the same release.
- The probe accepts 0.3.x at run time, but **real acceptance is pinned to 0.3.0** (the readiness report says so for a
  0.3.1).

**GPU smoke.** Brush v0.3.0's CLI has a dataset path, `--with-viewer` and the training options; it has **no device
or adapter probe that does not train**. So the smallest training run is the GPU smoke test: REAL_SMOKE's
`acceptance_smoke` profile (500 steps, ≤ 100 000 splats, SH degree 3, seed 42). It proves that Brush starts, reports
its version, initialises Vulkan, finds a usable device and writes a valid PLY headlessly. It is never a quality profile.

## REAL_SMOKE

```
npm run local:acceptance:smoke -- --real
```

1. Probes the toolchain (it must be READY) and the hardware (it must not be UNSUPPORTED), and checks free disk.
2. Renders 12 synthetic 512×384 views of a procedurally textured 6 m × 6 m room, in memory. Cameras stand on a small
   circle, so the views overlap heavily with a real baseline. The scene is deterministic, uses no external asset and
   makes no download.
3. Runs the real engine: COLMAP (4 commands), then Brush `acceptance_smoke`, then PLY validation, SPZ conversion and
   `inspectSplat`.
4. Runs the Spark render check (below), unless `--no-render`.
5. Writes the report.

A smoke verdict is the machine verdict only (a synthetic scene has no quality to judge). If COLMAP cannot register
the synthetic scene on a machine, re-run with `--input <dir>` on a tiny real photo set (10–20 overlapping photos of a
textured object or desk). The default output is `<per-user data>\PrismStudio\acceptance\smoke-<time>`.

## REAL_ROOM (M2D.3D2)

```
npm run local:acceptance:room -- --real --input D:\captures\living-room --output D:\acceptance\living-room-1
```

- **Inputs:**
  - 3–300 JPEG/PNG files, identified by their bytes, not their extension.
  - One directory, not recursive. Links are never followed. Other files are listed as skipped and never read.
  - Duplicates are refused.
  - Order is file-name code-point order, so the same files give the same order on every machine.
  - The directory must be **outside the repository**.
- **Originals are never written.** The engine copies each photograph into its workspace as `000001.jpg …`, and file
  names never reach a tool or a shell.
- **Output** must be new or empty, outside the repository, and not inside the photo directory.
- Runs the real M2D.3A engine with the `standard` profile. `draft` and `high` stay unavailable until `standard` has
  passed on real data.
- **Produces:** `splat.ply`, `splat.spz`, `run-manifest.json` (the engine's manifest), `run.log` (bounded),
  `acceptance-report.json`, `human-review.json`, and Spark frames (`render-overview.png`, `render-interior.png`).
- **Failure preservation:**
  - A failed run keeps the report, the engine's failure manifest and the bounded log.
  - Large intermediates (COLMAP database and models, undistorted images, Brush dataset) are removed by default, or
    kept under `work/` with `--keep-intermediates` for debugging.
  - Each run has its own output directory, chosen by the operator, so nothing accumulates silently. Delete old runs
    yourself.

### The acceptance report: `prism.reconstruction-acceptance.v1`

The report records:

- run id, time and mode;
- network `{ providerCalls: 0, paidCalls: 0, uploads: 0 }`;
- engine schema, quality, Brush profile and settings;
- dataset kind, input count and bytes, per-input ordinal, sha256, size, type and dimensions, and a dimension summary;
- COLMAP version, approved commit and binary sha256; Brush version; SPZ encoder;
- hardware summary and tier;
- GPU backend: the Vulkan instance and usable devices;
- camera metrics: registered images, ratio, sparse points, cameras, models found;
- splat facts: Gaussian count, SH degree, PLY/SPZ bytes, compression ratio, checksums, values clamped by SPZ;
- **duration by stage**: input preparation; COLMAP feature extraction, matching, mapping and undistortion; Brush
  training; PLY validation; SPZ conversion; SPZ validation; render acceptance;
- resources: the minimum free system memory, sampled each second, and the workspace's maximum size;
- validation results (PLY, SPZ, `inspectSplat`, Spark render);
- outcome, warnings, and verdicts.

Not measured, and said so: the tools' own peak RAM and VRAM, and GPU utilisation.

The schema refuses absolute paths, home directories and URLs in any text field. A report never contains a user name,
host name, original photo path or secret.

### Verdicts: PASS, PASS WITH LIMITATIONS, FAIL (no score)

**Machine verdict** (software checks):

- **FAIL** if any of these hold:
  - the run did not finish;
  - the PLY, the SPZ or `inspectSplat` failed;
  - Spark could not render the SPZ.
- **PASS WITH LIMITATIONS** if any of these hold:
  - the Spark check was not run;
  - fewer than 90 % of the photographs registered (the engine's hard floor is 40 %);
  - more than 1 % of Gaussians' values were clamped by SPZ.

**Final verdict** (REAL_ROOM, `npm run local:acceptance:verdict`) combines the machine verdict with the filled-in
`human-review.json`:

- It stays **PENDING_HUMAN_REVIEW** while any of these hold:
  - an item is unanswered;
  - the control-pass limitation is unacknowledged;
  - the review names another run.
- **FAIL** if the machine verdict is FAIL, or if a **critical** item fails (or is marked not applicable).
- **PASS** requires all of these:
  - the toolchain was verified;
  - every source image was processed without corruption;
  - registration thresholds passed;
  - a valid Gaussian PLY and SPZ;
  - **Spark loaded and rendered it**;
  - no critical human failure.
- Otherwise the result is **PASS WITH LIMITATIONS**, listing each limitation.

### Human checklist (machine success is not enough)

Answer each item `pass`, `fail` or `not_applicable` in `human-review.json`. Critical items (marked ★) cannot be
`not_applicable`, and a failure of any of them fails acceptance.

- **GEOMETRY:**
  - ★ walls, floor and major furniture are recognizable;
  - ★ no catastrophic duplication;
  - the camera can move through the expected area;
  - scale can be calibrated manually to a plausible value.
- **VISUAL:**
  - ★ no giant splat explosions;
  - no severe holes in the primary filming angles;
  - no dominant floaters;
  - not upside down or rotated (or corrected with the Set transform);
  - ★ acceptable appearance from the production camera.
- **CONTINUITY:** the environment stays stable when:
  - the camera moves;
  - a character mannequin is inserted;
  - the shot framing changes.
- **PRODUCTION:**
  - ★ a master frame renders;
  - previs renders;
  - ★ a GenerationPackage can reference it.
- **CONTROL PASS LIMITATION** (acknowledged, not tested): a visible Gaussian splat still blocks exact M2C
  depth/object/mask passes. Acceptance does not pretend this gap is gone.

### Spark render acceptance

`npm run local:acceptance:render -- --output <run dir>` (run automatically after `smoke` and `room`):

- **What it renders:** the run's SPZ, through **Prism's production splat path**: `SplatRuntime` with
  `@sparkjsdev/spark` 0.1.10 on a `THREE.WebGLRenderer`, and the sorted `renderFromCamera` that master frames use.
- **Where:** headless Chromium on SwiftShader WebGL. The page and its bundle are built locally with esbuild and served
  from intercepted routes; every other request is aborted.
- **What it checks:** the load succeeds, there is no page or WebGL error, and the Production Camera's overview frame
  (35 mm on the 24 mm sensor model, the 2.39:1 frame) is not empty.
- **For the human:** the overview and interior frames are saved, and the human review judges them. Visual quality is
  never inferred from pixel counts.

It proves the **file** renders in Prism's renderer; it says nothing about this machine's GPU speed.

### Location import acceptance (M2D.3D2, local first)

```
real SPZ → Prism private Asset → immutable SpatialReconstruction → explicit "Use as Spatial Environment" → Set
         → Production Camera frame
```

Run this in local memory mode (`npm run dev`) or a dedicated test project, never by deploying:

1. Upload `splat.spz` as a Location Asset.
2. Import it as a reconstruction (unknown scale; calibrate manually).
3. Choose _Use as Spatial Environment_, open the Set, frame a shot with the Production Camera, render a master frame
   and a previs frame, and reference it from a GenerationPackage.

These are the PRODUCTION checklist items.

## First room: capture guide

The first dataset should be **small and controlled**: one ordinary room (living room, office, bedroom, a hotel-like
room). Not a whole house, an outdoor block or a warehouse. The goal is to prove the pipeline, not to set a benchmark.

- **About 50–120 photographs.** More is not automatically better: overlap and coverage matter more than count. A phone
  camera is fine, and no expensive camera is needed.
- **Heavy overlap.** Each part of the room should appear in several photos taken from different positions. Take a
  photo every short step.
- **Walk the perimeter** facing inwards, then cross the middle facing the walls.
- **Several heights:** chest height, plus some low and some high.
- **Corners, every wall, the floor and the major furniture,** from more than one angle each.
- **Keep exposure consistent** where possible: lock exposure if the phone allows it, and avoid large exposure jumps
  such as pointing straight at a bright window.
- **Avoid motion blur:** hold still, use good light, and avoid night mode.
- **No people moving through the frame,** and no moving objects (pets, curtains in wind).
- **Avoid mirror-heavy and reflective angles** where you can. Glass and mirrors confuse reconstruction.
- Use JPEG or PNG; HEIC needs converting first. Keep the originals: the harness never modifies them.

## Privacy

Acceptance photographs are private local material. REAL_SMOKE and REAL_ROOM upload nothing. If the remote-agent
hosted path is tested later, only the explicitly selected project Assets cross the Prism relay. The commands refuse
input and output directories inside the repository. `.gitignore` additionally ignores the harness's own output names
(`splat.spz`, `splat.ply`, `acceptance-report.json`, `human-review.json`, `run-manifest.json`) and `/acceptance*/`
as a narrow safety net. It deliberately does **not** ignore every `.spz` / `.ply`: a curated fixture under another name
can be added normally (a fixture literally named `splat.spz` needs `git add -f` or a `!path` exception). Capture photos
must never be committed.

## Hosted security (Gate A)

### Feature flag and the relay key

Production remote execution needs **both** `PRISM_LOCAL_AGENTS_ENABLED=1` **and** the dedicated relay key. Without
the key, agents stay paired and the control plane keeps working (pair, heartbeat, status, revocation), while execution
is unavailable and fails closed. Nothing falls back to the worker key or any other key.

**Dedicated relay secret: operator procedure** (not done in M2D.3D1; no key is created, copied, printed or committed
here):

1. In the Supabase dashboard of the Prism Studio project, create a **new** secret API key (`sb_secret_…`) labelled
   for exactly this purpose, e.g. "Prism Studio agent relay".
2. Store it **only** in the Prism server's environment, as `PRISM_STUDIO_AGENT_RELAY_SUPABASE_SECRET_KEY`.
   - Never a workstation, a `NEXT_PUBLIC_*` variable, a ticket, a log or this repository.
   - Do not reuse the generation worker key, the database password or any unrelated secret.
3. Restart or redeploy the server.
4. Run `npm run local:acceptance:check` in the server's environment and confirm `relay key: configured`. It never
   prints the value.
5. **Rotation:** set a new key value and restart. The relay builds a new Storage client for the new value and never
   reuses the old one. Then revoke the old key in Supabase.
   - Removing the variable disables execution immediately.
   - No workstation needs re-pairing at any point (tested with fictional keys).

### Rate limiting (deploy gate, not an in-process limiter)

Prism deliberately has no per-process limiter (it would not hold across instances). The platform's ingress must limit
`/api/local-agent/v1/*` per client IP. The numbers below come from the protocol's cadence:

- heartbeat every 10 s;
- an idle lease request at most once per heartbeat;
- keepalive every 10 s, plus one write per stage change;
- one job's sources fetched one after another;
- one result per lease.

They allow **up to 4 workstations behind one address** (a studio NAT).

| Route               | Auth             | Suggested limit per IP                                   | Why                                                                                   |
| ------------------- | ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `POST /pair`        | **none**         | **5 per 10 min, burst 3**; alert on sustained refusals   | the only unauthenticated route; pairing is a rare human action                        |
| `POST /heartbeat`   | device signature | 30/min, burst 10                                         | 6/min per agent × 4                                                                   |
| `GET /status`       | device signature | 30/min                                                   | operator CLI, on demand                                                               |
| `POST /jobs/lease`  | device signature | 30/min, burst 10                                         | ≤ 6/min per idle agent × 4                                                            |
| `POST …/progress`   | device signature | 60/min, burst 20                                         | ~6–10/min per running agent (keepalive + stage changes) × 4                           |
| `GET …/sources/{n}` | device signature | **burst 300, then 120/min**                              | a 300-photo job fetches all of its sources at its start; a lower burst would break it |
| `POST …/fail`       | device signature | 10/min                                                   | one per attempt                                                                       |
| `PUT …/result`      | device signature | **10/hour, burst 3**; body ≤ 55 MB; request time ≥ 5 min | one ≤ 50 MB upload per lease, plus retry tolerance; slow uplinks need time            |

The platform must also allow **request bodies up to 55 MB** (the result) and **responses up to 64 MB** (a source
photograph), and requests that last minutes. Some serverless platforms cap bodies at a few MB, which would break
remote execution: verify the chosen platform's limits.

### Lease ids in logs

A lease id is a 128-bit capability-like identifier, but **not** a credential: every request is device-signed. Logs do
not need it. Application side (enforced by tests):

- Prism's own logs never print a request URL or a lease id: structured job logs carry the job id and device only, and
  unexpected errors are logged by reference.
- `next dev`'s request log skips the lease routes (`logging.incomingRequests.ignore`), and `next start` logs no
  requests.
- Lease ids are never in the UI, job events or provenance.

**What this does NOT control:** the application's logging settings have no effect on external load balancer, CDN,
edge, reverse-proxy or hosting-provider access logs. They record request paths on their own, and those paths contain
`/leases/<id>/`. Suppressing or redacting the lease id there is a **deployment gate**, and Gate A is not complete until
the chosen hosting supports and configures it.

Infrastructure (the operator's gate): reverse-proxy, edge and platform access logs record request paths, which
contain `/leases/<id>/`. The deployment must either drop or redact that path segment (e.g. rewrite
`/leases/[^/]+/` → `/leases/[REDACTED]/` in the log format) or exclude these routes from access logs. Where a
platform cannot do either, record it as an accepted residual (the id grants nothing without the device's key).

### Deployment target

**NOT DEFINED.** The repository has no platform configuration (no `vercel.json`, Dockerfile, proxy or edge config).
The only hint is that `src/lib/auth/site-url.ts` accepts `VERCEL_URL` as a fallback origin. The intended production
origin is `https://studio.prismsuite.io` ([auth.md](auth.md)). Prism does not infer a platform from that fallback and
adds no vendor configuration. The infrastructure must support: incoming result bodies of at least 55 MB, source
responses of at least 64 MB, multi-minute request handling where ingestion needs it, and body streaming compatible with
the protocol; plus server-only environment secrets, edge request controls and access-log controls. Until a platform is
chosen, the provider-neutral checklist is:

- HTTPS-only origin, with `NEXT_PUBLIC_SITE_URL` set to it;
- per-IP rate limits as above;
- body, response and request-duration limits as above;
- lease-path redaction in access logs;
- the relay key in the server environment only;
- `PRISM_LOCAL_AGENTS_ENABLED=1` only after all of the above;
- no deployment until Gates A–C pass.

## Real-tool limitations (honest status)

- No real COLMAP build, no real Brush run and no real reconstruction exist yet (M2D.3D2).
- The COLMAP build plan comes from a source audit, and its first execution may need adjustments. The verifier, not
  the plan, decides.
- REAL_SMOKE's synthetic scene proves that the tools run, not their quality. Registration of synthetic views by real
  COLMAP is expected but unproven; use `--input` with a tiny real set if it fails.
- The hardware thresholds are Prism heuristics, refined after the first real runs.
- Only `standard` exists. Video and FFmpeg are out of scope.
