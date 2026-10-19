# Reconstruction providers and jobs (Phase 2F M2D.2)

Reference images → reconstruction job → provider operation → validated private result → immutable reconstruction →
(only when the user says so) the Location's spatial environment.

The provider is **never** Prism's source of truth. Prism owns the job identity, the input provenance, the provider
request provenance, the result bytes and their checksum, the reconstruction record, the scene placement and every
approval. No real provider is called by any test.

## Free first

```
Prism Reconstruction Jobs (this document: jobs, ingestion, provenance)
    ├─ Local adapters                     free, run on the user's own machine
    │    └─ local_capture  [M2D.3]        photos / video → COLMAP poses → Brush training → PLY → SPZ
    ├─ Import  [M2D.1]                    any .spz / .ply / .splat the user already has
    └─ Optional hosted adapters           paid, never required, never selected or used automatically
         └─ worldlabs_marble              World Labs Marble API (the user's own key)
    ↓
M2D.1 ingestion: validated private Asset → immutable reconstruction → Location → Set (Spark rendering, local)
```

- Creating a Location must never **require** a per-generation fee. Rendering, editing, import and the whole job
  system are local; the default reconstruction path (M2D.3) is local and free. A hosted provider is an option the
  user picks, per request, with an explicit cost acknowledgement.
- **No automatic fallback.** If the chosen provider is unavailable or fails, that job fails. Prism never switches to
  another provider, and so never starts spending money, on its own. Changing provider is always a user action.
- **ArtCraft is not Prism's generation backend.** An audit of ArtCraft's source (storytold/artcraft and
  storytold/artcraft-services, 2026-10-19) found that its "Image to Location" runs nothing locally: it uploads the
  reference images to ArtCraft's cloud
  (`api.storyteller.ai`), requires an ArtCraft account and credits, relays to World Labs Marble or fal.ai TripoSplat at
  a markup, and stores results in ArtCraft storage. Prism makes no call to ArtCraft and holds no ArtCraft credential.
  The scene-authoring code Prism vendored from ArtCraft (MIT; `src/vendor/artcraft-scene-engine/UPSTREAM.md`) is a
  separate, local engine and has nothing to do with ArtCraft's hosted paid service.
- **TripoSplat** (VAST) produces an object-scale splat from one image: a candidate for a future Image → Prop workflow,
  not a Location provider. It is not registered.
- The M2D.1 splat runtime (Spark, MIT) renders locally in the browser and costs nothing.

## Five concepts, not one

| Concept                   | Where                                                       | Lifetime            | Holds                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **ReconstructionJob**     | `reconstruction_jobs` (one row per attempt)                 | history             | what was asked: ordered sources (by value), provider, capability, model, result kind, options, status, provider operation id          |
| **ProviderOperation**     | the provider                                                | external, temporary | the provider's own execution state, reached by its id                                                                                 |
| **ProviderResult**        | the provider                                                | transport           | result candidates; their URLs are used once, server-side, and never stored                                                            |
| **SpatialReconstruction** | `location_spatial_reconstructions` (`method = 'generated'`) | immutable           | the validated result Asset + checksum, the job's ordered sources, the provider/model/operation provenance, the provider's scale claim |
| **Set scene object**      | the Location's saved Set                                    | mutable             | placement and calibration, only after **Use as Spatial Environment**                                                                  |

An imported splat (M2D.1) and a generated one converge on the same reconstruction record and the same Set object.

## The job (`prism.reconstruction-job.v1`)

- **Statuses**: `draft`, `queued`, `submitting`, `running`, `ingesting`, `succeeded`, `failed`, `cancelled`. The
  provider's operation status (`pending/running/succeeded/failed/expired/cancelled`) is stored separately.
- **Transitions** (enforced in TypeScript AND by a database trigger): `draft→queued|cancelled`,
  `queued→submitting|failed|cancelled`, `submitting→running|failed`, `running→running|ingesting|failed|cancelled`,
  `ingesting→succeeded|failed`. Terminal rows never change. Every write is compare-and-set on `revision`.
- **Input snapshot**: each source is frozen by value: `ordinal, kind, assetId, checksum, mime, width, height,
byteSize`. `kind` is `image` or `video` (a video job is exactly one video; images and video never mix). Rows written
  before migration 0037 have no `kind` and read back as images. Up to 300 inputs (the database allows the same);
  each provider declares its own lower maximum (World Labs: 8). A changed reference image (new checksum) makes the
  job refuse submission: create a new job.
- **Order is identity**: the first image is the primary one and is never re-sorted. Reordering changes the job
  fingerprint.
- **Fingerprint**: schema, project, location, ordered sources, provider, capability, model, result kind and
  provider options (canonicalised). Never status, timestamps, progress, operation ids, poll counts or URLs. An image
  source's `kind` is left out, so image jobs keep their pre-0037 fingerprints (pinned by a test); a video changes it.
- **Cost provenance** (migration 0037): `cost_estimate_json` is the estimate shown to the user and checked by the
  spend gate (cost class `free | paid | unknown`, provider units, USD when the provider publishes the conversion,
  the basis, the pricing source and the date it was checked). It is frozen with the request. `cost_actual_json` is
  only what a provider itself reports; Prism never derives it. Jobs created before 0037 have no estimate.
- **Attempts**: `(project_id, job_fingerprint, attempt)` is unique. **Retry** creates a new row (`attempt + 1`,
  `previous_job_id`); the failed attempt stays history. Retry is never automatic.
- **Operation id**: assigned once; a database trigger refuses any replacement.
- **Events**: `reconstruction_job_events` is append-only and sanitised (no URL, no key, bounded size).

## The provider contract (`src/lib/reconstruction/provider.ts`)

`capabilities()` states truthfully:

- `execution`: `local | hosted | mock`; `runner`: `provider_api | local_worker` (see below); `cost`:
  `free | paid | unknown` (`paid` and `unknown` both go through the spend gate, and `unknown` is blocked because it
  cannot be checked);
- `inputModes` (`single_image | multi_image | panorama | video`), `resultKinds` (only kinds Prism can ingest: today
  `gaussian_splat`), `maxInputs`, `models`, `defaultModel`;
- `options`: the provider-specific options it accepts, DECLARED (`boolean` or `choice`, with a default). The UI
  renders them and the server keeps only declared keys of the declared type; anything else is refused;
- `supportsCancel`, `supportsProgress`, `supportsResume`, `supportsIdempotencyKey`, `testOnly`.

`status()` reports configured / enabled / capability (`available | unavailable | not_installed | unknown`) and a
user-language reason. `estimateCost(model, inputMode)` returns the documented cost (or `unknown`; never a guess).
Then `prepareInputs`, `submit`, `getOperation`, optional `cancel`, `extractResult` and `download`. Neither the job
service nor the panel branches on a provider id.

### The registry (`src/lib/reconstruction/registry.ts`)

The registry is the only list of providers. Provider ids in the database are bounded identifiers
(`^[a-z][a-z0-9_]{0,63}$`, migration 0037), not a closed list, so adding a provider needs no migration. A job naming
a provider the registry no longer has stays readable history: it is shown as stored, never polled, never
substituted, and can still be cancelled locally.

| Provider              | Execution / runner      | Cost | Inputs                    | Availability                                                        |
| --------------------- | ----------------------- | ---- | ------------------------- | ------------------------------------------------------------------- |
| `local_capture`       | local / `local_worker`  | free | multi-image, video        | `not_installed` until the M2D.3 toolchain exists (never faked)      |
| `worldlabs_marble`    | hosted / `provider_api` | paid | single image, multi-image | optional: key + `WORLDLABS_RECONSTRUCTION_ENABLED` + the spend gate |
| `mock_reconstruction` | mock / `provider_api`   | free | single image, multi-image | development and test servers only                                   |

The UI pre-selects a provider only when a free, local provider is ready (`local_capture` once M2D.3 lands). A paid
provider, or the mock, is never pre-selected, even when it is the only one available. `meshy` (0036's reserved id)
has no adapter and is not offered; `world_bundle` is not a result kind; ArtCraft and TripoSplat are not providers.

### The execution boundary (M2D.3 contract)

- `provider_api`: an external service runs the operation. Any Prism server request may advance it (polls are
  rate-limited per job), so a job resumes from its stored operation id after a navigation, a closed tab or a restart.
- `local_worker`: a separate Prism worker process on the same machine runs it. Web requests never execute or poll a
  local job: `submitJob` and `refreshJob` leave it exactly as the worker wrote it (unit-tested). The M2D.3 worker
  will claim `queued` jobs with the same compare-and-set (`queued → submitting`), run the toolchain, write
  `running` progress, and hand the result to the same atomic ingestion. Because it does not depend on a browser, a
  10–30 minute reconstruction keeps running with no page open. It must re-read the job before every write (a user
  may cancel a queued or running local job; the compare-and-set and the terminal-state guard make a late write fail).

## World Labs / Marble (`src/lib/reconstruction/worldlabs.ts`)

Only the documented public API (docs.worldlabs.ai, Marble API v1) is used:

| Call                                          | Use                                                                                                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /marble/v1/media-assets:prepare_upload` | create a media asset; returns `media_asset.media_asset_id` and `upload_info { upload_url, upload_method, required_headers }`                                                           |
| `PUT <upload_url>`                            | upload the Prism image bytes to the signed grant (server-side). The API key is NOT sent there                                                                                          |
| `GET /marble/v1/media-assets/{id}`            | reuse check for a source uploaded by an earlier attempt                                                                                                                                |
| `POST /marble/v1/worlds:generate`             | `world_prompt` `image` (1 source) or `multi-image` (2–4; up to 8 with `reconstruct_images: true`), content `source: media_asset`, `permission.public = false`, model `marble-1.0-draft | marble-1.0 | marble-1.1 | marble-1.1-plus` |
| `GET /marble/v1/operations/{id}`              | poll; when done, `response` is the World with `assets.splats.spz_urls` (`full_res`, `500k`, `100k`) and `semantics_metadata`                                                           |

- **Credentials**: `WLT_API_KEY`, sent only as the `WLT-Api-Key` header on API calls; never in a URL, never to the
  signed upload or download URLs, never persisted, logged or sent to the browser. Optional `WLT_API_BASE_URL`
  (default `https://api.worldlabs.ai`, as documented), `WLT_UPLOAD_HOSTS` (default `storage.googleapis.com`) and
  `WLT_RESULT_HOSTS` (default `*.worldlabs.ai, wlt-ai-cdn.art, storage.googleapis.com`).
- **Prism images never become public**: the provider receives them through its own private upload grant.
- **No documented idempotency key and no cancel endpoint**: Prism never resubmits on its own; each world is tagged
  with the job attempt's stable key (`pj…`, 32 chars) so an ambiguous submission can be found in the World Labs
  account; "Cancel" only stops Prism tracking and says so (the remote world may still finish and be charged).
- **No webhooks** are documented; polling is used.
- **Capability**: `worlds:generate` is documented, so the capability is `available` whenever the provider is enabled
  and configured; no probe call is made. The brief's `/api/v2/...` `images2PosedRGBD` / `splats2Mesh` routes are NOT
  in the current public documentation and are not used.
- **Pricing** (official pricing page, docs.worldlabs.ai/api/pricing, checked 2026-10-19; $1.00 per 1,250 credits). A
  request is a "pano generation" event (0 credits for a panorama image, 80 for a non-panorama image, 100 for
  multi-image) plus the world generation (150 draft, 1,500 standard; 1.1 Plus adds a size-dependent 0–1,500). Prism
  sends one image with `is_pano: "auto"`, so a single image is estimated as the range panorama…non-panorama:
  Draft 150–230 credits ($0.12–$0.18) for one image, 250 ($0.20) for several; 1.0 / 1.1 1,500–1,580 ($1.20–$1.26) and
  1,600 ($1.28); 1.1 Plus 1,500–3,080 ($1.20–$2.46) and 1,600–3,100 ($1.28–$2.48). The spend ceiling is checked
  against the MAXIMUM. The pricing source and check date are stored with each job's estimate. World Labs documents no
  per-operation cost report, so no actual cost is recorded for it.
- **Result**: SPZ candidates are tried best-first (`full_res`, `500k`, `100k`); one over Prism's 50 MB splat cap is
  skipped (never truncated). The collider mesh is not imported and therefore not advertised as a result kind.
- **Options**: one declared option, `reconstructImages` ("Reconstruction mode (up to 8 images)"). No azimuth or seed
  is sent (Prism has no input for them).
- **Scale**: `metric_scale_factor` (documented: multiply XYZ to get metres; `1.0` means "not inferred") becomes a
  `provider_estimated` calibration (`units = metres`, labelled an ESTIMATE everywhere); `1.0`/missing stays
  `unknown`. `ground_plane_offset` is recorded and used for the starting placement.

## Configuration and the spend gate

A provider is usable only when ALL of these hold:

| Switch                                                                        | Meaning                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `PRISM_RECONSTRUCTION_JOBS_ENABLED=1`                                         | the feature is on for this server                                                          |
| `WORLDLABS_RECONSTRUCTION_ENABLED=1` + `WLT_API_KEY`                          | World Labs is switched on AND configured (a key alone does nothing)                        |
| `PRISM_STUDIO_ALLOW_PAID_GENERATION=true` + `PRISM_STUDIO_MAX_GENERATION_USD` | the existing live-spend gate; the documented maximum price must fit under the ceiling      |
| explicit acknowledgement                                                      | the user ticks "provider charges may apply" before **Generate Reconstruction** / **Retry** |

The paid rows apply to a `paid` or `unknown`-cost provider only; a free provider (local capture, the mock) needs no
spend switch and no acknowledgement. The gate is checked when the job is created AND again immediately before
submission, before any upload: a paid-off server never calls a billable provider (unit-tested with a spy that must
stay at zero calls). Nothing is ever
submitted from a Save button. The mock provider is free and exists only on development/test servers
(`PRISM_STUDIO_ENABLE_MOCK_RECONSTRUCTION=1` for the E2E production builds). `PRISM_RECONSTRUCTION_POLL_MS` (default
5000, minimum 250) bounds how often a job's provider is polled.

## Running, resuming, failing

- **Submit** (`queued → submitting` CAS elects one submitter) → sources read server-side from private storage →
  provider inputs (reused from the previous attempt when the checksum matches) → one `submit` → `running` with the
  operation id. An unanswered submit becomes `failed: submit_ambiguous` with the findable tag; it is never retried
  automatically.
- **Polling**: the browser polls Prism (1–10 s); Prism polls the provider at most once per interval per job. A local
  timeout or network error never fails a running job and never triggers a new submission.
- **Resume**: a job lives in the database; navigating away, closing the tab or restarting the server loses nothing.
- **Errors**: `not_configured, capability_unavailable, spend_blocked, invalid_sources, submit_failed,
submit_ambiguous, provider_failed, provider_timeout, result_missing, result_too_large, result_invalid,
ingest_failed, cancelled`. Messages are sanitised (URLs and key material removed).

## Ingestion (`src/server/reconstruction-jobs.ts`)

`running → ingesting` (CAS: exactly one poller ingests) → download (SSRF-safe: https only, provider host allow-list,
public addresses only, bounded redirects, byte cap, timeout) → checksum → `inspectSplat` (M2D.1) → private Asset
(`3d` / `spatial_reconstruction` / `provider_output`) → immutable generated reconstruction **and** job success in ONE
database transaction. Any failure removes what the attempt stored; a transient failure keeps the job `ingesting`
and is retried on later polls (at most 3 times) without ever regenerating; a second ingestion of the same job is
refused by a unique index on `job_id`.

## PLY → SPZ (M2D.3 requirement)

Brush (and most 3DGS trainers) write a binary little-endian Gaussian PLY. M2D.1 already validates that format
(`inspectSplat`) and renders it, but a room-scale PLY with spherical harmonics is about 250 bytes per Gaussian
(1 M Gaussians ≈ 250 MB), far over the 50 MB splat cap. M2D.3 therefore needs a production PLY → SPZ converter:

```
Brush PLY → validate (inspectSplat) → convert / compress to SPZ → validate again → private Asset → reconstruction
```

`encodeSpzFile` in `src/lib/splat/synthetic.ts` was audited for reuse and is **not** promoted: it is a test fixture
that writes no spherical harmonics, wraps positions outside ±2,048 units silently (24-bit fixed point, 12 fractional
bits, no range or NaN check), takes 8-bit opacity rather than PLY's logit, has no PLY reader, and builds everything
in memory. The M2D.3 converter must read PLY attributes (positions, `f_dc_*`, `f_rest_*`, opacity logit, log
scales, rotations), choose fractional bits from the scene's extent and refuse (not wrap) out-of-range values, keep
or explicitly drop SH by degree, normalise quaternions, stream large files, and be round-trip tested against
`inspectSplat` and the Spark loader. Until then, a local result that fits the cap can be ingested as PLY unchanged.

## Use as Spatial Environment

A finished reconstruction changes nothing until the user presses **Use as Spatial Environment**. If the Set already
has an environment, **Replace current spatial environment** must be confirmed; the replaced reconstruction stays in
history. The Set must then be saved, which is what changes the Set fingerprint (and, through the existing rules,
stales camera, blocking and renders).

Only the environment actually used by the saved Set enters a GenerationPackage
(`spatialReference.spatialEnvironment.generation`: job, attempt, provider, capability, model, operation id). Jobs on
their own are Location history, not Shot truth. A visible generated splat still blocks M2C control passes.

## Tests (no real provider call)

| What                                                                                                                                                          | Where                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Domain (fingerprint, order, matrix, idempotency key, sanitising, provider ids, input kinds, cost)                                                             | `src/domain/reconstruction/__tests__/job.test.ts`                                          |
| Lifecycle, paid gate, atomic ingestion, lost race, registry, local capture, NO paid fallback, unknown providers, cost, declared options, no ArtCraft endpoint | `src/server/__tests__/reconstruction-jobs.test.ts`                                         |
| World Labs adapter, official pricing table, fake World Labs → Prism ingestion (fake HTTP)                                                                     | `src/lib/reconstruction/__tests__/worldlabs.test.ts`                                       |
| Database (matrix, CAS, immutability, RLS, one reconstruction per job, new provider ids without a migration, input bounds, frozen estimate, reported cost)     | `npm run db:reconstruction-jobs`                                                           |
| Browser (mock provider)                                                                                                                                       | `e2e/zzzzzzzzzzzz-reconstruction-jobs.spec.ts`, `e2e/supabase-reconstruction-jobs.spec.ts` |

## Known gaps

- No live World Labs call has been made from Prism (by design in M2D.2); the adapter is built to the public docs and
  proved against a fake HTTP layer only. The first live use needs an operator decision.
- Local capture is registered but not implemented: no worker, no toolchain detection beyond a stub that reports
  "not installed", no video upload path in the panel (the job schema already represents video). That is M2D.3.
- Mesh results (`collider_mesh_url`) are not imported; only Gaussian splats are.
- The World Labs price table is static (checked 2026-10-19); a price change needs a code update.
- No webhooks; no provider-side cleanup of uploaded media assets.
- An ambiguous submission is only reconcilable by hand (World Labs tag), because the API has no idempotency key.
- A job whose result could not be imported (`ingest_failed`) cannot be re-ingested from the same operation yet.
