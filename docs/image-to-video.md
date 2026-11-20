# Image-to-Video (Phase 2H)

Phase 2G made the Shot's canonical still: the **Production Frame**. Phase 2H makes it move.

> The selected, current Production Frame is the canonical first-frame source for the video model.

It is never replaced by an approved or draft Storyboard, a generic Location reference, a manual start-frame override,
text-to-video because a provider preferred it, or a similar regenerated image. When a provider's prompt-image aspect
contract cannot accept the canonical frame directly, Prism may create a deterministic **provider-only transport frame**
that contains the same Production Frame pixels on the frozen provider canvas. That transport never becomes canonical,
never changes the Production Frame Asset, and is disclosed before spend and in provider provenance.

2H is an execution contract plus a workflow. It reuses everything that already exists: generation attempts and jobs,
the worker, the Runway adapter, the model catalog, candidate sets, human review, cost estimates and spend gates,
delivery conform, continuity QA and final Shot approval. No migration, no new table, GenerationPackage stays **v5**,
the freshness parts are unchanged. No GPU, COLMAP, Brush or 3D set is required.

## The purpose: `animate_production_frame`

A provider-independent `GenerationPurpose`, frozen on the attempt's request (`request.purpose`) and on the candidate
set's recommendation JSON (`generationPurpose`):

| Purpose                    | Meaning                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `shot_output`              | generic Shot-output generation (every request without a purpose: history is never rewritten)          |
| `production_frame`         | a still candidate for the canonical Production Frame (2G.2)                                           |
| `animate_production_frame` | a Shot-output VIDEO whose canonical first-frame source is the selected, current Production Frame (2H) |

An animation **is a Shot-output attempt**, not a Production Frame candidate: `isProductionFrameAttempt()` is false, the
pipeline includes it, human review / Best / final approval apply, and the Production Frame selection never changes.
Unknown purpose values parse as `shot_output` (`parseGenerationPurpose`), so an unexpected record never crashes.

No database CHECK constrains the purpose: it lives in JSON (request, model settings, set recommendation).

## The source rules (hard, never acknowledgeable)

`animationSource(pkg)` (`src/domain/generation/animation.ts`) reads only the frozen package:

| Situation                                                                | Result                                                                                                                                                                |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no selected Production Frame                                             | **BLOCKED**: "Choose a Production Frame before animating this Shot." (no Storyboard / text-to-video fallback)                                                         |
| the selected frame is stale (`productionFrameFreshness`)                 | **BLOCKED**, naming what changed. Update, reselect or create a current frame; there is no acknowledgement around it                                                   |
| a manual `shot.generation.startFrameAssetId` that differs from the frame | **BLOCKED**: "This Shot has a manual start-frame override that differs from the canonical Production Frame. Clear the override or use the generic Generate workflow." |
| a manual override equal to the frame's own Asset                         | allowed                                                                                                                                                               |

Generic **Generate** keeps its historical start-frame precedence (override → Production Frame → Storyboard). Only the
dedicated workflow is stricter.

## Canonical start frame and image-to-video only

For `animate_production_frame` the compatibility engine:

- chooses `image_to_video` and nothing else. A model without image-to-video is **INCOMPATIBLE** ("Animate Production
  Frame requires exact first-frame conditioning. This workflow requires image-to-video from the canonical Production
  Frame."), never a text-to-video fallback;
- takes the start frame **only** from `pkg.references.productionFrame.assetId`;
- never sends the frame a second time as a `production_frame` reference (one Asset, one input slot), and does not send
  the Storyboard it supersedes;
- keeps the end frame's existing semantics (used when supported, otherwise acknowledged as not used). No end frame is
  generated automatically.

The resulting request has `purpose: "animate_production_frame"`, `modality: "image_to_video"` and
`startFrameAssetId === package.references.productionFrame.assetId`.

### The approved Storyboard is not sent

Animate Production Frame does **not** separately send the approved Storyboard (neither as start frame nor as a
reference), even when one exists. This is intentional: the selected Production Frame supersedes the Storyboard as the
visual source and is the exact first frame. Sending both would give the model two competing truths about composition
and reference, and the Storyboard would win nothing the frame has not already fixed. The comparison disclosure says
"Exact first frame: Production Frame vN" and does not list the Storyboard.

### The adapter invariant

`animationRequestViolations(request, packageSnapshot)` is checked when the attempt is prepared AND again by the worker
right before `adapter.submit` (provider-independent). It refuses any animation request that is not image-to-video, has
no start frame, starts from anything but the frozen frame, or also sends the frame as a reference. If a frozen
`prismStartFrameTransport` exists, its `sourceAssetId` must be that same frozen Production Frame. A refused job fails
with `animation_source_invalid`; the provider is never called.

### Provider-only start-frame transport

Some providers constrain the **prompt image** more tightly than Prism's production frame. Prism does not solve that by
changing the Production Frame or allowing the provider to auto-crop it. The immutable request freezes
`providerOptions.prismStartFrameTransport` with the canonical source Asset, policy, provider canvas and background.

For Runway the current policy is `contain-pad-v1`:

- FFmpeg reads the canonical Production Frame bytes locally;
- the complete frame is uniformly scaled to **contain** inside the provider canvas (up or down as needed), never cropped;
- the remaining axis is center-padded black;
- for Shot 3A, 1536×642 becomes 1584×662 plus 5 px top/bottom; the 2.39:1 delivery crop removes that padding;
- the transient transport image is sent to Runway and never becomes a Prism canonical Asset;
- Runway's output still follows the already-frozen delivery conform back to the production aspect ratio.

The request preview names the transport and target canvas. Provider result provenance records the same frozen transport
metadata, so a worker restart cannot silently change how the first frame reached the provider.

**Provider canvas = verified pixels, not label arithmetic.** An aspect label (`21:9`) describes the provider's mode;
the catalog's verified pixel value for that label (`1584:672` on Runway Gen-4 Turbo) is the request and transport
canvas. Model capabilities expose it as `video.providerCanvases`, and the framing planner uses it (`canvasSource:
"provider"`) before any requested or nominal canvas. Re-deriving height from `21/9` gave 1584×678, which the adapter
correctly refused; the adapter invariant (frozen canvas = provider canvas, exactly) is unchanged. Providers without
documented pixel canvases keep the previous requested/nominal planning.

**Delivery removes exactly the transport padding.** The transport placement is a pure function of the frozen policy,
the provider canvas and the canonical source size (`attemptTransportGeometry`). When the provider output is exactly the
transport canvas, `resolveConform` crops to that content rectangle (Shot 3A: 1584×662 at y=5 inside 1584×672) and
centre-crops inside it only if the content is not already the target ratio. FFmpeg's crop uses `exact=1` for odd
rectangles: on yuv420p it otherwise rounds y=5 to y=4. The generic even centre crop (y=4) had left a 1 px padding
row. Attempts without a transport, or outputs of another size, keep the generic conform (the latter with a warning).

### Pre-pad transport for narrow prompt-image ranges (`contain-prepad-center-crop-v1`)

Some models accept a narrower prompt image than the output they produce. Runway Gen-4.5 documents a prompt-image
width/height range of 0.5–2.0 but a `1584:672` (≈2.357) output; its API "Inputs" page also documents that a prompt image
whose aspect differs from the requested `ratio` is centre-cropped to that ratio (verified 2026-11-10; recorded as
`inputs.promptImageCrop` in the catalog — only models with that documented fact may use this policy).

When the verified output canvas is outside the model's prompt-image range, `buildGenerationRequest` freezes an explicit
record instead of `contain-pad-v1` (`planPrepadCenterCrop`, pure):

| Field              | Shot 3A (Gen-4.5)                             |
| ------------------ | --------------------------------------------- |
| `source`           | 1536×642 (canonical, never modified)          |
| `content`          | 1584×662 (uniform scale, no crop)             |
| `submittedCanvas`  | 1584×792 (exactly 2:1, inside 0.5–2.0)        |
| `submittedOffset`  | x 0, y 65 (65 synthetic rows above and below) |
| `providerCrop`     | centre, source URL, verifiedAt                |
| `outputCanvas`     | 1584×672                                      |
| `expectedCrop`     | x 0, y 60, 1584×672 (removes 60 + 60 rows)    |
| `effectiveContent` | 1584×662 at x 0, y 5 (= the Turbo geometry)   |

The planner refuses unless every invariant holds: documented centre crop; output outside the range; submitted image
inside it; an exact integer crop (even padding total); the crop contains the whole picture (zero picture pixels lost);
the picture's scale is identical on the submitted and output canvases. The adapter re-derives the record and refuses any
difference, the transport refuses a source whose stored dimensions differ from the record, and delivery conform uses
`effectiveContent` exactly as it uses the `contain-pad-v1` rectangle. A real-FFmpeg test proves the submitted image,
centre-cropped as documented, is pixel-identical to the `contain-pad-v1` transport. The transport image is provider-only:
it exists in memory for the request and is never stored as an Asset. Gen-4 Turbo (range 0.5–2.358) keeps
`contain-pad-v1`.

## Keyframe mode and reference disclosure

Models whose first/last frames exclude reference images (Seedance, Hailuo: `keyframesExcludeReferences`) always run in
**keyframe mode** for this purpose. The Production Frame is mandatory and outranks separate identity / Look / Location
references, because it already resolves identity, wardrobe, Location, viewpoint, composition and lighting. Reference
mode is not offered (requesting it is an error: it would demote the frame to a reference). The omitted references are
disclosed truthfully and acknowledged:

> Character and Location reference images are not separately supplied because this model's exact first-frame mode
> excludes reference images. Their approved appearance is already represented by the Production Frame.

Character Continuity Lock facts and Location View facts stay in the GenerationPackage and the PromptPlan (what the
motion must preserve). A Shot with a selected Lock never reverts to the mutable library.

## Reference check before spend

A video model given a first frame receives that frame and text. On Runway Gen-4.5 and Gen-4 Turbo the image-to-video
request has no reference-image input at all (`@runwayml/sdk` 4.22.0: `promptImage` with position `first`, `promptText`,
`ratio`, `duration`, `seed`); every hosted model that has one excludes it in first-frame mode. So in this workflow the
Character's identity, the wardrobe Look and the Location reach the clip **only through the Production Frame**. An
animation request for Shot 3A carries one image and zero references by construction.

Whether that frame was itself generated from the canonical references is therefore the reference question that matters
before spend, and it is answerable from records Prism already keeps
(`src/domain/generation/reference-integrity.ts`, pure, no new state):

- **Slots.** Per assigned Character its identity (the designated Canonical Identity, else the first stored identity
  image, else the selected Continuity Lock's) and its Look's first reference image; then the Shot's selected Location
  View. Each is `ready` (a stored image Prism sends) or `missing` (words only), with its **origin**: an uploaded
  original, a generated reference, or derived. A generated reference is always labelled as one.
- **Lineage.** The selected frame's source attempt and its frozen `inputAssetIds`, following edits back through the
  images they were made from:

| Status         | Meaning                                                                                | Paid animation                         |
| -------------- | -------------------------------------------------------------------------------------- | -------------------------------------- |
| `verified`     | Generated from every ready essential reference                                         | nothing extra                          |
| `partial`      | Generated **without** one or more of the Shot's current essential references (named)   | `references.frame_lineage` to confirm  |
| `unreferenced` | Generated while the Shot had no reference image: every appearance came from words      | `references.essential_missing`         |
| `unverifiable` | Uploaded, from a Storyboard or a 3D Master Frame, or its attempt record is unavailable | disclosed ("check it by eye"), no gate |
| `none`         | No Production Frame selected                                                           | (Animate is already blocked)           |

A frame that was uploaded or promoted, but whose image is byte-identical (same checksum) to an earlier **generated**
frame of the same Shot, is that picture. It takes that frame's lineage and the message says so ("v2 is the same image as
v1"), so re-uploading a generated frame never erases what Prism knows about how it was made. An uploaded frame that is
a different image stays `unverifiable`.

This reports facts about inputs. It never claims to have looked at pixels: a `verified` frame can still be a bad
likeness, and human review stays authoritative. It complements freshness, which already blocks a frame whose
references changed after it was made; lineage catches the frame that was made without them in the first place.

The Animate panel shows the check for every Shot ("Reference check"). On a **paid** model the two acknowledgements
above are confirmed on their own ("Check before you spend"), never inside the general "what each candidate will not
use" list, and the server requires the same confirmation (`acknowledgePreSpend`). They are recorded on the attempt
(`acknowledgedIgnored`, and in its frozen compatibility report). Free models are not gated.

## Rejected takes

A creatively rejected clip is evidence about a specific request. `src/domain/generation/retake.ts` gives a request a
**take signature**: first and last frame, model, the prompt actually sent, duration and provider canvas (not the seed,
the resolution tier or native audio). The Shot's earlier animations from the same Production Frame are its prior takes,
each with its verdict (a candidate review, or the attempt's own rejection) and reasons.

- A rejection made in the Shot Clip panel stays visible there with its reasons, and Reject is no longer offered again.
- A paid request **identical** to a rejected take needs its own confirmation (`retake.identical_to_rejected`: "the same
  frame, model, prompt and duration would be sent again"). Prism never regenerates a rejected Shot on its own, and
  never re-sends the identical instruction silently.
- Changing the Production Frame, the Shot's direction, the model, or the prompt policy changes the signature.

## Motion-first prompting

Same PromptPlan v1 sections, no new schema, no provider-specific format in the domain. For this purpose
`buildPromptPlan(pkg, adaptation, { purpose })`:

- opens with "Begin exactly from the supplied Production Frame (vN).";
- leads with camera, action, performance, timing, continuity and hard constraints, then composition and appearance;
- states "Preserve the subjects, wardrobe, set, composition and lighting established by the first frame." and marks the
  composition as "As established by the first frame; do not recompose."

The PromptPlan is Prism's production intent. It is **not** necessarily what a provider receives (see below).

## Provider-prompt adaptation (Phase 5B)

`Story / Shot intent → deterministic provider-prompt policy → provider request.`

The Shot's story data stays the source of truth. A provider-prompt policy derives an execution representation from the
GenerationPackage's structured fields (never from the rendered plan, so internal labels cannot leak). It is pure and
deterministic (no AI rewriting), versioned, and frozen in the immutable request as
`providerOptions.prismProviderPrompt` (`src/domain/generation/provider-prompt.ts`).

Why: Shot 3A's story moved from figurative "mask" wording to "composure" wording. Two Runway Gen-4 Turbo tasks whose
prompt contained "composure restored" / "Composure slips" failed inside Runway with `INTERNAL.BAD_OUTPUT.CODE01`; the
same image with a visible-behaviour prompt succeeded. The prompts had also leaked metadata (`Production Frame (v2)`, the
Shot code and title, `Purpose: …`, `(55/10)`, aspect-ratio prose) and sat at 992 of 1,000 characters, silently losing
their last clause.

**Policy table.** `providerPromptPolicyFor(provider, model, purpose)` is table-driven; a model opts in explicitly with
its own target. Runway `gen4_turbo` and `gen4.5`, `animate_production_frame`: policy `visible-motion` **v2** (since
2026-11-19), limit from the catalog (`promptMaxChars` 1000), target 600. Everything else keeps its existing compilation,
unchanged.

Gen-4.5's documented prompt-image range (0.5–2) is narrower than its 21:9 output; its wide start frames use the
`contain-prepad-center-crop-v1` transport described above.

### visible-motion v2 (current): the provider's documented prompting contract

v1 (below) was written from the failures in front of it. v2 is written from Runway's own guidance for these models,
re-read on 2026-11-19:

- [Gen-4 Video Prompting Guide](https://help.runwayml.com/hc/en-us/articles/39789879462419): describe what should
  happen; negative phrasing is not supported and may produce the opposite result; restating what the image already
  shows (clothing, hair) can cause unexpected results; refer to subjects in general terms; one scene's motion, simply.
- [Image to Video Prompting Guide](https://help.runwayml.com/hc/en-us/articles/48324313115155-Image-to-Video-Prompting-Guide)
  (written for Gen-4.5): prompts describe motion, not what is visible; stillness is asked for positively ("The
  locked-off camera remains perfectly still.", "Minimal subject motion only."); motion cues in the image itself work
  against a prompt for stillness.

v1's Shot 3A prompt (882 characters) broke that contract in the two ways the guide warns about. It carried five
negations ("never rotating through frontal or toward screen-left", "never looking into the camera", "no larger head or
body movement", "no push-in, pan or reframing", "Do not introduce new objects or people") and restated the hair, gown,
earrings, Location and time of day. The rejected Gen-4.5 take rotated through frontal to a screen-left profile. That is
consistent with the guide's warning; it is not proof of cause, and only a new take can show the result.

v2 is the same deterministic derivation from the package's structured fields, under three rules:

1. **Positive phrasing only, enforced.** A Shot note phrased negatively ("never smiles", "doesn't look at the camera")
   is not sent. The omission is recorded (`negative-phrasing-omitted`) and shown in the Animate panel as "Shot notes
   not sent", so the filmmaker can rephrase it as what should happen. A negatively phrased camera note ("No movement")
   becomes a still camera. If a negation still reached the final text the record is `ok: false` and the adapter
   refuses it before any spend (defence in depth: no input reaches that state today).
2. **Motion only.** No subject description, Look, Location, lighting or beginning pose: the first frame carries them.
   Each is recorded as deliberately not restated (`established-by-first-frame`).
3. **General terms.** "The subject" on first mention, then a pronoun. Never a name or a physical description.

Sections, in sending order: Camera (required), Visible action (required: held orientation, the visible change, the
ending, and for a held Shot the motion envelope), Performance (optional: the pace). Shot 3A, 443 characters:

> The locked-off camera remains perfectly still. The subject holds her position, turned toward the right side of the
> frame, and her gaze stays down and away. Her expression briefly softens, she looks visibly exhausted, her shoulders
> lower subtly and she closes her eyes briefly. Then her eyes open and she ends calm and neutral. Minimal subject
> motion only: her face, eyelids and breathing, with a slight drop of the shoulders. The pace is slow.

**Attribution follows the cast.** One Character: the translation rules below, and a note no rule understands is
attributed to the subject only when its own shape makes that safe (a body part, a verb plus its object, a single
descriptive word); anything else is sent in the filmmaker's own words, never rewritten into a claim ("Door swings open"
stays "door swings open"). Several Characters: Prism has no reliable screen position for each, so their notes are sent
verbatim and only what is true of all of them is added ("The subjects hold their positions."). No Character: camera and
scene notes only. Positional language for several subjects is not derived yet.

**History.** An attempt keeps the prompt it froze. A v1 record still parses, validates and is shown as v1; no new
request is built with it. Because the sent prompt is part of a take's signature, a take sent under v1 is not
"identical" to today's request (see Rejected takes).

### visible-motion v1 (historical)

**visible-motion v1** wrote concise prose in these sections:

| Section         | Required | Priority | Content                                                                                                                                                                                                                           |
| --------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Continuity      | yes      | 1        | identity, apparent age, facial structure, the Look's head phrases (hair, wardrobe, jewelry), lighting, background; no new objects or people                                                                                       |
| Visible action  | yes      | 2        | held orientation, eyeline and "never looking into the camera" (from blocking), begin → change → end as observable behaviour; a held orientation also states the motion envelope (below), otherwise natural breathing is asked for |
| Subject, Camera | yes      | 3        | who/where/when in plain words; camera (an imperceptible move is requested as a locked camera, recorded)                                                                                                                           |
| Composition     | no       | 4        | subject blocking (the first frame already establishes the composition)                                                                                                                                                            |
| Performance     | no       | 5        | restraint and pace                                                                                                                                                                                                                |
| Look detail     | no       | 6        | the complete Look fields                                                                                                                                                                                                          |
| Setting         | no       | 7        | set lighting and mood                                                                                                                                                                                                             |

**Held orientation.** A Shot that faces one side (`screenDirection` "… screen-right/left") with no blocking movement (no
marks, entry or exit) holds the first frame's orientation. "Keeps her head turned toward screen-right" alone was not
enough: a Gen-4.5 Shot 3A take turned through frontal to a screen-left profile. The policy therefore pins head AND torso
("keeps the first frame's three-quarter orientation toward screen-right: head and torso stay screen-right, never
rotating through frontal or toward screen-left", "profile" when the direction says so), and limits the motion envelope
to the face plus only what the Shot's own action moves ("Limit motion to her face, eyelids, breathing and a small
shoulder drop; no larger head or body movement."). Both are recorded adaptations (`held-orientation`,
`motion-envelope-limited`).

Abstract story language is translated by ordered, tested rules (`composure/mask … restored` → "ends calm and
neutral"; `… slips/drops` → "expression briefly softens"; `exhausted` → "looks visibly exhausted";
`tense`, `confident`, `hesitates`; `shoulders fall` → "shoulders lower subtly"). A figurative note no rule understands is
**omitted and recorded**, never sent (a model may render "mask" literally).

**Budget.** Required sections are always kept; optional sections are added in priority order only while the prompt
stays within the target. Sections are dropped whole — a sentence or field is never cut part-way — and each omission is
recorded and surfaces as one acknowledgeable ignored feature (`prompt.budget`). If the required content alone exceeds
the provider limit the request is refused (`ok: false`), never truncated.

**Provenance.** The frozen record holds the policy id and version, provider/model/purpose, the source package
fingerprint, the final text and its length, the budget, every section's fate, the omitted sections, every adaptation
(field, source text, provider text, rule) and the list of internal metadata deliberately excluded. The Runway adapter
sends exactly that text; it refuses a malformed, foreign, over-limit or not-ok record; the adapter invariant (also
re-checked by the worker before the provider call) requires its source fingerprint to equal the attempt's own package.
Historical attempts keep what they recorded.

**Inspectable before spend.** The Animate Production Frame panel shows, per policy-adapted model, the story intent
(source of truth), the exact provider prompt, the policy version, length/limit/target, omitted sections and the Shot
notes that were not sent (with the reason). The no-spend evaluation (`Evaluation.providerPrompt`) and the Prompt
Inspector's compiled fields (`promptPolicy`, `promptBudget`, `promptOmittedSections`) carry the same record.

**Deployment note.** A generation worker built before this change ignores `prismProviderPrompt` and would compile the
old prompt. The worker must run this code before a policy-adapted request is submitted.

## Duration and framing

Unchanged adaptation semantics. The production duration (timeline / package timing) is never rounded: a natively
supported duration is generated natively; a shorter-than-minimum duration with an explicit **generate longer, then
trim** plan asks the provider for the supported duration (priced on the provider seconds) and the delivery conform trims
it back; an unsupported duration without a plan is blocked. Framing: Production Frame → optional provider-only transport canvas → provider original → delivery conform, never a
silent crop. The comparison shows production / provider / delivery duration and the frozen provider canvas before any
spend. The canonical Production Frame Asset is never modified.

Audio: the selected performance stays production truth. Provider-native audio is OFF unless the person turns it on.
Performance audio a provider accepts may condition the video; it is never called the final dialogue (Phase 2I assembles
the final performance deliberately).

## Workflow

**Shot Prep → 16A · Animate Production Frame** (`?section=animate`), next to the Production Frame:

- the Production Frame preview with its version and a current / stale badge, Shot duration, camera motion, action
  summary and the start-frame override state;
- blocked reasons when the source rules fail (no comparison is offered then);
- **Compare animation models**: the existing model comparison for the video models with, per model, eligible or
  incompatible and why, canonical first-frame source plus provider-only transport when required, production → provider
  → delivery duration, provider canvas, audio conditioning, native audio (off/on), estimated cost and the references
  omitted by keyframe mode. No model is
  pre-selected and nothing calls a provider until the set is explicitly created; paid models still need the server
  spend gates and the confirmation of the displayed total.

Generic **20 · Generate** remains for text-to-video, manual start frames, reference-rich experiments and other
modalities.

## Candidate sets and review

An animation set freezes `generationPurpose: "animate_production_frame"` and `animationSource` (frame id, version,
Asset id, checksum, intent fingerprint) in its recommendation JSON. All candidates share one package (one Shot, one
duration, one Production Frame); provider adaptation may differ per model. The server re-reads the Shot's selected
frame before the set is created and before every candidate: if the selection moved, the set is refused, or once
started nothing more is submitted. A set never mixes source frames.

The final authority is the repository. `prepareSubmission` derives `expectedAnimationProductionFrameId` from the
frozen package for EVERY `animate_production_frame` submission (not only candidate sets), and `createAttemptWithJob`
accepts a new attempt only if the Shot still has exactly that frame selected, checked in the insert transaction under
a `FOR SHARE` row lock on `shot_production_frame_selections`, so the selection cannot move between the check and the
commit. Otherwise it refuses with `stale_animation_source` and writes no attempt, job, cost or event; in a set, that
candidate is marked failed and nothing more is submitted. An idempotent replay of an already accepted attempt still
returns it. The worker's `animationRequestViolations` check stays: it guards the frozen request's internal
consistency, the repository check guards acceptance against the live selection.

The candidate board is the **video** surface plus source truth: "Animated from Production Frame · Start: Production
Frame vN", whether that frame is still selected, per clip the deterministic **first-frame provenance** check (the frozen
request's start frame equals the frozen frame Asset; this is integrity, not computer vision: it never claims the
output's first frame pixel-matches), freshness with reasons, and **Delivery conform required** when the plan needs a
crop / pad / trim that does not exist yet. Good / Shortlist / Reject / ⭐ Best work as before. **Best never approves the
Shot's output**; "Promote to Shot" (the existing final creative approval) stays separate and human.

## Freshness

`animationFreshness(ctx, attempt)` is the 2G.2 candidate input basis, unchanged: the 13 named parts frozen in the
package plus the Production Frame the clip started from. A clip goes stale when another frame is selected, when the
frame goes stale, or when camera, action, performance, timing / duration, Character Lock, Location View or any other
named part changes. Editing a master Look or IdentityRef under the SAME Character Continuity Lock does not stale it.
Stale clips stay as history (never deleted, never rewritten); an approved clip is reported stale, never silently
unapproved.

## Delivery conform and QA

The provider original is immutable; an existing delivery conform makes a separate production-shaped Asset (crop, pad,
trim). Until it exists the board says so, and the provider original is never presented as production-shaped. Continuity
QA stays optional and advisory (external QA calls: 0 unless a person starts one) and judges the selected delivery master
or else the provider original against the Production Frame (`production_frame` reference role), the Character Lock
images, the Location View (`location_view` role) and the current production truth.

## Sequence Board

Each card shows a derived **animation state** (Not animated / Animation candidates / Final video approved / Animation
stale) from the Shot's animation attempts and their approval: no table, no cache. A Shot with a selected, current
Production Frame gets an **Animate** link into the workflow (no provider call from the board). The board stays a
canonical-STILL surface: the Production Frame visual is never replaced by video.

## What 2H does not do

- no new table, migration, package version or freshness part;
- no automatic generation, retry beyond the existing worker policy, provider audio, end frame or approval;
- no live provider call during implementation: MockProvider only. One tiny live image-to-video smoke can be approved
  separately after merge.
- no change to the generic `projectRevision()` digest. That digest predates the Production Frame, Location View and
  Character Continuity selection tables, so generic Generate does not catch a selection moved between package build
  and submit. Animate does not rely on it: it re-reads the selected Production Frame before the set is created and
  before every candidate, and the worker re-checks the frozen request against the frozen package. Extending generic
  revision coverage is a separate hardening task (see [roadmap](roadmap.md)).

## MockProvider limitation: duration

The free mock video is **fixture media**: the same short clip whatever was asked for. It does **not** simulate a
provider physically returning exactly the requested duration. Tests therefore assert what Prism decides and records —
the request duration, the provider-duration plan (native vs generate-longer-then-trim), the cost estimate, the
adaptation plan, the trim target and the delivery conform orchestration — and never claim the source mock clip itself
has the requested provider duration. Whether a real provider returns the requested seconds is checked only by the live
smoke.

## Tests

- `src/generation/__tests__/animation-contract.test.ts` (pure): purposes and history, the source rules (PF A vs
  Storyboard B, no PF, stale PF, override conflict / equal), image-to-video only, the adapter invariant, keyframe mode
  and disclosure, motion-first prompt, native / longer-then-trim / unsupported duration, framing, gate exemptions,
  freshness, provenance and the derived Sequence state.
- `src/generation/__tests__/animation-flow.test.ts` (memory worker, free mock video models): the full path, PF v1 → v2,
  a source change during set creation, the worker refusing a tampered request before any provider call, a master
  Look edit under a Lock (fresh) vs a Lock switch (stale), a Location View change.
- `e2e/zzzzzzzzzzzzzzzzzzzz-image-to-video.spec.ts` (memory, UI) and `e2e/supabase-image-to-video.spec.ts` (real Auth,
  RLS, Postgres, private Storage and worker; MockProvider only; fixture restored exactly).
- `src/generation/__tests__/pre-spend-checks.test.ts` (pure and memory): reference slots, origins and every lineage
  status (including an edit chain and a Continuity Lock), the paid-only gate, the identical-retake guard, and the
  candidate set refusing a paid take until the check is confirmed.
- `src/domain/generation/__tests__/provider-prompt.test.ts` and `src/generation/__tests__/runway-provider-prompt.test.ts`:
  both policies, with Shot 3A's v2 text pinned and a frozen v1 attempt left unchanged.
- `e2e/zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-paid-animation-gate.spec.ts` (memory, UI): the only browser coverage of a
  **paid** row. Its server lists Runway with paid generation enabled and an explicitly empty secret, so the rows are
  selectable and priced and nothing can reach the provider; the spec never submits a paid candidate. It covers the
  reference check for a frame generated from words only, the exact v2 prompt shown, "Check before you spend" holding
  Generate until it is confirmed on its own, free models not being gated, and a rejection staying visible in the Shot
  Clip panel.
