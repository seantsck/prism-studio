# Image-to-Video (Phase 2H)

Phase 2G made the Shot's canonical still: the **Production Frame**. Phase 2H makes it move.

> The selected, current Production Frame is the exact first-frame image supplied to the video model.

It is never replaced by an approved or draft Storyboard, a generic Location reference, a manual start-frame override,
text-to-video because a provider preferred it, or a similar regenerated image. The moving Shot begins from the exact
still the filmmaker approved.

2H is an execution contract plus a workflow. It reuses everything that already exists: generation attempts and jobs,
the worker, the Runway adapter, the model catalog, candidate sets, human review, cost estimates and spend gates,
delivery conform, continuity QA and final Shot approval. No migration, no new table, GenerationPackage stays **v5**,
the freshness parts are unchanged. No GPU, COLMAP, Brush or 3D set is required.

## The purpose: `animate_production_frame`

A provider-independent `GenerationPurpose`, frozen on the attempt's request (`request.purpose`) and on the candidate
set's recommendation JSON (`generationPurpose`):

| Purpose                    | Meaning                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `shot_output`              | generic Shot-output generation (every request without a purpose: history is never rewritten) |
| `production_frame`         | a still candidate for the canonical Production Frame (2G.2)                                  |
| `animate_production_frame` | a Shot-output VIDEO whose exact first frame is the selected, current Production Frame (2H)   |

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

## Exact start frame and image-to-video only

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
no start frame, starts from anything but the frozen frame, or also sends the frame as a reference. A refused job fails
with `animation_source_invalid`; the provider is never called.

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

## Motion-first prompting

Same PromptPlan v1 sections, no new schema, no provider-specific format in the domain. For this purpose
`buildPromptPlan(pkg, adaptation, { purpose })`:

- opens with "Begin exactly from the supplied Production Frame (vN).";
- leads with camera, action, performance, timing, continuity and hard constraints, then composition and appearance;
- states "Preserve the subjects, wardrobe, set, composition and lighting established by the first frame." and marks the
  composition as "As established by the first frame; do not recompose."

## Duration and framing

Unchanged adaptation semantics. The production duration (timeline / package timing) is never rounded: a natively
supported duration is generated natively; a shorter-than-minimum duration with an explicit **generate longer, then
trim** plan asks the provider for the supported duration (priced on the provider seconds) and the delivery conform trims
it back; an unsupported duration without a plan is blocked. Framing: Production Frame → provider canvas → provider
original → delivery conform, never a silent crop. The comparison shows production / provider / delivery duration and
"Production Frame 2.39:1 → provider 16:9 → delivery back to 2.39:1" before any spend. The canonical Production Frame
Asset is never modified.

Audio: the selected performance stays production truth. Provider-native audio is OFF unless the person turns it on.
Performance audio a provider accepts may condition the video; it is never called the final dialogue (Phase 2I assembles
the final performance deliberately).

## Workflow

**Shot Prep → 16A · Animate Production Frame** (`?section=animate`), next to the Production Frame:

- the Production Frame preview with its version and a current / stale badge, Shot duration, camera motion, action
  summary and the start-frame override state;
- blocked reasons when the source rules fail (no comparison is offered then);
- **Compare animation models**: the existing model comparison for the video models with, per model, eligible or
  incompatible and why, exact first frame, production → provider → delivery duration, provider canvas, audio
  conditioning, native audio (off/on), estimated cost and the references omitted by keyframe mode. No model is
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
