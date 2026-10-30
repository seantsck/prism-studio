# Sequence Continuity Supervisor (Phase 3A.4)

**Status: architecture accepted; 3A.4A–C implemented; 3A.4D–F pending (2026-10-29).** The owner reviewed this
design and accepted it with fixes, and those fixes are applied below. The owner decisions are recorded in
[§21](#21-owner-decisions-and-implementation-details). 3A.4A (the pure cut domain and deterministic projection,
[§22](#3a4a-implementation-notes)), 3A.4B (the deterministic Supervisor UI, [§22](#3a4b-implementation-notes)) and
3A.4C (migration 0046: transition persistence and predecessor-bound cut intent, [§22](#3a4c-implementation-notes))
exist. 0046 is verified on a disposable local database only and is **not applied to hosted**. There is still no
semantic transition analysis, provider mode, provider call, media derivation or calibration for 3A.4. Each
implementation slice ([§22](#22-implementation-slices)) is its own gate.

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
| left / right performance    | **no** (see §13)                | Audio placements do not change the pixels a visual cut check examines                                                                                                            |
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

**Applicability is Prism's decision, made at planning, before anything is submitted.** A criterion that does not apply
is recorded `n_a` by Prism and is never sent. The analyzer is never asked whether a criterion applies, and it cannot
answer `n_a` (§10).

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

**Policy `cut-edge-static-v1` (owner decision Q4: 2,000 ms per side at 4 fps):**

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

The window is **not** tuned before v1 exists. No calibration gate is spent comparing 1.5 s with 3 s. The 3A.4E
calibration tests whether this 2-second policy is sufficient. If evidence later shows it is not, Prism introduces
`cut-edge-static-v2` as a new policy id (which is part of the job identity) and never silently changes v1.

## 7. Derived clips: deterministic, checksummed, persisted

Prism produces the windows locally, before submission, in the app server under the owner's session. This is the same
place and authority that already produces review frames and contact sheets (`ensureReviewArtifacts`).

**When derivation happens (owner decision Q6).** Cut-edge clips and stills are created **only** during explicit
semantic preparation or submission, and **only for the cuts selected into the current batch or wave**. They are
**never** created:

- on page reads;
- by the deterministic projection;
- merely because an edit changed.

The order is fixed: plan first, then pass the consent, policy and budget gates, then derive media for the bounded
selected wave only. If an Episode has 100 cuts and the batch cap is 20, at most those 20 cuts' windows are derived. The
other 80 are not touched before they are selected. Trim experimentation therefore never eagerly creates Assets.

- **Operation:** the existing `asset_derivations` operations `trim` (clip) and `frame_extract` (still). The clip is
  re-encoded frame-accurately (a stream copy would start at a keyframe outside the window), with fixed encoder
  settings and `-an`. This needs a small processor method (`extractWindow(bytes, startMs, endMs)`), because the
  current `trimVideo` only trims from 0.
- **Lineage and deduplication:** `derivation_key = sha256(parent checksum | operation | {startMs, endMs, audio:
"stripped", policy: "cut-edge-static-v1"} | processor version)` for a clip, and `(parent checksum | frame_extract |
{atMs, policy})` for an edge still. That key already exists in 0020 and is unique per Project. Repeated preparation
  of the same window or frame reuses the same valid derivation, and the parent is always recorded.
- **Checksum:** the child Asset records its own sha256. The frozen job names the child Asset and its checksum, and the
  worker re-verifies that checksum before sending (the existing fail-closed rule).
- **Exact timestamps:** each clip's `AnalysisMedia` carries the window
  (`window: { parentAssetId, parentChecksum, startMs, endMs }`), so evidence at clip time `t` maps to source time
  `startMs + t` and to edit-timeline time `itemStart + (startMs + t − sourceIn)`.
- **Persisted, not ephemeral, and retained.** The worker can only read Assets named in its job and cannot write
  Storage. Evidence must also stay reviewable: the Supervisor plays the exact clip the analyzer saw. Clips are small
  derived Assets, tagged `cut-edge` and `derived`. 3A.4 retains them and adds **no garbage collector**. Cleanup of
  orphaned or unused cut-edge derivations (ones no run references) is a **later hygiene task**, outside 3A.4.
- **Identity uses the parent, not the child bytes.** Re-encoding may differ across ffmpeg builds, so the cut
  fingerprint uses the parent checksum plus the window. The child checksum is recorded for audit and for the send.

## 8. Provider model: one contract, one new mode

`ContinuityAnalysisProvider` is reused. It gains **one analysis mode, `sequence_transition`**, next to `image_set` and
`direct_video`. The name was accepted by the owner (Q7) as an internal contract name.

- `direct_video` means "one Shot's video, timestamped inside it". Stretching it to two videos would break the
  single-video assumptions in `plan.ts`, `prompt.ts` and `prepare.ts`, and would blur accepted 3A.3 semantics.
- `image_set` can carry two edge stills, but not motion (direction of travel, action match).
- `sequence_transition` carries **two sided clips, two edge stills and sided references** in one request, with its
  own prompt (`continuity-gemini-transition-v1`) and validation rules (§10). Plans, manifests, the frozen snapshot,
  the worker queue, costs and findings are the existing machinery.

There is no Gemini-specific pipeline. A provider declares the mode in `modes()` and the capability in
`capabilities()`. Mock implements it for free tests, and the shared provider-contract suite gains the mode. OpenAI
does not declare it (its models take no video).

The mode needs a **mode-scoped analysis version**, because the existing contract has one scalar `provider.version`.
That contract extension is specified in §14 and must be in place before 3A.4D.

## 9. Capability and calibration

`video_temporal` calibration proves within-Shot judgement on one clip. It does **not** prove comparison across two
clips. 3A.4 therefore keeps the two separately identifiable:

- **New capability `cross_cut`** (an internal contract name, accepted in Q7), declared only for the
  `sequence_transition` mode and only when
  `GEMINI_CROSS_CUT_CALIBRATED` is true. It has its own **accepted-family list** (`CROSS_CUT_ACCEPTED_FAMILIES`,
  initially empty). A family not on the list stays `unsupported`. Unlike 3A.3's single switch, 3A.4 can then
  production-enable direction and eyeline while, for example, lighting is still being calibrated.
- `GEMINI_LIP_SYNC_CALIBRATED` is unrelated and untouched. `VIDEO_CAPABILITIES` stays `["video_temporal"]`.
- **Production default:** OFF. Semantic cut findings are not production-enabled until a 3A.4 calibration gate,
  separately authorised, accepts them.
- **UI copy** says "Sequence Continuity" or "cut continuity". It never shows `cross_cut` or `sequence_transition`.

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
| inter-Scene control | any change across a Scene boundary                                                   | Prism plans `n_a`; no request is sent     |

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

### `n_a` is Prism's, never the analyzer's

There are two vocabularies, and they stay different:

| Layer                                            | Results                                |
| ------------------------------------------------ | -------------------------------------- |
| Prism continuity result (domain, findings table) | `pass · warn · fail · n_a · unchecked` |
| Normalized analyzer response (schema 2)          | `pass · warn · fail · unchecked`       |

3A.4 does **not** add `n_a` to the analyzer response schema. For sequence QA, `n_a` is assigned deterministically by
Prism at planning time, for example:

- screen-direction, eyeline, axis or action continuity across a Scene boundary;
- geography or lighting continuity where the edit changes Location or Scene under the rules;
- a Character criterion where the Character is not on both sides.

Such a criterion is never submitted. An answer to an `n_a` criterion would be an unknown `criterionId`, and existing
validation already rejects that. So analyzer schema 2 is unchanged, provider output never contains `n_a`, and the
transition projection can still show `n_a`.

## 11. Result semantics for a cut

Same enum (`pass · warn · fail · n_a · unchecked`), with cut meanings:

| Result      | Meaning at a cut                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pass`      | No deviation from the declared continuity was found in the evaluated evidence. **Not approval**                                                           |
| `warn`      | A **possible continuity deviation that needs human review**. Never "the AI disliked the edit"                                                             |
| `fail`      | A clear contradiction of declared continuity truth (or a source-integrity failure)                                                                        |
| `n_a`       | The criterion does not apply to this cut (Scene boundary, Character not on both sides). **Assigned by Prism's planning only**, never by an analyzer (§10) |
| `unchecked` | Could not be judged: placeholder, no picture, not calibrated, not allowed, no media. Always with the specific reason                                      |

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

**Cut intent (owner decision Q2)** lives in the Episode Edit's item representation as **incoming cut intent** on the
right-hand item, because the intent of a cut is an editorial decision of the edit. There is no standalone intent
table. The exact schema is deferred to 3A.4C. The sketch below is illustrative:

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
- **Bound to its predecessor (mandatory).** The intent is declared for one cut, A → B, so it records the item it was
  declared against: either `fromItemId` inside the payload or an equivalent companion predecessor-id field (3A.4C
  chooses which). An intent declared for A → B must never silently become C → B after a reorder.
- **Validity rule:** an intent is effective only when `intent.fromItemId === the current predecessor item id` of B. In
  every other case it is **not effective**: it covers no finding and changes no state.
- **Adjacency changes clear or invalidate it transactionally.** Every edit operation that changes B's predecessor
  (reorder, insert, remove, replacing an item) clears or invalidates the affected incoming intents in the **same
  transaction** under the edit's row lock. The validity rule is the backstop: even an intent that survived a bug never
  applies to the wrong cut. A UI may say "declared for a previous neighbour, not applied" before it is cleared.
- **Survives** trims and semantic re-runs. **Does not survive** adjacency changes or a reorder. **Never changes**
  analyzer evidence, results or criteria.
- **Alternative considered:** a separate `continuity_cut_intents` table. It was rejected by the owner because intent is
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
`source_audio`, cut intent, overrides, or a new analyzer version (that is new **coverage**, the 3A.3 rule). Nor are
the cut's edit facts (pinned picture, source integrity / currentness, linked Shot QA, the stored previous-Shot link):
they are recomputed on every read and composed into the assessment live, so they never need a stale run to appear.
The reference set is **criterion-relevant**: only references a currently applicable semantic criterion could use.

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

### Mode-scoped analyzer version (required before 3A.4D)

Today the provider contract has one scalar, `provider.version` (`src/continuity/analysis/provider.ts`). The worker
fails a job as `analyzer_version_mismatch` when `job.inputSnapshot.analyzerVersion !== provider.version`
(`src/continuity/analysis/worker.ts`). One scalar cannot say "Shot analysis is `3` and sequence analysis is
`gemini-sequence-1`".

**Contract extension:** the provider gains a mode-aware analysis identity, conceptually
`provider.analysisVersion(mode)` (the exact name is decided in implementation).

| Mode                        | Gemini returns      |
| --------------------------- | ------------------- |
| `image_set`, `direct_video` | `3` (unchanged)     |
| `sequence_transition`       | `gemini-sequence-1` |

**Invariants:**

- **Shot job identities are unchanged.** A Shot job freezes `3` exactly as today, so no Shot idempotency key or
  automatic Shot coverage key moves.
- **The Shot worker guard still sees `3`.** For a Shot job the worker compares against the Shot-mode version.
- **A transition job freezes `gemini-sequence-1`**, and the worker compares it against
  `analysisVersion("sequence_transition")`.
- Changing the sequence contract later (`gemini-sequence-2`) does not queue every Shot again. Changing the Shot
  analyzer (`3` → `4`) does not silently relabel or re-run transition jobs.
- **No silent request semantics under a frozen identity (the 3A.3 provenance rule).** A transition job frozen as
  `gemini-sequence-1` executes only against the exact sequence contract that version names. A provider at
  `gemini-sequence-2` fails a `gemini-sequence-1` job `analyzer_version_mismatch` before anything is sent, and the
  job is never re-labelled or re-interpreted.

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
   - add `subject_kind` (`attempt` | `transition`, default `attempt`);
   - allow `attempt_id` and `subject_asset_id` to be null **only** for a transition run;
   - extend `guard_continuity_run` to freeze `subject_kind`.

   Existing rows become `attempt` and are otherwise unchanged.

2. `continuity_analysis_jobs`: the same `subject_kind`, with `attempt_id` null only for a transition job; the guard
   freezes it. The worker's column grants are unchanged (it needs neither field).
3. **New table `continuity_transition_subjects`** (1:1 with a transition run):
   - `run_id` (unique, FK `(run_id, project_id)` → runs, on delete cascade), `project_id`;
   - `edit_id`, `episode_id`, `edit_revision` (audit only), `transition_key`, `run_number`. **3A.4C correction:**
     `edit_id` is NOT a cascading key to `episode_edits` (deleting the live edit would delete the subject and leave
     its run without one, breaking the exactly-one invariant); like the item / Shot ids it is recorded history, see
     [3A.4C notes](#3a4c-implementation-notes);
   - `left_item_id`, `right_item_id`, `left_shot_id`, `right_shot_id`;
   - `left_side jsonb`, `right_side jsonb` (kind, attempt, Asset, parent checksum, window, edge-still Asset);
   - `crosses_scene`, `created_at`, `created_by`;
   - `unique (project_id, transition_key, run_number)`, plus an update guard refusing every change (frozen).

   Item, Shot and attempt ids are **recorded history, not FKs**, so removing an item from the edit never deletes or
   blocks QA history (0043's rule that upstream changes never cascade into the edit, mirrored).

4. Incoming cut intent on `episode_edit_items` (§12), bound to its predecessor item id. The exact column shape is
   decided in 3A.4C.

**Subject invariants (database-enforced; the exact CHECK / FK design is 3A.4C's).** No malformed hybrid row may exist:

| Subject kind | Must hold                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `attempt`    | `attempt_id IS NOT NULL`, `subject_asset_id IS NOT NULL`, the Shot subject fields required, **no** transition subject row |
| `transition` | `attempt_id IS NULL`, **exactly one** `continuity_transition_subjects` row for the run                                    |

The same rule applies to jobs: an `attempt` job names its attempt, and a `transition` job does not. A job's subject
kind equals its run's.

**Transition run numbering.** Transition runs get their own deterministic numbering scope: run history per transition
address (`transition_key`), recorded on the subject row and unique there. Shot numbering
(`max(run_number) … where attempt_id = $1`, `unique (attempt_id, run_number)`) is never used or affected by transition
rows. 3A.4C defines the exact scope and SQL.

**Shot-query isolation (mandatory 3A.4C acceptance criterion).** Every existing Shot-oriented query over a generalised
table explicitly constrains `subject_kind = 'attempt'`. That includes at least the two already found in
`src/data/media-qa-postgres.ts` (`distinct on (attempt_id)` and `max(run_number) where attempt_id = $1`), but 3A.4C
audits **all** queries over `continuity_runs` and `continuity_analysis_jobs`: repositories, the analysis store,
automation, the dashboard, the asset-in-use check, health and latest-job reads, and the database proofs. Transition
rows must never:

- appear as Shot QA;
- affect the latest Shot run;
- affect Shot run numbering;
- count as automatic Shot coverage.

Tests prove each of these with transition rows present.

**Security in 0046:**

- RLS: owner-only `for all` policy (`is_project_owner(project_id)`) on the new table, like every user-domain table.
- **Explicit grants**, per the migration policy that applies from 0045 on: `grant select, insert on
continuity_transition_subjects to authenticated`; `revoke all … from anon`. There is no update or delete grant (the
  row is frozen; deletion only cascades).
- **No grant to `prism_generation_worker` or `prism_continuity_worker`.** The worker reads only its frozen job and the
  Assets named in it, so it needs nothing new.
- Code obligations: the Shot-query isolation above. The asset-in-use check also counts cut-edge Assets named by
  transition jobs.

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
- the cut-intent form (an edit operation). It shows whether the intent is effective for the current predecessor.

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
| Explicit **Review batch** (manual)         | One confirmation for the batch with the exact disclosure in §19. A fresh batch nonce                                   |

**Settling (accepted, cut-local):** a cut is automatically submittable only when its own truth has been unchanged for a
settle window of about 10 minutes. The change time is **cut-local**: it comes from the two items of that cut
(`episode_edit_items.updated_at` of the left and right items) or another cut-local fact. It is **never** the global
Episode Edit revision or `episode_edits.updated_at`. So changing an unrelated cut never resets settling for the whole
Episode, and rapid trimming of one cut queues nothing for it. Settling only filters; there is no timer or scheduler.

**Media is derived per wave, after the gates.** For every trigger the order is: plan the due cuts, select the bounded
batch or wave, pass consent, policy and budget, and only then derive the selected cuts' edge media (§7).

**Policy (later migration, 3A.4F):** `project_qa_policies.sequence_semantic_mode` (`off` default, `suggest`,
`automatic`) and `max_transitions_per_batch`, which defaults low (proposed 20).

- `automatic` requires an analyzer, the existing `external_media_allowed`, the existing `direct_video_allowed`, and
  finite ceilings. These are database-checked like 0044.
- `direct_video_allowed = true` **alone never starts sequence QA** (§19).
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

### Consent: `direct_video_allowed` is reused and deliberately broadened (owner decision Q1)

There is no new video-consent boolean. This is **a deliberate semantic broadening** of the existing Project
video-transfer permission, not merely a smaller use of the same scope. A cut-edge clip contains less data than a full
video, but a cut may use an edit-pinned output that is **not** the Shot's currently selected delivery master.

**What 0045 meant, and still records.** Migration 0045 authorised sending **the full selected delivery video** for
temporal Shot QA. 0045 is applied and immutable: `supabase/migrations/0045_project_qa_direct_video.sql`, its comment
and its checksum are **not** edited. Its comment stays historical truth about what 0045 meant when it was applied.

**What it means from Phase 3A.4.** `direct_video_allowed` is the Project-level permission for Prism to send Project
Shot video media to the chosen semantic analyzer for temporal QA. Two cases are permitted:

1. the full selected delivery video, for within-Shot temporal QA (3A.3, unchanged);
2. bounded, audio-free cut-edge windows of an Episode Edit's **explicitly pinned** Shot output, for sequence QA.

The second source need not be the Shot's selected delivery master. It **must**:

- belong to the same Project;
- be explicitly pinned by the Episode Edit;
- have its exact Asset, checksum and window frozen before anything is sent;
- be disclosed to the owner.

The expanded meaning is described in current product documentation, current TypeScript comments, the policy UI
wording and the confirmation / disclosure copy, all updated by the implementing slice. The policy UI wording becomes,
for example, "Allow sending Shot video to the analyzer for temporal QA: the full selected delivery video for Shot QA,
and short audio-free cut-edge clips of the video pinned in the Episode Edit for Sequence Continuity".

### `direct_video_allowed` alone never starts sequence QA (mandatory)

An existing `direct_video_allowed = true` never silently activates the new 3A.4 workflow. An owner who enabled temporal
Shot video earlier has **not** opted into paid cut analysis.

| Sequence semantic QA | Requires **all** of                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manual**           | `direct_video_allowed = true`; an explicit **Review batch** action; the exact batch disclosure confirmed                                                                              |
| **Automatic**        | `direct_video_allowed = true`; the existing `external_media_allowed`; the new `sequence_semantic_mode = automatic` (default `off`); the analyzer, server, calibration and spend gates |

Without the permission, every semantic cut criterion is `not_allowed` / `unchecked`, and the deterministic checks still
run.

### Exact manual disclosure

When the exact media is known, the manual batch confirmation states it. It never says only "video may be sent". It
lists at least:

- provider and model;
- the number of cuts;
- per cut, the left and right source Asset identity and display name;
- whether either source differs from that Shot's currently selected delivery master;
- the exact source start and end of each cut-edge window, and its approximate duration;
- that audio is **not** sent;
- the edge stills;
- the reference images, per side;
- inline vs temporary provider file;
- the worst-case cost.

### Server gate (owner decision Q3)

There is **no** additional sequence-specific environment switch. Sending video stays behind the existing
`PRISM_STUDIO_GEMINI_DIRECT_VIDEO`, together with:

- the `cross_cut` capability defaulting OFF;
- calibration acceptance per family;
- `direct_video_allowed`;
- `sequence_semantic_mode`;
- the spend gates.

A separate emergency kill switch may be reconsidered during hosted 3A.4F, but only if real operational evidence
requires it.

## 20. Versioning

| Identity                     | Recommendation                                  | Why                                                                                                                                                                                                                                                           |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTINUITY_RULES_VERSION`   | **unchanged `3a.1`**                            | Shot criteria do not change. Bumping it would make **every** Shot run stale for nothing                                                                                                                                                                       |
| `SEQUENCE_RULES_VERSION`     | **new `3a.4`**                                  | Cut criteria construction is new and versioned on its own                                                                                                                                                                                                     |
| Gemini analyzer (Shot modes) | **unchanged `3`**                               | The analyzer version is in the automatic Shot QA identity. Bumping it would queue one new paid Shot run per output on every automatic Project, though Shot behaviour did not change                                                                           |
| Sequence analyzer version    | **new, mode-scoped `gemini-sequence-1`**        | Recorded as the transition run's `analyzer_version`. Needs the mode-aware version contract (§14): the worker's `analyzer_version_mismatch` guard compares against the job's mode version. A `gemini-sequence-1` job never runs under another sequence version |
| Prompt                       | **new `continuity-gemini-transition-v1`**       | A new instruction and sided-evidence contract; the Shot prompts are unchanged                                                                                                                                                                                 |
| Rubric                       | **new `sequence-rubric-1`** for transition runs | Cut meanings of `warn` / `n_a` (§11); Shot `continuity-rubric-1` unchanged                                                                                                                                                                                    |
| `ANALYSIS_SCHEMA_VERSION`    | **unchanged `2`**                               | The evidence and finding shape is unchanged (§10). The analyzer response does not gain `n_a`; Prism assigns `n_a` at planning                                                                                                                                 |
| Analysis input snapshot      | **version 2 for transition inputs only**        | A transition subject replaces `attemptId` / `subjectAssetId`, and media gain `window`. Shot snapshots stay version 1, byte-identical, so their keys do not move                                                                                               |
| Sampling / window policy     | **new `cut-edge-static-v1`**                    | Window length, rate, audio stripping and edge stills                                                                                                                                                                                                          |
| Calibration                  | **new `sequence-calibration-v1`**               | Independent of `temporal-calibration-v2`                                                                                                                                                                                                                      |

**Relationship to 3A.3:** purely additive. `video_temporal`, its calibration, prompts, schema, the analyzer v3
identity and `VIDEO_CAPABILITIES` are untouched. The within-Shot capability stays calibrated, and the cross-cut
capability is separately identifiable.

**Relationship to Phase 5:** 3A.4 **reads** the existing Episode Edit and annotates its cuts. The one edit write is
the human cut-intent operation. 3A.4 adds no trimming UI, transitions (dissolves), multitrack, export or NLE
behaviour.

## 21. Owner decisions and implementation details

### Owner decisions (resolved 2026-10-29)

| #   | Decision                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | **Reuse `direct_video_allowed`**, deliberately broadened to cover audio-free cut-edge windows of edit-pinned Shot outputs, which may not be the selected master. 0045 is not edited. The permission alone never starts sequence QA (§19) |
| Q2  | **Cut intent lives in the Episode Edit's item representation** (incoming intent on the right-hand item), bound to its predecessor item id; adjacency changes clear or invalidate it transactionally (§12)                                |
| Q3  | **No extra server switch.** The existing `PRISM_STUDIO_GEMINI_DIRECT_VIDEO` plus the capability default, calibration, consent, policy and spend gates. A kill switch is reconsidered in 3A.4F only on operational evidence               |
| Q4  | **`cut-edge-static-v1` = 2,000 ms per side at 4 fps.** Calibration tests its sufficiency; a change becomes `cut-edge-static-v2` (§6)                                                                                                     |
| Q5  | **Placeholder cuts get no semantic analysis in 3A.4.** Deterministic facts display; semantic criteria stay `unchecked`; still comparison stays the Sequence Board's job (§3)                                                             |
| Q6  | **Retain cut-edge Assets; no garbage collector in 3A.4.** They are derived only during explicit semantic preparation for the selected batch, and deduplicated deterministically. Orphan cleanup is a later hygiene task (§7)             |
| Q7  | **Internal names accepted:** mode `sequence_transition`, capability umbrella `cross_cut`. UI copy says "Sequence Continuity" / "cut continuity" (§8, §9)                                                                                 |

### Implementation details to validate (not owner decisions)

- The exact 0046 CHECK / FK design for the subject invariants, and the transition run-numbering SQL (3A.4C).
- The exact incoming-cut-intent column shape (payload `fromItemId` or a companion predecessor column) (3A.4C).
- The name and signature of the mode-aware analysis version method (3A.4D).
- That frame-accurate `extractWindow` re-encoding produces clips within the bounds of §6 for real Shot outputs (3A.4D).
- That the cost estimates in §17 hold for real cut requests (measured in 3A.4E).
- The settle window length in practice, about 10 minutes (3A.4F).

## 22. Implementation slices

Each slice is separately reviewed and gated. 3A.4A, 3A.4B and 3A.4C are implemented; 3A.4D–F have not started.

| Slice     | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Migration           | Paid / live calls           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------- |
| **3A.4A** | **Cut domain + deterministic projection:** `CutTransition` from the Episode Edit, side truth, edge windows, subject / criteria / reference fingerprints, cut criteria, deterministic findings, `assessTransition` status, shared `describeTransition` (the Sequence Board output is unchanged). Pure, plus tests                                                                                                                                                                                                                                                                                                                                     | none                | 0                           |
| **3A.4B** | **Supervisor UI (deterministic):** the Episode route, cut rows, filters, counts, the Episode Edit cut markers, Sequence Board ↔ Supervisor links; memory E2E                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | none                | 0                           |
| **3A.4C** | **Persistence + human intent:** 0046 (run / job `subject_kind` with database subject invariants, the transition subjects table, predecessor-bound incoming cut intent, explicit grants), repositories, transition run numbering, cut-intent edit operations (adjacency changes clear intent transactionally), overrides on transition findings; RLS / worker-role proofs; hosted apply as its own gate. **Acceptance criterion: every Shot-oriented query is audited and constrained to `subject_kind = 'attempt'`, and tests prove transition rows never appear as Shot QA, affect the latest Shot run, Shot numbering or automatic Shot coverage** | **0046**            | 0                           |
| **3A.4D** | **Semantic cut analyzer:** first the mode-scoped analysis version contract and worker guard (§14); then `extractWindow`, batch-bounded cut-edge derivations, the `sequence_transition` mode in the plan / prompt / validation (sided-evidence rules, Prism-assigned `n_a`), Mock + Gemini adapter behind the fake transport, manual batch submission with the exact disclosure; `cross_cut` declared **nowhere in production**                                                                                                                                                                                                                       | none                | 0                           |
| **3A.4E** | **Calibration:** `sequence-calibration-v1` fixtures + harness, the input hash, pre-registered acceptance; then a **separately authorised** live gate; accepted families recorded                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | none                | only in the authorised gate |
| **3A.4F** | **Automatic orchestration + hosted acceptance:** sequence policy (0047: `sequence_semantic_mode` default `off`, batch cap), cut-local settling, waves, batch caps, the budget sum, reconciliation triggers; hosted verification; final acceptance                                                                                                                                                                                                                                                                                                                                                                                                    | **0047** (proposed) | 0 unless authorised         |

3A.4A and 3A.4B deliver value (free, deterministic cut review in edit order) before any schema change. Semantic cut
QA cannot appear in production before 3A.4E accepts a family.

### 3A.4A implementation notes

The code is in `src/domain/continuity/sequence.ts` (the cut domain) and `src/domain/transition-truth.ts` (the shared
declared-truth comparison). Both are pure.

- **Adjacency:** `buildEpisodeCuts({ data, view, shotQa? })` takes the `buildEpisodeEditView` result. n items give
  n − 1 cuts in edit order. Per-item source usability, currentness and replacement facts come from the edit view and
  are not re-derived.
- **Shared comparison:** the Sequence Board's comparison moved unchanged into `describeTransitionTruth`. The board
  keeps its own link fact; the cut has `cut:link`. A golden file, recorded from the board before the refactor
  (`src/domain/__tests__/fixtures/shot-sequence-golden.json`), proves the board's output is unchanged.
- **Edge frames:** A's last displayed frame is quantised at the edit rate in **item-local** time, so a trim of an
  earlier item never moves it. The edit rate enters the subject fingerprint only through that exact edge-frame
  instant, and B's first frame is its in-point.
- **Subject:** per side, the kind, attempt, Asset, parent checksum, effective window and edge-frame instant, under
  `cut-edge-static-v1`. A's in-point and B's out-point change it only when they reach the 2-second window.
- **Keys:** the deterministic criteria are `cut:picture`, `cut:source_integrity` (critical, the only deterministic
  fail), `cut:source_currentness`, `cut:shot_qa` (only when the caller supplies Shot QA states), `cut:link`,
  `cut:location`, `cut:character:<id>`, `cut:declared_direction`, `cut:declared_time` (time of day, weather and
  lighting) and `cut:declared_props`. A declared difference is a `warn`, never a `fail`.
- **Semantic families:** the ten families are domain descriptors only, and each is `unchecked` with "not yet
  calibrated" (or with the placeholder, no-picture or unusable-source reason). The eyeline criterion is one per cut,
  `cut:eyeline`, because an eyeline match usually connects a Character in A with a different one in B.
- **Scene boundary:** Prism assigns `n_a` before any analysis. `cut:character_appearance:<id>` still applies across a
  boundary.
- **Intent:** `CutIntent` and `cutIntentEffective` (the predecessor binding) are types and pure logic only, with no
  persistence. Edit facts (`cut:picture`, source, Shot QA, link) are never covered by intent.
- **Comparable declarations:** a declared criterion compares only fields declared on **both** sides.
  `cut:declared_direction` compares screen direction and facing direction separately; `cut:declared_time` compares
  time of day, weather and lighting separately. With no comparable field the result is `n_a` (one side's weather and
  the other's lighting prove nothing), any comparable difference is a `warn`, and all comparable fields equal is a
  `pass`. `cut:declared_props` compares the assigned prop sets whenever either side assigns one (they are explicit),
  and the free-text prop notes only when both sides declare them; with neither it is `n_a`. The Sequence Board is
  unchanged: this is cut-domain logic over the shared facts.
- **Assessment composition (`effectiveTransitionFindings`):** the assessment reads one finding per **current**
  criterion, merged by key. Deterministic criteria always take the cut's current projection, recomputed on read,
  never a run's frozen value. Analyzer criteria take the current run's effective result (overrides applied by the
  caller) when it has one, and otherwise keep the projection's `unchecked` / `n_a`. A run never replaces Prism's
  `n_a`, and run findings for criteria the cut no longer has are ignored. So missing analysis is never a pass: a
  failed or incomplete current run leaves its important semantic criteria `unchecked`, and the cut reads "Unchecked
  transition" unless a higher state applies. No ninth state was added; 3A.4B can show the run failure separately.
- **Status before and after a run (accepted for 3A.4B):** before any semantic run, a cut reads "No sequence QA yet"
  even with deterministic warnings, which stay visible as findings; only a deterministic `cut:source_integrity`
  fail reads "Critical continuity break". Once a current run exists, the assessment combines the current
  deterministic projection with the run's semantic results, so a deterministic warning (for example a currentness
  change, a re-linked Shot or a critical Shot QA mismatch arriving after the run) makes the cut "Needs review".
- **Criteria fingerprint:** it covers the declared-truth and semantic criteria, not the edit facts
  (`EDIT_FACT_CRITERIA`: `cut:picture`, `cut:source_integrity`, `cut:source_currentness`, `cut:shot_qa`, `cut:link`).
  Those are recomputed on read, so supplying Shot QA, a newer approval or a re-linked Shot never stales a run.
- **Reference fingerprint (`referencesForCut`):** each side's references are candidates, kept only when a currently
  applicable semantic criterion could use them (`usedBy`). A Lock serves the shared Character's
  `cut:character_appearance:<id>` and `cut:wardrobe:<id>`, an identity image the appearance and a Look image the
  wardrobe. A Location View serves axis, geography, lighting and object continuity. A one-sided Character's
  references and, across a Scene boundary, the Location View, are therefore never in it. The Production Frame a clip
  was generated from is general visual provenance of that side: it stays while any semantic criterion applies. The
  order is canonical (side, role, ref, Asset, checksum), never ProjectData insertion order.
- **Not built in 3A.4A:** UI, persistence, migrations, provider mode or capability, mode-scoped versions, media
  extraction and orchestration. `CONTINUITY_RULES_VERSION`, Shot criteria, Shot fingerprints and the provider contract
  are unchanged.

### 3A.4B implementation notes

- **Route:** `/projects/<project>/episodes/<ep>/continuity` (an Episode tab, "Continuity"). The read
  (`src/server/sequence-continuity-page.ts`) is exactly the Episode Edit page's: the persisted edit
  (`getEpisodeEditRepo().getForEpisode`), its media facts (`loadEditMediaFacts`), then `buildEpisodeEditView` and
  `buildEpisodeCuts`. The display model (`src/components/views/sequence-continuity-model.ts`) is pure and re-derives
  no cut logic. A page visit writes nothing and starts no worker (see the review fix below).
- **No edit / no cuts / error:** without a persisted edit the page says "Sequence Continuity needs a persisted Episode
  Edit because the edit determines the actual cuts." and links to the Episode Edit and the Sequence Board: cuts are
  never invented from Shot order and no edit is created. An edit with 0 or 1 item says "This edit has no cuts to
  review yet." A read failure is reported, never replaced by a fallback.
- **Status:** every cut is assessed with `run: null`, because no transition run is stored before 3A.4C. A normal cut
  reads "No sequence QA yet"; only a current `cut:source_integrity` failure reads "Critical continuity break". The
  deterministic warnings are shown as findings ("Needs attention", first), whatever the state; the Warnings filter and
  count use the findings, never the state.
- **Counts and filters:** cuts, critical breaks, cuts with deterministic warnings, semantic criteria unchecked,
  Scene boundaries and cuts blocked from semantic media (a side is a placeholder, has no picture, or its clip is
  unusable or unchecksummed: the same rows as the Media blocked filter). There is no score. Reviewed / stale / intentional
  counts are stated as unavailable. The client-local filters (All, Critical, Warnings, Unchecked, Scene boundaries,
  Media blocked) only hide server-rendered rows by their own data flags; "Unchecked" counts important applicable
  semantic criteria only, never `n_a`.
- **Previews:** the PINNED sources through the private asset route: a muted clip for a video side, the still for a
  placeholder, a placeholder box for no picture. The edge window and the last / first displayed frame are shown as
  the 3A.4A descriptors (text, computed source times). No edge-frame media is derived, and nothing is called the
  exact edge frame; exact cut-edge media remains 3A.4D. The note "For generated clips, exact cut-edge media will be
  available when cut-edge derivation is implemented." appears only on a cut with a generated-clip side: a placeholder
  still never gets temporal edge media.
- **Shot QA:** the optional current Shot QA state is NOT loaded in 3A.4B, so `cut:shot_qa` is absent. The only
  existing producer of a pinned attempt's Shot QA state is the Shot QA page's per-attempt read (`loadAttemptMedia`:
  runs, jobs, policy and automation state per attempt), which that page pairs with its automatic-QA reconciler; 3A.4B
  keeps the Supervisor to the Episode Edit's own read path instead. Each video side links to its pinned attempt's
  Shot QA page (`/projects/<slug>/generations/<attemptId>/continuity`).
- **Episode Edit markers:** between adjacent items of the PERSISTED edit, a small link to the cut's Supervisor anchor
  (`cut-<leftItemId>-<rightItemId>`), built from the same cut projection (`cut-marker-model.ts`). It shows a fail tone
  for a current source-integrity failure, a warn tone for deterministic warnings, else neutral, never a pass, with the
  issue count and an accessible label. A proposal has no markers.
- **Sequence Board:** an always-visible "Continuity Supervisor" link (the Supervisor's no-edit state is truthful, so a
  conditional link would only add an edit read to the board). The board's ordering, facts, golden output and sync are
  unchanged; the subtitle now says "planned Shot order". The Supervisor links back to the board.
- **Technical review fix: reads no longer start a worker.** In memory mode `getMediaQaRepo()` starts the demo's
  in-process continuity analysis worker, and `getGenerationRepo()` / `getCandidateRepo()` start the generation
  worker, so as first implemented a GET of the Episode Edit or the Supervisor (through `loadEditMediaFacts`) could
  start a worker that then processed work already queued in that process. The getters now take
  `{ startInlineWorker: false }`: the same memory store without starting the worker (Supabase mode has no inline
  worker either way). `loadEditMediaFacts` obtains all three repositories that way, so the Episode Edit and
  Continuity Supervisor GETs are read-only with respect to worker activation too. Every path that creates or submits
  work keeps the default and still starts its worker (`src/server/__tests__/read-only-repos.test.ts` proves both).
- **Not built in 3A.4B:** transition-run or cut-intent persistence, migrations, semantic analysis, provider mode or
  capability, media derivation and automatic reconciliation.

### 3A.4C implementation notes

Migration `0046_sequence_continuity_persistence.sql` (forward-only, one transaction through the migration runner;
**not applied to hosted** in 3A.4C). Verified on a disposable local PostgreSQL 17 with the real `db:*` scripts
([local-supabase](local-supabase.md#disposable-local-database-unapplied-migrations)).

- **Subject kind.** `continuity_runs.subject_kind` and `continuity_analysis_jobs.subject_kind`
  (`'attempt' | 'transition'`, `not null default 'attempt'`): every existing row is `attempt` and is otherwise
  byte-for-byte unchanged (proved: runs, findings, overrides, jobs, costs and events snapshotted at 0045 and compared
  after 0046). `attempt_id` / `subject_asset_id` became nullable, with CHECK `continuity_runs_subject_shape`: an
  attempt run has its attempt and subject Asset; a transition run has neither, nor an original Asset. Jobs:
  `continuity_analysis_jobs_subject_shape` (attempt job names its attempt, a transition job does not). The kind-aware
  key `continuity_runs (id, project_id, subject_kind)` is referenced by the job (`continuity_analysis_jobs_run_kind_fkey`)
  and by the subject, so an attempt job can never point at a transition run nor the reverse.
- **Guards.** `guard_continuity_run` keeps every field 0021 / 0022 / 0044 froze (project, attempt, run number,
  subject / original Asset, analyzer, version, kind, rules version, the package / subject / criteria / reference
  fingerprints, reference set, analysis plan, external manifest, prompt, rubric, model, automation key) and adds
  `subject_kind`; `guard_continuity_analysis_job` keeps its 0022 fields and adds `subject_kind`. All 29 are tested.
- **`continuity_transition_subjects`** (1:1 with a transition run): `run_id` (primary key), `project_id`, constant
  `subject_kind = 'transition'`, `edit_id`, `episode_id`, `edit_revision` (audit), `transition_key` (64 hex),
  `run_number`, `left_item_id`, `right_item_id`, `left_shot_id`, `right_shot_id`, `left_side` / `right_side`
  (objects: `PersistedCutSide`, `cut-side-snapshot-v1`: the pinned picture, edge window and edge-still DESCRIPTORS, the
  side's subject fingerprint, usability and references; no derived edge Asset exists), `crosses_scene`,
  `created_by`, `created_at`. Keys: `(run_id, project_id, subject_kind)` → runs **on delete cascade** (a subject goes
  with its run, never the reverse), `project_id` → projects, `unique (project_id, transition_key, run_number)`. The
  edit / Episode / item / Shot ids are **historical identifiers, not keys**: the repository validates them against the
  live edit when the run is created (edit exists in the Project and Episode, the two items adjacent left → right,
  their Shots, the transition key of that address); afterwards a reorder, an item removal or deleting the edit never
  rewrites or removes the history. Immutable (update trigger; no UPDATE / DELETE grant).
- **Exactly one subject, at commit.** Deferrable constraint triggers (`continuity_runs_subject_check`,
  `continuity_transition_subjects_run_check`): a transition run has exactly one subject carrying its own run number;
  an attempt run has none (structurally impossible already). A run and its subject are written in one unit.
- **Numbering.** Per `(project, transition_key)`, stored on the subject; the run's `run_number` equals it. Postgres
  serialises allocation with a transaction-scoped advisory lock on that key (and holds the edit row `FOR SHARE`, so
  the adjacency checked is the adjacency at commit); concurrent creations get distinct sequential numbers (tested).
  Shot numbering (`unique (attempt_id, run_number)`) is untouched.
- **Grants.** Explicit (post-0045 policy): `authenticated` SELECT and INSERT only, owner RLS policies for both; no
  UPDATE / DELETE; nothing for `anon`, `prism_generation_worker` or `prism_continuity_worker`. Existing run / finding /
  override / job owner policies and the continuity worker's column grants are unchanged.
- **Shot-query isolation.** Every Shot query over runs and jobs constrains `subject_kind = 'attempt'`: `getRun`,
  `listAttemptRuns`, `listLatestProjectRuns` (distinct on attempt), both Shot run-number allocators, the automation-key
  lookups, `setAnalysisStatus`, `applyAnalysis`, `finalizeRun`, the job replay, `getAnalysisJob`,
  `listAttemptAnalysisJobs`, `listActiveProjectAnalysisJobs`, `requestAnalysisCancel`, and the analysis worker's
  `claim` (it executes Shot jobs only; a transition job waits for 3A.4D). Deliberately generic: the Project's
  active-job limit (one shared quota), the spend total, `assetPins`, and operator status counts. The TypeScript Shot
  types stay attempt-only (`ContinuityRun`, `AnalysisJob`: non-null attempt / subject Asset);
  `TransitionContinuityRun` / `TransitionRunView` are separate. Memory keeps transition runs in their own collection.
- **Asset pins.** An Asset named in a transition job's `input_asset_ids` is in use ("a sequence continuity analysis
  of a cut reads it"); attempt runs keep pinning their subject / original Asset; Shot job reference inputs stay as
  before.
- **Repository API (structurally ready, not used by any page).** `createTransitionRun`, `getTransitionRun`,
  `listTransitionRuns(project, key)`, `listLatestEditTransitionRuns(project, edit)`, memory and Postgres with the same
  refusals (`src/data/transition-runs.ts`). `recordTransitionRun` (`src/continuity/sequence-runs.ts`) rebuilds the cut
  from the re-read edit and refuses when its subject / criteria / reference fingerprints or rules differ from what was
  reviewed (no silent refresh); it freezes the deterministic projection as findings. Nothing in 3A.4C creates a
  transition run from the UI; the Supervisor still computes deterministic QA on read.
- **Cut intent persisted.** `episode_edit_items.incoming_cut_intent jsonb null` on the RIGHT item: `{fromItemId,
kinds, scope, note, declaredBy, declaredAt}` (the 3A.4A type, now `src/domain/continuity/cut-intent.ts`, shared by
  the Episode Edit model and the cut domain). CHECK `episode_cut_intent_valid` (immutable; `false`, never NULL, for a
  missing field, since a CHECK passes on NULL): object, known keys only, a uuid `fromItemId`, 1–10 distinct known
  kinds, distinct known categories, a trimmed note of 1–2,000 characters, `declaredBy` null or uuid, ISO `declaredAt`.
  Deferred constraint trigger `episode_edit_items_cut_intent_check`: at commit, every intent names the item at
  `position - 1` and the first item has none, evaluated on the final order after any renumbering.
- **Intent operations.** `set_cut_intent` (right item, the predecessor the person reviewed, kinds, scope, note; the
  repository re-reads the edit and refuses a different predecessor as a conflict; `declaredBy` / `declaredAt` come from
  the authenticated user and the server's clock) and `clear_cut_intent`. Both are ordinary edit changes: expected
  revision, one transaction, revision +1, a stale revision writes nothing.
- **Invalidation.** After applying a unit's ops, `applyEditOps` clears every intent whose predecessor changed (reorder,
  add, remove, moved first), in the same unit, never retargeting it; the database rule is the final barrier.
  Intent survives trims, source changes, hold, clip audio, performance changes and reruns. Moving an item away and
  back does not restore a cleared intent.
- **Intent is not freshness.** It is not part of any fingerprint (tested), never covers an edit fact (3A.4A
  `intentCoverable`), and, with no transition run stored, never changes a cut's state: it shows as "This cut is
  deliberate" with its kinds, scope and note, never as "Intentional discontinuity accepted".
- **Supervisor.** Each cut row shows the declared intent (or none) and a compact form to declare / update or remove it:
  the Supervisor's only write. A proposal has no intent. The Episode Edit stores and reads intent; it has no intent
  panel.
- **Deployment order.** The 3A.4C application queries `subject_kind` / `incoming_cut_intent`: it must not run against
  a database without 0046 (apply 0046 at the hosted gate before using this build against hosted).
- **Not built in 3A.4C:** semantic cross-cut analysis, the `sequence_transition` provider mode and `cross_cut`
  capability, mode-scoped provider versions, media derivation, calibration, automatic reconciliation, migration 0047,
  hosted application.

## 23. Out of scope for 3A.4

- automatic regeneration, edit changes, approval or rejection;
- music continuity, audio mixing, lip sync (enablement stays separately gated), captions;
- NLE export or any Phase 5 editor feature;
- cross-Episode continuity;
- face embeddings, Claude vision, automatic provider routing / failover;
- persistent 3D requirements;
- full-video cut analysis.
