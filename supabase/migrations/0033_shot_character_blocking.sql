-- 0033: Phase 2F M2B shot-specific character blocking (rigged proxy placement + pose).
--
--   shot_character_blocking   ONE current blocking state per (Shot, Character): the neutral rigged proxy's root
--                             placement (position / orientation / uniform scale) and its skeletal pose
--                             (prism.pose.v1 on prism.humanoid-rig.v1), tied to the Set revision + fingerprint it
--                             was authored against. A proxy carries NO identity (face, hair, wardrobe, likeness):
--                             that stays in the Character's Prism references.
--   scene_master_frames, shot_previs_clips
--                             + blocking_fingerprint / blocking_json: which blocking each render actually showed
--                             (provenance by value: character id, blocking id, revision, fingerprint; never a URL)
--
-- Blocking belongs to the SHOT, not the Location's persistent set: the same Location can have different blocking in
-- Shot 3A and Shot 3B. Authority: USER-domain table, owner-only RLS (is_project_owner). The generation and
-- continuity workers get NO grant. Forward-only; 0019-0032 untouched. A Set change makes blocking STALE (computed
-- by fingerprint comparison); nothing is deleted or rewritten.

-- characters had no composite key; project-safe foreign keys need one (additive, same shape as shots/locations)
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'characters'::regclass and contype = 'u'
       and pg_get_constraintdef(oid) = 'UNIQUE (id, project_id)'
  ) then
    alter table characters add constraint characters_id_project_key unique (id, project_id);
  end if;
end;
$$;

create table shot_character_blocking (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references projects (id) on delete cascade,
  shot_id              uuid not null,
  character_id         uuid not null,
  location_id          uuid not null,
  scene_document_id    uuid not null,
  -- the set state this blocking was authored against (changes only by an explicit re-anchor or a save)
  scene_revision       integer not null check (scene_revision >= 1),
  scene_fingerprint    text not null check (char_length(scene_fingerprint) = 64),
  schema_version       text not null check (schema_version = 'prism.shot-blocking.v1'),
  rig_version          text not null check (rig_version = 'prism.humanoid-rig.v1'),
  -- increments by exactly one per save; the application compares-and-sets on it
  revision             integer not null default 1 check (revision >= 1),
  -- root blocking: {x,y,z}, quaternion {x,y,z,w}, uniform scale relative to the 1.70 m reference figure
  root_position        jsonb not null check (jsonb_typeof(root_position) = 'object'),
  root_orientation     jsonb not null check (jsonb_typeof(root_orientation) = 'object'),
  root_scale           numeric(9, 5) not null check (root_scale > 0 and root_scale <= 5),
  -- prism.pose.v1: only joints that differ from neutral, quaternions authoritative
  pose_json            jsonb not null check (pose_json ->> 'schema' = 'prism.pose.v1'),
  visible              boolean not null default true,
  pose_fingerprint     text not null check (char_length(pose_fingerprint) = 64),
  blocking_fingerprint text not null check (char_length(blocking_fingerprint) = 64),
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (id, project_id),
  -- one current blocking state per Character per Shot
  unique (shot_id, character_id),
  foreign key (shot_id, project_id) references shots (id, project_id) on delete cascade,
  foreign key (character_id, project_id) references characters (id, project_id) on delete cascade,
  foreign key (location_id, project_id) references locations (id, project_id) on delete cascade,
  foreign key (scene_document_id, project_id) references location_scene_documents (id, project_id) on delete cascade,
  check (pose_json ->> 'rig' = rig_version)
);
create index shot_character_blocking_scene_idx on shot_character_blocking (scene_document_id);
create index shot_character_blocking_project_idx on shot_character_blocking (project_id, shot_id);

create or replace function guard_shot_character_blocking() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id
     or new.shot_id is distinct from old.shot_id
     or new.character_id is distinct from old.character_id then
    raise exception 'blocking cannot move between projects, shots or characters';
  end if;
  if new.revision < old.revision then
    raise exception 'blocking revision cannot decrease (% -> %)', old.revision, new.revision;
  end if;
  return new;
end;
$$;
create trigger shot_character_blocking_guard before update on shot_character_blocking
  for each row execute function guard_shot_character_blocking();
create trigger shot_character_blocking_updated before update on shot_character_blocking
  for each row execute function set_updated_at();

-- renders record which blocking they showed (null = no character proxies in the picture, as before M2B)
alter table scene_master_frames add column blocking_fingerprint text;
alter table scene_master_frames add column blocking_json jsonb;
alter table scene_master_frames add constraint scene_master_frames_blocking_check check (
  (blocking_fingerprint is null) = (blocking_json is null)
  and (blocking_fingerprint is null or char_length(blocking_fingerprint) = 64)
);

alter table shot_previs_clips add column blocking_fingerprint text;
alter table shot_previs_clips add column blocking_json jsonb;
alter table shot_previs_clips add constraint shot_previs_clips_blocking_check check (
  (blocking_fingerprint is null) = (blocking_json is null)
  and (blocking_fingerprint is null or char_length(blocking_fingerprint) = 64)
);

-- ───────────────────────── RLS: owner only ─────────────────────────

alter table shot_character_blocking enable row level security;
create policy shot_character_blocking_owner on shot_character_blocking for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- NOTE: no GRANT to prism_generation_worker or prism_continuity_worker; db:previs asserts they have no privilege.
