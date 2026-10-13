# Framing and duration adaptation (Phase 2C)

> **Production frame ≠ Provider canvas ≠ Delivery frame.**

A production shot may be **2.39:1 / 4.5 s** while a generation model offers **16:9 / 5 s**. Prism never mutates
the production shot to fit a provider. Instead:

```
PRODUCTION INTENT
  → GENERATION ADAPTATION PLAN      (explicit, user-chosen, acknowledged, frozen on the attempt)
  → PROVIDER CANVAS                 (what the model is actually asked for)
  → PROVIDER OUTPUT                 (immutable original)
  → DELIVERY CONFORM                (deterministic crop / pad / trim → a NEW derived Asset)
  → CONTINUITY QA                   (advisory)
  → HUMAN APPROVAL
```

## The three frame spaces

| Space               | Meaning                                 | Where it appears                                           |
| ------------------- | --------------------------------------- | ---------------------------------------------------------- |
| **Production**      | What the filmmaker designed (2.39:1)    | Shot, bible, animatic, package, QA expectations            |
| **Provider canvas** | What the model accepts (16:9, 1280×720) | Generate panel overlay, the request, the provider original |
| **Delivery**        | Final conformed media (2.39:1)          | Delivery master asset, continuity review                   |

The production frame stays 2.39:1 everywhere production-facing (bible, animatic, package snapshot, QA criteria).
The 16:9 canvas exists only in execution/adaptation contexts. `bible.aspectRatio` is the canonical production
format; optional explicit pixel dimensions (`delivery_width/height`, `target_codec`, `audio_sample_rate`,
migration 0019) are never invented and are `null` until someone sets them.

## GenerationAdaptationPlan

`src/domain/framing/adaptation.ts` (pure). Built by the compatibility engine for every model, frozen on the
attempt as `generation_attempts.adaptation_plan` (immutable, migration 0019). It is **not** the
GenerationPackage: the package says what the film is; the plan says what execution gives up.

Fields: `production` (aspect ratio, duration, fps), `provider` (provider/model), `framing` (strategy, provider
ratio + canvas, retained crop window, discarded fraction, safe areas, protected notes, usable options,
recommendation), `duration` (strategy, production/provider duration, trim), `promptAdaptation`
(production instruction vs provider adaptation, separate), `acknowledgements`, `warnings`, `blockedReasons`,
`conform` (the DeliveryConformPlan), `fingerprint` (content hash, stable). No secrets, ever.

### Framing strategies

| Strategy             | Meaning                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `native`             | The provider offers the production ratio. Nothing to adapt.                     |
| `crop_to_production` | Provider generates a larger frame; Prism crops it afterwards.                   |
| `overscan_for_crop`  | As above, plus a provider-side prompt hint to compose inside a protected region |
| `fit_with_letterbox` | Whole provider picture kept, padded top/bottom (provider wider than production) |
| `fit_with_pillarbox` | Whole provider picture kept, padded left/right (provider narrower)              |
| `blocked`            | No acceptable strategy is chosen/possible                                       |

Prism **recommends** a strategy (overscan when a crop is possible) but never selects one: until the user chooses,
the model is incompatible and the plan is `needs_choice`. A crop that would discard more than 60 % of the picture
(e.g. 9:16 → 2.39:1) is blocked as unreasonable.

### Duration strategies

`native`, `generate_longer_then_trim` (smallest supported duration ≥ production, then trim to production),
`generate_shorter_and_extend` (declared, **not available**: always blocked, no extension step exists) and
`blocked`. Production timing is never changed: 4.5 s stays 4.5 s; the provider is asked for 5 s and the
delivery master is trimmed.

### Crop math (`src/domain/framing/crop.ts`)

`centerCrop(canvas, targetRatio)` returns the largest centred rectangle with the target ratio in **integer, even**
pixels (yuv420-safe), never off-canvas. 1280×720 → 2.39:1 gives `x 0, y 92, 1280×536` (25.6 % discarded). Works for
arbitrary ratios and sizes; `padToFrame` does the same for letterbox/pillarbox. The plan stores the crop window as
0..1 fractions; the conform step re-resolves it against the **actual** probed output (a provider's real size may
differ from the planned canvas).

## Acknowledgements

Non-native adaptation produces `adaptation.framing` / `adaptation.duration` entries in the compatibility
report's ignored features, so they use the existing acknowledgement gate: the user must tick each before any
generation (mock included — there is no development bypass), and the acknowledged ids are recorded on the attempt.

## Prompt adaptation

The PromptPlan gains one section, `provider_adaptation`, built only for `overscan_for_crop`
("compose primary subjects within a centered 2.39:1 protected region; preserve additional vertical visual
information above and below for crop flexibility", plus protected-composition notes). The production
camera/composition lines are never rewritten. The Prompt Inspector and the attempt page show the production
instruction and the provider adaptation separately.

## Protected composition

`shot.generation.protectedComposition` is manual production intent about the final frame ("Yumeko's eyes inside
the crop", "keep the doorway fully visible"). It is edited in the Generate panel, is not part of any freshness part
(editing it does not stale a storyboard), flows into the plan and into QA criteria. No computer vision is used.

## UI

Generate panel (Shot Prep): a model that needs adaptation shows the choice selects (nothing preselected), the
**frame overlay** (full provider canvas, protected crop box, hatched discard regions, action/title safe guides,
centre lines, storyboard frame underneath), production vs provider frame/duration, the discarded share, and the
acknowledgements, all before any spend. Attempt review shows **provider original / production target /
conform** side by side, an original ↔ final-crop ↔ split player (CSS clip preview when no delivery file exists),
and the frozen plan.

## Backward compatibility

Attempts created before Phase 2C have `adaptation_plan = null` and render as "No adaptation plan recorded".
Nothing is back-filled or guessed.
