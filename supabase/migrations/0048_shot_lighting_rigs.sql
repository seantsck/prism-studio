-- 0048: Shot Lighting Rigs and render-history guards (Phase 4B).
--
--   shot_light_rigs       one CURRENT prism.shot-lighting.v1 rig per Shot. An overlay on the Location's set: it adds nothing
--                         to location_scene_documents or to the scene fingerprint, and it never writes authored text.
--   scene_master_frames   + lighting_fingerprint, lighting_json: what the render was lit by (prism.render-lighting.v1).
--   shot_previs_clips     + the same pair. On both, null/null means "no Shot Lighting Rig was recorded for this render".
--                         Nothing is backfilled: no lighting truth is invented for an existing render.
--
-- Provenance guards. Before this migration, "render history is never rewritten" was true of the application but not
-- enforced by the database. The guards below are deny-by-default: every column, including any column added later, is
-- immutable except the ones named here. Audited writers (Phase 4B):
--   scene_master_frames   adoptMasterFrame sets adopted_at and adopted_frame_id (semantics unchanged);
--                         deleting a bookmark nulls camera_bookmark_id (FK ON DELETE SET NULL).
--   shot_previs_clips     deleting a camera path nulls camera_path_id (FK ON DELETE SET NULL). No application UPDATE.
-- A pointer may only go to null: naming a different bookmark or path is refused. DELETE and cascades stay allowed.
--
-- Security: owner-only RLS. No SECURITY DEFINER. anon and both worker roles hold no privilege on shot_light_rigs; no worker
-- needs Shot lighting truth. Forward-only; 0001-0047 untouched. 3D stays optional: nothing here is required of a Shot.

-- ───────────────────────── a scene document names its Location ─────────────────────────

-- lets the rig's foreign key prove its scene document belongs to its Location, not merely to its Project
alter table location_scene_documents
  add constraint location_scene_documents_id_project_location_key unique (id, project_id, location_id);

-- ───────────────────────── shot_light_rigs ─────────────────────────

create table shot_light_rigs (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects (id) on delete cascade,
  shot_id              uuid not null,
  location_id          uuid not null,
  scene_document_id    uuid not null,
  -- the set state this rig was authored against (changes only on an explicit save)
  scene_revision       integer not null check (scene_revision >= 1),
  scene_fingerprint    text not null check (char_length(scene_fingerprint) = 64),
  schema_version       text not null check (schema_version = 'prism.shot-lighting.v1'),
  -- increments by exactly one per save; the application compares-and-sets on it
  revision             integer not null default 1 check (revision >= 1),
  rig_json             jsonb not null,
  lighting_fingerprint text not null check (char_length(lighting_fingerprint) = 64),
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (id, project_id),
  -- one current rig per Shot
  unique (shot_id),
  foreign key (shot_id, project_id) references shots (id, project_id) on delete cascade,
  foreign key (location_id, project_id) references locations (id, project_id) on delete cascade,
  foreign key (scene_document_id, project_id, location_id)
    references location_scene_documents (id, project_id, location_id) on delete cascade,
  -- coalesce: a CHECK passes on NULL, and a missing JSON key reads as NULL
  constraint shot_light_rigs_shape check (coalesce(
    jsonb_typeof(rig_json) = 'object'
    and rig_json ->> 'schema' = schema_version
    and rig_json #>> '{base,mode}' in ('engine_default', 'replace')
    and jsonb_typeof(rig_json -> 'authoredIntent') = 'object'
    and case when jsonb_typeof(rig_json -> 'lights') = 'array'
             then jsonb_array_length(rig_json -> 'lights') <= 16
             else false end,
    false))
);
create index shot_light_rigs_project_idx on shot_light_rigs (project_id, shot_id);
create index shot_light_rigs_scene_idx on shot_light_rigs (scene_document_id);
create index shot_light_rigs_location_idx on shot_light_rigs (location_id);

create or replace function guard_shot_light_rig() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id
     or new.shot_id is distinct from old.shot_id
     or new.location_id is distinct from old.location_id
     or new.scene_document_id is distinct from old.scene_document_id then
    raise exception 'a lighting rig cannot move between projects, shots, locations or sets';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'a lighting rig revision must increase by exactly one';
  end if;
  return new;
end;
$$;
create trigger shot_light_rigs_guard before update on shot_light_rigs
  for each row execute function guard_shot_light_rig();
create trigger shot_light_rigs_set_updated_at before update on shot_light_rigs
  for each row execute function set_updated_at();

alter table shot_light_rigs enable row level security;
create policy shot_light_rigs_owner on shot_light_rigs for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

revoke all on shot_light_rigs from public, anon;
grant select, insert, update, delete on shot_light_rigs to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'prism_generation_worker') then
    revoke all on shot_light_rigs from prism_generation_worker;
  end if;
  if exists (select 1 from pg_roles where rolname = 'prism_continuity_worker') then
    revoke all on shot_light_rigs from prism_continuity_worker;
  end if;
end;
$$;

-- ───────────────────────── render lighting provenance ─────────────────────────

alter table scene_master_frames add column lighting_fingerprint text;
alter table scene_master_frames add column lighting_json jsonb;
alter table scene_master_frames add constraint scene_master_frames_lighting_check check (
  (lighting_fingerprint is null and lighting_json is null)
  or coalesce(char_length(lighting_fingerprint) = 64
      and lighting_json ->> 'schema' = 'prism.render-lighting.v1'
      and lighting_json ->> 'rigFingerprint' = lighting_fingerprint, false)
);

alter table shot_previs_clips add column lighting_fingerprint text;
alter table shot_previs_clips add column lighting_json jsonb;
alter table shot_previs_clips add constraint shot_previs_clips_lighting_check check (
  (lighting_fingerprint is null and lighting_json is null)
  or coalesce(char_length(lighting_fingerprint) = 64
      and lighting_json ->> 'schema' = 'prism.render-lighting.v1'
      and lighting_json ->> 'rigFingerprint' = lighting_fingerprint, false)
);

-- ───────────────────────── provenance guards ─────────────────────────

create or replace function guard_scene_master_frame_provenance() returns trigger
language plpgsql as $$
begin
  if new.camera_bookmark_id is distinct from old.camera_bookmark_id and new.camera_bookmark_id is not null then
    raise exception 'a master frame cannot be pointed at a different camera bookmark';
  end if;
  if (to_jsonb(new) - array['adopted_at', 'adopted_frame_id', 'camera_bookmark_id'])
     is distinct from (to_jsonb(old) - array['adopted_at', 'adopted_frame_id', 'camera_bookmark_id']) then
    raise exception 'master frame provenance is immutable';
  end if;
  return new;
end;
$$;
create trigger scene_master_frames_provenance_guard before update on scene_master_frames
  for each row execute function guard_scene_master_frame_provenance();

create or replace function guard_shot_previs_clip_provenance() returns trigger
language plpgsql as $$
begin
  if new.camera_path_id is distinct from old.camera_path_id and new.camera_path_id is not null then
    raise exception 'a previs clip cannot be pointed at a different camera path';
  end if;
  if (to_jsonb(new) - 'camera_path_id') is distinct from (to_jsonb(old) - 'camera_path_id') then
    raise exception 'previs clip provenance is immutable';
  end if;
  return new;
end;
$$;
create trigger shot_previs_clips_provenance_guard before update on shot_previs_clips
  for each row execute function guard_shot_previs_clip_provenance();
