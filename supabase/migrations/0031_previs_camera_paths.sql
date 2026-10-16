-- 0031: Phase 2F M2A camera motion + local previs.
--
--   shot_camera_paths   ONE current editable production-camera path per Shot (prism.camera-path.v1 in path_json),
--                       tied to the scene revision + fingerprint it was authored against
--   shot_previs_clips   locally rendered previs videos + their camera-path / scene provenance
--                       (the video itself is a private asset in Storage; nothing here is a URL or a blob)
--
-- Authority: USER-domain tables, owner-only RLS (is_project_owner). The generation and continuity workers get NO
-- grant. Forward-only; 0019-0030 untouched. A scene change makes a path/clip STALE (computed by fingerprint
-- comparison); nothing is deleted or rewritten.

-- A locally rendered previs video is an Asset of its own kind of origin (extends the 0020 list; nothing removed).
alter table assets drop constraint assets_source_check;
alter table assets add constraint assets_source_check check (source in (
  'upload', 'generated', 'sketch', '3d_preview', 'recording', 'import', 'seed',
  'extracted', '3d_render', 'storyboard', 'provider_output', 'derived', 'local_previs'
));

create table shot_camera_paths (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects (id) on delete cascade,
  shot_id           uuid not null,
  location_id       uuid not null,
  scene_document_id uuid not null,
  -- the set state this motion was authored against
  scene_revision    integer not null check (scene_revision >= 1),
  scene_fingerprint text not null check (char_length(scene_fingerprint) = 64),
  schema_version    text not null check (schema_version = 'prism.camera-path.v1'),
  -- increments by exactly one per save; the application compares-and-sets on it
  revision          integer not null default 1 check (revision >= 1),
  duration_ms       integer not null check (duration_ms > 0),
  frame_rate        numeric(7, 3) not null check (frame_rate > 0 and frame_rate <= 120),
  path_json         jsonb not null,
  path_fingerprint  text not null check (char_length(path_fingerprint) = 64),
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (id, project_id),
  -- one current editable path per Shot
  unique (shot_id),
  foreign key (shot_id, project_id) references shots (id, project_id) on delete cascade,
  foreign key (location_id, project_id) references locations (id, project_id) on delete cascade,
  foreign key (scene_document_id, project_id) references location_scene_documents (id, project_id) on delete cascade
);
create index shot_camera_paths_scene_idx on shot_camera_paths (scene_document_id);

create or replace function guard_shot_camera_path() returns trigger
language plpgsql as $$
begin
  if new.project_id is distinct from old.project_id or new.shot_id is distinct from old.shot_id then
    raise exception 'a camera path cannot move between projects or shots';
  end if;
  if new.revision < old.revision then
    raise exception 'camera path revision cannot decrease (% -> %)', old.revision, new.revision;
  end if;
  return new;
end;
$$;
create trigger shot_camera_paths_guard before update on shot_camera_paths
  for each row execute function guard_shot_camera_path();
create trigger shot_camera_paths_updated before update on shot_camera_paths
  for each row execute function set_updated_at();

create table shot_previs_clips (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects (id) on delete cascade,
  shot_id           uuid not null,
  location_id       uuid not null,
  -- the path row may later be re-saved or removed; the clip keeps its own provenance by value
  camera_path_id    uuid,
  path_revision     integer not null check (path_revision >= 1),
  path_fingerprint  text not null check (char_length(path_fingerprint) = 64),
  scene_document_id uuid not null,
  scene_revision    integer not null check (scene_revision >= 1),
  scene_fingerprint text not null check (char_length(scene_fingerprint) = 64),
  -- the encoded video: a private Prism asset (never a URL)
  asset_id          uuid not null,
  source            text not null default 'local_previs' check (source = 'local_previs'),
  frame_rate        numeric(7, 3) not null check (frame_rate > 0),
  duration_ms       integer not null check (duration_ms > 0),
  render_width      integer not null check (render_width > 0),
  render_height     integer not null check (render_height > 0),
  container         text not null check (container in ('mp4', 'webm')),
  codec             text not null check (char_length(codec) between 1 and 32),
  has_audio         boolean not null default false,
  audio_asset_id    uuid,
  rendered_at       timestamptz not null,
  created_by        uuid,
  created_at        timestamptz not null default now(),

  unique (id, project_id),
  foreign key (shot_id, project_id) references shots (id, project_id) on delete cascade,
  foreign key (location_id, project_id) references locations (id, project_id) on delete cascade,
  foreign key (scene_document_id, project_id) references location_scene_documents (id, project_id) on delete cascade,
  foreign key (camera_path_id, project_id) references shot_camera_paths (id, project_id) on delete set null (camera_path_id),
  foreign key (asset_id, project_id) references assets (id, project_id),
  foreign key (audio_asset_id, project_id) references assets (id, project_id),
  check (has_audio = (audio_asset_id is not null))
);
create index shot_previs_clips_shot_idx on shot_previs_clips (shot_id, rendered_at desc);

-- ───────────────────────── RLS: owner only ─────────────────────────

alter table shot_camera_paths enable row level security;
alter table shot_previs_clips enable row level security;

create policy shot_camera_paths_owner on shot_camera_paths for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
create policy shot_previs_clips_owner on shot_previs_clips for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- NOTE: no GRANT to prism_generation_worker or prism_continuity_worker; db:previs asserts they have no privilege.
