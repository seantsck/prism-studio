# Sequence Continuity Supervisor (Phase 3A.4)

**Status: architecture in progress (2026-10-29).** This page is the design for review. No production code, migration,
provider call or calibration exists for 3A.4 yet. Each section is the decision for one point of the 3A.4 brief, and
[§21](#21-open-questions) lists what still needs the owner's decision.

**Question it answers:** _does this cut work as continuity?_ In other words, does Shot B continue Shot A correctly at
the cut that actually exists in the Episode Edit, as opposed to each Shot satisfying its own truth?

QA stays **advisory**. The supervisor detects, compares, explains, prioritises and suggests review. It never approves,
rejects, regenerates, retries, marks Best, selects an attempt, or changes an Episode Edit, Shot order, Production
Frame, Character Continuity Lock or Location View. A person decides, and declaring a discontinuity intentional is a
human editorial act.

Three kinds of judgement stay separate everywhere:

| Kind                    | Owner                      | Example                                                    |
| ----------------------- | -------------------------- | ---------------------------------------------------------- |
| Within-Shot temporal QA | Phase 3A.3 (accepted)      | "the actor exits frame left as planned, inside Shot B"     |
| **Cross-Shot / cut QA** | **Phase 3A.4 (this page)** | "A ends moving left → right; B starts moving right → left" |
| Editorial preference    | A person (never a defect)  | "this cut feels abrupt"                                    |

## 1. Audit: what exists and what is reused

| Existing piece                                   | Where                                                            | 3A.4 use                                                                                                                                                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Episode Edit** (0043)                          | `src/domain/edit/*`, `src/data/episode-edit-*`                   | **The authority for adjacency.** Items have stable ids, dense `position`, an exact pinned picture (`video` = attempt + Asset + `source_in_ms`/`source_out_ms`, or a placeholder still, or `none`), plus a `revision` counter |
| `buildEpisodeEditView`                           | `src/domain/edit/view.ts`                                        | Per-item facts reused as-is: source usability, clip freshness, approval moved, replacement available, placeholder freshness, performance placement state, `sceneId`                                                          |
| Shot Sequence Board                              | `src/domain/shot-sequence.ts`                                    | `describeTransition` already derives cut facts from Shot truth (Scene, Location / View, Characters enter / exit, Lock A → B, Look, screen direction, weather, time of day). It is **refactored to be shared**, not copied    |
| Criteria + reference set                         | `src/domain/continuity/criteria.ts`                              | Criterion shape (`key`, `category`, `severity`, `sourceRef`, `expected`, capability) and the frozen reference-set pattern. Existing `previous_shot` / `next_shot` roles stay Shot-QA roles                                   |
| Continuity runs / findings / overrides (0021)    | `continuity_runs`, `continuity_findings`, `continuity_overrides` | **Reused for transition runs** (one generalisation: the run's subject, see §15)                                                                                                                                              |
| Analysis jobs, costs, events (0022–0025)         | `continuity_analysis_jobs`, `_costs`, `_events`                  | Reused unchanged in shape: queue, lease, fencing, resume, `provider_state`, idempotency, the single cost ledger                                                                                                              |
| `ContinuityAnalysisProvider`                     | `src/continuity/analysis/provider.ts`                            | Reused; gains one **analysis mode** (§8)                                                                                                                                                                                     |
| Plan + external-media manifest                   | `src/domain/continuity/analysis/plan.ts`                         | Reused; one more batch kind and manifest omission reasons                                                                                                                                                                    |
| Evidence schema 2                                | `src/domain/continuity/analysis/schema.ts`                       | **Reused unchanged** (`input`, `timestampMs`, `endMs`, `observation`, see §10)                                                                                                                                               |
| Shot QA projection (3A.1)                        | `src/domain/continuity/shot-qa.ts`                               | Pattern reused for the transition assessment; each side's Shot QA state is linked, never recomputed                                                                                                                          |
| Automatic reconciliation + Project policy (3A.2) | `src/continuity/automation.ts`, `project_qa_policies` (0044)     | Pattern reused (authenticated, idempotent, no scheduler); sequence automation gets its own explicit mode (§17)                                                                                                               |
| Full-video consent (0045)                        | `project_qa_policies.direct_video_allowed`                       | Reused for cut-edge video windows (§19)                                                                                                                                                                                      |
| Derived media lineage (0020)                     | `asset_derivations` (`trim`, `frame_extract` operations)         | Cut-edge clips and edge stills are ordinary derived Assets (§7)                                                                                                                                                              |
| Shot freshness parts                             | `src/domain/fingerprint.ts`                                      | Not used directly for transition identity: the transition freezes its own criteria and reference fingerprints, as a Shot run does (§13)                                                                                      |
| Production Frames, Location Views, Locks         | 2G.1–2G.4                                                        | Frozen truth for both sides. Lock images and Location View images are the references, never today's library                                                                                                                  |

**Facts from the audit that shape the design:**

- `continuity_runs.attempt_id` and `subject_asset_id` are `NOT NULL`, and `continuity_analysis_jobs.attempt_id` is
  `NOT NULL`. A cut has two attempts (or none, for placeholders), so a transition cannot be stored as a run without
  one generalisation. Findings, overrides, costs and events key on `run_id` only and need no change.
- The continuity worker never uses `attempt_id`. It executes the frozen snapshot and reads only the `assets` rows named
  in the job's `input_asset_ids`. It **cannot write Storage**, so every clip it sends must exist as an Asset before
  submission.
- `src/data/media-qa-postgres.ts` has `select distinct on (attempt_id) … from continuity_runs` and
  `max(run_number) … where attempt_id = $1`. Any generalised run table must keep these Shot-only (filter on the
  subject kind), or a transition run would leak into Shot QA as a `null` attempt group.
- Single-video assumptions exist in `plan.ts`, `prompt.ts` and `prepare.ts` (`media.find((m) => m.kind === "video")`).
  This is why a separate mode is cleaner than overloading `direct_video` (§8).
- The edit already pins only immutable things (attempts, Assets, frames, takes) and reports upstream changes without
  rewriting. A transition's identity can therefore be computed exactly from the edit.

## 2. Analysis unit: the Cut

The unit is one **Cut**: the boundary between two adjacent items of one Episode Edit, `A → B`, where A is at
`position p` and B at `p + 1`.

| Field                       | Included                        | Why                                                                                                                                                                              |
| --------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| project id                  | yes                             | Owner boundary, RLS                                                                                                                                                              |
| Episode id                  | yes                             | Denormalised scope (an edit belongs to one Episode)                                                                                                                              |
| Episode Edit id             | yes                             | Stable owning reference (alternate cuts later drop the one-edit rule; the id is already the identity)                                                                            |
| edit revision               | **no** (recorded, not identity) | The revision bumps on **any** edit mutation. Putting it in identity would make every cut stale whenever any item changes, which §13 forbids. It is recorded on the run for audit |
| left item id, right item id | **yes**                         | The cut's address. Item ids, not Shot ids, so a duplicate or intercut Shot later gives distinct cuts                                                                             |
| left Shot, right Shot       | yes (derived from the items)    | Truth lookup and display                                                                                                                                                         |
| left / right visual source  | yes                             | Kind plus exact attempt, Asset, checksum and trimmed interval (or frame id for a placeholder)                                                                                    |
| left / right performance    | **no** (see §14)                | Audio placements do not change the pixels a visual cut check examines                                                                                                            |
| relevant frozen truth       | yes                             | The cut criteria (expected values) and references, fingerprinted                                                                                                                 |

`TransitionAddress = { editId, leftItemId, rightItemId }` names the cut. `transitionKey = sha256("cut-v1" | editId |
leftItemId | rightItemId)` is stable for as long as those two items stay adjacent. A run's **freshness** is separate
from its address (§13).

## 3. The Episode Edit is authoritative for adjacency

**Decision:** accepted. Once an Episode has an edit, sequence QA evaluates the edit's actual item order. The Shot
Sequence Board stays the planning surface for `shotOrder` and canonical stills.

| Situation                                                           | Behaviour                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No edit yet                                                         | The Supervisor shows an empty state that links to the Sequence Board (planned order) and to "Create Episode Edit". It invents no cut                                                                           |
| `video → video`                                                     | Full deterministic checks; semantic checks when gated in (§8, §19)                                                                                                                                             |
| Placeholder still on either side                                    | Deterministic checks. Semantic cut criteria are `unchecked` with "Planning picture: a placeholder still is not the cut's final picture". Still continuity stays the Sequence Board's job                       |
| `none` on either side                                               | Deterministic "No picture" fact. Every picture criterion is `unchecked` ("No picture on the left / right of this cut")                                                                                         |
| Unusable source (eligibility violation)                             | Deterministic `fail` on the cut's source-integrity criterion. Semantic analysis is not prepared                                                                                                                |
| Intentionally reordered (edit order ≠ `shotOrder`)                  | Evaluated as edited. An informational fact says "Edit order differs from the planned sequence". It is not a defect                                                                                             |
| Duplicate Shot (blocked today by `episode_edit_items_one_per_shot`) | Already safe: cuts are addressed by item id, so dropping the rule later (intercutting) gives each occurrence its own cuts                                                                                      |
| Item removed or moved                                               | Its old cuts leave the current projection. Their runs stay in history as "not in the current edit". If the same two items become adjacent again, the existing run is current again when its fingerprints match |
| Scene boundary                                                      | The cut carries `crossesScene`. Most continuity criteria apply only inside a continuous Scene (§4)                                                                                                             |

## 4. Deterministic and semantic checks

Every cut gets a set of **cut criteria**, built from the frozen truth of both sides in the same way Shot criteria are
built. A criterion says who can answer it: `deterministic`, `analyzer` (with a capability), or `manual`. Nothing is
inferred from pixels by deterministic code, and nothing deterministic is sent to a model.

**Scene scope.** Inside one Scene, A and B are presumed continuous in time and space, so the full set applies. Across a
Scene boundary only identity-level criteria apply by default. Location, lighting, time-of-day, geography, direction,
eyeline, axis and action criteria are `n_a` with "Scene changes at this cut". This removes most cost and most noise.

### Deterministic (free, computed on read, no media probing)

Each one compares declared truth, never pixels. A difference in declared free-text truth is a `warn` (possible
deviation, review it), never a `fail`. Only integrity problems fail.

| Key (proposed)            | Check                                                                                                    | Result                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `cut:picture`             | both sides have a picture; kind of each (video / placeholder / none)                                     | `pass`, or `unchecked` downstream with a reason                   |
| `cut:source_integrity`    | both pinned sources satisfy edit eligibility (`VideoFacts.usable` / `PlaceholderFacts.usable`)           | `fail` if not                                                     |
| `cut:source_currentness`  | either clip is stale against its Shot truth, or a replacement is available (from `buildEpisodeEditView`) | `warn` with the side and reason                                   |
| `cut:shot_qa`             | either side's pinned attempt has a fresh Shot QA critical mismatch                                       | `warn` that links to that Shot QA (never re-judged)               |
| `cut:link`                | B's stored `previousShotId` is not A's Shot                                                              | `warn` ("planned continuity link differs from the edit")          |
| `cut:location`            | same Scene but a different Location, or Location View A ≠ B when both are set                            | `warn`                                                            |
| `cut:character:<id>`      | a Character present on both sides: Lock A ≠ Lock B, locked ↔ live, or Look A ≠ Look B (both live)        | `warn`; `pass` when the same Lock or Look                         |
| `cut:character_presence`  | Characters enter / exit across the cut                                                                   | informational fact only (not a criterion)                         |
| `cut:declared_direction`  | declared `screenDirection` / `facingDirection` differ inside a Scene                                     | `warn` ("needs human review"), as the Sequence Board already says |
| `cut:declared_time`       | declared `timeOfDay` / `weather` / `lighting` differ inside a Scene                                      | `warn`                                                            |
| `cut:declared_props`      | declared `props` differ inside a Scene                                                                   | `warn`                                                            |
| `cut:declared_exit_entry` | A's `exitPoint` and B's `entryPoint` are both declared (shown side by side)                              | informational; the semantic `action_match` judges it              |
| `cut:order`               | edit order ≠ `shotOrder`                                                                                 | informational (Episode-level, not per cut)                        |

These are the Sequence Board's transition facts plus edit facts, so the board's `describeTransition` is refactored
into a shared pure function that takes two "side truth" values. Both surfaces call it. The board's own output does
not change.

### Semantic (analyzer, cross-cut, all calibration-gated)

| Criterion family (proposed key) | Category (existing enum) | Question to the analyzer                                                                     | Severity (Prism-owned)                        |
| ------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `cut:screen_direction`          | `screen_direction`       | Does the subject's direction of travel / facing carry across the cut as declared?            | major                                         |
| `cut:eyeline:<id>`              | `eyelines`               | Does A's look direction match B's subject position / reverse eyeline?                        | major                                         |
| `cut:axis`                      | `camera`                 | Is the camera on the same side of the line of action (180°)?                                 | major                                         |
| `cut:character_appearance:<id>` | `identity`               | Is the same Character recognisably the same person, against the frozen Lock / identity refs? | critical when locked, else major              |
| `cut:wardrobe:<id>`             | `wardrobe`               | Same costume, hair, makeup and jewellery across the cut (frozen Lock / Look)?                | critical when locked, else major              |
| `cut:prop:<slug>`               | `props`                  | Does a declared prop persist, stay in the same hand or place, and keep its state?            | major                                         |
| `cut:object_continuity`         | `props`                  | Does a salient object disappear, appear or jump position unexpectedly at the cut?            | minor (major when declared)                   |
| `cut:geography`                 | `geography`              | Are the Characters' relative positions and the set geography consistent?                     | major                                         |
| `cut:lighting`                  | `lighting`               | Is the key direction / colour / time-of-day look continuous?                                 | minor; major if the time of day seems to jump |
| `cut:action_match`              | `action_continuity`      | Does B's action continue A's (match on action, pose, position)?                              | major                                         |

None of them reuse a within-Shot criterion key. `screen_direction` inside a Shot asks "did the subject travel as
declared?". `cut:screen_direction` asks "is the direction continuous across two clips?". They are different questions
with different evidence, so the keys differ while the categories (and therefore the UI grouping and finding table)
are shared.

**Calibration-gated:** every semantic family above. Until a 3A.4 calibration accepts a family (§9), its criteria
are planned `unsupported` with "Cross-cut <family> is not yet calibrated", and they stay `unchecked`. **Manual:**
anything only a person can judge (protected composition notes, story intent) stays manual, as for Shots.

## 5. Cross-cut evidence: what the analyzer receives

The analyzer receives the minimum that shows both sides of the cut.

| Input (inputId)                            | Kind           | Content                                                                                                                                   |
| ------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `left:clip`                                | `video`        | The last W ms of A's **used** interval (§6), audio stripped                                                                               |
| `right:clip`                               | `video`        | The first W ms of B's used interval, audio stripped                                                                                       |
| `left:last`                                | `output_frame` | A's exact last displayed frame (frame-accurate at the edit rate)                                                                          |
| `right:first`                              | `output_frame` | B's exact first displayed frame                                                                                                           |
| `ref:left:<role>:n` / `ref:right:<role>:n` | `reference`    | Only what a criterion's `referenceRoles` needs: frozen Lock / identity images, Location View image, the attempt's frozen Production Frame |
| criteria text                              | data           | Expected value, `sourceRef`, side metadata (declared direction, exit / entry), `crossesScene`                                             |

Rules carried over from 3A.3:

- Prism supplies the expected truth. The analyzer does not decide what continuity should be.
- References are per side and per criterion (`referenceRoles`), so a wardrobe criterion sends the two Lock images, not
  every reference of both Shots.
- Editorial and camera metadata go as text (Prism-owned), never inferred.
- No full video unless a future criterion proves edges are insufficient. That would be a separately reviewed policy.

## 6. Media minimisation and cut-edge windows

**Policy `cut-edge-static-v1` (proposed; window length and rate are a calibration question, not an assumption):**

| Setting      | Value                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------- |
| Left window  | `[max(sourceIn_A, sourceOut_A − W), sourceOut_A]`: the end of the picture actually used in the edit |
| Right window | `[sourceIn_B, min(sourceOut_B, sourceIn_B + W)]`: the start of the picture actually used            |
| W            | **2000 ms** per side (clamped to the item's used duration)                                          |
| Sampling     | static, **4 fps** (the calibrated 3A.3 rate), so about 8 frames per side                            |
| Audio        | **stripped** (3A.4 excludes audio and lip sync, so no audio leaves Prism)                           |
| Edge stills  | exactly 2: A at `sourceOut_A − 1 frame`, B at `sourceIn_B`, quantised at the edit rate              |
| Bounds       | each clip ≤ 3 s and ≤ 20 MB; MP4/WebM; a known duration and a recorded checksum                     |

A normal cut sends **about 4 s of video and 2 stills** instead of two whole Shots: roughly 40–70 % less video than
two 3–10 s Shots, and no audio.

## 7. Derived clips: deterministic, checksummed, persisted

Prism produces the windows locally, before submission, in the app server under the owner's session. This is the same
place and authority that already produces review frames and contact sheets (`ensureReviewArtifacts`).

- **Operation:** the existing `asset_derivations` operations `trim` (clip) and `frame_extract` (still). The clip is
  re-encoded frame-accurately (a stream copy would start at a keyframe outside the window), with fixed encoder
  settings and `-an`. This needs a small processor method (`extractWindow(bytes, startMs, endMs)`), because the
  current `trimVideo` only trims from 0.
- **Lineage:** `derivation_key = sha256(parent checksum | operation | {startMs, endMs, audio: "stripped", policy} |
processor version)`. That key already exists in 0020 and is unique per Project, so re-preparing the same window is
  a no-op, and the parent is always recorded.
- **Checksum:** the child Asset records its own sha256. The frozen job names the child Asset and its checksum, and the
  worker re-verifies that checksum before sending (the existing fail-closed rule).
- **Exact timestamps:** each clip's `AnalysisMedia` carries the window
  (`window: { parentAssetId, parentChecksum, startMs, endMs }`), so evidence at clip time `t` maps to source time
  `startMs + t` and to edit-timeline time `itemStart + (startMs + t − sourceIn)`.
- **Persisted, not ephemeral.** The worker can only read Assets named in its job and cannot write Storage. Evidence
  must also stay reviewable: the Supervisor plays the exact clip the analyzer saw. Clips are small derived Assets,
  tagged `cut-edge` and `derived`. A later storage-hygiene task may prune orphaned cut-edge Assets that no run
  references (open question).
- **Identity uses the parent, not the child bytes.** Re-encoding may differ across ffmpeg builds, so the cut
  fingerprint uses the parent checksum plus the window. The child checksum is recorded for audit and for the send.

## 8. Provider model: one contract, one new mode

`ContinuityAnalysisProvider` is reused. It gains **one analysis mode, `sequence_transition`** (proposed name), next to
`image_set` and `direct_video`.

- `direct_video` means "one Shot's video, timestamped inside it". Stretching it to two videos would break the
  single-video assumptions in `plan.ts`, `prompt.ts` and `prepare.ts`, and would blur accepted 3A.3 semantics.
- `image_set` can carry two edge stills, but not motion (direction of travel, action match).
- `sequence_transition` carries **two sided clips, two edge stills and sided references** in one request, with its
  own prompt (`continuity-gemini-transition-v1`) and validation rules (§10). Plans, manifests, the frozen snapshot,
  the worker queue, costs and findings are the existing machinery.

There is no Gemini-specific pipeline. A provider declares the mode in `modes()` and the capability in
`capabilities()`. Mock implements it for free tests, and the shared provider-contract suite gains the mode. OpenAI
does not declare it (its models take no video).

## 9. Capability and calibration

`video_temporal` calibration proves within-Shot judgement on one clip. It does **not** prove comparison across two
clips. 3A.4 therefore keeps the two separately identifiable:

- **New capability `cross_cut`** (proposed name), declared only for the `sequence_transition` mode and only when
  `GEMINI_CROSS_CUT_CALIBRATED` is true. It has its own **accepted-family list** (`CROSS_CUT_ACCEPTED_FAMILIES`,
  initially empty). A family not on the list stays `unsupported`. Unlike 3A.3's single switch, 3A.4 can then
  production-enable direction and eyeline while, for example, lighting is still being calibrated.
- `GEMINI_LIP_SYNC_CALIBRATED` is unrelated and untouched. `VIDEO_CAPABILITIES` stays `["video_temporal"]`.
- **Production default:** OFF. Semantic cut findings are not production-enabled until a 3A.4 calibration gate,
  separately authorised, accepts them.

### Sequence calibration `sequence-calibration-v1` (sketch; not built in this gate)

The fixtures are deterministic synthetic pairs, two ffmpeg-rendered clips per fixture. They are cut-edge windows
produced by the real `cut-edge-static-v1` extraction, so calibration also exercises the clipping. Each family has a
positive control (continuity holds → `pass`) and a conflict control (continuity broken → `fail`). The truth is frozen
in the fixture set, and the input hash is checked before execution.

| Family              | Positive control                                                                     | Conflict control                          |
| ------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------- |
| screen direction    | square exits A moving L→R, enters B moving L→R                                       | B moves R→L                               |
| eyeline             | A subject looks screen-right; B target sits screen-left of frame centre, facing back | B's target faces away / same side         |
| axis (180°)         | two marked subjects keep their left/right order                                      | their order swaps across the cut          |
| character position  | subject at the same relative position (match)                                        | subject jumps to the opposite third       |
| object continuity   | prop present on both sides                                                           | prop disappears in B                      |
| wardrobe            | same colour / pattern garment                                                        | garment colour changes                    |
| geography           | landmark on the same side                                                            | landmark mirrored                         |
| match on action     | motion phase continues (arm at 60 % → 65 %)                                          | motion restarts / mistimed (60 % → 10 %)  |
| lighting            | key light from the same side and colour                                              | key flips side / colour temperature jumps |
| inter-Scene control | any change across a Scene boundary                                                   | expected `n_a` (no request is sent)       |

Acceptance is pre-registered, the same as 3A.3: 3 trials per fixture, 3/3 correct per fixture, conflict controls must
be `fail` (`warn` and `unchecked` count as wrong), evidence must cite **both sides** with timestamps inside each clip,
and a provider-access / request-contract fail-fast applies. It is accepted per family. The result of each run is
recorded in this doc like the 3A.3 attempts.

## 10. Taxonomy, findings and evidence

### Taxonomy

The keys in §4 are prefixed `cut:` and use the **existing `continuity_findings.category` enum** (`screen_direction`,
`eyelines`, `camera`, `identity`, `wardrobe`, `props`, `geography`, `lighting`, `action_continuity`,
`location_set`, `time_of_day`, `other`). No category migration is needed.

| Kind              | Families                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic     | picture, source integrity, source currentness, side Shot QA, link, Location / View, Character Lock / Look, declared direction / time / props |
| Semantic          | screen direction, eyeline, axis, character appearance, wardrobe, prop, object, geography, lighting, action match                             |
| Calibration-gated | **all semantic families** (each separately, §9)                                                                                              |
| Manual            | protected composition, story intent                                                                                                          |

### A transition finding

It is an ordinary `continuity_findings` row on a transition run. Every field below already exists, or comes from the
run's transition subject:

| Needed                                | From                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| left Shot, right Shot                 | the run's transition subject (§15)                                                                                                 |
| criterion, severity, expected, source | `criterion_key`, `severity`, `expected`, `source_ref` (frozen)                                                                     |
| result, explanation, confidence       | `result`, `actual` / `notes`, `confidence`                                                                                         |
| evidence from left / right            | `evidence[]` items whose `input` is `left:*` or `right:*` (side = the input's prefix)                                              |
| analyzer / version / model            | the run (`analyzer`, `analyzer_version`) and the job (`model`)                                                                     |
| calibrated?                           | the frozen plan records the capability and the accepted-family list version; a finding exists only for a planned (accepted) family |

### Evidence: the existing schema is enough

Evidence is already `{ input, timestampMs, endMs, observation }`, and `input` must be an input of the request.
Because each sided input has its own `inputId` and its own `durationMs`, the existing `videoEvidenceProblem` bounds
check works per clip unchanged. **No new evidence schema.** `ANALYSIS_SCHEMA_VERSION` stays `2`.

Two validation rules are added for `sequence_transition` answers only:

1. A `pass`, `warn` or `fail` must cite at least one timestamped `video` or edge-frame item from **each** side. A
   one-sided judgement is a request-contract error and goes through the existing single correction.
2. An edge-frame item may only carry its own exact position (the existing still rule).

Ambiguous evidence ("the subject turns") without an input cannot be written: the input is mandatory, and the side is
the input's prefix.

## 11. Result semantics for a cut

Same enum (`pass · warn · fail · n_a · unchecked`), with cut meanings:

| Result      | Meaning at a cut                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `pass`      | No deviation from the declared continuity was found in the evaluated evidence. **Not approval**                      |
| `warn`      | A **possible continuity deviation that needs human review**. Never "the AI disliked the edit"                        |
| `fail`      | A clear contradiction of declared continuity truth (or a source-integrity failure)                                   |
| `n_a`       | The criterion does not apply to this cut (Scene boundary, Character not on both sides)                               |
| `unchecked` | Could not be judged: placeholder, no picture, not calibrated, not allowed, no media. Always with the specific reason |

The rubric that defines these meanings for cuts is versioned separately: `sequence-rubric-1`. Shot runs keep
`continuity-rubric-1`.

## 12. Intentional discontinuity: a first-class human decision

Two different human statements are kept apart:

| Statement                                  | Mechanism                                                      | Effect                                                                         |
| ------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| "The analyzer is wrong about this finding" | **Existing** `continuity_overrides` (append-only, latest wins) | The effective result changes for that finding of that run                      |
| "This cut is deliberately discontinuous"   | **Cut intent** (new, editorial truth)                          | Findings inside the declared scope show as **intentional**; the evidence stays |

Overrides alone cannot express intent. A `pass` override would claim the analyzer was wrong when it was right, and an
override belongs to one run. The next trim makes a new run, and the filmmaker would have to re-declare a montage after
every frame nudge.

**Cut intent** (proposed) lives on the **incoming** item of the cut, because the intent of a cut is an editorial
decision of the edit:

```
episode_edit_items.incoming_cut_intent jsonb null
  { fromItemId,            -- the left item this intent was declared against
    kinds: [...],          -- jump_cut | montage | match_cut | time_jump | location_jump | dream_flashback
                           -- | axis_break | lighting_transition | wardrobe_progression | other
    scope: [...],          -- affected categories, e.g. ["time_of_day","lighting","wardrobe"]; [] = all
    note,                  -- required
    declaredBy, declaredAt }
```

- It is set through an explicit edit operation (`set_cut_intent` / `clear_cut_intent`). That operation goes through
  the edit's existing revision compare-and-set and owner RLS. QA code never writes it.
- **Projection, not truth rewriting:** intent does not change criteria, results or evidence. The transition
  assessment shows a `fail` / `warn` inside the scope as "intentional (time jump, by <user>: <note>)" and leaves it
  out of the blocking counts. The system result stays visible.
- **Not part of freshness:** declaring intent never makes a run stale and never triggers analysis.
- **Survives trims and re-runs;** it **does not survive** a reorder. If B's left neighbour is no longer `fromItemId`,
  the intent is shown as "declared for a previous neighbour, not applied" until it is re-confirmed or cleared.
- **Alternative considered:** a separate `continuity_cut_intents` table. It was rejected because intent is
  editorial, belongs inside the edit's revision and concurrency model, and Phase 5 transitions (dissolves) will also
  be cut properties.

## 13. Freshness, trims and performance

A transition run is **stale** when any of these differ from the frozen values, and **only** these:

| Input                                                                                                                                                                         | Part of                     | Why                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------- |
| left side: kind, attempt, Asset + checksum, left window                                                                                                                       | `subject_fingerprint` (cut) | The frames at the cut changed           |
| right side: same, right window                                                                                                                                                | `subject_fingerprint`       |                                         |
| edit rate                                                                                                                                                                     | `subject_fingerprint`       | It moves the exact edge-frame positions |
| cut criteria (expected values from both Shots' frozen truth: Characters, Looks / Locks, Location / View, declared direction, time, props, geography, exit / entry, Scene ids) | `criteria_fingerprint`      | Truth changed                           |
| references (Lock images, Location View images, frozen Production Frames, with checksums)                                                                                      | `reference_fingerprint`     | Reference changed                       |
| `SEQUENCE_RULES_VERSION`                                                                                                                                                      | `rules_version`             | Criteria construction changed           |

**Not stale:** a change anywhere else in the Episode, the global edit revision, a reorder elsewhere, audio placements,
`source_audio`, cut intent, overrides, or a new analyzer version (that is new **coverage**, the 3A.3 rule).

**Trim sensitivity:** windows are computed from the trims, so changing A's out-point or B's in-point changes
`subject_fingerprint` and makes the cut stale. A's **in-point** matters only when A is shorter than W (the window then
reaches it). Changing it otherwise moves neither window, and the cut stays current. That is exact, not blunt.

**Performance sensitivity:** the evaluated media is picture-only (audio stripped). Placements, take selection and
audio timing **cannot alter it**, so they are excluded. A performance change matters only when it reaches the
picture, which is a new attempt, and therefore already a side change. The edit's own per-item performance facts
(`take_superseded`, `performanceChanged`) stay visible on the edit, not as cut staleness.

## 14. Transition analysis identity

Deterministic, with no timestamps:

```
transition run truth = (project, editId, leftItemId, rightItemId,
                        subject_fingerprint, criteria_fingerprint, reference_fingerprint, rules_version)

job idempotency key  = sha256(transition run truth
                        | provider id | sequence analyzer version | model
                        | prompt version | rubric version | sampling policy id
                        | calibration version + accepted-family list
                        | nonce)                -- "auto-sequence-v1", or a fresh per-batch nonce for a manual batch
```

The existing `unique (project_id, idempotency_key)` makes a repeat return the same job. `subject_fingerprint` is
`sha256("cut-subject-v1" | left side | right side | edit rate | window policy)`, where a side is `kind | attemptId |
assetId | parent checksum | startMs | endMs`, or `kind | frameId | checksum` for a placeholder.

## 15. Persistence: compare and recommend

| Option                                                              | For                                                                                    | Against                                                                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **A.** Widen `continuity_runs` with transition columns              | One table                                                                              | About 10 nullable columns on the Shot run row, a wider guard trigger, and every Shot query must ignore them     |
| **B.** Generalise the run **subject** + a minimal 1:1 subject table | Findings, overrides, jobs, costs, events, worker reused unchanged; Shot rows untouched | Two small schema changes + one table                                                                            |
| **C.** Projection only, with no persisted transition runs           | No migration                                                                           | Cannot hold frozen semantic findings, overrides, jobs or cost; this is a second QA system for the semantic half |
| A separate transition QA stack (runs / findings / jobs)             | —                                                                                      | A parallel QA system. **Rejected**                                                                              |

**Recommendation: B, with deterministic cut checks as a pure projection (the C part) until a transition run freezes
them.**

- Deterministic cut facts are computed on read, like the Sequence Board, and cost nothing. Persisting them would add
  writes on every edit for no audit value.
- A semantic transition run (manual or automatic) freezes the deterministic findings of that truth together with the
  semantic ones: the 3A.2 "one run per truth" rule.

### Proposed migration 0046 (NOT created or applied in this gate)

1. `continuity_runs`:
   - add `subject_kind text not null default 'shot' check (subject_kind in ('shot','transition'))`;
   - relax `attempt_id` and `subject_asset_id` to nullable, under
     `check ((subject_kind = 'shot') = (attempt_id is not null and subject_asset_id is not null))`;
   - extend `guard_continuity_run` to freeze `subject_kind`.

   Existing rows become `'shot'` and are otherwise unchanged. `unique (attempt_id, run_number)` still holds for Shots
   (nulls are distinct).

2. `continuity_analysis_jobs`: the same `subject_kind` plus a nullable `attempt_id` under the same check; the guard
   freezes it. The worker's column grants are unchanged (it needs neither field).
3. **New table `continuity_transition_subjects`** (1:1 with a transition run):
   - `run_id` (unique, FK `(run_id, project_id)` → runs, on delete cascade), `project_id`;
   - `edit_id` (FK `(edit_id, project_id)` → `episode_edits`, on delete cascade), `episode_id`, `edit_revision`
     (audit only), `transition_key`, `run_number`;
   - `left_item_id`, `right_item_id`, `left_shot_id`, `right_shot_id`;
   - `left_side jsonb`, `right_side jsonb` (kind, attempt, Asset, parent checksum, window, edge-still Asset);
   - `crosses_scene`, `created_at`, `created_by`;
   - `unique (project_id, transition_key, run_number)`, plus an update guard refusing every change (frozen).

   Item, Shot and attempt ids are **recorded history, not FKs**, so removing an item from the edit never deletes or
   blocks QA history (0043's rule that upstream changes never cascade into the edit, mirrored).

4. `episode_edit_items.incoming_cut_intent jsonb null` with a shape check (§12).

**Security in 0046:**

- RLS: owner-only `for all` policy (`is_project_owner(project_id)`) on the new table, like every user-domain table.
- **Explicit grants**, per the migration policy that applies from 0045 on: `grant select, insert on
continuity_transition_subjects to authenticated`; `revoke all … from anon`. There is no update or delete grant (the
  row is frozen; deletion only cascades).
- **No grant to `prism_generation_worker` or `prism_continuity_worker`.** The worker reads only its frozen job and the
  Assets named in it, so it needs nothing new.
- Code obligations from the audit: every Shot-run query (`distinct on (attempt_id)`, `max(run_number) where
attempt_id`, the asset-in-use check) filters `subject_kind = 'shot'`, and that is tested. The asset-in-use check
  also counts cut-edge Assets named by transition jobs.

The Project sequence-automation policy columns (§17) are a **later, separate migration** (proposed 0047, slice
3A.4F), so each migration ships with the code that uses it. Neither is created in this gate.

## 16. Supervisor UI, Episode Edit and Sequence Board

**Route:** `/projects/[project]/episodes/[ep]/continuity`, named **Continuity Supervisor**. It is a **separate route
from the Sequence Board, and the two link to each other**: the Sequence Board reviews planned order and canonical
stills before an edit exists or changes; the Supervisor reviews the actual edit's cuts. They answer different
questions from different orders, so tabs on one route would show two orders and imply they are the same.

**Header counts** (each a filter, each traceable to findings, **no score**):

- cuts in the edit;
- reviewed (current semantic run);
- critical breaks;
- needs review;
- unchecked;
- stale;
- intentional accepted;
- deterministic-only (no semantic run).

**One row per cut, in edit order:**

- A → B edge thumbnails (A's last frame, B's first frame, through the private Asset route);
- Shot codes and the Scene (with a Scene-boundary marker);
- the transition state (§18) and the top issue (criterion, side, expected vs observed);
- intent and override badges;
- stale / current with the reason;
- a link to each side's Shot QA.

**Expanded cut:**

- the two edge clips, playable side by side, with evidence markers mapped to clip, source and edit time;
- the criteria grouped by severity, then result, with sided evidence;
- the frozen references per side;
- the run history;
- the override form (existing);
- the cut-intent form (an edit operation).

**Filters:** critical / fail · warn · unchecked · stale · intentional · Scene (client-local, like the board).

**Episode Edit integration (minimal):** a small **cut marker** between items: a dot coloured by state, plus a count
only when issues exist. It links to `/continuity#cut-<leftItemId>-<rightItemId>`. There is no inline evidence and no
panel, so the editor does not become a QA dashboard. The edit page performs no reconciliation that sends media.

**Sequence Board integration:**

- the board is unchanged except for one link, "Review cuts in the Episode Edit →", when an edit exists;
- its `describeTransition` becomes the shared pure function (§4);
- the board's "do these stills cut together?" stays its own planning job.

## 17. Orchestration, budget, concurrency and cost

**Generalising 3A.2 reconciliation:** `reconcileSequenceQa({ editId })` is authenticated, idempotent and explicit.

| Trigger                                    | What happens                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Any read (page, GET)                       | **Nothing is written.** Reads compute the deterministic projection and "due" facts only                                |
| An edit mutation succeeds                  | Deterministic projection only (free, nothing persisted). Semantic work is **never** fired from inside an edit mutation |
| Supervisor visit, Project mode `suggest`   | "N cuts due for semantic QA (estimate $X)" with a **Review batch** button                                              |
| Supervisor visit, Project mode `automatic` | Submits due **settled** cuts within the limits below                                                                   |
| Explicit **Review batch** (manual)         | One confirmation for the batch: cuts, windows, provider, model, worst-case total. A fresh batch nonce                  |

**Settling:** a cut is automatically submittable only when its subject fingerprint has been unchanged for a settle
window (proposed 10 min since the last edit revision that changed it). Rapid trimming therefore queues nothing.
Settling only filters; there is no timer or scheduler.

**Policy (later migration, 3A.4F):** `project_qa_policies.sequence_semantic_mode` (`off` default, `suggest`,
`automatic`) and `max_transitions_per_batch`, which defaults low (proposed 20).

- `automatic` requires an analyzer, the existing `external_media_allowed`, the existing `direct_video_allowed`, and
  finite ceilings. These are database-checked like 0044.
- Shot `semantic_mode = automatic` **never implies** sequence automation. It is a separate standing authorisation
  with its own confirmation text.

**Budget:** each transition is one run, so the existing gates apply per cut, in order:

1. policy completeness;
2. the analyzer is runnable and `cross_cut` is declared for the family;
3. the plan has an analysable criterion;
4. the Project per-run and 24-hour ceilings (the **same** ledger and 24-hour total as Shot QA, so sequence spend
   cannot exceed the Project's daily QA ceiling);
5. the global analysis gate;
6. the batch cap and the sum of worst-case estimates ≤ the remaining 24-hour budget **before** the first submission.

An unknown estimate never auto-submits.

**Concurrency:** there is no new queue. Durable state is the existing jobs, and "due" is computed.

- **Waves:** each reconciliation submits at most `min(batch cap, maxActivePerProject − active)` jobs (the existing
  limit, default 3). The existing poller refreshes when a job finishes, and the next reconciliation submits the next
  wave.
- **Pause / resume:** closing the page pauses, because nothing runs without an authenticated reconciliation. Switching
  the mode to `off` / `suggest` stops new submissions, and cancelling queued jobs uses the existing cancel. A manual
  batch that was not finished shows "Resume batch (N remaining)" and needs a new confirmation.
- **Idempotency:** the identity in §14. Double clicks, two tabs and retries return existing jobs.
- **Ordering:** edit order, with critical-capable cuts (locked Characters on both sides) first.

**Cost model:**

- An Episode of n items has n − 1 cuts. As a planning assumption (not measured from Project data), an Episode of
  30–120 Shots has 29–119 cuts, and perhaps 60–85 % of them are inside a Scene. Inter-Scene cuts send nothing by default.
- **Input per intra-Scene cut:** 2 clips × 2 s × 4 fps × 300 tokens ≈ 4.8k, plus 2 stills, plus ≤ 4 sided references,
  plus criteria text. That is about 8–12k input tokens and about 1–2k output.
- **Observed baseline:** the accepted 3A.3 calibration cost **$0.110537 for 48 requests**, about $0.0023 per request
  with one short clip each.
- **Estimate:** about $0.003–0.006 per cut, with a worst case of about 2× (one correction). A 100-cut Episode with 80
  intra-Scene cuts is then roughly **$0.25–0.50**, with a worst case of about $1.
- These are planning estimates. 3A.4E measures them, and the per-request worst-case estimator stays the gate.

## 18. Transition status, severity and the dashboard

**Computed state per cut** (pure projection, `assessTransition`, precedence in table order, mirroring Shot QA):

| State                  | Label                              | Meaning                                                                                                       |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `no_sequence_qa`       | No sequence QA yet                 | Deterministic facts only; no transition run exists for this truth                                             |
| `sequence_stale`       | Sequence QA stale                  | The latest run no longer matches this cut (which side, trim, truth or reference)                              |
| `critical_break`       | Critical continuity break          | A fresh, effective critical FAIL **not** covered by cut intent                                                |
| `analysis_running`     | Sequence QA running                | A job is queued or running                                                                                    |
| `needs_review`         | Needs review                       | A fresh major / minor FAIL or any WARN not covered by intent                                                  |
| `unchecked_transition` | Unchecked transition               | Nothing failing, but a critical / major cut criterion is unchecked (placeholder, not calibrated, not allowed) |
| `intentional_accepted` | Intentional discontinuity accepted | Every remaining FAIL / WARN is inside a declared cut intent                                                   |
| `no_blocking_mismatch` | No blocking mismatch found         | Nothing failing or warning in the evaluated criteria. **Not approval, not "continuity perfect"**              |

A deterministic `cut:source_integrity` fail is a `critical_break` even without a semantic run. That is the one case
where a deterministic fact leads.

**Severity** is Prism-owned per criterion (the §4 tables), never returned by a provider, and advisory:

- **critical:** a wrong Character identity (locked); a locked Look / wardrobe contradiction; a source-integrity
  failure;
- **major:** axis or geography swap, screen direction reversal, eyeline mismatch, a declared prop vanishing, an
  action mismatch;
- **minor:** subtle lighting variation, undeclared object drift, a borderline eyeline.

Across a Scene boundary, most of these criteria are `n_a`.

**Dashboard:** counts only (§16 header). Every number is a filter that lists the cuts and findings behind it. There is
no Episode continuity score.

## 19. Security and consent

The 3A.1–3A.3 guarantees are preserved:

- **Authority:** authenticated owner, owner-only RLS, explicit `authenticated` grants on any new table, `anon`
  revoked.
- **Workers:** no generation-worker access. The continuity worker's privileges are **unchanged**: it executes a
  frozen job and reads only the Assets it names.
- **Media path:** private media through the existing Asset route; no signed URL is stored; checksums are re-verified
  before send; provider-file cleanup as in 3A.3; every spend gate applies.

**Consent: reuse `direct_video_allowed`.** Cut-edge windows are bounded, audio-free portions of the same Project's
Shot output video, strictly less than the full video that permission already allows. A new flag would multiply
consents without adding protection.

- What is sent must be disclosed exactly. The manual batch confirmation lists, per cut: two windows (source, start,
  end, about 2 s each), two edge stills, the sided references, "audio is not sent", the provider and model, inline vs
  temporary file, and the worst-case cost.
- The permission's UI wording becomes "full Shot video or bounded cut-edge windows". That needs **owner sign-off**
  because 0045's comment says "full selected delivery video" (§21, Q1).
- One difference to disclose: a cut may pin a delivery version or a provider output that is **not** the Shot's
  selected delivery master. Consent is per Project media, not per selection.
- Without the permission, every semantic cut criterion is `not_allowed` / `unchecked`, and the deterministic checks
  still run.

**Server gate:** reuse `PRISM_STUDIO_GEMINI_DIRECT_VIDEO`. The capability is still off until calibrated (§9). A
separate env switch is an open question (Q3).

## 20. Versioning

| Identity                     | Recommendation                                  | Why                                                                                                                                                                                 |
| ---------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTINUITY_RULES_VERSION`   | **unchanged `3a.1`**                            | Shot criteria do not change. Bumping it would make **every** Shot run stale for nothing                                                                                             |
| `SEQUENCE_RULES_VERSION`     | **new `3a.4`**                                  | Cut criteria construction is new and versioned on its own                                                                                                                           |
| Gemini analyzer (Shot modes) | **unchanged `3`**                               | The analyzer version is in the automatic Shot QA identity. Bumping it would queue one new paid Shot run per output on every automatic Project, though Shot behaviour did not change |
| Sequence analyzer version    | **new, mode-scoped `gemini-sequence-1`**        | Recorded as the transition run's `analyzer_version`. The worker's `analyzer_version_mismatch` guard compares per subject kind                                                       |
| Prompt                       | **new `continuity-gemini-transition-v1`**       | A new instruction and sided-evidence contract; the Shot prompts are unchanged                                                                                                       |
| Rubric                       | **new `sequence-rubric-1`** for transition runs | Cut meanings of `warn` / `n_a` (§11); Shot `continuity-rubric-1` unchanged                                                                                                          |
| `ANALYSIS_SCHEMA_VERSION`    | **unchanged `2`**                               | The evidence and finding shape is unchanged (§10)                                                                                                                                   |
| Analysis input snapshot      | **version 2 for transition inputs only**        | A transition subject replaces `attemptId` / `subjectAssetId`, and media gain `window`. Shot snapshots stay version 1, byte-identical, so their keys do not move                     |
| Sampling / window policy     | **new `cut-edge-static-v1`**                    | Window length, rate, audio stripping and edge stills                                                                                                                                |
| Calibration                  | **new `sequence-calibration-v1`**               | Independent of `temporal-calibration-v2`                                                                                                                                            |

**Relationship to 3A.3:** purely additive. `video_temporal`, its calibration, prompts, schema, the analyzer v3
identity and `VIDEO_CAPABILITIES` are untouched. The within-Shot capability stays calibrated, and the cross-cut
capability is separately identifiable.

**Relationship to Phase 5:** 3A.4 **reads** the existing Episode Edit and annotates its cuts. The one edit write is
the human cut-intent operation. 3A.4 adds no trimming UI, transitions (dissolves), multitrack, export or NLE
behaviour.

## 21. Open questions

| #   | Question                                                                                                                                                                         | Proposed default                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Q1  | Does `direct_video_allowed` cover bounded cut-edge windows of any edit-pinned Shot output, including a non-selected delivery version? (needs owner sign-off; UI wording changes) | Yes, with exact disclosure                      |
| Q2  | Should cut intent be a column on `episode_edit_items` (recommended) or its own table?                                                                                            | Column                                          |
| Q3  | Is a separate server switch for sequence semantic QA wanted, beyond the calibration constant?                                                                                    | No, until hosted acceptance                     |
| Q4  | W = 2000 ms and 4 fps, or measure 1.5 / 3 s in calibration first?                                                                                                                | Calibrate 2 s; record alternatives              |
| Q5  | Should semantic still-pair checks for placeholder cuts exist (planning-grade), or stay with the Sequence Board?                                                                  | Stay unchecked in 3A.4                          |
| Q6  | Retention of cut-edge Assets that no run references                                                                                                                              | Keep; a later hygiene task                      |
| Q7  | Final public names: `sequence_transition` mode, `cross_cut` capability                                                                                                           | As proposed, pending provider-capability review |

## 22. Implementation slices

Each slice is separately reviewed and gated. None has started.

| Slice     | Scope                                                                                                                                                                                                                                                                                                            | Migration           | Paid / live calls           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------- |
| **3A.4A** | **Cut domain + deterministic projection:** `CutTransition` from the Episode Edit, side truth, edge windows, subject / criteria / reference fingerprints, cut criteria, deterministic findings, `assessTransition` status, shared `describeTransition` (the Sequence Board output is unchanged). Pure, plus tests | none                | 0                           |
| **3A.4B** | **Supervisor UI (deterministic):** the Episode route, cut rows, filters, counts, the Episode Edit cut markers, Sequence Board ↔ Supervisor links; memory E2E                                                                                                                                                     | none                | 0                           |
| **3A.4C** | **Persistence + human intent:** 0046 (run `subject_kind`, transition subjects table, cut intent column, explicit grants), repositories, the Shot-query `subject_kind` filters, cut-intent edit operations, overrides on transition findings; RLS / worker-role proofs; hosted apply as its own gate              | **0046**            | 0                           |
| **3A.4D** | **Semantic cut analyzer:** `extractWindow`, cut-edge derivations, the `sequence_transition` mode in the plan / prompt / validation (sided-evidence rules), Mock + Gemini adapter behind the fake transport, manual batch submission with disclosure; `cross_cut` declared **nowhere in production**              | none                | 0                           |
| **3A.4E** | **Calibration:** `sequence-calibration-v1` fixtures + harness, the input hash, pre-registered acceptance; then a **separately authorised** live gate; accepted families recorded                                                                                                                                 | none                | only in the authorised gate |
| **3A.4F** | **Automatic orchestration + hosted acceptance:** sequence policy (0047), settling, waves, batch caps, the budget sum, reconciliation triggers; hosted verification; final acceptance                                                                                                                             | **0047** (proposed) | 0 unless authorised         |

3A.4A and 3A.4B deliver value (free, deterministic cut review in edit order) before any schema change. Semantic cut
QA cannot appear in production before 3A.4E accepts a family.

## 23. Out of scope for 3A.4

- automatic regeneration, edit changes, approval or rejection;
- music continuity, audio mixing, lip sync (enablement stays separately gated), captions;
- NLE export or any Phase 5 editor feature;
- cross-Episode continuity;
- face embeddings, Claude vision, automatic provider routing / failover;
- persistent 3D requirements;
- full-video cut analysis.
