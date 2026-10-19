-- 0036: Phase 2F M2D.2 reconstruction jobs: reference images -> provider operation -> Prism reconstruction.
--
--   reconstruction_jobs        ONE row per ATTEMPT of a reconstruction request for a Location: the ordered source
--                              images frozen BY VALUE (asset id, checksum, mime, size, ordinal), the provider /
--                              capability / model / requested result kind / options, the job fingerprint, Prism's
--                              job status (separate from the provider's operation status), the provider operation id
--                              (assigned once, never replaced) and sanitised bounded provider metadata. A retry is a
--                              NEW row (attempt + 1, previous_job_id); a finished row never changes again.
--   reconstruction_job_events  append-only, secret-free history of a job (created, submitted, progress, ...).
--   location_spatial_reconstructions
--                              + method 'generated' with job / provider / model / operation provenance. A generated
--                              reconstruction is the SAME immutable record an import produces (M2D.1); exactly one
--                              per job (unique job_id) so two racing pollers can never ingest twice.
--
-- Nothing here stores a provider URL, an upload grant, an API key or a raw provider response.
-- Authority: USER-domain tables, owner-only RLS (is_project_owner). The provider is polled by the Prism server in the
-- user's own request; the generation and continuity workers get NO grant. Forward-only; 0019-0035 untouched.

-- ───────────────────────── jobs ─────────────────────────

create table reconstruction_jobs (
  id                      uuid primary key default gen_random_uuid(),
  project_id              uuid not null references projects (id) on delete cascade,
  location_id             uuid not null,
  schema_version          text not null check (schema_version = 'prism.reconstruction-job.v1'),
  job_fingerprint         text not null check (char_length(job_fingerprint) = 64),
  attempt                 integer not null check (attempt >= 1),
  previous_job_id         uuid,
  provider                text not null check (provider in ('worldlabs_marble', 'meshy', 'mock_reconstruction')),
  provider_capability     text not null check (char_length(provider_capability) between 1 and 64),
  provider_model          text check (provider_model is null or char_length(provider_model) <= 64),
  requested_result_kind   text not null check (requested_result_kind in ('gaussian_splat', 'mesh')),
  -- [{ordinal, assetId, checksum, mime, width, height, byteSize}], in the user's order (never sorted)
  source_assets_json      jsonb not null check (jsonb_typeof(source_assets_json) = 'array'
                                                and jsonb_array_length(source_assets_json) between 1 and 8),
  options_json            jsonb not null check (jsonb_typeof(options_json) = 'object'),
  status                  text not null check (status in
                            ('draft', 'queued', 'submitting', 'running', 'ingesting', 'succeeded', 'failed', 'cancelled')),
  progress                real check (progress is null or (progress >= 0 and progress <= 1)),
  revision                integer not null default 1 check (revision >= 1),
  provider_operation_id   text check (provider_operation_id is null or char_length(provider_operation_id) <= 200),
  provider_operation_json jsonb check (provider_operation_json is null or
                                       (jsonb_typeof(provider_operation_json) = 'object'
                                        and octet_length(provider_operation_json::text) <= 8192)),
  provider_inputs_json    jsonb check (provider_inputs_json is null or jsonb_typeof(provider_inputs_json) = 'array'),
  provider_result_json    jsonb check (provider_result_json is null or
                                       (jsonb_typeof(provider_result_json) = 'object'
                                        and octet_length(provider_result_json::text) <= 8192)),
  result_reconstruction_id uuid unique,
  error_code              text check (error_code is null or error_code in (
                            'not_configured', 'capability_unavailable', 'spend_blocked', 'invalid_sources',
                            'submit_failed', 'submit_ambiguous', 'provider_failed', 'provider_timeout',
                            'result_missing', 'result_too_large', 'result_invalid', 'ingest_failed', 'cancelled')),
  error_message           text check (error_message is null or char_length(error_message) <= 500),
  last_polled_at          timestamptz,
  created_by              uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  completed_at            timestamptz,

  unique (id, project_id),
  -- one row per attempt of the same request
  unique (project_id, job_fingerprint, attempt),
  foreign key (location_id, project_id) references locations (id, project_id) on delete cascade,
  foreign key (previous_job_id, project_id) references reconstruction_jobs (id, project_id) on delete set null (previous_job_id),
  -- state invariants
  check ((status = 'succeeded') = (result_reconstruction_id is not null)),
  check (status <> 'failed' or error_code is not null),
  check ((status in ('succeeded', 'failed', 'cancelled')) = (completed_at is not null)),
  check (status not in ('running', 'ingesting', 'succeeded') or provider_operation_id is not null)
);
create index reconstruction_jobs_location_idx on reconstruction_jobs (location_id, created_at desc);

-- The transition matrix, the immutability of everything that identifies a job, and of finished jobs.
create or replace function guard_reconstruction_job() returns trigger
language plpgsql as $$
declare allowed text[];
begin
  if old.status in ('succeeded', 'failed', 'cancelled') then
    raise exception 'a finished reconstruction job is immutable history';
  end if;
  if new.id is distinct from old.id or new.project_id is distinct from old.project_id
     or new.location_id is distinct from old.location_id or new.schema_version is distinct from old.schema_version
     or new.job_fingerprint is distinct from old.job_fingerprint or new.attempt is distinct from old.attempt
     or new.previous_job_id is distinct from old.previous_job_id or new.provider is distinct from old.provider
     or new.provider_capability is distinct from old.provider_capability
     or new.provider_model is distinct from old.provider_model
     or new.requested_result_kind is distinct from old.requested_result_kind
     or new.source_assets_json is distinct from old.source_assets_json
     or new.options_json is distinct from old.options_json
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'a reconstruction job''s request is frozen at creation';
  end if;
  if old.provider_operation_id is not null and new.provider_operation_id is distinct from old.provider_operation_id then
    raise exception 'a provider operation id is never replaced (retry creates a new attempt)';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'reconstruction job revision must advance by exactly one';
  end if;
  allowed := case old.status
    when 'draft' then array['queued', 'cancelled']
    when 'queued' then array['submitting', 'failed', 'cancelled']
    when 'submitting' then array['running', 'failed']
    when 'running' then array['running', 'ingesting', 'failed', 'cancelled']
    when 'ingesting' then array['succeeded', 'failed']
    else array[]::text[]
  end;
  if new.status <> old.status and not (new.status = any (allowed)) then
    raise exception 'reconstruction job transition % -> % is not allowed', old.status, new.status;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger reconstruction_jobs_guard before update on reconstruction_jobs
  for each row execute function guard_reconstruction_job();

-- ───────────────────────── events ─────────────────────────

create table reconstruction_job_events (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  job_id      uuid not null,
  event       text not null check (event in (
                'created', 'queued', 'submitted', 'provider_running', 'progress', 'provider_succeeded', 'ingesting',
                'succeeded', 'failed', 'cancel_requested', 'cancelled', 'retry_created')),
  detail_json jsonb not null default '{}'::jsonb check (jsonb_typeof(detail_json) = 'object'
                                                         and octet_length(detail_json::text) <= 4096),
  created_at  timestamptz not null default now(),
  foreign key (job_id, project_id) references reconstruction_jobs (id, project_id) on delete cascade
);
create index reconstruction_job_events_job_idx on reconstruction_job_events (job_id, created_at);

create or replace function guard_reconstruction_job_event() returns trigger
language plpgsql as $$
begin
  raise exception 'reconstruction job events are append-only';
end;
$$;
create trigger reconstruction_job_events_guard before update on reconstruction_job_events
  for each row execute function guard_reconstruction_job_event();

-- ───────────────────────── generated reconstructions ─────────────────────────

alter table location_spatial_reconstructions drop constraint location_spatial_reconstructions_method_check;
alter table location_spatial_reconstructions add constraint location_spatial_reconstructions_method_check
  check (method in ('imported', 'generated'));
alter table location_spatial_reconstructions
  add column job_id                 uuid,
  add column provider               text,
  add column provider_capability    text,
  add column provider_model         text,
  add column provider_operation_id  text,
  add column generation_json        jsonb check (generation_json is null or
                                                 (jsonb_typeof(generation_json) = 'object'
                                                  and octet_length(generation_json::text) <= 8192));
alter table location_spatial_reconstructions
  add constraint location_spatial_reconstructions_job_fk
    foreign key (job_id, project_id) references reconstruction_jobs (id, project_id),
  -- a generated reconstruction always names its job and provider; an import never does
  add constraint location_spatial_reconstructions_generated_check
    check ((method = 'generated') = (job_id is not null and provider is not null and provider_capability is not null and generation_json is not null));
-- exactly ONE reconstruction per job: a second ingestion of the same job is rejected by the database
create unique index location_spatial_reconstructions_job_uidx
  on location_spatial_reconstructions (job_id) where job_id is not null;

alter table reconstruction_jobs
  add constraint reconstruction_jobs_result_fk
    foreign key (result_reconstruction_id, project_id) references location_spatial_reconstructions (id, project_id);

-- ───────────────────────── RLS: owner only ─────────────────────────

alter table reconstruction_jobs enable row level security;
create policy reconstruction_jobs_owner on reconstruction_jobs for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

alter table reconstruction_job_events enable row level security;
create policy reconstruction_job_events_owner on reconstruction_job_events for all to authenticated
  using (is_project_owner(project_id)) with check (is_project_owner(project_id));

-- NOTE: no GRANT to prism_generation_worker or prism_continuity_worker; db:reconstruction-jobs asserts they have none.
