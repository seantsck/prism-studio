# Phase 5B V3: practical Episode editing

> Sequence → trim Shot Clips → adjust still durations → reorder → choose simple transitions → add titles → preview →
> save revision. The rough cut becomes an editable Episode timeline. No source media is ever changed.

V3 branches from `phase-5b-story-intelligence` at `85e23d3`, after V2. It is local / test only: one **local**
migration (`0058`), no hosted change and no paid call. It ends at **editable timeline + deterministic render
manifest**; V4 renders.

## 1. Audit

### What the Episode Edit already supported (2I.1, migrations 0043 / 0046)

| Concern          | Existing architecture                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit + revisions | `episode_edits`: its own id, a rational edit rate and a **revision counter**. Every mutation is one transaction under a row lock that compares `expectedRevision` and bumps it once. No stored history. |
| Timeline items   | `episode_edit_items` in a dense `position` order (deferred-unique). Each references a Shot of the Episode; **one item per Shot** is a named, removable constraint.                                      |
| Pinned media     | A `VisualSource` by kind: `video` (attempt + exact Asset + source in/out), `production_frame` / `storyboard_frame` (held for `durationMs`), `none`. Cross-project / cross-Shot references are keys.     |
| Trim in / out    | **Already there:** the `trim` op (whole ms, in < out, inside the Asset's probed duration; checked in code and by trigger). Editor UI: "Edit item → Trim".                                               |
| Still duration   | **Already there:** the `set_hold` op for stills / empty slots. Never writes the Shot.                                                                                                                   |
| Tracks           | One picture track (the items). Audio: each clip's own track (`source_audio` muted / included) and **performance takes placed under items** (`episode_edit_audio_placements`, kept inside their item).   |
| Transitions      | None (straight cuts). The 3A.4C **cut intent** shows how per-cut metadata is bound to its predecessor.                                                                                                  |
| Titles           | None.                                                                                                                                                                                                   |
| Render manifest  | None.                                                                                                                                                                                                   |
| Player           | 2I.1E `buildPlaybackPlan` + `RoughCutController`: one master clock; media elements follow it; play / pause / seek / restart.                                                                            |
| Update actions   | `episode-edit-actions.ts` → repository `apply(ops)`; shared op semantics in `episode-edit-ops.ts` for memory **and** Postgres (no drift).                                                               |
| Immutability     | Edits reference only immutable rows (attempt outputs, Assets, frames, takes). Upstream changes never rewrite an edit; referenced sources cannot be deleted.                                             |

### What V2 added

Reset to story order, "Use current Shot Clips and frames" (explicit re-pin, one revision), the Sequence line per item,
the V1 badges ("Needs review", "Generated from an earlier Production Frame", "Newer Production Frame selected"), and
previous / next in the player.

### What V3 needed to add

Transitions, title cards, saved (immutable) revisions with restore, **one** canonical timeline module, a render manifest,
and a player that shows titles and dissolves. Trims and holds were reused as they are.

## 2. V3 additions

| Addition                                                                                                                                                                                                                                                                                                                                 | Where                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Canonical timeline**: opening title → items (each at the previous end minus its incoming dissolve) → closing title, exact integer ms, frames from absolute positions. The view's item timings, the Scene runs, the player and the manifest all read it.                                                                                | `src/domain/edit/timeline.ts` (`editTimeline`, `transitionViolations`, `segmentAt`)                |
| **Transitions**: Cut (default) and Cross dissolve, stored as the item's `incomingTransition {kind, durationMs, fromItemId}`, bound to its predecessor like a cut intent (reset to a cut when the cut changes, never retargeted).                                                                                                         | `model.ts`, ops `set_transition`, `TransitionControl`                                              |
| **Titles**: an opening and a closing card (title, second line, 0.5–20 s, Film / Plain style), on the edit row.                                                                                                                                                                                                                           | `EditTitleCard`, ops `set_title` / `remove_title`, `TitlePanel`                                    |
| **Saved revisions**: "Save revision" freezes the exact editorial state (items, media, trims, holds, audio, transitions, cut intents, titles) as the next number; "Restore" makes a saved state current as a NEW working revision plus a new saved revision ("restored from #n"). Saved revisions are never updated.                      | `episode_edit_revisions`, `saveRevision` / `listRevisions` / `restoreRevision`, `RevisionPanel`    |
| **Render manifest**: deterministic, from the canonical timeline: per segment the Asset + checksum, media kind, source in/out, output duration, order, transition to the next, the target (edit rate, aspect ratio, delivery size); titles with text and layout; the clip-audio and performance placements; the edit state's fingerprint. | `src/domain/edit/render-manifest.ts`, `ManifestPanel`                                              |
| **Player**: title cards; a cross dissolve shows the outgoing picture (a second, muted video element or the still) under the incoming one, mixed linearly; "Preview from here" on every item moves the playhead.                                                                                                                          | `playback.ts` (`outgoingAt`, `dissolveMix`, `titleAt`), `controller.ts`, `episode-edit-player.tsx` |

### Migration 0058 (local / disposable only)

- `episode_edit_items.incoming_transition jsonb`: a shape CHECK (`dissolve`, 100–2000 ms, uuid predecessor) and a
  DEFERRED constraint trigger. At commit it requires that the dissolve names the item right before it, that the first
  item has none, and that it is at most half of the shorter neighbour.
- `episode_edits.titles jsonb`: a shape CHECK (at most one opening and one closing card, real text, 0.5–20 s, a
  known style).
- `episode_edit_revisions`: owner SELECT / INSERT only, an update-refusal trigger (immutable even to the table
  owner), and it cascades with its edit / Project. No worker grant.

The existing payload model could not hold title cards or saved history, so a migration was needed. It extends the
existing tables; there is no second editor schema.

## 3. Behaviour

- **Trim**:
  - in < out, inside the clip, whole ms;
  - a placed take must stay inside the item (the existing 2I.1 rule);
  - the source Asset never changes, and the Shot page still plays the full clip.
- **Still timing**: the item's hold only. The Shot's intended duration, the Production Frame and the Storyboard are
  never written.
- **Transitions**: a dissolve is allowed when 0.1 s ≤ duration ≤ min(2 s, ½ × the shorter of the two items).
  - A trim or hold that would break an existing dissolve is refused ("Shorten the dissolve first").
  - A reorder, add or remove resets a dissolve whose cut changed to a cut.
  - A dissolve **shortens** the timeline by its duration: A 5.0 s → dissolve 0.5 s → B 4.0 s = **8.5 s**.
- **Titles**: an opening card plays from 0 and pushes every item later by its duration; a closing card follows the
  last item. Both are joined by cuts.
- **Reorder / intercut**: changes editorial order only. The Shot's Scene, order and code never change. The Scene
  runs show an intercut Scene twice.
- **Pinned media**: V2's policy is unchanged: "Replacement available", "Newer Production Frame selected" and "Needs
  review" are shown, editing still works, and only "Use current Shot Clips and frames" re-pins (a new working
  revision). Saved revisions keep the media they froze.
- **Preview = manifest**: both are built from `editTimeline(edit)`. The same order, starts, durations and total are
  asserted in the unit tests and in story R (`data-total-ms` of the player and of the manifest).

## 4. Deferred, documented (not invented)

- **Split at playhead: deferred.**
  - Two items on the same Shot clip need the 2I.1 "one item per Shot" rule dropped. That rule is enforced by
    `ONE_ITEM_PER_SHOT` in the domain and by `episode_edit_items_one_per_shot` in the database.
  - The consumers keyed by Shot would also need updating: replacement detection, V2's "use current media", the
    proposal's add-Shot flow, and the continuity cut analysis.
  - The constraint was designed to be removable, so this is a clean follow-up, not a hack in V3.
- **Audio placement deferred to V3b.** V3 keeps what is structurally clean today, the clip's own audio and the
  placed performance takes; both are in the manifest. An Episode music bed would need:
  - a new table referencing an immutable audio Asset (with type and duration triggers);
  - an audio picker;
  - a second audio channel in the player with volume and fades;
  - and the generic upload does not yet produce audio Assets for this purpose.

  The manifest has `audio.bed = null` reserved for it.

- **Fade to black** is not added: the render architecture (V4) does not exist yet.
- **No final render.** V3 ends at the manifest. V4 renders it segment by segment, never as one monolithic ffmpeg
  operation.

## 5. Phase 5D recommendation: Sequence / Animatic / Edit

The Episode has three overlapping tabs today:

- the **Sequence** Board (2G.5): planned Shot order and production status;
- the **Animatic** (Phase 1): Storyboard-only planning playback;
- **Edit**: the persisted editorial timeline, which V2 / V3 made the Sequence + Animatic in practice.

Recommendation: **one Edit workspace with modes**, not three competing tabs.

- **Board** (today's Sequence Board): Shot readiness, planning order.
- **Timeline** (today's Edit): the editable cut, titles, transitions, revisions.
- **Watch** (the player, full width): today's Animatic becomes "Watch" of a proposal before an edit exists.

The Sequence Board's status facts would become an overlay on Timeline rows. This is a navigation redesign for Phase
5D; V3 does not do it.

## 6. Acceptance (mock only)

- **`episode-edit-v3.test.ts`** (Ojou-sama, memory, real mock Shot Clips) covers the required tests 1–25:
  - trims in and out of 3A and 3B, invalid trims refused, the source clip unchanged;
  - 3C held for 4.5 s with the Shot unchanged;
  - an opening title and its duration;
  - a reorder, plus an intercut with a Shot of another Scene;
  - Cut, a Cross dissolve and over-long refusals, with the timeline math;
  - saved revisions A and B, and restore A as revision 3 (A unchanged);
  - the manifest's determinism, and preview = manifest;
  - replacement shown but explicit, pinned media, Needs review;
  - V2 reset compatibility and the V1 selected clips;
  - zero network calls.
- **`timeline.test.ts`**: the canonical math (8.5 s example, titles, stale and over-long dissolves, overlap
  lookup).
- **`controller.test.ts`**: the outgoing clip plays muted on the under element during a dissolve; title cards.
- **`db:episode-edits`** (disposable Postgres): V3 parity steps (memory = Postgres), every 0058 backstop,
  saved-revision immutability / RLS / restore, cascade.
- **Story R (browser)**: the full creator flow, described in the spec header.
