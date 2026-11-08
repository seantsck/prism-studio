# Phase 5B-I5: Location Visual Bible

> Location → **Visual Bible** → canonical appearance → recurring views → select a view for the Shot → the Shot
> automatically receives its Location references → Production Frame generation.

After I5 a Shot automatically receives **Character references** (5B-I4: canonical identity, then the selected Look)
**plus Location references** (selected Location View, then the canonical Location, then establishing views, plates and
relevant variants). A Shot can still add its own references.

No paid generation. Migration `0053` is repository and local only. Hosted DEV and the live site are unchanged.

## 1. Audit, and what is reused

| Concept            | Existing representation                                                         | I5 decision                                        |
| ------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| Location           | `locations` row: description, geography, zones, entrances, lighting, `locked`   | unchanged                                          |
| Location reference | `locations.reference_asset_ids uuid[]`: **no per-reference metadata**           | unchanged; still the loose references              |
| Location View      | `location_views` (0040): immutable, named, kind-tagged, selected per Shot       | **the** recurring camera view; not duplicated      |
| Location lock      | `locations.locked`; preflight requires it; reference edits refused while locked | Visual Bible changes are refused while locked too  |
| Shot ↔ Location    | `shots.location_id`; `shot_location_view_selections`                            | unchanged                                          |
| Package            | `set.referenceAssetIds`; `references.locationView` (v4)                         | `set.visualReferences` added, only when designated |
| Freshness          | the fingerprint's location part                                                 | includes what the Shot receives from the Bible     |
| Asset usage        | `location_ref`, `location_view`                                                 | `location_visual_bible` pins designations          |

Location references are a bare `uuid[]`, so they cannot say "this one is the canonical appearance" or "this one is the
night variant". A table would duplicate the reference list, and a Location View is a different thing (an immutable,
per-Shot-selected viewpoint). The smallest model is **one jsonb column on the Location row**:

```json
{
  "canonicalAssetId": "<asset>",
  "entries": [{ "assetId": "<asset>", "role": "establishing|plate|variant", "label": "night" }]
}
```

- **Canonical appearance**: ONE `canonicalAssetId` key, so a Location has at most one canonical appearance by
  construction. No unique index is needed.
- **Establishing views** (`establishing`), **background plates** (`plate`), and **variants** (`variant`): a variant's
  label is free text ("night", "rainy night", "event lighting", "crowded", "after the gala"). A suggestion list is
  offered; it is never a rigid enumeration. A variant stays part of the same Location.
- **Interior / exterior**: the label of an establishing view ("exterior wide"). Generate presets exist for both.
- A designation is a **pointer** to an existing image of this Location (one of its references, its Location View
  images, or its own generated images). Nothing is copied.

## 2. Migration 0053 (local only)

`0053_location_visual_bible.sql` adds `locations.visual_bible jsonb not null default '{}'`, plus one shape check: an
object, a string or null `canonicalAssetId`, and an array of `entries`. It is additive, changes no data and adds no
table. Existing rows read back as an empty Visual Bible.

Evidence:

- `src/data/__tests__/migration-0053.test.ts` (envelope; 0051 and 0052 unchanged);
- `scripts/db-location-visual-bible.mts` on the disposable database.

**Compatibility.** An absent Visual Bible is never written (`locationToRow`). Code without designations therefore keeps
working against a database without 0053; designating needs 0053.

## 3. Shot reference assembly

`deriveProductionFrameReferenceCandidates` and `deriveReferenceCandidates`, in priority order:

1. The selected Production Frame, then the approved Storyboard (unchanged).
2. **Characters (5B-I4)**: canonical identity → the selected Look → other identity images. A Character with a
   Continuity Lock sends only its frozen images, unchanged. I5 also applies this I4 order to Production Frame
   generation, which until now put every identity image before the Look.
3. **The selected Location View**, the highest-priority Location image.
4. **The Location Visual Bible**: canonical Location → establishing views → background plates → variants relevant to
   the Shot.
5. The other Location references, then lighting, then the Shot's own references (unchanged).

How a variant counts as relevant: every word of its label appears, as a stem ("rainy" ≈ "rain"), in the Shot's time of
day and weather, or in its Scene's time of day. A night Shot gets the night variant and never the golden-hour one. A
designated variant that is not relevant is also kept out of that Shot's generic Location references.

**Model limits.** The automatic Visual Bible Location images are supplements. Over the model's limit, the
lowest-priority supplements are left out first and disclosed as an ignored feature the creator acknowledges
(`references.location_visual_bible_limit`, which names each image left out). Every other reference keeps the existing
hard limit ("Reduce references in Shot Prep."), so nothing is dropped silently and no Shot that fitted before I5 is
blocked by it. The frozen request records exactly the references sent, with labels.

**Freshness.** The fingerprint's location part carries the Visual Bible references the Shot receives, plus its
effective Location references. A new canonical Location stales the Shots set there. A variant a Shot does not use, or
another Location's change, does not. A Location without designations keeps every fingerprint and package
byte-for-byte.

**Frozen references.** A recorded attempt's request never changes. A locked Location refuses Visual Bible changes. A
Character Continuity Lock still sends only its frozen images; the Location's images only follow it.

## 4. Deletion and usage

While designated, the canonical appearance, an establishing view, a plate or a variant is in use
(`location_visual_bible`, which affects the Shots set there). Removing the designation releases it, unless something
else still pins it (another designation, a Location reference, a Location View). Generation attempts remain
provenance, not usage.

## 5. UI

Each Location (Locations page) has a **Visual Bible** panel:

- the large canonical image and the Location name;
- readiness, e.g. "4 / 6 ready", with a ✓/○ checklist: canonical appearance, establishing view, Location View, reverse
  view, time-of-day / state variant, background plate. Guidance only;
- **Generate presets**, all on the existing pipeline: Canonical Appearance, Establishing View, Alternate Angle,
  Interior View, Exterior View, Background Plate, Time-of-Day Variant (a free label, e.g. "night");
- **Views**: the existing Location Views;
- **Use as Canonical** (replacing needs the explicit "Replace" checkbox), **Add to Visual Bible** (establishing, plate
  or variant, with a label), and **Remove**.

On each generated Location image:

- **Use as Canonical**;
- **Use as Location View**, which now needs an explicit view name (no default) and a view kind. It is still refused
  while the Location is locked; the same image and view never creates a duplicate or replaces an existing view;
- the existing **Use as Location Reference** and **Edit Image**.

Model details sit under **Advanced**.

## 6. Ojou-sama acceptance (memory, fixtures, free mock models)

`src/server/__tests__/location-visual-bible.test.ts` (14 tests) builds these fixtures:

| Location                        | Fixtures                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grand Celeste Exterior (Canopy) | canonical exterior; Location View "Canopy — arrival"; night establishing view                                                                     |
| Grand Celeste Lobby             | canonical lobby; views "entrance toward elevators" and "elevators toward entrance"; establishing "lobby wide"; variants "night" and "golden hour" |
| Sky-View Restaurant             | canonical; views "table toward skyline" and "skyline toward table"                                                                                |
| Hotel Hallway                   | canonical; views "elevator end" and "room-door end"                                                                                               |
| Tokyo Night Street              | canonical night street; establishing view                                                                                                         |

**Shot 3A** (Lobby, Night, Yumeko in her Black Satin Formal Look, the "entrance toward elevators" view selected)
automatically sends, in this order:

1. Yumeko's canonical identity;
2. Yumeko's Look reference;
3. the selected Lobby view;
4. the Lobby canonical appearance;
5. "lobby wide";
6. the night variant;
7. the other Lobby view as a generic reference.

It never sends the golden-hour variant or any other Location. The request records exactly these references.

At a 5-reference limit, the night variant and "lobby wide" are left out and named. At a 2-reference limit, the Shot is
refused (nothing is sent).

Also covered:

- canonical assignment, replacement confirmation and immutability;
- generation never replaces the canonical appearance;
- designations;
- refusals for a locked Location, another Location's image and another project's image;
- deletion pinning and release;
- Use as Location View naming, lock and dedupe;
- canonical-first references when generating Location images;
- freshness;
- frozen requests.

`src/domain/__tests__/location-visual-bible.test.ts` (5 pure tests) covers relevance, priority, byte-identical
packages, readiness, and Character Continuity Lock plus the Location Visual Bible. The rendered UI is in
`src/components/images/__tests__/merged-image-panels.test.ts`; browser story I covers the real app.
