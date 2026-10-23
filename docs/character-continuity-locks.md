# Character Continuity Locks (Phase 2G.4)

Prism should never ask a generation model to remember a character's appearance it can store. A **Character Continuity
Lock** is an **immutable approved snapshot of one Character's appearance in one exact Look**: the identity and Look
facts copied by value, plus the exact reference images they were approved with. A Shot may select one Lock per
assigned Character. That Shot's production truth then reasons from the Lock, not from whatever the editable library
says today. This covers generation, Production Frame / Storyboard / candidate freshness and continuity QA references.

```
Character + IdentityRefs + Look  →  Create Continuity Lock ("Yumeko — Ivory Suit v1")
Shot assignment (Yumeko, Ivory Suit) → chooses the Lock → generation sends the Lock's frozen images and facts
Later edits to the Look / IdentityRefs → Shots WITH the Lock: unchanged · Shots WITHOUT a Lock: change, as before
```

No image is generated, no image byte is copied, and no 3D set, GPU, COLMAP, Brush or provider is involved.

## Character, IdentityRefs, Look, Continuity Lock

| Concept                  | What it is                                                                                 | Mutable?                     |
| ------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------- |
| Character                | The person (Yumeko): name, physical description, continuity rules (`characters`)           | yes                          |
| IdentityRefs             | Editable reference library: front · three-quarter · profile · full body · additional       | yes                          |
| Character Look           | Editable appearance configuration ("Ivory Suit"): wardrobe, shoes, jewelry, hair, makeup … | yes (unless locked)          |
| **Continuity Lock**      | ONE approved appearance: facts by value + exact images (`character_continuity_locks`)      | **never** (a revision = new) |
| Assignment's Lock choice | Which Lock a Shot Character assignment relies on (`shot_character_continuity_selections`)  | yes (one pointer)            |

A Look answers "what outfit / appearance configuration is this?". A Lock answers "exactly which approved appearance
facts and images does THIS Shot rely on?". IdentityRefs and Looks stay source libraries: nothing in this phase makes
them immutable or replaces them.

## Why Locks exist

Before 2G.4 a Shot pointed at a Look id, and generation read the CURRENT Character, IdentityRefs and Look. Editing the
Look or swapping an identity image later silently gave old Shots different visual inputs. With a selected Lock, the
Shot keeps meaning the exact appearance that was approved when the Lock was made.

## The record

`character_continuity_locks` + `character_continuity_lock_assets` (migrations 0041 + 0042), `src/domain/character-continuity.ts`:

- `schemaVersion` `prism.character-continuity-lock.v1`, `projectId`, `characterId`, `name` (the filmmaker's, e.g.
  "Yumeko — Ivory Suit v1"), `sourceLookId` (null = intentionally no Look), `createdBy`, `createdAt`.
- `facts` (`prism.character-continuity-facts.v1`), copied **by value**:
  - the Character's id and name at lock time, its physical description and continuity rules;
  - the source Look id;
  - `look`: the Look's name, wardrobe, shoes, jewelry, hair, makeup, grooming, body notes and accessories, or
    `null` when no Look is assigned (recorded intentionally, nothing invented).
- `references`: the frozen images, in a stable order:
  - identity images by slot (front, three-quarter, profile, full body, additional), then the Look's images in the
    Look's order;
  - each with `position`, `role` (`identity` / `look`), `identitySlot`, `label`, `assetId` and the Asset's
    `assetChecksum`, `width` and `height` at creation (a trigger checks them against the Asset);
  - the same Asset is frozen once; identity outranks Look.
- `lockFingerprint`: sha256 of the Character, the source Look (or null), the facts and the ORDERED references by role,
  slot and image checksum. No timestamps, user, URL or Lock name.

The `source_look_id` is a historical id, not a foreign key. A trigger checks at creation that it is a Look of the same
Character and Project. Afterwards the Lock is interpretable from its own snapshot, even if the Look is later deleted,
and never re-reads the Look row.

**Only real image evidence.** An IdentityRef with no Asset, or whose Asset has no stored file (the seed's placeholders),
stays in the editable library but never enters a Lock. Neither does a non-image or an Asset of another project. No
identity slot is required.

**At most 64 images, never truncated.** A Lock freezes every usable unique image: placeholders and unusable images
are excluded first, and the same Asset in both identity and Look counts once. If more than 64 remain, creating the Lock
is refused, from the Character page and from Shot Prep. The message names both counts, and nothing is saved: no Lock,
no Lock images, no selection change. Remove some Identity or Look references first. Prism never freezes the first 64
and silently drops the rest.

The Character page and Shot Prep show coverage truthfully: The Character page and Shot Prep show coverage truthfully:

- identity slots present and Look image count;
- `rich`: front, plus another angle, plus a Look image when the Lock has a Look;
- `sparse`: some images;
- `none`: facts only.

**Immutable.**

- `before update` triggers refuse every update of a Lock or of a Lock image, the table owner included.
- RLS has no UPDATE or DELETE policy on either table.
- Deferred constraint triggers compare a Lock's image rows with its frozen `reference_count` at commit. A Lock can
  therefore never be committed incomplete, and its membership can never grow later.
- Deletes happen only through Project / Character cascades.
- A revised appearance is a new Lock ("… v2").

**Dedupe.** The same appearance basis is the same Lock (`unique (character_id, lock_fingerprint)`, and the create locks
the Character row): five concurrent identical creates make one row. The same image bytes and facts are the same Lock,
whatever the Lock is named. A changed wardrobe, hair, makeup or identity image is a new Lock.

**Assets.** A Lock references existing Assets: creating one copies zero bytes and adds zero Asset rows. The Asset is a
real project-safe foreign key, so an image a Lock froze cannot be deleted from under it. The Assets page lists the Lock
as a usage, and the database refuses the delete. Migration 0042 makes that foreign key
`DEFERRABLE INITIALLY DEFERRED`, the fix-forward 0005 applied to `shot_characters`. A direct delete is therefore refused
at commit, while a Project cascade (which reaches the Assets and the Lock images on different paths) completes.

## Per-Shot selection

One selection per Shot Character assignment (`primary key (shot_id, character_id)`). Changing it moves only that
pointer, with compare-and-set (two tabs never silently overwrite each other); no Shot, Character, Look or Lock row is
touched. There is deliberately **no "Yumeko's current Lock"**: Shot 1 may keep "Ivory Suit v1" while Shot 42 uses v2.

A selected Lock must be the exact appearance contract of the assignment. This is enforced in the server and in the
database:

| Rule                                                 | Database                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| same Project                                         | composite FK `(lock, character, project)` + `(shot, project)`                    |
| same Character as the assignment                     | composite FK carries the Lock's Character; FK to the assignment row              |
| the Character is assigned to the Shot                | FK `(shot_id, character_id) → shot_characters` (**on delete cascade**)           |
| the Lock's Look IS the assignment's Look (null=null) | trigger on insert / update of the selection                                      |
| the assignment's Look changes                        | trigger on `shot_characters.look_id` deletes THAT Character's selection, at once |

So a Shot whose Yumeko changes from Ivory Suit to Black Evening Outfit can never silently keep the Ivory Suit images.
Removing a Character from a Shot removes its selection. The Postgres Shot write keeps assignment rows: removed
Characters are deleted, the others updated in place. A Look change is therefore an UPDATE the trigger sees, and an
unrelated Shot edit never drops a selection. The memory repository mirrors all of it (`onShotSaved`).

A stored selection that does not match its assignment can only arise from a data-integrity problem. That covers a
missing Lock, another Character or Look or project, and a Character no longer assigned. It is reported
(`continuityLockIssue` / `continuityLockOrphans`) and blocks generation (preflight `character.continuity_lock`). No
selection is never a blocker.

## Source-library changes vs locked Shot truth

When a Lock is selected, its snapshot is **authoritative** for the assignment's visual identity and Look. The
appearance is resolved once in `ShotContext` (`characters[].appearance`, source `continuity_lock`), and every consumer
reads that: the package, prompt plan, Production Frame intent, references, preflight and QA. Those fields are the
identity images, physical description and continuity rules, plus wardrobe, shoes, jewelry, hair, makeup, grooming,
body notes, accessories and Look images. Shot-specific performance stays live on the assignment: expression, posture,
gestures, physical interactions and performance notes.

| After the Lock was selected …                 | Locked Shot                         | Unlocked Shot with the same Look |
| --------------------------------------------- | ----------------------------------- | -------------------------------- |
| edit the Look's wardrobe / hair / Look images | unchanged; Storyboard / PF fresh    | changes; goes stale as before    |
| replace an identity image / physical text     | unchanged                           | changes                          |
| switch the Shot from Lock A to Lock B         | `characters` / `looks` parts change | n/a                              |

**Freshness parts.** No new part is added. A locked assignment's entry in the existing `characters` part becomes
`{ assignment, continuityLock: { lockId, identity basis } }`. Its `looks` entry becomes
`{ continuityLock: { lockId, Look basis } }`. Lock A → B therefore stales the approved Storyboard, the selected
Production Frame and earlier Production Frame candidates, and changes `parts.overall`. **A Shot without a Lock hashes
exactly as before 2G.4**, and so does one with an unselected Lock: its entries are byte-for-byte the old ones, and a unit
test compares them with the pre-2G.4 formula.

**Candidates.** The 2G.2 input basis keeps working: a candidate is judged by the named parts frozen in its package
snapshot. Changing the Lock selection later stales it. Editing the master library under the SAME Lock does not.
`candidateInputBasis().characterContinuityReferences` records, from the frozen records only, which Lock(s) the
candidate was generated under and which locked images were actually sent.

## GenerationPackage v5

- `version` / `packageSchemaVersion` = 5 (v4, v3 and v2 stay readable; nothing is backfilled or rewritten).
- `characters[]` describes the appearance Prism actually sends. For a locked assignment that is the Lock's frozen
  name, physical description, Look facts and images, plus `continuityLock: { lockId, name, lockFingerprint }`.
  Unlocked entries are unchanged.
- `references.characterContinuity[]` holds every selected Lock by value, in assignment order: Character id and name,
  Lock id and name, fingerprint, source Look, the full facts snapshot, and the ordered images with Asset ids, checksums
  and sizes. It is omitted when there is none.
- Every locked image is described in `package.assets` (never a URL or credential).
- `provenance.sourceVersions.characterContinuityLocks` maps `{ [characterId]: { lockId, lockFingerprint } }` for
  selected Locks only. Unselected Lock history is never recorded.
- The PromptPlan's identity and wardrobe sections state the Lock and its frozen facts: "Yumeko — Character Continuity
  Lock …", the physical identity, "identity reference images: front, profile", then wardrobe, hair and makeup. Every
  image therefore travels with role context. The hard constraints say the Look is "frozen by Character Continuity Lock
  …".

## Reference priority and multi-Character behaviour

The overall Production Frame candidate priority is unchanged:

1. Production Frame
2. Storyboard
3. Character identity
4. Character Look
5. Location View
6. generic Location references
7. lighting
8. explicit Shot references

2G.4 changes only where the Character images come from:

- **Lock selected:** the Lock's frozen identity images (slot order) and Look images (frozen order). Nothing else for
  that Character, so locked and live images are never both sent.
- **No Lock:** today's IdentityRefs and Look images, exactly as before.

Characters follow Shot assignment order. Identity images of every Character come before any Look image. The same Asset
is sent once under its highest-priority role: an image that is both the Production Frame and a Lock image is sent once,
as `production_frame`. The roles stay provider-independent (`identity`, `character_look`). Locked images are labelled
with their person, slot and Lock: `Yumeko identity — front (Continuity Lock "Yumeko — Ivory Suit v1")` and
`Yumeko Look "Ivory Suit" (Continuity Lock …)`. So Runway's GPT Image still tags them `YumekoIdentity`,
`YumekoIdentity2` and `YumekoLook` (Sean's `SeanIdentity` …), and the prompt legend names whose image is whose.

If the exact required references exceed the model's capacity, generation is **blocked** with no attempt, job or call.
Prism never drops a Character, identity image, Look image or Location View to make a model fit. A model that takes no
reference images still gets the Lock's facts in the prompt, plus the disclosure "Character reference images not
supplied to this model …"; it never claims visual identity conditioning occurred.

## Continuity QA integration

Continuity QA prepares its criteria and reference set from the package. A locked assignment's identity, wardrobe,
hair, makeup and jewelry criteria therefore judge against the Lock's frozen facts. Its reference set holds the Lock's
frozen identity and Look images, never newer library images, and the criterion's source names the Lock. Without a Lock
the existing IdentityRefs and Look references work exactly as before. Selecting a Lock runs **no** analyzer: Gemini /
OpenAI analysis stays human-triggered and separately gated. No other image analyzer was built.

## Security

- **Locks and Lock images:** owner-only, RLS `SELECT` + `INSERT` (no update or delete policy).
- **Selections:** owner CRUD.
- Strangers and anon see nothing.
- Neither `prism_generation_worker` nor `prism_continuity_worker` has any privilege on the three tables. Workers
  consume the frozen request and package.
- The browser only names ids. The server re-reads the Character, Look, IdentityRefs and Assets, and the database
  re-checks every rule.

## UI

- **Character page → Continuity Locks.**
  - **Create:** choose a Look or "No Look (intentional)" and a name.
  - **Cards, grouped by Look:**
    - name, Look and creation time;
    - physical description, wardrobe, hair, makeup and jewelry;
    - identity slots present, Look image count and coverage;
    - thumbnails served by the private asset route.
  - Each Look also gets an "Add Look image" upload, so a Look can carry reference images.
- **Shot Prep → 5 · Look → Character continuity**, per assigned Character:
  - **Selected:** the selected Lock with "Clear Lock".
  - **Offered:** the Locks of that Character made for the assignment's CURRENT Look, each with "Choose Lock". A Lock
    of another Look is never offered.
  - **Create:** "Create Lock from current appearance" (creates, then selects).
  - **None selected:** "No Character Continuity Lock selected. Prism will use the Character's current IdentityRefs and
    Look."
  - Copy: "A Continuity Lock freezes the exact identity, wardrobe and appearance references this Shot should preserve."

## Shot Sequence Board (Phase 2G.5)

Each Sequence Board card shows every assigned Character as either `Yumeko 🔒 Ivory Suit v1` (the selected Lock) or
`Yumeko · Live appearance · Ivory Suit`. `CharacterLook.locked` is never shown as a Continuity Lock.

Across a cut, a Character in both Shots is compared by its RESOLVED appearance, never by today's library:

- the same Lock is **stable**;
- Lock A → B is a **Lock change**;
- locked ↔ live is an **appearance-authority change**;
- two live assignments with different Looks are a **Look change**.

All of these are review notes, not failures. An invalid selection is the Shot's integrity blocker. See [shot-sequence-board](shot-sequence-board.md).

## No-Lock compatibility, no GPU, no 3D

Existing projects keep working with zero Locks: there is no backfill and no Lock requirement, and a Shot without a Lock
behaves, hashes and packages its characters exactly as before (apart from the package version number). Locks need no
generation, GPU, 3D set or reconstruction.
