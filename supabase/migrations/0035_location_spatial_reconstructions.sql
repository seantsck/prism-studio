-- 0035: Phase 2F M2D.1 Gaussian-splat Location core: reconstruction provenance.
--
--   location_spatial_reconstructions   ONE immutable record per spatial reconstruction that belongs to a LOCATION:
--                               which private result Asset it produced (a Gaussian splat), what method produced it
--                               ('imported' for M2D.1; provider/model methods arrive later), which reference-image
--                               Assets it was built from, the calibration the SOURCE claimed on arrival, and a
--                               content fingerprint. It is origin truth: it never changes when the splat is later
--                               moved, rotated or scaled in a 3D Set. PLACEMENT and CALIBRATION are mutable
--                               scene-object state (the Set document), not this row.
--   assets                      + purpose 'spatial_reconstruction' (type stays '3d': a splat is a 3D asset).
--                               The private bucket also accepts the three Gaussian-splat MIME types.
--
-- The source image ids are a JSON array of {assetId, checksum}. They are NOT foreign keys, so the server verifies
-- that every source belongs to the same Project before the write (and the result Asset is a real project-safe FK).
-- Authority: USER-domain table, owner-only RLS (is_project_owner). The generation and continuity workers get NO
-- grant. Forward-only; 0019-0034 untouched.

-- ───────────────────────── asset taxonomy ─────────────────────────

alter table assets drop constraint assets_purpose_check;
alter table assets add constraint assets_purpose_check check (purpose in (
  'identity_ref', 'look_ref', 'location_ref', 'prop_ref', 'storyboard', 'performance_audio',
  'reference_audio', 'generation_input', 'generation_output', 'video_reference', 'document',
  'waveform', 'model_3d', 'other', 'spatial_control', 'spatial_reconstruction'
));

-- the private bucket must accept the Gaussian-splat MIME types (still private, still owner-only policies)
update storage.buckets
   set allowed_mime_types = (
     select array_agg(distinct m)
       from unnest(coalesce(allowed_mime_types, array[]::text[]) || array[
         'application/x-gaussian-splat',
         'application/x-spz',
         'application/x-ply'
       ]) as m
   )
 where id = 'prism-assets';

-- ───────────────────────── reconstructions ─────────────────────────

create table location_spatial_reconstructions (
  id                      uuid primary key default gen_random_uuid(),
  project_id              uuid not null references projects (id) on delete cascade,
  location_id             uuid not null,
  schema_version          text not null check (schema_version = 'prism.spatial-reconstruction.v1'),
  method                  text not null check (method in ('imported')),
  result_kind             text not null check (result_kind in ('gaussian_splat')),
  result_asset_id         uuid not null,
  result_checksum         text,
  result_format           text not null check (result_format in ('splat', 'spz', 'ply')),
  gaussian_count          integer check (gaussian_count is null or gaussian_count > 0),
  -- reference images this was reconstructed from: [{ "assetId": uuid, "checksum": text|null }] (may be empty)
  source_assets_json      jsonb not null default '[]'::jsonb check (jsonb_typeof(source_assets_json) = 'array'),
  -- the calibration the SOURCE claimed on arrival (units unknown for an import); the placement is scene state
  calibration_json        jsonb not null check (jsonb_typeof(calibration_json) = 'object'),
  reconstruction_fingerprint text not null check (char_length(reconstruction_fingerprint) = 64),
  created_by              uuid,
  created_at              timestamptz not null default now(),

  unique (id, project_id),
  unique (location_id, reconstruction_fingerprint),
  foreign key (location_id, project_id) references locations (id, project_id) on delete cascade,
  -- the result is a real project-safe asset; an Asset a reconstruction depends on cannot be deleted from under it
  foreign key (result_asset_id, project_id) references assets (id, project_id)
);
create index location_spatial_reconstructions_location_idx
  on location_spatial_reconstructions (location_id, created_at desc);

-- origin truth: no update in place, ever
create or replace function guard_location_spatial_reconstruction() returns trigger
language plpgsql as $$
begin
  raise exception 'a spatial reconstruction is immutable provenance';
end;
$$;
create trigger location_spatial_reconstructions_guard before update on location_spatial_reconstructions
  for each row execute function guard_location_spatial_reconstruction();

-- ───────────────────────── RLS: owner only ─────────────────────────

alter table location_spatial_reconstructions enable row level security;
create policy location_spatial_reconstructions_owner on location_spatial_reconstructions for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- NOTE: no GRANT to prism_generation_worker or prism_continuity_worker; db:reconstructions asserts they have no privilege.
