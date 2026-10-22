# Location Views (Phase 2G.3)

Prism should never ask an image or video model to remember a place it can store. A **Location View** is one
**immutable canonical image of a Location plus a written description of the viewpoint it shows** ("Doorway", "Window
side", "Reverse"). A filmmaker makes it once; any Shot set at that Location can choose it; Prism then hands **the same
image** to every Production Frame generation of those Shots, so the place keeps its geography.

```
Location → canonical Location Views → Shot chooses a view → Production Frame candidates use that image
        → human chooses the Production Frame → (2H) image-to-video starts from it
```

No 3D set, GPU, reconstruction, COLMAP, Brush or splat is required anywhere. A 3D Master Frame may optionally become a
view's image (the schema accepts it as a source); that is all.

## Location, Location reference, Location View

| Concept               | What it is                                                               | Mutable?                     |
| --------------------- | ------------------------------------------------------------------------ | ---------------------------- |
| Location              | The place: description, geography, zones, entrances, lighting            | yes (unless locked)          |
| Location reference    | `Location.referenceAssetIds`: broad source photos of the place           | yes (the list)               |
| **Location View**     | ONE named viewpoint: image + `prism.location-view-spec.v1`               | **never** (a revision = new) |
| Shot's view selection | Which view of ITS Location a Shot uses (`shot_location_view_selections`) | yes (one pointer per Shot)   |
| Production Frame      | One Shot's approved still (may become a Location View; is never one)     | history immutable            |

A generic Location reference is **never** silently treated as canonical: it becomes a Location View only when a
filmmaker names it ("Use existing Location reference"), and it stays in `referenceAssetIds` afterwards.

## The record

`location_views` (migration 0040), `src/domain/location-view.ts`:

- `schemaVersion` `prism.location-view.v1`, `projectId`, `locationId`, `name`, `kind`
  (`establishing · entrance · reverse · side · zone · detail · custom`)
- `assetId` + frozen `assetChecksum`, `width`, `height` (a trigger checks them against the Asset)
- `source` (`upload · location_reference · production_frame · storyboard · previs_master`) with exactly its own source
  id (`sourceProductionFrameId` / `sourceStoryboardFrameId` / `sourceMasterFrameId`; not foreign keys, like 0039)
- `viewSpec` (`prism.location-view-spec.v1`): `name`, `kind`, `zone` and `entrance` (copied **by value** from the
  Location's own lists), `viewpointDescription`, `orientation`, `cameraPosition`, `cameraHeight`, `cameraAngle`,
  `shotSize`, `framing`, `lens`, `geographyNotes`, `continuityNotes`. Any field may be empty. **No coordinates**: this is
  semantic production data.
- `viewFingerprint`: sha256 of the Location, the image checksum and the full viewSpec. No timestamps, no source.

**Immutable.** A `before update` trigger refuses every update (the table owner included); RLS has no UPDATE or DELETE
policy. Deletes happen only through Project / Location cascades. A revised doorway is a new view ("Doorway — tighter").
There is deliberately **no "current version of Doorway" pointer**: each Shot names the exact view it means, so a new
view never rewrites an older Shot.

**Dedupe.** Creating the same Location + image bytes + viewSpec twice returns the existing view (an upload's redundant
object is removed). The same image with a changed spec is a new view: its production meaning changed. Source is not
part of the key: the same picture described the same way at the same Location is the same canonical view however it
reached Prism.

**Image shape.** A Location View is a reference, not a frame: any aspect ratio (4:3, portrait...) is stored as is and
never cropped to the production aspect. PNG / JPEG / WebP, at least 64 px a side, with a stored file and a checksum.

## Sources (no bytes are ever copied)

| Source                       | Where                          | Asset                                |
| ---------------------------- | ------------------------------ | ------------------------------------ |
| Upload                       | Locations → Location Views     | one new private `location_ref` Asset |
| Existing Location reference  | Locations → Location Views     | the reference's own Asset (reused)   |
| Production Frame             | Shot Prep → Production Frame   | the frame's own Asset (reused)       |
| Storyboard / 3D Master Frame | schema only in 2G.3 (optional) | its own Asset (reused)               |

Uploads go through the shared pipeline (MIME + magic bytes, size, dimensions, checksum, private Storage). The Asset and
the view are written in **one transaction**; a refused spec, a failed write or a duplicate removes the stored object
(`src/server/location-view-upload.ts`). No new asset purpose was needed (`location_ref`).

### Production Frame → Location View

Shot Prep → Production Frame → **Save as Location View** (name, kind, optional zone / entrance, viewpoint, orientation,
notes). Offered only when the Shot has a Location **and** a **selected, fresh** Production Frame
(`productionFrameToViewStatus`): a stale frame no longer depicts the Shot's intent and is refused. The view reuses the
frame's Asset, `source = production_frame`, `sourceProductionFrameId` set. Saving a view does not select it for any
Shot and changes nothing about this Shot. No provider call.

## Shot selection

`shot_location_view_selections`: one row per Shot (`shot_id` primary key) naming `location_view_id` and the view's
`location_id`. Changing it moves only this pointer: the Shot row, the view and the Location are untouched.
Choose / Clear use compare-and-set (the view the browser saw), so two tabs never silently overwrite each other.

**Same Location only**, enforced in the UI, the server (`wrong_location`) **and** the database:

- a composite foreign key `(location_view_id, location_id, project_id) → location_views (id, location_id, project_id)`
  keeps the pointer inside the view's own Project and Location;
- a trigger requires that Location to be the Shot's **effective Location**;
- a trigger on `shots` (`after update of location_id`, only when it really changed) deletes a selection of the old
  Location's view in the same statement. The memory repository mirrors it (`onShotSaved`).

**Effective Location** is what Prism uses everywhere else: the Shot's own `spatial.locationId`
(`shots.location_id`), which a new Shot copies from its Scene. ShotContext has no read-time Scene fallback, so neither
does this.

If an invalid pointer ever exists anyway (historical or out-of-band data), ShotContext resolves `selectedLocationView =
null` with `locationViewIssue`, the package never contains it, and preflight `set.location_view` **blocks** generation
with a data-integrity message. No view selected is never a blocker.

## Production truth and freshness

The selected view is part of the Shot's **location** part (`computeShotParts(ctx).location` adds the view's id,
fingerprint and image checksum while one is selected). So choosing none → A, A → B or A → none:

- stales the approved Storyboard ("Location / set changed") and the selected Production Frame;
- changes `provenance.parts.overall` (the Shot's production-input identity);
- stales Production Frame **candidates** generated before, through their frozen named parts.

A Shot without a selected view hashes exactly as before 2G.3 (no churn). Location Views themselves have **no**
fresh/stale state: each is exactly what was canonized at creation. Artifacts that _use_ a view become stale when the
Shot chooses another view or Location; the two ideas are kept separate.

The Production Frame intent snapshot (`prism.production-frame-intent.v1`) gains an optional `location.view` (identity
only); older snapshots stay valid and are never rewritten.

## Generation

**GenerationPackage v4** adds `references.locationView` (by value: view id, Location, name, kind, Asset id and checksum,
size, source, fingerprint, viewSpec), `provenance.sourceVersions.locationViewId`, and the view's Asset in
`package.assets` — only while a valid view is selected. v2 and v3 packages stay readable; nothing is backfilled. The
exact package fingerprint of an unchanged Shot differs between v3 and v4 (different frozen shapes); "has the Shot
changed?" keeps comparing `parts.overall`. See [generation-package](generation-package.md).

**PromptPlan.** The environment section states the view in words (`canonical Location View: "Doorway" (entrance)`,
viewpoint, zone, entrance, orientation, view camera / framing words, notes). It never describes the image pixel by pixel.

**Reference role `location_view`.** Never the generic `location` role. Production Frame candidate order:

1. selected Production Frame
2. approved Storyboard
3. Character identity
4. Character Look
5. **selected Location View** (`Canonical Location View "Doorway"`)
6. generic Location references
7. lighting reference
8. explicit Shot references

Deduplicated by Asset, under the most specific role: the Shot's own pictures (Production Frame, Storyboard) outrank the
view (a Production Frame saved as a view and selected again for the same Shot is sent **once**, as `production_frame`);
the view outranks identity / Look / Location / lighting / Shot references (sent once, as `location_view`). The video
path sends the view before generic Location references too.

**Limits.** If production truth needs more references than the model accepts, the candidate is **blocked**
(`references.too_many`): nothing is truncated, no attempt or job is created, no provider is called.

**Models that take no images.** The view's words stay in the PromptPlan, and the compatibility report says
"Location View image not supplied to this model ... NOT conditioned on the image". Prism never claims visual
conditioning that did not happen.

**Adapters.** Runway's GPT Image tags it `LocationView`; order-addressed models get "Reference image N is Canonical
Location View "Doorway"". Provider syntax stays inside the adapter.

**Frozen evidence.** The request's references record whether `location_view` was actually sent;
`candidateInputBasis(...).locationViewReference` reads it from the frozen request only, never from today's selection.
The candidate board lists each sent reference by its frozen label.

## Security

Owner-only RLS (`is_project_owner`); views have SELECT and INSERT policies only; selections one owner policy. A stranger
and anon see nothing. **Neither worker role has any privilege** on either table: the generation worker consumes the
frozen request (it reads the view's image only as one of an active attempt's `input_asset_ids`, like every input).
Images are shown only through the private asset route; no public bucket, no persisted signed URL. A view's Asset is a
project-safe foreign key (it cannot be deleted from under the view, and Asset usage lists it). Cross-project Assets,
Locations and views and cross-Location selections are refused by the database as well as the server.

## Tests

- `src/domain/__tests__/location-view.test.ts` — record, dedupe, spec, context, package v4, PromptPlan, freshness,
  input basis, save-as-view rule, reference order / dedupe / overflow / text-only, integrity, v2/v3 history, memory repo
- `src/generation/__tests__/location-view-flow.test.ts` — Shot A frame → "Doorway" → Shots B and C send the same image;
  same-Asset dedupe; overflow blocks with no attempt
- `src/server/__tests__/location-view-upload.test.ts` — upload cleanup
- `npm run db:location-views` — the relational contract on the real database (create, dedupe, concurrency,
  immutability, triggers, composite keys, CAS, cross-Location refusal, Location-change trigger, RLS, worker denial,
  cascades, package v4)
- `e2e/zzzzzzzzzzzzzzzzz-location-views.spec.ts` (memory) and `e2e/supabase-location-views.spec.ts` (Auth, RLS,
  Postgres, private Storage; MockProvider only)
