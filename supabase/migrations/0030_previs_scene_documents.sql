-- 0030: Phase 2F M1 persistent 3D production set.
--
--   location_scene_documents   ONE current editable 3D scene per Location (prism.previs.v1 wrapper in scene_json)
--   shot_camera_bookmarks      the Shot's production camera, normalised, tied to a scene revision + fingerprint
--   scene_master_frames        locally rendered master frames + their scene provenance (asset = private Storage)
--
-- Authority: USER-domain tables. Owner-only RLS (is_project_owner). The generation and continuity workers get NO
-- grant, so a provider/worker can never write a set, a camera or a master frame. Forward-only; 0019-0029 untouched.
-- Nothing here stores a signed URL, blob URL or provider identifier: assets are referenced by Prism asset id.

-- composite-FK targets (a child can never point at another project's row)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'locations_id_project_key') then
    alter table locations add constraint locations_id_project_key unique (id, project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shots_id_project_key') then
    alter table shots add constraint shots_id_project_key unique (id, project_id);
  end if;
end $$;

create table location_scene_documents (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references projects (id) on delete cascade,
  location_id      uuid not null,
  engine           text not null check (engine = 'artcraft-derived'),
  engine_version   text not null default '',
  upstream_commit  text not null check (char_length(upstream_commit) >= 7),
  schema_version   text not null check (schema_version = 'prism.previs.v1'),
  -- increments by exactly one on every save; the application compares-and-sets on it
  revision         integer not null default 1 check (revision >= 1),
  scene_json       jsonb not null,
  scene_fingerprint text not null check (char_length(scene_fingerprint) = 64),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (id, project_id),
  -- one current editable scene per Location
  unique (location_id),
  foreign key (location_id, project_id) references locations (id, project_id) on delete cascade
);
create index location_scene_documents_project_idx on location_scene_documents (project_id);

create or replace function guard_location_scene_document() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id or new.location_id is distinct from old.location_id then
    raise exception 'a scene document cannot move between projects or locations';
  end if;
  if new.revision < old.revision then
    raise exception 'scene revision cannot decrease (% -> %)', old.revision, new.revision;
  end if;
  return new;
end;
$$;
create trigger location_scene_documents_guard before update on location_scene_documents
  for each row execute function guard_location_scene_document();
create trigger location_scene_documents_updated before update on location_scene_documents
  for each row execute function set_updated_at();

create table shot_camera_bookmarks (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references projects (id) on delete cascade,
  shot_id               uuid not null,
  location_id           uuid not null,
  scene_document_id     uuid not null,
  -- the scene state this camera was authored against
  scene_revision        integer not null check (scene_revision >= 1),
  scene_fingerprint     text not null check (char_length(scene_fingerprint) = 64),
  camera_label          text not null default '',
  position              jsonb not null,
  rotation              jsonb not null,
  target                jsonb not null,
  projection            text not null default 'perspective' check (projection = 'perspective'),
  fov_vertical_degrees  numeric(9, 4) not null check (fov_vertical_degrees > 0 and fov_vertical_degrees < 180),
  focal_length_mm       numeric(9, 3) not null check (focal_length_mm > 0),
  -- states how focal length relates to FOV (the engine's lens convention); never an assumed real sensor
  focal_length_basis    text not null check (focal_length_basis = 'vertical-sensor-24mm'),
  production_aspect_ratio text not null,
  production_aspect_value numeric(9, 5) not null check (production_aspect_value > 0),
  created_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (id, project_id),
  -- one current production camera per Shot
  unique (shot_id),
  foreign key (shot_id, project_id) references shots (id, project_id) on delete cascade,
  foreign key (location_id, project_id) references locations (id, project_id) on delete cascade,
  foreign key (scene_document_id, project_id) references location_scene_documents (id, project_id) on delete cascade
);
create index shot_camera_bookmarks_scene_idx on shot_camera_bookmarks (scene_document_id);
create trigger shot_camera_bookmarks_updated before update on shot_camera_bookmarks
  for each row execute function set_updated_at();

create table scene_master_frames (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references projects (id) on delete cascade,
  shot_id            uuid not null,
  location_id        uuid not null,
  scene_document_id  uuid not null,
  scene_revision     integer not null check (scene_revision >= 1),
  scene_fingerprint  text not null check (char_length(scene_fingerprint) = 64),
  camera_bookmark_id uuid,
  -- the rendered image lives in the private asset store; this row is its provenance
  asset_id           uuid not null,
  source             text not null default 'scene_render' check (source = 'scene_render'),
  render_width       integer not null check (render_width > 0),
  render_height      integer not null check (render_height > 0),
  production_aspect_ratio text not null,
  captured_at        timestamptz not null,
  -- set only by an explicit user "Use as Master Frame"; never automatic
  adopted_at         timestamptz,
  adopted_frame_id   uuid,
  created_by         uuid,
  created_at         timestamptz not null default now(),

  unique (id, project_id),
  foreign key (shot_id, project_id) references shots (id, project_id) on delete cascade,
  foreign key (location_id, project_id) references locations (id, project_id) on delete cascade,
  foreign key (scene_document_id, project_id) references location_scene_documents (id, project_id) on delete cascade,
  foreign key (camera_bookmark_id, project_id) references shot_camera_bookmarks (id, project_id) on delete set null (camera_bookmark_id),
  foreign key (asset_id, project_id) references assets (id, project_id),
  check (adopted_frame_id is null or adopted_at is not null)
);
create index scene_master_frames_shot_idx on scene_master_frames (shot_id, captured_at desc);

-- ───────────────────────── RLS: owner only ─────────────────────────

alter table location_scene_documents enable row level security;
alter table shot_camera_bookmarks enable row level security;
alter table scene_master_frames enable row level security;

create policy location_scene_documents_owner on location_scene_documents for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
create policy shot_camera_bookmarks_owner on shot_camera_bookmarks for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
create policy scene_master_frames_owner on scene_master_frames for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- NOTE: no GRANT to prism_generation_worker or prism_continuity_worker; db:previs asserts they have no privilege.
