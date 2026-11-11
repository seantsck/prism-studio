-- 0052: Character Visual Bible invariants (Phase 5B-I4). Additive: two partial unique indexes, no data change.
--
-- A Visual Bible designation is an identity reference whose metadata.visualRole names its role (see
-- src/domain/visual-bible.ts). A Character has AT MOST ONE canonical identity and AT MOST ONE designated cutout; the
-- server action enforces this too, and these indexes close the concurrent-request gap. Expressions may repeat.
-- NOT applied to hosted DEV until the owner authorizes it (like 0051).

create unique index identity_refs_one_canonical
  on character_identity_refs (character_id)
  where metadata ->> 'visualRole' = 'canonical';

create unique index identity_refs_one_cutout
  on character_identity_refs (character_id)
  where metadata ->> 'visualRole' = 'cutout';
