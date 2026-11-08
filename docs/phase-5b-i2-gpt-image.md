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

- **Default OpenAI image models (where privacy / ZDR matters): `gpt-image-2.5-flare` and `gpt-image-2.5-sunburst`.**
  - Both are recommended "for new integrations".
  - Both are typed by the SDK.
  - Both have GA transparent backgrounds.
  - Both are listed in the current Zero Data Retention compatibility documentation.
- **`gpt-image-2.6-sunburst` and `gpt-image-2.6-flare`: available upstream, not yet default.**
  - They exist in the Image API (released 2026-11-04).
  - They are NOT currently listed as ZDR-compatible.
  - They are recorded in the catalog as `OPENAI_IMAGE_UPSTREAM_NOT_DEFAULT`: known to the architecture, not offered as
    models. They become offerable only when all three conditions hold:
    1. the installed SDK / API integration path is clean: typed by the pinned SDK, with no untyped workaround;
    2. Prism's privacy requirements are satisfied;
    3. their ZDR status is acceptable for unreleased customer material.
- **Other models not used:**
  - gpt-image-2: transparency is preview only.
  - gpt-image-1.5, 1-mini and chatgpt-image-latest: shut down 2026-12-01.
  - gpt-image-1 and dall-e: already shut down.
- **Images API, not the Responses tool.** GPT Image 2.5 CAN be used through the Responses API image-generation tool.
  Prism still uses the direct Images API (`images.generate` / `images.edit`) for this worker adapter, because the
  execution model is a discrete generation or edit job, not a conversational image session. One request is one
  attempt is one image, priced and gated before it is queued.
  - Correction: an earlier draft of this document said the Responses API was unsupported for 2.5. That was wrong.
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
- **SDK and docs disagree** in a few places, and Prism follows the SDK types for them: 2.6 model ids, gif/svg output,
  `markup`, `complexity`, and the REST `images` field are missing from the SDK. Prism exposes none of these, and adds no
  untyped workaround to reach them.

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

## 6. Creator-facing controls

None of these adds a new review system. Every result is an ordinary generated image, promoted with the existing
"Use as …" actions.

### Character panel (`subject-image-panel.tsx`)

- **Generate Image** has a simple **Transparent background** checkbox. Quality is under Advanced.
- **Edit Image** has:
  - a source image: any of the Character's references, Look images or generated images;
  - an edit instruction;
  - a model: only models that can edit;
  - a Transparent background checkbox;
  - Advanced settings: aspect ratio and quality.
- An edited result shows its lineage: **Source → edit attempt #N → this new image**.
- It is promoted with **Use as Character Reference** or **Use as Look**.

### Location panel

- The same **Edit Image** and **Transparent background** controls.
- Results are promoted with **Use as Location Reference**, or with **Use as Location View**. The view is new: it
  references the image and creates the view through the existing 2G.3 action, and it respects the Location lock.

### Shot panel (`shot-image-actions.tsx`, Shot Prep → Production Frame)

- **Edit Image** has:
  - a source: one of THIS Shot's stills, which the server re-checks with `shotEditableAssetIds`;
  - an instruction;
  - a model;
  - a Transparent background checkbox.
- The edit is a new **Production Frame candidate**, made through the existing candidate-set workflow with
  `applyImageEdit`. The source is sent first, the instruction goes into the plan, and the edit is priced before the
  creator confirms it.
- The generated still shows its lineage and keeps **Use as Production Frame** and **Use as Storyboard Frame**.

### Transparency

- It is refused, never faked, for a model without native transparency:
  - the subject path checks it in `prepareSubjectImage`;
  - the Shot path checks it with `transparencyBlockers` in the gate.
- Output is always PNG. MIME, alpha, dimensions, checksum and provenance are stored normally.
- A future "Generate Character Cutout" will build on this. The full background-removal workflow stays in I3.

### Masked edits: I2b / I3 follow-up

The API supports masks (a PNG with alpha, applied to the first image), and the transport already carries a `mask`
field, which the adapter currently always sends as `null`. The result is best-effort by OpenAI's own documentation,
and a usable mask needs a painting UI. So the core Edit Image workflow ships without masks, and masked inpainting is
tracked as **I2b / I3 follow-up**.

## 7. Acceptance evidence (automated, zero paid calls)

| Gate                                                                                                  | Test                                                                                             |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| text-to-image path; one call; stored PNG; actual cost from usage                                      | `openai-image.test.ts`                                                                           |
| source-image edit path; edit creates a NEW asset; source unchanged; source → attempt → output lineage | `openai-image.test.ts`, `image-edit-actions.test.ts` (Character, Location, Shot)                 |
| transparent PNG path (RGBA survives ingestion)                                                        | `openai-image.test.ts`                                                                           |
| unsupported transparency refused (subject and Shot paths)                                             | `openai-image.test.ts`, `image-edit-actions.test.ts`                                             |
| key worker-only; the web queues worker-backed OpenAI without the key; the worker fails closed         | `openai-image.test.ts`, `openai-security.test.ts`                                                |
| spend gate applies                                                                                    | `openai-image.test.ts` (paid off → refused, no call)                                             |
| an uncertain synchronous call is not retried                                                          | `openai-image.test.ts` (timeout → one call, `submission_outcome_unknown`)                        |
| Character, Look, Location reference, Location View promotion                                          | `image-edit-actions.test.ts`                                                                     |
| Production Frame candidate promotion intact                                                           | `image-edit-actions.test.ts`; browser story F                                                    |
| zero paid API calls                                                                                   | every provider call goes to `FakeOpenAIImageTransport`; browser stories use the free mock models |

## 8. Next

1. The owner-approved, controlled acceptance generation: one capped paid call, to calibrate the provisional estimate
   from the reported usage.
2. I2b / I3: masked edits and the Character Cutout / background-removal workflow.

FLUX: see [phase-5b-flux-host-decision](phase-5b-flux-host-decision.md). The research is done; there is no code until
the owner chooses a host.
