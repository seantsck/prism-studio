-- 0005: ON DELETE RESTRICT is checked immediately, and even NO ACTION is checked per statement, so
-- deleting a project failed: the cascade reached characters/looks before the shot_characters rows that
-- reference them were removed. Make these two FKs DEFERRABLE INITIALLY DEFERRED: a direct delete of a
-- Look/character that a shot uses is still rejected (at commit, or immediately under
-- SET CONSTRAINTS ... IMMEDIATE), while a project cascade removes the referencing rows first.
alter table shot_characters drop constraint shot_characters_character_id_fkey;
alter table shot_characters add constraint shot_characters_character_id_fkey
  foreign key (character_id) references characters (id) on delete no action
  deferrable initially deferred;
alter table shot_characters drop constraint shot_characters_look_id_fkey;
alter table shot_characters add constraint shot_characters_look_id_fkey
  foreign key (look_id) references character_looks (id) on delete no action
  deferrable initially deferred;
