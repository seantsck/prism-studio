# Reconstruction providers and jobs (Phase 2F M2D.2)

Reference images → reconstruction job → provider operation → validated private result → immutable reconstruction →
(only when the user says so) the Location's spatial environment.

The provider is **never** Prism's source of truth. Prism owns the job identity, the input provenance, the provider
request provenance, the result bytes and their checksum, the reconstruction record, the scene placement and every
approval. No real provider is called by any test.

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
- **Input snapshot**: each source is frozen by value: `ordinal, assetId, checksum, mime, width, height, byteSize`.
  A changed reference image (new checksum) makes the job refuse submission: create a new job.
- **Order is identity**: the first image is the primary one and is never re-sorted. Reordering changes the job
  fingerprint.
- **Fingerprint**: schema, project, location, ordered sources, provider, capability, model, result kind and
  provider options (canonicalised). Never status, timestamps, progress, operation ids, poll counts or URLs.
- **Attempts**: `(project_id, job_fingerprint, attempt)` is unique. **Retry** creates a new row (`attempt + 1`,
  `previous_job_id`); the failed attempt stays history. Retry is never automatic.
- **Operation id**: assigned once; a database trigger refuses any replacement.
- **Events**: `reconstruction_job_events` is append-only and sanitised (no URL, no key, bounded size).

## The provider contract (`src/lib/reconstruction/provider.ts`)

`capabilities()` states truthfully: input modes, result kinds, max images, models (with documented prices),
`supportsCancel`, `supportsProgress`, `supportsWebhooks`, `supportsIdempotencyKey`, `requiresPublicInputUrls`,
`supportsProviderAssetUpload`, `billable`, `testOnly`. `status()` reports configured / enabled / capability
(`available | unavailable | unknown`) and a user-language reason. Then `prepareInputs`, `submit`, `getOperation`,
optional `cancel`, `extractResult` and `download`. Nothing else in Prism infers a capability from a provider name.

Provider ids: `worldlabs_marble` (real), `mock_reconstruction` (free, test/dev only), `meshy` (reserved; no adapter
yet).

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
- **Pricing** (documented at implementation time; 1,250 credits per USD): Draft 150 credits (~$0.12), 1.0 / 1.1 1,500
  (~$1.20), 1.1 Plus 1,500–3,000 (~$1.20–$2.40). The spend ceiling is checked against the documented MAXIMUM.
- **Result**: SPZ candidates are tried best-first (`full_res`, `500k`, `100k`); one over Prism's 50 MB splat cap is
  skipped (never truncated). The collider mesh is recorded as a candidate but not imported (see gaps).
- **Scale**: `metric_scale_factor` (documented: multiply XYZ to get metres; `1.0` means "not inferred") becomes a
  `provider_estimated` calibration (`units = metres`, labelled an ESTIMATE everywhere); `1.0`/missing stays
  `unknown`. `ground_plane_offset` is recorded and used for the starting placement.

## Configuration and the spend gate

A provider is usable only when ALL of these hold:

| Switch                                                                        | Meaning                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `PRISM_RECONSTRUCTION_JOBS_ENABLED=1`                                         | the feature is on for this server                                                          |
| `WORLDLABS_RECONSTRUCTION_ENABLED=1` + `WLT_API_KEY`                          | the provider is switched on AND configured (a key alone does nothing)                      |
| `PRISM_STUDIO_ALLOW_PAID_GENERATION=true` + `PRISM_STUDIO_MAX_GENERATION_USD` | the existing live-spend gate; the documented maximum price must fit under the ceiling      |
| explicit acknowledgement                                                      | the user ticks "provider charges may apply" before **Generate Reconstruction** / **Retry** |

The gate is checked when the job is created AND again immediately before submission, before any upload: a paid-off
server never calls a billable provider (unit-tested with a spy that must stay at zero calls). Nothing is ever
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

## Use as Spatial Environment

A finished reconstruction changes nothing until the user presses **Use as Spatial Environment**. If the Set already
has an environment, **Replace current spatial environment** must be confirmed; the replaced reconstruction stays in
history. The Set must then be saved, which is what changes the Set fingerprint (and, through the existing rules,
stales camera, blocking and renders).

Only the environment actually used by the saved Set enters a GenerationPackage
(`spatialReference.spatialEnvironment.generation`: job, attempt, provider, capability, model, operation id). Jobs on
their own are Location history, not Shot truth. A visible generated splat still blocks M2C control passes.

## Tests (no real provider call)

| What                                                                  | Where                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Domain (fingerprint, order, matrix, idempotency key, sanitising)      | `src/domain/reconstruction/__tests__/job.test.ts`                                          |
| Lifecycle, paid gate, atomic ingestion, lost race (mock + memory)     | `src/server/__tests__/reconstruction-jobs.test.ts`                                         |
| World Labs adapter + fake World Labs → Prism ingestion (fake HTTP)    | `src/lib/reconstruction/__tests__/worldlabs.test.ts`                                       |
| Database (matrix, CAS, immutability, RLS, one reconstruction per job) | `npm run db:reconstruction-jobs`                                                           |
| Browser (mock provider)                                               | `e2e/zzzzzzzzzzzz-reconstruction-jobs.spec.ts`, `e2e/supabase-reconstruction-jobs.spec.ts` |

## Known gaps

- No live World Labs call has been made from Prism (by design in M2D.2); the adapter is built to the public docs and
  proved against a fake HTTP layer only. The first live use needs an operator decision.
- Mesh results (`collider_mesh_url`, Meshy) are not imported; only Gaussian splats are.
- No webhooks; no provider-side cleanup of uploaded media assets.
- An ambiguous submission is only reconcilable by hand (World Labs tag), because the API has no idempotency key.
- A job whose result could not be imported (`ingest_failed`) cannot be re-ingested from the same operation yet.
