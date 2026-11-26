-- 0070: animated characters made from real ones. A Character can be drawn in an art style the creator writes ("anime",
-- "3D animated film", "soft watercolour") instead of as a photograph, and can take its likeness from another Character
-- of the same project (the real person whose photos show who it is). "Create animated character" on a Character's page
-- makes such a copy, so the real Character and its reference set are never changed.
--
-- Two nullable columns: null = drawn as before / no likeness source, so every existing row stays as it is.
-- likeness_from_id is ON DELETE SET NULL: deleting the real Character for good leaves the animated one with its own
-- pictures. No RLS change: the owner's existing policies on characters cover them. The app writes the columns only
-- when an animated Character is created or its style changed, so code that ships before this migration keeps working
-- (creating one then says it needs this update).

alter table characters add column if not exists art_style text;

alter table characters
  add column if not exists likeness_from_id uuid references characters (id) on delete set null;
