# Generation model catalog (Phase 2E)

Prism answers **"what generator should I use for THIS shot?"**, not "which model is best overall". The catalog is the
factual half of that answer: what each model can take, what it costs, and how sure Prism is of each statement.

It is **versioned application configuration**. Nothing is scraped at runtime and nothing is inferred from marketing.

## Where it lives

| Piece                                            | File                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Vocabulary (`CatalogModel`, `Support`, pricing)  | `src/domain/generation/models/types.ts`                            |
| The Runway video set + pricing + helpers         | `src/domain/generation/models/catalog.ts`                          |
| Catalog → provider-independent `GenerationModel` | `toGenerationModel()` (same file)                                  |
| Request shapes per model family                  | `src/generation/providers/runway/families.ts`                      |
| The adapter (one class, dispatches by family)    | `src/generation/providers/runway/adapter.ts`                       |
| Shot requirements and feature profile            | `src/domain/generation/models/requirements.ts`                     |
| Per-shot fit matrix (what each model receives)   | `src/domain/generation/models/matrix.ts`                           |
| UI                                               | Shot Prep → Generate → _Compare models_; `/projects/<slug>/models` |

Adding a model is **one catalog entry** (plus a family compiler only when its request shape is genuinely new). No
provider class per model, no model logic scattered through the app.

## Capability honesty: supported / unsupported / unknown

Each capability is `supported`, `unsupported` or `unknown`. `unknown` means the official documentation / SDK types do
not state it. Prism then says **UNKNOWN** instead of guessing in either direction, and the compatibility matrix lists
the unknowns that matter for the shot at hand. The SDK types often say only `duration: number`; the
**API reference** (`docs.dev.runwayml.com/api.md`, POST /v1/image_to_video) states the real range per model, so
Prism reads both and records which one stated what. A bound that neither states stays `verified: false` (Seedance 2.5's
minimum) and is shown as "bounds unverified". Phase 2E.1 corrected the first-release ranges: Gen-4 Turbo and Hailuo 3
had been recorded as unknown, which let a 2 s Hailuo request reach the provider and be rejected (HTTP 400).

Every entry carries `verification`: `verifiedAt`, the sources read, `sdkVersion` (`@runwayml/sdk@4.21.0`),
`providerApiVersion` (`2024-11-06`) and an explicit `unstated` list.

## The initial comparison set (6 models, verified 2026-10-14)

| Model         | Role (descriptive, not a ranking) | Inputs                                                      | Duration                                    | Price (credits/s)                              |
| ------------- | --------------------------------- | ----------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `gen4.5`      | Runway flagship                   | start frame only (i2v) or text                              | whole seconds 2–10                          | 12                                             |
| `gen4_turbo`  | lower cost / faster               | start frame **required** (i2v only)                         | whole seconds 2–10                          | 5                                              |
| `seedance2_5` | reference-rich                    | first/last frame **or** ≤ 30 reference images, audio, video | ≤ 30 s; min **unverified** (planned as 4 s) | 20 / 30 / 68 at 480p / 720p / 1080p, min 80 cr |
| `hailuo3`     | cinematic competitor              | first/last frame **or** ≤ 9 reference images, audio, video  | whole seconds **5–15**                      | 10 (768p) / 15 (2K) + 2 cr per image/keyframe  |
| `veo3.1_fast` | fast Veo, native audio            | first + last frame, negative prompt                         | exactly 4 / 6 / 8 s                         | 10 (15 with audio)                             |
| `veo3.1`      | premium Veo, native audio         | first + last frame, negative prompt                         | exactly 4 / 6 / 8 s                         | 20 (40 with audio)                             |

## The still-image set (3 models, verified 2026-10-21, Phase 2G.2)

`RUNWAY_IMAGE_MODELS` (`src/domain/generation/models/image-catalog.ts`) beside `RUNWAY_VIDEO_MODELS`; `RUNWAY_MODELS` is the
combined catalog. An image entry adds `image` (quality options with Prism's explicit default, reference addressing, output
formats, what is deliberately not exposed) and an `imageRule` price (credits per image by quality and canvas tier, credits per
reference, per-output or per-request). Each entry carries SDK `@runwayml/sdk@4.22.0`, API version, sources, pricing version
`runway-image-2026-10-21` and an `unstated` list.

| Model                 | Role                     | References    | Prompt | Price (credits/image)                                            |
| --------------------- | ------------------------ | ------------- | ------ | ---------------------------------------------------------------- |
| `gpt_image_2_5_flare` | reference-rich quality   | ≤ 16, tagged  | 32,000 | low 1 · medium 5 · high 16 · xhigh 28 · max 63, +1 per reference |
| `muse_image`          | inexpensive              | ≤ 10, ordered | 4,000  | 1                                                                |
| `seedream5_lite`      | alternative model family | ≤ 14, ordered | 4,000  | 4                                                                |

`nano_banana_2.1` appears on Runway's pricing page but not in the SDK 4.22.0 request union: recorded in
`IMAGE_SDK_BLOCKED_MODELS`, not offered. A model whose request shape, limits, ratios, price and typing cannot all be verified
is omitted. The video facts did not change with the SDK bump: the SHA-256 of the video and task request type files is pinned in
`runway-image.test.ts`. See [image-shot-generator](image-shot-generator.md).

Not offered, deliberately:

- **Kling 3.0** (`kling3.0_standard` / `kling3.0_pro` / `kling3.0_4k`): the API reference documents them under
  `image_to_video` (3–15 s, first/last frame, `providerSettings.multiPrompt`, `audio` defaulting to true; 9/13,
  12/17 and 43 credits/s), but **no published `@runwayml/sdk` (4.21.0, 4.22.0) types them** in the video request
  unions (Kling appears only under the organization usage types). Prism does not bypass the typed SDK with casts and
  does not hand-roll a REST client for one vendor, so they are recorded in `SDK_BLOCKED_MODELS` (facts + blocker) and
  NOT offered. A test fails when an SDK upgrade starts typing them: that is the signal to add real catalog entries.
  Earlier phases' "Kling is absent from the docs" was wrong in framing: it is present in the docs, absent from the SDK.
- The other 40+ hosted models: the set is small so comparisons stay meaningful. Each is one catalog entry later.
- Runway's own **Model Router** is _not_ used. Prism needs shot-specific production truth, human history and a
  transparent choice that can later span providers. It can be documented as a future provider-side fallback.

## First/last frame vs reference images (a real provider constraint)

Seedance and Hailuo document: _"Use position first/last for keyframe mode, or omit position for reference images. The
two modes cannot be mixed."_ Prism therefore makes the **input mode** an explicit, visible choice (never a silent
drop):

- **Keyframes** (default when a storyboard frame exists): the approved storyboard frame is the exact first frame;
  identity/Look/location references are listed as **NOT USED (mode)** and must be acknowledged.
- **References**: text-to-video with up to 30 (Seedance) / 9 (Hailuo) reference images; the storyboard frame joins them
  as a reference (role `storyboard`) and is _not_ the exact first frame (acknowledged).

The compatibility engine (`evaluateCompatibility`) implements this behind the optional capability flag
`keyframesExcludeReferences`; models without it are unaffected.

**Animate Production Frame (Phase 2H)** reuses the same six video models with no second catalog, but judges them as
image-to-video from the canonical Production Frame: a model without `image_to_video` is incompatible (never a
text-to-video fallback), and a keyframe-exclusive model always runs in keyframe mode (reference mode is not offered); the
references it cannot take are disclosed as represented by the Production Frame. The free `mock-video-t2v` (text-to-video
only) exists to exercise that rule. See [image-to-video](image-to-video.md).

## Audio

Native audio (`audio: true` on Veo/Seedance) is advertised but **OFF by default** and priced when on. It never replaces
Prism's selected performance, which stays production truth. Where a model accepts reference audio (Seedance, Hailuo)
the performed take is supplied as _context_, not as exact lip sync, and the matrix says so.

## Pricing

Versioned (`runway-2026-10-13`), source `docs.dev.runwayml.com/guides/pricing`, $0.01 per credit. `estimateCredits()`
implements per-second by tier, audio surcharge, per-reference-image credits, reference-video seconds and minimums.
**Historical cost is never re-priced**: actual spend always comes from the provider-reported credits at ingestion;
estimates are stored with their pricing version. Seedance 2.5 audio is priced as silent because the published table
lists no audio surcharge (Veo lists one explicitly).

## Availability

`availability: available | unavailable | deprecated | retired`. An unavailable model stays in the catalog (historical
attempts remain interpretable) and is shown as such; it is never selectable.

## Duration is enforced before the provider

A shot duration outside a model's documented range is never sent natively and never rounded. The compatibility engine
reports `duration.unsupported` and the matrix classifies the model **ADAPTATION REQUIRED** only when Prism has an explicit
strategy (`generate_longer_then_trim`: generate the next supported length, trim the delivery). It then shows
_Production 2 s · Provider generation 5 s · Delivery trim 2 s_ and **prices the full provider generation**. When the shot
is longer than the model's maximum there is no strategy and the model is UNSUPPORTED. Veo (4/6/8 s only) works the same
way. Regression tests pin: 2 s Gen-4 Turbo is native; 2 s Hailuo 3 needs the trim strategy (priced at 5 s); 5 s Hailuo is
native; Seedance's 4 s lower bound; Gen-4.5's 2–10 s.

## Validation

`phase2e-models.test.ts`: registry validity, capability normalization, pricing arithmetic, ratio tables, family
request bodies (including that gen4/Seedance/Veo/Hailuo bodies differ), refusal of provider-impossible combinations.
