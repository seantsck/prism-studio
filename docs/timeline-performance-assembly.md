# Timeline & Performance Assembly (Phase 2I)

Status: **2I.1 architecture approved. 2I.1A (pure domain) complete** in `src/domain/edit/` (pushed `e5f5061`; full
unit run 1638/1639 with one accepted, unrelated, non-reproducible timing flake in `character-continuity-actions.test.ts`,
recorded as such, not as a clean pass). **2I.1B (persistence) complete** (§3): migration `0043_episode_edits.sql`
is **applied to the hosted DEV database** (approved; ledger checksum
`9e8e6d0a176aa6a9d7c23388df6a43f46fb362bd1b27e36c714d5c9d94128124`) and verified there (`db:episode-edits` 94/94,
`db:validate`, `db:behavior` 49/49, `db:generation` 71/71); full unit 1661/1661. No production deployment. **2I.1C (read-only
Episode Edit page + explicit creation) implemented** (§4.1): `/projects/<slug>/episodes/<ep>/edit`. **2I.1D
(explicit editing) implemented** (§4.2). **2I.1E (rough-sequence playback) implemented** (§4.3). **Not
implemented:** final rendering / export (out of 2I); 2I.1F is the Supabase browser close-out. A prerequisite hardening change (§1, audit findings) shipped separately and is not part of the
timeline data model; its Postgres regression is now in `db:generation` (section 9).

The filmmaking path is script → performance → Shot Prep → storyboard → Production Frame → image-to-video →
**timeline + performance assembly**. Phase 2I turns the Shot clips Prism already produces, and the performances it
already records, into a deliberate, persisted edit of an Episode. It is not an NLE: one picture track, the
performance audio that belongs to each placed Shot, contiguous placement, trims and order. Everything else
(transitions, effects, multitrack audio, music, captions, EDL/XML export) is Phase 5.

## 1. Architecture audit (what exists today)

All of this was read from the implementation on `main` at `766b098`.

### Structure and order

- Episode → Scene → Shot. `shots` carry both `episode_id` and `scene_id` (`0002_production.sql`); a Shot never moves
  between Scenes (no action changes `sceneId`). Shot `order` is meaningful only within a Scene; the Episode sequence
  is `shotOrder()` = scene `order`, then shot `order` (`src/domain/context.ts:208`). Scene order is set only by the
  script sync.
- `reorderShots` (`src/server/actions.ts:703`) rewrites shot `order` inside one Scene with no expected-revision check
  (last writer wins). Order is not a freshness input.
- The **Shot Sequence Board** (`src/domain/shot-sequence.ts`, 2G.5) is a pure projection (no table). Its only write
  is the explicit, previewed link sync of `shots.previous_shot_id`, guarded by a non-stored preview key
  (`sequenceLinkPreviewKey`). Since 2H it also derives an animation summary per Shot
  (`shotAnimationSummary`, `src/domain/generation/animation.ts:243`: `not_animated` / `candidates` /
  `final_approved` / `stale`). The board's visual stays the canonical still.

### Timing and performance

- All durations are **integer milliseconds**: `shots.target_duration_ms`, `duration_mode`
  (`manual` | `derived_from_performance`), `shot.audio.{preRollMs, interLineGapMs, postRollMs}`,
  `performance_takes.duration_ms`, waveforms, previs clips.
- One placement arithmetic, `layoutPerformance` (`src/domain/duration.ts:42`), feeds `computeShotDuration` and
  `buildShotTimeline` (`src/domain/timeline.ts`): pre-roll, selected takes separated by the inter-line gap, reaction
  hold. `buildSceneAudioAssembly` concatenates Shot timelines for a Scene.
- Shot ↔ line: `shot_dialogue_lines(shot_id, dialogue_line_id, position)` → `shot.audio.dialogueLineIds` (ordered).
  The database allows one line on several Shots; each Shot then places the whole take.
- `performance_takes`: `source_type` (`human_recording` | `generated_voice` | `temp_voice`), `audio_asset_id`
  (nullable, `on delete set null`), `duration_ms`, `waveform`, `selected` (one per line, partial unique index),
  `archived` (never deleted). **Takes have no in/out points.** No voice-generation provider exists; a
  `generated_voice` take is just a take.
- Previs audio (`src/domain/previs/audio-mix.ts`) records cues as `{assetId, assetChecksum, timelineStartMs,
sourceStartMs (always 0), durationMs}` — asset-level, not take-level. **No sync-offset field exists anywhere.**

### Frame rate

Plain numbers only: `project_bibles.default_frame_rate numeric(7,3)` (`bible.defaultFrameRate`, default 24), `shot.generation.fps`,
`assets.frame_rate numeric(8,3)` (probed by ffmpeg for conformed media; provider-reported for originals). No rational
timebase, no 23.976/29.97 handling.

### Generated video, approval, Best, delivery

- `generation_attempts`: frozen request (`request.purpose` ∈ `shot_output` | `production_frame` |
  `animate_production_frame`; missing/unknown → `shot_output`), frozen `package_snapshot` + `package_fingerprint`,
  execution `status`, review fields. Creative fields are immutable (`guard_attempt_history`).
- Outputs: `generation_outputs(attempt_id, asset_id, role, position)`, at most one `primary`; assets cannot be deleted
  while linked.
- **Creative approval** = `generation_attempts.approved` (+ `review_status`). **At most one approved attempt per Shot**
  (`attempts_one_approved_per_shot`, any purpose); approving one supersedes the previous one
  (`reviewAttempt`, `generation-postgres.ts:495`). It is revocable (clear / reject). `animate_production_frame` and
  `shot_output` attempts compete for the same single approval — that is the Shot's approved moving picture.
- **Candidate sets** (`0026`): **Best** = `generation_candidate_sets.preferred_attempt_id` (one per set, mutable,
  evented). Best is a review signal; it does **not** approve. **Promote** approves the attempt (superseding the
  Shot's previous approval) and records `promoted_attempt_id`.
- **Delivery masters** (`0020`): `attempt_deliveries` — at most one selected master **per attempt** (not per Shot),
  mutable; the master is either the provider original or an immutable derived asset with an append-only
  `asset_derivations` row (`slot='delivery'`, crop/pad/trim parameters). Conform trims **to a duration only** (no
  in-point). The doc already says: "Creative approval refers to the attempt; the delivery master is what … downstream
  editing should use." Nothing consumes delivery masters yet (`listProjectDeliveries` has no caller outside
  `src/data`).
- **There is no Shot-level "current video" pointer** anywhere. The pipeline's focus attempt is "approved, else newest
  succeeded" (`src/server/pipeline.ts:42`), a display heuristic.

### Freshness / revisions

- Staleness is always **frozen named-part fingerprints vs live `computeShotParts()`**, recomputed on read, never
  stored or cascaded (`src/domain/fingerprint.ts`: storyboard `approved_snapshot.parts`, Production Frame `parts`,
  attempt `package_snapshot.provenance.parts`). Clip freshness (`animationFreshness` / `candidateInputStaleness`)
  also flags a Production Frame reference that is no longer selected.
- Concurrency tools: `projectRevision()` (generation submit only), `expectedShotUpdatedAt`, the sequence preview key,
  `expected<Selected>Id` on selection writes (checked under a Shot `for update`), and the 2H `FOR SHARE` check.

### Animatic

`buildAnimaticTimeline` (`src/domain/animatic.ts`) is an Episode-level, **read-only, derived** playback: Shots in
`shotOrder`, durations from `timelineFromContext`, the approved (else first) **storyboard frame** as picture
(`<img>`, no video), selected takes on an audio lane with an audio-led clock (`animatic-player.tsx`). Its only edit
control (`setShotDuration`) edits the Shot, not the animatic. It has no persisted state.

### Persistence conventions to follow

Sub-service triple `X-repository.ts` / `X-memory.ts` / `X-postgres.ts` + `src/server/X.ts` getter; domain error class
with codes translated from Postgres (`23503`→`wrong_project`, `23505`→`conflict`, `P0001`/`23514`→`invalid`);
project-scoped composite FKs `(x_id, project_id) references x (id, project_id)`; `before insert/update` validation
triggers with human messages; RLS `is_project_owner(project_id)` (single owner), mutable tables one `for all` policy,
no worker grants; actions via `runAction`, server re-reads facts, `revalidatePath(…, "layout")`; feature DB suite
`scripts/db-<feature>.mts`; `db-validate.mjs` / `db-behavior.mjs` updated with each migration.

### Audit findings outside 2I

- **Prerequisite hardening (fixed, separate commit `fix: restrict generation approval to shot outputs`):**
  `reviewGeneration` did not check purpose on the server. The UI hid Production Frame attempts from the approve
  controls, but a direct request could approve a `production_frame` attempt, and because approval is one per Shot
  across purposes it would silently supersede the Shot's approved video. The single approval write path,
  `GenerationRepository.reviewAttempt` (memory and Postgres; used by `reviewGeneration` and `promoteCandidate`), now
  refuses approval of an attempt that is not a Shot output, using the existing classifier
  (`isShotOutputAttempt` = `isShotOutputPurpose(parseGenerationPurpose(request.purpose))`); the action pre-checks it
  for a clear message. Shot-output, animation, purpose-less history and unknown purposes approve as before; reject and
  clear are unchanged; no schema change. This is integrity hardening, not part of the timeline model.
- The generic `projectRevision()` selection-pointer gap (Production Frame / Location View / Character Continuity
  selections) is unchanged and unrelated to the edit; see §7.

## 2. Decisions

### A. Owner: the Episode

One edit per Episode. The Animatic, the Sequence Board and `shotOrder` are all Episode-scoped, Shots carry
`episode_id`, and a film is assembled from an Episode's Shots across its Scenes. There is no Scene-level timeline, so
nothing is duplicated.

**Identity is not ownership.** The edit has its own stable `id`; `episode_id` is an owning reference, never the edit's
identity. "One edit per Episode" is a Phase 2I.1 invariant enforced (2I.1B) by a **removable** `unique (episode_id)`;
alternate cuts later drop that constraint (and add a name) without changing any key or API. Every item likewise has
its own stable `id`; "one item per Shot" is a removable `unique (edit_id, shot_id)` (§E). Nothing in the domain or the
planned API addresses an item by its Shot.

**Scene runs are derived, never assumed contiguous.** The view walks the items in editorial order and emits a run per
maximal sequence of consecutive items whose Shots share a Scene (`sceneRuns`, `occurrence` 1, 2, …). The initial
assembly follows the Sequence Board, so Scenes start contiguous; once the editor intercuts or revisits a Scene, the
same Scene simply has several runs (A, A, B, A → A₁, B₁, A₂). No Scene table or span is stored.

### B. Visual source contract

Each item names its picture explicitly with a **kind** and never substitutes silently:

| kind               | references                               | meaning                                                       |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------- |
| `video`            | `attempt_id` + `asset_id` (pinned media) | a generated Shot clip — the exact file the trims refer to     |
| `production_frame` | `production_frame_id`                    | **placeholder still** (labelled), for a Shot not yet animated |
| `storyboard_frame` | `storyboard_frame_id`                    | **placeholder still** (labelled)                              |
| `none`             | —                                        | the Shot is in the edit with no picture yet (slate, labelled) |

Why pin the asset and not only the attempt: trims are offsets into a specific file. The attempt's delivery master is a
mutable per-attempt pointer and a conformed master may already be trimmed, so offsets measured against the original
would be wrong against the master (and vice versa). The item therefore pins the media it was cut against; a different
master later is reported as **replacement available**, never swapped in.

`video` eligibility (`videoSourceViolations`, `src/domain/edit/eligibility.ts`; later also the repository and a
database trigger):

1. same Project (attempt and Asset); the attempt's `shot_id` is the item's Shot; the Shot belongs to the edit's Episode;
2. a **Shot-output purpose by the existing classifier**: `isShotOutputAttempt` (`shot_output`,
   `animate_production_frame`, and purpose-less history); a `production_frame` attempt is never eligible, even with a
   video Asset and even if (bad history) it is approved;
3. attempt `status = 'succeeded'`;
4. the Asset IS one of the attempt's playable pictures: a `primary` / `variant` `generation_outputs` row, or a
   `slot = 'delivery'` derivation of that attempt (`asset_derivations.attempt_id`); previews, thumbnails, audio and
   metadata outputs are not;
5. the Asset is `type = 'video'` with a known probed `duration_ms` (unknown duration = the trim cannot be verified =
   not placeable);
6. the trim is integer ms with `0 ≤ source_in < source_out ≤ asset.duration_ms` of **that exact Asset**.

Those generation facts are not in `ProjectData`; the server passes them to the pure domain as `EditMediaFacts` (per
attempt: outputs, delivery versions with their parent, the selected delivery master; per candidate set: the current
Best). The domain never reaches into a repository.

Preferred source when Prism proposes one (initial assembly, "replacement available"): the Shot's **approved** attempt
→ its selected delivery master if one exists and is usable, else its primary output. A delivery master is preferred,
not required: a rough cut may pin a provider output. Never a non-approved clip automatically; a
Shot without an approved clip gets `production_frame` (current selected frame) → `storyboard_frame` (approved) →
`none`, each labelled as a placeholder.

### C. Human selection semantics

No new "selected" concept is introduced. The edit item **is** the editorial decision ("this clip, these trims, in this
slot"), stored as its own row, distinct from creative approval, Best and the delivery master:

- **Eligible**: any succeeded Shot-output clip of the Shot (rule B). Creative approval is **not** required to place a
  clip — a rough cut is made from candidates. The item always shows the clip's approval state.
- **Best is not sufficient for an automatic choice** and is never followed automatically. It surfaces as a hint
  ("Best of set N") and the editor may pin it, or any other eligible clip, deliberately.
- **Approval is what Prism proposes** (initial assembly, replacement hints). Approval of the _edit_ (picture lock) is
  out of 2I.1; when it comes it will require every `video` item to be the approved clip and fresh.
- **When Best, approval or the delivery master later change**, the item keeps its pinned clip and reports
  `replacement_available` with the reason (`approval_moved`, `delivery_master_changed`). Only an explicit
  "Use replacement" action changes it.

### D. Timing model

- **Integer milliseconds** everywhere, matching every existing duration in the system (no floats are stored).
- The edit carries an **edit rate as a rational** (`edit_rate_num / edit_rate_den`: 24/1, 24000/1001, 25/1,
  30000/1001, 30/1), defaulting from the project's `default_frame_rate` (23.976 → 24000/1001, 29.97 → 30000/1001,
  otherwise the integer). It is used only to quantise **absolute** positions for display and future export
  (`frame = floor(absMs × num / (den × 1000))`), so rounding never accumulates item by item. 2I.1 does not snap trims to
  frames.
- **Placement is contiguous**: items are an ordered list; an item's timeline start is the sum of the durations before
  it; the timeline start is 0. No gaps and no overlaps in 2I.1 (a deliberate pause is a `none` item, or a still).
- **Video items: the source is the duration authority.** A video item stores `source_in_ms` and `source_out_ms` of
  its exact Asset, and `timelineDurationMs = sourceOutMs − sourceInMs` (`itemDurationMs`). The timeline never
  manufactures duration to meet the Shot's planned duration. Trimming changes `source_in_ms` / `source_out_ms`;
  nothing else moves except later items' derived starts.
- **Source shorter than the Shot's planned duration** (`computeShotDuration`): never stretched, never a silently held
  last frame, never fabricated blank media. The item is the chosen interval; the next item follows immediately (2I.1
  is contiguous); the mismatch is a derived fact (`duration.deltaMs < 0`, proposal note `clip_shorter_than_planned`),
  consistent with conform, which never extends.
- **Source longer**: the initial proposal is `source_in = 0`, `duration = min(source duration, planned duration)` when
  a planned duration exists, else the full source; the remainder is available to trim back in.
- **Still placeholders** (`production_frame`, `storyboard_frame`) and `none` have no finite media duration: they
  store `duration_ms`, proposed from the Shot's planned duration (or an explicit, noted 3 s fallback when the Shot has
  none), and are always labelled as placeholders (`VISUAL_KIND_LABEL`).
- **Why there is no cumulative drift.** Canonical placement is the exact integer-ms sum of item durations; nothing is
  ever rounded and stored. Frames are a derived view of **absolute** instants: `frameAtMs(ms) = ⌊ms·num / (den·1000)⌋`
  in integer arithmetic; an item's frame span is `frameAtMs(end) − frameAtMs(start)`, and those spans telescope to the
  total. Rounding each item to whole frames and summing would drift instead: 1,000 one-second items at 24000/1001 are
  23,976 frames by absolute position but 23,000 by per-item rounding (a unit test asserts both). Frame snapping of
  trims, if ever wanted, is a later display / playback / export decision.

### E. Order model

Persisted, explicit editorial order (`position`, dense 0..n−1, unique per edit, deferrable so a reorder is one
transaction). The **initial assembly derives order from the Sequence Board** (`shotOrder` within the Episode), then
the edit owns it. The edit never follows later Scene/Shot reorders silently; the view reports
`order_differs_from_sequence` and Shots of the Episode that are not in the edit (`not_in_edit`). A "re-sequence from
the board" action can come later as an explicit, previewed operation (same pattern as the link sync). One item per
Shot in 2I.1 (a removable `unique (edit_id, shot_id)`, checked in the domain by `editShapeViolations` behind the
`ONE_ITEM_PER_SHOT` flag); intercutting (several items per Shot) is a later relaxation of that one check. Items are
addressed by their own ids, never by Shot.

### F. Performance assembly

Performance is **referenced, never copied**: an item's audio is a small list of **placements**, each naming one
`dialogue_line_id` + one `take_id` with sync facts. No audio bytes, no take metadata are duplicated; the take's audio
asset, waveform and duration are read through the take.

- Initial assembly pins the Shot's **currently selected** takes of its `audio.dialogueLineIds`, laid out exactly as
  `layoutPerformance` lays them (pre-roll, gaps), relative to the Shot's planned start.
- `generated_voice` and `temp_voice` takes are takes like any other (source type shown).
- A line with no selected take produces no placement and is reported (`missing_take`); **silence is explicit**: no
  placement means no dialogue there.
- Takes without an audio asset (manual-duration temp takes) remain timed subtitles, as in the Animatic.
- The generated clip's own audio track is **muted by default** (`source_audio = 'muted'`); the performance is the
  dialogue truth. `included` is available for clips whose provider produced intended audio.

### G. Synchronisation

Each placement (`AudioPlacement`) stores `start_ms` (a **signed** integer: the take's start relative to the
**item's** timeline start), plus `take_in_ms` and `take_out_ms` (the part of the take that plays,
`0 ≤ in < out ≤ take.duration_ms`). This covers: performance starting at the Shot start (`start 0`), a performance
offset, trimmed performances, picture leading audio and dialogue spanning less than the Shot. **Moving the picture's
`source_in_ms` does not move the audio**: audio is anchored to the item's timeline position, not to the source file,
so a trim is a deliberate re-sync choice.

**J/L cuts are representable, not allowed (yet).** The shape already expresses a negative `start_ms` (J-cut: audio
before the picture) and an end beyond the item (L-cut). Phase 2I.1 validation (`PLACEMENT_INSIDE_ITEM` in
`editShapeViolations`; later the database check) keeps every placement inside its item (`0 ≤ start`,
`start + (out − in) ≤ item duration`). Allowing J/L cuts later is a relaxation of that one rule; the stored model does
not change.

Each item also freezes a small **placement basis** (`performance_basis`: the Shot's `performance` and `timing` part
fingerprints when the performance was placed), so "the performance / planned timing changed since this was placed" is
the usual frozen-vs-live comparison. It is a fingerprint of mutable state at decision time, not copied take metadata.

### H. Lineage

Every item is inspectable by following references, with no copied metadata:

- picture: edit item → `shot_id` → `attempt_id` → pinned `asset_id` → (`asset_derivations` → provider original, or
  `generation_outputs` role) → `attempt_deliveries` (is it the current master?) → attempt `package_snapshot`
  (`provenance.sourceVersions`: Production Frame id, Location View, Locks, takes);
- audio: placement → `dialogue_line_id` → `take_id` → take `audio_asset_id`;
- placeholders: `production_frame_id` / `storyboard_frame_id` → their asset.

`editItemLineage(data, item, media)` (implemented) builds the chain for the inspector: Shot → attempt (number, model,
purpose) → exact Asset (primary output / variant / delivery version; whether it is the attempt's current master) → the
Asset it was derived from (delivery version → provider original); and line → take (number, source type) → audio Asset.

### I. Staleness, superseded sources, replacements

Computed on read (the existing pattern), stored nowhere, never applied automatically (`buildEpisodeEditView`,
`replacementFor`; implemented). Each item reports independent facts, not one blended status:

| fact                    | how it is computed                                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clip_freshness`        | `animationFreshness` / package parts of the pinned attempt vs live Shot parts (incl. a new Production Frame selected, Location View, Locks, performance, timing): `fresh` / `stale` / `unknown`                       |
| `clip_approval`         | pinned attempt approved? Best of its set?                                                                                                                                                                             |
| `replacement_available` | approved attempt ≠ pinned attempt (`approval_moved`), or pinned attempt's current delivery master ≠ pinned asset (`delivery_master_changed`), or a placeholder whose Shot now has an approved clip (`clip_available`) |
| `placeholder_freshness` | Production Frame / storyboard freshness as already computed                                                                                                                                                           |
| `performance`           | per placement: take still selected? (`take_superseded` → selected take id), line still in Shot? (`line_removed`), take archived? lines with no placement but a selected take (`missing_take`)                         |
| `duration`              | item duration vs current planned Shot duration (`short_by_ms` / `long_by_ms`, informational)                                                                                                                          |
| `order`                 | edit order vs `shotOrder` (`order_differs_from_sequence`), `not_in_edit`                                                                                                                                              |

Upstream events and their effect on the edit — always a report, never a rewrite: new Production Frame selected →
clip `stale` (2H freshness) and placeholder `stale`; new animation generated → nothing until approved, then
`replacement_available: approval_moved`; Best changes → hint only; approval changes → `approval_moved`; delivery
conform changes → `delivery_master_changed`; selected take changes → `take_superseded`; dialogue changes → the
`performance` part changes (clip `stale`) and `line_removed` if unlinked (locked lines cannot change text); Shot
duration changes → `duration` delta and clip `stale` (timing part); Scene/Shot order changes →
`order_differs_from_sequence`.

### J. Relationship to the Animatic

Keep the Animatic as the **derived, zero-state planning playback** (no persistence, storyboard stills, current
selected takes) and introduce the edit as the **persisted editorial intent** beside it. They do not duplicate an
editing system because the Animatic has no editing state of its own. Reuse, not fork:

- `layoutPerformance` / `buildShotTimeline` produce the initial placements;
- the Animatic player's audio-led clock is generalised (video element + take cues) for edit playback;
- the scene-span derivation is shared.

Evolution: the Animatic view links to the Episode edit when one exists; Phase 5's "promote the animatic to a rough
cut" is realised by the edit (the Animatic becomes the edit's placeholder-only projection). No migration of Animatic
data is needed because there is none.

## 3. Persistence (migration `0043_episode_edits.sql` — applied to hosted DEV)

The block below was the approved plan; §3.1 records what 2I.1B implemented and where it went further.

```
episode_edits
  id               uuid pk default gen_random_uuid()
  project_id       uuid not null references projects (id) on delete cascade
  episode_id       uuid not null
  edit_rate_num    integer not null check (edit_rate_num > 0)
  edit_rate_den    integer not null check (edit_rate_den > 0)
  revision         bigint  not null default 0          -- bumped by every mutation (optimistic concurrency)
  created_by       uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  constraint episode_edits_one_per_episode unique (episode_id)   -- 2I.1 rule; REMOVABLE (alternate cuts)
  unique (id, project_id), unique (id, episode_id, project_id)
  foreign key (episode_id, project_id) references episodes (id, project_id) on delete cascade
  check ((edit_rate_num, edit_rate_den) in ((24,1),(24000,1001),(25,1),(30000,1001),(30,1)))

episode_edit_items
  id                   uuid pk
  project_id           uuid not null references projects (id) on delete cascade
  edit_id              uuid not null
  episode_id           uuid not null                    -- denormalised so the Shot/Episode match is a key, not a trigger
  shot_id              uuid not null
  position             integer not null check (position >= 0)
  visual_kind          text not null check (visual_kind in ('video','production_frame','storyboard_frame','none'))
  attempt_id           uuid, asset_id uuid
  source_in_ms         integer check (source_in_ms >= 0)            -- video only
  source_out_ms        integer check (source_out_ms > source_in_ms) -- video only: duration = out − in
  production_frame_id  uuid, storyboard_frame_id uuid
  duration_ms          integer check (duration_ms > 0)              -- stills / none only
  performance_basis    jsonb                                        -- {performance, timing} part fingerprints
  source_audio         text not null default 'muted' check (source_audio in ('muted','included'))
  placed_by uuid, placed_at timestamptz not null default now(), updated_at timestamptz not null default now()
  unique (edit_id, position) deferrable initially deferred
  constraint episode_edit_items_one_per_shot unique (edit_id, shot_id)   -- 2I.1 rule; REMOVABLE (intercutting)
  unique (id, project_id)
  foreign key (edit_id, episode_id, project_id) references episode_edits (id, episode_id, project_id) on delete cascade
  foreign key (shot_id, episode_id, project_id) references shots (id, episode_id, project_id)
      deferrable initially deferred                     -- NO ACTION: a Shot in an edit cannot be deleted directly;
                                                        -- a Project delete still cascades (0042 pattern)
  foreign key (attempt_id, project_id) references generation_attempts (id, project_id)        -- NO ACTION
  foreign key (asset_id, project_id)   references assets (id, project_id)                     -- NO ACTION
  foreign key (production_frame_id, shot_id, project_id) references shot_production_frames (id, shot_id, project_id)
  foreign key (storyboard_frame_id, shot_id, project_id) references storyboard_frames (id, shot_id, project_id)
  check: exactly the columns of visual_kind are set
        video            → attempt_id, asset_id, source_in_ms, source_out_ms; duration_ms and frame ids null
        production_frame → production_frame_id, duration_ms;  storyboard_frame → storyboard_frame_id, duration_ms
        none             → duration_ms only

episode_edit_audio_placements
  id                uuid pk
  project_id        uuid not null references projects (id) on delete cascade
  item_id           uuid not null
  dialogue_line_id  uuid not null
  take_id           uuid not null
  start_ms          integer not null    -- signed, item-relative; the 2I.1 check (start_ms >= 0) is REMOVABLE
  take_in_ms        integer not null default 0 check (take_in_ms >= 0)
  take_out_ms       integer not null check (take_out_ms > take_in_ms)
  unique (item_id, dialogue_line_id)
  foreign key (item_id, project_id) references episode_edit_items (id, project_id) on delete cascade
  foreign key (take_id, dialogue_line_id, project_id)
      references performance_takes (id, dialogue_line_id, project_id)   -- NO ACTION (takes are archived, never deleted)
```

New keys on existing tables (idempotent `do $$ … if not exists` blocks, as 0030 did for `shots`):
`episodes unique (id, project_id)`, `shots unique (id, episode_id, project_id)`,
`storyboard_frames unique (id, shot_id, project_id)`, `performance_takes unique (id, dialogue_line_id, project_id)`.

Triggers (`before insert or update`, human messages):

- `check_episode_edit_item_source`: for `video` — attempt `shot_id` = item Shot, `status = 'succeeded'`,
  `coalesce(request->>'purpose','shot_output') <> 'production_frame'`, the asset is `type = 'video'` and is an output
  of the attempt or a `slot = 'delivery'` derivation with that `attempt_id`, and
  `source_out_ms ≤ assets.duration_ms`, with `assets.duration_ms` known.
- `check_episode_edit_audio_placement`: the take is not archived **at placement time**, `take_out_ms ≤ take.duration_ms`,
  and (2I.1 rule, removable for J/L cuts) `start_ms + (take_out_ms − take_in_ms) ≤` the item's duration (re-checked by
  the repository when the item is trimmed; a trim that would cut a placement is refused with the placement named).

Indexes: `episode_edit_items (attempt_id)`, `(asset_id)`, `(shot_id)`; `episode_edit_audio_placements (take_id)`,
`(item_id)`. The unique keys cover the ordered reads.

Deletion: a Shot (or attempt, asset, frame, take) referenced by an edit **cannot be deleted directly** (NO ACTION):
the user removes the Shot from the edit first; the asset library's pin reasons gain "used in the Episode edit". A
**full Project delete still succeeds**: the Shot FK is `deferrable initially deferred` (the 0042 pattern), so the
Project cascade removes the edit, its items and the Shot together. `db:episode-edits` must prove both: a direct Shot
delete refused with the edit intact, and a Project delete leaving no edit rows. Deleting an edit (explicit) deletes its
items and placements. Nothing is silently removed.

RLS (same file): `enable row level security` on the three tables; one `<table>_owner` policy each,
`for all to authenticated using (is_project_owner(project_id)) with check (is_project_owner(project_id))`; no grant
to `prism_generation_worker` / `prism_continuity_worker`. The edit is not a package input and not a QA input.

Memory representation: `MemoryEpisodeEditService` (`src/data/episode-edit-memory.ts`) holding
`edits: Map<editId, EpisodeEdit>` (keyed by the edit's own id; one-per-Episode is a separate check) with items and
placements, enforcing the same checks in one synchronous method per
mutation (atomic in JS), wired lazily in `MemoryRepository`; refusal of Shot / asset deletion mirrored where the memory
repository deletes those rows.

Repository interface (`src/data/episode-edit-repository.ts`):

```ts
interface EpisodeEditRepository {
  getForEpisode(projectId, episodeId): Promise<EpisodeEdit | null>; // edit + items + placements
  listForProject(projectId): Promise<EpisodeEdit[]>; // for withAttachments / where-used
  create(input: { projectId; episodeId; editRate; items: NewEditItem[]; userId; now }): Promise<EpisodeEdit>;
  apply(input: {
    editId;
    projectId;
    expectedRevision: number;
    ops: EditOp[];
    userId;
    now;
  }): Promise<EpisodeEdit>;
  delete(input: { editId; projectId; expectedRevision: number }): Promise<void>;
}
type EditOp =
  | { op: "add"; item: NewEditItem; atPosition: number }
  | { op: "remove"; itemId }
  | { op: "reorder"; itemIds: string[] } // must be exactly the current set
  | { op: "set_visual"; itemId; visual: VisualSource } // the union carries its own times
  | { op: "trim"; itemId; sourceInMs: number; sourceOutMs: number } // video
  | { op: "set_hold"; itemId; durationMs: number } // stills / none
  | { op: "set_source_audio"; itemId; sourceAudio: "muted" | "included" }
  | { op: "set_performance"; itemId; placements: NewPlacement[] }; // replaces the item's placements
```

`apply` runs in one transaction: `select … from episode_edits where id = $1 and project_id = $2 for update`, compare
`revision` (`conflict`: "The edit changed in the meantime. Reload and try again."), apply ops, renumber positions
densely, bump `revision`, `updated_at`. Errors: `EpisodeEditError` codes `not_found | wrong_project | wrong_shot |
invalid_source | conflict | invalid`, translated with the existing Postgres code map.

### 3.1 Implemented contract (2I.1B)

Files: `supabase/migrations/0043_episode_edits.sql`, `src/data/episode-edit-repository.ts` (contract, `EpisodeEditError`,
`EditOp`), `src/data/episode-edit-ops.ts` (op semantics + checks shared by both implementations),
`src/data/episode-edit-memory.ts`, `src/data/episode-edit-postgres.ts`, `src/server/episode-edits.ts` (getter only; no
action), `scripts/db-episode-edits.mts` (`npm run db:episode-edits`).

Schema, as planned, plus:

- **Every source key is `deferrable initially deferred`** (Shot, attempt, Asset, Production Frame, storyboard frame, take;
  the 0005 / 0042 lesson): a direct delete of a referenced row is refused at commit; a Project / Episode cascade passes.
  No source key cascades or nulls into an edit, so upstream changes never destroy editorial history.
- **The attempt is a key of the item's Shot**: `(attempt_id, shot_id, project_id) → generation_attempts` (new
  `generation_attempts_id_shot_project_key`), so "attempt of another Shot" is refused by a key, not only by the trigger.
- Placements have their own `id` (row identity) and are addressed by `(item_id, dialogue_line_id)` (unique); they are
  replaced as a set by `set_performance` / `clear_performance`.
- The removable 2I.1 rules are named: `episode_edits_one_per_episode`, `episode_edit_items_one_per_shot`,
  `episode_edit_audio_placements_start_inside_item` (+ the end check in the two triggers). Positions:
  `episode_edit_items_position_key` (deferrable); the repository renumbers densely on every write.
- The item trigger also re-checks placements when an item's duration changes (a trim / hold cannot cut a placed take).

**Classifier boundary.** The repositories are the authority for "is this a Shot output" (`isShotOutputAttempt`, run
inside the mutation's transaction). The trigger refuses exactly `request->>'purpose' = 'production_frame'`, a subset of
what the classifier refuses (it treats a missing or unknown purpose as a Shot output), so the database is defence in
depth that can never contradict the classifier; it does not re-implement it. Op semantics, revision checks, renumbering
and the replacement rule are repository logic.

Repository (`EpisodeEditRepository`): `get`, `getForEpisode`, `listForProject`, `create` (revision 0; `conflict` if the
Episode has an edit), `apply({ editId, projectId, expectedRevision, ops })`, `delete({ …, expectedRevision })`,
`usesAsset`. Ops: `add` (at a position), `remove`, `reorder` (exactly the current ids), `set_visual`, `use_replacement`
(the Shot's approved clip as delivery master else primary output, only if it is still exactly the `expected`
attempt + Asset the caller saw; the trim keeps the item's duration when it can), `trim` (video), `set_hold` (stills /
none), `set_source_audio`, `set_performance` (replaces placements and basis; empty = explicit silence),
`clear_performance`. Items are addressed by id only. Error codes: `not_found | wrong_project | wrong_shot |
invalid_source | conflict | invalid | in_use`.

A mutation (both implementations): lock the edit (`select … for update` in Postgres; one synchronous block after the
fact reads in memory), compare `revision` (stale → `conflict`, nothing written), load exactly the referenced rows, plan
the next state (`applyEditOps`), validate the whole edit's 2I.1 shape and the changed items' sources with the domain
checks (`assertEditValid`), write the difference (Postgres: removals first, then changed items, then adds), bump
`revision` by exactly one, commit. Memory parity: `MemoryEpisodeEditService` runs the same shared rules;
`MemoryRepository.remove` refuses a Shot, attempt, Asset, storyboard frame, take or line an edit references (`in_use`),
and an Episode that goes takes its edit with it.

Verification (2I.1B): memory suite `src/data/__tests__/episode-edit-memory.test.ts` (22 tests: identity, one per
Episode / Shot, order, every source rule, trims, placeholders and their holds, placements, explicit silence,
replacement, revision, two concurrent writers, deletion semantics). On the hosted DEV database after the approved apply
of 0043: `db:episode-edits` 94/94 (structure, owner-only RLS, no worker privilege, memory/Postgres parity over one
27-step op script with identical outcomes and resulting edit, every trigger / key with raw SQL, two writers on two
connections against one revision → exactly one wins and the loser writes nothing, a held `FOR UPDATE` blocking the
second writer, direct Shot / attempt / frame deletes refused with the edit intact, the Shot deletable after its item is
removed, Project cascade; its two throwaway projects removed), `db:validate` STRUCTURE OK, `db:behavior` 49/49 (rolled
back), `db:generation` 71/71 (the approval-purpose regression, section 9). The first hosted run found one defect,
fixed before the push: a hold change on an existing placeholder did not load that placeholder's frame for re-checking
(`editRefs`), now covered by a memory test.

## 4. Actions (`src/server/episode-edit-actions.ts`)

### 4.1 Implemented in 2I.1C: the read-only page and explicit creation

**Route:** `/projects/<slug>/episodes/<ep>/edit` (Episode tab "Edit", after "Animatic"). Server page
`src/app/projects/[project]/episodes/[ep]/edit/page.tsx` → `loadEpisodeEditPage` (`src/server/episode-edit-page.ts`) →
display model `src/components/views/episode-edit-model.ts` → `EpisodeEditView`. The project is the signed-in user's own
(`requireProject`, RLS-bound in Supabase mode); media facts come from `loadEditMediaFacts`
(`src/server/episode-edit-media.ts`: outputs, delivery versions, selected delivery master, Best, read for the user);
media is served only through the private `/api/assets/<id>` route (`assetUrl`), never a storage path.

**The read is pure.** It loads the Episode's edit if one exists and builds its view; otherwise it builds the
proposal. It never creates, completes, renumbers or re-pins anything and never follows Best, approval, a Production Frame
or take selection (no hidden get-or-create). A failure to build the page is shown as an error with a reference, never as
partial state; an item whose pinned source cannot be resolved stays in the list, flagged "Source unavailable", and is
listed at the top of the page.

Three states:

- **Proposed initial assembly** (no edit): the proposal's order, Scene runs, each Shot's proposed picture by kind
  ("Placeholder: Storyboard still", "No picture yet", … a still is never called video), durations, placed takes or
  explicit "Silence", the proposal's reasons and notes (e.g. an approved clip without usable video), the total, and one
  button, "Create edit from this proposal". Nothing is saved until it is pressed.
- **The saved edit**: revision, edit rate, total, Shots, Scene runs; per item in order: Shot, Scene run, start,
  duration (and the planned duration when it differs), the picture by kind with the exact source (generation, Asset,
  trim, delivery-master relationship; or the frame), the performance lane (line, pinned take, offset / take in–out,
  audio link, explicit Silence, clip audio muted / included), badges, and a "Lineage" disclosure (Shot → generation →
  exact Asset → derived-from / delivery master; Shot → Production Frame / Storyboard frame; line → take → audio Asset).
- **Error**: the message, nothing written.

**Badges are facts, never actions** (no "Use replacement" button until 2I.1D): Pinned, Approved, Approved elsewhere,
Best, Best elsewhere, Newer delivery master, Production Frame changed, Stale, Replacement available / Clip available,
Dialogue changed, Planned timing changed, Take superseded (with the take selected now), Take archived, Dialogue removed,
Take missing, Source unavailable, Not in this Episode; edit level: Order differs from Sequence, N Shots not in edit.
Scene runs come from the 2I.1A `sceneRuns` (a revisited Scene shows "run 1 of 2", "run 2 of 2"); nothing is stored.

**Stale-proposal contract (`proposalKey`, `src/domain/edit/proposal-key.ts`).** The page renders the proposal with its
key: SHA-256 of the canonical JSON of exactly what would be persisted (Episode, edit rate; per item in order: Shot,
picture kind + references + times, clip audio, placements, placement basis). Reasons and notes are excluded. "Create edit"
sends only the project slug, the Episode id and that key. `createEpisodeEdit` re-reads the project as the user
(ownership), recomputes the proposal from current facts and creates it only when the key is unchanged, so the persisted
edit is exactly what the user reviewed and every source comes from server-side records (no client-supplied source id).
Any change that would alter the persisted content (order, approval, delivery master, Production Frame, Storyboard,
selected take, planned timing / performance parts) refuses with "The proposed assembly changed since this page was
loaded…"; the reloaded page shows the new proposal. This does not touch the generic `projectRevision()` gap (§7).

**Concurrent / repeated create.** If the Episode already has an edit, the action resolves to it ("already exists;
showing it"). Two identical creates racing: one creates; the other's repository refusal (`conflict`, the one-per-Episode
rule) is resolved to the edit that now exists. Never a second edit, never a raw database error, no duplicate items or
placements (unit-tested with two concurrent calls).

**Animatic relationship.** The Animatic is unchanged as the unsaved planning projection; its subtitle links to the
Episode Edit, and the Edit page links to the Animatic and the Sequence Board. Nothing migrates between them and the
Animatic does not read edit data. Rough-sequence playback is 2I.1E.

**Tests.** `src/server/__tests__/episode-edit-actions.test.ts` (read is pure, honest proposal labels / silence / notes,
private asset URLs only, create at revision 0, reads never bump it, stale-proposal refusal, forged key, concurrent
creates → one edit, foreign Episode / unknown project refused, pinned take kept with "Take superseded", lineage, an
unresolvable source flagged not omitted) and `src/domain/edit/__tests__/proposal-key.test.ts`. Memory E2E
`e2e/zzzzzzzzzzzzzzzzzzzzz-episode-edit.spec.ts`: proposal → Create edit → reloads keep revision 0 and the pinned
sources → a take selected on the Perform page is reported ("Take superseded"), not applied → lineage, timing, Scene
runs, Animatic link.

**E2E isolation.** Creating an edit is persistent for the life of a memory store (one per Episode, and its pins refuse
deleting what they reference), and the spec asserts the proposal of the pristine seed. It therefore runs in its own
Playwright project `memory-2i-isolated` against its own memory server (port 3104), started by the ordinary
`npm run test:e2e` like the 2H isolated server; the shared `memory` project ignores it. No reset API was added; the test-only
keep-alive setting applies to the new server too. No Supabase E2E in 2I.1C (2I.1F).

### 4.2 Implemented in 2I.1D: explicit editing

The saved edit's page gains editing controls (an "Edit item" disclosure per item, ↑ / ↓ / Remove per item, and a "Shots
not in the edit" panel). Every control is a plain server-action form (`src/server/episode-edit-actions.ts`) carrying
the edit id, the item id and the revision the page showed; the server re-reads the user's project (ownership), refuses
a stale revision before anything else, translates the request into the 2I.1B repository's `EditOp`s and applies them in
ONE `apply` (lock, revision compare, every source re-validated, placements kept inside their item, revision +1 exactly
once). The actions add no mutation logic of their own and no repository, domain-rule or schema change was needed
(no migration 0044). Server-confirmed: no optimistic state; the page re-renders from the saved edit.

| action                   | op(s)                         | behaviour                                                                                                                                                          |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `setEditItemSource`      | `set_visual`                  | pins any eligible clip (`video:<attempt>:<asset>`, at its FULL length), a Production Frame / Storyboard frame of the Shot (keeping the item's duration), or `none` |
| `useEditItemReplacement` | `use_replacement`             | pins exactly the replacement the page showed (attempt + Asset); a different current replacement is refused ("replacement changed"), nothing is pinned silently     |
| `trimEditItem`           | `trim`                        | source in / out (seconds → integer ms) inside the exact Asset; a trim that would cut a placed take is refused (J/L cuts are later)                                 |
| `setEditItemHold`        | `set_hold`                    | a still / empty item's duration                                                                                                                                    |
| `moveEditItem`           | `reorder`                     | ↑ / ↓: the complete new order (dense positions, deferred-unique)                                                                                                   |
| `addShotToEdit`          | `add`                         | a Shot of the Episode not in the edit, as Prism proposes it (shown), at a chosen position; refused when the proposal changed (`proposedItemKey`) or already added  |
| `removeEditItem`         | `remove`                      | (confirmed) removes the item and its placements; the Shot, clips, frames and takes are untouched and the Shot becomes deletable                                    |
| `pinEditItemTake`        | `set_performance`             | pins one exact take for one line (other placements kept): starts where the line already starts, else where the Shot timeline lays it out; plays what fits          |
| `repinSelectedTakes`     | `set_performance`             | an explicit "pin the selected takes" (laid out as the Shot timeline)                                                                                               |
| `silenceEditItem`        | `clear_performance` / `set_…` | Silence for the item or one line: no placement (no "silence take" exists)                                                                                          |
| `setEditItemClipAudio`   | `set_source_audio`            | Muted / Use clip audio; including is refused (and the option disabled) when Prism has no record of an audio track in the clip                                      |

**Choices are facts, not requirements.** The source picker lists every eligible succeeded Shot-output clip of the Shot
(each picture Asset: primary, variant, delivery version) with generation number, provider / model, review state,
Approved / Best / Delivery master / Pinned badges, clip length and a preview through `/api/assets/<id>`, then the Shot's
Production Frames (selected or not), Storyboard frames (approved or not) and "No picture". Best and approval are never
required. Production Frame candidates are not offered and are refused by the repository and the database. The take picker
lists the line's takes (archived ones only when pinned) with duration, source type, "selected now", archived and audio
availability; an older or archived take may stay pinned, and pinning a take never changes the Shot's selected take.

**Revision conflicts.** A change submitted from a page showing an older revision is refused with "This edit changed
before your update was saved. Review the latest version and try again." Nothing is written, retried or merged; the page
re-renders the latest edit while the message stays next to the control (the form is not remounted; after a success the
forms reset to the re-rendered values). Two writers on one revision: exactly one wins (repository lock; unit-tested).

**Currentness after a change** is the full re-read view (§4.1): e.g. Use replacement clears "Replacement available",
a reorder raises "Order differs from Sequence" and re-derives Scene runs (a revisited Scene shows "run k of n"),
pinning the selected take clears "Take superseded", Silence shows in the performance lane.

**Tests.** `src/server/__tests__/episode-edit-editing.test.ts` (real free mock clips through the in-process worker: pin
at full length, Production Frame candidate / foreign Asset refused, trims valid / outside / cutting a take / not a
number, take pin with the project's selection untouched, foreign take refused, archived take kept and reported, Silence,
clip audio refused without a track, replacement exactly-as-shown vs changed, reorder with two Scene runs, remove + add
back with a proposal key, stale revision, two writers → one) plus the 2I.1C suites; the isolated memory E2E (§4.1) now
continues with the 2I.1D browser flow (pin, refused and applied trims with later items moving, take, Silence, reorder,
remove / add back, replacement, a two-tab conflict). Not in 2I.1D: playback (2I.1E), drag / ripple / slip / roll
editing, frame-by-frame keys, transitions, multitrack, J/L cuts, undo.

### 4.3 Implemented in 2I.1E: rough-sequence playback

"Watch this edit" (`EditPlayer`, `src/components/views/episode-edit-player.tsx`) plays the SAVED edit as one continuous
rough sequence: a preview, not a render (no concatenation, no new Assets, no transitions, no mixing controls, no J/L
cuts). Opening, playing, pausing and seeking write nothing (the revision never moves; tested).

**Source of truth.** `buildPlaybackPlan` (`src/domain/edit/playback.ts`, pure) reads only the persisted edit: item
order, picture kind, the exact pinned Asset and its source in / out, still holds, `none` durations, every placement
(line, exact take, offset, take in / out) and the clip-audio policy. Media addresses are the private `/api/assets/<id>`
route. Best, approval, the delivery master, the Production Frame selection and the selected takes are never consulted
(tested: with another clip approved, playback plays the pinned one).

**Timing.** Items are back to back from 0: `start = Σ previous durations` in exact integer ms (no rounding to
accumulate); the current item is the one with `start ≤ t < end` (a boundary belongs to the next item; nothing at the
end). Video: `source = source in + (t − item start)`, clamped to `[in, out]`. Placement: absolute
`item start + placement start` for `take out − take in`; `take position = take in + (t − placement start)`. Frames and
timecode are derived from the absolute position at the edit rate, never stored.

**One master clock** (`RoughCutController`, `src/lib/edit-playback/controller.ts`, framework-free): the timeline time
advances with the wall clock (`performance.now()` deltas, one `requestAnimationFrame` at a time) and is the only
authority. Media elements follow it: the single picture `<video>` and one `Audio` element per sounding placement are
pointed at the clock's position when they become active, after a seek, and whenever they drift more than 250 ms
(`DRIFT_MS`); no element ever moves the clock, so a slow or failed file cannot stall or skip the edit. Play starts only
from a click (no autoplay; a browser refusal is reported while the clock still runs); `play()` is called once per
activation, never from render.

**Per kind.** Video: plays its trim only; at its out point it is paused and the next item starts immediately (no
crossfade). Production Frame / Storyboard placeholder: the pinned still is held for the item's duration, labelled as a
placeholder. `none`: an honest "No picture" slate for its full duration (never skipped); its performance still plays.
Several placements in one item sound independently; no placement is explicit Silence (no media is synthesised). Clip
audio "muted": the video element is muted and only placed takes sound; "included": the clip's own audio is audible
together with the placed takes (no gain / pan).

**Seeking** (slider, Restart) rebuilds the whole state from the clock position: active item, video source position,
still / slate, the sounding placements at their take positions; while paused everything stays paused, while playing it
continues; seeking to the end shows "End of edit", stopped. Reaching the end stops playback.

**Missing media.** An item the read view already reports as "Source unavailable", a still without a stored image, or a
picture whose element reports an error plays its interval as "Source unavailable (…)" and the clock continues; a take
whose audio fails is reported ("N takes could not be played") and the picture continues. Nothing is substituted and
nothing is written.

**Edits during playback.** The player is keyed on the edit's revision: a saved change disposes the old controller
(all media stopped) and builds a new one from the new edit, paused at 0. A player never plays a stale structure. The
edit list highlights the item under the playhead (`data-playing`).

**Animatic.** Unchanged and independent: the Animatic keeps its own audio-led planning player. No playback code is
shared and neither reads the other's data (its unit regression was re-run).

**Tests.** `src/lib/edit-playback/__tests__/controller.test.ts` (18: plan timing, current item at boundaries, trim and
take mapping, multiple placements, clip audio, and the controller with a deterministic clock and fake media: no
autoplay, source in at start, handover at the out point, still hold, no-picture interval, placement start and end,
seek while paused / playing, pause, restart, end, drift re-seek, unavailable picture / take, blocked media, dispose);
`episode-edit-editing.test.ts` (the page's plan plays the pinned clip and trim, not the current approval; reading
writes nothing). Isolated memory E2E (port 3104), self-establishing (`--grep "2I.1E"` alone passes on a fresh store):
Playwright's fake clock, frozen after load, advances time only by `runFor`; the player exposes its state as data
attributes (`data-time-ms`, `data-item-id`, `data-kind`, `data-video-src-ms`, `data-video-url`, `data-video-muted`,
`data-placements`, `data-ended`), so the tests check timing semantics without depending on headless media decoding.

The rest of this section is the original action plan (now implemented as above).

The browser sends ids, positions and integer ms only; the server re-reads the project, proposes and validates.

| action                   | effect                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `createEpisodeEdit`      | builds the initial assembly with the pure `proposeEpisodeAssembly(data, episodeId)` (B, D, E, F) and creates it; refused if one exists |
| `addShotToEdit`          | adds a `not_in_edit` Shot at a position, with the proposed source and placements                                                       |
| `setEditItemVisual`      | pins an eligible clip (asset of the attempt) or a placeholder; resets trims to the proposal unless given                               |
| `useEditItemReplacement` | `setEditItemVisual` with the reported replacement; requires the replacement the user saw (`expectedReplacementAttemptId` / asset id)   |
| `trimEditItem`           | `source_in_ms`, `source_out_ms` (video) or `duration_ms` (stills / none)                                                               |
| `reorderEditItems`       | full ordered id list                                                                                                                   |
| `removeEditItem`         | removes an item (the Shot becomes `not_in_edit`)                                                                                       |
| `setEditItemPerformance` | re-pin to the Shot's currently selected takes (re-layout), or explicit placements / offsets                                            |
| `setEditItemSourceAudio` | muted / included                                                                                                                       |

Every mutation carries `expectedRevision`. Reads ("inspect currentness") are the pure
`buildEpisodeEditView(data, edit)`: derived starts, scene spans, total, per-item facts (§I) and lineage (§H) — no
action needed.

## 5. Test plan

- **Unit (pure domain)**: `proposeEpisodeAssembly` — order from `shotOrder`, approved clip → delivery master else
  primary, placeholders labelled, no non-approved auto-pick, durations min(source, planned), placements equal
  `layoutPerformance`, missing takes reported; eligibility (wrong Shot, production_frame purpose, not succeeded, asset
  not of the attempt, range outside asset); `buildEpisodeEditView` — contiguous starts, frame quantisation on absolute
  positions at 24000/1001 without drift over 1,000 items, every §I fact including approval moved, delivery master
  changed, take superseded, line removed, duration delta, order differs, not in edit; lineage chains.
- **Memory repository**: create/apply parity, revision conflict, reorder must be the exact set, trim refusing to cut a
  placement, one item per Shot, cross-Episode Shot refused, Shot/asset delete refused while in an edit.
- **Postgres (`scripts/db-episode-edits.mts`)**: every constraint and trigger (kind/column check, Episode match,
  attempt purpose/status/asset membership, delivery-derivation asset accepted, range vs asset duration, take/line
  match, placement bounds), deferrable position swap in one transaction, NO ACTION deletes refused and Project delete
  cascading cleanly, **concurrency**: two `apply` with the same `expectedRevision` → exactly one wins, the other
  `conflict`, nothing partially written; a held `FOR UPDATE` blocks a second writer; `db-validate.mjs` /
  `db-behavior.mjs` updated; cleanup leaves no test rows.
- **RLS**: owner can read/write; stranger and anon see nothing and cannot insert; worker roles have no privilege;
  cross-project references refused by the composite FKs.
- **E2E (memory, new `z…` spec with 21 `z`)**: create the edit from the 2H fixture (an approved mock clip on one Shot,
  placeholders elsewhere, all labelled), trim, reorder, change source to a non-Best candidate, approve another clip →
  "replacement available" without change, use replacement, change the selected take → `take_superseded`, re-pin
  performance; **Supabase E2E**: one create + mutate + reload flow. No provider calls (Mock only).

## 6. Proposed implementation sequence

| slice     | scope                                                                                                                                                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **2I.1A** | **Complete.** Pure domain (`src/domain/edit/`): edit rate, model + shape checks, eligibility, `proposeEpisodeAssembly`, `buildEpisodeEditView` (timing, Scene runs, §I facts), `replacementFor`, `editItemLineage`; unit tests. No persistence. |
| **2I.1B** | **Complete** (§3.1): migration `0043_episode_edits.sql` applied to hosted DEV (approved), `EpisodeEditRepository` memory + Postgres, `db:episode-edits`, RLS, validate/behavior updates, `db:generation` approval regression.                   |
| **2I.1C** | **Implemented** (§4.1). Actions + a read-only Episode Edit page: create assembly, the picture lane with truthful kind labels, durations, approval/freshness/replacement badges, performance lane, lineage inspector. Memory E2E.                |
| **2I.1D** | **Implemented** (§4.2). Editorial mutations in the UI: choose source, use replacement, trim, reorder, add/remove, re-pin performance, source audio; conflict handling.                                                                          |
| **2I.1E** | **Implemented** (§4.3; one wall-clock master, media follow it, instead of the planned audio-led clock). Playback of the rough sequence: video elements + take cues on the generalised audio-led clock; Animatic links to the edit.              |
| **2I.1F** | Supabase E2E, hosted migration (approval), docs/roadmap close-out.                                                                                                                                                                              |

## 7. Generic revision gap — impact

None, by design. The edit references only **immutable** things (attempts' creative fields, assets, derivations,
frames, takes) plus its own rows; the mutable pointers it reads (approval, Best, delivery master, Production Frame /
take selection) only drive **reported** facts, never what plays. Edit writes are serialised by the edit's own
`revision` under `FOR UPDATE`, and the source checks run inside that transaction against immutable rows, so there is
no time-of-check/time-of-use window to close. The edit is not a generation package input, so it is not added to
`REVISION_SOURCES`, and 2I does not attempt to fix the Production Frame / Location View / Character Continuity
selection gap recorded in the roadmap.
