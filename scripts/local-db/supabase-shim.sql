-- DISPOSABLE LOCAL POSTGRES ONLY (scripts/db-disposable.mjs). Never applied to Supabase.
--
-- The minimum of Supabase's platform schema that supabase/migrations reference, so the real migrations 0001..N can be
-- applied unchanged to a throwaway PostgreSQL and verified with the real db:* scripts before a hosted gate:
--   roles anon / authenticated / service_role, auth.users + auth.uid() (from request.jwt.claims, as PostgREST /
--   rlsPreamble set it), storage.buckets / storage.objects / storage.foldername, and Supabase's LEGACY default
--   privileges on new public tables (what hosted applied when 0001-0044 were created). A migration that must not rely
--   on default privileges (0045 onwards) revokes and grants explicitly, so this default does not hide a missing grant.

-- Roles are cluster-wide and survive the database drop of a reset, so they are created only once per cluster.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema auth;
create table auth.users (
  id         uuid primary key,
  email      text,
  created_at timestamptz not null default now()
);
create function auth.uid() returns uuid
language sql stable as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  owner              uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create table storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text,
  owner      uuid,
  metadata   jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.buckets to authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated, service_role;

-- Supabase's legacy default privileges on public (objects created by the migrating role).
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
