-- 0039: Phase 2G.1 PRODUCTION FRAME core (GPU-optional, image-first filmmaking).
--
--   shot_production_frames             IMMUTABLE history: one row per Production Frame ever made for a Shot. A Production
--                                      Frame is the canonical approved still of a Shot that Prism carries into
--                                      image-to-video and continuity. It REFERENCES a private image Asset (a promoted
--                                      Storyboard / 3D Master Frame reuses its existing Asset; an upload creates a new
--                                      'production_frame' Asset) and freezes, BY VALUE, what it was made to represent:
--                                      the visual-intent snapshot, its fingerprint and the Shot's named-part
--                                      fingerprints. Origin, image, size, version and snapshot never change.
--   shot_production_frame_selections   ONE mutable pointer per Shot: which frame is canonical. Changing it moves only
--                                      this row; no historical frame is touched.
--   assets                             + purpose 'production_frame' (type stays 'image').
--
-- Nothing here requires a 3D set, a reconstruction, a GPU or any provider: a 3D Master Frame is only one possible
-- SOURCE. 'generation_output' is accepted now so Phase 2G.2 (image generation) needs no redesign, but 2G.1 has no
-- action that creates one.
--
-- The three source ids are NOT foreign keys (like the source ids of 0035): the server verifies the source belongs to
-- the same Project and Shot before the write, and a historical Production Frame must stay interpretable even if a
-- storyboard or previs row it came from is later removed. The Asset IS a real project-safe foreign key, so an image a
-- Production Frame depends on cannot be deleted from under it.
--
-- Authority: USER-domain tables, owner-only RLS (is_project_owner). The frames table has INSERT and SELECT policies
-- only (no UPDATE or DELETE policy: history is append-only for users; cascades from the Shot/Project still work).
-- The generation and continuity workers get NO grant. Forward-only; 0001-0038 untouched.

-- ───────────────────────── asset taxonomy ─────────────────────────

alter table assets drop constraint assets_purpose_check;
alter table assets add constraint assets_purpose_check check (purpose in (
  'identity_ref', 'look_ref', 'location_ref', 'prop_ref', 'storyboard', 'performance_audio',
  'reference_audio', 'generation_input', 'generation_output', 'video_reference', 'document',
  'waveform', 'model_3d', 'other', 'spatial_control', 'spatial_reconstruction', 'production_frame'
));

-- ───────────────────────── production frames (immutable history) ─────────────────────────

create table shot_production_frames (
  id                          uuid primary key default gen_random_uuid(),
  project_id                  uuid not null references projects (id) on delete cascade,
  shot_id                     uuid not null,
  -- 1, 2, 3 ... per Shot; assigned inside the creating transaction under a lock on the Shot
  version                     integer not null check (version > 0),
  schema_version              text not null check (schema_version = 'prism.production-frame.v1'),
  asset_id                    uuid not null,
  -- frozen from the Asset at creation (a trigger below checks them against the Asset)
  asset_checksum              text not null check (asset_checksum ~ '^[0-9a-f]{64}$'),
  width                       integer not null check (width > 0),
  height                      integer not null check (height > 0),
  production_aspect_ratio     text not null check (char_length(production_aspect_ratio) > 0),
  source                      text not null check (source in ('upload', 'storyboard', 'previs_master', 'generation_output')),
  source_storyboard_frame_id  uuid,
  source_master_frame_id      uuid,
  source_generation_attempt_id uuid,
  -- prism.production-frame-intent.v1: what this frame was approved to represent, copied by value
  intent_snapshot             jsonb not null check (jsonb_typeof(intent_snapshot) = 'object'),
  intent_fingerprint          text not null check (intent_fingerprint ~ '^[0-9a-f]{64}$'),
  -- the Shot's named-part fingerprints at creation (freshness compares against the current ones)
  parts                       jsonb not null check (jsonb_typeof(parts) = 'object'),
  -- deterministic identity of this artifact (shot, source, image checksum, size, aspect, intent): the duplicate key
  frame_fingerprint           text not null check (frame_fingerprint ~ '^[0-9a-f]{64}$'),
  created_by                  uuid,
  created_at                  timestamptz not null default now(),

  unique (id, project_id),
  -- the composite key the selection pointer references: a selection can only name a frame of ITS OWN Shot and Project
  unique (id, shot_id, project_id),
  unique (shot_id, version),
  unique (shot_id, frame_fingerprint),
  foreign key (shot_id, project_id) references shots (id, project_id) on delete cascade,
  foreign key (asset_id, project_id) references assets (id, project_id),
  -- each origin carries exactly its own source id
  check (
    (source = 'upload'
       and source_storyboard_frame_id is null and source_master_frame_id is null and source_generation_attempt_id is null)
    or (source = 'storyboard'
       and source_storyboard_frame_id is not null and source_master_frame_id is null and source_generation_attempt_id is null)
    or (source = 'previs_master'
       and source_storyboard_frame_id is null and source_master_frame_id is not null and source_generation_attempt_id is null)
    or (source = 'generation_output'
       and source_storyboard_frame_id is null and source_master_frame_id is null and source_generation_attempt_id is not null)
  )
);
create index shot_production_frames_shot_idx on shot_production_frames (shot_id, version desc);

-- history, never rewritten: no update in place, by anyone (the table owner included)
create or replace function guard_shot_production_frame() returns trigger
language plpgsql as $$
begin
  raise exception 'a Production Frame is immutable history';
end;
$$;
create trigger shot_production_frames_guard before update on shot_production_frames
  for each row execute function guard_shot_production_frame();

-- the frozen image facts must be the Asset's own: a real image of this project, with this checksum and size
create or replace function check_shot_production_frame_asset() returns trigger
language plpgsql as $$
declare
  a assets%rowtype;
begin
  select * into a from assets where id = new.asset_id and project_id = new.project_id;
  if not found then
    raise exception 'the Production Frame image does not exist in this project';
  end if;
  if a.type <> 'image' then
    raise exception 'a Production Frame must be an image';
  end if;
  if a.object_path is null then
    raise exception 'the Production Frame image has no stored file';
  end if;
  if a.checksum is distinct from new.asset_checksum
     or a.width is distinct from new.width
     or a.height is distinct from new.height then
    raise exception 'the Production Frame facts do not match its image';
  end if;
  return new;
end;
$$;
create trigger shot_production_frames_asset_check before insert on shot_production_frames
  for each row execute function check_shot_production_frame_asset();

-- ───────────────────────── selection (one mutable pointer per Shot) ─────────────────────────

create table shot_production_frame_selections (
  shot_id             uuid primary key,
  project_id          uuid not null references projects (id) on delete cascade,
  production_frame_id uuid not null,
  selected_by         uuid,
  selected_at         timestamptz not null default now(),

  foreign key (shot_id, project_id) references shots (id, project_id) on delete cascade,
  -- same Shot AND same Project as the selection row: enforced here, not only in the UI
  foreign key (production_frame_id, shot_id, project_id)
    references shot_production_frames (id, shot_id, project_id)
);

-- ───────────────────────── RLS: owner only ─────────────────────────

alter table shot_production_frames enable row level security;
alter table shot_production_frame_selections enable row level security;

-- history is readable and appendable by the project owner; there is deliberately no update or delete policy
create policy shot_production_frames_select on shot_production_frames for select to authenticated
  using (is_project_owner(project_id));
create policy shot_production_frames_insert on shot_production_frames for insert to authenticated
  with check (is_project_owner(project_id));
create policy shot_production_frame_selections_owner on shot_production_frame_selections for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- NOTE: no GRANT to prism_generation_worker or prism_continuity_worker; db:production-frames asserts they have no privilege.
