# Human generation review (Phase 2E)

**Human visual review is authoritative, and it must be fast.** It is Prism's primary quality signal. Automated
continuity analysis ([continuity-analyzer-contract](continuity-analyzer-contract.md)) stays available as an _optional_
action ("Run AI Continuity Check") and is never required, never auto-run.

## Candidate review ≠ creative approval

|                  | Candidate review (`generation_reviews`) | Creative approval (`generation_attempts.review_status`) |
| ---------------- | --------------------------------------- | ------------------------------------------------------- |
| Meaning          | "how good is this candidate?"           | "this is the shot's output"                             |
| How many         | every candidate, any time               | at most one per shot                                    |
| Written by       | the user only                           | the user only                                           |
| Changes the shot | never                                   | yes (the shot points at it)                             |

A review never touches approval. **Promote to Shot** is the only bridge, and it is explicit.

## Decisions and reasons

Decisions: `approve` (Good), `shortlist`, `reject`, `unreviewed`.

Rejection reasons (select several; the first is the primary reason): character identity, wardrobe, hair/makeup,
location/set, props, composition, camera motion, body motion, facial expression, performance, lip sync, dialogue
audio, visual artifacts, physics, lighting, duration, framing, style, prompt adherence, other.

Strengths (don't only learn from failures): identity, wardrobe, motion, camera, performance, composition, set,
lighting, audio, overall quality.

A rejection needs at least one reason (one click); **no note is ever forced**. A note is optional (≤ 1000 chars).

## Quick review UX

On a candidate card: **👍 Good · Shortlist · ⭐ Best · 👎 Reject**. Reject opens six one-click reasons (Identity,
Wardrobe, Motion, Composition, Artifacts, Other) and "more reasons…" for the full list plus an optional note.
"What was good?" (optional) adds strengths.

Keyboard on a focused card (cards are focusable; `Tab` to move):

| Key   | Action                           |
| ----- | -------------------------------- |
| `1`   | Good                             |
| `2`   | Shortlist                        |
| `3`   | Reject (opens the reason picker) |
| `B`   | Best                             |
| `Esc` | close the reason picker          |

Keys are ignored while typing in a field. Every action is also a real button with a title and label.

## Only a completed generation can be reviewed

A candidate that failed, was cancelled, was never submitted or is still running has **no clip**. Its card shows the
provider failure (or state) and says "No clip to review"; it exposes no Good / Shortlist / Reject / Best controls and no
shortcuts. This is enforced in the UI, in the server action, in both repositories and by a database trigger
(migration 0028). In a partial set ("1/3 completed, 2 failed") the succeeded clip stays fully reviewable and can be
marked Best; the historical provider failures stay exactly as recorded.

## History is append-only

Changing your mind inserts a **new** review that `supersedes` the previous one. Nothing is rewritten (a DB trigger
rejects updates). The current review is the newest; the card shows how many reviews exist. Statistics use only the
current review per attempt, so a superseded rejection no longer counts against a model.

## Integrity

Providers, workers and analyzers cannot write human decisions: neither worker role has any grant on the review/set
tables (asserted in `db:candidates`). Reviews can only be written for attempts of the user's own projects (RLS).

## Candidate review is not final shot approval

Two different controls exist and they write to different places:

| Where                                    | Controls                         | Writes                                                             | Feeds model intelligence |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------------------------ | ------------------------ |
| Candidate board (`/candidates/<set>`)    | Good · Shortlist · Reject · Best | `generation_reviews` + the set's single preferred candidate        | yes (benchmark or prod)  |
| Attempt card on the shot's Generate page | Approve / Reject as final output | the attempt's `review_status` (legacy vocabulary, e.g. bad_motion) | no                       |

Final approval is the shot's creative approval; Best never makes it. The attempt card now says so and, for an attempt that
belongs to a candidate set, links back to the board. A final approve/reject recorded by mistake is not reinterpreted:
it stays what it is, and the candidate review is recorded separately on the board.

Phase 2H animation sets (`animate_production_frame`) use the same video review: Good / Shortlist / Reject / ⭐ Best,
and Best still never approves the Shot. The board adds the source truth (the Production Frame version each clip started
from, the first-frame provenance check, freshness, and "Delivery conform required"). See [image-to-video](image-to-video.md).

## Picture size on a candidate card

Five sizes are kept apart: the **production frame** (what the filmmaker designed), the **planning canvas** (the
adaptation plan's generic geometry), the **requested provider canvas** (what Prism actually sent), the **actual output** and
the **delivery** master.

- "Actual output" is the stored provider file's own dimensions (probed at ingest; for a historical asset with none
  recorded, read from the file in the browser). The request is never presented as the output.
- "Requested provider canvas" is read **only** from the stored output's frozen provider provenance
  (`provider.settings.providerCanvas`, or a pixel `ratio` such as `1280:720`). It is never recomputed from today's catalog
  and never borrowed from the plan. A model family that takes an aspect label and/or a resolution tier (Hailuo 3, the mock)
  shows exactly that ("16:9 at the 768p tier (aspect sent, no pixel canvas)"), with no manufactured pixels. An older attempt
  without recorded request geometry shows "unknown".
- "Planning canvas" appears only when the exact request is not known, labelled "(plan, not a request)".
- A conformed delivery master is reported separately.

Phase 2G.2.1 fixed a card that showed the plan's canvas as the request: the live image smoke displayed "1920×822
(requested)" while Runway had been sent, and returned, 2048×880.
