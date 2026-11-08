# Phase 5B-I6: Reference-driven Production Frames

> Shot → Prism assembles the approved visual context → the creator reviews it → chooses the model → **Generate
> Production Frame** → candidates → review → edit if desired → promote one canonical Production Frame → animate it.

**No new generation system.** I6 is orchestration and creator UX over pieces that already exist:

- the Production Frame candidate sets (2G.2), attempts and jobs, the model registry and spend gates, the worker and
  private Storage;
- Edit Image (I2) and the immutable promotion (2G.1);
- the exact-input fingerprint and freshness;
- the I4/I5 reference assembly.

**No migration.** An attempt already freezes everything a candidate needs:

- provider, model, prompt and prompt plan;
- the exact references sent, with labels;
- the compatibility report (what was not used, and why);
- the package snapshot and fingerprint;
- the cost estimate and the output Asset.

The candidate set groups the attempts. Promotion is the existing Production Frame record.

## 1. The Production Frame input package

The input package is the existing GenerationPackage (v5) built from the Shot's context. It already carries:

| Part       | Contents                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Story      | Scene, Shot, story beat, dramatic purpose, dialogue                                                                                      |
| Characters | Each Character: name, canonical identity (I4), selected Look, prioritized identity images, Continuity Lock, expression / posture / marks |
| Location   | The Location, selected Location View, canonical Location and relevant Visual Bible references (I5), time of day, weather, set zone       |
| Direction  | Shot size, framing, lens, camera position / height / angle, movement, blocking, eyelines, lighting                                       |
| Continuity | Wardrobe, hair / makeup, props, previous Shot, Continuity Locks                                                                          |

`src/domain/generation/production-frame-inputs.ts` reads that package. It never builds a second one:

- `productionFrameInputs(pkg)` gives the human-readable lines, the readiness ticks, and every reference in priority
  order with its tier.
- `fitProductionFrameToModel(pkg, model)` gives what a chosen model will be sent, what is omitted (by name), the
  refusal (if any) and the exact prompt.
- `modelsFittingEssentials(pkg, models)` recommends models with enough room. It is a recommendation only; the human
  chooses.

## 2. Essential, frozen, optional and explicit references

The tiers are defined in `ReferenceTier` (`compatibility.ts`). The audit kept the 2G.2 send order and the 2G.4 Lock
guarantees.

| Tier          | What                                                                                                                                                                                                                                           | At the model's limit                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **essential** | each Character's identity (its designated canonical identity, else its first identity image; with a Continuity Lock, the Lock's first frozen identity image), each Character's selected Look (its first image), and the selected Location View | never dropped; if they alone do not fit: **refused**          |
| **frozen**    | a Continuity Lock's other frozen images                                                                                                                                                                                                        | never dropped, never reordered                                |
| **explicit**  | the creator's own Shot references and the lighting reference                                                                                                                                                                                   | never dropped (the existing "Reduce references in Shot Prep") |
| **optional**  | everything Prism adds automatically: the current Production Frame, the approved Storyboard, other identity and Look images, the Location Visual Bible (canonical, establishing, plates, relevant variants), generic Location references        | dropped lowest priority first, each **named**                 |

**Send order** is unchanged:

1. the selected Production Frame, then the approved Storyboard;
2. Characters: canonical identity → selected Look → other identity images (I4);
3. the selected Location View;
4. the Location Visual Bible (I5);
5. generic Location references, then lighting, then Shot references.

**Trimming** removes optional images in reverse send order, so the Storyboard is the last optional image to go and it
never outranks an essential one.

**Refusal.** The message is `This model supports 4 references, but this Shot requires 5 essential references.`, recorded
as `references.too_many`, so existing callers keep their contract. Omitted references are disclosed as the ignored
feature `references.optional_trimmed`, with every name. The model is never switched.

**Changed from 2G.3 / I5:**

- 2G.3 refused any Production Frame request over the limit, even when the extra images were automatic. Those images are
  now trimmed with disclosure.
- I5 trimmed only Visual Bible images. On Production Frames I6 trims all optional images; other purposes keep the I5
  rule.

The tests that encoded the old rule were updated to the new one:

- `location-view.test.ts`, `location-view-flow.test.ts`, `location-visual-bible.test.ts`;
- the I1b Alternate Composition payload.

## 3. One prompt composer

`buildPromptPlan` (`prompt-plan.ts`) stays the single composer. Its `production_frame` purpose orders a still as:

| Part             | Sections                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Semantic content | subject, identity, wardrobe, environment, action, performance (the line and its emotion only) |
| Cinematography   | composition, camera, lighting                                                                 |
| Continuity       | continuity                                                                                    |
| Constraints      | hard constraints, negative constraints (only what Prism data supports)                        |

A still has no duration, so there is no timing section. The prompt says to match the canonical identity image and the
canonical Location image when they are sent. Other purposes are unchanged.

**Additional direction** (optional) is a small, bounded override, recorded as `modelSettings.creatorDirection`.
**Alternate Composition / Generate Alternatives** varies only framing, lens, camera position and composition, and marks
the planned camera as "planned". Both prepend `CREATOR_DIRECTION_GUARD` to the hard constraints: identity, wardrobe,
Location and continuity never change. No manual prompt editing is required.

## 4. UI (Shot Prep → Production Frame)

**Production Frame Inputs:**

- Characters ✓ · Location ✓ · Direction ✓ · Story ✓;
- for example, "Yumeko — Canonical Identity", "Yumeko — Episode 1 — Formal Black Look", "Grand Celeste Lobby —
  Entrance toward elevators", "Grand Celeste Lobby — Canonical", the Direction line, and the Story;
- when the chosen model cannot fit the essentials: the refusal, plus the models that would fit;
- when it omits optional images: their names.

**Actions:**

- **Generate Production Frame**;
- **Generate Alternatives** (Alternate Composition when no frame exists yet);
- Generate Storyboard;
- **Candidates**: 1–4, one model, repeated. The spend gate prices every candidate, and a paid model needs the confirmed
  total;
- **Additional direction**.

**Advanced:** the model (Prism suggests a free one; you choose), the cost per candidate, every reference with its tier
and whether it is sent, and the exact prompt.

**Candidates**, shown together:

- **Use as Production Frame** (the existing immutable promotion; never automatic);
- Use as Storyboard Frame;
- **Reject** (the existing candidate review, with a reason);
- a "Production Frame" badge on the current one, and "inputs changed" when what it was made from has changed;
- Edit Image remains I2's action. Its result is a new candidate, and the source is never changed.

## 5. Freshness

A candidate is stale exactly when the Shot's inputs changed (`shotChangedSinceAttempt`, the fingerprint parts):

- the canonical identity or Look;
- the selected view;
- the canonical Location;
- a relevant variant;
- direction;
- continuity;
- the Storyboard used.

A Visual Bible change the Shot does not receive (an unused variant) keeps it fresh. This is the I5 exact-input rule.

## 6. Acceptance (memory, free mock models, no provider call)

`src/generation/__tests__/production-frame-i6.test.ts` (9 tests) covers:

- **Shot 3A**, with two candidates through the real candidate-set workflow, worker and Storage, sends exactly:
  1. Yumeko canonical identity;
  2. her Formal Black Look reference;
  3. the selected Lobby view "entrance toward elevators";
  4. the Lobby canonical;
  5. the Lobby establishing view;
  6. the night variant.

  It never sends the golden-hour variant. The still prompt has no timing.

- **Limits:**
  - at 4, the establishing view and night variant are omitted by name;
  - at 2, the request is refused with "supports 2 … requires 3 essential";
  - with mock-image-lite, it is refused and no attempt is created.
- **Storyboard:**
  - generation works without one;
  - with one, it is an optional composition reference;
  - at 3 references it gives way to the essentials.
- **Promotion and alternatives:**
  - nothing is promoted automatically;
  - promotion is explicit;
  - Generate Alternatives makes a new candidate with the same identity, Look and Location images and the protected
    direction;
  - the canonical frame record is unchanged;
  - an edit of it makes a new Asset, and the frame's bytes are unchanged.
- **Freshness:** an unused variant keeps the candidate fresh; a new Lobby canonical stales it.
- **Foreign assets:** another project's asset never reaches the package.
- **Shot 6A (Sean + Yumeko):**
  - both canonical identities, then both Looks, then the view, then the Location;
  - 5 essentials;
  - at 5, every Location image is omitted by name;
  - at 4, the request is refused.

Also:

- `src/domain/__tests__/production-frame-inputs.test.ts`: Continuity Lock tiers (essential, frozen), frozen images never
  trimmed, and explicit references kept;
- `src/server/__tests__/shot-image-actions.test.ts`: candidate count, direction and bounds;
- browser story J: the real app, from the Lobby Visual Bible to promote, refresh and alternatives.
