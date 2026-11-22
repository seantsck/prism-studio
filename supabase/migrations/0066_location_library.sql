-- 0066: the account's location library, the twin of the character library (0062). A creator saves a Location to it
-- from the project it lives in (or makes one on its own, in their `library` project from 0065); "Add from library" in
-- any other project of theirs copies it there (the Location and a copy of every picture it uses, in the target
-- project's own storage). The library holds only which Locations are saved. An entry goes when its Location (or that
-- Location's project) is deleted. Owner-only: a row is visible and writable only by the user who saved it, and only
-- for a Location in a project they own. Nothing existing changes. The app reads it defensively: until this is
-- applied, the location library says it needs this migration and nothing else changes.

create table if not exists location_library (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  location_id  uuid not null references locations (id) on delete cascade,
  saved_at     timestamptz not null default now(),
  unique (user_id, location_id)
);
create index if not exists location_library_user_idx on location_library (user_id, saved_at desc);

alter table location_library enable row level security;
create policy location_library_owner on location_library for all to authenticated
  using (
    user_id = auth.uid()
    and exists (select 1 from locations l where l.id = location_id and is_project_owner(l.project_id))
  )
  with check (
    user_id = auth.uid()
    and exists (select 1 from locations l where l.id = location_id and is_project_owner(l.project_id))
  );
grant select, insert, delete on location_library to authenticated;
