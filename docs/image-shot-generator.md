# Image Shot Generator (Phase 2G.2)

The filmmaker can **generate several still images for a Shot, compare them, and choose one as the Shot's Production
Frame**. Image-to-video then starts from that frame automatically. This needs **no 3D set, no GPU, no reconstruction**:
the image models run at the provider.

```
SHOT PREP → Production Frame → Generate candidates
   → compare several stills → Good / Shortlist / Best / Reject
   → Use as Production Frame → the canonical Production Frame changes
   → image-to-video starts from it
```

**This milestone made no real image call and spent nothing.** Real Runway image calls: 0. Paid calls: 0. Migrations: 0
(0039 already anticipated `generation_output`). The first live smoke is a separate, explicitly approved, small spend
([below](#first-live-smoke-not-run)).

## The Shot's output vs a Production Frame candidate

These are different things and Prism keeps them apart:

|                                   | Shot output (before 2G.2)              | Production Frame candidate (2G.2)               |
| --------------------------------- | -------------------------------------- | ----------------------------------------------- |
| **Purpose** (`GenerationPurpose`) | `shot_output`                          | `production_frame`                              |
| **Request modality**              | `text_to_video` / `image_to_video` / … | `text_to_image` or `image_to_image`             |
| What it is for                    | the Shot's own moving picture          | an exploratory still a human may make canonical |
| `shot.generation.modality`        | the Shot's setting                     | **never changed**                               |

The purpose is **frozen on the attempt's immutable request** (`request.purpose`, also in `modelSettings.purpose`) and, for a
candidate set, in the set's frozen recommendation JSON (`generationPurpose`) and each member's plan. A request frozen
before 2G.2 has no purpose and is `shot_output`; a `shot_output` request is byte-identical to what it was. There is no
schema change: the columns that hold this were already immutable JSON.

Generating candidates does **not** change `shot.generation.modality`, `shot.generation.startFrameAssetId`, the Production
Frame selection, the Storyboard approval or any 3D state. Candidate generation is exploratory until a human chooses.

A Production Frame candidate attempt is also **kept out of the Shot's video flow**: it does not drive the Shot's
lifecycle badge, the pipeline "generated" count, the output attempt history, or the "this shot has changed since
generation attempt N" notice (those are about the Shot's own output attempts).

## One attempt = one image

Prism **always sends `outputCount: 1`** to the provider, even for models that could return 4 or 10 (tested for every
registered model). Three candidates are **3 attempts, 3 jobs, 3 provider requests, 3 images**: never one attempt with
three provider images. Reason: a CandidateSet member, a human review, a cost, a provenance record and a Production Frame
promotion each refer to exactly one immutable attempt.

## Models (Runway, SDK `@runwayml/sdk` 4.22.0)

One provider adapter (`runway`) serves several image models through `client.textToImage.create`. Runway is transport here;
no separate OpenAI / Gemini / ByteDance adapter exists. A model is registered **only** when its request shape, reference
limit, ratios, quality options, price and SDK typing can all be verified. Nothing is called "best": Prism recommends per
Shot from capability fit, reference preservation, framing, cost and **your** review history.

| Model                 | Role (descriptive)                   | References                      | Prompt | Price (credits/image)                                                                   |
| --------------------- | ------------------------------------ | ------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| `gpt_image_2_5_flare` | reference-rich quality               | ≤ 16, each with a **tag**       | 32,000 | quality: low 1 · medium 5 · high 16 · xhigh 28 · max 63; **+1 per reference per image** |
| `muse_image`          | inexpensive                          | ≤ 10, ordered                   | 4,000  | 1 at every size                                                                         |
| `seedream5_lite`      | alternative model family (ByteDance) | ≤ 14, ordered ("Figure 1, 2 …") | 4,000  | 4 at every size                                                                         |

$0.01 per credit (pricing version `runway-image-2026-10-21`; historical attempts are never re-priced). Sources: the
installed SDK's `TextToImageCreateParams` union, `docs.dev.runwayml.com/guides/pricing`, and the `POST /v1/text_to_image`
reference, all read 2026-10-21. See [generation-model-catalog](generation-model-catalog.md).

**Omitted, with reasons**

- `nano_banana_2.1`: listed (and priced) on Runway's pricing page, but **absent from the SDK 4.22.0 request union**. Prism
  does not bypass the typed SDK, so it is recorded in `IMAGE_SDK_BLOCKED_MODELS`; a type-level test stops compiling when a
  release types it, which is the signal to add it.
- `gemini_image3.1_flash`, `gemini_image3_pro`, `gen4_image(_turbo)`, `gpt_image_2`, `seedream5_pro`,
  `grok_imagine_image_2`, `ideogram_4_0/4_5`, `gemini_2.5_flash`: typed and priced, deliberately outside this milestone's
  three-model comparison set (one catalog entry plus a family compiler each).

**Facts the sources do not state** are recorded per model in `verification.unstated` and shown, never guessed. The main ones:
the pixel boundary between GPT Image's "1K / 2K" and "4K" price tiers (so Prism only offers canvases up to 2048 px, which are
unambiguously 1K / 2K, and no 4K canvases); how a reference tag is addressed inside the prompt (Prism writes `@Tag`, the form
Runway documents for its Gen-4 image models); and that Muse / Seedream document no reference tags (references are addressed by
order).

**Model options.** Only options that change quality or cost are exposed: GPT Image's **quality**. Its default is **explicit**
(`medium`, 5 credits), shown before spend and always sent; Prism never relies on the provider's hidden default (`high`, 16).
`background`, `grounding`, `outputCount > 1`, `auto` ratios and 4K canvases are deliberately not exposed (recorded in each
entry's `notExposed`).

## References

References come only from the Shot's explicit production data, are deduplicated by Asset, and are sent **only if the Asset has
a stored file** (a seed/placeholder record without bytes is never sent). Priority:

1. the selected **Production Frame**
2. the approved **Storyboard** frame
3. Character **identity** references
4. Character **Look** references
5. **Location** references
6. the lighting reference and the Shot's explicit references

If the Shot needs more references than a model accepts, Prism does **not** drop any silently: the candidate is **blocked** with
"N references selected; X accepts at most M". The request modality is `image_to_image` when references exist and the model takes
them, otherwise `text_to_image` (no 3D, no storyboard, no Production Frame needed).

Runway reference **tags** (3-16 characters, start with a letter, letters/digits/underscore, unique) are compiled **inside the
adapter**: `ProductionFrame`, `Storyboard`, `YumekoIdentity`, `YumekoLook`, `SeanIdentity`, `Location`, `Lighting`, `ShotRef`,
with a numeric suffix on collisions. The prompt carries a legend ("`@ProductionFrame` is Current Production Frame. …") so the
model is never asked to infer which image is which. Tags never appear in the GenerationPackage, the intent snapshot or the Shot.

## Prompt

The **same PromptPlan** as video, rendered for a still. A still shows one moment: the opening pose and each character's
expression / posture / gesture are kept; timed beats, the ending pose, timing, spoken dialogue text and negative constraints are
not sent (these models have no negative field; Prism already required the filmmaker to acknowledge that). The performance
informs emotional and pose intent only: **image models receive no audio, and Prism never claims audio conditioning.** The
reference legend is reserved first, so a long prompt can never cut it off; whatever does not fit is an acknowledged omission.

## Framing: the Production Frame vs the provider canvas

The Production Frame is the Shot's canonical aspect; the **provider canvas** is what a model can actually generate. They are
never conflated and a ratio is never mapped silently (2.39:1 is **not** "21:9"). The existing `GenerationAdaptationPlan` applies:
if the model cannot generate the exact production ratio the user sees and chooses (`overscan_for_crop`, `crop_to_production`,
letterbox / pillarbox …), the choice is acknowledged and recorded on the attempt, and the request carries the documented provider
canvas (for example the 21:9 canvas `2048×880`).

A generated provider image is stored as the **provider original** and never modified. If it already matches the production aspect
(within the 1% tolerance Production Frames use) it may be used directly. Otherwise the deterministic **delivery conform** (the
existing Phase 2C ffmpeg pipeline, which already handles stills) must exist first.

## Use as Production Frame

An explicit human action, available only for a candidate that is:

- a **succeeded** attempt of **this Shot and Project** with request purpose `production_frame` and a still-image output;
- **not stale** (below); and
- backed by a **production-shaped image**.

Image source: **(A)** the attempt's selected production conform, else **(B)** the provider original when it already matches the
production aspect, else **(C)** refused: "**Create the production conform first.**" (nothing is cropped silently). The Production
Frame is drafted by the same `draftProductionFrame` as every other source, with `source = 'generation_output'` and
`sourceGenerationAttemptId = attempt.id`. It **reuses the existing private Asset** (no byte copy, no duplicate Asset) and is
created and selected through the existing 2G.1 repository, so versions, duplicate promotion and selection behave exactly as for
any other source. It never writes `shot.generation.startFrameAssetId`.

**Best is not the Production Frame.** ⭐ Best marks the set's preferred candidate (an experiment preference). The **CURRENT
PRODUCTION FRAME** badge derives from the selected frame's `sourceGenerationAttemptId`. You may mark A Best and use B. Nothing
here uses `generation_attempts.approved` (Production Frame selection is the one canonical pointer); the legacy video "Promote to
Shot" flow is unchanged and is simply not offered for image sets.

### The stale-candidate rule

A generated image must never be promoted while pretending it depicts newer Shot intent. Before promotion Prism compares the
attempt's frozen `packageSnapshot.provenance.parts` with the current Shot over the 13 **named parts** (camera, blocking,
characters, Looks, location, props, lighting, action, performance, continuity, story, timing, constraints: the parts
`provenance.parts.overall` is built from). A difference **refuses** promotion with:

> The Shot changed after this candidate was generated. Regenerate it from the current Production Frame intent before using it.

followed by the changed parts. The candidate is never rewritten: it stays valid history, shown **STALE** relative to the current
Shot.

The selected Production Frame is handled precisely, not as a blanket "anything changed":

- A candidate generated **from Production Frame v1** (as its image reference) stays usable while v1 is canonical and becomes
  stale once **another** frame is canonical (it was an edit of v1, and v2 is now the basis). Using a refinement that _is_ the
  canonical frame again is the duplicate-promotion path, not a stale one.
- Choosing candidate A **does not** make its sibling B stale: both depict the same Shot intent, and the human may still choose B
  (otherwise Best-vs-current independence, and "A then B then back to A", could not work). So the comparison uses the named
  parts plus the frame identity a candidate actually used as a reference, rather than `parts.overall` including the selection
  part. This is a deliberate reading of the requirement; the tests pin it.

## Candidate sets and the review surface

Production Frame sets reuse CandidateSet (no second table); the planner is the existing model-comparison workflow filtered to
the still-image models (no duration, no audio; each model shows the provider canvas and the explicit quality/price before
spend). A free comparison of three mock models is offered; a recommended comparison is shown, **never auto-submitted**.

The image review board shows large stills per candidate: model, vendor family, actual dimensions, provider canvas, production
conform status, estimated and actual cost, generation time, references used / ignored inputs, quality, fresh / STALE, and the
controls Good · Shortlist · Best · Reject · Use as Production Frame (keys 1 / 2 / 3 / B stay). Copy is modality-aware: a still is
never called a clip.

## Image history and recommendation

Human reviews of image candidates feed the same model-performance framework, **separated by purpose**: an outcome record carries
`purpose`, the recommendation counts only reviews of the same purpose, and image requirements judge only still criteria (no
audio, duration or first-frame penalty for an image model). Automated continuity analysis is **not** run on image candidates.

## Spend gates

Unchanged and authoritative. A configured Runway key alone is **not** permission to spend: paid generation needs
`PRISM_STUDIO_ALLOW_PAID_GENERATION=true`, a per-attempt `PRISM_STUDIO_MAX_GENERATION_USD`, a set ceiling
`PRISM_STUDIO_MAX_CANDIDATE_SET_USD`, and an exact server-recomputed confirmation of the total. No automatic paid candidate
generation and no background experimentation.

## Output ingestion and provenance

The existing pipeline: SSRF allow-list, MIME and dimensions inspected from the bytes, checksum, private Storage, an Asset with
`purpose = generation_output`, `source = provider_output`. Frozen provenance includes provider, model, task id, purpose, request
modality, provider canvas, quality, reference roles/ids/tags, output position, actual dimensions and the provider-reported cost.
**Never** an API key, an Authorization header, a signed URL or a raw provider response.

## Safety

Owner-only RLS applies unchanged. A candidate of another Project (or another Shot) can never be used: the server refuses it, the
database's project-safe Asset key refuses a foreign Asset, and a stranger cannot even read the attempt. The deterministic
cleanup (`npm run db:generation:cleanup`) removes a mock-generated frame first (a frame pins its Asset) and never touches a frame
from any other source.

## Tests

| What                                                                                         | Where                                                      |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| promotion rules: image source, conform, stale, siblings, cross-Project/Shot                  | `src/domain/__tests__/production-frame-generation.test.ts` |
| Runway image catalog, exact SDK bodies, tags, limits, quality, pricing, prompt, results      | `src/generation/__tests__/runway-image.test.ts`            |
| memory flow: purpose frozen, Shot untouched, review, Best vs frame, dedupe, conform, history | `src/generation/__tests__/image-candidates-flow.test.ts`   |
| Runway through the worker: spend gates, 2.39 → 21:9, one request per candidate, refinement   | `src/generation/__tests__/image-runway-flow.test.ts`       |
| the real database: purpose, promotion, conform, stale, RLS, cleanup                          | `npm run db:image-shot-generator`                          |
| UI, memory mode                                                                              | `e2e/zzzzzzzzzzzzzzzz-image-shot-generator.spec.ts`        |
| UI, hosted stack (Supabase Auth, RLS, real worker, private Storage; mock provider)           | `e2e/supabase-image-shot-generator.spec.ts`                |

## First live smoke (not run)

Planned, **not executed, needs explicit approval of the spend**: one Shot, the three registered models at their default quality
with no references (about $0.10 in total), reviewed by a human. Until that is approved and run, every Runway image path above
is proven only against the fake SDK boundary.

## What 2G.2 does not do

No Location View Continuity (2G.3), Character Continuity (2G.4) or Shot Sequence Board (2G.5); no automated image QA; no
provider multi-output; no 3D requirement; no GPU. Image-to-video from the Production Frame is the existing start-frame path
(2H later generalises it).
