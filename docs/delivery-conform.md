# Delivery conform and asset lineage (Phase 2C)

## Principles

1. **The provider original is immutable.** A conform never replaces, edits or re-checksums it.
2. **Every derived file is a separate Asset** (`source = 'derived'`, `purpose = 'generation_output'`, so it never
   perturbs the package-input revision) with a lineage row pointing at its parent.
3. **Deterministic and versioned.** Same parent bytes + operation + parameters + processor ⇒ same derivation key,
   same asset id (idempotent). A different conform is a new version; old versions are kept.
4. **No NLE.** Only crop, pad (letterbox/pillarbox) and trim. No colour, no effects, no timeline.

## Schema (migration 0020)

- `asset_derivations`: `parent_asset_id`, `child_asset_id` (unique), `operation`
  (`crop|pad|trim|scale|conform|thumbnail|frame_extract|contact_sheet`), `derivation_key` (unique per project),
  `parameters`, `processor`, `processor_version`, `attempt_id`, `slot`, `version`. Append-only (trigger).
  The parent cannot be deleted while derivations exist (lineage is never orphaned).
- `attempt_deliveries`: at most **one selected delivery master per attempt** (PK `attempt_id`):
  `asset_id` (the master), `original_asset_id`, `conform` (plan + resolved parameters), `selected_by/at`.
  Selection is mutable; the files and lineage are not.
- `assets.source` gains `derived`.

## DeliveryConformPlan

`src/domain/framing/conform.ts`: `{ required, targetAspectRatio, framing: none|crop|letterbox|pillarbox,
trimToMs, steps }`, produced by the adaptation plan. `resolveConform(plan, probe)` turns intent into integer
pixel parameters against the real output and reports non-fatal warnings (e.g. the provider output is shorter than
the trim target: it is **not** extended).

## Flow (`src/media/delivery.ts`)

```
attempt succeeded (provider original ingested by the worker)
  → "Create delivery conform"  (app server)
  → read original (checksum verified) → probe → resolveConform
  → no-op?  original becomes the delivery master (no new file)
  → else    one ffmpeg pass → derived asset → lineage row → select as delivery master
```

`delivery master` may be the provider original (no conform needed, or chosen explicitly: "Use original as
delivery master"). Creative approval refers to the attempt; the delivery master is what continuity QA judges and
what downstream editing should use.

## Review frames and contact sheet

First / 25 % / 50 % / 75 % / last frame are extracted as derived PNG assets (`slot = frame:<ms>`) and tiled into
a contact sheet (`slot = contact_sheet`), per examined asset, idempotently. They feed the review UI, analyzers
and attempt comparison.

## Deletion and the library

Where-used for a derived asset shows "Derived from … by conform (ffmpeg, v1)". An asset that has derivatives, is
a selected delivery master or original, or was examined by a continuity review is **pinned**: deleting it is
refused with the reason (`MediaQaRepository.assetPins`). Dev cleanup (`db:generation:cleanup`) removes derived
assets and their stored files with the attempts that own them.

## Cost

Conform is local compute. No dollar cost is recorded or invented; if compute metering is ever added it will be
separate from generation cost.
