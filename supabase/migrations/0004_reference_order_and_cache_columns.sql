-- 0004: deterministic reference-asset order; remove stale readiness cache columns.

-- A. Generation inputs are an ordered list; provider behaviour can depend on the sequence.
--    `position` is the 0-based index within (shot_id, role). Existing rows (none are expected to carry
--    meaningful order) are numbered deterministically by asset id so the unique index can be created.
alter table shot_reference_assets add column position integer;
update shot_reference_assets r
   set position = n.rn - 1
  from (
    select shot_id, asset_id, role,
           row_number() over (partition by shot_id, role order by asset_id) as rn
      from shot_reference_assets
  ) n
 where r.shot_id = n.shot_id and r.asset_id = n.asset_id and r.role = n.role;
alter table shot_reference_assets alter column position set not null;
alter table shot_reference_assets add constraint shot_reference_assets_position_nonneg check (position >= 0);
create unique index shot_reference_assets_order_uq on shot_reference_assets (shot_id, role, position);

-- B. Readiness is computed live from deterministic preflight (src/domain/preflight.ts). Cached
--    columns nothing maintains would silently go stale, so they are removed until there is a
--    deliberate cache strategy.
alter table shots drop column if exists prep_score;
alter table shots drop column if exists ready_to_generate;
