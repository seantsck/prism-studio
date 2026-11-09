# Phase 5B production loop: convergence and verification

`phase-5b-production-loop` is the canonical Phase 5B base. It was created from `phase-5b-story-intelligence` at
`c265c04` (S5 merged).

```text
Screenplay → AI writing → Production Proposal → Characters / Locations / Scenes → Shot List → Storyboard Direction
→ Character Visual Bible → Location Visual Bible → automatic references → Production Frame Inputs
→ candidate generation → conform → canonical Production Frame
```

This is an integration slice. No product features were added: only tests, one message fix and this document.

## 1. Lineage

- `phase-5b-image-pipeline` (`4773dd4`, I6 merged) **is an ancestor** of `c265c04`.
  `git rev-list c265c04..4773dd4` is empty, so no image commit is missing, and the image line has no newer commits.
  There was nothing to merge and **no conflicts**.
- Every slice merge is in the history:

| Slice | Merge commits                               |
| ----- | ------------------------------------------- |
| I1    | `65ec005`, with the 0051 gate fix `4505e5d` |
| I1b   | `8a24cfa`                                   |
| I2    | `df755bb`                                   |
| I3    | `9cf79c4`                                   |
| I3b   | `c582e41`                                   |
| I4    | `6c2a588`                                   |
| I5    | `3bffe96`                                   |
| I6    | `4773dd4`                                   |
| S1    | `78d12fa`                                   |
| S2    | `5f0fac7`                                   |
| S4    | `e181394`                                   |
| S5    | `c265c04`                                   |

## 2. Feature presence

| Slice    | Present (code; tests that pass on this line)                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1 / I1b | Character and Location image generation (`subject-image`), Shot image entry points (`shot-image-actions`)                                                        |
| I2       | image editing, transparent generation (mock-image provider, `image-*` tests)                                                                                     |
| I3 / I3b | local matting (`prism-matting`), Photoroom fallback adapter (`providers/photoroom`, fake transport only)                                                         |
| I4       | Character Visual Bible: canonical identity, Looks, expressions, cutout, automatic Character references                                                           |
| I5       | Location Visual Bible: canonical, Location Views, variants, background plates, automatic Location references                                                     |
| I6       | reference tiers (essential / frozen / explicit / optional), candidate workflow, production conform, promotion, alternatives                                      |
| S1       | paste / upload / import, Production Proposal, review / apply, immutable versions                                                                                 |
| S2       | rewrite / continue / brainstorm / alternatives, script revision history, Accept / Reject, story-change warning                                                   |
| S4       | Scene → Shot List, review / reorder / edit, deterministic apply, approved in-place replace, source traceability                                                  |
| S5       | Shot → Storyboard Direction (framing, lens, camera, blocking, lighting, composition, continuity, View constraint, storyboard description), direct I6 integration |

## 3. Migrations

0051 → 0057, in order, all 57 applied from zero on a reset disposable database. The checksums are pinned by the
static migration tests:

| Migration | Checksum    |
| --------- | ----------- |
| 0051      | `1f9ca200…` |
| 0052      | `3bbbae94…` |
| 0053      | `229eed99…` |
| 0054      | `382747f5…` |
| 0055      | `5de7cc21…` |
| 0056      | `01d2452b…` |
| 0057      | `737b81a1…` |

No historical migration has been rewritten since its merge. 0051's second commit is the I1 compatibility-gate fix,
made before I1 merged. Nothing is applied to hosted DEV.

## 4. The complete pre-video acceptance

`src/server/__tests__/production-loop.test.ts` exercises one path through the real actions, workers and repositories
(memory), with the free Story fakes and the free mock image model. A network spy proves zero external calls.

1. **Story (S1):** the Ojou-sama screenplay produces a Production Proposal (Yumeko, Sean, Takumi…, 5 Locations, 6
   Scenes). Applied to a fresh project it creates Characters, Locations, an Episode, 6 Scenes and Shots, and the
   Episode's first revision is the imported source.
2. **Writing (S2):** an accepted Prism revision of Scene 3. Revisions are `ai_revision, baseline`, and Scene 3 is
   story-changed.
3. **Shot planning (S4):** a Shot List planned against the accepted canon. The master replaces 3A in place (approved)
   and a Yumeko single is added. 3A carries "Source: lines 19–… (Shot List v1)".
4. **Visual Bibles (I4 / I5):** Yumeko's canonical identity, her Formal Black Look reference, the Lobby canonical, and
   the "Entrance → elevators" Location View selected for 3A (fixtures only).

   These are set up **before** direction, because the View is a hard constraint S5 must see.

5. **Direction (S5):** 3A is directed against the selected View and every section is applied. S4's source line
   survives.
6. **Production Frame Inputs** for 3A: see §5.
7. **Candidate:** the free `mock-image-1` candidate set.
   - It sends the four Visual Bible references with no manual attachment.
   - Promotion is refused with `needs_conform`; the production conform (ffmpeg, the existing 2C pipeline) then makes a
     512×214 (≈2.39:1) delivery image.
   - **Use as Production Frame** promotes from the conform, and after a refresh it is still the selected canonical
     frame.

## 5. Shot 3A Production Frame Inputs (exact, from the acceptance)

```text
Ready       characters ✓ location ✓ direction ✓ story ✓
Story       3A — Lobby master
            (tightly) The lobby is hushed. Yumeko stands alone at the elevators.
            Scene 3: INT. GRAND CELESTE LOBBY - NIGHT
            Establish the space and play the whole scene wide, so every later cut has a home.
Characters  Yumeko — Canonical Identity
            Yumeko — Episode 1 — Formal Black Look
            Yumeko — screen right, midground, facing three-quarter away from camera
Location    Grand Celeste Lobby — Entrance → elevators
            Grand Celeste Lobby — Canonical
            Time of day: Night · Weather: Indoors · Zone: Elevator bank
Direction   wide · 24–28mm — wide environmental · Hushed, lonely
            Angle: eye level
            Yumeko in the midground, frame right, in the Episode 1 — Formal Black Look.
            Movement: Static
Continuity  Wardrobe: Formal Black · Follows 2E
References  essential  identity        Yumeko canonical identity
            essential  character_look  Yumeko Look "Episode 1 — Formal Black"
            essential  location_view   Canonical Location View "Entrance → elevators"
            optional   location        Grand Celeste Lobby canonical location
```

The story beat begins with "(tightly)" because the free S2 test writer adds a parenthetical to the accepted line. The
beat really is the accepted canon.

## 6. Staleness chain (same test, after the Production Frame)

A creator edit to Scene 3 is accepted. Then:

- Scene 3 is **story-changed** (the breakdown needs review).
- The applied Shot List no longer matches the Scene (**Re-plan Shots** is offered, never run).
- The applied direction's Scene fingerprint no longer matches (**"Direction needs review"**).
- The canonical Production Frame **stays selected**, its Asset and attempt intact (historical media).
- **Nothing** is deleted, re-planned, re-directed or regenerated: Shot ids, 3A's direction fields, proposal counts and
  attempt counts are unchanged, and the fake providers recorded no new call.

Story O shows the same chain in the browser: the Shot's story-changed notice, then "Direction needs review" on Direct
with Prism.

## 7. Workers and security

**Story worker:**

- `npm run story:db:provision` (with `--rotate`) and `npm run worker:story -- --once` both ran against the disposable
  database, through a temporary `.env.local` copy of the disposable env that was deleted afterwards. The worker ran
  as `prism_story_worker` and the secret never appeared in output. Without a credential it exits with code 2.
- `db-story-worker-login`: 27/27. It reads only the four proposal tables, while in flight. It cannot read Shots,
  Scenes, Characters, Episodes, script revisions, sessions, story-change markers, Assets or Projects; and it cannot
  insert, delete, create or SET ROLE.

**Generation worker:**

- `worker-db-check`: 32 PASS / 0 FAIL. No grant on any Story table.
- `db-worker-role --set-role`: 55/62, **identical on the pre-Story image base `4773dd4`** (same 7 checks, same
  database conditions). These failures predate Story; they come from impersonation on the disposable superuser (the
  suite targets hosted DEV with a real worker login). Not a regression.
- `db:generation` 71/71, `db-candidates` 55/55, `db-production-frames` 71/71.

**Static boundary** (`phase5b-boundaries.test.ts`):

- the generation worker and its providers never read a Story credential;
- Story code and the Story worker never read a generation credential or the generation worker's database login;
- no browser module names any provider or worker secret, or imports a worker registry;
- no `NEXT_PUBLIC_*` provider or worker variable exists;
- the Story migrations grant nothing to the other workers.

## 8. Navigation (UX sanity) and Phase 5D debt

Story O walks Import Story → Write → Scenes → Plan Shots → Shot → Direct with Prism → Production Frame through the
real links, with no typed URLs. Gaps found (not fixed here; for Phase 5D):

1. **Plan Shots** is reachable only from the Scenes page, inside a collapsed row. The Write page's Scene chips, the
   Shot page and the "Story changed" notice do not link to it.
2. The **"Story changed after production breakdown"** notice links to Write and "Mark reviewed", but not to **Re-plan
   Shots** or **Direct with Prism**, the two places that need the review.
3. The **Shot page** shows no direction status. "Direction needs review" appears only after opening Direct with Prism.
4. After **Apply** on a Shot List, newly created Shots are only reachable through the "Existing Shots" list. The applied
   message has no links.
5. After **S1 Apply**, the created Scenes have no "Plan Shots" call to action (the applied panel links one Shot only).
6. The S5 **Storyboard description** reaches the provider prompt (camera notes) but is not shown as its own line in
   the Production Frame Inputs panel.
7. For 2.39:1 Shots every candidate needs a separate **Create production conform** click before **Use as Production
   Frame**.
8. Import Story, Write, Plan Shots and Direct with Prism each repeat the Advanced model / Confirm total block. There is
   no Story-wide budget view.

## 9. Test matrix (serialized, conservative workers)

| Gate                                                                  | Result                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration chain from zero                                             | 0051–0057, 57 applied                                                                                                                                                                                                                              |
| DB suites                                                             | story worker login 27/27 · 0057 22/22 · 0056 23/23 · 0055 29/29 · 0054 21/21 · 0051 28/28 · 0052 6/6 · 0053 10/10 · generation 71/71 · candidates 55/55 · location views 69/69 · production frames 71/71 · behavior 61/61 · worker role audit 32/0 |
| S1 / S2 / S4 / S5 + boundary + loop                                   | focused suites (see the PR)                                                                                                                                                                                                                        |
| I1–I6                                                                 | image pipeline suites                                                                                                                                                                                                                              |
| Browser                                                               | stories A–O (O new)                                                                                                                                                                                                                                |
| Full unit suite, typecheck, ESLint, Prettier / diff, production build | see the PR                                                                                                                                                                                                                                         |

Hosted DEV: no changes. Live site: unchanged. Paid calls: zero.
