# Phase 5B-I3: Remove Background (transparent cutouts)

> Source Image → **Remove Background** → review (original next to the cutout) → the cutout is kept as an immutable
> Asset → Use as Character Reference / Use as Look / any image input.

This is **segmentation / matting, never a generative redraw.** The engine returns only an alpha matte, and the cutout
keeps **every source RGB value**: no face, hair, wardrobe or prop can change. A test checks this pixel by pixel.
Generating with a transparent background (I2) stays a separate capability with its own control.

No paid call. No migration. `0051` is still unapplied to hosted DEV. The live site is unchanged.

## 1. Architecture audit and decision

| Question                         | Finding                                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Media worker                     | `Dockerfile.media-worker` (Node 24 + ffmpeg, 4 GiB / 2 vCPU planned). Today it runs only the continuity worker; the persisted media-job worker is 5A.3. Delivery conforms run synchronously in the server action. |
| Generation worker                | The only durable async worker: leases, heartbeats, retries, idempotency, ingest to private Storage. It already serves Character / Location attempts (I1) and synchronous providers (I2).                          |
| Alpha / PNG                      | I2 stores RGBA PNGs intact. Ingest reads the real dimensions and checksum from the bytes, and now also records `hasAlpha` (from the colour type or `tRNS`).                                                       |
| Lineage, promotion, deletion     | Subject attempts: `inputAssetIds` plus the output Asset. The "use as …" actions work for any succeeded subject attempt. The 0051 gate treats an attempt as provenance, not a use.                                 |
| Image / ML libraries in the repo | None (no sharp, no onnxruntime).                                                                                                                                                                                  |
| Daemon sizes                     | 1 / 2 / 4 / 8 GiB (up to 4 vCPU), CPU only.                                                                                                                                                                       |

**Decision: B's role, executed by A, behind C.** Background removal is a provider adapter (`prism-matting`, local,
`localNoCost`) on the **existing generation queue and worker**:

- the Character attempt's purpose is `background_removal`;
- the request has one source reference and no Bible prompt;
- the adapter is synchronous and ingests under the same lease, like I2's OpenAI Images.

There is no new service and no new table. The 2C `asset_derivations` path was considered: it would need an operation
enum migration and a media-job worker that does not exist yet. Lineage is already exact through the attempt. When the
5A.3 media worker exists, the same `MattingEngine` can run there unchanged.

The flow:

1. `removeBackground` checks that the source is one of THIS Character's own images, and builds the attempt with
   `prepareBackgroundRemoval`.
2. The worker runs the adapter: `decodePng` → `engine.matte` → `composeCutout` (source RGB plus alpha) →
   `encodePngRgba`.
3. Ingest stores a new Asset in private Storage.

## 2. Engine

### Research (2026-11-08)

All findings come from primary sources: repository licenses, model cards, npm and official docs.

| Engine                               | Code / weights license                                                          | Fit                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BiRefNet-matting** (972.7 MB ONNX) | MIT / MIT                                                                       | The best soft alpha for hair. CPU latency and RAM are **not published** (est. 3–5 GB, so the 8 GiB worker). Trained on academic matting datasets whose terms (Distinctions-646, DIS5K and others) **need a legal decision**. |
| BiRefNet_lite (224 MB)               | MIT / MIT                                                                       | Fits 4 GiB / 2 vCPU (est.); edges are more binary. Same data caveat.                                                                                                                                                         |
| isnet-anime (176 MB)                 | Apache-2.0 / Apache-2.0                                                         | Anime segmentation (not matting); dataset licenses not stated.                                                                                                                                                               |
| MODNet                               | Apache-2.0 (code and models)                                                    | Photographic portraits only; poor on anime.                                                                                                                                                                                  |
| BRIA RMBG-1.4 / 2.0                  | Non-commercial (CC BY-NC)                                                       | **Excluded** without a paid BRIA agreement.                                                                                                                                                                                  |
| @imgly/background-removal-node       | **AGPL-3.0**                                                                    | **Excluded.**                                                                                                                                                                                                                |
| rembg                                | MIT tool; per-model weight licenses; its default model is BRIA (non-commercial) | Not used.                                                                                                                                                                                                                    |

Runtime: `onnxruntime-node` 1.31.1 (MIT, Node-API v6). It is about 307 MB unpacked, its install downloads CUDA files
unless `ONNXRUNTIME_NODE_INSTALL=skip` is set, and it would add about 1 GB of weights to the worker image.

**Conclusion.** No ML engine is adopted in I3:

- the best permissive engine's training-data provenance needs a legal sign-off;
- its CPU runtime and memory are unbenchmarked;
- it would put about 1.3 GB on a worker image whose current size class is 1 GiB.

The owner's rule was to stop at the provider-neutral boundary in that case, so I3 stops there.

### Shipped: `plain-background-keyer-1` (Prism's own code; no model, no weights)

- **Commercially clean by construction** (it is Prism code), **private** (bytes never leave the worker), **free**,
  **deterministic** (same source → same bytes → same checksum), and it uses little memory: an RGBA buffer, about 16 MB
  at 2048².
- **Algorithm:**
  1. The background colour is the median of a thin border ring.
  2. A flood fill from the border reaches only pixels connected to it through background-like colour, so an enclosed
     area of the background's colour, such as a white collar or the whites of the eyes, stays opaque.
  3. A soft alpha ramp across a colour-distance band gives antialiased edges and fine hair against a contrasting
     plain background.
  4. A 3×3 average runs only where alpha changes.
- **Honest limits:**
  - It **refuses** a busy background (code `background_not_plain`) instead of producing a bad cutout.
  - Hair or fabric of the same colour as the background, glass, smoke, motion blur and soft shadows cannot be
    separated by colour.
  - Colour spill on edges is not removed, because RGB is never modified.
  - Only PNG sources are accepted for now. Generated images are PNG; a JPEG or WebP is refused with a clear message.
- **Fit:** the typical generated character reference (studio or flat background) is exactly this case. Photographic
  or busy-background portraits need the segmentation engine.

### Ready for the segmentation engine (owner / legal decision)

`MattingEngine` (`src/generation/matting/engine.ts`) is the boundary: `matte(image) → alpha`. A BiRefNet engine would
be one more entry in `prism-matting`'s `ENGINES`, with:

- weights pinned by SHA-256 in Prism's own bucket;
- `onnxruntime-node` installed with `ONNXRUNTIME_NODE_INSTALL=skip`;
- intra-op threads set to the vCPU count;
- inference at 1024² and the alpha upscaled to the source size;
- running on an 8 GiB / 4 vCPU worker (or BiRefNet_lite on 4 GiB / 2 vCPU).

The UI, lineage, promotion and deletion do not change.

**Hosted alternatives** (opt-in, priced, worker-only key, spend-gated):

| Provider            | Price per image | Terms                                               |
| ------------------- | --------------- | --------------------------------------------------- |
| Photoroom           | $0.02           | "Doesn't save the images processed through the API" |
| Stability Remove BG | $0.05           | —                                                   |
| remove.bg           | $0.21–0.90      | Moves to Leonardo.Ai on 2026-12-01                  |
| fal BiRefNet        | price not shown | —                                                   |

**Open questions for the owner:**

1. The legal view on BiRefNet's training data.
2. The benchmark budget: an 8 GiB worker for this?
3. Is anime hair on busy backgrounds needed in v1?

## 3. Character UI (`subject-image-panel.tsx`)

- **On each generated Character image:** a **Remove Background** button.
- **A Remove Background section:** choose any of the Character's images (references, Look images, generated images)
  and press the button. There is no Advanced section: the shipped engine has no tunable that would improve the
  result, so none is shown.
- **A cutout card** shows:
  - **Original (unchanged)** next to the **Cutout** on a checkerboard;
  - the lineage line "Source → background removal #N → this transparent cutout";
  - the existing **Use as Character Reference** and **Use as Look** buttons.

  The cutout is already an Asset ("kept as an asset"). Nothing canonical is replaced automatically.

- **Location UI is unchanged.** There is no meaningful location-cutout use case. Generic Asset-Library cutouts need
  subject-less attempts and are deferred.
- The matting engine is never listed as a generation or edit model.

## 4. Output, provenance, promotion, deletion

- **Output:** PNG, RGBA, the **source dimensions**, the correct MIME, a SHA-256 checksum, `hasAlpha: true` (read from
  the bytes), project ownership, and a created timestamp.
- **Provenance** (in the attempt and output records):
  - engine id, version and license;
  - `sourceAssetId` and `sourceSha256`;
  - `rgbUnchanged: true`;
  - matte details: estimated background, thresholds, alpha coverage;
  - `uploadedAnywhere: false`;
  - cost $0.
- **Lineage:** source → attempt (`backgroundRemovalSourceAssetId`, `inputAssetIds`) → cutout.
- **Promotion and generation input:** the existing actions. A cutout used as a Character / Look reference is then sent
  by later image generations; Production Frame candidates read the same identity references.
- **Deletion:** the existing asset-usage rules, unchanged:
  - a referenced cutout is refused;
  - an unreferenced cutout is deletable, and its attempt stays as history with no output (the 0051 trigger and its
    memory twin);
  - the source stays pinned by the attempt that used it as an input.

## 5. Security and cost

- No credential.
- No external call. The engine never uploads anything, which is a privacy advantage over hosted options.
- `localNoCost: true` exempts only this provider from the spend gate. Fail-safe: any provider without the marker still
  bills, and a test proves it.
- Enabled by default outside production. In production it is listed in `PRISM_STUDIO_GENERATION_PROVIDERS` like every
  provider.

## 6. Tests

`src/server/__tests__/background-removal.test.ts` (8 tests, real action, queue, worker, sink and delete path) covers
the Yumeko acceptance:

1. an owned image is accepted;
2. a foreign or out-of-project image is refused;
3. the output is a new Asset;
4. the source row and bytes are unchanged;
5. the output has alpha (colour type 6, transparent and soft pixels, RGB identical);
6. MIME `image/png`;
7. checksum;
8. dimensions;
9. lineage;
10. Character promotion;
11. Look promotion;
12. a referenced cutout is undeletable;
13. an unreferenced cutout is deletable, with its attempt kept;
14. a busy source fails cleanly with the source intact and no Asset;
15. a replay plus extra ticks give one output, and a lost result is recomputed byte-identically;
16. the fake OpenAI transport has zero calls, and the spend gate is not needed;
17. the I2 transparent-generation tests still pass in the suite.

A later generation sends the cutout as a reference, and the matting engine is never offered as a model.

`src/generation/__tests__/matting.test.ts` (9 tests): the codec (round trip, RGB / RGBA / palette + tRNS, refusals,
`pngHasAlpha`) and the keyer (soft edges, RGB untouched, enclosed area kept, deterministic, busy and empty refusals,
existing transparency respected). Browser story G runs the flow end to end.

## 7. I3b: High Quality Removal (Photoroom), only on request

**Local first.** **Remove Background** always runs the local `plain-background-keyer-1` (free, private).

- If it succeeds, the cutout is returned immediately, and nothing is sent anywhere.
- If it refuses (`matting_background_not_plain`), the card says **"This image has a complex background."** and offers
  **High Quality Removal — $0.02**. The price comes from the provider's configuration, never from UI code.
- **Nothing is sent to Photoroom automatically.** Only that button queues the hosted job.

**Privacy.** The normal UI shows one line: "Processed by Photoroom. The provider states API images are discarded after
processing." The details (eastern-US servers, the provider's exact statement, errors not billed) sit under **Details**.

**Provider:** `photoroom` / `photoroom-remove-background` (`src/generation/providers/photoroom/`).

- **A separate provider, not a second local engine**, because its credential, worker-backed queuing and spend gate are
  per provider. It produces the same `background_removal` attempt, so lineage, promotion and deletion are identical.
- **Contract** (Photoroom docs, 2026-11-08): `POST https://sdk.photoroom.com/v1/segment`, `x-api-key`, multipart
  `image_file` (PNG / JPEG / WebP, ≤ 50 MB, ≤ 6,000 px), with `format=png&channels=rgba&size=full&crop=false`. There
  is no idempotency key; "Calls that result in an error will not consume an image"; the default limit is 60 images a
  minute.
- **Secret.** `PRISM_STUDIO_PROVIDER_PHOTOROOM_API_KEY` is **worker only**.
  - It is set as a header in `http-transport.ts`, which is loaded lazily, and never logged, returned or stored.
  - The web queues the job through `PRISM_STUDIO_WORKER_BACKED_PROVIDERS=photoroom`.
  - A worker without the key fails closed.
- **Cost.**
  - The price is defined once, in `config.ts` (`PHOTOROOM_DEFAULT_USD_PER_IMAGE`); a different contract price is the
    `PRISM_STUDIO_PHOTOROOM_USD_PER_IMAGE` setting.
  - The server recomputes the estimate and refuses a confirmation that doesn't match.
  - The spend gate (paid generation on, under the cap) applies at submit and again in the worker.
- **Retry safety.** The call is synchronous and ingested under the same lease. An ambiguous call (timeout, dropped
  connection, 5xx) is never re-sent: the job stops with `submission_outcome_unknown` for the operator. A result held by
  a worker that died is reported as `photoroom_result_not_retained` instead of being bought again.
- **Output and pixel identity.**
  - It is classified as **matting**.
  - Prism accepts the result only if it is a PNG with an alpha channel; anything else is refused and never stored as a
    cutout.
  - The provenance records `foregroundPreservation: "provider-process"`, and `rgbUnchangedVerified` (true, false, or
    null when it could not be checked from the bytes) — never Prism's local `rgbUnchanged` guarantee.
  - It also records the API surface, the source checksum, the uncertainty score if Photoroom sends one, and the cost.

**Tests:** `src/server/__tests__/background-removal-hosted.test.ts`, 10 tests on the fake transport, zero external
calls:

1. a plain-background image stays local, with no request;
2. a busy image is refused locally, with no automatic Photoroom call;
3. the explicit High Quality Removal queues Photoroom;
4. the result is a PNG with alpha, the source is untouched, lineage and cost are recorded;
5. the provenance claims match what was verified;
6. a cross-character or out-of-project source is refused;
7. the web queues without the key, and the worker fails closed without it;
8. the key is never in browser code, `NEXT_PUBLIC` names or persisted data;
9. the price confirmation, the paid switch, the cap and the configured price are enforced;
10. a provider error leaves the source intact; a replay and extra ticks make one call; an ambiguous call is never
    re-sent.
