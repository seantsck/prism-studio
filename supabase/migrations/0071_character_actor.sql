-- 0071: Actors and the Characters they play. An Actor is a person made on their own in the account's library project
-- (who they are and how they look: photos and views); a Character is a role in a story. A Character can be "played by"
-- an Actor: Prism copies the Actor's reference pictures into the Character's own project (a generation only ever reads
-- pictures of its own project), and new pictures of the Character are made from them, so every role an Actor plays has
-- the same face.
--
-- One nullable column: null = played by no Actor, so every existing row stays as it is. It may point at a Character in
-- another of the owner's projects (the library), so it is a plain reference with ON DELETE SET NULL: deleting the Actor
-- for good leaves the Character with the pictures already copied. No RLS change: the owner's existing policies on
-- characters cover it. The app writes the column only when a Character is linked to an Actor, so code that ships
-- before this migration keeps working (linking then says it needs this update).

alter table characters
  add column if not exists actor_id uuid references characters (id) on delete set null;
