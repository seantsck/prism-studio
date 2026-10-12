-- 0006: Asset becomes a first-class production object.
-- Forward-only: 0001-0005 are never edited. Existing rows are carried over:
--   uploaded_at  -> created_at
--   storage_path -> object_path (storage_provider 'local' when a path exists, otherwise 'none')

alter table assets rename column uploaded_at to created_at;
alter table assets rename column storage_path to object_path;

alter table assets add column updated_at        timestamptz not null default now();
alter table assets add column created_by        uuid references auth.users (id) on delete set null;
alter table assets add column purpose           text not null default 'other';
alter table assets add column original_filename text not null default '';
alter table assets add column storage_provider  text not null default 'none';
alter table assets add column bucket            text;
alter table assets add column byte_size         bigint;
alter table assets add column frame_rate        numeric(8, 3);
alter table assets add column sample_rate       integer;
alter table assets add column channels          smallint;
alter table assets add column notes             text not null default '';

alter table assets add constraint assets_purpose_check check (purpose in (
  'identity_ref', 'look_ref', 'location_ref', 'prop_ref', 'storyboard', 'performance_audio',
  'reference_audio', 'generation_input', 'generation_output', 'video_reference', 'document',
  'waveform', 'model_3d', 'other'
));
alter table assets add constraint assets_storage_provider_check
  check (storage_provider in ('none', 'local', 'supabase'));
alter table assets add constraint assets_byte_size_check check (byte_size is null or byte_size >= 0);
alter table assets add constraint assets_supabase_location_check
  check (storage_provider <> 'supabase' or (bucket is not null and object_path is not null));

alter table assets drop constraint assets_source_check;
alter table assets add constraint assets_source_check check (source in (
  'upload', 'generated', 'sketch', '3d_preview', 'recording', 'import', 'seed',
  'extracted', '3d_render', 'storyboard', 'provider_output'
));

-- Backfill from what the rows already say.
update assets set storage_provider = 'local' where object_path is not null;
update assets set original_filename = regexp_replace(object_path, '^.*/', '') where object_path is not null;
update assets set purpose = case
  when type = 'audio' then 'performance_audio'
  when type = 'waveform' then 'waveform'
  when type = '3d' then 'model_3d'
  when type = 'document' then 'document'
  when type = 'video' then 'video_reference'
  when 'storyboard' = any (tags) then 'storyboard'
  else 'other' end;

create index assets_purpose_idx on assets (project_id, purpose);
create unique index assets_object_uq on assets (bucket, object_path) where object_path is not null and bucket is not null;
create trigger assets_updated before update on assets for each row execute function set_updated_at();
