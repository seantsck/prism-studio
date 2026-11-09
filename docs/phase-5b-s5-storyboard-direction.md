# Phase 5B Story Intelligence S5: approved Shot → reviewed Storyboard Direction

> Approved Shot → **Direct with Prism** → Storyboard Direction Proposal → review / edit → **Apply Direction** → the
> Shot's existing direction fields → the I6 Production Frame Inputs read them.

S5 branches from `phase-5b-story-intelligence` at `e181394` (S1, S2 and S4 merged). Everything is local / test only:
migration 0057 is not applied to hosted DEV, and no real provider call is made.

S4 decides _what Shots exist_; S5 decides _how each one plays_. **The model never changes a Shot.**

## 1. The frozen Shot snapshot (`shotSnapshot`)

The snapshot is text only (no image pixels):

- **The Shot as planned:** code, title, beat, purpose, S4's plan notes, current size / angle / framing / lens, and the
  dialogue it covers.
- **The Scene:** heading, INT/EXT, time of day, summary; the Scene text fingerprint comes from S4's canon snapshot.
- **Characters:** each with its selected **Look** (name and wardrobe / hair / jewelry), any **Continuity Lock**, and
  continuity notes.
- **The Location:** description, lighting, geography.
- **The selected Location View:** viewpoint, orientation, camera position / height / angle, size, framing, lens. It is
  a **hard constraint**. Other Views are listed for recommendation only.
- **Adjacent Shots:** up to two before and two after in the Scene, each with size, angle, framing, Characters, screen
  sides (from their blocking marks), screen direction and eyelines.
- **`established`:** the screen side each Character already holds. It comes from the adjacent Shots first, then the
  Shot's own marks, then S4's "Keep X screen-left and Y screen-right" note.

**`shot_fingerprint`** covers the Shot's planning and direction fields, its Characters and Looks, its Continuity
Locks, dialogue and the selected View. **`scene_fingerprint`** covers the Scene's canonical text. If either changes,
the proposal is **stale** and Apply refuses it.

## 2. Direction schema (`prism.shot-direction.v1`)

| Part       | Fields                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| framing    | shot size (S4's sizes), composition, subject placement, headroom / negative space                                                       |
| lens       | intent ("85mm intimate compression"), focal range (a range when exact is not justified), rationale                                      |
| camera     | height, angle, position, perspective, movement (static · handheld · dolly · pan · tilt · push in · pull out · track · crane), rationale |
| blocking   | per visible Character: position, screen side, depth (fg / mid / bg), facing, eyeline, relation, entry / exit                            |
| lighting   | key, practicals, contrast, mood, time of day, motivated sources (no gaffer diagram)                                                     |
| depth      | foreground, midground, background, cues                                                                                                 |
| emotional  | why this treatment supports the beat                                                                                                    |
| continuity | screen direction, eyelines, constraints (Look, Lock, adjacent cuts), `breaksPattern` + justification                                    |
| location   | `usesSelectedView`, `conflict`, `suggestedNewView` (never created)                                                                      |
| storyboard | a concise visual description for an artist, a director and later image generation (not a provider prompt)                               |

**Validation** (`validateShotDirection`) checks:

1. JSON, then the strict Zod schema (lockstep with the Structured Outputs schema);
2. **exactly** the Shot's Characters, each blocked once, nobody added;
3. a selected View is used, or the conflict is named; with no View, none may be claimed;
4. every Character keeps its established screen side unless `breaksPattern` is set with a justification.

A malformed answer gets one correction turn, then fails and stores nothing.

## 3. Provider

`StoryIntelligenceProvider` gains one provider-neutral operation, `directShot(ShotDirectionRequest) → ShotDirection`,
with an optional creator note.

- **OpenAI:** the same adapter, strict schema `shot_direction`, prompt `shot-director-v1` (a director / DP: lens
  intent, not fake precision; movement only when it serves; continuity respected; the View as a hard constraint).
- **Free deterministic director:**
  - keeps Characters, Location and View;
  - keeps established sides; otherwise the first Character goes screen-left, and a lone Character screen-right looking
    into the frame;
  - reads variant notes: more intimate / distant / isolated, tense, romantic, symmetrical, handheld, restrained, and
    "make X dominant".

The Story worker claims directions alongside S1, S2 and S4 work, applies the same spend re-check, and reads only the
frozen row; it cannot read Shots, Looks, Location Views, Characters or Scenes.

## 4. Persistence (migration 0057, local only)

`shot_list_proposals` was audited. Its lifecycle is per Scene and its result is a plan, so S5 adds the parallel table
**`shot_direction_proposals`**.

- One row per immutable version **per Shot** (`unique(shot_id, version)`, `parent_id`).
- **Frozen input:** the instruction (variant note), both fingerprints, the snapshot, provider, model, schema and
  prompt versions, estimate, spend authorization.
- **Result:** direction, usage, cost and error, written once by the worker.
- **Review** only while ready; applied once.
- Owner-only RLS, no delete, triggers, and same-project / Scene / Shot references.

## 5. Review (Shot → "Direct with Prism →")

- **Sections:** Camera, Blocking, Lighting, Composition, Continuity, Storyboard Description.
  - Each can be **accepted** or left out of Apply, and every field is editable. Enums use selects; blocking is edited
    per Character.
- **Actions:** Save review, Reject / Un-reject, Save as alternate, **Regenerate** (a new version), **Ask for another
  approach** (a new version with the note, e.g. "make Yumeko feel isolated"), compare any two versions (side by
  side), **Apply Direction**.
- **Advanced:** provider, model, prompt, schema, version, estimate, cost and fingerprints.
- **Needs review:** after Apply, the page shows "Direction needs review" when the Shot, its screenplay or the S2
  story-change flag changed since. Nothing is re-run automatically.

## 6. Apply → existing Shot fields (no new Shot columns)

The current Shot schema was audited. Every direction element already has a home, and those fields already feed I6.

| Section     | Written to                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| camera      | `composition.shotSize`, `lens` ("85mm — intimate compression"), `cameraHeight`, `cameraAngle`, `cameraPosition`, `movement` |
| composition | `composition.framing` (composition, placement, headroom); camera notes: Depth, Emotional intent                             |
| blocking    | `spatial.subjectBlocking`, `spatial.marks` (side → x, depth → y), `facingDirection`, `entryPoint`, `backgroundActivity`     |
| lighting    | `lighting.keyDirection`, `practicals`, `fill` (contrast), `mood`; camera notes: Motivated light                             |
| continuity  | `spatial.screenDirection`, `spatial.eyelines`; camera notes: Continuity constraints                                         |
| storyboard  | camera notes: `Storyboard: …`                                                                                               |

- The camera notes keep S4's coverage line and `Source: lines … (Shot List vN)`, and add
  `Direction: Storyboard Direction vN`.
- The Shot keeps its id, code, order, Characters, Location, story fields, dialogue, generations, frames and approvals.
- Apply goes through the Shot schema and repository, writes no second Shot, and is refused when stale, rejected or
  already applied.

## 7. Production Frame integration (I6)

Nothing new is wired: I6 already builds its package from these Shot fields.

- **Production Frame Inputs:**
  - **Direction:** "size · lens · mood", "Angle: …", subject blocking, movement.
  - **Characters:** "Yumeko — screen right, midground…", from the marks.
  - **Location:** with the selected View.
  - **Story:** unchanged.
- **The provider prompt's Camera / Blocking / Lighting sections:** read the same fields, including the storyboard
  description in the camera notes.

The Storyboard Description remains available to the existing Storyboard / Shot image entry points. S5 adds no image
flow.

## 8. Cost

S2's controls are shared through `authorizeStorySpend`, now used by S4 and S5:

- free models need nothing;
- paid requests stay under the per-request ceiling;
- each needs the explicit "Confirm total" or the capped allowance of the Episode's live writing session, reserved
  atomically;
- the worker re-checks every request.

Tests use only the free director and fake OpenAI responses.

## 9. Tests

| Area                          | File                                                                  |
| ----------------------------- | --------------------------------------------------------------------- |
| Domain                        | `src/domain/__tests__/shot-direction.test.ts`                         |
| OpenAI (fake transport)       | `src/story/__tests__/openai-shot-direction.test.ts`                   |
| Acceptance (actions + worker) | `src/server/__tests__/shot-direction.test.ts`                         |
| Migration (static)            | `src/data/__tests__/migration-0057.test.ts`                           |
| Database (disposable)         | `scripts/db-shot-directions.mts`; `scripts/db-story-worker-login.mts` |
| Browser                       | story N                                                               |

What they cover:

- **Domain:** schema lockstep, a textual snapshot, validation (Characters, View, sides), variants, a three-Shot
  sequence, apply into existing fields with traceability kept, and the fingerprint.
- **OpenAI:** instructions, schema, note block, correction turn, timeout, no key → no call.
- **Acceptance:**
  - 3A with the selected View; edit / save / apply on the same Shot; I6 inputs;
  - reject, regenerate, another approach, alternate, compare;
  - stale after a Shot or screenplay change;
  - the S4 → S5 sequence keeping screen sides and eyelines;
  - foreign Shot and malformed output refused;
  - paid gate, session allowance, worker fails closed;
  - zero network.
- **Story N:** 3A → Direct → sections → edit → save → Apply → refresh → same Shot → I6 inputs show camera, blocking
  and lighting → 3B keeps Yumeko screen-right.
