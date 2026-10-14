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

## History is append-only

Changing your mind inserts a **new** review that `supersedes` the previous one. Nothing is rewritten (a DB trigger
rejects updates). The current review is the newest; the card shows how many reviews exist. Statistics use only the
current review per attempt, so a superseded rejection no longer counts against a model.

## Integrity

Providers, workers and analyzers cannot write human decisions: neither worker role has any grant on the review/set
tables (asserted in `db:candidates`). Reviews can only be written for attempts of the user's own projects (RLS).
