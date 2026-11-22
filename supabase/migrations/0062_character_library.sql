-- 0062: the account's character library. A creator saves a Character to their library from the project it lives in;
-- "Add from library" in any other project of theirs copies it there (the Character, its identity references, Looks and
-- voice profiles, and a copy of every picture they use, in the target project's own storage). The library itself
-- holds only which Characters are saved: no copy, no storage of its own. A library entry goes when its Character (or
-- that Character's project) is deleted; archiving keeps it. Copies are independent: editing one never changes another.
-- Owner-only: a row is visible and writable only by the user who saved it, and only for a Character in a project
-- they own. Nothing existing changes. The app reads it defensively, so code that ships before this migration keeps
-- working (the library says it needs this migration until it is applied).

create table if not exists character_library (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  character_id  uuid not null references characters (id) on delete cascade,
  saved_at      timestamptz not null default now(),
  unique (user_id, character_id)
);
create index if not exists character_library_user_idx on character_library (user_id, saved_at desc);

alter table character_library enable row level security;
create policy character_library_owner on character_library for all to authenticated
  using (
    user_id = auth.uid()
    and exists (select 1 from characters c where c.id = character_id and is_project_owner(c.project_id))
  )
  with check (
    user_id = auth.uid()
    and exists (select 1 from characters c where c.id = character_id and is_project_owner(c.project_id))
  );
grant select, insert, delete on character_library to authenticated;
