-- 0034: Phase 2F M2C spatial control passes (depth + object ids + Character masks).
--
--   shot_spatial_pass_bundles   ONE immutable historical capture per exact control frame: the Shot, the saved Set
--                               state, the rendered blocking, an EXPLICIT production-camera source (a camera-path
--                               time or the Production Camera bookmark, camera BY VALUE), the production frame size,
--                               and the private machine assets it produced:
--                                 depth         prism.depth-f32.v1        linear view-space depth in metres
--                                 object ids    prism.object-id-u32.v1    bundle-local manifest index per pixel
--                                 masks         prism.character-mask-u8.v1  one exact mask per visible Character
--                               (the masks live in character_masks_json, keyed by Character id; nothing here is a
--                               URL or a blob).
--   assets                      + type 'data' and purpose 'spatial_control' so machine rasters are never labelled
--                               as images; the private bucket accepts their application/x-prism-* MIME types.
--
-- Bundles are historical truth: no update in place (the only permitted change is a deleted camera path
-- nulling camera_path_id by the foreign-key action). STALE SCENE / CAMERA / BLOCKING is computed by fingerprint
-- comparison; nothing is deleted or rewritten. Audio never stales a bundle (the passes contain none).
-- Authority: USER-domain table, owner-only RLS (is_project_owner). The generation and continuity workers get NO
-- grant. Forward-only; 0019-0033 untouched.

-- ───────────────────────── truthful asset taxonomy for machine data ─────────────────────────

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'assets'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%''image''%'
       and pg_get_constraintdef(oid) ilike '%''waveform''%'
       and pg_get_constraintdef(oid) ilike '%type%'
       and pg_get_constraintdef(oid) not ilike '%purpose%'
  loop
    execute format('alter table assets drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table assets add constraint assets_type_check check (type in (
  'image', 'video', 'audio', 'document', '3d', 'waveform', 'reference', 'data'
));

alter table assets drop constraint assets_purpose_check;
alter table assets add constraint assets_purpose_check check (purpose in (
  'identity_ref', 'look_ref', 'location_ref', 'prop_ref', 'storyboard', 'performance_audio',
  'reference_audio', 'generation_input', 'generation_output', 'video_reference', 'document',
  'waveform', 'model_3d', 'other', 'spatial_control'
));

-- the private bucket must accept the machine-data MIME types (still private, still owner-only policies)
update storage.buckets
   set allowed_mime_types = (
     select array_agg(distinct m)
       from unnest(coalesce(allowed_mime_types, array[]::text[]) || array[
         'application/x-prism-depth-f32',
         'application/x-prism-object-id-u32',
         'application/x-prism-character-mask-u8'
       ]) as m
   )
 where id = 'prism-assets';

-- ───────────────────────── bundles ─────────────────────────

create table shot_spatial_pass_bundles (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references projects (id) on delete cascade,
  shot_id               uuid not null,
  location_id           uuid not null,
  scene_document_id     uuid not null,
  -- the saved set state the passes were rendered from
  scene_revision        integer not null check (scene_revision >= 1),
  scene_fingerprint     text not null check (char_length(scene_fingerprint) = 64),
  -- identity of the rendered blocking layer (null = no visible character proxies)
  blocking_fingerprint  text check (blocking_fingerprint is null or char_length(blocking_fingerprint) = 64),
  -- the explicit camera source and the camera BY VALUE (never the navigation camera)
  camera_source         text not null check (camera_source in ('camera_path', 'bookmark')),
  camera_json           jsonb not null check (jsonb_typeof(camera_json) = 'object'),
  camera_path_id        uuid,
  camera_path_revision  integer check (camera_path_revision is null or camera_path_revision >= 1),
  camera_path_fingerprint text check (camera_path_fingerprint is null or char_length(camera_path_fingerprint) = 64),
  time_ms               integer check (time_ms is null or time_ms >= 0),
  schema_version        text not null check (schema_version = 'prism.spatial-pass-bundle.v1'),
  bundle_fingerprint    text not null check (char_length(bundle_fingerprint) = 64),
  width                 integer not null check (width > 0),
  height                integer not null check (height > 0),
  -- canonical machine assets: private, never URLs
  depth_asset_id        uuid not null,
  depth_encoding        text not null check (depth_encoding = 'prism.depth-f32.v1'),
  depth_metadata_json   jsonb not null check (depth_metadata_json ->> 'schema' = depth_encoding),
  object_id_asset_id    uuid not null,
  object_id_encoding    text not null check (object_id_encoding = 'prism.object-id-u32.v1'),
  object_manifest_json  jsonb not null check (object_manifest_json ->> 'schema' = 'prism.object-id-manifest.v1'),
  character_masks_json  jsonb not null check (character_masks_json ->> 'schema' = 'prism.character-masks.v1'),
  created_by            uuid,
  created_at            timestamptz not null default now(),

  unique (id, project_id),
  -- the same exact control frame is captured once (rendering is deterministic)
  unique (shot_id, bundle_fingerprint),
  foreign key (shot_id, project_id) references shots (id, project_id) on delete cascade,
  foreign key (location_id, project_id) references locations (id, project_id) on delete cascade,
  foreign key (scene_document_id, project_id) references location_scene_documents (id, project_id) on delete cascade,
  foreign key (camera_path_id, project_id) references shot_camera_paths (id, project_id) on delete set null (camera_path_id),
  foreign key (depth_asset_id, project_id) references assets (id, project_id),
  foreign key (object_id_asset_id, project_id) references assets (id, project_id),
  -- a camera-path source records the path identity + time; a bookmark source records none of them
  check (
    (camera_source = 'camera_path') = (camera_path_fingerprint is not null and camera_path_revision is not null and time_ms is not null)
  ),
  check (camera_source = 'camera_path' or (camera_path_id is null and time_ms is null))
);
create index shot_spatial_pass_bundles_shot_idx on shot_spatial_pass_bundles (shot_id, created_at desc);
create index shot_spatial_pass_bundles_scene_idx on shot_spatial_pass_bundles (scene_document_id);

-- historical truth: the only change ever allowed is the foreign-key action nulling a deleted camera path's id
create or replace function guard_shot_spatial_pass_bundle() returns trigger
language plpgsql as $$
begin
  if (to_jsonb(new) - 'camera_path_id') is distinct from (to_jsonb(old) - 'camera_path_id')
     or (new.camera_path_id is not null and new.camera_path_id is distinct from old.camera_path_id) then
    raise exception 'a spatial pass bundle is immutable historical truth';
  end if;
  return new;
end;
$$;
create trigger shot_spatial_pass_bundles_guard before update on shot_spatial_pass_bundles
  for each row execute function guard_shot_spatial_pass_bundle();

-- ───────────────────────── RLS: owner only ─────────────────────────

alter table shot_spatial_pass_bundles enable row level security;
create policy shot_spatial_pass_bundles_owner on shot_spatial_pass_bundles for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- NOTE: no GRANT to prism_generation_worker or prism_continuity_worker; db:spatial-passes asserts they have no privilege.
