-- Prism Studio — migration 0001: core entities
-- REVIEW ONLY. Not applied to any database. Targets Supabase (auth.users, storage) / PostgreSQL 15+.
--
-- Conventions
--   * UUID primary keys, created_at/updated_at timestamps (updated_at maintained by trigger).
--   * Every project-owned table carries project_id (denormalised) so RLS stays a single indexed check.
--   * Enumerations are text + CHECK so values can evolve without ALTER TYPE.
--   * JSONB only where the shape is genuinely flexible or provider-specific.

create extension if not exists "pgcrypto";

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ───────────────────────── projects ─────────────────────────

create table projects (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  title             text not null,
  slug              text not null,
  project_type      text not null default 'series' check (project_type in ('series', 'film', 'short')),
  description       text not null default '',
  genre             text not null default '',
  tone              text not null default '',
  default_language  text not null default 'en',
  production_status text not null default 'development'
    check (production_status in ('development', 'pre_production', 'production', 'post_production', 'complete')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, slug)
);
create index projects_user_idx on projects (user_id);
create trigger projects_updated before update on projects for each row execute function set_updated_at();

create table project_bibles (
  project_id                  uuid primary key references projects (id) on delete cascade,
  premise                     text not null default '',
  genre                       text not null default '',
  tone                        text not null default '',
  visual_style                text not null default '',
  cinematography_rules        text[] not null default '{}',
  color_language              text not null default '',
  aspect_ratio                text not null default '16:9',
  default_frame_rate          numeric(7, 3) not null default 24,
  dialogue_language_strategy  text not null default '',
  subtitle_strategy           text not null default '',
  audio_philosophy            text not null default '',
  canon_facts                 text[] not null default '{}',
  continuity_rules            text[] not null default '{}',
  guardrails                  text[] not null default '{}',   -- forbidden changes / generator guardrails
  updated_at                  timestamptz not null default now()
);
create trigger project_bibles_updated before update on project_bibles for each row execute function set_updated_at();

-- ───────────────────────── assets ─────────────────────────

create table assets (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects (id) on delete cascade,
  type          text not null check (type in ('image', 'video', 'audio', 'document', '3d', 'waveform', 'reference')),
  name          text not null,
  mime          text,
  storage_path  text,                    -- null = placeholder / not yet uploaded
  width         integer,
  height        integer,
  duration_ms   integer,
  checksum      text,
  source        text not null default 'upload'
    check (source in ('upload', 'generated', 'sketch', '3d_preview', 'recording', 'import', 'seed')),
  tags          text[] not null default '{}',
  metadata      jsonb not null default '{}'::jsonb,   -- waveform peaks, codec, etc.
  uploaded_at   timestamptz not null default now()
);
create index assets_project_idx on assets (project_id, type);
create index assets_checksum_idx on assets (checksum) where checksum is not null;

-- ───────────────────────── characters ─────────────────────────

create table characters (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references projects (id) on delete cascade,
  name                  text not null,
  role                  text not null default '',
  description           text not null default '',
  personality           text not null default '',
  behavior_notes        text not null default '',
  physical_description  text not null default '',
  continuity_rules      text[] not null default '{}',
  signature_behavior    text not null default '',
  relationship_notes    text not null default '',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index characters_project_idx on characters (project_id);
create trigger characters_updated before update on characters for each row execute function set_updated_at();

create table character_identity_refs (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references projects (id) on delete cascade,
  character_id  uuid not null references characters (id) on delete cascade,
  slot          text not null check (slot in ('front', 'three_quarter', 'profile', 'full_body', 'additional')),
  asset_id      uuid references assets (id) on delete set null,
  label         text not null default '',
  metadata      jsonb not null default '{}'::jsonb,
  locked        boolean not null default false
);
create index identity_refs_character_idx on character_identity_refs (character_id);
-- one primary reference per standard slot; "additional" may repeat
create unique index identity_refs_slot_uniq on character_identity_refs (character_id, slot) where slot <> 'additional';

-- episodes is referenced by looks, so it is created in 0002; looks.episode_id gets its FK there.
create table character_looks (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references projects (id) on delete cascade,
  character_id        uuid not null references characters (id) on delete cascade,
  episode_id          uuid,            -- FK added in 0002 (episodes)
  name                text not null,
  wardrobe            text not null default '',
  shoes               text not null default '',
  jewelry             text not null default '',
  hair                text not null default '',
  makeup              text not null default '',
  grooming            text not null default '',
  body_notes          text not null default '',
  accessories         text not null default '',
  reference_asset_ids uuid[] not null default '{}',
  locked              boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index looks_character_idx on character_looks (character_id);
create index looks_project_idx on character_looks (project_id);
create trigger looks_updated before update on character_looks for each row execute function set_updated_at();

create table voice_profiles (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects (id) on delete cascade,
  character_id         uuid not null references characters (id) on delete cascade,
  name                 text not null,
  language             text not null default 'en',
  locale               text not null default '',
  provider             text not null default 'unassigned',
  provider_voice_id    text,
  description          text not null default '',
  pitch_notes          text not null default '',
  timbre_notes         text not null default '',
  accent               text not null default '',
  speaking_style       text not null default '',
  emotional_range      text not null default '',
  pronunciation_rules  text[] not null default '{}',
  sample_asset_ids     uuid[] not null default '{}',
  locked               boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index voice_profiles_character_idx on voice_profiles (character_id);
create trigger voice_profiles_updated before update on voice_profiles for each row execute function set_updated_at();

-- ───────────────────────── locations / props ─────────────────────────

create table locations (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects (id) on delete cascade,
  name                 text not null,
  description          text not null default '',
  geography            text not null default '',
  zones                jsonb not null default '[]'::jsonb,       -- [{id,name,description}]
  entrances            jsonb not null default '[]'::jsonb,       -- [{id,name,description}]
  lighting             text not null default '',
  recurring_props      text[] not null default '{}',
  reference_asset_ids  uuid[] not null default '{}',
  locked               boolean not null default false,
  -- Reserved for the future 3D Set (Three.js / R3F). Nullable so 2D-only projects pay nothing.
  set3d_model_asset_id uuid references assets (id) on delete set null,
  set3d                jsonb,                                    -- {cameraRigs, blockingMarkers, lightRigs}
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index locations_project_idx on locations (project_id);
create trigger locations_updated before update on locations for each row execute function set_updated_at();

create table props (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects (id) on delete cascade,
  name                 text not null,
  description          text not null default '',
  reference_asset_ids  uuid[] not null default '{}',
  locked               boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index props_project_idx on props (project_id);
create trigger props_updated before update on props for each row execute function set_updated_at();
