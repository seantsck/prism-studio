# Phase 5B V2: Episode Sequence + Animatic

> Write → Scenes → Shots → **Sequence** → **Animatic**: the Episode's Shots, in an editorial order, played as one
> rough cut. Each item shows its Shot Clip, else its canonical Production Frame, else its approved Storyboard, else
> "Missing media".

V2 branches from `phase-5b-story-intelligence` at `617f2f6`, after V1. It is local / test only: **no migration**, no
hosted change and no paid call.

## 1. Audit: what already existed (reused, not rebuilt)

| Surface (Episode tab)                    | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Edit**: Episode Edit (2I.1, `0043`)    | The editorial timeline. `EpisodeEdit { editRate, revision, items }`; each `EditItem` references a Shot and pins a `VisualSource`: `video {attemptId, assetId, sourceInMs, sourceOutMs}` · `production_frame {durationMs}` · `storyboard_frame` · `none {durationMs}`. Operations `add` / `remove` / `reorder` / `set_visual` / `use_replacement` / `trim` / `set_hold` / audio / performance / cut intent, each a revision with an `expectedRevision` check. |
| Assembly proposal                        | `proposeEpisodeAssembly`: Scene order then Shot order. Per Shot: the approved clip (trimmed to min(clip, planned duration)), else a Production Frame hold (planned duration, or `PLACEHOLDER_FALLBACK_MS` = 3000 ms), else the Storyboard, else `none`. Rejected and unapproved candidates are never chosen.                                                                                                                                                 |
| Replacement detection                    | `replacementFor`: `approval_moved`, `delivery_master_changed`, `clip_available`. It is shown, never applied silently.                                                                                                                                                                                                                                                                                                                                        |
| Rough-cut player (2I.1E)                 | `buildPlaybackPlan` + `RoughCutController`: one clock across the items; clips play their trimmed source range, stills hold; play / pause / seek / restart.                                                                                                                                                                                                                                                                                                   |
| **Sequence**: Shot Sequence Board (2G.5) | The Shot-by-Shot production status board, in story order.                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Animatic** (Phase 1)                   | The Storyboard-only animatic.                                                                                                                                                                                                                                                                                                                                                                                                                                |

The Episode Edit already is an editorial arrangement of Shots that never rewrites Scene or Shot structure. **V2 is
the Episode Edit**, with the missing editorial actions and creator words. There is no second timeline and no schema.

## 2. What V2 adds

| Addition                                                                                                                                                                                                                                                                  | Where                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Reset to story order**: one `reorder` to Scene order then Shot order (the Sequence Board's `shotOrder`). Disabled ("In story order") when already ordered.                                                                                                              | `domain/edit/sequence.ts` `storyOrderIds`; `resetEditToStoryOrder` |
| **Use current Shot Clips and frames (N)**: re-pins, in **one revision**, every item whose picture is no longer its Shot's selection: the selected Shot Clip (`use_replacement`), else the current canonical Production Frame (`set_visual`, keeping the item's duration). | `currentMediaChanges`; `useCurrentShotMedia`                       |
| **Sequence line** per item: `3A — Shot Clip — 5.0s` · `Production Frame` · `Storyboard` · `Missing media` (still visible, with its duration).                                                                                                                             | `SEQUENCE_MEDIA_LABEL`; `episode-edit-view.tsx`                    |
| V1 words on the row: **Needs review** (was "Stale"), **Generated from an earlier Production Frame**, **Newer Production Frame selected**.                                                                                                                                 | `episode-edit-model.ts`                                            |
| Player: **Play Animatic ↓** link, **Previous / Next item**, plus the existing play / pause, scrub and current / total time.                                                                                                                                               | `episode-edit-player.tsx`                                          |

## 3. Media policy (one model, documented and tested)

**Items pin exact media**, as 2I.1 always has: a clip attempt plus its Asset plus its trim, or a frame plus its hold.

- An upstream change is **never applied silently**. It is surfaced on the row: a new Shot Clip shows "Replacement
  available"; a new canonical Production Frame on a still item shows "Newer Production Frame selected".
- One explicit click, "Use current Shot Clips and frames", re-pins everything current.
- Why not a live reference: a live reference would change a cut the creator already timed (a new clip has a
  different length) without them seeing it. Pinning keeps every revision reproducible, and the surfaced review keeps
  it current in one click.
- Pinned media is never edited. Older clips and frames stay as history.

## 4. Durations

- A **clip** plays min(clip length, the Shot's intended duration) from its source in-point. The existing 2I.1 `trim`
  operation changes it.
- A **still** (Production Frame / Storyboard / Missing) holds for the Shot's intended duration, or Prism's existing
  3000 ms default. `set_hold` changes it.
- Editorial durations are the **edit's**: changing a hold or a trim never writes the Shot's target duration (tested:
  3C held 4.5 s while its Shot target stays 3.0 s).

## 5. Staleness

A selected Shot Clip that becomes **Needs review** (a frozen input changed, for example an applied S5 direction)
**keeps playing** in the Sequence, with the warning on its row. Prism never swaps or drops it. The creator decides.

## 6. Acceptance (mock only)

- **`sequence-v2.test.ts`:**
  - 3A and 3B have Shot Clips, 3C has a Production Frame only, 3D has nothing ("Missing media", 5000 ms).
  - Story order spans Scenes. 3C moves before 3B, and 3A moves across the Scene boundary; Scene and Shot structure
    are unchanged; Reset returns to story order.
  - A new 3A Shot Clip and a 3C Production Frame v2 are surfaced, then pinned in exactly one revision.
  - A stale 3B still plays video. Asset checksums are unchanged. The playback order equals the item order on a
    contiguous timeline. Zero network calls.
- **Story Q (browser):**
  1. Edit tab: 3A / 3B "Shot Clip", 3C "Production Frame". Move 3C up, Play Animatic: the player follows the new
     order (clip → frame → clip).
  2. Pause, scrub and Next, then Reset to story order.
  3. Replace 3A's Shot Clip with story P's alternative: the row says "Replacement available" and stays pinned until
     "Use current Shot Clips and frames".
  4. A new direction on 3B: its clip shows "Needs review" and still plays.

## 7. Gaps and debt (documented, not invented)

- Three overlapping Episode surfaces (the Sequence Board, the Storyboard Animatic and Edit) are **Phase 5D UX
  debt**. V2 keeps them and makes Edit the Sequence + Animatic.
- No final render, no audio beyond the clips' own audio, cut-only transitions (all as asked).
- **`db-worker-role --set-role`:** the same 7 local-impersonation failures as the `4773dd4` baseline (55/62). The
  read-only audit is clean. A hosted real-login run is still required before hosted use.
