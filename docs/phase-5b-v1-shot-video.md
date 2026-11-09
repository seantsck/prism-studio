# Phase 5B V1: canonical Production Frame → Shot Clip

> Canonical Production Frame → **Animate** → Video Inputs → compatible video model → duration and cost → generate →
> video candidate → review → **Use as Shot Clip**.

V1 branches from `phase-5b-story-intelligence` at `9066509`, the integrated pre-video loop. It is local / test only:
**no migration**, no hosted change and no paid call.

## 1. Audit: what already existed (Phase 2C / 2E / 2H, reused unchanged)

| Concern                                  | Existing architecture (reused)                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Providers / registry                     | One `ModelRegistry` (`src/generation/registry.ts`). Runway is the first real video provider (`providers/runway`: Gen-4.5, Veo, Seedance… image-to-video families). The mock provider has real WebM output (`mock-video-1`, `-lite` 5/10 s, `-169`, `-t2v`, `-flaky`, `-rejects`, `-hang`). Capabilities drive modality, durations (`min/max/step/allowedDurationsMs`), aspect ratios, resolution and pricing. |
| Queue / worker                           | One generation queue: `generation_attempts` + jobs, and the existing generation worker. Lifecycle queued → submitted → processing → succeeded / failed. The provider job id is persisted at submission and polling resumes from it. An uncertain submission is never re-sent to a non-idempotent provider (`submission_outcome_unknown`).                                                                     |
| Image-to-video from the Production Frame | Phase 2H `animate_production_frame` (`src/domain/generation/animation.ts`): the Shot's selected, current Production Frame is the **exact first frame**, never the Storyboard, a different override or text-to-video. The adapter invariant is checked at submission AND by the worker before the provider call. The frame is never re-sent as a reference.                                                    |
| Candidates / review                      | 2E candidate sets (`purpose = animate_production_frame`), the model comparison before spend, Good / Shortlist / Best / Reject, and promotion = the attempt's `approved` flag (**at most one per Shot**, enforced in the database).                                                                                                                                                                            |
| Spend                                    | Paid off unless allowed. Per-generation and per-set ceilings. A paid set needs the exact confirmed total (candidates × per-second price × duration).                                                                                                                                                                                                                                                          |
| Duration                                 | The Shot's target / performance duration. Unsupported durations are refused ("Prism will not round the shot silently"); "generate longer, then trim" only on explicit choice.                                                                                                                                                                                                                                 |
| Conform                                  | The 2C delivery conform. The provider original stays immutable and a production-shaped master is derived. A Production Frame promoted from a conform IS that conform asset.                                                                                                                                                                                                                                   |
| Lineage / freshness                      | `animationProvenance` (frame id / version / asset / checksum / firstFrameMatches) and `animationFreshness` (the 13 frozen package parts plus the frame reference). Approved clips are reported stale, never silently unapproved. The Sequence Board shows the derived animation state.                                                                                                                        |
| Video asset                              | A new private immutable `video` Asset per output (mime, size, checksum, dimensions, duration) and cost rows. Never overwrites another file.                                                                                                                                                                                                                                                                   |

## 2. What V1 adds

| Addition                                                                                                                                                                                                                                                                                                                                                                          | Where                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Video Inputs** preview: First Frame (version, Shot, size, production conform or original), Action (story beat + S5 blocking), Camera (Static · angle · lens), Performance (S5 emotional intent + mood, minimal movement), Continuity (Look, Location, View, screen direction), Duration. Advanced: first-frame asset + sha256, aspect ratio, duration, the exact motion prompt. | `domain/generation/video-inputs.ts` `videoInputs()`; `components/generation/shot-clip-panel.tsx` |
| **Motion layer** of the one provider-neutral prompt path (`buildPromptPlan`, purpose `animate_production_frame`).                                                                                                                                                                                                                                                                 | `prompt-plan.ts`                                                                                 |
| **Clip duration** choice: only durations an available image-to-video model supports. It sets the Shot's own target duration; anything else is refused.                                                                                                                                                                                                                            | `clipDurationChoices()`; `server/video-actions.ts` `setShotClipDuration`                         |
| **Use as Shot Clip**: explicit. **Replacing** the current Shot Clip needs a confirmation (`confirmReplace`), on the candidate board, the Shot Clip panel and the generation-page approve path. The previous clip stays in history.                                                                                                                                                | `candidate-actions.ts`, `generation-actions.ts`, `candidate-board.tsx`                           |
| **Shot Clip** panel on Animate: the selected clip (player, source frame version, provider/model, "Generated from an earlier Production Frame.", "Needs review: …") and every clip with Play / Use as Shot Clip / Reject (reason) / Generate Alternative.                                                                                                                          | `shot-clip-panel.tsx`, `shotClips()`                                                             |
| **Generate Alternative**: same Shot, same canonical frame (2H re-reads and enforces it), same model, plus the creator's **motion note** (`CreatorDirection` kind `motion`). It never replaces the selected clip.                                                                                                                                                                  | `video-actions.ts` `generateClipAlternative`; `submission.ts`                                    |

The motion layer adds these lines:

- `ANIMATION_MOTION_LINE`: animate only what changes after the first frame, restrained and motivated; no new action.
- `ANIMATION_STATIC_CAMERA_LINE`, used when the direction says Static: a locked camera is not a frozen picture
  (breathing, blinking, hair and fabric, practical flicker, subtle environment).
- `emotional intent: … — show it through subtle actor motion`, plus the mood, both from the applied S5 direction.
- `ANIMATION_CONTINUITY_LINE`: identity, face, wardrobe, hairstyle, Location, composition, props and screen direction.
- `ANIMATION_MOTION_GUARD`: a creator motion note never changes Characters, Looks, Location, story or composition.

The 2H lines stay first and unchanged: "Begin exactly from the supplied Production Frame", "Preserve …" and "do not
recompose".

**Not added:** no queue, no registry, no worker, no Runway worker, no schema. The Shot Clip is the existing approved
animation attempt.

## 3. First frame (the invariant)

The request's `startFrameAssetId` is the Shot's canonical Production Frame asset, frozen in the package. When that
frame was promoted from a production conform, the asset **is the conform** (tested: never the unconformed original).

It is never:

- a Storyboard Frame;
- a newer candidate;
- another Shot's frame;
- an override that differs (that blocks Animate);
- a cross-project image.

A new Production Frame makes later animations start from it only. Earlier clips are labelled **"Generated from an
earlier Production Frame."**

## 4. Staleness

Clips are historical media: never deleted, never regenerated, never silently unapproved.

- A clip is **Needs review** when a frozen input changes: the canonical frame, the applied S5 direction (camera,
  blocking, lighting), the Shot's story and action, its Look or Lock, its Location View, its timing.
- An irrelevant change (another Character's notes, an unused Look) leaves it fresh. This is the exact-input
  fingerprint of 2G.2 / 2H.

## 5. Ojou-sama acceptance (mock only)

- **Shot 3A** (`shot-video-v1.test.ts`):
  - The Video Inputs read "Production Frame v1 — Shot 3A", "Static · eye level · 85mm — intimate compression",
    "Yumeko — Episode 1 — Formal Black Look", "Grand Celeste Lobby", and the S5 emotional intent.
  - The `mock-video-1` clip starts from exactly that frame. It is a real WebM in private storage with its checksum,
    the provider job id, a 5000 ms duration, the package fingerprint, cost rows and provenance.
  - Use as Shot Clip works. Generate Alternative ("Less movement. Yumeko only glances toward Sean.") leaves the
    selected clip unchanged. Replacing needs confirmation and keeps the old clip.
- **2.39:1 conform:** the 3A frame promoted from its conform; the clip's first frame is the conform asset.
- **Three Shots:** 3A, 3B and 3C each keep their own first frame, motion direction, selected clip and lineage.
- **Story P (browser):**
  1. Shot 3A from story O → Video Inputs → free mock clip → play.
  2. Use as Shot Clip → refresh → Generate Alternative; the Shot Clip is unchanged.
  3. A new S5 "handheld" direction is applied; the clip shows "Needs review" and is still playable.

## 6. Gaps documented (not invented)

- **Runway capabilities** (durations, prices, aspect ratios) are the existing pinned definitions. No fresh Runway
  call was made to re-verify them. The prepared real acceptance stays owner-authorized.
- **Generate Alternative** reuses the clip's model. A paid model there needs the confirmed total, so the action
  refuses and points back to the Animate comparison. A model that ignores features must be acknowledged in the
  Animate panel; it is never assumed.
- Clips longer than one supported generation (extension, stitching) belong to a later V slice.
- **`db-worker-role --set-role`:** the same 7 local-impersonation failures as the `4773dd4` baseline (55/62). The
  read-only audit is clean (32/0). A **hosted real-login** run of `db:worker-role` is still required before hosted
  use.
