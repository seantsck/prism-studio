# Phase 5B-I2: GPT Image direct (`openai-image`)

I2 is the first slice that calls an image provider directly. It is built on the existing provider-neutral pipeline:

> Character / Location / Shot → image request → existing queue → worker → **OpenAI Images API** → private Storage →
> immutable generated Asset → review → Use as Character / Look / Location reference / Location View / Storyboard /
> Production Frame candidate.

**No paid call has been made.** Every test uses `FakeOpenAIImageTransport`. The first real call waits for an
owner-approved acceptance generation with a cap. Migration `0051` is still unapplied to hosted DEV, and I2 needs no
new migration.

## 1. API and SDK audit (2026-11-07)

Sources: `openai@7.32.0` (`resources/images.d.ts`), the image-generation guide, the images/edit reference, the pricing
page, the deprecations page, the model pages, and the data-controls guide (all on developers.openai.com).

- **Models used: `gpt-image-2.5-flare` and `gpt-image-2.5-sunburst`.**
  - Both are recommended "for new integrations".
  - Both are typed by the SDK.
  - Both have GA transparent backgrounds.
  - Both are eligible for Zero Data Retention.
- **Models not used:**
  - 2.6: documented and priced, but not in SDK 7.32.0 and not ZDR-listed.
  - gpt-image-2: transparency is preview only.
  - gpt-image-1.5, 1-mini and chatgpt-image-latest: shut down 2026-12-01.
  - gpt-image-1 and dall-e: already shut down.
- **The Responses API image tool is not used.** The 2.5 and 2.6 model pages say Responses is unsupported, so I2 uses
  `images.generate` and `images.edit`.
- **The call is synchronous** and the image is returned only as `b64_json`.
- **Edits:**
  - up to 16 input images;
  - `mask` is a PNG with alpha, the size of the first image, and applies to the first image;
  - masked inpainting is prompt-guided and "may not match its shape exactly";
  - `input_fidelity` must be omitted for gpt-image-2 and is not stated for 2.5, so it is omitted.
- **Transparency:** `background: "transparent"` with png or webp output.
- **Pricing is token-based:** text in $5, image in $8, image out $30 per 1M tokens. There is no per-image price, and no
  output-token counts are published for 2.5.
- **Moderation:** `moderation_blocked` is mapped to `content_rejected`, which is final.
- **No idempotency key.** Retries are disabled in the SDK, and an ambiguous call is never re-sent.
- **SDK and docs disagree** in a few places, and Prism follows the SDK types for them: 2.6, gif/svg output, `markup`,
  `complexity`, and the REST `images` field are missing from the SDK. Prism exposes none of these.

## 2. Architecture

| Piece                                                 | Where                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model definitions (separate from the adapter)         | `src/domain/generation/models/openai-image-catalog.ts`; `catalogModel()` searches every provider                                                 |
| Adapter (translate, validate, estimate, call, result) | `src/generation/providers/openai-image/adapter.ts`                                                                                               |
| Transport boundary                                    | `transport.ts` (neutral types), `sdk-transport.ts` (the ONLY importer of `openai` here; loaded with `await import`), `fake-transport.ts` (tests) |
| Registration                                          | `createRegistry()` always registers it. It is enabled per deployment with `PRISM_STUDIO_GENERATION_PROVIDERS`                                    |

### Credentials

- The key is `PRISM_STUDIO_PROVIDER_OPENAI_IMAGE_API_KEY`. It is **worker only** and separate from the continuity
  analyzer's `OPENAI_API_KEY`, so spend and limits are isolated.
- The web sets `PRISM_STUDIO_WORKER_BACKED_PROVIDERS=openai-image`. It can then list, compare, price, validate and queue
  without the secret.
- A worker without the key fails closed. If the list is absent, nothing is treated as worker-backed (`352a663`).

### Synchronous provider on an async queue

- `submit` makes the one billable call and returns `succeeded`.
- The worker now ingests straight away **under the same lease** (`worker.ts`), the same way a poll that finds success
  already does.
- The bytes live only in that process until they are ingested. If the process dies in between, the job fails with
  `openai_image_result_not_retained` ("OpenAI may have billed it"). OpenAI is never called again.

### Requests

- One attempt is one image: `n=1`, always PNG.
- Offered: sizes 1024², 1536×1024, 1024×1536, 1536×864 and 864×1536; quality low, medium (the default) or high.
- Every exclusion is listed in the catalog's `notExposed` with its reason.

### Estimate and actual cost

- **The estimate is a deterministic upper bound, and it is provisional.** It uses the published output-token counts
  for the largest standard size × 1.5, plus ≤6,000 image-input tokens per reference, plus prompt text bounded by its
  UTF-8 byte length.
- **Calibrate it from the `usage` of the first approved paid run.**
- **The actual cost** always comes from the reported `usage`. If no usage is reported, the cost is recorded as unknown.

## 3. Editing and lineage (never overwrite)

- `prepareSubjectImage({ …, edit: { sourceAssetId, instruction } })` sends the source **first**, as "the image to
  edit", followed by the subject's other references (up to 16 in total).
- The instruction goes into the prompt plan, which is what the provider receives.
- Lineage is source Asset → attempt → new Asset:
  - the attempt records `modelSettings.editSourceAssetId` and the source in `inputAssetIds`;
  - the output is ingested as a **new** immutable Asset with `metadata.generation`;
  - the source is never modified.
- While that attempt exists, the source is pinned by the 0051 asset-usage gate (`subjectImageAssetPins`).
- The new image is promoted separately with the existing "Use as …" actions.

## 4. Transparency

- It is explicit: `options: { background: "transparent" }`.
- It is refused, never emulated, for a model without native transparency.
- It is stored as an RGBA PNG, with MIME, dimensions and checksum read by ingestion. The provenance records the
  requested and reported background, size, quality, format, usage and the output's SHA-256.
- OpenAI documents C2PA metadata and a SynthID watermark on API images.

## 5. Tests (fake transport only)

`src/generation/__tests__/openai-image.test.ts` has 14 tests:

- **Registration and availability:**
  - registered with both models as paid;
  - not usable by default;
  - web available without the key when worker-backed;
  - worker fails closed without the key;
  - paid gate closed → refused with no call.
- **Pure checks:**
  - generations vs edits endpoints and fields;
  - refusals for an unsupported ratio, quality or background;
  - the estimate is monotonic, deterministic and an upper bound.
- **Through the real queue and worker:**
  - one call;
  - a stored PNG with checksum;
  - actual cost from usage, at or below the estimate;
  - the key never persisted.
- **Edit:** a new Asset, the source unchanged, the source sent first, the instruction in the prompt.
- **Transparency:** RGBA survives ingestion; refused for the mock model.
- **Failures:**
  - a timeout is never re-sent;
  - moderation is final;
  - a lost result is reported honestly;
  - no key → refused before any call.

`openai-security.test.ts` now allows exactly two SDK importers and checks that the image transport is only loaded
lazily.

## 6. Next in I2

1. "Edit image" and "Transparent background" controls on the Character and Location image panels (the server actions
   pass `edit` and `options`). The same goes for the Shot image entry points once #65 is integrated.
2. A masked edit, in the adapter only, when a mask Asset is supplied. The API supports it cleanly but the result is
   best-effort, and the UI will say so.
3. The owner-approved controlled acceptance generation: one capped paid call to calibrate the estimate.

FLUX: see [phase-5b-flux-host-decision](phase-5b-flux-host-decision.md). The research is done; there is no code until
the owner chooses a host.
