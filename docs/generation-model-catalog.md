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
the unknowns that matter for the shot at hand. Example: Gen-4 Turbo's SDK type is `duration?: number` with no range,
so its duration bounds are `verified: false` and shown as "bounds unverified" (the range is a permissive superset; the
provider is the authority and a rejected request is free).

Every entry carries `verification`: `verifiedAt`, the sources read, `sdkVersion` (`@runwayml/sdk@4.21.0`),
`providerApiVersion` (`2024-11-06`) and an explicit `unstated` list.

## The initial comparison set (6 models, verified 2026-10-14)

| Model         | Role (descriptive, not a ranking) | Inputs                                                      | Duration                    | Price (credits/s)                              |
| ------------- | --------------------------------- | ----------------------------------------------------------- | --------------------------- | ---------------------------------------------- |
| `gen4.5`      | Runway flagship                   | start frame only (i2v) or text                              | whole seconds 2–10          | 12                                             |
| `gen4_turbo`  | lower cost / faster               | start frame **required** (i2v only)                         | bounds not documented       | 5                                              |
| `seedance2_5` | reference-rich                    | first/last frame **or** ≤ 30 reference images, audio, video | ≤ 30 s (minimum not stated) | 20 / 30 / 68 at 480p / 720p / 1080p, min 80 cr |
| `hailuo3`     | cinematic competitor              | first/last frame **or** ≤ 9 reference images, audio, video  | bounds not documented       | 10 (768p) / 15 (2K) + 2 cr per image/keyframe  |
| `veo3.1_fast` | fast Veo, native audio            | first + last frame, negative prompt                         | exactly 4 / 6 / 8 s         | 10 (15 with audio)                             |
| `veo3.1`      | premium Veo, native audio         | first + last frame, negative prompt                         | exactly 4 / 6 / 8 s         | 20 (40 with audio)                             |

Not offered, deliberately:

- **Kling**: absent from the Runway SDK's video request types (4.21.0 and 4.22.0). Prism does not invent a model id.
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

## Validation

`phase2e-models.test.ts`: registry validity, capability normalization, pricing arithmetic, ratio tables, family
request bodies (including that gen4/Seedance/Veo/Hailuo bodies differ), refusal of provider-impossible combinations.
