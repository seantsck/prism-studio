-- 0020: derived media lineage and delivery masters (Phase 2C).
--
--   Provider output is IMMUTABLE: a crop/trim/thumbnail is always a NEW Asset that points back at its parent.
--
--   asset_derivations   child asset -> parent asset + the deterministic operation that produced it
--   attempt_deliveries  at most one selected delivery master per generation attempt (the original stays the
--                       provider_original; a delivery master may be that same asset when no conform is needed)

alter table assets drop constraint assets_source_check;
alter table assets add constraint assets_source_check check (source in (
  'upload', 'generated', 'sketch', '3d_preview', 'recording', 'import', 'seed',
  'extracted', '3d_render', 'storyboard', 'provider_output', 'derived'
));

create table asset_derivations (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references projects (id) on delete cascade,
  parent_asset_id    uuid not null,
  child_asset_id     uuid not null,
  operation          text not null check (operation in (
    'crop', 'pad', 'trim', 'scale', 'conform', 'thumbnail', 'frame_extract', 'contact_sheet'
  )),
  -- sha256 over parent checksum + operation + normalized parameters + processor version: the idempotency key
  derivation_key     text not null check (char_length(derivation_key) >= 16),
  parameters         jsonb not null default '{}'::jsonb,
  processor          text not null,
  processor_version  text not null,
  -- the generation attempt this derivation was made for (NULL for derivations of ordinary assets)
  attempt_id         uuid,
  -- what part of an attempt this is ("delivery", "frame:25", "contact_sheet"); versions count per slot
  slot               text not null default '',
  version            integer not null default 1 check (version >= 1),
  created_by         uuid,
  created_at         timestamptz not null default now(),

  foreign key (parent_asset_id, project_id) references assets (id, project_id),
  foreign key (child_asset_id, project_id) references assets (id, project_id) on delete cascade,
  foreign key (attempt_id, project_id) references generation_attempts (id, project_id) on delete cascade,
  check (parent_asset_id <> child_asset_id),
  unique (child_asset_id),
  unique (project_id, derivation_key)
);
create unique index asset_derivations_attempt_slot_version
  on asset_derivations (attempt_id, operation, slot, version) where attempt_id is not null;
create index asset_derivations_parent_idx on asset_derivations (parent_asset_id);
create index asset_derivations_attempt_idx on asset_derivations (attempt_id) where attempt_id is not null;
create index asset_derivations_project_idx on asset_derivations (project_id);

-- A derivation is a fact about how a file was made: append-only.
create or replace function guard_asset_derivation() returns trigger
language plpgsql as $$
begin
  raise exception 'asset derivation % is append-only', old.id;
end;
$$;
create trigger asset_derivations_guard before update on asset_derivations
  for each row execute function guard_asset_derivation();

create table attempt_deliveries (
  attempt_id         uuid primary key,
  project_id         uuid not null references projects (id) on delete cascade,
  -- the selected delivery master (a derived conform, or the provider original itself)
  asset_id           uuid not null,
  -- the provider original primary output at selection time (kept for the original/delivery toggle)
  original_asset_id  uuid not null,
  -- the DeliveryConformPlan + resolved parameters that produced asset_id (NULL when the original is the master)
  conform            jsonb,
  selected_by        uuid,
  selected_at        timestamptz not null default now(),

  foreign key (attempt_id, project_id) references generation_attempts (id, project_id) on delete cascade,
  foreign key (asset_id, project_id) references assets (id, project_id),
  foreign key (original_asset_id, project_id) references assets (id, project_id)
);
create index attempt_deliveries_project_idx on attempt_deliveries (project_id);
create index attempt_deliveries_asset_idx on attempt_deliveries (asset_id);

alter table asset_derivations enable row level security;
create policy asset_derivations_owner on asset_derivations for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

alter table attempt_deliveries enable row level security;
create policy attempt_deliveries_owner on attempt_deliveries for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));
