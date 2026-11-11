-- 0053: Location Visual Bible (Phase 5B-I5). Additive: one jsonb column with a shape check, no data change.
--
-- Location references are a bare uuid[] with no per-reference metadata, so the Visual Bible needs somewhere to say
-- which image is the canonical appearance and which are establishing views, background plates or variants (see
-- src/domain/location-visual-bible.ts). It lives on the Location row itself:
--   {"canonicalAssetId": "<uuid>" | null, "entries": [{"assetId", "role", "label"}]}
-- ONE canonicalAssetId key, so a Location has at most one canonical appearance by construction. Recurring camera views
-- stay the existing Location Views (0040); nothing here duplicates them. No new table.
-- NOT applied to hosted DEV until the owner authorizes it (like 0051 and 0052).

alter table locations
  add column visual_bible jsonb not null default '{}'::jsonb;

alter table locations
  add constraint locations_visual_bible_shape check (
    jsonb_typeof(visual_bible) = 'object'
    and jsonb_typeof(coalesce(visual_bible -> 'canonicalAssetId', 'null'::jsonb)) in ('string', 'null')
    and jsonb_typeof(coalesce(visual_bible -> 'entries', '[]'::jsonb)) = 'array'
  );
