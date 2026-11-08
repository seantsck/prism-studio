# Phase 5B-I4: Character Visual Bible

> Character → **Visual Bible** → choose the canonical identity → Looks → expressions and angles → a reusable cutout →
> ready for Shots.

Shot image generation now consumes **Character + canonical identity + selected Look + relevant references**
automatically. The filmmaker does not attach the same files to every Shot. A Shot can still add its own references.

No paid generation. Migration `0052` is repository and local only. Hosted DEV and the live site are unchanged.

## 1. Data model (audit first)

| Visual Bible part   | Representation                                                                                                                                                                  | New schema?            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Canonical identity  | an `IdentityRef` with `metadata.visualRole = "canonical"`                                                                                                                       | no (metadata is jsonb) |
| Identity references | `IdentityRef` slots: front, three-quarter, profile, full body, additional                                                                                                       | no                     |
| Looks               | `CharacterLook` with `referenceAssetIds`                                                                                                                                        | no                     |
| Expressions         | `IdentityRef` (slot `additional`) with `visualRole = "expression"` and `metadata.expression` (suggested: neutral, happy, concerned, angry, crying, surprised; or a custom name) | no                     |
| Cutout              | an `IdentityRef` with `visualRole = "cutout"` pointing at an existing **transparent** Asset (`hasAlpha` read from the bytes at ingest)                                          | no                     |

- **A designation is a pointer to an existing immutable Asset.** Nothing is copied.
- While a designation exists, the existing asset-usage rules pin the Asset (it counts as an identity reference).
- Removing a designation removes only the pointer, and the normal deletion rules apply again.

**The missing invariant, and the smallest migration that adds it.** "At most one canonical identity and one cutout per
Character" is enforced by the server action, but nothing in the database stopped two concurrent requests. Migration
`0052_character_visual_roles.sql` adds two partial unique indexes on `character_identity_refs`, keyed on
`metadata ->> 'visualRole'`. It is additive (no data change) and **local only**, like 0051. Evidence:
`src/data/__tests__/migration-0052.test.ts` (envelope, and 0051 unchanged), and `scripts/db-visual-bible.mts`, 6/6 on
the disposable database.

## 2. Priority, and the Shot integration

`orderedIdentityRefs` (`src/domain/visual-bible.ts`) sends a Character's references in this order:

1. the canonical identity;
2. the ordinary references, in library order;
3. the cutout;
4. expressions.

It is stable: a Character without roles keeps exactly the library order, so existing packages, fingerprints and
tests are unchanged.

- **Character image generation** (`buildSubjectImagePlan`): canonical identity → the selected Look → the other
  identity references. A request trims to the model's limit from the end, so the highest-priority images always
  survive. The frozen request records exactly which references were sent.
- **Shot generation:**
  - `liveAppearance` carries `canonicalIdentityAssetId`, and the GenerationPackage character entry carries it too
    (present only when one is designated, so existing packages stay byte-identical).
  - `deriveReferenceCandidates` sends canonical identity → the selected Look → the other identity images, inside the
    existing 2G.2 priority (Production Frame, Storyboard, Character, Location View, …). Without a canonical identity
    the order is unchanged.
  - A Character with a selected Continuity Lock still sends only its frozen images (2G.4 unchanged).
- **Freshness:** the fingerprint tuple of an identity reference gains its role only when it has one. Changing the
  canonical identity makes an earlier Shot approval stale; a project without roles keeps every fingerprint.

## 3. UI (Character page)

The **Visual Bible** panel sits above the Images panel:

- the large canonical image;
- the Character's name;
- readiness, e.g. "5 / 8 ready" (guidance only);
- a checklist: ✓ / ○ Canonical identity, Look with references, Front, 3/4, Profile, Full body, Transparent cutout,
  Expression references. Each open item carries a suggestion, such as "You don't have a full-body reference yet.";
- **Generate presets**, fed into the existing I1/I2 pipeline with no new backend: Generate Portrait, 3/4 View,
  Profile, Full Body, Expression, Look Reference.

The panel's actions:

- **Use as Canonical** (a source picker; replacing needs the explicit "Replace the current canonical identity"
  checkbox);
- **Add Expression** (a suggested or custom name);
- **Use as Cutout** (transparent images only);
- **Remove designation**.
- The **Looks** list shows each Look's reference count with guidance ("This Look has only one reference.") and a
  Generate Look Reference button.

On each generated image in the Images panel: **Use as Canonical** (or **Use as Cutout** for a cutout), alongside the
existing **Use as Character Reference**, **Use as Look**, **Edit Image** and **Remove Background**.

Model details sit under **Advanced**. Nothing is a hard gate; skipping an item means leaving it empty. Nothing is
generated or replaced without the creator.

## 4. Ojou-sama acceptance (memory, fixtures, free mock models)

`src/server/__tests__/visual-bible.test.ts` (8 tests) covers:

- **Yumeko, Sean and Takumi** each get a canonical identity and a reference on their seeded Looks: Episode 1 Formal
  Black, Charcoal, and Navy.
- **Yumeko additionally gets:**
  - a front reference (a generated portrait, through the existing action);
  - 3/4 and full-body references;
  - a Look reference;
  - expressions "happy" and a custom one;
  - a transparent cutout from Remove Background.

  Readiness shows exactly the open item (profile) as a suggestion.

- **A Shot with Yumeko** automatically sends her canonical identity first and her selected Look reference next. On a
  2-reference model those two survive the limit.
- **Canonical replacement:**
  - replacing it needs an explicit confirmation;
  - generation never changes it;
  - another Character's image, or an unknown one, is refused;
  - sources stay byte-identical.
- **The designated cutout:**
  - an opaque image is refused as a cutout;
  - the designated cutout is pinned against deletion;
  - removing the designation makes it deletable again.
- **Freshness:** changing the canonical identity changes the Shot fingerprint.

Also: `src/domain/__tests__/visual-bible.test.ts` (4 pure tests), and browser story H.
