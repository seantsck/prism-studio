# Shot Sequence Board (Phase 2G.5)

The first place to review **the film as a sequence of canonical stills**. The question it answers is "do these Shots
cut together?".

Routes: `/projects/[project]/episodes/[ep]/sequence` and the project-level `/projects/[project]/sequence?ep=…`
(same episode selection as Storyboard / Animatic). Navigation order: Storyboard → **Sequence** → Animatic.

Default workflow: Shot Prep → Production Frame → **Sequence Board** → inspect neighbouring Shots → correct continuity /
stale frames → Phase 2H image-to-video.

## Storyboard vs Sequence vs Animatic

| Surface    | Owns                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| Storyboard | Planning individual Shots: Storyboard versions, approval, frame upload, planning-oriented reorder                      |
| Sequence   | Reviewing canonical production imagery and continuity ACROSS Shots: one display image per Shot, transitions, link sync |
| Animatic   | Time-based playback with Storyboard frames and selected performances                                                   |

Neither Storyboard nor Animatic changed.

## A projection, not new state

`src/domain/shot-sequence.ts` is pure (`buildShotSequence(data, episodeId)`). It derives everything from existing
production truth:

- Shot order (`shotOrder`);
- the selected Production Frame and `productionFrameFreshness`;
- Storyboard approval and `storyboardFreshness`;
- the selected Location View (`ShotContext.selectedLocationView` / `locationViewIssue`);
- Character Continuity selections (the resolved `ShotContext.characters[].appearance`, `continuityLockIssue`,
  `continuityLockOrphans`);
- the Shot's continuity fields;
- the Animatic timeline, for duration.

There is no table, cache or duplicate canonical-frame pointer, and no migration. `FRESHNESS_PARTS` is unchanged, and
the GenerationPackage stays **v5**: the board never enters a package. No AI analysis, provider call, 3D set or GPU.

## Canonical display visual

Each card shows ONE clearly labelled image, in this priority:

| `visual.kind`         | Label                               | Meaning                                                    |
| --------------------- | ----------------------------------- | ---------------------------------------------------------- |
| `production_frame`    | Production Frame vN                 | the Shot's selected, canonical Production Frame            |
| `approved_storyboard` | Storyboard fallback vN              | no Production Frame yet; the approved Storyboard stands in |
| `draft_storyboard`    | Draft Storyboard vN · not canonical | only an unapproved Storyboard exists                       |
| `none`                | NO PRODUCTION IMAGE                 | nothing; links to Shot Prep                                |

- An approved Storyboard is never called a Production Frame.
- A **stale** Production Frame (or approved Storyboard) is still shown, with a ⚠ Stale overlay and the changed parts on
  demand. A stale Production Frame is never replaced by the Storyboard.
- Production Frames display in their own production shape (never the provider canvas or adapted request geometry).
- Images come only through the existing private asset route (`/api/assets/<id>`): no Storage, provider or signed URL.

The derived per-Shot health (`current_production_frame`, `stale_production_frame`, `storyboard_fallback`,
`draft_storyboard_only`, `missing_visual`, `integrity_blocked`) is never persisted.

## Card

Each card shows:

- Shot code, title and duration.
- The display visual and Production Frame status:
  - version · source · current / stale / missing;
  - "Generated · provider / model" from the frozen attempt when it still resolves.
- Location and the selected **View** (or "none"). No View is not a warning.
- Characters:
  - `Yumeko 🔒 Ivory Suit v1` when a Character Continuity Lock is selected;
  - `Yumeko · Live appearance · Ivory Suit` otherwise.

  `CharacterLook.locked` is a library flag and is never shown as a Continuity Lock.

- Shot status and the preflight blocker count.
- Integrity blockers: an invalid Location View or Continuity Lock selection, or orphaned selections. These are never a
  silent fallback.
- Links: Open Shot Prep, and the Production Frame section.

The top summary shows:

- Shots;
- current / stale / missing Production Frames;
- Storyboard-only Shots;
- continuity-link mismatches;
- integrity blockers;
- episode runtime.

The runtime is the Animatic's own total. It is visual readiness only: full generation readiness stays in each Shot's
Preflight. Client-local filters: All · Needs Production Frame · Stale · Continuity issues.

## Transitions (human review aids)

Every adjacent pair A → B gets a transition, including across a Scene boundary.

- **error** (the only automatic one): the stored `previousShotId` of B is not A.
- **change**: something differs across the cut and may be intentional.
  - Scene;
  - Location;
  - Location View: only when both Shots have a View;
  - Character enters / exits;
  - Continuity Lock A → B;
  - locked ↔ live (an appearance-authority change);
  - Look (both live);
  - screen / facing direction: "Screen direction changes: Left to right → Right to left (needs human review)";
  - weather;
  - time of day.
- **stable**: same Lock, same Look, same Location / View.

A locked Shot is compared by its Lock, never by today's mutable library. Prism does not judge the 180° rule. Invalid
selections are the Shot's integrity blockers.

**Compare** on a card opens a larger side-by-side panel for that cut. It shows:

- both visuals with their labels and freshness;
- Location / View, Characters, directions, weather / time and the link status;
- what changes and what carries over.

## Stored previous-Shot link

`shot.continuity.previousShotId` is persisted continuity intent, separate from order. It is part of the `continuity`
fingerprint, so Storyboards, Production Frames and candidates depend on it.

For each Shot, the expected link is the Shot before it in `shotOrder`, or null for the first Shot. A Shot's link status
is `synced`, `missing` or `wrong`; a non-null link on the first Shot is a mismatch too.

**Reorder never syncs links.** Drag-to-reorder on the board reuses `SortableBoard` and `reorderShots` unchanged:

- within a Scene only;
- locked Shots pinned;
- contiguous orders.

The mismatches it creates are shown and are not auto-synced.

## Explicit link sync

1. **Preview.** The board lists exactly what would change, e.g. `2B: 1A → 2A`
   (`sequenceLinkChanges(data, episodeId)`). It warns that this changes Shot continuity truth and may make existing
   Storyboard Frames, Production Frames and generations stale.
2. **Confirm.** The server action `syncSequenceContinuityLinks` recomputes `planSequenceLinkSync`:
   - it sets `previousShotId` (null for the first Shot, otherwise the previous Shot);
   - it writes ONLY the Shots that differ, and changes nothing else on them (order, Scene, Characters, Looks, Location,
     frames and generation state stay as they are);
   - the write is ONE `upsertMany` through the normal Shot save path, which is one transaction in Postgres.
3. **Locked Shots.** If any change would touch a `locked` Shot, the whole sync is refused and names that Shot. Nothing
   is partially applied.
4. **Stale preview (CAS).** The confirmation carries the **sync preview key** (`sequenceLinkPreviewKey`): a hash of the
   ordered Shot ids, their stored links and locked state. If it differs on submit, the action refuses with "The
   sequence changed. Review the new link changes before syncing.". This key is optimistic-concurrency protection for
   this action ONLY. It is not Shot freshness, not GenerationPackage provenance and not a persistent identity, and it is
   never stored.
5. **Consequence.** Nothing is marked stale by hand. The changed `continuity` part makes the existing freshness rules
   stale whatever depended on it, and the next package naturally carries the new link (still v5).

## Tests

- `src/domain/__tests__/shot-sequence.test.ts` covers:
  - visual priority and a stale PF staying visible;
  - order and runtime against the Animatic, and summary totals;
  - zero automatic failures on the seed;
  - link mismatch;
  - Location / View, Character entry / exit, Lock, Look, screen direction, weather / time;
  - integrity blockers;
  - reorder rules;
  - sync, the locked refusal, a stale preview, and freshness after a sync.
- `src/server/__tests__/sequence-actions.test.ts` runs the real action on the memory repository: only mismatched Shots
  are written, a locked Shot refuses the sync, and an outdated preview after a reorder is refused.
- `e2e/zzzzzzzzzzzzzzzzzzz-sequence-board.spec.ts` (memory) walks the flow: board → drag → mismatches → compare →
  preview → confirm → stale Storyboards → restore.
- `e2e/supabase-sequence-board.spec.ts` (real Studio database) runs the sync once through Auth, RLS and the Postgres Shot
  save, then restores the links exactly.
