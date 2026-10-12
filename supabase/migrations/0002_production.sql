-- Prism Studio — migration 0002: episodes, script, performance, shots, storyboard, generation, continuity
-- REVIEW ONLY. Not applied to any database.

-- ───────────────────────── episodes / scenes ─────────────────────────

create table episodes (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects (id) on delete cascade,
  number       integer not null check (number > 0),
  slug         text not null,
  title        text not null,
  synopsis     text not null default '',
  script_text  text not null default '',
  "order"      integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (project_id, number),
  unique (project_id, slug)
);
create trigger episodes_updated before update on episodes for each row execute function set_updated_at();

alter table character_looks
  add constraint character_looks_episode_fk foreign key (episode_id) references episodes (id) on delete set null;

create table scenes (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects (id) on delete cascade,
  episode_id        uuid not null references episodes (id) on delete cascade,
  scene_number      text not null,
  slugline          text not null,
  int_ext           text not null check (int_ext in ('INT', 'EXT', 'INT/EXT')),
  location_id       uuid references locations (id) on delete set null,
  time_of_day       text not null default '',
  summary           text not null default '',
  dramatic_purpose  text not null default '',
  emotion_entering  text not null default '',
  emotion_leaving   text not null default '',
  script_start_line integer,
  script_end_line   integer,
  continuity_notes  text not null default '',
  "order"           integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index scenes_episode_idx on scenes (episode_id, "order");
create trigger scenes_updated before update on scenes for each row execute function set_updated_at();

create table scene_characters (
  scene_id      uuid not null references scenes (id) on delete cascade,
  character_id  uuid not null references characters (id) on delete cascade,
  primary key (scene_id, character_id)
);
create table scene_props (
  scene_id  uuid not null references scenes (id) on delete cascade,
  prop_id   uuid not null references props (id) on delete cascade,
  primary key (scene_id, prop_id)
);

-- ───────────────────────── dialogue & performance ─────────────────────────

create table dialogue_lines (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references projects (id) on delete cascade,
  episode_id          uuid not null references episodes (id) on delete cascade,
  scene_id            uuid not null references scenes (id) on delete cascade,
  character_id        uuid references characters (id) on delete set null,
  speaker_label       text not null default '',          -- cue for non-principal speakers
  original_text       text not null,
  language            text not null default 'en',
  translation         text,
  pronunciation_notes text not null default '',
  dramatic_context    text not null default '',
  subtext             text not null default '',
  locked              boolean not null default false,    -- approved dialogue
  "order"             integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index dialogue_scene_idx on dialogue_lines (scene_id, "order");
create index dialogue_episode_idx on dialogue_lines (episode_id);
create trigger dialogue_updated before update on dialogue_lines for each row execute function set_updated_at();

-- Locked dialogue text may not be changed in place; unlock first (guards AI revision / script sync).
create or replace function guard_locked_dialogue() returns trigger
language plpgsql as $$
begin
  if old.locked and new.locked and new.original_text is distinct from old.original_text then
    raise exception 'dialogue line % is locked; unlock before changing text', old.id;
  end if;
  return new;
end;
$$;
create trigger dialogue_locked_guard before update on dialogue_lines for each row execute function guard_locked_dialogue();

create table performance_directions (
  id                        uuid primary key default gen_random_uuid(),
  project_id                uuid not null references projects (id) on delete cascade,
  dialogue_line_id          uuid not null unique references dialogue_lines (id) on delete cascade,
  emotion                   text not null default '',
  objective                 text not null default '',
  subtext                   text not null default '',
  intensity                 smallint not null default 40 check (intensity between 0 and 100),
  pace                      text not null default 'natural' check (pace in ('very_slow', 'slow', 'natural', 'fast', 'very_fast')),
  volume                    text not null default 'normal' check (volume in ('whisper', 'quiet', 'normal', 'loud', 'shout')),
  pauses                    text not null default '',
  breaths                   text not null default '',
  emphasis_notes            text not null default '',
  physical_behavior_notes   text not null default '',
  updated_at                timestamptz not null default now()
);
create trigger directions_updated before update on performance_directions for each row execute function set_updated_at();

create table performance_takes (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects (id) on delete cascade,
  dialogue_line_id  uuid not null references dialogue_lines (id) on delete cascade,
  character_id      uuid references characters (id) on delete set null,
  voice_profile_id  uuid references voice_profiles (id) on delete set null,
  source_type       text not null check (source_type in ('human_recording', 'generated_voice', 'temp_voice')),
  audio_asset_id    uuid references assets (id) on delete set null,
  duration_ms       integer not null check (duration_ms > 0),
  waveform          jsonb,                                 -- peaks array when available
  transcript        text not null default '',
  take_number       integer not null check (take_number > 0),
  notes             text not null default '',
  rating            smallint not null default 0 check (rating between 0 and 5),
  selected          boolean not null default false,
  created_at        timestamptz not null default now(),
  unique (dialogue_line_id, take_number)
);
create index takes_line_idx on performance_takes (dialogue_line_id);
-- Exactly one canonical (selected) take per dialogue line.
create unique index takes_one_selected_per_line on performance_takes (dialogue_line_id) where selected;

-- ───────────────────────── shots ─────────────────────────
-- Core columns are first-class; each production *section* is JSONB because sections are edited
-- as a unit, validated by Zod at the app boundary, and evolve faster than first-class entities.
-- Cross-entity references (characters, looks, dialogue, props, previous shot) are normalised tables.

create table shots (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references projects (id) on delete cascade,
  episode_id          uuid not null references episodes (id) on delete cascade,
  scene_id            uuid not null references scenes (id) on delete cascade,
  shot_code           text not null,
  title               text not null,
  story_beat          text not null default '',
  dramatic_purpose    text not null default '',
  "order"             integer not null default 0,
  status              text not null default 'draft'
    check (status in ('draft', 'prepping', 'ready', 'generating', 'review', 'approved', 'locked')),
  target_duration_ms  integer check (target_duration_ms >= 0),
  duration_mode       text not null default 'manual' check (duration_mode in ('manual', 'derived_from_performance')),

  location_id         uuid references locations (id) on delete set null,
  previous_shot_id    uuid references shots (id) on delete set null,   -- next shot is derived from order

  composition         jsonb not null default '{}'::jsonb,   -- framing, size, lens, movement, …
  spatial             jsonb not null default '{}'::jsonb,   -- set zone, blocking, marks, eyelines, …
  continuity          jsonb not null default '{}'::jsonb,   -- weather, vehicle orientation, count, …
  action              jsonb not null default '{}'::jsonb,   -- beats, beginning/ending pose
  audio               jsonb not null default '{}'::jsonb,   -- pre/post roll, ambience, foley, music
  lighting            jsonb not null default '{}'::jsonb,
  constraints         jsonb not null default '{}'::jsonb,   -- hard / negative / forbidden
  generation          jsonb not null default '{}'::jsonb,   -- modality, provider, model, refs, fps

  approval_storyboard  boolean not null default false,
  approval_performance boolean not null default false,
  approval_continuity  boolean not null default false,
  -- Cached output of the deterministic preflight; ready_to_generate is derived, never user-set.
  prep_score           smallint check (prep_score between 0 and 100),
  ready_to_generate    boolean not null default false,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (episode_id, shot_code)
);
create index shots_scene_idx on shots (scene_id, "order");
create index shots_episode_idx on shots (episode_id);
create index shots_location_idx on shots (location_id);
create trigger shots_updated before update on shots for each row execute function set_updated_at();

create table shot_characters (
  shot_id               uuid not null references shots (id) on delete cascade,
  character_id          uuid not null references characters (id) on delete restrict,
  look_id               uuid references character_looks (id) on delete restrict,  -- shots reference Looks, never copy wardrobe
  performance_notes     text not null default '',
  expression            text not null default '',
  posture               text not null default '',
  gestures              text not null default '',
  physical_interactions text not null default '',
  position              integer not null default 0,
  primary key (shot_id, character_id)
);
create index shot_characters_look_idx on shot_characters (look_id);

create table shot_props (
  shot_id  uuid not null references shots (id) on delete cascade,
  prop_id  uuid not null references props (id) on delete cascade,
  primary key (shot_id, prop_id)
);

create table shot_dialogue_lines (
  shot_id           uuid not null references shots (id) on delete cascade,
  dialogue_line_id  uuid not null references dialogue_lines (id) on delete cascade,
  position          integer not null default 0,
  primary key (shot_id, dialogue_line_id)
);

create table shot_reference_assets (
  shot_id   uuid not null references shots (id) on delete cascade,
  asset_id  uuid not null references assets (id) on delete cascade,
  role      text not null default 'reference'
    check (role in ('reference', 'start_frame', 'end_frame', 'reference_video', 'reference_audio', 'lighting_reference')),
  primary key (shot_id, asset_id, role)
);

-- ───────────────────────── storyboard ─────────────────────────

create table storyboard_frames (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  shot_id     uuid not null references shots (id) on delete cascade,
  asset_id    uuid references assets (id) on delete set null,
  version     integer not null check (version > 0),
  source      text not null check (source in ('upload', 'generated', '3d_preview', 'sketch')),
  notes       text not null default '',
  approved    boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (shot_id, version)
);
create index frames_shot_idx on storyboard_frames (shot_id);
-- At most one approved frame per shot.
create unique index frames_one_approved_per_shot on storyboard_frames (shot_id) where approved;

-- ───────────────────────── generation (append-only history) ─────────────────────────

create table generation_attempts (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects (id) on delete cascade,
  shot_id           uuid not null references shots (id) on delete cascade,
  attempt_number    integer not null check (attempt_number > 0),
  provider          text not null,
  model             text not null,
  modality          text not null check (modality in ('video', 'image', 'image_to_video', 'audio')),
  prompt            text not null default '',
  negative_prompt   text not null default '',
  package_snapshot  jsonb not null,                       -- frozen GenerationPackage
  model_settings    jsonb not null default '{}'::jsonb,
  input_asset_ids   uuid[] not null default '{}',
  output_asset_id   uuid references assets (id) on delete set null,
  cost_usd          numeric(10, 4) check (cost_usd >= 0),
  duration_ms       integer,
  status            text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'rejected', 'approved')),
  rejection_reason  text not null default '',
  notes             text not null default '',
  approved          boolean not null default false,
  created_at        timestamptz not null default now(),
  unique (shot_id, attempt_number)
);
create index attempts_shot_idx on generation_attempts (shot_id, attempt_number);
create unique index attempts_one_approved_per_shot on generation_attempts (shot_id) where approved;

-- History is immutable: only review fields may change after insert.
create or replace function guard_attempt_history() returns trigger
language plpgsql as $$
begin
  if new.prompt is distinct from old.prompt
     or new.negative_prompt is distinct from old.negative_prompt
     or new.package_snapshot is distinct from old.package_snapshot
     or new.model_settings is distinct from old.model_settings
     or new.input_asset_ids is distinct from old.input_asset_ids
     or new.shot_id is distinct from old.shot_id
     or new.attempt_number is distinct from old.attempt_number then
    raise exception 'generation attempt % is append-only; only review fields may change', old.id;
  end if;
  return new;
end;
$$;
create trigger attempts_history_guard before update on generation_attempts for each row execute function guard_attempt_history();

-- ───────────────────────── continuity ─────────────────────────

create table continuity_checks (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects (id) on delete cascade,
  shot_id        uuid not null references shots (id) on delete cascade,
  attempt_id     uuid references generation_attempts (id) on delete set null,
  kind           text not null default 'manual' check (kind in ('manual', 'automated')),
  overall_score  numeric(5, 2) check (overall_score between 0 and 100),
  -- per-dimension 0–100: characterIdentity, wardrobe, hair, makeup, jewelry, set, props,
  -- lighting, geography, actionContinuity, characterCount
  scores         jsonb not null default '{}'::jsonb,
  issues         jsonb not null default '[]'::jsonb,   -- [{dimension, severity, description}]
  reviewer       text not null default '',
  created_at     timestamptz not null default now()
);
create index continuity_shot_idx on continuity_checks (shot_id, created_at desc);
