# Phase 5B Story Intelligence S4: Scene → reviewed Shot List

> Scene → **Plan Shots with Prism** → Shot List Proposal → the creator reviews, reorders and edits → **Apply** → Prism
> Shots.

S4 branches from `phase-5b-story-intelligence` at `5f0fac7` (S1 and S2 merged). Everything is local / test only:
migration 0056 is not applied to hosted DEV, and no real provider call is made.

**The model never writes Shots.** It returns a versioned, strictly validated Shot List Proposal. Deterministic code
creates or updates Shots only for what the creator approved.

## 1. Source and canon

A plan is made from a frozen **Scene snapshot** of the Episode's current accepted screenplay (`episodes.script_text`).
Unaccepted or rejected S2 writing proposals never reach it.

The snapshot contains:

- the Scene's own text (heading included) and its line range in the Episode;
- the Episode and Scene fingerprints (SHA-256);
- the latest script revision, when it matches;
- a keyed context the model can reference:
  - Characters `c1…`: the Scene's own, the speakers, and anyone named in the action;
  - the Location `l1`;
  - dialogue `d1…`: speaker and text, linked to the stored dialogue line id through the stable-id sync;
  - action `a1…`;
  - the existing Shots' codes (read-only).

A proposal is **stale** when the Scene's text no longer matches its `scene_fingerprint`. A stale plan cannot be
applied. Its sources are shown against the current screenplay (line-shifted when the Scene has only moved).

## 2. Shot List schema (`prism.shot-list.v1`)

Each proposed Shot has:

- `key`, `order` and `title`;
- `coverage`: establishing, master, two-shot, single, over-the-shoulder, reaction, insert, cutaway, POV or other;
- `purpose` (why it exists in the cut) and `beat` (story beat / action);
- `characterKeys`, `locationKey`, `dialogueKeys` (the dialogue covered) and `actionKeys`;
- `shotSize`: extreme wide … extreme close-up;
- `cameraAngle`: eye level, high, low, overhead, dutch, over-the-shoulder or POV;
- `framing` (one sentence), `emotionalIntention`, `continuityNotes`;
- `sources` (line ranges), `confidence` and `ambiguity`.

Lenses, moves and lighting are deliberately absent; S5 handles storyboard direction.

**Validation** (`validateShotPlan`) runs before anything is stored:

1. JSON, then the strict Zod schema (kept in lockstep with the Structured Outputs JSON schema);
2. every key exists in the frozen context, shot keys are unique, and order runs 1..n;
3. every source lies inside the Scene;
4. for a one-Shot regeneration, every other Shot comes back byte-identical.

A malformed answer gets one correction turn, then fails. Nothing is partially stored.

## 3. Provider

`StoryIntelligenceProvider` gains one provider-neutral operation, `planShots(ShotPlanRequest) → ShotPlan`.

- **OpenAI:** reuses the S1/S2 adapter. Same transport, strict JSON schema `shot_list`, two-call contract, ambiguous
  timeouts never re-sent. Prompt `shot-planner-v1`: a director/editor who thinks in coverage, not one shot per line;
  inserts only when justified; no inflation; screen direction kept; dialogue covered with the grammar the scene
  needs.
- **Free deterministic planner** for tests and development:
  - a master;
  - an over-the-shoulder to open a two-person exchange, a single for the reply, and a reaction on the listener for
    the last line;
  - a single for a lone speaker.

The Story worker claims Shot Lists alongside S1 and S2 work. It applies the same spend re-check and reads only the
frozen row; it cannot read Shots, Scenes, Characters or Episodes.

## 4. Persistence (migration 0056, local only)

S1's `story_proposals` was audited. Its row shape (scope, proposal, review) is specific to Production Proposals, so
S4 adds the parallel table **`shot_list_proposals`** with the same immutability rules instead of overloading it.

- One row per immutable version **per Scene** (`unique(scene_id, version)`, `parent_id`).
- **Frozen input:** Scene, Episode, both fingerprints, script revision, Scene text, keyed context, provider, model,
  schema and prompt versions, estimate, spend authorization; plus `scope` (full or one Shot) and `base_plan` for a
  one-Shot regeneration.
- **Result:** plan, usage, cost and error, written once by the worker.
- **Review** only while `ready`; `ready → applied` once, which freezes it.
- Owner-only RLS, no delete policy, triggers enforcing all of the above, and same-project / same-Episode references.

## 5. Review

The Scene page ("Plan Shots with Prism →") opens `/episodes/<ep>/scenes/<scene>/plan`.

**The ordered list** shows each Shot with:

- the code it will get (`3A — Lobby master`), coverage, size and angle;
- Characters and Location;
- why it exists, the beat and the dialogue covered;
- `Source: lines 23–24` with an excerpt;
- confidence or ambiguity;
- any possible match with an existing Shot.

**Per Shot:** Include, Reject, ↑ / ↓ (reorder), Split (two Shots, each covering half the dialogue), Duplicate (a
variant), and Edit (title, purpose, beat, framing, emotional intention, continuity, size, angle). Regenerate this
Shot (with an optional note) creates a new version, where only that Shot changes and the creator's other choices are
carried over.

**Whole list:** Select all / Deselect all, Save review, Regenerate whole list (a new version), **Apply selected**.

Nothing becomes project state until Apply.

## 6. Apply

`planShotListApply` is deterministic and goes through the Shot schema and repository, like every other Shot change.

- **New Shots** get ids derived from (proposal, item), so applying is repeatable. They take the next free codes in the
  Scene (3B, 3C…) and are ordered after the existing Shots.
- Each Shot gets title, story beat, purpose, composition (size, angle, framing, notes with coverage, emotional
  intention, continuity and `Source: lines … (Shot List vN)`), Location, Characters (character count set),
  dialogue lines (audio and script sources) and action blocks.
- **Existing Shots** are never silently replaced:
  - every proposed Shot defaults to **a new Shot** (append);
  - possible matches (same position, or same Characters and size) are surfaced;
  - "Replace 3A" updates that Shot **in place**: id, code, order, Look and performance notes, generations, frames and
    approvals are kept, and only its planning fields change. It requires the explicit "I approve replacing…" checkbox.
  - Cancel is simply not applying. Nothing is ever deleted.
- Apply is refused for a stale plan, for an already-applied plan, or when two items replace the same Shot.

## 7. Story changes

S2 marks a Scene "Story changed after production breakdown" when an accepted revision (or creator edit, or restore)
changes its text. On the plan page this shows:

- a warning, **Re-plan Shots** (a new version planned against the new canon), and "story changed" on the stale
  versions;
- the previous applied plan, which stays `applied`;
- the existing Shots, which are untouched until the creator reviews and applies a new plan.

## 8. Cost

S2's spend controls are reused:

- paid Prism AI is off unless `PRISM_STUDIO_ALLOW_PAID_STORY_AI=true`;
- the per-request ceiling still applies;
- every paid plan needs either the explicit "Confirm total" or the **capped allowance of the Episode's live writing
  session**, reserved atomically (`reserveBudget`, never exceeded);
- the worker re-checks every request;
- the output budget scales with the Scene.

Tests use only the free planner and fake OpenAI responses. The prepared real acceptance call (S2 §8) was not run.

## 9. Tests

| Area                          | File                                                             |
| ----------------------------- | ---------------------------------------------------------------- |
| Domain                        | `src/domain/__tests__/shot-list.test.ts`                         |
| OpenAI (fake transport)       | `src/story/__tests__/openai-shot-plan.test.ts`                   |
| Acceptance (actions + worker) | `src/server/__tests__/shot-list.test.ts`                         |
| Migration (static)            | `src/data/__tests__/migration-0056.test.ts`                      |
| Database (disposable)         | `scripts/db-shot-lists.mts`; `scripts/db-story-worker-login.mts` |
| Browser                       | story M                                                          |

What they cover:

- **Domain:** schema lockstep, canon snapshot, validation, coverage grammar, review operations, deterministic apply,
  replace with approval.
- **OpenAI:** instructions, schema, numbered Scene, correction turn, timeout, no key → no call.
- **Acceptance:**
  - Scene 3 plan; canon only;
  - edit / reorder / reject / split; regenerate one Shot and the whole list;
  - apply with replace and approval; Shot 3A feeds I6; apply once;
  - stale plan, and re-plan destroys nothing;
  - Sean + Yumeko coverage;
  - foreign Scene and malformed output refused;
  - paid gate, session allowance, worker fails closed;
  - zero network.
- **Database:** RLS, immutability, versions, worker limits, apply once; the worker login can read shot lists in flight
  and cannot read `shots`.
- **Story M:** Scene 3 → plan → duplicate / reorder / edit / deselect / replace 3A → Apply → 3A's Production Frame
  Inputs → an S2 change marks the plan story-changed.
