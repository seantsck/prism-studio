# Production Frames (Phase 2G.1)

Prism Studio makes a film from an **image-first** path that needs **no GPU, no 3D set, no reconstruction, no COLMAP
and no Gaussian splat**:

```
SCRIPT → PERFORMANCE → SHOT PREP → STORYBOARD → PRODUCTION FRAME → IMAGE-TO-VIDEO → EDIT
```

The 3D / splat / blocking / camera work of Phase 2F is **optional spatial infrastructure**. It can help produce a
Production Frame, but it never gates one. Core principle: _never ask a generation model to remember information
Prism can store explicitly_: the approved image of a Shot is stored explicitly, with what it was made to represent.

## Five image concepts, kept distinct

| Concept              | What it is                                                                                    | Where it lives                                             |
| -------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Storyboard Frame** | Planning / composition approval.                                                              | `storyboard_frames`                                        |
| **3D Master Frame**  | A deterministic render from the OPTIONAL spatial scene.                                       | `scene_master_frames`                                      |
| **Production Frame** | The canonical approved still of a Shot that Prism carries into image-to-video and continuity. | `shot_production_frames` (this document)                   |
| **Provider Canvas**  | The execution geometry a generation model requires.                                           | the adaptation plan ([framing](framing-adaptation.md))     |
| **Delivery Frame**   | The final conformed media.                                                                    | delivery masters ([delivery-conform](delivery-conform.md)) |

They are never the same row: a Storyboard can be _promoted_ into a Production Frame (a new record that references
the same image), but promoting changes nothing about the Storyboard.

## Data model (migration 0039)

**`shot_production_frames`**: immutable history, one row per Production Frame ever made for a Shot.

| Column                                                                                 | Meaning                                                                                                                           |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `project_id`, `shot_id`                                                          | identity; `(shot_id, project_id)` is a composite FK to `shots`                                                                    |
| `version`                                                                              | 1, 2, 3 … per Shot; `unique (shot_id, version)`; assigned under a lock                                                            |
| `schema_version`                                                                       | `prism.production-frame.v1`                                                                                                       |
| `asset_id`, `asset_checksum`, `width`, `height`                                        | the private image Asset (composite FK `(asset_id, project_id)`) and its facts, frozen at creation                                 |
| `production_aspect_ratio`                                                              | the Shot's production ratio at creation, as written (e.g. `2.39:1`)                                                               |
| `source`                                                                               | `upload` · `storyboard` · `previs_master` · `generation_output`                                                                   |
| `source_storyboard_frame_id`, `source_master_frame_id`, `source_generation_attempt_id` | exactly the one that matches `source` (a CHECK); plain ids, not foreign keys, so history stays interpretable                      |
| `intent_snapshot`, `intent_fingerprint`                                                | `prism.production-frame-intent.v1`: what the frame was made to represent, copied by value, and its hash                           |
| `parts`                                                                                | the Shot's named-part fingerprints at creation (see [production-workflow](production-workflow.md#freshness-migrations-0009-0011)) |
| `frame_fingerprint`                                                                    | deterministic artifact identity (no timestamps); `unique (shot_id, frame_fingerprint)` is the duplicate key                       |
| `created_by`, `created_at`                                                             | who and when                                                                                                                      |

**`shot_production_frame_selections`**: ONE mutable pointer per Shot (`shot_id` is the primary key). Its composite FK
`(production_frame_id, shot_id, project_id) → shot_production_frames (id, shot_id, project_id)` makes it impossible,
in the database, to select a frame of another Shot or another Project.

**Asset taxonomy.** A new purpose `production_frame` (type stays `image`). Bytes live in the normal private bucket.
A **promotion** (Storyboard or 3D Master Frame) REFERENCES the existing Asset: nothing is copied. An **upload**
creates one new private `production_frame` Asset.

### Immutability

A frame never changes after creation: a trigger refuses every `UPDATE` (even from the database owner), and the owner
policy set has only `SELECT` and `INSERT` (no `UPDATE`/`DELETE` policy), so history is append-only for users;
cascades from a deleted Shot or Project still work. A trigger also checks, on insert, that the frozen checksum and size
are the Asset's own and that the Asset is a stored image of the same project. Selection is separate state: choosing
another frame moves only the pointer.

### Authority and RLS

User-domain state. Owner-only RLS (`is_project_owner`); a stranger and `anon` see 0 rows; the **generation and
continuity workers have no grant** and receive Production Frame information only through the frozen GenerationPackage
(`db:production-frames` asserts all of this against the real database).

## Sources

| Action in Shot Prep         | Source              | Requires                                                                                                         |
| --------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Use approved Storyboard** | `storyboard`        | the Shot has an approved Storyboard Frame whose image is a stored image at the production aspect                 |
| **Use 3D Master Frame**     | `previs_master`     | a 3D Master Frame of THIS Shot exists (the action is offered only then); its image passes the same rules         |
| **Upload Production Frame** | `upload`            | a PNG, JPEG or WebP at the production aspect, through the ONE shared upload pipeline                             |
| _(none in 2G.1)_            | `generation_output` | accepted by the schema for Phase 2G.2 (image generation); **no action creates one and no image model is called** |

No code path requires a `SpatialReference`. A project with no 3D set, no Production Camera, no reconstruction and no
GPU can create, upload, select, inspect and use Production Frames.

### Production aspect and size

The Shot's production aspect is its own `composition.aspectRatio`, else the Bible's `aspectRatio`; it is **never
hardcoded** (the seed happens to use 2.39:1). An image is accepted when its real pixel size is within a **1 % relative
aspect tolerance** of it (2.39 vs 2.388 match; 16:9 vs 2.39:1 does not) and at least 64 px on each side. A wrongly
shaped image is **refused, never cropped or padded** (a future conform tool may create a correctly shaped _derived_
Asset). Production Frames are **not** required to be 1912×800: that is only the current 3D master render size; any
size at the right aspect is valid and the real width and height are stored. Accepted types: PNG, JPEG, WebP (those
whose size Prism can read and verify on the server).

## The frozen visual intent (`prism.production-frame-intent.v1`)

Built by the pure `buildProductionFrameIntent(ctx)` from the Shot's resolved context, by value:

- **Shot**: id, code, title, story beat, dramatic purpose, duration; scene slugline; style (visual style, colour language)
- **Production framing**: aspect, shot size, framing, lens, aperture, camera position/height/angle, movement
- **Characters**: id, name, Look id and name, wardrobe, shoes, hair, makeup, jewelry, grooming, accessories, identity
  and Look reference Asset ids, expression, posture, gestures, interactions, performance notes
- **Location**: id, name, zone, description, geography, reference Asset ids
- **Lighting**, **blocking**, **performance** (lines, emotion, objective, selected take id and duration),
  **timing** (duration, poses, action beats), **continuity**, **constraints** (hard, negative, forbidden, guardrails)
- **Optional spatial facts** (scene fingerprint, camera bookmark, master-frame and environment Asset ids): present
  **only when the Shot has a 3D set**. The key is otherwise absent.

It is deliberately **not** a GenerationPackage: the package references the selected frame, so embedding it would be
circular, and provider/execution data has no place in a statement of visual intent.

### Fingerprints

- `intent_fingerprint` = `fingerprint(intentSnapshot)`; `parts` = `computeShotParts(ctx)` at creation.
- `frame_fingerprint` = `fingerprint({ schema, shot, source, source ids, asset checksum, size, production aspect,
intent_fingerprint })`. No timestamps and no row id: the same artifact always has the same identity.

### Duplicate promotion (exact behaviour)

Creating a frame whose `frame_fingerprint` already exists for the Shot (same Shot, same source artifact, same image
checksum and size, same visual intent) **returns the existing frame and re-selects it** instead of making an identical
new version. If the Shot's visual intent changed, the fingerprint differs and a **new** frame is legitimate even
when the underlying image is the same, because its meaning differs. An upload of identical bytes with unchanged intent
returns the existing frame; the redundant new Asset is not stored (its uploaded object is removed). Concurrent
creates are serialised on the Shot row: a version is `max + 1` computed inside the creating transaction, so concurrent creates never produce a duplicate (gaplessness is not a promise: a failed attempt rolls back and takes no number, but nothing relies on consecutive numbering), and N identical concurrent creates
make one frame.

## Selection

`selectProductionFrame` moves the Shot's pointer to another frame of the same Shot. It is a **compare-and-set**: the
form carries what the browser saw as canonical and a mismatch is a `conflict` ("The selected Production Frame changed
in the meantime"), so two tabs never silently overwrite each other. Selecting the frame that is already canonical
writes nothing. The selection never writes into `shot.generation.startFrameAssetId`.

## Freshness

`productionFrameFreshness(ctx, frame)` compares the frame's stored `parts` with the Shot's current ones:

- `missing`: no frame selected; `fresh`: nothing relevant changed; `stale`: names the changed parts.
- The parts that stale a frame: **camera, blocking, characters, Looks, location, props, lighting, action, continuity
  and the selected performance**. Story text, derived timing and constraints are frozen in the snapshot but do not stale
  the image on their own, and the optional 3D scene is deliberately **not** an input.
- A stale frame is **never deleted, rewritten or deselected**: it stays selected, shows `STALE` and what changed, and
  history keeps it. Restoring the Shot makes the same frame fresh again.

## ShotContext, GenerationPackage v3, start frame, preflight

- `ShotContext.productionFrames` (newest first) and `selectedProductionFrame` resolve from `ProjectData` alone
  (`productionFrames` / `productionFrameSelections`, attached by the server loaders from the Production Frame
  repository in memory and Postgres mode alike): no previs repository, no 3D data. Freshness is the pure
  `selectedProductionFrameFreshness(ctx)`.
- **GenerationPackage v3** ([generation-package](generation-package.md)): `references.productionFrame` (frame id,
  Asset id, version, source, intent fingerprint, `fresh|stale`, changed parts) and `freshness.productionFrame`, both
  present **only when a frame is selected**; the frame's Asset is in `package.assets`; the brief says
  `Production Frame: v2 · Uploaded · stale` and names the changed visual areas (never a path, URL or checksum).
  Historical **v2 snapshots are not rewritten and stay readable** (every v3 key is optional; no backfill).
- **Start-frame precedence** (image-to-video): **1. the Shot's explicit `generation.startFrameAssetId` override → 2. the selected Production Frame's image → 3. the approved Storyboard Frame's image → 4. none.** The override stays a
  deliberate execution choice; the selection table owns the canonical frame, so there is no duplicated mutable truth.
- **Two fingerprints** ([generation-package](generation-package.md#two-fingerprints-two-questions-never-interchangeable)):
  `provenance.fingerprint` is the **exact package identity** (the frozen v3 content; it differs from a v2 package of the
  same Shot) and `provenance.parts.overall` is the **Shot's production-input identity**. The selected frame contributes
  one part (`productionFrame`: frame id, frame fingerprint, image checksum, intent fingerprint) **only while selected**,
  so selecting or switching frames changes **both**, an unselected historical frame changes **neither**, and a Shot with
  no selected frame has the `parts.overall` it had before 2G.1. Shot Prep's "this shot has changed since attempt N"
  compares `parts.overall` (so a v2 → v3 package upgrade alone never reads as a change); attempts, candidate sets,
  continuity runs and exports keep the exact package fingerprint.
- **Preflight** `production_frame.fresh`: not applicable until a frame is selected (existing Shots keep the Storyboard
  path); passes when fresh; a **stale** selected frame **blocks image-to-video** with a clear reason, unless an explicit
  start-frame override is set (then a warning), and only warns for other modalities.

## Shot Prep UI

Section **16 · Production Frame** (after Storyboard): the selected frame's private preview, `Production Frame` heading,
version, source badge, aspect and dimensions, fresh/stale badge with the changed parts, created time. Empty state: "No
Production Frame yet. This is the approved image Prism will carry into image-to-video and continuity." with **Use
approved Storyboard** and **Upload Production Frame**; **Use 3D Master Frame** appears only when a master frame exists;
nothing mentions a 3D set or a GPU. History lists every frame newest first with thumbnail, version, source,
freshness and **Use**. Previews use the private `/api/assets/:id` route: no public URL, no signed URL, no Storage path in
client state.

## What 2G.1 does not do

No image generation (OpenAI, Gemini, Google, Runway, Kling, fal, Replicate: **0 calls, 0 paid calls**); no cropping or
padding conform; no continuity analysis of the frame (the structured facts are stored for it); no change to Phase 2F.
**Phase 2G.2 (Image Shot Generator)** adds Production Frame _candidates_: multiple generated stills, human compare and
review, and selection of the canonical frame, again with no 3D requirement; a generated image becomes a Production Frame
with `source = 'generation_output'` without redesigning this table (see the next section).

## Generated frames (Phase 2G.2)

`source = 'generation_output'` and `sourceGenerationAttemptId` are now used. A human chooses a succeeded
`production_frame` candidate ("Use as Production Frame"): the frame **reuses the attempt's existing private Asset** (no copy)
and is drafted by the same `draftProductionFrame`, created and selected through the same repository, so versions, duplicate
promotion (same checksum, aspect and intent returns the existing frame) and selection are unchanged. The image is the
attempt's selected **production conform** or the provider original when it already matches the production aspect; a
wrong-aspect original is refused with "Create the production conform first." and never silently cropped. A candidate that no
longer matches the Shot is refused as **stale**. The Asset is either the provider original or the deterministic conform,
whichever actually matches the production aspect. No new migration. Full rules and the Runway image models:
[image-shot-generator](image-shot-generator.md).

## Saving a Production Frame as a Location View (Phase 2G.3)

Shot Prep → Production Frame → **Save as Location View** turns the Shot's **selected, fresh** Production Frame into an
immutable canonical view of the Shot's Location (`source = production_frame`, `sourceProductionFrameId`), reusing the
frame's Asset (no copy). A stale frame is refused: it no longer depicts the Shot's intent. Saving a view selects nothing
and changes nothing about the Shot. The intent snapshot gains an optional `location.view` (the selected view's identity)
when a Shot has one; older snapshots stay valid and are never rewritten. See [location-views](location-views.md).

## Tests

| What                                                                                                           | Where                                                |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| rules, snapshot, drafting, freshness (per part), context, package v3, brief, precedence, preflight, no-3D flow | `src/domain/__tests__/production-frame.test.ts`      |
| memory service: versions, dedupe, concurrency, selection, compare-and-set, project/Shot isolation              | `src/data/__tests__/production-frame-memory.test.ts` |
| the real database: constraints, triggers, immutability, RLS, workers, concurrency, cascade, package            | `npm run db:production-frames`                       |
| UI, memory mode: empty → promote → upload → refusals → history → stale                                         | `e2e/zzzzzzzzzzzzzzz-production-frames.spec.ts`      |
| UI, hosted stack (Supabase Auth, RLS, private Storage)                                                         | `e2e/supabase-production-frames.spec.ts`             |
