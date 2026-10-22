-- 0042: fix-forward for 0041 (applied, immutable): let a Project cascade delete pass through Character Continuity Lock
-- images.
--
-- `character_continuity_lock_assets (asset_id, project_id) → assets` is NO ACTION, and NO ACTION is checked per
-- statement. Deleting a Project cascades to its Assets on one path and to its Locks → Lock images on another (two levels
-- deep), and the Asset check could run before the Lock-image rows were removed:
--   update or delete on table "assets" violates foreign key constraint
--   "character_continuity_lock_assets_asset_id_project_id_fkey"
-- This is the same situation 0005 resolved for `shot_characters`. The fix is the same: the foreign key becomes
-- DEFERRABLE INITIALLY DEFERRED. A direct delete of an Asset that a Lock froze is still refused (at commit, or
-- immediately under SET CONSTRAINTS ... IMMEDIATE), while a Project / Character cascade removes the Lock images first.
-- Nothing else changes; 0001-0041 untouched.

alter table character_continuity_lock_assets
  drop constraint character_continuity_lock_assets_asset_id_project_id_fkey;
alter table character_continuity_lock_assets
  add constraint character_continuity_lock_assets_asset_id_project_id_fkey
  foreign key (asset_id, project_id) references assets (id, project_id)
  deferrable initially deferred;
