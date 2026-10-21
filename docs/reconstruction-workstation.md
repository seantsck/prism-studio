# First real reconstruction: workstation readiness (M2D.3D2 preparation)

**Status: preparation only.** Nothing in this document has been run on real tools. No hardware was bought, no GPU was rented,
no system tool was installed, and no real reconstruction ran. Every REAL command still needs `--real`. Gate B (real
toolchain) and Gate C (real reconstruction) are NOT PASSED; this document is the plan for passing them.

Authoritative procedure and policy: [reconstruction-acceptance.md](reconstruction-acceptance.md) and
[local-reconstruction.md](local-reconstruction.md). This file only chooses an environment and turns those documents into one
ordered checklist.

## 1. What was verified (2026-10-21, read-only)

| Check                                                                         | Result                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main` after PR #13                                                           | `59202f9` (Phase 2F M2D.3D1), fresh clone, clean                                                                                                                                                                           |
| `npm run local:acceptance:check` on a Linux VPS (4 vCPU, 7.6 GiB, virtio GPU) | runs on Linux; correctly reports tier `UNSUPPORTED`, `NOT_READY_FOR_REAL_RUN`: no Vulkan device, 4 cores, <16 GB, no COLMAP, no Brush. Proves the harness is Linux-capable and fails closed                                |
| `vitest run src/lib/reconstruction`                                           | 144 passed, 2 skipped; the single failed file, `acceptance/__tests__/render.test.ts`, fails only because Playwright's Chromium is not installed on that VPS (environmental)                                                |
| Brush v0.3.0 Linux asset                                                      | `brush-app-x86_64-unknown-linux-gnu.tar.xz`, 44 242 224 bytes, GitHub-recorded sha256 `4f0f9a8785d1951c62df26aae247c02c5bba32b00f40b06df4e1c9b867399e20`; tag `v0.3.0` → commit `3edecbb2fe79d3e2c87eeab85b15e0b1dd10d486` |
| COLMAP pin                                                                    | commit `bd1fcf654d2dd8fefa1466999c190a246f83f4b9` exists upstream                                                                                                                                                          |
| Code paths for Linux                                                          | hardware policy accepts `linux`; tool resolution has no `.exe` rule off Windows; the COLMAP verifier handles Ninja builds and `.so` runtime files                                                                          |

**Not verified:** that the documented COLMAP build plan (written for Windows) builds and passes `local:verify-colmap` on Linux;
Brush on any GPU; wall-clock times. These are exactly what the first run is for.

## 2. Candidate environments

Requirements (Prism policy, [reconstruction-acceptance.md](reconstruction-acceptance.md)): a hardware **Vulkan** device that
`vulkaninfo --summary` enumerates (not llvmpipe), **≥ 8 logical cores** (COLMAP is CPU-only here), **≥ 15 GiB RAM**, free disk
≥ 10 GiB + 25 × photo bytes (about 20 GiB for 100 phone photos; keep ≥ 60 GiB), Windows or Linux x64.

| Option                                                   | GPU / Vulkan                                                                                       | CPU / RAM                              | Cost (approximate)                                                                                              | Setup complexity                                                                                             | Verdict                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **A. Existing Windows laptop** (Core m3-6Y30, HD 515)    | integrated Intel; Vulkan 1.3 enumerates; shared memory                                             | 4 logical / 16 GB                      | $0                                                                                                              | VS Build Tools + vcpkg build of COLMAP on a 2-core mobile part: many hours                                   | `SUPPORTED_FOR_TEST` only. A REAL_SMOKE at most; never a room         |
| **B. The Linux VPS** (4 vCPU / 7.6 GiB)                  | virtio, no hardware Vulkan                                                                         | 4 / 7.6 GiB                            | already owned                                                                                                   | n/a                                                                                                          | `UNSUPPORTED` (shown by `check`)                                      |
| **C. Rented hourly GPU VM, Linux (recommended)**         | NVIDIA 8–24 GB (T4 / RTX 30xx–40xx class), Vulkan via driver                                       | choose ≥ 8 vCPU, ≥ 16 GB, ≥ 80 GB disk | roughly $0.4–1.0 per hour (consumer-GPU marketplaces about $0.15–0.8; hyperscaler T4/A10G class about $0.5–1.1) | Ubuntu 24.04 + NVIDIA driver; build COLMAP once (1–2 h estimated); install Brush from a hash-checked tarball | **Lowest-cost practical path.** About $3–8 expected, **hard cap $15** |
| D. Container-based GPU rental (RunPod/Vast-style pods)   | compute-only by default; Vulkan needs the container's NVIDIA `graphics` capability and an ICD file | varies                                 | cheapest per hour (about $0.15–0.7)                                                                             | Same as C plus Vulkan-in-container risk                                                                      | Acceptable **only** after the 5-minute Vulkan gate (§4) passes        |
| E. Buy a GPU workstation / dedicated GPU server by month | discrete                                                                                           | 8+ / 16+                               | hardware: hundreds of dollars and up; monthly dedicated GPU servers: well over $100 per month                   | highest                                                                                                      | Not justified before one real run proves the pipeline                 |

Price notes: figures are rough and come from public aggregator pages in 2026 (for example RTX 4090 about $0.14–0.74/h
depending on marketplace and tier; RTX 3090 spot about $0.22/h; sources: [Hostinger GPU price comparison](https://www.hostinger.com/tutorials/?p=158956),
[PromptQuorum GPU cost per hour](https://www.promptquorum.com/prompt-bites/cloud-gpu-cost-per-hour)). They vary up to several times between providers
and exclude storage, egress and idle time. **Re-check live prices before renting.**

NVIDIA's container documentation states that Vulkan needs the `graphics` driver capability, which is **not** in the default
`utility,compute` set ([NVIDIA Container Toolkit docs](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/1.20.1/docker-specialized.html)).
That is why a full VM (option C) is preferred to a pod (option D): on a VM the driver package provides the Vulkan ICD.

### Recommendation

**Option C**, the cheapest single-GPU Linux VM that offers a full VM (not a locked container), an NVIDIA GPU with ≥ 8 GB, ≥ 8 vCPU,
≥ 16 GB RAM and ≥ 80 GB disk, billed hourly, with a data-centre region you control. If the cheapest offer is a pod, use it only if
the Vulkan gate passes in the first five minutes; otherwise destroy it immediately (cost: minutes).

Budget plan (estimates, unverified): provision + gate 0.2 h; COLMAP build 1–2 h; Brush + smoke 0.5 h; room run 1–3 h; slack 1 h.
At $0.5–1.0/h that is about **$3–8**. Stop and reassess at **$15**. Keep the instance **stopped/destroyed between phases** (build once,
then snapshot the disk if the provider offers cheap snapshots; otherwise do everything in one session).

Optional cost cut (unproven): build COLMAP on a cheaper CPU-only 8-vCPU VM, then copy `colmap` plus its manifest to the GPU VM. The
provenance manifest hashes the binary and runtime libraries, so this should verify, but it is not tested here; if
`local:acceptance:check` reports the provenance as `incompatible`, build on the GPU VM instead.

## 3. Privacy and safety guards that do not change

- REAL commands refuse without `--real`, and refuse inside tests (`NODE_ENV=test` / `VITEST`).
- They make 0 network provider calls, 0 paid calls, 0 uploads; they need no Supabase and no provider key.
- Input and output directories must be **outside the repository**; originals are never written; output must be new or empty.
- Disk guards refuse before starting: 2 GiB (smoke) / 10 GiB + 25 × photo bytes (room); the engine caps a run at 40 GiB.
- `room` refuses anything below tier `PRACTICAL` unless `--accept-hardware-risk` is given; do not use that flag on a rented
  PRACTICAL machine.
- **Room photos are private.** Upload them to the rented VM only over SSH (`scp`/`rsync`), never to a public bucket; delete them and
  destroy the VM at the end (§7). Rented machines are third-party hardware: use a **non-sensitive room** for this first run.
- Gate A (hosted security) is independent of this run and stays NOT PASSED; this run does not enable remote agents, create the relay
  key, or touch hosted infrastructure.

## 4. Five-minute pre-spend gate (do this before building anything)

On the freshly provisioned VM:

```bash
nproc                       # >= 8
free -g | head -2           # >= 15 GiB total
df -h /                     # >= 60 GiB free
nvidia-smi                  # GPU visible, driver loaded
sudo apt-get update && sudo apt-get install -y vulkan-tools libvulkan1
vulkaninfo --summary        # must list a NVIDIA device with deviceType = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU (or INTEGRATED), not llvmpipe
```

If `vulkaninfo` shows only `llvmpipe`/no devices, fix the driver stack once (`sudo apt-get install -y nvidia-driver-<ver>-server libnvidia-gl-<ver>-server`
matching `nvidia-smi`'s version, then re-run). If it still fails, **destroy the instance**; do not build COLMAP on a machine that cannot
run Brush.

## 5. Reproducible installation (Ubuntu 24.04 x64 VM; all paths outside the repository)

Work as an ordinary user in `~/prism-tools`. Every network action is visible here on purpose; nothing is piped from the web into a shell.

```bash
# 5.1 prerequisites (system packages; operator-installed on the rented VM)
sudo apt-get update
sudo apt-get install -y build-essential cmake ninja-build git curl zip unzip tar xz-utils pkg-config \
  autoconf automake libtool bison flex python3 vulkan-tools libvulkan1
# Node 22 for Prism (use the distribution or nodesource method you trust), then:
node --version              # v22.x

# 5.2 COLMAP 4.2.1 @ bd1fcf6 (Linux adaptation of the documented plan; the verifier is the judge)
export ROOT=$HOME/prism-tools
mkdir -p "$ROOT" && cd "$ROOT"
git clone https://github.com/microsoft/vcpkg vcpkg
git -C vcpkg checkout 127402f1c75bb3d5ff6bce04b285faa4930a5aca
./vcpkg/bootstrap-vcpkg.sh -disableMetrics
git clone https://github.com/colmap/colmap colmap-src
git -C colmap-src checkout bd1fcf654d2dd8fefa1466999c190a246f83f4b9
cmake -S colmap-src -B colmap-build -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$ROOT/vcpkg/scripts/buildsystems/vcpkg.cmake" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCUDA_ENABLED=OFF -DHIP_ENABLED=OFF -DCASPAR_ENABLED=OFF -DGUI_ENABLED=OFF -DOPENGL_ENABLED=OFF \
  -DMVS_ENABLED=OFF -DCGAL_ENABLED=OFF -DLSD_ENABLED=OFF -DONNX_ENABLED=OFF -DFETCH_ONNX=OFF \
  -DDOWNLOAD_ENABLED=OFF -DTESTS_ENABLED=OFF -DBENCHMARK_ENABLED=OFF \
  -DCMAKE_INSTALL_PREFIX="$ROOT/colmap"
cmake --build colmap-build -j"$(nproc)"
cmake --install colmap-build

# 5.3 Brush v0.3.0 (Linux release asset, hash-checked BEFORE extraction)
mkdir -p "$ROOT/brush" && cd "$ROOT/brush"
curl -fL -o brush.tar.xz https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-x86_64-unknown-linux-gnu.tar.xz
echo "4f0f9a8785d1951c62df26aae247c02c5bba32b00f40b06df4e1c9b867399e20  brush.tar.xz" | sha256sum -c -   # must print OK
tar -xJf brush.tar.xz && find . -name brush_app -type f      # note the absolute path

# 5.4 Prism checkout, verification of COLMAP, environment
cd "$ROOT" && git clone https://github.com/seantsck/prism-studio.git && cd prism-studio
git rev-parse HEAD          # must be a commit containing 59202f9 (M2D.3D1)
npm ci
npm run local:verify-colmap -- --source "$ROOT/colmap-src" --build "$ROOT/colmap-build" \
  --exe "$ROOT/colmap/bin/colmap" --out "$ROOT/colmap/prism-colmap-provenance.json"   # must print VERIFIED
export PRISM_COLMAP_PATH="$ROOT/colmap/bin/colmap"
export PRISM_COLMAP_PROVENANCE_PATH="$ROOT/colmap/prism-colmap-provenance.json"
export PRISM_BRUSH_PATH="<absolute path of brush_app from 5.3>"

# 5.5 Chromium for the Spark render check (not needed for the smoke if you pass --no-render)
npx playwright install --with-deps chromium

# 5.6 readiness
npm run local:acceptance:check
```

Expected from 5.6: tier `PRACTICAL`, COLMAP `verified`, Brush `ready` (0.3.0), Vulkan `available`, and
**READY FOR REAL ACCEPTANCE: YES**. Gate A will correctly stay NOT_PASSED (hosted); that does not block a CLI run. If `check`
says anything else, stop and fix it; do not pass `--accept-hardware-risk` to get around it.

If `local:verify-colmap` refuses, the build is not supported whatever COLMAP itself does. Fix the build (never the verifier) and
record the deviation in the PR that follows this run.

## 6. Run 1: tiny synthetic smoke (about 12 views, 500 Brush steps)

```bash
npm run local:acceptance:smoke -- --real --output "$HOME/acceptance/smoke-1" --no-render
npm run local:acceptance:render -- --output "$HOME/acceptance/smoke-1"     # if Chromium is installed
```

The command prints the exact executables, input count and output directory before it starts.

**Pass criteria (machine):** exit 0; `acceptance-report.json` outcome `PASS` or `PASS WITH LIMITATIONS` (render skipped is a limitation);
`network` is `{ providerCalls: 0, paidCalls: 0, uploads: 0 }`; COLMAP version 4.2.1 at the approved commit; Brush 0.3.0; ≥ 1 Vulkan
device recorded; camera registration present; a valid Gaussian PLY and SPZ that `inspectSplat` accepts; stage durations recorded;
`run.log` bounded; no absolute paths in the report.

**Artifacts:** `splat.ply`, `splat.spz`, `run-manifest.json`, `run.log`, `acceptance-report.json` (+ `render-*.png` after render).

**If COLMAP cannot register the synthetic scene** (documented possibility), re-run with `--input <abs dir of 10–20 overlapping photos
of a textured object>` before spending more; do not move to the room until a smoke passes.

**Go/no-go for run 2:** smoke `PASS`/`PASS WITH LIMITATIONS` and the GPU time so far is under budget.

## 7. Run 2: real room (standard profile)

Capture and privacy: see "First room: capture guide" in [reconstruction-acceptance.md](reconstruction-acceptance.md): one ordinary,
non-sensitive room, about 50–120 JPEG photos, heavy overlap, no people, consistent exposure.

```bash
# from the capture machine: copy photos over SSH only (originals stay on the capture machine)
rsync -av --progress ./living-room/ <user>@<vm>:acceptance-input/living-room/
# on the VM
npm run local:acceptance:room -- --real --input "$HOME/acceptance-input/living-room" --output "$HOME/acceptance/living-room-1"
npm run local:acceptance:verdict -- --output "$HOME/acceptance/living-room-1"     # after filling human-review.json
# retrieve results to the owner machine, then clean up
rsync -av <user>@<vm>:acceptance/living-room-1/ ./living-room-1/
```

**Measurable machine criteria** (all recorded in `acceptance-report.json`):

| Criterion                                         | Pass                        | Limitation                     | Fail                    |
| ------------------------------------------------- | --------------------------- | ------------------------------ | ----------------------- |
| Run completes, exit 0                             | yes                         |                                | no                      |
| Registered images / input images                  | ≥ 90 %                      | 40–90 % (engine floor is 40 %) | < 40 % (engine refuses) |
| Sparse points, cameras                            | present, one dominant model | several models found           | none                    |
| Gaussian PLY valid (≤ ~1 M Gaussians)             | yes                         |                                | invalid                 |
| SPZ valid and `inspectSplat` ok                   | yes                         |                                | invalid                 |
| SPZ values clamped                                | ≤ 1 % of Gaussians          | > 1 %                          |                         |
| Spark renders SPZ (overview frame non-empty)      | yes                         | not run                        | cannot render           |
| Network counters                                  | 0 / 0 / 0                   |                                | anything else           |
| Stage durations, minimum free RAM, workspace peak | recorded (informational)    |                                |                         |

**Human review** (`human-review.json`; ★ = critical): ★ walls, floor and major furniture recognizable; ★ no catastrophic duplication;
★ no giant splat explosions; ★ acceptable from the production camera; ★ a master frame renders; ★ a GenerationPackage can reference it
(the last two via the Location import steps in the acceptance document, run in local memory mode, never by deploying). Final verdict
is `PASS`, `PASS WITH LIMITATIONS` or `FAIL`; the control-pass limitation must be acknowledged.

**Expected artifacts to bring back:** `splat.spz`, `splat.ply`, `acceptance-report.json`, `run-manifest.json`, `run.log`, `render-overview.png`,
`render-interior.png`, `human-review.json`, plus the COLMAP provenance manifest. Intermediates are removed by default; use
`--keep-intermediates` only to debug and delete them afterwards.

**Cleanup (always):** on the VM `shred`/`rm -r` the input photos and outputs after retrieval, then **destroy the instance** (stopping
still bills for disk on most providers). Confirm in the provider console that no volume or snapshot containing photos remains.

## 8. Stop conditions

Stop and do not continue spending if: the Vulkan gate fails; `check` is not `READY FOR REAL ACCEPTANCE: YES`; `local:verify-colmap`
refuses; the smoke fails twice; spend reaches $15; any command asks for a credential or tries the network beyond the package/source
downloads listed in §5; or a photo would leave the VM by any route other than your own `rsync`.

## 9. Exact operator actions (nothing here is done for you)

1. Choose the provider and approve the spend cap (recommended: option C, cap $15). Provision an Ubuntu 24.04 GPU VM (≥ 8 vCPU, ≥ 16 GB, ≥ 80 GB, NVIDIA ≥ 8 GB, SSH key only).
2. Run the §4 gate; destroy the VM if it fails.
3. Run §5 (system packages, COLMAP build, Brush download + sha256 check, `npm ci`, verify, `check`).
4. Run §6 (smoke). Review `acceptance-report.json`.
5. Capture the room, run §7, fill in `human-review.json`, run `verdict`.
6. Retrieve artifacts, wipe the VM, destroy it, and record the actual cost and stage durations in the follow-up PR.

## 10. Assessment

**GO** to proceed with the operator actions above (smoke first) on a rented Linux GPU VM, subject to the owner's spend approval.
**NO-GO** to run on the current Windows laptop (room) or the Linux VPS (no Vulkan), and **NO-GO** to claim production readiness: Gates
A and C remain open and the Linux COLMAP build plan is unproven until the verifier accepts it.
